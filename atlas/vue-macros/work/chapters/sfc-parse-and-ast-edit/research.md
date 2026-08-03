# SFC 解析与增量 AST 编辑 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：写一个「编译期改写 Vue 单文件组件」的宏（比如 defineModels、jsx 指令）时，每个宏都要面对同一组琐碎问题——怎么把一个 `.vue` 拆成 `<script>` / `<script setup>`、怎么拿到能找节点的语法树、改完之后怎么保证 sourcemap 不错位、多个宏先后改同一个文件会不会互相覆盖。如果没有一块统一地基，每个宏都得各自重复「解析 + 算偏移 + 改字符串 + 修 sourcemap」，既啰嗦又极易踩偏移错位、map 失真这类隐蔽 bug。

- **一句话核心思想**：解析只做一次且只在真正需要时做，改写只记录「在哪个偏移处增删改」的增量——把"读源码"和"写源码"都压成可叠加的薄层。

- **设计动机（为什么需要它）**：官方编译器的解析器其实会在解析时就**顺手把两个块的语法树都建好**，可大量宏压根不需要这两棵树（有的只动模板、有的只动 import）。地基层因此把"建语法树"从解析时**推迟成按需触发**，并叠加一层「按源码内容缓存」——不调不解析、调了也只解析一次。改写侧则一律走「偏移增量」：所有改动登记成"在第 N 个字符处删/插/改"，多个宏的改动可以叠在同一份编辑缓冲上依次累积，最后一次性产出代码与 sourcemap。这是全书地基章（无前置依赖），后续每个宏都站在这块地基上；本章只立「懒解析 + 偏移增量编辑」这两根柱子，不展开任何具体宏。

- **关键权衡（核心原料）**：
  1. **砍掉解析器自带的急切语法树、改成按需触发的懒求值 → 换来不需要树的宏零解析开销、且内容级缓存让重复解析只发生一次 → 代价是调用方必须显式去"取树"，并且取到的节点坐标是相对"子块内容"的，所有后续编辑都得手动加一个偏移量。**
  2. **改写统一走「偏移增量」（删节点/覆盖节点/前插后插）而非字符串拼接 → 换来多道转换能叠在同一份编辑缓冲上、并天然产出字符边界精度的 sourcemap → 代价是每个宏都要自己算对那一个偏移量，偏移算错就会改到错位置（属于调试期成本）。**
  3. **用同一个入口同时接纳 `.vue` 与纯脚本（.js/.ts/.jsx）两种输入 → 换来宏的转换函数对单文件组件和纯脚本场景（整文件即 setup、JSX 指令）都适用 → 代价是两块脚本拼接时必须用换行+分号强制语句边界，且两块的语言必须一致（不一致直接报错）。**
  4. **宏自身的导入语句用 import attributes（`with { type: 'macro' }`）打标、并在编译期擦除 → 换来"宏的写法长得像普通导入"的低心智负担、运行时零残留 → 代价是依赖较新的导入属性语法，老旧工具链可能不识别。**

- **最小心智模型（3～7 步）**：
  1. 收到 `(源码, 文件 id)`：用一条正则判断 id 是不是 `.vue`。
  2. 若是 `.vue`：调用官方解析器，拿到描述符，取出两个脚本块的**文本**与语言，记下「setup 块在整篇文档里的起始偏移」；**语法树此时并不建立**。
  3. 宏在需要找节点时，才去"取 setup 的树"：首次触发会真正解析该块文本，并把结果塞进一张「以文本内容为键」的全局缓存。
  4. 宏遍历树找到目标节点（其坐标是相对"setup 块文本"的局部坐标）。
  5. 用编辑缓冲登记一条增量改动，**坐标 = 局部坐标 + 第 2 步记的偏移**（删/覆盖/前插/后插都一样）。
  6. 多个宏按管道顺序，各自往**同一份**编辑缓冲里继续叠改（所有坐标都锚定在原始文档上，互不干扰）。
  7. 收尾：仅当缓冲确实被改动过，才一次性输出新代码 + 字符边界精度的 sourcemap。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个约 40 行、能直接 `node`/`bun` 跑的脚本（依赖官方 SFC 解析器 + magic-string，能真跑最好，非硬要求），演透**权衡 1（懒解析 + 内容缓存）**与**权衡 2（偏移增量编辑 + sourcemap）**两条。脚本里：(a) 写一个迷你"解析 SFC"函数，**不**在解析时建树，而是返回一个"取树"闭包；(b) 闭包内部放一个解析次数计数器——连续调两次"取树"，断言计数器只 +1（证明懒 + 缓存命中）；(c) 取到树后找到一个 import 节点，用「节点 start + setup 偏移」删掉它，最后打印改动后的代码与 sourcemap 片段，肉眼确认删除区段被正确映射回原文件。
  - 应故意省略：语言一致性校验、导入属性插件配置、非 `.vue` 分支、宏导入擦除、注入额外 `<script>` 块、完整错误处理、HMR。
  - 演示载体建议：本仓库是 TS/JS，建议写成可 `bun run`/`node` 的独立脚本；核心是**用计数器证明"懒 + 缓存"**、**用一次删改后的 map 证明"偏移编辑保 sourcemap"**——演透原理即可，不追求工程完整。

