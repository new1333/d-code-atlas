# Vue Macros 的宏变换流水线

> 本章属于 composite 层。前置：靠 AST 而非正则识别宏调用节点、magic-string：sourcemap 友好的源码就地变换。
> 学完你能用一句话讲清：为什么 Vue Macros 把"一个编译期特性"抽象成"一个独立 transform 函数 + 一条固定顺序的插件链"，以及换来了什么、代价是什么。

## 1. 为什么需要它（设计动机）

上一章讲了 magic-string：用 offset 级操作保住 sourcemap，让宏改写后的产物能精确回溯到用户源码。这一手解决了一个宏改一段代码的问题，但留下了更大的口子——一个 `.vue` 里要塞十几个宏、好几个还想改同一个 `defineProps()`，谁先改？谁后改？怎么不踩脚？

第 4 章已经讲透怎么靠 AST 精确命中宏调用节点，第 5 章已经讲透怎么用 magic-string 在原 offset 上登记变换。把这两件事各自单独看都没问题，但堆到十几个宏身上，立刻撞上工程化的矛盾：

- 写到第十个宏，每个宏都得自己从头写一遍"读文件 → 解析 SFC → 拿 `<script setup>` AST → 改写 → 生成 sourcemap → 挂到 Vite/webpack/esbuild"这一整套脚手架。同一份 SFC 被解析了十遍。
- `defineProps` 这个调用可能同时被好几个宏盯上：`chainCall` 要把它的链式调用拆开、`defineModels` 要往里塞一个 model prop、`betterDefine` 要把 TypeScript 类型注解展开成运行时 props。谁先动？动完之后另一个看到的还是不是原来那棵 AST？
- 同一个团队、不同的人在不同时间写出来的宏，怎么保证它们能拼到同一条构建管线里、还互不冲突？

如果没有一条统一的变换流水线，写十几个宏就是十套重复脚手架、十种各异的接入方式、十次踩同一个坑。**宏要被规模化地、互相不冲突地、跨构建工具地生产**，这个矛盾就是这条流水线要解决的。它换来的是：写一个新宏 = 写一个独立的 transform 函数 + 在链上插一个位置，零脚手架、可独立开关、可单独发布为 npm 包、可跨 Vite/webpack/esbuild 分发。

## 2. 核心思想

**把"一个编译期特性"抽象成"一个独立 transform 函数 + 一个特性开关"，再用一条固定顺序的插件链把它们串起来——加一个宏 = 写一个函数 + 在链上插一个位置。**

如果说前两章讲的是流水线上的**单兵动作**（怎么精确瞄准一个节点、怎么在源码上留下 sourcemap 友好的印记），那本章讲的是**编队**——怎么让一群单兵动作排成一条不会互相撞飞的链。每个动作都是独立的、可插拔的；链本身的顺序就是宏之间依赖关系的表达，不需要任何额外的依赖声明语言。

## 3. 心智模型

一个特性从被构建工具请求到交还改写后代码，走七步：

```
请求文件 id
 → ① 过滤   文件名不在 include 规则里？直接放行，不进链
 → ② 短路   源码字符串里不含本宏名？立刻 return，根本不解析
 → ③ 解析   惰性产出 <script setup> 的 AST（结果缓存，后续宏复用）
 → ④ 命中   walkAST，按"节点类型 + 调用名"精确匹配宏调用节点
 → ⑤ 注入   在一份 offset 记录器上登记 overwrite / appendLeft
 → ⑥ 收尾   一次性产出 { code, map }，交还构建工具
 → ⑦ 接力   下一个特性拿这份 code 当原始输入，重复 ②~⑥
链尾 → 交给 Vue 官方编译器（此时它看到的已全是它认识的原语）
```

四个要钉死的不变量：

- **每个特性是一个 `(code, id) => { code, map } | undefined` 函数**。返回 `undefined` 表示"我对这文件没兴趣"——这是 ② 的语言层落地。
- **链上每个特性都 `new MagicStringAST(code)` 新建自己的变换实例**，不共享。前一个的 `toString()` 输出就是后一个的原始 code，offset 在每步重新计算。
- **顺序就是依赖**。链是一个数组，构建工具按下标依次调用。"先把各种 `defineProps` 写法统一、再做类型展开"——这种先后关系不需要额外的依赖声明机制，写在数组里靠位置表达就够了。
- **所有特性 `enforce: 'pre'`**——它们都在 Vue 官方编译器之前运行，这是流水线能成立的前提（详见 §4 第三条）。

