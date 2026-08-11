# 函数工厂与无 this 的方法

> 本章属于 primitive 层。前置：第 1 章「把 pubsub 退化成一张查找表」。
> 学完你能讲清：这个发射器的方法为什么一律不靠 `this`，又为此放弃了什么。

## 1. 为什么需要它

上一章把状态退化成了一张 `Map<事件类型, 处理器数组>`，那张表已经定下来。但表怎么绑到方法上、怎么从工厂手里塞进去，还没说——这两件事正是本章的两个新侧面。

先看一个 JS 老坑。如果发射器按传统「类 + this」写：

```js
class Emitter {
  constructor() { this.table = new Map(); }
  on(type, fn)   { /* this.table.get/set */ }
  emit(type, e)  { /* this.table.get */ }
}

const e = new Emitter();
const { on, emit } = e;
someButton.addEventListener('click', () => emit('click', ev));   // 必须包箭头
```

只要 `on` / `emit` 一旦离开实例——解构出来当回调、塞进 `Promise.then`、挂在 `addEventListener` 上——内部的 `this` 就跟着丢了。严格模式下 `this` 变成 `undefined`，方法里 `this.table` 直接抛 `Cannot read properties of undefined`；非严格模式下 `this` 指向全局对象，读到的根本不是自己的状态。使用者被迫到处写 `.bind(this)` 或包一层箭头函数，谁都嫌膈应。

mitt 想让「拿到方法就能随便传、随便存、随便异步调」这件事零成本成立。要做到这一点，方法就不能依赖 `this`；而消灭了 `this` 之后，方法还想共享同一份状态，靠的只能是「闭包」。这两件事其实是一气呵成的同一个设计。

## 2. 核心思想

方法不靠 `this` 绑定状态，靠「工厂调用产生的闭包」捕获状态。`this` 这个 JS 里最容易出错的绑定机制被整个拿掉了——工厂存在的意义，就是替 `this` 去造那个闭包。

## 3. 心智模型

把 `mitt()` 想成一个「开盒」动作：

1. 调用工厂，可传入一张已有的注册表（不传则内部新建一张空表）。
2. 工厂把这张表的引用，关进本次调用形成的闭包里。
3. 工厂返回一个普通对象字面量，里面挂着这张表本身和 `on` / `off` / `emit`。
4. 每个方法内部要读写订阅状态时，直接引用闭包里那张表，全文不出现 `this`。
5. 因为不靠 `this`，方法被解构出来单独调用时，闭包照旧把状态喂给它——不丢绑定。
6. 因为表是公开属性、且工厂可接受外部表，两个发射器可以共享同一张表。

工厂 + 闭包和 class + `this` 表面都在「让一组方法共享一份状态」，区别在绑定的时机：`this` 是**调用时**决定的（谁点的就指谁），闭包是**创建时**决定的（工厂一调用就钉死了）。前者跟着调用上下文跑，后者永远不动。这正是 mitt 选闭包的根本原因。

## 4. 关键权衡

### 闭包替 this 绑状态，换方法可安全解构传递，代价是放弃原型共享

最重的选择：方法完全不依赖 `this`，状态由工厂闭包捕获。

换来的是「方法可安全解构、单独传递、当回调挂载，绝不因 `this` 丢失而读错状态或报错」。下面这段在 mitt 里完全合法，在 class + `this` 版本里就崩：

```js
const { on, emit } = mitt();
Promise.resolve('foo').then(type => emit(type, 42));   // 异步、解构、零 .bind
on('foo', n => console.log('got', n));                  // => got 42
```

代价是每个发射器实例都新生成一份方法——没有原型共享，多实例时方法对象占的内存会线性增加；且要求状态必须以闭包变量形式被所有方法共同捕获，不能再靠实例字段。mitt 在「实例通常很少、追求极致体积与无 `this` 安全性」这一前提下接受了这笔开销。

这条权衡化解的本质矛盾是**绑定要稳定到能脱离调用上下文**对**状态要被一组方法共享**。class + `this` 用「调用时 `this`」共享状态，绑定会跟着调用上下文跑掉；工厂 + 闭包用「创建时闭包」钉死状态，调用上下文再怎么变也动不了它。这是 JS 所有「方法要脱离实例被传递」场景的通解骨架——回调、异步、解构、跨模块挂载，都得把绑定从 `this` 换成闭包，否则迟早踩坑。

### 工厂接受可选注册表入参，换跨发射器事件汇流，代价是 API 多一个参数

第二个选择藏在工厂签名里：`mitt(all?)`，第一行兜底 `all = all || new Map()`。

- 传了用你的。
- 不传内部新建。

换来的是多个发射器可以共享同一张表。这件事在「跨模块事件汇流」之类的场景里特别有用：一个模块暴露一个 emitter、另一个模块暴露另一个，但底层指向同一张表；或者外部预构造好一张表（比如从持久化反序列化回来），交给 `mitt` 注入。注入让 mitt 不再是封闭黑盒，而是可以「拼装」的基础设施。

代价薄到不展开：API 表面多一个参数，外加一行「传了就用、没传就建」的兜底赋值。

这条权衡的本质矛盾是**自洽封装**对**可注入组合**。类通常自带状态、对外封闭；工厂可以接受外部状态、与其它实例汇流。它和「`all` 是公开可变属性」其实是配套的——只有 `all` 既公开可变、又能从外部注入，「两个 emitter 共享一张表」这件事才完整成立。

### all 公开可变——回指第 1 章

