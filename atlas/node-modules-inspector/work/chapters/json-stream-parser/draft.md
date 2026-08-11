# 流式 JSON 解析：应付百万行依赖输出

> 本章属于 primitive 层。这是全书第一章——后续所有章节都建立在「先拿到一份可用的依赖清单」之上。
> 学完你能：用一句话讲清「为什么读 npm/pnpm 的 stdout 不能 `JSON.parse` 一把梭，得拆成 token 流 + 装配器两段；这个拆法换来了什么、代价是什么」。

## 1. 为什么需要它

全书要从这一章开始，是因为这本 Atlas 后面所有花活（依赖图物化、可视化、版本对比、维护者行动算法）都依赖同一件事：先把 npm 或 pnpm 命令吐出来的 stdout 变成 JS 里能用的对象。这一章就专讲这件最底层的事。

想象你在一个有几千个直接依赖、上万个传递依赖的大型 monorepo 里跑 `pnpm ls --json --recursive`，stdout 像消防水管一样喷出几百兆 JSON。你下意识想 `JSON.parse(stdout)` 一把梭。这把梭有两个口子都会崩。

第一个口子是**超大**。stdout 拿到的是字节流，`JSON.parse` 的第一步要 `Buffer.toString()` 把整段字节塞进一根 V8 字符串。V8 字符串有上限（约 512MB），超过就抛 `Invalid string length` 直接崩。大型 monorepo 的 pnpm 输出能轻松超过这个上限。

第二个口子是**可拼接**。pnpm 在 `--recursive` 模式下会把每个 workspace 的清单作为独立的 JSON 数组依次写进同一根 stdout：

```
[{...workspace A 的清单...}][{...workspace B 的清单...}][{...workspace C...}]
```

这种「多个 JSON 背靠背拼在一起」的形态，对 `JSON.parse` 是非法的——它只读第一个数组就停，剩下的字节当作垃圾丢掉。

stdout 同时具备「超大」和「可拼接」两个属性，一次性反序列化在这两个属性上都会失败。这套机制就是为了同时解决这两个失败而生的。

## 2. 核心思想

JSON 文本是分层的（对象套数组、数组套对象），但字节流是线性的。一次性反序列化的思路是「先把线性字节全部读进一根字符串，再递归下降解析层级」；流式装配换了一条路：**把线性字节边读边还原成层级，永不收齐整根字符串**。

具体做法是拆成两段：**扫描字节产生 token 流** + **按 token 名分派给一个有状态装配器**。tokenizer 像 CT 扫描，一圈圈切过去逐层吐片；assembler 像读图纸的工人，每收一片就拼到对应位置。两个零件只靠一根 token 名约定对接。

## 3. 心智模型

整套机制靠两个零件加一条约定。

**tokenizer**：`stream-json` 提供的 `parser.asStream()` 是一个 Transform 流。吃字节、吐 `{ name, value }` 形态的 token。`name` 是 token 类型（`startObject` / `keyValue` / `numberValue` / `endObject` 等），`value` 是字面量。

**assembler**：一个有状态的 reducer。把 token 序列还原成 JS 值。内部维护嵌套栈——遇到 `startObject` 开新对象、`keyValue` 记当前键、`stringValue` 填值、`endObject` 收尾。`assembler.current` 永远指向当前半成品，`assembler.done` 在某个顶层值完成时翻成 `true`。

**连接约定**：token 名等于 assembler 方法名。dispatcher 全文就一行：

```ts
assembler[chunk.name]?.(chunk.value)
```

token 名是 `startObject` 就调 `assembler.startObject()`，是 `keyValue` 就调 `assembler.keyValue("name")`。可选链 `?.()` 让任何没有对应方法的 token 被静默忽略。

完整数据流是一根单向管线：

```
字节 chunk 到达 parser
  → parser 吐 token { name, value }
  → dispatcher 查 assembler 同名方法、调用
  → assembler 更新 current
  → 若 done 翻 true，wrapper 把 current 抓走、push 进 values
```

