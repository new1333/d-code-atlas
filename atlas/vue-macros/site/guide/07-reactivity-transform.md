# 响应式语法糖：赋值即 .value

> 本章属于 composite 层。前置：SFC 解析与增量 AST 编辑。
> 学完你能：用一句话讲清「响应式糖为什么选编译期静态改写、而非运行时 Proxy，代价是什么」。

## 1. 为什么需要它

写 Composition API 的人大概都有过这种体会：每个 `ref` 都得拖一个 `.value` 才能碰它真正的值。一段十来行的逻辑里，`count.value++`、`user.value.name = '...'`、`total.value = a.value + b.value` 满眼都是 `.value`——既啰嗦，又容易漏写，模板字符串里尤其碍眼。

更扎心的是：声明成响应式之后，你心里其实是在把它当一个普通变量用的，只是 Vue 偏要让你每次都提醒自己「这是个 ref」。理想很朴素——**声明成响应式之后，就当普通变量用**。

上一章 `better-define` 把「类型层面的样板」收掉了一截，让 TS 类型直接成为运行时校验的真相来源；但它没动 setup 内的**书写**本身，`.value` 满天飞的问题还在原地。要解决它，需要的是另一类机制：**在源码标识符层面做一次定向重写**。

这一章就来回答：怎么在不发明任何新运行时能力的前提下，让 `count = $ref(0)` 之后的 `count` 像普通变量一样被读写。

## 2. 核心思想

**编译期记账，引用处补 `.value`**。

把这套糖分成两件事：先在编译期把「谁是响应式变量」**登记成册**，再在源码里对它的每一处读 / 写，**就地补上 `.value`**。运行时拿到的代码，跟你手写 `ref().value` 一模一样，没有新魔法，只是把 `.value` 的填写工作搬到了编译期。

## 3. 心智模型

转换的执行可以拆成 7 步，本质就「登记 → 改写」两个阶段：

1. **正则粗筛**：源码里若没有 `$ref` / `$()` / `$computed` / `$$()` 这类痕迹，直接原样返回，连解析都不做。
2. **第一遍登记**：扫描全部声明，凡是 `const x = $ref(...)` 或 `const x = $(...)` 这种形态的，把 `x` 记进「响应式绑定表」，标注它是不是 const、是不是来自 props 解构。普通声明也占位记一笔（记成 `false`），免得后面误判。函数体、块、catch 各开一层新作用域。
3. **第二遍改写**：遍历每一处**标识符引用**，从最内层作用域向外逐层查表。
4. **命中响应式绑定**：在标识符后面插入 `.value`；对象简写 `{ foo }` 补成 `{ foo: foo.value }`；若它是 `const` 却出现在赋值 / 自增的左侧，直接报错。
5. **命中 props 绑定**：改写成对 `__props` 的属性访问（`__props.foo`）。
6. **遇到解构声明**：把被 `$()` 包住的解构模式整体替换成一个临时变量，再在后面追加「逐字段取值并包成响应式」的语句。
7. **遇到 `$$()`**：把它标为「转义区域」，区域内对响应式变量的引用**不加** `.value`（取原始 ref 对象本身），并删掉 `$$` 符号。最后把用到的 helper（`ref` / `computed` / `toRef`）统一注入到顶部。

底下那套「懒解析、magic-string 增量改写、setupOffset 偏移」的解析底座已在第 1 章讲过，本章不重演——我们关心的是它**之上**针对标识符读写的一层定向重写。

## 4. 关键权衡

> 本章的主角。

### 静态文本改写，换零运行时开销

要消掉 `.value`，理论上只有两条路。

一条是**运行时**路：用 Proxy 包一层，访问 `count` 时自动解包到 `count.value`。另一条是**编译期**路：在源码上做静态改写——读者写 `count`，编译器在背后把它变成 `count.value`，运行时拿到的就是 `count.value`，根本不知道有人写过 `count`。

vue-macros 选了第二条。

- **换来**：零额外运行时开销（运行时跑的还是原生 `ref().value`，没有任何代理层）；与原生 `ref` 完全兼容（同一个 ref，外面不包任何东西）；类型推导不受影响（TS 看到的仍是 `Ref<number>`）。
- **代价**：失去**语法透明性**——看 setup 源码时，肉眼分不清哪些变量被宏接管、哪些是普通变量；为了让改写不误伤，必须做大量**保守的静态判定**：作用域分析、排除声明位标识符、跳过类型节点、跳过属性键……每一个边界都是一处潜在的误伤点。

> 这条权衡化解的是「**书写体验 vs. 运行时透明**」这对矛盾：要么让运行时替你包一层（多一道开销），要么让编译器替你填 `.value`（多一堆判定）。它选了后者。

### 两遍遍历，换引用的正确性

转换器完全可以「单遍边走边改」——扫到一个声明就改一个，扫到一个引用就查一次。但它没这么做，而是分了两遍：先 `walkScope` 把全文件的声明都扫完、建好绑定表，再 `walkAST` 遍历引用查表改写。

