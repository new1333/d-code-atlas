# Vue Macros 的宏变换流水线：一个特性 = 一个函数 + 链上一个位置

> 本章属于 composite 层。前置：『靠 AST 而非正则识别宏调用节点』『magic-string：sourcemap 友好的源码就地变换』。
> 学完你能：用一句话讲清"为什么 Vue Macros 要把每个宏做成独立 transform、再用固定顺序的链串起来"，以及这套设计换来什么、付出什么。

## 1. 为什么需要它

上一章把"怎么在一份源码上做 offset 级就地改写、还能还原 sourcemap"这件事办成了：magic-string 给了我们一把不会弄丢原始坐标的手术刀。但它留下一个口子——一把手术刀只解决"改一处"，没解决"改很多处"。一个真实的宏集合动辄十几个宏，每个都想动 `<script setup>` 里的代码。如果没有一条统一的变换流水线，每个宏都要自己从头写"解析 SFC → 找调用 → 改代码 → 生成 sourcemap → 挂到 Vite/webpack/esbuild"，十几个宏就是十套重复脚手架。

更麻烦的是它们还会互相踩脚。设想你同时启用一个单事件宏 `defineEmit` 和一个批量宏 `defineModels`，好几个宏都要碰 `defineProps` 相关的调用：谁先改、谁后改？前一个改完之后，后一个看到的还是它认识的写法吗？

矛盾很清楚：宏要被规模化地、互相不冲突地、跨构建工具地生产，但每个宏单独看又只是"一段 AST 改写逻辑"。这条流水线就是为了把这个矛盾接住而生的。

## 2. 核心思想

把"一个编译期特性"抽象成"一个独立的 transform 函数加上一个特性开关"，再用一条固定顺序的插件链把它们串起来：加一个宏 = 写一个函数 + 在链上插一个位置。

## 3. 心智模型

先看一个特性长什么样。每个特性的标准形态是一个函数：

```ts
type FeatureTransform = (code: string, id: string) => { code: string; map: any } | undefined
```

返回 `{ code, map }` 表示"我要改这份代码，这是改完的结果"；返回 `undefined` 表示"我对这份代码不感兴趣，原样放行"。`undefined` 不是凑数的，它是后面整条链能顺畅接力的前提。

一次构建工具 transform 钩子触发时，链是这样跑的：

```
请求文件 id
  → 文件过滤：非 .vue / 非目标文件直接放行
  → 进入【固定顺序的插件链】，对链中每个特性按顺序执行：
       ① 短路：源码里不含本宏名？立即 return undefined，连 AST 都不解析
       ② 解析：拆出 <script setup>，惰性产出它的 AST
       ③ 命中：遍历 AST，按"节点类型 + 调用名"找到本宏的调用节点
       ④ 就地改写：在一个 offset 记录器上登记 overwrite / appendLeft（不动原文）
       ⑤ 收尾：一次性产出 { code, map } 交还构建工具
       下一特性拿到上一步的 code，重复 ①~⑤
  → 链尾 → 交给 Vue 官方编译器
```

有三个不变量要钉死，后面讲权衡全靠它们：

- **独立遍历**：每个特性在自己的一次 `walkAST` 里遍历，不存在"把多个 visitor 合并到一次遍历"的设施。
- **串行接力**：链上每个特性的输入，是上一个特性 `toString()` 出来的字符串。也就是说，宏 B 拿到的是宏 A 已经改过的字符串，不是最初的源码。
- **offset 每步重算**：正因为接力的是字符串，每个特性都要对"自己拿到的那段代码"重新解析、重新建立 offset。前一步 appendLeft 进去的一行 helper，会让后面所有位置整体后移，但下一个特性完全无感，它只认自己重新解析出来的坐标。

所以这不是一条"一次解析、多人共享"的流水线，而是一条"逐段改写、逐段重解析"的接力链。这一点很关键，下面权衡一的性能账全建立在它之上。

## 4. 关键权衡

### 权衡一：把每个特性拆成独立可装配单元

面对"十几个宏"，最省事的本能是写一个大 transform，按宏名 if-else 在一次遍历里处理所有宏。Vue Macros 偏不这么干。它选择把每个特性都做成一个独立的、可单独发布的 transform 函数，各自遍历、各自改写。

