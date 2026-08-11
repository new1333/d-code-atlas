# SFC 解析与增量 AST 编辑

> 本章属于 primitive 层，全书地基章（无前置依赖）。
> 学完你能用一句话讲清：vue-macros 的所有宏为什么都把「解析」和「改写」压成两层薄皮——懒解析换零无用开销，偏移增量换多宏叠加而 sourcemap 不乱。

## 1. 为什么需要它（设计动机）

写一个 Vue 宏要做的事其实并不神秘：拿到 `.vue` 文件，找到要改的位置，改完之后让 sourcemap 不错位。但 vue-macros 下面挂着三十多个宏——`defineModels`、`defineProps`、JSX 指令、`setup-sfc`……如果这件事让每个宏各写一遍，三十一份就长三十一遍，而且偏移算错、map 失真这类隐蔽 bug 一旦混进管道里几乎没法定位。

这就是为什么全书从这一章开始。所有宏都需要一个共同的回答：怎么把 `.vue` 拆成可读的块、怎么把改写登记成可叠加的增量。本章就是这两根支柱——后面每一章都在这层地基上长出来：`unplugin` 包装它、`virtual-helper` 注入它、各种宏消费它。

## 2. 核心思想

解析只在真正需要时做、且只做一次；改写只记下「在哪个偏移处增删改」的增量。读源码和写源码都被压成两层薄皮，多道转换叠在同一份缓冲上互不干扰。

## 3. 心智模型

数据结构上有三件东西：

- **SFC 解析结果**：拿到 `<script>` / `<script setup>` 的文本、它们的语言、以及 setup 块在整篇文档里的起始偏移。注意只是文本，语法树此时并不存在。
- **取树闭包**：`getSetupAst` / `getScriptAst` 是挂在解析结果上的方法。调它才解析，并以源码字符串为键塞进一张全局缓存表。第二次调同一块文本，命中缓存。
- **编辑缓冲**：所有改动登记成 `在文档坐标 [start, end) 删/插/改` 的条目。它像 git 的暂存区：每个宏只往里登记改动，不直接动原文件，多个宏的条目叠在同一份缓冲里，最后一次性结算出新代码与 sourcemap。

坐标关系是关键：

```
setup 块在文档里的起始偏移：setupOffset
setup 树里某节点的局部区间：[node.start, node.end)   ← 相对 setup 块文本
登记到编辑缓冲时的文档级区间：[node.start + setupOffset, node.end + setupOffset)
```

流程上一共七步：

1. 拿到 `(源码, 文件 id)`，正则判一下是不是 `.vue`。
2. 是：调官方 `@vue/compiler-sfc` 的 `parse`，取两个脚本块的文本与语言，记下 `setupOffset`。**树此时不建。**
3. 不是：把整文件当成「一整块 setup」，语言按扩展名推断。
4. 宏在需要找节点时，调 `getSetupAst()`——首次触发解析，后续命中缓存。
5. 找到目标节点（坐标是相对 setup 块文本的局部值）。
6. 往编辑缓冲登记一条改动，文档坐标 = 局部坐标 + setupOffset。
7. 多宏按管道顺序往**同一份**编辑缓冲叠改，所有坐标都锚在原始文档上。收尾仅当缓冲非空，才一次性产出新代码与字符边界 sourcemap。

## 4. 关键权衡

### 4.1 把急切建树改成按需取树，省掉无用解析

官方 `@vue/compiler-sfc` 的解析器在解析时其实**顺手就把两个块的语法树都建好**。可大量宏压根用不到这两棵树——`defineModels` 只关心 setup、`short-bind` 只动模板、`chain-call` 只动 import。如果照搬官方实现，每个 `.vue` 文件都被无差别建两棵树，纯属浪费。

地基层的做法是把 `scriptAst` / `scriptSetupAst` 这两个字段从类型层面**主动 `Omit`**——`SFCScriptBlock` 用 `Omit<..., 'scriptAst' | 'scriptSetupAst'>` 强行擦掉，让调用方从类型上就摸不到「现成的树」。取而代之的是挂在描述符上的 `getSetupAst` / `getScriptAst` 闭包：不调不解析，调了也只解析一次（再叠一层「以源码字符串为键」的内容缓存）。

代价是：调用方必须显式去「取树」，并且取到的节点坐标是相对 setup 块文本的，所有后续编辑都得手动加一个 `setupOffset`。

这条化解的矛盾是「**让没用树的宏零开销**」与「**让用树的宏仍然方便**」——把树的生成从解析阶段推到取用阶段，让两边都按需付费。

### 4.2 改写一律走「偏移增量」，多宏可叠在同一份缓冲