- **正文不宜展开的细节**：webpack 专用的 `?vue&type=script` 子资源正则（仅注明它是为 webpack 把 SFC 拆成虚拟请求而留的兼容钩子即可）；"注入额外普通 script 块"那对 helper（start/end 包裹 `<script>` 标签）的细节应留给静态提升章；虚拟模块前缀常量留给编译期注入虚拟模块章；导入属性的 `deprecatedAssertSyntax` 兼容开关、setup-sfc 子模块正则里 `definePage` 的特例，都只需一句话点到。

- **推荐的一个执行轨迹例子**：输入 `<script setup lang="ts">import { x } from './x'; const a = 1</script>` 包成的 SFC。关键中间态：解析得到 `setup 块起始偏移 = 39`（示意）；第一次"取树"触发解析（计数 1），第二次"取树"命中缓存（计数仍 1）；定位到 import 节点，其局部区间为 `[0, 24)`。输出：以 `[39, 63)` 登记一条删除，收尾产出"删掉 import 的新代码 + 把该区段正确映射回原文件的 sourcemap"。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **地基入口把 `.vue` 与纯脚本统一成"一段待解析的代码 + 一个语言"**：对非 `.vue` 文件直接按扩展名推断语言并原样返回源码；对 `.vue` 文件解析后把 `<script>` 与 `<script setup>` 的内容用 `\n;\n` 拼成一段（分号强制语句边界，避免两块粘连）。源码位置: packages/common/src/vue.ts:70-89

- **语言一致性是硬约束**：当 `<script>` 与 `<script setup>` 同时存在且二者 `lang` 不一致时直接抛错（默认按 `'js'` 对比），杜绝"两块用不同语言却要合成一段"的非法输入。源码位置: packages/common/src/vue.ts:33-46

- **懒解析的落点：把官方描述符自带的急切语法树字段从类型层面剔除**。`SFCScriptBlock` 用 `Omit<..., 'scriptAst' | 'scriptSetupAst'>` 主动去掉这两个字段，迫使所有取树必须走 getter，从类型上断绝"顺手拿到现成树"的旧路径。源码位置: packages/common/src/vue.ts:12-15

- **取树是闭包、按需触发**：解析时只记下 setup 块在文档里的起始偏移，`getSetupAst`/`getScriptAst` 作为方法挂在外推对象上，**被调用才**对该块的 `content` 做解析；传 `cache: true` 让 ast-kit 走内容级缓存。源码位置: packages/common/src/vue.ts:48-67

- **内容级缓存的真实语义（外部依赖 ast-kit，推断已核实源码）**：`babelParse(code, lang, { cache })` 在 `cache` 为真时，先查以**源码字符串本身为键**的全局 `parseCache`；命中即复用，未命中才解析并写入。这意味着"懒求值"叠上"内容缓存"后，同一块 setup 文本即便被多个宏、多次取树也只解析一次。源码位置: 依赖 ast-kit（GitHub sxzz/ast-kit）/src/parse.ts 的 `babelParse`（核实：`if (cache) result = parseCache.get(code); if (!result) { result = parse(...); if (cache) parseCache.set(code, result) }`）

- **偏移增量编辑的坐标平移（外部依赖 magic-string-ast，推断已核实源码）**：`removeNode/overwriteNode/sliceNode` 都接受 `{ offset }`，内部 `getNodePos` 把节点局部区间 `[node.start, node.end]` 加上 `offset` 得到文档级区间，再透传给底层 magic-string 的 `remove/overwrite`。因 setup 树的坐标是相对"setup 块文本"的，这个 `offset` 就是"setup 块在整篇文档的起始偏移"。源码位置: 依赖 magic-string-ast（GitHub sxzz/magic-string-ast）/src/index.ts 的 `getNodePos`/`removeNode`（核实：`return [offset + node.start, offset + node.end]`）

- **sourcemap 精度来自底层 magic-string 的高分辨率模式**：收尾的 `generateTransform` 仅在 `hasChanged()` 时输出，map 用 `generateMap({ source: id, includeContent: true, hires: 'boundary' })`——`hires: 'boundary'` 是字符边界级映射，正是增量改写仍能精确保 sourcemap 的来源。源码位置: 依赖 magic-string-ast/src/index.ts 的 `generateTransform`

- **地基只给"setup 偏移"单一字段，隐含"宏主要改 setup"的假设**：`offset` 取自 `scriptSetup?.loc.start.offset ?? 0`。若改的是普通 `<script>`（其树坐标相对 script 块文本），这个 setup 偏移并不适用（推断：改普通 script 时需调用方自行用 script 块偏移，框架未直接提供）。源码位置: packages/common/src/vue.ts:52

- **宏导入用 import attributes 标记并擦除**：`removeMacroImport` 判定带 `with { type: 'macro' }` 导入属性的 `ImportDeclaration`，调用编辑缓冲的 `removeNode(node, { offset })` 删除——宏导入在编译期被识别并抹掉，运行时不残留。constants.ts 顶部自身就有一条这样的宏导入（取仓库链接），是同一机制的实例。源码位置: packages/common/src/vue.ts:107-122，packages/common/src/constants.ts:1

- **constants.ts 是全局名册 + 路由正则 + 虚拟前缀**：集中定义全部宏名常量（`DEFINE_PROPS` 等）供各宏复用；定义 SFC/源文件/setup-sfc/webpack 子资源/node_modules/支持扩展名等正则用于 include 过滤与文件分流；`VIRTUAL_ID_PREFIX` 为后续虚拟模块章预留前缀。源码位置: packages/common/src/constants.ts:3-38

## 关键调用链