换来的是四样东西：特性可以**独立开关**（开关关掉就整条从链上拿掉）、可以**单独发成独立 npm 包**（`@vue-macros/define-emit` 和 `@vue-macros/chain-call` 是分开的包）、可以**跨 Vite/webpack/esbuild 分发**、新宏几乎**零脚手架**（写一个函数 + 在链上插一个位置就完事）。

代价是性能上的重复。接力链上每多一个启用的特性，就多一次"解析 + 遍历"。而且要强调一点：**每次解析的是一段不同的改写后代码**——宏 B 解析的是宏 A 改过的字符串，不是同一份源码被解析 N 遍。这条开销没法靠"共享一次解析"来消掉，因为本来就没有一次共享的解析可共享。

| 选择 | 换来 | 代价 |
|---|---|---|
| 每个特性独立 transform、各自遍历 | 独立开关 / 单独发布 / 跨工具 / 零脚手架 | 接力链累计解析 N 次，每次解析的还是各不相同的改写后代码 |

这条流水线用了两样东西来压低这个代价，但它们各管各的事，别混为一谈：

- **短路（主力）**：每个特性函数第一行几乎都是 `if (!code.includes(宏名)) return`。源码里压根没出现这个宏的名字，就根本不解析。一个文件通常只用到少数几个宏，所以"实际真正去解析 AST 的特性数"远小于"启用的特性总数"。短路压低的是**参与解析的宏数**。
- **解析缓存（辅助，且作用域有限）**：底层 `babelParse` 带了缓存。但这个缓存只在**同一份代码字符串被重复请求解析**时才命中，比如 HMR / watch 里一个没改动的文件再次进入流水线，或者同一个特性内部多次取 setup / script 的 AST。它**不能**把接力链里 N 段互不相同的代码合并成一次解析，因为那些字符串本来就不一样，缓存键对不上，互不命中。

> 本质矛盾：这是『模块化、可独立装配』和『单次遍历的极致性能』在打架。流水线选了前者，再用短路把"实际参与解析的宏数"压下去、用缓存兜住"同一份代码被重复请求"的边角，把性能代价控在一个能接受的水位。

### 权衡二：用一条固定顺序的链解决冲突

多个宏可能都想改写同一个节点（比如好几个宏都要碰 `defineProps` 相关的调用）。怎么解决冲突？一个重型方案是引入依赖图、拓扑排序、甚至冲突检测器。Vue Macros 选了最朴素的一种：**一条固定顺序的插件链，串行传递代码**。链的顺序硬编码在聚合包的 `plugins` 数组里，还带着语义分组注释（`// props`、`// emits`、`// convert to runtime props & emits`），构建工具老老实实按数组顺序一个一个调，前一个的输出就是后一个的输入。

换来的是简单和确定。顺序本身就表达了宏之间的依赖：先把 `defineProps` 的各种写法统一成标准形态，再做依赖标准形态的类型展开。谁先谁后，看链上的位置就知道，不用跑什么分析。

代价有两个。第一，顺序是手工维护的：新增一个特性，得人工找准它该插在链的哪个位置，插错了就出错。第二，正因为每个特性各自遍历，**无法在一次遍历里共享上下文**——A 在遍历时算出来的中间信息，B 拿不到，B 只能从 A 改完的字符串里重新推断一切。

> 本质矛盾：这是『多个宏改写同一节点的冲突』和『不想引入复杂调度器』在打架。流水线用"确定的串行顺序"这个最朴素的调度来化解，省下一整套依赖图的复杂度，代价是顺序全靠人维护、特性间无法共享遍历上下文。

（少数特性会返回一前一后两个插件，分别插在链的不同位置。所以"一个特性 = 一个插件"是个简化模型，真实的颗粒度允许"一个特性拆成多个阶段"。但这不改变"串行接力"的本质。）

### 权衡三：所有宏在官方编译器之前，把自己降级成官方原语

Vue Macros 的所有宏插件都带 `enforce: 'pre'`，强制跑在 Vue 官方编译器**之前**。它们不是去教官方编译器认识新语法，而是趁官方编译器还没上场，先把自定义宏"自降级"成官方本来就认识的原语：单个 `defineEmit('open')` 被改写成调用官方 `defineEmits(['open'])` 的局部变量；链式 `defineProps().withDefaults({...})` 被改写成官方的 `withDefaults(defineProps(), {...})`。