写编译期改写最直觉的写法是字符串拼接：找到 import、删掉它、把剩下的两段拼回去。但这种写法一旦两个宏先后改同一个文件就乱套了——第二个宏拿到的是第一个宏改过的字符串，所有偏移都得重新算。

地基层改走「偏移增量」：所有改动登记成「在文档坐标 `[start, end)` 处删/插/改」的条目，多宏按管道顺序往**同一份编辑缓冲**里叠。所有坐标都锚在**原始文档**上，互不串扰。底层 `magic-string` 在收尾时一次性结算这些条目，并顺便产出 sourcemap——`hires: 'boundary'` 模式给到字符边界精度，正是「改动仍能精确保 sourcemap」的来源。

代价是：每个宏都得自己算对那一个偏移量（局部 + setupOffset）。偏移算错就会改到错位置——属于调试期成本，运行时不会爆，反而更难定位。

这条化解的矛盾是「**多道转换要能串成管道**」与「**每道转换不应被前一道干扰**」——把「改」拆成「登记」和「结算」两步，让所有改动并行地指向原始文档。

### 4.3 同一个入口同时接纳 `.vue` 与纯脚本

很多宏的转换函数对「`.vue` 的 setup 块」和「`.js/.ts` 整文件」是一视同仁的——`jsx-directive` 处理 `.jsx`、`setup-sfc` 把整文件当 setup。如果地基层只接 `.vue`，每个宏都得自己再写一份「纯脚本入口」。

于是入口统一：对 `.vue` 走官方 `parse` 取 setup 文本；对纯脚本直接按扩展名推断语言、原样返回源码。两种输入都被归一成「一段代码 + 一个语言 + 一个偏移」。

代价是两块脚本拼接（当 `<script>` 与 `<script setup>` 同时存在时）必须用 `\n;\n` 强制语句边界，避免两块粘连；并且两块的语言必须一致，不一致直接抛错（默认按 `'js'` 对比）。

这条化解的矛盾是「**调用方想用一个统一的'setup 文本'抽象**」与「**输入可能是 SFC 也可能是纯脚本**」——把差异收在解析入口，让宏的转换函数对两种场景都通用。

### 4.4 宏导入用 import attributes 打标，编译期擦除

宏自身需要从 vue 里 import 进来（比如 `import { defineModels } from 'vue-macros/macros'`），但宏在运行时是被擦除的——它只是编译期的一个「标记」。怎么让这个 import 既写得像普通导入、又在运行时不残留？

地基层用导入属性 `with { type: 'macro' }` 给宏导入打标：`removeMacroImport` 遍历 import 节点，发现带这个属性的就用编辑缓冲的 `removeNode(node, { offset })` 删掉。运行时零残留，写法上又跟普通导入完全一致。

代价是依赖较新的导入属性语法（旧版叫 assert statement），老旧工具链可能不识别——这是 vue-macros 选择站在新语法一边的代价，靠 `deprecatedAssertSyntax` 兼容开关回退。

这条化解的矛盾是「**宏导入想写得像普通 import 一样直觉**」与「**运行时不能残留任何宏痕迹**」——用语法标记把两者区分开来，编译期识别并抹掉。

## 5. 最小原理演示

下面这段约 60 行的脚本演透两件事：**懒解析 + 内容缓存让两次取树只解析一次**（看 `parseCount`）和**偏移增量编辑保住文档级 sourcemap 区段**（看登记的 `[start, end)` 区间是文档级而非 setup 局部）。

为了能在 `node`/`bun` 直接跑、不依赖真实的 `@vue/compiler-sfc` 与 `@babel/parser`，下面用极简 mock 顶替两块真实依赖——mock 的细节不重要，重点看 `parseSfc`、`getSetupAst`、`editor.removeNode` 三处如何串起来。

