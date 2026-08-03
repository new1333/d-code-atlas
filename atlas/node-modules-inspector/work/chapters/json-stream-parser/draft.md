# 流式 JSON 解析：应付百万行依赖输出

## 一个看似简单的任务

想象你在写一个工具，要拿到当前项目的依赖列表。最直觉的做法：`execFileSync('pnpm', ['ls', '--json'])`，然后 `JSON.parse(stdout)`。十几个依赖的小项目里这就是全部代码。

现在把场景放大。一个大型 monorepo，几千个直接依赖、上万个传递依赖，再叠加 `pnpm ls --json --recursive` 会把每个 workspace 的清单都吐出来。stdout 一根字节流可以冲到几百兆。这时候 `JSON.parse` 会从**两个完全不同的方向**同时崩掉：

**第一崩：V8 字符串长度上限。** Node 里一根字符串最多约 512MB（`v8::String::kMaxLength`）。`JSON.parse` 之前要先 `Buffer.toString()` 把字节翻译成 UTF-16 字符串——还没开始 parse，光是这步就先抛 `RangeError: Invalid string length`。你连一行 JSON 的样子都没看到，进程就死了。

**第二崩：根本不是合法 JSON。** `pnpm --recursive` 的输出长这样：

```
[{"name":"a",...},{"name":"b",...}][{"name":"c",...}][{"name":"d",...}]
```

方括号挨着方括号，几个独立的 JSON 数组**首尾相连**塞在同一根 stdout 里。这违反了"一根流里只能有一个顶层值"的 JSON 默认约定。`JSON.parse` 只读第一个数组就停，剩下的字节当垃圾忽略——你静悄悄地丢失了 90% 的数据，连个错都不报。

两个失败模式都不能靠"把 JSON.parse 换成更聪明的 JSON.parse"解决。问题不在 parse 的算法，而在"先把整根字符串物化出来再 parse"这个**整体策略**。

## 换个策略：边读边装

放弃"先拿全字符串"的执念。把"读 JSON"拆成两段独立的活儿：

1. **扫描字节，产生 token 流**——一个状态机逐字节读，看到一个 `{` 就吐 `{ name: 'startObject' }`，看到一个键名就吐 `{ name: 'keyValue', value: 'name' }`，看到一个字符串字面量就吐 `{ name: 'stringValue', value: 'a' }`……它不关心这些 token 组合成什么，只管"按字节顺序吐出来"。

2. **按 token 名装配对象**——另一个状态机吃 token 流，看到 `startObject` 就在栈里压一个新对象，看到 `keyValue` 就记住"接下来要填的键是这个名字"，看到 `stringValue` 就把值填到刚才记住的键上，看到 `endObject` 就把当前对象弹出栈、挂到父对象的某个键上……

类比一下：tokenizer 像一个不识字的小孩逐字逐句把书念出来；assembler 像一个会做笔记的助手，听着念稿，边听边在脑子里搭出整本书的结构。两个人都不需要看到下一页才能开始干活。

**关键在于：** 两个人内存里同时只持有一行字、一份半成品笔记。无论输入是一行还是一百万行，他们各自的"工作集"都不变大。这就是流式装配能吃下任意大 stdout 的根本原因——内存用量跟输入大小无关。

## 那一行 dispatcher

两段活儿之间，靠一行代码连起来：

```ts
assembler[chunk.name]?.(chunk.value)
```

这是整个分派逻辑的全部。`chunk.name` 是字符串（`'startObject'`、`'keyValue'`、`'numberValue'` 等等），用方括号动态取到 assembler 上同名的方法再调用。可选链 `?.()` 的意思是：如果当前 token 没有对应方法（比如某些边角 token 你不关心），就**当无事发生**。

为什么这个写法好？想象一下反面：写成 `switch (chunk.name) { case 'startObject': assembler.startObject(); break; case 'keyValue': assembler.keyValue(chunk.value); break; ... }`。每加一种 token 类型，都得回来改这个 switch。换成动态分派，**token 名字就是方法名字**，新增 token 自动对应到 assembler 上同名的新方法，dispatcher 一行都不用动。两段活儿彻底解耦。

## 单值模式 vs 拼接模式

读到这里你可能会问：tokenizer 怎么知道流里有几个顶层值？默认情况下，它假设只有一个。读完一个完整值之后，再有任何字节都是错误。这就是 `parseJsonStream` 的模式——它结束的时候直接把 `assembler.current` 当结果 resolve 出去：