## 4. 关键权衡

### 把每个特性做成独立单元，换来可装配，代价是同一份源码被解析 N 次

每个特性都是一个独立的 unplugin 实例、可以单独发布为一个 npm 包、可以单独被某个项目关闭（开关为假就在装配时被 `filter(Boolean)` 剔除）。这件事的诱惑很大：宏的开发者只为自己的宏负责、用的人按需挑选、社区可以单独贡献一个宏而不必改动核心仓库。换来的是新宏零脚手架——把一个 transform 函数包成 `{ name, enforce: 'pre', transformInclude, transform }` 就完事，跨 Vite/webpack/esbuild 都能跑。

代价也直白：N 个启用的特性就要解析 + 遍历同一份 SFC N 次。补救措施就两条——② 在解析前先做一次 `code.includes(宏名)` 的廉价字符串检查，绝大多数不含本宏的 `.vue` 第一行就退出了；③ AST 解析带 `cache: true`，重复解析同一份代码命中缓存。短路挡掉了无关节点、缓存挡掉了重复解析，剩下的实际开销是"每个启用的特性都得 walkAST 一次"——这是这条流水线选独立装配要承受的代价。

**本质矛盾**：特性独立自治（好装配、好开关、好发布）与共享遍历上下文（一次 walk 多 visitor）天然对立。选了前者就得接受 N 次遍历，靠短路和缓存补救。

> 注：大纲里"统一 walk 调度"这个说法容易让人误以为有个设施把多个 visitor 合并到一次遍历。源码里的实际做法是"固定顺序 plugins 数组 + 串行 transform 传递"——每个特性在**自己的** walkAST 里独立遍历，**不存在**多 visitor 合并设施。

### 用一条固定顺序的链解决"多个宏想改同一节点"的冲突

想象一个反例：如果每个特性都并行触发、各改各的、最后再叠加，那 `chainCall` 改完的 `defineProps()` 节点，`defineModels` 还能认得出来吗？它的 offset 还对得上吗？这种"并发改写"几乎没有干净的解法。

Vue Macros 选了最朴素的路线——**串行**。链是一个数组，构建工具按下标依次调用，前一个的输出就是后一个的输入。每个特性在自己重新解析出的 AST 上工作，看到的永远是上一步改完之后的那份代码。冲突问题被消解为顺序问题：把"统一 `defineProps` 写法"的宏排在前面、"做类型展开"的宏排在后面——`betterDefine` 看到的就一定是已经统一好写法的 `defineProps()`，不用自己兜底各种语法变体。

顺序本身还能表达依赖，不需要任何额外的依赖声明语言。

代价是：顺序被硬编码在聚合包的 plugins 数组里（带 `// props` / `// emits` / `// convert to runtime props & emits` 这种语义分组注释）。新增特性必须人工找准插入位置——它该排在哪个分组后面、该让谁先走，都得作者想清楚。而且每个特性各自遍历，无法在一次 walk 里共享 visitor 上下文。

**本质矛盾**：宏改写之间天然有先后依赖（A 改完 B 才能基于结果继续），并发不安全。串行接力牺牲了"无依赖宏之间本可并发"的优化空间，换来"顺序即依赖"的最简表达——不需要任何依赖图、拓扑排序、调度器。

### 把所有宏放在官方编译器之前运行，换来与 Vue 版本解耦，代价是语义被锁死在"能否用官方原语还原"

这条流水线最关键的一个约束是：**所有自定义宏插件都标记 `enforce: 'pre'`，在 Vue 官方编译器之前运行**。这不是偶然，而是设计前提。

`defineEmit('open')` 最终被改写成两段：一行 `const __MACROS_emit = defineEmits(['open'])` 插在块首，原来的调用位置变成 `(...args) => __MACROS_emit('open', ...args)`。链式 `defineProps().withDefaults({...})` 被改写成 `withDefaults(defineProps(), {...})`。看出来了吗？不管自定义宏多花哨，最终落到代码里的全是 `defineProps` / `defineEmits` / `withDefaults` 这些**官方原语**。