## 4. 关键权衡

### 用 token 名做动态分派，tokenizer 与 assembler 各自独立

dispatcher 全文是 `assembler[chunk.name]?.(chunk.value)`，把 token 名当方法名查。换来的是 tokenizer 和 assembler 完全解耦——加新 token 类型不用改 dispatcher；assembler 没有对应方法的 token 被可选链静默忽略。代价落在类型安全上：`chunk` 是 any，token 名拼错只能运行时发现，源码里必须 `@ts-expect-error` 把 chunk 当 any 处理。

这里化解的本质矛盾是**扩展性 vs 类型安全**。开放派发（按字符串名查方法）换扩展零成本，闭合派发（switch case 枚举所有 token 名）换编译期校验。这条选了前者，反正 stream-json 的 token 词汇表本来就是该库的私有约定，当作可变的事情对待更合理。

### 开启 jsonStreaming 非标准模式，吃下多 workspace 拼接

`parser.asStream({ jsonStreaming: true })` 让 parser 接受多个顶层值背靠背排列。换来的是 pnpm `--recursive` 的多 workspace 输出能被一根 stdin 一口吃下，不用每个 workspace 单独起一次进程。代价是绑死在 `stream-json` 的私有约定上——RFC 8259 规定一个 JSON 文档只有一个顶层值，`jsonStreaming` 是该库的扩展，换库就得重写。

背后是**标准合规 vs 现实数据形态**的取舍。标准说一个 JSON 文档一个值，但 pnpm 的工程实践把多个值塞进同一根 stdout。要么站在标准一边（强行每个 workspace 起一次进程再合并），要么站在现实一边（接受非标准模式）。这条选了现实，因为 spawn 进程的代价远高于依赖一个稳定库的扩展约定。

### 每个顶层值完成后立刻摊平进同一根 values 数组

每次 `assembler.done` 翻 true，wrapper 断言 `current` 是数组，然后 `values.push(...current)`——把第 N 个数组的元素**展开**追加进同一根扁平数组。换来的是上层永远拿到统一的 `PackageNodeRaw[]`，无论源头发了 1 个还是 N 个数组，下游代码不用关心「这次是单 workspace 还是多 workspace」。代价是丢失了「这段是哪个 workspace 的」边界信息，下游要用 `pkg.path` 字段另行恢复归属。

本质矛盾是**调用方接口的简单 vs 信息保留**。展平让接口最简单（一种类型走天下），代价是装配阶段就丢弃了「哪段属于哪个 workspace」这个元信息，事后要用别的字段重建。这条选了简单，因为下游（依赖图物化、筛选器、可视化）需要的就是统一一维数组，边界信息对它们没用。

### Promise 只 resolve、不 reject，错误靠 EventEmitter 逃逸

Promise 只有一条 happy path：parser 的 `end` 事件触发时 `resolve(values)`。错误路径是在 `data` 事件里同步 throw 一个携带半成品对象的 `JsonParseStreamError`。换来的是控制流极简——读代码不用关心 try/catch，主线就是字节到 token、token 到对象、对象到 values。代价是错误以 EventEmitter 异常形式逃逸，调用方不能用 `try { await ... } catch`，必须在 stream 上挂 error handler，或者用 `.then().catch()` 在外层兜住；半成品对象（`assembler.current`）也要靠自定义 error 的 `data` 字段单独携带传出。

背后是**异步错误模型的两种风格**：Promise reject（结构化、链式可追溯）vs EventEmitter error（侧带通道、需单独监听）。这条把 happy path 留给 Promise、把错误推到 side channel，让正常路径读起来像同步代码，代价是调用方必须两套都接住。

## 5. 最小原理演示

下面这段脚本能直接 `npx tsx demo.ts` 跑起来。它不靠真实子进程，只伪造一根「分三段、每段边界都和 JSON 边界错开」的 stdout，演透「流式 + 拼接」两件事：