```ts
const assembler = new Assembler()
const parser = createParser.asStream()

parser.on('data', (chunk) => {
  assembler[chunk.name]?.(chunk.value)
})

parser.on('end', () => {
  resolve(assembler.current as T)
})
```

但 `pnpm --recursive` 的拼接输出没法用这个模式。需要打开 stream-json 的一个非标准开关 `jsonStreaming: true`，告诉它"我允许多个顶层值背靠背"。开了之后，每装配完一个值，assembler 会把内部的 `done` 标志置为 true；下一个 token 到来时，它自动复位，开始装配下一个值。**这就是检测"一个顶层值装配完了"的唯一信号。**

```ts
const assembler = new Assembler()
const parser = createParser.asStream({ jsonStreaming: true })
const values: T[] = []

parser.on('data', (chunk) => {
  assembler[chunk.name]?.(chunk.value)
  if (assembler.done) {
    values.push(...assembler.current as T[])
    // 下一个 token 到来时 assembler 自动复位
  }
})

parser.on('end', () => {
  resolve(values)
})
```

## "摊平"而非"压栈"

注意上面那行 `values.push(...assembler.current)`。这里把每个完成的数组的元素**展开**追加进同一个扁平 `values`，而不是 `values.push(assembler.current)` 把整个数组作为一个元素压进去。

为什么这么选？因为对调用方来说，无论源头是 `pnpm --recursive` 拼了 5 个数组，还是单 workspace 只发了 1 个数组，它都想拿到"一份合并好的扁平依赖列表"。摊平之后，调用方拿到的永远是 `PackageNodeRaw[]`，不用关心边界。

**说人话就是：** 我们主动把"这段 JSON 是哪个 workspace 的"这个边界信息**丢掉**了。如果调用方需要知道边界，得另外靠每个包的 `pkg.path` 字段去恢复——这是上层 package-manager 策略要处理的活，不归这一层管。

## 跑给你看

下面这段脚本可以从零演示两个性质——**流式**（块边界与 JSON 边界无关）和**拼接**（同一根流里有多个顶层值）。不靠子进程，靠一个伪造的 Readable 把字节切片喂进去：

```ts
import { Readable } from 'node:stream'
import { parser as createParser } from 'stream-json'
import Assembler from 'stream-json/assembler.js'

// 故意把字节切成跟 JSON 边界完全错开的块
const chunks = [
  Buffer.from('[{"a":1}'),          // 第一个数组还差尾巴
  Buffer.from(',{"b":2}][{"c":'),   // 跨数组边界！前半属于第一个数组，后半已在第二个
  Buffer.from('3}]'),               // 第二个数组收尾
]

// 伪造一根会异步分块到达的 Readable
const fakeStream = new Readable({ read() {} })
let i = 0
const timer = setInterval(() => {
  if (i < chunks.length) {
    fakeStream.push(chunks[i++])
  } else {
    fakeStream.push(null)
    clearInterval(timer)
  }
}, 10)

const assembler = new Assembler()
const parser = createParser.asStream({ jsonStreaming: true })
const values: any[] = []
let count = 0

parser.on('data', (chunk: any) => {
  assembler[chunk.name]?.(chunk.value)

  if (assembler.done) {
    count++
    console.log(`完成第 ${count} 个数组:`, assembler.current)
    values.push(...assembler.current)
  }
})

fakeStream.pipe(parser)

parser.on('end', () => {
  console.log('最终摊平结果:', values)
})
```

期望输出：

```
完成第 1 个数组: [ { a: 1 }, { b: 2 } ]
完成第 2 个数组: [ { c: 3 } ]
最终摊平结果: [ { a: 1 }, { b: 2 }, { c: 3 } ]
```

试着把 `chunks` 切得更碎（比如一字节一块），输出不变。这就证明了：tokenizer 的状态机跨块稳定，assembler 的栈也跨块稳定——**两者都不在乎块边界画在哪里**。这正是流式相对一次性 parse 的本质优势。

## 关键权衡

讲完原理，得把做过的选择摊开看看，每一个都换了什么、又付了什么代价。

### 权衡一：动态分派换解耦，付掉类型安全

选了 `assembler[chunk.name]?.(chunk.value)` 这种**字符串名字 → 方法调用**的分派方式，换来了 tokenizer 和 assembler 之间零连线——加 token 类型不需要改 dispatcher，两边可以独立演进。