换来的是与官方编译器的彻底解耦。官方编译器上场时，看到的全是它认识的 `defineEmits` / `withDefaults` / `defineProps`，根本不知道刚才有一堆自定义宏来过。这意味着 Vue Macros 几乎与 Vue 版本无关，官方编译器怎么演进，只要那几个原语还在，这套宏就继续工作。

代价是宏的语义被锁死在一条边界上：**它最终能不能还原成少数几个官方原语**。能引入的全新语义是有限的，你没法靠这套机制做出一个官方原语完全表达不了的运行时行为。

> 本质矛盾：这是『想任意扩展宏的语义』和『不想 fork 官方编译器』在打架。流水线用"把自己降级成官方原语"来搭桥，换来不侵入官方编译器，代价是扩展能力被官方原语集合圈死。

## 5. 最小原理演示

下面用约 50 行 JS 演透四个原理点：**短路、独立遍历、顺序接力、统一收尾**。两个特性都是 `(code) => { code, map } | undefined` 的形态，再用一个 `pipeline` 按数组顺序把它们串起来。为了不引重依赖，手写一个迷你 `MagicString`（只记 offset、最终 `toString` 输出）和一个迷你 `walkAST`。

```js
// —— 原理点④的形：offset 级就地变换（第 5 章已讲透，这里只复用其形）——
class MagicString {
  constructor(src) { this.src = src; this.ops = []; }
  overwrite(start, end, str) { this.ops.push({ k: 'ow', start, end, str }); return this; }
  appendLeft(at, str)        { this.ops.push({ k: 'al', at, str }); return this; }
  toString() {
    // 从后往前应用，避免改写影响前面的 offset
    const sorted = [...this.ops].sort((a, b) => (b.start ?? b.at) - (a.start ?? a.at));
    let out = this.src;
    for (const op of sorted) {
      if (op.k === 'ow') out = out.slice(0, op.start) + op.str + out.slice(op.end);
      else               out = out.slice(0, op.at) + op.str + out.slice(op.at);
    }
    return out;
  }
}

// —— 原理点③的形：命中（第 4 章已讲透，这里只复用其形）——
const isCallOf = (n, name) => n && n.type === 'Call' && n.callee === name;
function walkAST(node, visitors) {
  if (!node || typeof node !== 'object') return;
  if (node.type && visitors.enter) visitors.enter(node);
  for (const k in node) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(c => walkAST(c, visitors));
    else if (v && typeof v === 'object') walkAST(v, visitors);
  }
}
// 极简 parse：扫描出 name(args) 调用并标 offset（真实流水线用 babel，这里只为演示）
function parse(code) {
  const body = [];
  for (let i = 0; i < code.length; i++) {
    if (!/[a-zA-Z_$]/.test(code[i])) continue;
    let j = i; while (j < code.length && /[\w$]/.test(code[j])) j++;
    const name = code.slice(i, j);
    let k = j; while (k < code.length && code[k] === ' ') k++;
    if (code[k] !== '(') { i = j - 1; continue; }
    let depth = 1, end = k + 1;
    while (end < code.length && depth) { if (code[end] === '(') depth++; else if (code[end] === ')') depth--; end++; }
    body.push({ type: 'Call', callee: name, start: i, end });
    i = j - 1; // 只跳过名字，继续往里扫，让嵌套调用也被识别
  }
  return { type: 'Program', body };
}

// —— 原理点①：每个特性是一个独立 transform 函数 ——
// 特性 A：把 foo(x) 包成 bar(foo(x))，并在块首插一行 helper（演示 overwrite + appendLeft）
function chainWrap(code) {
  if (!code.includes('foo(')) return;              // 原理点②：短路
  const s = new MagicString(code);
  walkAST(parse(code), { enter(n) {
    if (isCallOf(n, 'foo')) {
      s.overwrite(n.start, n.end, `bar(${code.slice(n.start, n.end)})`);
      s.appendLeft(0, 'const bar = makeBar()\n');  // 插 helper：下一步拿到的字符串整体后移
    }
  } });
  return { code: s.toString(), map: '<sourcemap>' }; // 原理点⑤：统一收尾
}
// 特性 B：把 double(x) 内联成 (x)*2
function doubleInline(code) {
  if (!code.includes('double(')) return;           // 短路
  const s = new MagicString(code);
  walkAST(parse(code), { enter(n) {
    if (isCallOf(n, 'double')) {
      const inner = code.slice(n.start + n.callee.length + 1, n.end - 1); // 剥掉 double( 和 )
      s.overwrite(n.start, n.end, `(${inner})*2`);
    }
  } });
  return { code: s.toString(), map: '<sourcemap>' };
}

// —— 原理③：固定顺序的插件链，串行接力（前者输出 = 后者输入）——
const pipeline = (features) => (code, id) =>
  features.reduce((c, f) => f(c, id)?.code ?? c, code);

const transform = pipeline([chainWrap, doubleInline]); // 顺序即依赖
```

