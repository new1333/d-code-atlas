# 流式 JSON 解析：应付百万行依赖输出 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在一个有几千个依赖、上万个传递依赖的大型 monorepo 里跑 `pnpm ls --json --recursive`，stdout 一次性吐出来的 JSON 可以达到数百兆。直接 `JSON.parse(stdout)` 会先 `Buffer.toString()` 把整段字节塞进一根 V8 字符串——超过 V8 字符串上限（"Invalid string length"）就直接崩。更糟的是 pnpm 在 `--recursive` 模式下会把每个 workspace 的清单**作为独立的 JSON 数组依次写进同一根 stdout**（`[{...}][{...}][{...}]`），这种"多个 JSON 拼接在一起"的形态对 `JSON.parse` 是非法的——它只读第一个数组就停。

- **一句话核心思想**：把"读 JSON"拆成「**扫描字节产生 token 流**」+「**按 token 名分派给一个有状态装配器**」两段，让对象边到边装配，永不物化整根字符串。

- **设计动机（为什么需要它）**：npm/pnpm 的清单 JSON 同时具备"超大"和"可拼接"两个属性。一次性反序列化在两个属性上都会失败：超大撑爆 V8 字符串，可拼接违反"一个文件一个值"的默认约定。流式装配换来的正是"内存里同时只持有一个 token + 一份半成品对象"，从而既能吃下任意大的 stdout，也能在装配器报告"完成"后立刻收割、复位、继续吃下一个顶层值。

- **关键权衡（机制丰富章，列 4 条）**：
  - 「**用 token 名做动态分派** (`assembler[chunk.name]?.(chunk.value)`) → 换来了 tokenizer 与 assembler 的零连线解耦（新增 token 类型不需要改 dispatcher）→ 代价是失去了类型安全：必须 `@ts-expect-error` 把 chunk 当作 any 处理，token 名拼写错误只能运行时发现」。
  - 「**开启 `jsonStreaming: true` 非标准模式**接受多个顶层值 → 换来了 pnpm `--recursive` 多 workspace 输出能被一根 stdin 一口吃下 → 代价是依赖 `stream-json` 的私有约定，换库就得重写」。
  - 「**每个顶层值完成后立刻 `push(...current)` 摊平进同一个 `values` 数组** → 换来了上层拿到的是统一的 `PackageNodeRaw[]`，无论源头发了 1 个还是 N 个数组 → 代价是丢失了"这段是哪个 workspace 的"边界信息（边界要在调用方用 `pkg.path` 另行恢复）」。
  - 「**Promise 只 resolve、不 reject**，唯一的失败路径是在 `data` 事件里同步 throw → 换来了"happy path 优先"的极简控制流 → 代价是错误以 EventEmitter 异常形式逃逸，调用方必须用 `await import(...).then(...).catch(...)` 在外层兜住，且非数组形态的诊断信息得另靠 `JsonParseStreamError.data` 携带半成品对象传出」。

- **最小心智模型（5 步）**：
  1. spawn 子进程，把它的 stdout 拿到一根 `ReadableStream`（**永不 `.toString()`**）。
  2. 创建一个有状态的 `Assembler`（半成品容器）和一个作为 Transform 流的 `parser`。
  3. `stream.pipe(parser)`——字节边到边过 parser，parser 边到边吐 `{ name, value }` 形态的 token。
  4. 每来一个 token，调用 `assembler[name]?.(value)`：startObject 开新对象、keyValue 记当前键、numberValue/stringValue 填值、endObject 收尾…… assembler 内部自动维护嵌套栈。
  5. 当 assembler 报 `done`（一个顶层值装配完成）：抓 `assembler.current`、断言它是数组、`push(...)` 摊进 `values`；下一个 token 到来时 assembler 自动复位，继续装配下一个顶层值，直到 stdout 关闭。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一段 ~25 行的独立 Node/Bun 脚本，**演透"流式 + 拼接"两个核心思想**。
    - 构造一根假的 Readable，分块吐出 `[{"a":1},{"b":2}][{"c":3}]`（**故意切成跨数组的块**：`[{"a":1}`、`,{"b":2}][{"c":`、`3}]`），让读者看到"块边界与 JSON 边界无关"。
    - 用 `stream-json` 的 `parser.asStream({ jsonStreaming: true })` + `Assembler` 装配。
    - 在 `data` 里 `assembler[chunk.name]?.(chunk.value)` 后查 `assembler.done`，每完成一个顶层数组就 `console.log` 一次"完成第 N 个数组"，最后 `resolve` 摊平结果。
    - 期望输出：`完成第 1 个数组: [{a:1},{b:2}]` → `完成第 2 个数组: [{c:3}]` → 最终 `[{'a':1},{'b':2},{'c':3}]`。
  - 应故意省略：真实子进程 spawn、tinyexec 集成、`JsonParseStreamError` 错误类、`console.dir` 诊断、与 pnpm/npm agent 的类型对接——这些是工程化脚手架，不表达核心思想。
  - **演示载体建议**：本章主语言是 TS/Node，机制是纯字节流处理、无 UI 依赖——**强烈建议写成能 `bun run demo.ts` / `npx tsx demo.ts` 直接跑的脚本**（不靠 child_process，靠伪造 Readable）。能跑的演示比文字执行轨迹有说服力 10 倍，因为读者能改切块大小、改顶层值数量，亲眼看到"流式"和"拼接"两个性质。

