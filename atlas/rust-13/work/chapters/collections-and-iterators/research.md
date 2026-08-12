# 集合与迭代器：零成本抽象的典范 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：从 JS 过来的工程师，习惯用 `arr.map(...).filter(...).reduce(...)` 写出又短又顺的链式数据处理，但心里总有个隐忧——每一步是不是都新建了一个数组？是不是要靠 V8 的隐藏类和内联缓存才能跑得不慢？到了 Rust，既想保留这种高阶表达力，又被警告「迭代会消耗所有权」「要分 iter 还是 into_iter」，稍不留神就撞上借用检查器。本章要解决的就是：**如何在不牺牲性能、也不放弃高阶表达的前提下，安全地遍历与变换集合**。

- **一句话核心思想**：把「遍历 + 变换」拆成一个**惰性的、可组合的迭代器管道**——它只在被消费时才真正跑，跑起来时编译器已经把整条管道内联压平成与手写循环等价的机器码。

- **设计动机（为什么需要它）**：动态数据必须放在堆上管理，于是先有标准集合（Vec/HashMap）封装「堆分配 + 增长 + 回收」；但光有集合还不够，遍历与变换集合才是日常最高频的操作，需要一种既安全又零开销的统一抽象，于是有了迭代器。**承前关系**：
  - （已在第 2 章『所有权与移动语义』讲透「单一所有权 + 默认移动 + 离开作用域析构」，本章只看它的**新侧面**：所有权在「迭代」这个动作中到底走借用、可变借用还是消耗——即 `iter` / `iter_mut` / `into_iter` 三种传递方式）。
  - （已在第 8 章『闭包与 Fn/FnMut/FnOnce』讲透「捕获方式即类型」，本章只看它的**新侧面**：迭代器适配器是闭包 trait 的最大消费方，闭包的捕获/消耗能力直接决定了它能插在哪种迭代器后面）。

- **关键权衡（本章核心，4 条三段式）**：
  1. **惰性 + 适配器链 → 换来高阶组合表达力且零中间分配 → 代价是必须靠消费器驱动，否则什么都不会发生**。一条只接了 `map`/`filter` 却没接 `collect`/`for`/`sum` 的管道，编译器会警告「未使用的迭代器」，初学者常困惑「我明明写了 map，为什么没执行」。
  2. **把迭代的所有权语义编码进三个方法（`iter` 借用 / `iter_mut` 可变借用 / `into_iter` 消耗）→ 换来迭代意图显式、编译器可静态证明无别名冲突 → 代价是从 JS 的 `for...of`（统一语义、无需选）转向必须主动选择三种迭代方式，选错就与借用检查器缠斗**。这是「值语义带来的心智冲击」在迭代场景的具体落地。
  3. **HashMap 默认用 SipHash + 每实例随机种子 → 换来默认防御 HashDoS（哈希洪泛）攻击，让恶意输入无法把 O(1) 查找降级成 O(n) → 代价是默认哈希比 FxHash/AHash 等非加密哈希慢，性能敏感且输入可信的场景需手动换 hasher**。安全是默认值，速度是可选项——这是 Rust 一以贯之的取向。
  4. **融合优化依赖 rustc 内联 + LLVM 后端把管道压平 → 换来「零成本抽象」的招牌承诺 → 代价是优化不写进语言规范、不可保证**：在 SIMD 友好、或某些复杂组合子链中，迭代器版本偶尔不如手写循环快，工程实战仍需 profile。