注意 `pipeline` 里这一行 `features.reduce((c, f) => f(c, id)?.code ?? c, code)`：特性返回 `undefined` 时，链上原样传上一份代码；返回 `{ code }` 时，把改完的代码喂给下一个。"接力"的全部秘密就在这里，薄到只有一行 reduce。

## 6. 执行轨迹

拿一个同时命中两个特性的输入走一遍：`double(foo(3))`。

**特性 A `chainWrap` 先跑**：

- 短路检查：`code.includes('foo(')` 命中，继续。
- 解析 `double(foo(3))`，遍历找到 `foo(3)` 节点，offset 是 `7..13`。
- 就地改写：`overwrite(7, 13, 'bar(foo(3))')`；再 `appendLeft(0, 'const bar = makeBar()\n')`。
- 收尾 `toString()`，从后往前应用：先在 `7..13` 套上 `bar(...)`，再在开头插 helper。输出：

```
const bar = makeBar()
double(bar(foo(3)))
```

**特性 B `doubleInline` 接力**——注意它拿到的是 A 改过的字符串，不是原始输入：

- 短路检查：这段新代码里 `includes('double(')` 命中，继续。
- **重新解析**这段新代码。因为 A 在开头插了一行 helper，`double(...)` 的 offset 已经整体后移，但 B 完全无感，它只认自己刚解析出来的坐标。
- 遍历找到 `double(...)` 节点，就地改写成 `(bar(foo(3)))*2`。
- 收尾输出：

```
const bar = makeBar()
(bar(foo(3)))*2
```

两个关键中间态值得盯一眼。第一，B 之所以还能命中 `double(...)`，是因为 A 的改写只动了内层的 `foo`，外层的 `double(...)` 调用结构原封不动传了下来——这就是"顺序接力"能协作的基础：前一个宏别把后一个宏还要用的调用结构破坏掉。第二，每一步产出的都是"对那一步原始 offset 的增量记录"，下一步拿到的是字符串、重新建 offset，接力链没有任何跨步的共享状态。

放到真实的 Vue Macros 里，这条链的终点是 Vue 官方编译器。链尾代码交到它手上时，自定义宏已经全部降级成了它认识的 `defineEmits` / `withDefaults` / `defineProps`，它压根不知道这层流水线存在过。

## 7. 教学简化说明

本章演示故意省略了：真实的 SFC 分块解析（演示直接吃整段代码）、跨构建工具的 unplugin 适配、IDE / Volar 的类型侧、特性开关的配置 schema、解析缓存的真实实现，以及少数特性拆成"前置 + 后置"两阶段插件的具体细节。这些在第 8 章及之后会展开。

## 8. 小结

一条流水线，把"一个编译期特性"抽象成"一个独立 transform 函数 + 一个特性开关"，再用固定顺序的链串行接力。它换来的是新宏零脚手架、可独立开关、可单独发布、可跨工具分发，与官方编译器彻底解耦；付出的是接力链上累计 N 次解析（每次解析的还是各不相同的改写后代码）、顺序靠手工维护、特性间无法共享遍历上下文，以及宏语义被"能否还原成官方原语"这条边界圈死。

有了这条流水线，下一个自然的问题就是：到底哪些东西值得被做成宏？哪些运行期的样板，值得前移到编译期来消灭？这正是下一章《宏的设计原型：把什么前移到编译期》要归纳的。