换来的是与官方编译器的彻底解耦——Vue Macros 根本不关心 Vue 是 3.2 还是 3.4、官方编译器内部怎么改，它只负责把自己识别的宏翻译成官方编译器认识的入口，剩下的事全交给官方。升级 Vue 版本时，只要官方原语的语义没变，宏这边一行都不用动。

代价是宏能引入的全新语义有限。它能"补全官方宏缺失的能力"（如单个事件的 `defineEmit`）、能"把运行期约定编译期化"（如响应式 Props 解构），但很难引入一种官方原语根本表达不了的全新运行时行为。宏的语义被锁死在"能否用 `defineProps`/`defineEmits`/`withDefaults` 等少数原语还原"这条边界上。第 7 章会专门归纳这种约束催生的几类设计原型。

**本质矛盾**：宏想引入的语义新颖度 与 能否用官方原语还原 两头只能取一头。Vue Macros 选了对齐——可以激进改写语法糖，但糖的最底层必须是官方能吃下去的东西，否则插件写得再花哨官方编译器也不认。

## 5. 最小原理演示

下面用大约 40 行 JS 把这条流水线的骨架演一遍。不引入 Vue、不引入 unplugin、不引入真实的 SFC 解析——这些都不是这条流水线的原理。原理只有四件事：**短路、独立遍历、顺序接力、统一收尾**。每一行都对应上面某个原理点。

```js
// offset 级就地变换的迷你实现：只记录操作，不改原文（原理点⑤）
class MagicString {
  constructor(src) { this.src = src; this.ops = []; }
  overwrite(start, end, str) { this.ops.push([start, end, str]); return this; }
  toString() {
    const sorted = [...this.ops].sort((a, b) => a[0] - b[0]);
    let out = '', cursor = 0;
    for (const [start, end, str] of sorted) {
      out += this.src.slice(cursor, start) + str;
      cursor = end;
    }
    return out + this.src.slice(cursor);
  }
}

// 命中：在原文里找出 name(...) 调用的字节区间（演示用字符串模拟，
// 真实流水线里走 AST + isCallOf——这是前置章已讲透的部分，这里只演"命中"这件事）
function findCalls(code, name) {
  const calls = [];
  const needle = name + '(';
  let i = 0;
  while ((i = code.indexOf(needle, i)) !== -1) {
    let depth = 1, j = i + needle.length;
    while (depth > 0) { const c = code[j++]; if (c === '(') depth++; else if (c === ')') depth--; }
    calls.push({ start: i, end: j, arg: code.slice(i + needle.length, j - 1) });
    i = j;
  }
  return calls;
}

// 特性 A：把 foo(...) 改写成 bar(...)（原理点①：每个特性是独立 transform 函数）
function wrapFoo(code) {
  if (!code.includes('foo(')) return;                  // 原理点②：短路
  const s = new MagicString(code);
  for (const c of findCalls(code, 'foo')) s.overwrite(c.start, c.end, `bar(${c.arg})`);
  return s.toString();                                  // 原理点⑥：统一收尾
}

// 特性 B：把 double(...) 改写成 (...)*2
function inlineDouble(code) {
  if (!code.includes('double(')) return;
  const s = new MagicString(code);
  for (const c of findCalls(code, 'double')) s.overwrite(c.start, c.end, `(${c.arg})*2`);
  return s.toString();
}

// 流水线：固定顺序的插件链，串行接力（原理点③与⑦）
const pipeline = (features) => (code) =>
  features.reduce((c, f) => f(c) ?? c, code);          // ?? ：本特性返回 undefined 就原样透传

const transform = pipeline([wrapFoo, inlineDouble]);   // 顺序即依赖
console.log(transform('foo(1)\ndouble(2)\nfoo(double(3))'));
// 输出：
// bar(1)
// (2)*2
// bar((3)*2)
```

拿最后一行 `foo(double(3))` 走一遍：先轮到 `wrapFoo`，命中外层 `foo`、把整个表达式换成 `bar(double(3))`；再轮到 `inlineDouble`，它**重新扫**这份新代码、命中 `double(3)`、换成 `(3)*2`，最终得 `bar((3)*2)`。两个特性各自扫描、各自改写、靠 `reduce` 一环扣一环——这就是流水线最朴素的形态。

