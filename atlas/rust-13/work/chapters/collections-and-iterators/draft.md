# 集合与迭代器：零成本抽象的典范

> 本章属于 composite 层。前置：所有权与移动语义、闭包与 Fn/FnMut/FnOnce。
> 学完你能：用一句话讲清 Rust 怎么让链式高阶数据处理既安全又零开销，以及它为此做了哪些关键权衡。

## 1. 为什么需要它

上一章把「单次操作可能失败」收进了类型——`Result`/`Option` 让错误无处遁形，`?` 运算符把样板压成一行。但程序里的数据大多是成批出现的：一串用户、一组坐标、一张键值表。这些成批的数据放哪儿、怎么遍历、怎么变换才既不拷贝又不出错？这就是本章要接的口子。

从 JS 过来的工程师会很熟悉这样的写法：

```js
users
  .filter(u => u.active)
  .map(u => u.email)
  .reduce(...)
```

短、顺、一目了然。但心里总有个隐忧：每一步是不是都新建了一个数组？是不是要靠 V8 的隐藏类和内联缓存才能跑得不慢？到了 Rust，你既想保留这种高阶表达力，又会立刻被提醒两件事——「迭代会消耗所有权」「要分 `iter` 还是 `into_iter`」，稍不留神就撞上借用检查器。

于是矛盾就很具体了：**我想要高阶链式的表达力，又不想为每一步的中间结果付出堆分配和性能代价，同时还不能越过所有权与借用的安全线**。这个矛盾催生了两个东西——标准集合（`Vec`/`HashMap`）把动态数据收拢到堆上统一管理，迭代器则在集合之上提供一种「既高阶又零开销」的遍历变换抽象。本章的主角是后者，集合只是它的舞台。

## 2. 核心思想

本质上是把**「描述要做什么」和「真正去做」拆成两段**。一段是惰性、可拼装的描述——你用 `map`/`filter` 把意图串成一条管道，但管道什么都不发生；另一段是唯一真正动手的驱动——某个消费器（`collect`/`for`/`sum`）按下启动键，整条管道才开始流转。描述拼得再花，编译器最后都把它和那一次驱动揉成同一圈手写循环。

## 3. 心智模型

先看数据放在哪。一个 `Vec<T>` 在栈上其实只是个三元组 `(ptr, len, capacity)`：`ptr` 指向堆上一段连续的 `T`，`len` 是当前元素数，`capacity` 是已分配的容量。所以索引是 O(1)；`push` 在没满时是 O(1)，满了就按容量翻倍重新分配加拷贝，整体是**摊还 O(1)**。这里有个不对称的小心思：增长是急切的（翻倍），但删元素后容量不会自动缩，想省内存得显式 `shrink_to_fit`。

集合自己只持一个指向堆的小对象，遍历它需要另一样东西——**迭代器**。把迭代器想成「一个游标 + 对集合的引用或所有权」的小对象：游标记录「读到第几个了」，引用/所有权决定了读出来的元素跟集合是什么关系（只读、可改、还是拿走）。

迭代器的契约小到只有一件事：

```rust
trait Iterator {
    type Item;
    fn next(&mut self) -> Option<Self::Item>;
    // 标准库在此之上提供 70+ 个默认方法（map/filter/collect/...）
}
```

`next` 返回 `Some(下一个元素)` 或 `None` 表示结束。就这么多。标准库里那几十个花哨方法，全都是建立在这一个 `next` 之上的默认实现。

这里有一条最关键、也最容易把初学者绊倒的区分——**适配器 vs 消费器**：

| 类别 | 代表方法 | 干了什么 |
|------|----------|----------|
| 适配器 | `map` / `filter` / `take` / `skip` / `enumerate` | 返回一个「包了上游迭代器 + 自带逻辑」的**新迭代器**，本身**不调** `next`，**什么都不做** |
| 消费器 | `collect` / `fold` / `sum` / `find` / `any` / `for` 循环 | 真正进入循环，反复调 `next` 直到 `None`（或提前命中） |