为什么非得两遍？因为**引用可以出现在声明之前**：

```js
function inc() { count++ }      // 引用 count
const count = $ref(0)            // 声明 count
```

`inc` 里的 `count` 引用会先被遍历到，但真正的 `count` 声明在下面。单遍边走边改就漏了。两遍走的逻辑是：先把全文件扫一遍把 `count` 登记进表，再回头处理引用——这时候表是完整的，引用出现在哪都不怕。

- **换来**：引用可以出现在任意位置（声明之前、嵌套深处、函数闭包里）都能被正确识别。
- **代价**：两趟遍历（性能损耗薄到可以不展开）；以及必须**手工维护一个词法作用域栈**——函数体、块、catch 各开一层，标识符从内到外逐层查表。这个栈是正确性的根，也是代码里最容易绊倒读者的地方。

> 化解的是「**正确性 vs. 实现简单**」这对矛盾：单遍最简单，但跨声明顺序就漏改；两遍复杂一点，但任意位置都准。

### 临时变量加逐字段取值，换完整解构语法

`const { x } = $(useFoo())` 这种**响应式解构**——`useFoo()` 返回一个 reactive 对象，希望解构出来的 `x` 还是个 ref（不然解构完响应性就丢了）。

改写思路是：把整个解构模式**整体替换成一个临时变量**，再在后面**逐字段**取出值、包成 ref：

```js
// 改写前
const { x } = $(useFoo())
// 改写后
const __$temp_1 = useFoo()
const x = _toRef(__$temp_1, 'x')
```

为什么不让 `useFoo()` 返回值直接解构？因为那样 `x` 拿到的是裸值，响应性已经断在解构那一刻。要保住响应性，每个字段都必须**单独**包成一个 ref。

- **换来**：响应式解构的**完整语法**——默认值 `x = 1`、嵌套 `{ a: { b } }`、重命名 `{ x: y }` 都能正确处理。
- **代价**：要生成临时变量名；嵌套解构要靠一段「路径拼字符串」逻辑（递归 ObjectPattern / ArrayPattern，把 `a.b.c` 这种访问路径还原出来）才能在取值时找到正确的字段。rest 元素（`...rest`）干脆不支持，直接报错——保响应性的成本太高。

> 化解的是「**语法便利 vs. 语义正确**」这对矛盾：直接解构最方便，但响应性丢了；要让每个字段都是 ref，就只能拆成逐字段包。

### 正则粗筛，换跳过无关文件

转换入口 `shouldTransform(src)` 是一条单行正则：

```ts
const transformCheckRE =
  /\W\$(?:\$|ref|computed|shallowRef|toRef|customRef)?\s*(?:[(<]|as)/
```

它干的活儿很轻——判断源码里**有没有** `$` / `$$` / `$ref` 这些糖的痕迹。没有，整个转换直接原样返回，连 babel 都不调。

- **换来**：绝大多数无糖文件零成本跳过——构建管线里挂着这个插件，但没糖的文件不付出任何解析开销。
- **代价**：正则只是「是否进入转换」的**粗筛**，存在边界误判的可能（比如字符串里碰巧出现了 `$ref(`）；但最终是否真有可改写的糖，仍由 AST 判定保证，所以**正确性不受影响**，最多是多跑一次解析。

> 化解的是「**入口开销 vs. 跳过效率**」这对矛盾：所有文件都走完整 AST 太贵，先用一条便宜的正则把无糖的挡在门外，错的至多多跑一次解析。

## 5. 最小原理演示

下面这段约 50 行的脚本，只演示「**两遍遍历 + 作用域绑定表 + 引用处补 `.value` + `$$()` 转义**」这四件事——也就是上面**前两条权衡**的实现骨架。解构拆解、props 解构 polyfill、helper 注入、TS 类型节点跳过等工程细节全部故意省略。