```ts
// 演透懒解析 + 内容缓存 + 偏移增量编辑

// —— mock：顶替 @vue/compiler-sfc 与 @babel/parser 的极简版 ——
type Node = { type: string; start: number; end: number }
type AST = { program: { body: Node[] } }

function mockBabelParse(code: string): AST {
  // 假装解析出一条 import：从开头到第一个分号（含分号）
  const importEnd = code.indexOf(';') + 1
  return { program: { body: [{ type: 'ImportDeclaration', start: 0, end: importEnd }] } }
}

const parseCache = new Map<string, AST>()
let parseCount = 0

function babelParse(code: string): AST {
  if (parseCache.has(code)) return parseCache.get(code)!   // 内容级缓存命中
  parseCount++                                              // 真正解析才计数
  const ast = mockBabelParse(code)
  parseCache.set(code, ast)
  return ast
}

// —— 地基入口：返回 setup 文本 + 偏移 + 取树闭包（懒解析） ——
function parseSfc(source: string) {
  // 模拟官方 parse：定位 <script setup> 块
  const openTag = '<script setup>'
  const openEnd = source.indexOf(openTag) + openTag.length
  const closeStart = source.indexOf('</script>')
  const content = source.slice(openEnd, closeStart)
  return {
    content,
    setupOffset: openEnd,
    getSetupAst() { return babelParse(content) },   // 不调不解析
  }
}

// —— 编辑缓冲：登记偏移增量，最后一次性结算 ——
function makeEditor() {
  const edits: Array<{ start: number; end: number }> = []
  return {
    removeNode(node: Node, offset: number) {
      // 局部坐标 + setup 偏移 = 文档级区间
      edits.push({ start: node.start + offset, end: node.end + offset })
    },
    applyTo(source: string) {
      // 倒序结算，避免前一条改动影响后一条的坐标
      const sorted = [...edits].sort((a, b) => b.start - a.start)
      let out = source
      for (const e of sorted) out = out.slice(0, e.start) + out.slice(e.end)
      return out
    },
    segments() { return edits.map(e => `[${e.start},${e.end})`) },
  }
}

// —— 演透原理 ——
const sfcSource = `<script setup>import { x } from './x'; const a = 1</script>`
const parsed = parseSfc(sfcSource)

console.log('setup 偏移:', parsed.setupOffset)            // 14
console.log('取树前计数:', parseCount)                    // 0
const ast1 = parsed.getSetupAst()
const ast2 = parsed.getSetupAst()
console.log('两次取树后计数:', parseCount)                // 1 ← 缓存命中

const editor = makeEditor()
for (const n of ast1.program.body) {
  if (n.type === 'ImportDeclaration') editor.removeNode(n, parsed.setupOffset)
}

console.log('改动后:', editor.applyTo(sfcSource))
// → <script setup>; const a = 1</script>

console.log('文档级区段:', editor.segments())
// → ["14,40)"] ← import 节点局部 [0,26) + setup 偏移 14
```

`parseCount` 停在 1 演的是懒解析 + 缓存命中；`segments()` 给出的 `[14, 40)` 演的是节点局部坐标 `[0, 26)` 经 setup 偏移 14 平移成文档级区间——sourcemap 就是从这个文档级区间反推回原文件的字符级映射。

## 6. 执行轨迹

输入 `<script setup>import { x } from './x'; const a = 1</script>`，包成一段最小 SFC（共 51 个字符）。

- **解析阶段**：`parseSfc` 找到 `<script setup>` 开标签结束位置 = `14`，闭标签开始位置 = `51`。`content = "import { x } from './x'; const a = 1"`（长 37 字符），`setupOffset = 14`。此时 `parseCount = 0`。
- **第一次取树**：宏调 `getSetupAst()`，触发 `babelParse(content)`——`parseCount` 从 0 跳到 1，缓存表里多一条 `"import { x } from './x'; const a = 1" → AST`。返回的 AST 中 import 节点局部区间 `[0, 26)`（到第一个分号 +1）。
- **第二次取树**：另一个宏（或 HMR 重跑）再调 `getSetupAst()`，命中缓存——`parseCount` 仍为 1。
- **登记改动**：编辑缓冲收到一条 `{ start: 0 + 14, end: 26 + 14 } = { start: 14, end: 40 }` 的删除条目。
- **收尾结算**：编辑缓冲在原始 51 字符文档上倒序删 `[14, 40)`，得到 `<script setup>; const a = 1</script>`。同时 `generateMap({ hires: 'boundary' })` 产出 sourcemap，把新代码里 `; const a = 1</script>` 这段字符级映射回原文件的对应区段。

整条轨迹的关键是三件事：解析阶段没建树、两次取树只解析一次、改动以文档级坐标锚在原文件上。这三件合起来让多宏叠加既省又稳。

## 7. 教学简化说明

为了演透原理，演示故意省略了：语言一致性校验、两块脚本拼接时的 `\n;\n` 边界处理、`.vue` 之外的纯脚本分支、import attributes 标记与 `removeMacroImport`、注入额外普通 `<script>` 块的 helper、HMR 与 webpack `?vue&type=script` 子资源正则——这些都是真实地基层的工程职责，但它们都长在「懒解析 + 偏移增量」这两根支柱之上。

## 8. 小结

vue-macros 的每一道宏都站在同一块地基上：解析只在需要时触发、且只解析一次；改写登记成偏移增量、多宏叠在同一份缓冲上。所以后面看到任何一条宏时，你都可以假定它只关心「找节点 + 登记改动」这两步，剩下的解析、缓存、sourcemap 都被这块地基兜住了。

下一章从「单文件内部如何改」往外走一步——一个宏怎么同时跑在 vite/rollup/webpack/esbuild/rspack/rolldown 六套构建器上。看 `unplugin` 怎么把同一份 `transformXxx` 函数分发出去。