- **最小心智模型（7 步）**：
  1. 集合把数据放在堆上，自己只持一个指向堆的小对象（Vec 是「指针+长度+容量」三元组）。
  2. 集合实现 `IntoIterator`，调用它得到一个**迭代器**——迭代器本质上是个「持有游标 + 对集合的引用或所有权」的小对象。
  3. 迭代器只承诺一件事：`next()` 返回下一个元素，或返回 `None` 表示结束。
  4. **适配器**方法（`map`/`filter`/`take`/`skip`...）不调用 `next`，而是返回一个「包装了上游迭代器 + 自带逻辑」的**新迭代器**——所以它们什么都不做。
  5. 只有**消费器**方法（`collect`/`fold`/`sum`/`find`/`for`/`any`...）才真正进入循环，反复调 `next` 直到 `None`（或提前命中）。
  6. 编译器把整条链内联后，看到的就是「一个反复调 `next` 的循环」，中间那些包装类型全部被消除，等价于手写循环、无中间数组。
  7. 迭代结束，被消耗的元素已 move 给消费者、被借用的引用随迭代器析构而归还，所有权流自然收束。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的**从零迷你迭代器**——只定义 `next` 的基础迭代器；`map`/`filter` 两个适配器（各自返回「包了上游的新迭代器」）；`collect` 消费器。用它跑 `base.filter(p).map(f).collect()`，并打印日志证明：① 不调 `collect` 时 `map`/`filter` 的函数体一次都没跑（惰性）；② 调了之后元素是逐个穿过整条管道的（融合：没有中间数组，每个元素一次性走完 filter→map→输出）。这一行行对应「惰性 / 适配器 / 消费器驱动 / 零中间分配」四个原理点。
  - **应故意省略**：所有权三分（`iter`/`iter_mut`/`into_iter`）在 TS 里无法真实复刻，只在演示末尾用一段 Rust 原文 + 类型签名示意三者 `Item` 不同（`&T` / `&mut T` / `T`），不强行用 TS 模拟；省略 `ExactSizeIterator`/`DoubleEndedIterator` 等额外 trait、`size_hint` 的精确性、集合的容量增长因子实现细节。
  - **演示载体建议（Writer 据此执行）**：**首选 TS/JS**（本 Atlas 产物是 JS 生态站点，TS 对读者最友好；惰性管道用 TS 的闭包 + 类即可演透）。只在演示结尾贴一小段 Rust 原文展示三种迭代签名的差异（这部分语义 Rust 特有，TS 讲不透，需回退到 Rust）。

- **正文不宜展开的细节**：
  - HashMap 内部的 SwissTable / 开放寻址 / 控制字节实现（由 hashbrown crate 提供，属实现深水区）。
  - `BTreeMap` 的 B 树节点结构、`VecDeque` 环形缓冲区「故意留一格空位」以区分空/满的技巧。
  - `ExactSizeIterator`、`TrustedLen`、`DoubleEndedIterator`、`FusedIterator` 等 marker trait 对优化的影响。
  - `size_hint` 如何被 `collect` 用来预分配容量。
  - `iter()` 方法并不来自任何 trait（历史上「Iterable trait」提案被否决），它就是各集合手写的约定方法——别展开这段掌故，提一句即可。
  - 容量增长的具体倍率（当前实现基于 alloc 的摊还策略）。

- **推荐的一个执行轨迹例子**：
  输入：`vec![1, 2, 3, 4]`
  管道：`.into_iter().filter(|x| x % 2 == 0).map(|x| x * 10).collect::<Vec<_>>()`
  关键中间态：构造阶段只得到一个层层包装的迭代器对象 `Map { f, inner: Filter { pred, inner: IntoIter(...) } }`，**无人调 `next`，闭包体一行没跑**。
  消费阶段（`collect` 驱动）：`collect` 调 `Map::next` → `Map` 调 `Filter::next` → `Filter` 反复调上游 `next` 直到拿到一个偶数（2）→ 把 2 交给 `Map` 映射成 20 → `collect` 推入结果；继续直到上游返回 `None`。
  输出：`vec![20, 40]`
  要点：整条管道经内联后等价于一个 `for` 循环，**没有任何中间数组分配**；且每个元素一次性走完 filter→map→输出，不是先把全部 filter 完再 map。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **Vec 的内存布局**：`Vec<T>` 在栈上是三元组 `(ptr, len, capacity)`：`ptr` 指向堆上连续的 `T` 数组，`len` 是当前元素数，`capacity` 是已分配容量。索引 O(1)；`push` 在未满时 O(1)，满时按容量翻倍重新分配 + 拷贝，整体**摊还 O(1)**。依据: std::vec::Vec 官方文档「Capacity and reallocation」段。