- **正文不宜展开的细节**：
  - `// @ts-expect-error casting`：是 TS 与 stream-json 类型定义不齐的工程妥协，与原理无关。
  - `stream-json` 在 `node-modules-tools` 里被列为 **devDependency** 而非 dependency——因为该包用 unbuild 打包，把 stream-json 直接 bundle 进 dist，运行时不二次解析。属于打包策略，不影响原理。
  - 完整的 token 名清单（`startObject`/`keyValue`/`numberValue` 等）：是 stream-json 的私有词汇表，记入事实库即可，正文不必列。
  - pnpm 调用方对 `Invalid string length` 的恢复提示（建议降 depth 到 2/3）：属于 pnpm agent 的错误恢复策略，应在 `package-manager-strategy` 章处理。

- **推荐的一个执行轨迹例子**：
  - 输入：`pnpm ls --json --recursive` 的 stdout，分两块到达：`[{"name":"a","version":"1.0.0"}]` 和 `[{"name":"b","version":"2.0.0"}]`。
  - 关键中间态（按 token 序）：`startArray → startObject → keyValue("name") → stringValue("a") → keyValue("version") → stringValue("1.0.0") → endObject → endArray` → 此时 `assembler.done === true`、`assembler.current === [{name:"a",version:"1.0.0"}]` → 摊平进 `values`。
  - 第二轮重复，`values` 变成 `[{a...},{b...}]`。
  - stdout 关闭 → parser `end` → Promise resolve with `values`。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **核心架构：tokenizer + assembler 双件套**。`stream-json` 的 `parser.asStream()` 是一个 Transform 流，吃字节、吐 `{ name, value }` token；`Assembler` 是一个有状态的 reducer，把 token 序列还原成 JS 值。两者之间靠"token 名 = assembler 方法名"的约定连接。
  源码位置: `packages/node-modules-tools/src/json-parse-stream.ts:1-2`

- **动态分派是全文件的灵魂**。`assembler[chunk.name]?.(chunk.value)` 这一行就是整个 dispatcher——token 名是 `startObject` 就调 `assembler.startObject()`，是 `keyValue` 就调 `assembler.keyValue("...")`。可选链 `?.()` 让任何无对应方法的 token 被静默忽略，所以新增 token 类型不用改 dispatcher。
  源码位置: `packages/node-modules-tools/src/json-parse-stream.ts:20-23, 43-45`

- **两种使用模式共用同一对零件**：
  - `parseJsonStream<T>`（**单值模式**）：不开 `jsonStreaming`，整根流就是一个顶层 JSON 值，结束时 `resolve(assembler.current as T)`。
  - `parseJsonStreamWithConcatArrays<T>`（**多值拼接模式**）：开 `jsonStreaming: true`，每完成一个顶层值就摊平进 `values`，结束时 `resolve(values)`。
  源码位置: `packages/node-modules-tools/src/json-parse-stream.ts:13-29, 31-61`

- **`jsonStreaming: true` 的语义**：开启后 parser 不要求流仅含一个顶层值；多个顶层值背靠背排列（`[...][...]`）也能持续吐 token。每个顶层值装配完成时，assembler 把 `done` 置为 true；下一个 token 到来时 assembler 复位 `current`、开始装配下一个值。这是检测"完成边界"的唯一信号。
  源码位置: `packages/node-modules-tools/src/json-parse-stream.ts:36-38`

- **"摊平"而非"压栈"**：每检测到 `assembler.done`，wrapper 断言 `assembler.current` 是数组，然后 `values.push(...assembler.current)`——把第 N 个数组的元素**展开**追加进同一个扁平 `values`。结果对调用方等价于"一根超大的合并数组"，无论源头发了几个数组。
  源码位置: `packages/node-modules-tools/src/json-parse-stream.ts:46-54`

- **自定义错误类携带半成品**：`JsonParseStreamError` 的 `data` 字段存 `assembler.current`，让调用方能检视"装配到一半长成什么样"——这是后续 pnpm agent 写"如果你看到 Invalid string length 就降 depth"恢复提示的依据。
  源码位置: `packages/node-modules-tools/src/json-parse-stream.ts:4-11, 51`

- **唯一无调用方的导出**：`parseJsonStream`（单值版）在整个仓库里没有任何调用方——只有 `parseJsonStreamWithConcatArrays` 被 pnpm/npm 两个 agent 使用。`parseJsonStream` 要么是为对称/未来用途保留，要么是历史遗留。
  源码位置: 调用方仅见 `packages/node-modules-tools/src/agents/pnpm/list.ts:90-91`、`packages/node-modules-tools/src/agents/npm/list.ts:64-65`

- **npm 也用拼接版（即便它每次只发一个数组）**：npm 的 `query` 命令每次只产出一个 JSON 数组，理论上 `parseJsonStream` 就够。但代码复用了 `parseJsonStreamWithConcatArrays`——拼接逻辑在"只有一个顶层值"时退化成 no-op，所以行为等价。这是 DRY 优先于"按需选最简版"的选择。
  源码位置: `packages/node-modules-tools/src/agents/npm/list.ts:50-79`

- **stream-json 是 devDependency**：`package.json` 把 `stream-json` 与 `@types/stream-json` 都放在 `devDependencies`——因为该包用 unbuild bundle，把 stream-json 直接打进了 `dist/*.mjs`，运行时不再二次 resolve。这是工程化细节，不影响原理。
  源码位置: `packages/node-modules-tools/package.json:50-51`；catalog pin 见 `pnpm-workspace.yaml:64`

## 关键调用链