注意 `pipeline` 那行 `f(c) ?? c`：本特性返回 `undefined`（短路退出）时，原样透传给下一个。短短一行就是"独立遍历 + 顺序接力"的全部实现。

## 6. 执行轨迹

把演示换成真实的宏场景走一遍。

**输入**：一段 `<script setup>` 源码：

```js
const open = defineEmit('open')
const props = defineProps().withDefaults({ count: 0 })
```

**链**：`[defineEmit, chainCall]`（顺序：先单个事件展开、再链式调用拆开）。

**第 1 步：`defineEmit` 拿到原始 code**

- `code.includes('defineEmit(')` 命中，不短路。
- `parseSFC` 解析、`getSetupAst()` 产出 AST（命中缓存）。
- `walkAST` 找到 `defineEmit('open')` 节点（offset 假设为 14..36）。
- `s.overwrite(14, 36, '(...args) => __MACROS_emit("open", ...args)')`。
- `s.appendLeft(0, 'const __MACROS_emit = defineEmits(["open"])\n')`。
- 返回 `{ code, map }`。

**第 1 步产出 code**：

```js
const __MACROS_emit = defineEmits(["open"])
const open = (...args) => __MACROS_emit("open", ...args)
const props = defineProps().withDefaults({ count: 0 })
```

**第 2 步：`chainCall` 拿到上一步的 code 当原始输入**

- `code.includes('withDefaults(')` 命中。
- 重新 `new MagicStringAST(code)`、重新 `parseSFC`（缓存命中，开销可控）。
- `walkAST` 这次盯的是 `defineProps().withDefaults(...)` 这种链式调用节点。
- `s.overwriteNode(node, 'withDefaults(defineProps(), { count: 0 })')`。
- 返回新的 `{ code, map }`。

**第 2 步产出 code**：

```js
const __MACROS_emit = defineEmits(["open"])
const open = (...args) => __MACROS_emit("open", ...args)
const props = withDefaults(defineProps(), { count: 0 })
```

**链尾**：交给 Vue 官方编译器。它看到的只剩下 `defineEmits` / `defineProps` / `withDefaults`——全是它认识的原语。它按官方逻辑继续编译，根本不知道上面有两个插件替它做了归一。

每一步的关键中间态值得留意：每个特性产出的都是"对**自己**那份原始 code 的 offset 增量记录"。串行接力时，下一步拿到的字符串已经是上一步 `toString()` 的结果，offset 在每步重新计算——这就是为什么每个特性必须 `new` 自己的 `MagicStringAST`，不能跨特性共用。

## 7. 教学简化说明

上面的演示故意省略了不少工程细节：真实的 SFC 分块解析（`<script setup>` vs `<script>` vs `<template>` 各自怎么拆）、跨构建工具的 include 规则差异（webpack/rspack 与 Vite/Rollup 用不同正则）、helper import 的去重（用 `WeakMap<MagicString, Set<string>>` 保证 `ref` 这类 helper 在同一次变换里只 import 一次）、宏导入的擦除（`import ... with { type: 'macro' }` 整行删除）、少数特性拆成"前置 + 后置"两个插件的多阶段形态、解析缓存的真实缓存键。这些都不影响"流水线"这条主线，分别属于 SFC 解析、跨工具统一插件抽象、宏运行时擦除等各自章节的题目。

## 8. 小结

一条固定顺序的 plugins 数组，加上每个特性 `(code, id) => { code, map } | undefined` 的统一形态，就是 Vue Macros 把"写一个新宏"压成"写一个函数 + 在链上插一个位置"的全部秘密。它放弃了"一次 walk 共享多 visitor"的性能上限，换来每个宏都能单独发布、单独开关、跨构建工具分发；它把所有宏锁死在"能否用官方原语还原"的边界内，换来与 Vue 官方编译器的彻底解耦。

链跑完之后，每个特性都改过自己那一份、Vue 官方编译器接手一份它完全认识的代码。但下一个问题随之浮出来：什么样的"运行期约定"适合被这样前移到编译期、做成一个独立 transform 函数？这正是下一章「宏的设计原型：把什么前移到编译期」要回答的。