代价是失去了静态类型检查。`chunk.name` 的类型是 `string`，但 assembler 上只有一组固定方法（`startObject` / `keyValue` / ……）。TS 编译器没办法验证"这个字符串对应一个真实存在的方法"，所以源码里必须显式写 `// @ts-expect-error` 把这一行标记成"我知道这不符合类型，别管"。后果就是：如果哪天 stream-json 改了 token 命名（比如把 `keyValue` 重命名为 `keyString`），代码不会在编译期报错，只在运行时**静默地什么都装配不出来**。

这是个典型的"运行时灵活性 vs 编译期安全"取舍。在一个域很窄（就那么十几种 token）的场景里，灵活性收益小，但解耦收益大；选灵活性是合理的。

### 权衡二：开 jsonStreaming 换多 workspace 一口吃下，付掉标准依从

选了开 `jsonStreaming: true` 这个**非标准模式**，换来了 pnpm `--recursive` 把 N 个 workspace 的清单依次塞进同一根 stdout 时，调用方一根流就能全吃下，不用再切开重 pipe。

代价是依赖 stream-json 的私有约定。JSON 标准本身只允许一个顶层值；"多个值背靠背"是 stream-json 自家加的扩展。换一个流式 JSON 库（比如 `JSONStream`、`oboe.js`），这个开关的语义、甚至是否存在都不一样。换句话说，整个解析层绑死在 stream-json 上了。

这个代价值得付，是因为"被绑死"的下游很窄——就两个调用点（pnpm agent、npm agent），且这个库稳定维护了十年。把"标准依从"放在天平另一端，分量不够。

### 权衡三：摊平换统一类型，付掉边界信息

选了每完成一个顶层值就 `values.push(...current)` 摊进同一个扁平数组，换来了上层永远拿到 `PackageNodeRaw[]`，无论源头发了 1 个还是 N 个数组——类型签名稳定，调用方代码不用分支。

代价是把"这段是哪个 workspace 的"边界信息丢掉了。这个信息不是不重要，而是**这一层不该负责**：边界可以在调用方用每个包的 `pkg.path` 字段（包所在目录）恢复出来，比在这里维护一个 `Array<{ workspace: string, deps: PackageNodeRaw[] }>` 的复杂结构要干净。说白了，这一层只做"读字节、出扁平依赖列表"这一件事，把"分组"留给更懂业务的上层。

这是经典的"窄接口 + 把复杂性赶到上层"取舍。如果上层有自然的分组依据（`pkg.path`），就不要在底层重复维护一份。

### 权衡四：只 resolve、不 reject，付出错误处理的不对称

选了**控制流极简**：Promise 只 resolve，唯一的失败路径是在 `data` 事件里**同步 throw**。代码读起来就一条 happy path，没有 `reject` 分支打断节奏。

代价是错误以 EventEmitter 异常的形式逃逸。`stream.on('data', ...)` 里 throw 出来的错误，不会自动变成 Promise 的 rejection——它会沿着 EventEmitter 的调用栈往上抛，如果没人监听 `error` 事件，Node 进程会崩。所以调用方必须用 `await import('...').then(...).catch(...)` 在外层兜住，或者给 stream 注册 `error` handler。

另外，遇到非数组的顶层值（比如某次装配出来是个对象而不是预期的数组）时，需要把"装配到一半长成什么样"的诊断信息带出去——这部分靠一个自定义的 `JsonParseStreamError` 类，它额外带 `data` 字段存 `assembler.current`，让上层的 pnpm agent 能据此给出"建议降 depth 到 2/3"这种恢复提示。

这个取舍的根源是：**正常路径压倒性地多于异常路径**。在绝大多数调用里流都正常结束，给那少数错误单独搞一套异步 reject 流程，不如直接 throw 让外层兜——只要文档明确写了"必须 catch"。

## 这一层的位置

回顾一下：把"读 stdout 里的 JSON"这件看似一行 `JSON.parse` 的事，拆成 tokenizer + assembler 两段独立活儿，靠"token 名 = 方法名"的动态分派连起来。换来的是——能吃下任意大的 stdout（不物化整根字符串），能吃下任意多个背靠背的顶层值（`jsonStreaming`），还能给上层一份统一的扁平数组。

这一层是后续 package-manager 策略能抹平 pnpm/npm 差异的物理基础。再往上的所有抽象，都建立在"stdout 已经被流式吃成 `PackageNodeRaw[]`"这个前提之上——只要这层不塌，上层的 agent 怎么折腾都行。