```ts
import { Readable } from 'node:stream'
import { parser as createParser } from 'stream-json'
import Assembler from 'stream-json/assembler.js'

// 伪造的 stdout：两个独立 JSON 数组背靠背，故意切成三段
// 块边界和 JSON 边界完全错开，证明流式不靠「一整块 = 一个值」
const chunks = [
  '[{"a":1}',
  ',{"b":2}][{"c":',
  '3}]',
]
const fakeStdout = Readable.from(chunks.map(s => Buffer.from(s, 'utf8')))

const assembler = new Assembler()
// jsonStreaming：同一根流里允许有多个顶层值，吃下「背靠背拼数组」
const parser = createParser.asStream({ jsonStreaming: true })

const values: any[] = []
let arrayCount = 0

parser.on('data', (chunk: any) => {
  // token 名 = assembler 方法名，dispatcher 全文就这一行
  assembler[chunk.name]?.(chunk.value)
  // 一个顶层值装配完成：抓 current、摊平进 values
  if (assembler.done) {
    arrayCount++
    console.log(`完成第 ${arrayCount} 个顶层数组:`, assembler.current)
    values.push(...(assembler.current as any[]))
  }
})

fakeStdout.pipe(parser)
parser.on('end', () => {
  console.log('最终合并:', values)
})
```

跑出来的输出：

```
完成第 1 个顶层数组: [ { a: 1 }, { b: 2 } ]
完成第 2 个顶层数组: [ { c: 3 } ]
最终合并: [ { a: 1 }, { b: 2 }, { c: 3 } ]
```

三段字节被切在任意位置，第一个数组甚至在第二段中间就开始了，但每完成一个顶层值 assembler 就报告一次 `done`，最终摊平成一根数组。改切块大小、改顶层值数量，输出都正确——这就是「流式」和「拼接」两个性质。

## 6. 执行轨迹

拿一个真实的 `pnpm ls --json --recursive` 当例子。stdout 分两段到达，第一段是 `[{name:"a",version:"1.0.0"}]`，第二段是 `[{name:"b",version:"2.0.0"}]`。

第一段字节进入 parser，逐个吐出 token：

```
startArray             → assembler 开空数组 []
  startObject          → 数组里开空对象 {}
  keyValue("name")     → 记当前键 = "name"
  stringValue("a")     → 把 "a" 填进 name
  keyValue("version")  → 记当前键 = "version"
  stringValue("1.0.0") → 填值
  endObject            → 关闭对象，push 进数组
endArray               → 关闭数组
```

此时 `assembler.done === true`、`assembler.current === [{ name: "a", version: "1.0.0" }]`。wrapper 抓走 current、`values.push(...)`，`values` 变成 `[{name:"a",version:"1.0.0"}]`。

第二段字节进来，assembler 自动复位 current，重新走一遍同样的 8 步。`values` 变成 `[{a...}, {b...}]`。

stdout 关闭，parser 触发 `end`，Promise resolve 出 `values`。整个过程内存里始终只有「一个 token + 一份半成品」，整根 stdout 从头到尾没被收齐过。

## 7. 教学简化说明

本章演示故意省略了：真实子进程的 spawn、tinyexec 的集成、`JsonParseStreamError` 错误类（携带半成品用于诊断）、`console.dir` 调试输出，以及和 pnpm/npm agent 的类型对接。这些都是工程化脚手架，不表达「流式 + 拼接」的核心思想。

## 8. 小结

把「读 JSON」从一次性反序列化拆成 token 流 + 装配器，是这一章唯一的发明。内存里始终只持一个 token + 一份半成品，整根 stdout 不被物化，多 workspace 拼接也被同一套机制吃下——这就是后面所有章节拿到依赖清单的统一入口。

stdout 解出来了，下一章《包管理器策略：pnpm/npm/bun 三态归一》讲怎么让三种包管理器的不同清单来源都吐出同一份 `PackageNodeRaw[]`。