把迭代管道想成一条流水线：`map`、`filter` 是流水线上的工位，但这条流水线默认是停的。只有消费器是那个按下启动键的人。没接消费器，整条管道一行闭包体都不会跑。

这条区分解释了一个高频困惑：**「我明明写了 `map`，为什么函数体没执行？」**——因为你只搭了工位，没按启动键。

## 4. 关键权衡

### 描述与执行分离，换来零中间分配

这是惰性管道的核心取舍。

**选择**：适配器（`map`/`filter`）返回新迭代器、本身不调 `next`，把整条管道做成纯描述。
**换来**：高阶链式表达力，而且**零中间数组**——不是「`map` 先建一个数组、`filter` 再建一个」，而是整条管道融合进同一圈循环。
**代价**：必须靠消费器驱动，否则管道什么都不发生。一条只接了 `map`/`filter` 却没接 `collect`/`for`/`sum` 的管道，编译器会警告「未使用的迭代器」。

它化解的本质矛盾，是**「想要高阶组合的表达力」和「不想为每步建中间数组」**之间的对立。惰性把两者拆开：描述阶段尽情拼装不花一分钱，执行阶段一次性跑完。代价是真实的——这种分离会让习惯了 JS「写了就跑」的初学者困惑，漏接消费器是最常见的第一脚坑。

### 把迭代意图写进方法名，换来编译期无别名证明

迭代会碰数据，碰数据就得说清是「读」还是「改」还是「拿走」。Rust 没有把这个选择藏起来，而是把它做成了三个方法名：

```rust
let v = vec![1, 2, 3];
for x in v.iter()      { /* x: &i32     */ }   // 借用：只读
for x in v.iter_mut()  { /* x: &mut i32 */ }   // 可变借用：能改
for x in v.into_iter() { /* x: i32      */ }   // 消耗：拿走所有权
```

三个方法，产出的元素类型分别是 `&T` / `&mut T` / `T`。

**选择**：把迭代的所有权语义编码进 `iter`（借用）/ `iter_mut`（可变借用）/ `into_iter`（消耗）三个方法。
**换来**：迭代意图写在方法名上，编译器因此能**静态证明无别名冲突**——比如你一边遍历一边往同一个集合里插，编译期就能拦下，因为「不可变借用期间不能有可变借用」。
**代价**：从 JS 的 `for...of`（统一语义、无需选）转向必须主动三选一，选错就和借用检查器缠斗。

这是第 2 章「所有权与移动语义」里那个「值语义带来的心智冲击」在迭代场景的具体落地——单一所有权规则没变，只是在「遍历」这个动作上，必须显式说清所有权走哪条路。它化解的本质矛盾，是**「想要一个统一易用的遍历接口」和「必须区分读/写/消耗才能保证内存安全」**之间的对立。

### 默认防住 HashDoS，换来安全是默认值

顺带提一个集合本身的取舍，因为它最能体现 Rust 的取向。`HashMap` 默认用 SipHash 加上**每个实例各不相同的随机种子**，所以同一进程的两个 `HashMap`、甚至同一个 `HashMap` 两次运行的迭代顺序都不一样。

**选择**：默认用带随机种子的抗碰撞哈希。
**换来**：默认防御 HashDoS（哈希洪泛）攻击——恶意构造的 key 无法把 O(1) 的查找拖成 O(n)。
**代价**：默认哈希比 `FxHash`/`AHash` 这类非加密哈希慢；性能敏感且输入可信的场景，得用 `HashMap::with_hasher` 手动换 hasher。

它化解的本质矛盾，是**「默认安全」和「默认快」**的对立。Rust 一以贯之地把安全设为默认值、把快设为可选项——并发里的 `Send`/`Sync`、错误处理里强制处理 `Result`，都是同一个取向在别处的回响。顺带一个常见误区：`DefaultHasher::new()` 用的是**固定种子**，跟 `HashMap::new()` 内部经 `RandomState` 取的随机种子**不是一回事**，别混用。