- **Vec 不自动收缩**：增长是「急切」的（翻倍），但删除元素后容量不会自动释放，需显式 `shrink_to_fit`——这是不对称设计。依据: Rust Internals 论坛「Vec is asymmetric with memory handling」讨论 + std::vec::Vec 官方文档。
- **VecDeque 是环形缓冲区**：可增长的双端队列，两端 push/pop 均摊还 O(1)；为区分「空」与「满」，缓冲区**故意留一个槽位空闲**。依据: doc.rust-lang.org/std/collections/struct.VecDeque.html + r/rust「VecDeque wastes space by design」讨论。
- **HashMap 默认防御 HashDoS**：默认用 SipHash-1-3（曾用 SipHash-2-4）这类带随机种子的哈希，种子通过 `RandomState` 在每个 HashMap 实例化时从高质量随机源取得，因此**同一进程的两个 HashMap、甚至同一 HashMap 两次运行的迭代顺序都不同**。依据: doc.rust-lang.org/std/collections/struct.HashMap.html「A hashing algorithm selected to provide resistance against HashDoS attacks」段。
- **HashMap 的安全 vs 速度取舍**：SipHash 比非加密哈希（FxHash/AHash）慢，换来的默认安全；受信输入且性能敏感时可 `HashMap::with_hasher` 换快哈希。注意 `DefaultHasher::new()` 用的是**固定种子**（零），仅供测试/确定性场景，**不等于** `HashMap::new()` 内部的随机种子。依据: DevGenius「Hashing algorithms for HashMap in Rust」+ Rust Internals RFC 0823 相关讨论。
- **Iterator trait 的最小契约**：唯一必须实现的方法是 `fn next(&mut self) -> Option<Self::Item>`；返回 `None` 表示结束。标准库在此之上提供了 70+ 个默认方法（`map`/`filter`/`collect`/`fold`/`find`/...）。依据: doc.rust-lang.org/std/iter/trait.Iterator.html。
- **惰性：适配器 vs 消费器**：`map`/`filter`/`take`/`skip`/`enumerate` 等是**适配器**——返回新迭代器、本身不调用 `next`、不产生任何效果；`collect`/`fold`/`sum`/`count`/`any`/`find`/`for_each`/`for` 循环是**消费器**——驱动 `next` 直至 `None` 或提前命中。依据: The Rust Programming Language「Iterators」章 + cppcheatsheet「Iterators in Rust」。
- **IntoIterator 与 for 循环**：`for x in coll {}` 是 `IntoIterator::into_iter(coll)` 的语法糖。`IntoIterator` 对 `Vec<T>` / `&Vec<T>` / `&mut Vec<T>` 各有一个实现，分别 yield `T`（消耗）/ `&T`（不可变借用）/ `&mut T`（可变借用）——这就是 `for` 按集合的「值/引用/可变引用」形态自动选择三种迭代方式的根因。依据: geekAbyte「IntoIterator and the for…in Syntax」+ doc.rust-lang.org/std/iter/trait.IntoIterator.html。
- **iter / iter_mut / into_iter 的等价对应**：`iter()` ⇒ 借用，yield `&T`；`iter_mut()` ⇒ 可变借用，yield `&mut T`；`into_iter()` ⇒ 消耗所有权，yield `T`。`iter()`/`iter_mut()` 是集合手写的约定方法（不来自某个 trait），`into_iter()` 来自 `IntoIterator` trait。依据: StackOverflow「What is the difference between iter and into_iter?」+ SO「Is there a trait supplying iter()?」。
- **零成本抽象的工程含义**：「零成本」=「不使用这个抽象时，你无需为它付费；使用时，也无法写出更优的手写代码」（Bjarne Stroustrup 的定义，Rust 继承）。对迭代器而言，`map.filter.map.collect` 经 rustc 内联 + LLVM 后端融合优化后，生成的机器码与等价的手写 `for` 循环**通常逐条指令相同**，无中间分配。依据: reintech「Understanding Rust's Zero-Cost Abstractions」+ DockYard「Zero-Cost Abstractions in Rust」。
- **零成本是「通常」而非「总是」**：在 SIMD 友好代码、或某些复杂组合子链中，迭代器版本可能优化不到手写循环水平；社区有「zero-cost... not so zero-cost」的讨论与 profile 案例。依据: turbopuffer「Rust zero-cost abstractions vs. SIMD」+ r/rust 同名讨论。优化不进语言规范，不可保证。