注册表 `all` 直接作为返回对象的公开属性挂出，无封装。这件事第 1 章已作为「极简与可窥探换放弃封装」讲过，本章只补一刀：mitt 敢这么彻底地公开 `all`，正是因为没有 `this`、方法靠闭包——任何代码绕过 `on` / `off` 直接改 `all`（比如 `emitter.all.clear()`、`emitter.all.set('foo', [...])`），方法下次读 `all` 时拿到的还是闭包里那张表的引用，行为依然正确。「无 `this`」反而让「`all` 公开可变」在语义上不会塌方——如果方法写成 `this.table.get(...)`，外部一替换实例上的 `table` 引用就全乱套了。

## 5. 最小原理演示

下面这段演示不追求工程完整，只演透两件事：①闭包替 `this` 绑状态、②工厂接受可选注册表入参。每一行都对应上面某条原理。

```ts
type Handler = (event: any) => void;

// 工厂：接受可选的注册表入参，缺省时内部新建
function mitt(initial?: Map<string | symbol, Handler[]>) {
  // 缺省自建——这一行就是「可注入」的入口：传了用你的，没传内部新建
  const all = initial ?? new Map();

  return {
    // 注册表作为公开属性挂出：谁都能 dump、改、清空它
    all,

    // on：闭包里的 all 喂给方法，与 this 无关
    on(type: string | symbol, handler: Handler) {
      const list = all.get(type);
      if (list) list.push(handler);
      else all.set(type, [handler]);
    },

    // emit：同样靠闭包引用 all，不出现 this
    emit(type: string | symbol, event: any) {
      const list = all.get(type);
      if (list) for (const h of list) h(event);
    },
  };
}

// 实验 1：解构 + 异步调用，验证「闭包替 this 绑状态」
const { on, emit } = mitt();
on('foo', (n) => console.log('got', n));
Promise.resolve().then(() => emit('foo', 42));   // 异步触发，零 .bind
// => got 42

// 实验 2：两个发射器共享同一张表，验证「可注入共享注册表」
const shared = new Map<string | symbol, Handler[]>();
const a = mitt(shared);
const b = mitt(shared);
a.on('ping', () => console.log('a 通道收到'));
b.emit('ping', null);
// => a 通道收到
// 注册走 a、触发走 b，但它们指向同一张 shared 表
```

把同样的需求用「类 + `this`」写一遍，对照一下：

```ts
class ClassyEmitter {
  private table = new Map<string, Handler[]>();
  on(type: string, handler: Handler) {
    const list = this.table.get(type);    // 这里的 this 由调用方决定
    if (list) list.push(handler);
    else this.table.set(type, [handler]);
  }
  emit(type: string, event: any) {
    const list = this.table.get(type);
    if (list) for (const h of list) h(event);
  }
}

const c = new ClassyEmitter();
const { on: cOn } = c;
cOn('foo', () => console.log('hit'));
// TypeError: Cannot read properties of undefined (reading 'table')
// 原因：cOn 内部 this 不再指向 c，而是 undefined（严格模式）
```

两个版本一比就透：闭包版的 `all` 钉死在工厂调用的那一刻，再不变动；`this` 版的状态绑在「调用时谁点的」，谁拿走谁就丢。

## 6. 执行轨迹

接着演示的代码，看一遍「两个发射器共享一张表」发生时，表和方法各自长什么样。

初始：`shared` 是个空 `Map`，`Map(0) {}`。

`const a = mitt(shared)`：工厂被调用。参数 `initial = shared`（非 undefined），兜底 `const all = initial ?? new Map()` 走左侧，`all` 直接复用 `shared`。`a` 返回的对象上，`a.all` 和闭包里的 `all` 都指向 `shared`。

`const b = mitt(shared)`：同样地，`b` 闭包里的 `all` 也指向 `shared`。现在 `a` 和 `b` 的方法各自的闭包指向了**同一张表**。

`a.on('ping', fn)`：`a` 的 `on` 内部 `all.get('ping')` 返回 `undefined`，于是 `all.set('ping', [fn])`。注意写进去的是 `shared` 这张表，不是 `a` 私有的某张表。`shared` 变成 `Map(1) { 'ping' => [fn] }`。

`b.emit('ping', null)`：`b` 的 `emit` 内部 `all.get('ping')`——读到的是同一张 `shared` 表，返回 `[fn]`，遍历调用 `fn(null)`。控制台打出 `a 通道收到`。

注册和触发在两个不同发射器上发生，但因为它们的闭包都指向同一张表，状态被正确传递。这正是「可注入共享注册表」在执行轨迹上的直接体现：只要方法不靠 `this`、状态由闭包捕获，「哪些方法算同一组」就不再由实例决定，而由「它们闭包里关的是不是同一张表」决定。

## 7. 教学简化说明

演示里省略了：`off` 方法（第 4 章会拆解它的无分支移除技巧）、通配符 `'*'` 的派发支路（第 6 章）、`emit` 里 `.slice()` 的快照防御（第 5 章专题讲）、TS 泛型与条件类型（第 7、8 章）。源码里 `all = all || new Map()` 用 `||` 而非 `??`，是为了对 IE9 等老运行时更友好；演示里换成现代的 `??`，语义等价（空 `Map` 是真值，两种写法都不会误覆盖）。

## 8. 小结

mitt 把发射器写成一个普通函数工厂，返回一个对象字面量，方法靠闭包引用注册表、全文不出现 `this`。换来了方法能被随意解构、传递、当回调挂载而绝不丢绑定，也让「`all` 是公开可变属性」在语义上不会因为绕过 `on` / `off` 直接改表而塌方。代价是放弃原型共享、每个实例都重建一份方法。下一章把镜头推近到 `on` 这个方法上：往表里写一个处理器时，第一个处理器和第十个处理器走的不是同一条路——这条岔路，是 `on` 写入策略的全部精彩。