### 融合优化靠后端，换来零成本抽象招牌

回到迭代器主线。「零成本」这个词来自 Bjarne Stroustrup 的定义：**不使用这个抽象时无需为它付费，使用时也无法写出更优的手写代码**。对迭代器而言，`map.filter.map.collect` 经 `rustc` 内联加 LLVM 后端融合优化后，生成的机器码跟等价的手写 `for` 循环通常逐条指令相同。

**选择**：让零成本依赖 `rustc` 内联 + LLVM 后端把管道压平，而不是写进语言规范保证。
**换来**：「零成本抽象」这块招牌——你在源码层用高层组合子，后端替你压到底。
**代价**：优化不进语言规范、不可保证。在 SIMD 友好的代码、或某些复杂的组合子链里，迭代器版本偶尔优化不到手写循环水平。

这条的代价偏工程性：它换来的是招牌承诺，代价主要是「不保证、实战仍需 profile」。说「通常等价」比「保证等价」更准确。

## 5. 最小原理演示

下面用一个几十行的迷你迭代器演透四件事：惰性、适配器返回新迭代器、消费器才驱动、零中间数组。用 TS 写，因为惰性管道靠闭包加类就够演透。

```ts
// 迭代器契约：只承诺一件事——取下一个，或返回 null 表示结束
interface Iter<T> {
  next(): T | null;
}

// 基础迭代器：包一个数组 + 游标，next 就是"取第 idx 个并前进"
class ArrayIter<T> implements Iter<T> {
  private idx = 0;
  constructor(private buf: T[]) {}
  next(): T | null {
    return this.idx < this.buf.length ? this.buf[this.idx++] : null;
  }
}

// 适配器 map：不主动调 next，只把"上游 + 变换函数"打包成新迭代器
class MapIter<T, U> implements Iter<U> {
  constructor(private up: Iter<T>, private f: (x: T) => U) {}
  next(): U | null {
    const x = this.up.next();        // 自己被要元素时，才去问上游要一个
    return x === null ? null : this.f(x);
  }
}

// 适配器 filter：被要元素时反复问上游，直到命中谓词
class FilterIter<T> implements Iter<T> {
  constructor(private up: Iter<T>, private p: (x: T) => boolean) {}
  next(): T | null {
    let x = this.up.next();
    while (x !== null && !this.p(x)) x = this.up.next();
    return x;
  }
}

// 给每个迭代器挂上 map/filter，让链式写法成立
function attach<T>(it: Iter<T>) {
  return Object.assign(it, {
    map<U>(f: (x: T) => U) { return attach(new MapIter(it, f)); },
    filter(p: (x: T) => boolean) { return attach(new FilterIter(it, p)); },
  });
}

// 消费器 collect：唯一真正驱动 next 的地方，也是唯一建数组的地方
function collect<T>(it: Iter<T>): T[] {
  const out: T[] = [];
  let x = it.next();
  while (x !== null) { out.push(x); x = it.next(); }
  return out;
}

// 演示一：惰性——只接适配器、不接消费器，闭包体一行都不该跑
attach(new ArrayIter([1, 2, 3, 4]))
  .filter(x => { console.log("  filter 调用", x); return x % 2 === 0; })
  .map(x => { console.log("  map 调用", x); return x * 10; });
console.log("（上面无任何日志 = 没接消费器，整条管道一行没跑）\n");

// 演示二：融合——接上消费器后，每个元素一次性穿过 filter→map→输出
const out = collect(
  attach(new ArrayIter([1, 2, 3, 4]))
    .filter(x => { console.log("  filter", x); return x % 2 === 0; })
    .map(x => { console.log("  map", x); return x * 10; })
);
console.log("结果", out);
```