## 关键流程

**迭代器管道的构造与驱动（以 `coll.into_iter().filter(p).map(f).collect()` 为例）**：

```
构造阶段（惰性，不执行任何元素逻辑）：
  coll.into_iter()  →  IntoIter { buf, idx:0 }                    // 拿到基础迭代器
  .filter(p)        →  Filter { pred:p,  iter: IntoIter{...} }     // 包一层，不跑
  .map(f)           →  Map    { f:f,    iter: Filter{...}    }     // 再包一层，不跑
                       —— 此时整条管道无人调用 next ——

驱动阶段（消费器 collect 触发）：
  collect() 内部：
    loop {
        match map.next() {                 // 1. collect 调 Map::next
            Some(v) => out.push(v),        //    拿到最终值，推入结果
            None    => break,
        }
    }
  Map::next():
    match self.iter.next() {               // 2. Map 调上游 Filter::next
        Some(x) => Some((self.f)(x)),      //    命中后套用 f
        None    => None,
    }
  Filter::next():
    while let Some(x) = self.iter.next() { // 3. Filter 反复调上游 IntoIter::next
        if (self.pred)(x) { return Some(x); }  // 命中谓词才返回
    }
    None
  IntoIter::next():
    self.idx < len ? Some(buf[idx++]) : None   // 4. 真正从集合取一个元素

  → 经内联后，编译器看到的等价手写循环：
    let mut out = Vec::new();
    let mut i = 0;
    while i < buf.len() {
        let x = buf[i]; i += 1;
        if p(x) { out.push(f(x)); }       // filter 与 map 被融合进同一轮迭代
    }
    // 无任何中间数组；每个元素一次性走完 取→filter→map→push
```

依据: doc.rust-lang.org/std/iter/trait.Iterator.html（next/collect/map/filter 方法语义）+ reintech「Zero-Cost Abstractions」对融合的解释。

## 易混淆 / 边界 / 推断

- **事实**：`HashMap` 迭代顺序不确定且每次运行可能不同（随机种子），不要依赖它做任何有序处理；需要有序遍历请用 `BTreeMap`（按键排序）。依据: doc.rust-lang.org/std/collections/struct.HashMap.html。
- **事实**：`DefaultHasher`（`HashMap::default()` 不用，但 `DefaultHasher::new()` 用）是**固定种子**的，与 `HashMap::new()` 经由 `RandomState` 的随机种子**不同**——把两者混用是常见误区。依据: Rust Internals「A new default Hasher for HashMap?」。
- **易混淆**：`iter()` 方法**不是**某个 trait 提供的（不像 `into_iter()` 来自 `IntoIterator`），它是各集合类型各自手写的约定方法；历史上「Iterable trait」提案被否决。这点容易让初学者以为 `iter()` 来自某个统一 trait。依据: StackOverflow「Is there a trait supplying iter()?」。
- **易混淆**：`into_iter()` 在 Rust 2021 edition 前后语义有变——2021 起 `for x in vec` 对 `Vec<T>` 按值消耗（yield `T`），更早 edition 对 `for x in &vec` 需显式写 `&`。讨论迭代消耗时要锚定 edition（本 Atlas 默认较新 edition）。依据: The Rust Edition Guide「IntoIterator for arrays / for loop」相关变更（推断为 edition 演进事实）。
- **推断（标注为推断）**：HashMap 选择 SipHash 作为默认而非更快的非加密哈希，是基于「默认安全、攻击面最小化」的设计哲学——这与 Rust 在并发（Send/Sync）、错误处理（强制处理 Result）上的取向一致，是把安全/正确性设为默认值的同一取向在数据结构层的体现。
- **未理解 / 待查证**：迭代器融合优化的具体边界（哪些组合子链能被 LLVM 完全融合、哪些会留尾巴）没有权威的完整清单，社区案例多为经验性的 profile 结果；Writer 正文宜表述为「通常等价」而非「保证等价」。