```ts
import { parse } from '@babel/parser'
import MagicString from 'magic-string'

const SHORTHANDS = new Set(['ref', 'computed', 'shallowRef'])

function transform(src: string): string {
  // 绑定表：变量名 → 是否响应式。
  // 第一遍扫描时填写，第二遍改写时查表。
  const bindings = new Map<string, boolean>()

  // 第一遍：扫所有顶层声明，把 $ref / $ / $computed 包出来的变量登记进表
  function registerDeclarations(ast: any) {
    for (const stmt of ast.body) {
      if (stmt.type !== 'VariableDeclaration') continue
      for (const decl of stmt.declarations) {
        const init = decl.init
        if (!init || init.type !== 'CallExpression') continue
        const callee = init.callee.name ?? ''
        const isSugar =
          callee === '$' || (callee[0] === '$' && SHORTHANDS.has(callee.slice(1)))
        if (!isSugar || decl.id.type !== 'Identifier') continue
        bindings.set(decl.id.name, true)
      }
    }
  }

  const ast = parse(src, { sourceType: 'module' })
  const s = new MagicString(src)

  // 跑第一遍：先把绑定表建起来，后续引用查表才能命中
  registerDeclarations(ast)

  // 转义区深度：进入 $$() 时 +1、退出时 -1。
  // 区内的响应式引用不加 .value，取原始 ref 对象
  let escapeDepth = 0

  // 第二遍：遍历每个标识符引用、命中绑定就补 .value
  function walk(node: any) {
    if (!node || typeof node.type !== 'string') return

    // 命中 $$() 调用：删掉 $$ 符号、标记进入转义区
    if (node.type === 'CallExpression' && node.callee.name === '$$') {
      s.remove(node.callee.start, node.callee.end)
      escapeDepth++
      for (const k in node) walk(node[k])
      escapeDepth--
      return
    }

    // 命中一个标识符引用：登记在表里、且不在转义区，就在后面补 .value
    if (node.type === 'Identifier' &&
        bindings.has(node.name) &&
        escapeDepth === 0) {
      s.appendLeft(node.end, '.value')
      return
    }

    // 否则继续往下找
    for (const k in node) {
      const v = node[k]
      if (Array.isArray(v)) v.forEach(walk)
      else walk(v)
    }
  }

  walk(ast)
  return s.toString()
}
```

每个关键点对应一条原理：`bindings` 这张表 + `registerDeclarations` 演第一遍登记；`walk` + `bindings.has(...)` 演第二遍查表改写；`s.appendLeft(node.end, '.value')` 演核心动作「引用处补 `.value`」；`escapeDepth` 演转义区内的边界处理。

## 6. 执行轨迹

输入（一段假想的 setup 代码）：

```js
const count = $ref(0)
const double = $computed(() => count * 2)
function inc() {
  count++
  log($$(count))
}
```

**第一遍登记**：扫到 `const count = $ref(0)` → `count` 进响应式表（`isConst = true`）；扫到 `const double = $computed(...)` → `double` 进响应式表。函数声明 `inc` 不进。

**第二遍改写**，逐处走读：

- 简写 `$ref` / `$computed` 的调用名 → 改写成 `_ref` / `_computed`（运行时 helper）。
- 进入 `() => count * 2` 箭头函数体，扫到 `count` 这个 Identifier，查表命中（`escapeDepth === 0`）→ `s.appendLeft` 在它后面插入 `.value`，结果是 `count.value * 2`。
- 进入 `inc` 函数体，扫到 `count++` 里的 `count`，查表命中 → `count.value++`。
- 扫到 `log($$(count))`：识别出 `$$()` 调用，删掉 `$$` 符号、`escapeDepth` 从 0 变 1。
- 继续递归到 `count` 这个 Identifier，虽然查表命中，但处于转义区 → 跳过 `.value` 改写，保持裸 `count`。
- 退出 `$$()`，`escapeDepth` 回到 0。

**输出**（顶部 helper import 注入 `ref as _ref, computed as _computed`）：

```js
const count = _ref(0)
const double = _computed(() => count.value * 2)
function inc() {
  count.value++
  log(count)
}
```

`count.value++` 与 `log(count)` 的对比是这套机制最浓缩的演示：同一个 `count`，在转义区外被补上 `.value`，在 `$$()` 内则保留原始 ref。「登记 + 查表 + 转义」三件事，在这一行里同时演完。

## 7. 教学简化说明

本章演示故意省略了：

- 解构拆解（`processRefObjectPattern` / `processRefArrayPattern` + `pathToString` 路径拼接）。
- props 解构 polyfill（withDefaults / mergeDefaults / rest 代理走虚拟 helper 模块，同一机制已在第 3 章「编译期注入虚拟 helper 模块」讲过）。
- TS 类型节点跳过、`const` 出现在赋值左侧时的报错。
- 跨 `<script>` / `<script setup>` 块的作用域穿透（`knownRefs` 把 script 块的 ref 传给 setup）。
- 顶部 helper import 注入的细节（`importedHelpers` 集合 + 顶部 `prepend`）。
- 词法作用域栈的手工维护（演示里只用了 `escapeDepth` 这一个最简状态，真实实现是逐层作用域栈）。

这些都是工程完整度，不是原理本身。

## 8. 小结

响应式糖的本质就这么一句话：**把 `.value` 这件事，从书写时搬到了编译期**。它没有发明新运行时，只是替你填一份填得满文件都是的样板；它没有走 Proxy 路线，所以运行时拿到的还是原生 `ref().value`；为了让改写不误伤，它付出了「失去语法透明性 + 大量保守静态判定」的代价。

它演示了一种很 vue-macros 的解题姿势——**在编译期替读者做事，把运行时留得干干净净**。下一章会把这个姿势推得更远：当一个 `<script setup>` 不够用时，怎么把 SFC 的结构本身也打开。