演示一的输出是空的——没接 `collect`，`filter`/`map` 的函数体一次都没进。演示二的输出长这样：

```text
  filter 1     ← 1 不满足谓词，被丢
  filter 2     ← 2 通过
  map 2        ← 2 被映射成 20，推入结果
  filter 3     ← 3 被丢
  filter 4     ← 4 通过
  map 4        ← 4 被映射成 40，推入结果
结果 [20, 40]
```

重点看这个交错：`filter 2` 紧跟着 `map 2`，然后才轮到 `filter 3`。每个元素一次性走完 filter→map→输出，**不是**先把全部元素 filter 完再统一 map。这就是融合——没有「filter 的中间数组」，只有一个结果数组。四个原理点在这一段里全落到了地上。

## 6. 执行轨迹

拿一个具体输入从头走一遍，把心智模型和上面的演示对齐。输入 `vec![1, 2, 3, 4]`，管道：

```rust
vec![1, 2, 3, 4]
    .into_iter()
    .filter(|x| x % 2 == 0)
    .map(|x| x * 10)
    .collect::<Vec<_>>()
```

**构造阶段（惰性，没人调 `next`，闭包体一行没跑）**：表达式一层层求值，得到的只是层层包装的迭代器对象——`Map { f, inner: Filter { pred, inner: IntoIter { buf, idx: 0 } } }`。到这一步为止，`filter` 和 `map` 的闭包一次都没被调用。

**驱动阶段（`collect` 按下启动键）**：

1. `collect` 进循环，调最外层 `Map::next`。
2. `Map::next` 转头调它的上游 `Filter::next`。
3. `Filter::next` 反复调更上游的 `IntoIter::next`：先拿到 `1`，不满足偶数谓词，丢掉，继续要；拿到 `2`，满足，返回给 `Map`。
4. `Map` 把 `2` 套上 `*10` 得到 `20`，返回给 `collect`，`collect` 推入结果数组。
5. `collect` 再调一轮 `Map::next`，`Map` 又问 `Filter`，`Filter` 拿到 `3`（丢）、`4`（中），`Map` 映射成 `40`，`collect` 推入。
6. 下一轮 `IntoIter::next` 返回 `None`，逐层传上去，`collect` 的循环结束。

输出 `vec![20, 40]`。

整条链经编译器内联后，等价于这样一圈手写循环，没有任何中间数组：

```rust
let mut out = Vec::new();
let mut i = 0;
while i < buf.len() {
    let x = buf[i]; i += 1;
    if x % 2 == 0 { out.push(x * 10); }   // filter 与 map 融进同一轮
}
```

## 7. 教学简化说明

本章演示故意省略了几样东西：所有权三分（`iter`/`iter_mut`/`into_iter`）在 TS 里无法真实复刻，所以只在 §4 用一小段 Rust 类型签名示意三者产出元素类型不同，不强行模拟；`ExactSizeIterator`、`DoubleEndedIterator`、`FusedIterator`、`TrustedLen` 这些 marker trait 对优化的影响、`size_hint` 怎么帮 `collect` 预分配容量、`HashMap` 内部的 SwissTable 实现细节，都没展开——它们是优化深水区，不是理解「惰性 + 融合」这条主线的前提。

## 8. 小结

Rust 用一条惰性的迭代器管道，把「想要高阶表达」和「不想付中间分配的代价」这对老冤家拆开了：描述阶段尽情拼装不花钱，消费器一按下启动键，编译器再把整条管道揉成跟手写循环无差别的机器码。代价你也看见了——得自己挑 `iter`/`iter_mut`/`into_iter`，得记得接消费器，默认哈希为了安全宁可慢一点。

集合解决的是「一个主人、多人借用」已经够用的场景。但当数据真的需要被多个主人共享、或者需要在运行时改变借用规则时，单一所有权就力不从心了——下一章的智能指针和内部可变性，正是给这套规则开的运行时逃生舱。