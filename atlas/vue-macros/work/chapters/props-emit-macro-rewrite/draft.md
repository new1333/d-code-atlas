# props/emit 宏的编译期重写与类型转换

> 本章属于 composite 层。前置：SFC 解析与增量 AST 编辑。
> 学完你能讲清：为什么这四个宏只动文本、不动运行时；它们的"重写器"骨架长什么样；为什么"逐个声明"最后还是落回一个集中原生宏。

## 1. 为什么需要它（设计动机）

Vue 原生的 `defineProps` / `defineEmits` 有两个让人别扭的约束：所有 props 挤在一个调用里、所有 emits 也挤在一个调用里；早期版本还要求 props 名字跟变量名严格对应，emit 要手写一长串类型签名。组件写大一点之后，props/emits 那段就成了"集中申报表"——加一个 prop 要往表里塞一行，又得在 setup 顶上声明对应的变量。

用户想要的写法多种多样：有人想**逐个**声明一个 prop、像声明普通变量那样 `const count = defineProp('count', { default: 0 })`；有人想用更短的 emit 类型签名 `defineEmits<SE<{ click: [id: number] }>>()`；有人保留着旧版 `$defineProps` 的肌肉记忆。这些"顺手写法" Vue 运行时一个都不认识。

上一章留了一个口子：当宏需要**新运行时能力**时（比如 `useVModel`、`emitHelper`），我们用虚拟 helper 模块在编译期注入 import、运行时由 `load` 提供实现。但本章面对的不是"缺运行时能力"，而是**反过来**的问题——用户要的写法 Vue 运行时**其实已经认得**，差的就是改写这一步。这种"不缺运行时、只差改写"的宏该怎么做？答案就是这四个宏共同的核心思想。

## 2. 核心思想

**这四个宏本质都是"源码改写器"——在编译期把顺手写法重写成原生宏认得的形态，运行时零新增能力。**

`$defineProps` 改名成 `defineProps`；`SE<{...}>` 展开成标准事件签名；`defineProp('x')` 改写成 `toRef(__props, "x")`；`defineEmit('click')` 改写成转发函数。等到 Vue 编译器接管，自定义宏已经从源码里彻底消失，只剩 Vue 原生认得的标准代码。换句话说，这些宏的"魔法"全部发生在编译期，运行时根本看不到它们存在过。

## 3. 心智模型

每个重写器宏都走同一条流水线——这条流水线就是第 1 章建立的"懒解析 + 增量编辑"骨架的直接兑现（本章不重讲那套地基，只看四个宏怎么复用它）：

```
parseSFC 拿 scriptSetup + setupOffset
        ↓
getSetupAst() 按需 babel 解析 setup 片段
        ↓
walkAST + isCallOf(node, 宏名)  找出所有目标调用点
        ↓
对每个调用点：
  - 抽信息（名字、选项、类型参数）；
  - 名字可能要从父级 VariableDeclarator 的变量名反推
    （如 const count = defProp()，name 来自 count）；
  - 必要时看父节点是不是 $(...)（响应式变换包裹）。
        ↓
就地改写调用点本身——三种手法之一：
  ① 重命名 callee：$defineProps  →  defineProps
  ② 展开类型签名：SE<{ click: [id] }>  →  (evt: "click", ...args: [id]): void
  ③ 整体替换成代理：defProp('x')  →  toRef(__props, "x")
        ↓
若是"逐个声明"类宏（defineProp / defineEmit）：
  把收集到的信息合成一段运行时声明字符串，
  prependLeft 在 setup 顶部补一个集中的原生宏调用。
        ↓
generateTransform 输出改写后的代码 + sourcemap
```

四个宏的差异可以浓缩成一张表：

| 宏 | 调用点改写手法 | 是否需集中声明 | 典型复杂度 |
|---|---|---|---|
| `define-props` | 重命名 callee | 否 | 5 行 |
| `short-emits` | 类型签名就地展开 | 否 | 中 |
| `define-emit` | 整体替换成转发函数 | 是（集中 `defineEmits`） | 中 |
| `define-prop` | 整体替换成 `toRef` 代理 | 是（集中 `defineProps`） | 高（合并/互斥边界） |

前两个是"原地改写"，调用点改完就完事；后两个是"逐个声明 + 代理到集中原生宏"，调用点改写之外，还要在顶部 mount 一份合成声明。

## 4. 关键权衡

### 4.1 语法糖留编译期、运行时只认原生宏

**选择**：所有"顺手写法"（`$defineProps` / `SE<...>` / `defineProp` / `defineEmit`）一律在编译期改写成原生 `defineProps` / `defineEmits`，运行时不引入任何新概念、新 helper、新行为。

**换来**：用户拿到的语义与原生 `defineProps` / `defineEmits` **完全一致**——运行时行为、类型推导、props 校验、emits 选项、模板编译产物，全都跟没用宏时一模一样。读者一旦理解 `defineProp('x') ≡ 读 __props.x 的代理`，就不需要再学任何新运行时概念。

**代价**：这四个宏**只是重写器**，不引入任何新运行时能力——`defineProp` 的"逐个声明"只是一种写法糖，并不能在 props/emits 之外创造出 Vue 不支持的行为。这也是为什么 Vue 3.3+ 原生支持短事件签名之后，`short-emits` 的存在意义主要剩向下兼容。

**化解的本质矛盾**：用户对**书写人体工学**的多元化诉求（逐个写、短签名、`$` 前缀习惯）与 Vue 运行时对**单一标准 API** 的诉求之间的对立。这套解法的通解骨架是——**当用户的"想要"与系统的"认得"之间存在纯文本距离时，编译期重写比运行时扩展便宜得多**：只要改写前后语义等价，编译器接管后用户写法就被擦除，没有任何长期维护负担。

### 4.2 把源码片段当字符串抠出来拼，而非构造新的 babel AST 节点

**选择**：合成运行时声明对象时，不构造新的 `ObjectExpression` / `Property` 等 babel AST 节点再 print，而是用 `s.sliceNode` 把每个选项参数的**源码文本片段直接抠出来**，再用字符串模板拼成 `{ name: ${optsText} }` 或 `[name1, name2]`。

**换来**：实现极简——每个宏的核心逻辑压在几十行内，产物可直接读（输出代码就是普通字符串拼接结果，不经过 AST 序列化），调试时一眼就能看到改写前后对比。也避免了一旦"重新生成代码"就会丢 sourcemap 的麻烦。

**代价**：产物正确性**全靠约定**，没有类型系统兜底——如果用户在选项里写了语法奇怪的东西，拼出来的对象字面量可能并不合法，但宏在编译期发现不了。另一面代价是**两种产物形态要分两条路径生成**：所有 emit 都无 validator → 数组 `[name1, name2]`；任一带 validator → 对象 `{ name: validator }`。props 同理（全无选项走简写数组、否则拼对象）。这两条路径本质是同一份取舍在 props 侧和 emit 侧的复现，但代码里要分别写一次。

**化解的本质矛盾**：**实现简明**（手写最少代码、产物最直观）与**结构正确性**（构造 AST 节点能借 babel 校验、但代码量翻几倍）之间的对立。通解骨架是——**当输出形态是"已知模式化的字符串拼接"时，AST 构造的额外保证往往不值其复杂度**；这跟 SQL 拼接、HTML 模板的取舍是同一类问题，模式越受限、字符串拼接越划算。

### 4.3 逐个声明 + 代理到集中原生宏

**选择**：`defineProp` / `defineEmit` 把每个调用点改写成读代理（`toRef(__props, "x")` / `(...args) => __MACROS_emit("x", ...args)`），但所有调用点收集到的信息**汇总到一份**集中声明（`const __MACROS_props = defineProps({...})` / `const __MACROS_emit = defineEmits(...)`），落在 setup 顶部。

**换来**：用户获得**逐个声明**的人体工学（每个 prop 像声明普通变量、每个 emit 拿到独立转发函数），最终又落回 Vue 认得的**单个**原生宏上——既不丢失书写体验，又不引入第二个 `defineProps`。运行时 `__props` 还是 Vue 创建的那个 `__props`，每个 `toRef(__props, "x")` 只是它的一个代理视图。

**代价**：要处理两类边界。其一是**合并**——组件里如果本来就有 `defineProps(...)` 运行时参数，新收集的 props 要合并进它的参数位（`{ ...norm(old), ...norm(new) }`），而非另起一个 `defineProps`，否则 Vue 会报"重复定义"；helper `normalizePropsOrEmits` 在这里把"数组形式"与"对象形式"两套写法先统一成一个形态再合并。其二是**互斥报错**——组件里如果用的是 `defineProps<T>()` 泛型形式（只有类型参数、无运行时参数），`defineProp` 不能与之共存，因为前者已经在类型层定下了 props 形态，再注入运行时对象会与之冲突，宏必须主动抛错告知用户。

**化解的本质矛盾**：**书写的人体工学**（分散声明、各取所需）与 **Vue 的集中式 API 设计**（"一个组件一份 props 声明"是 Vue 的硬约束）之间的对立。通解骨架是——**当宿主框架强制集中式 API 而用户偏好分散式书写时，"分散收集 + 集中代理"是个可复用的中间层**；前端状态管理里的 atom+selector、ORM 里的 entity+unitOfWork 都是这个骨架的近亲。代价永远是：合并/冲突的边界条件必须由这个中间层自己负责。

## 5. 最小原理演示

下面用一段约 40 行 TS 演透"重写器类宏"的核心三件套——**收集 → 就地改写 → 顶部补集中声明**。以 `defineProp` 这一类（最完整、最具代表性）为蓝本，宏名故意写成 `defProp` 避免与真实宏混淆。

```ts
// 演透「重写器类宏」三件套：collect → rewrite call site → mount 集中声明

// 输入：一段模拟的 setup 源码
const setupCode = `const count = defProp('count', { default: 0 })
const open = defProp('open')`

// 工具 A：模拟 walkAST，找出所有 defProp(...) 调用点
//   （真实实现：@babel/parser 解析 + walkAST 遍历 + isCallOf 判 callee）
type CallSite = {
  start: number; end: number    // 调用点在 setup 中的字符区间
  name: string                  // prop 名字（这里直接取自字符串参数）
  opts: string | null           // 选项参数的源码文本片段（无则 null）
}
declare function findDefPropCalls(code: string, callee: string): CallSite[]

// 工具 B：模拟 magic-string，按字符区间就地改字符串
//   （真实实现：MagicStringAST.overwriteNode / prependLeft）
declare class S {
  constructor(src: string)
  overwrite(start: number, end: number, text: string): void
  prepend(text: string): void
  toString(): string
}

const s = new S(setupCode)
const collected: { name: string; opts: string | null }[] = []

// 步骤一：收集。每个调用点抽出 name 与 opts 文本片段
for (const call of findDefPropCalls(setupCode, 'defProp')) {
  collected.push({ name: call.name, opts: call.opts })
  // 步骤二：就地改写。调用点 → 读 __props 的代理 ref
  s.overwrite(call.start, call.end, `toRef(__props, ${JSON.stringify(call.name)})`)
}

// 步骤三：合成集中声明。所有 opts 拼成一段运行时 props 对象，prepend 在顶部
const runtimeProps = '{ '
  + collected.map(p => `${p.name}: ${p.opts ?? '{}'}`).join(', ')
  + ' }'
s.prepend(`const __props = defineProps(${runtimeProps})\n`)

console.log(s.toString())
```

跑出来的产物：

```ts
const __props = defineProps({ count: { default: 0 }, open: {} })
const count = toRef(__props, "count")
const open = toRef(__props, "open")
```

每一段都对应一个原理点：

- `findDefPropCalls(setupCode, 'defProp')` 演的是流水线里「walkAST + isCallOf 找调用点」；
- `s.overwrite(call.start, call.end, ...)` 演的是「调用点整体替换成代理」；
- 拼字符串 `runtimeProps` 而不构造 AST，演的是「字符串抠拼而非 AST 构造」；
- `s.prepend(...)` 演的是「逐个声明代理到集中原生宏」；
- 输出里 `defProp` 已彻底消失，演的是「运行时只认原生宏」。

## 6. 执行轨迹

拿上面那段输入走一遍，看每个调用点经历了什么：

1. **输入**：`const count = defProp('count', { default: 0 })` 后跟 `const open = defProp('open')`。
2. **walkAST 找调用点**：识别到两个 `defProp` CallExpression，分别记下字符区间、name、opts 文本。`collected = [{ name: 'count', opts: '{ default: 0 }' }, { name: 'open', opts: null }]`。
3. **第 1 个调用点就地改写**：原始字符区间被覆盖为 `toRef(__props, "count")`，setup 第一行变成 `const count = toRef(__props, "count")`。
4. **第 2 个调用点就地改写**：第二行的 `defProp('open')` 同理被覆盖为 `toRef(__props, "open")`。
5. **顶部 prepend 集中声明**：把 `collected` 拼成 `{ count: { default: 0 }, open: {} }`，prepend `const __props = defineProps(...)`。
6. **输出**：所有 `defProp` 已消失，最终代码只含 `defineProps` 与 `toRef`——交给 Vue 编译器时，已经是一段"没有任何自定义宏"的标准 SFC setup。

整个过程的核心特征：**没有任何运行时帮手被注入、没有任何 import 被加进来**，自定义宏只是文本上的"换件衣服"。对比上一章 `defineModels` 那一类要靠 `useVModel` 帮手才能跑的宏，区别就在这里。

## 7. 教学简化说明

上面演示故意省略了这些东西，它们不影响理解"重写器"的核心思想：

- **真实 SFC 解析**：直接喂一段 setup 字符串，省去 `parseSFC` 拆 script/scriptSetup/template、所有 AST 节点位置都要加 `setupOffset` 的偏移加法；
- **babel 偏移修正**：用简化的字符坐标代替 babel AST 节点的 `start/end`；
- **变量名反推**：演示假设 name 一定来自字符串参数，省去从父级 `VariableDeclarator` 反推 name 的逻辑；
- **类型降级**：演示把 `opts` 当字符串直接拼，省去 `resolveTSReferencedType` + `inferRuntimeType` 把 TS 类型降级为运行时 `{ type, required }` 的链路（这是第 6 章『better-define』的主线，本章 `defineProp` 只是借用、不展开）；
- **响应式变换分支**：省去 `$(defProp(...))` / `$defProp(...)` 两种写法的判定与 `$()` 包裹（第 7 章『响应式语法糖』的交叉点）；
- **与已有 `defineProps` 合并**：省去 `normalizePropsOrEmits` 把数组/对象两套写法统一后再合并的 helper，以及与 `defineProps<T>()` 泛型形式互斥时报错的处理；
- **kevin/johnson 两种 edition 的参数位差异**：真实 `define-prop` 用同一份 `Impl` 接口约束两套参数语义（`defineProp(name, definition)` vs `defineProp(value, required, rest)`），本章作为教学只演示其中一种。

## 8. 小结

四个宏做的是同一件事：在源码交给 Vue 编译器之前，把"顺手写法"重写成"Vue 认得的标准形态"，运行时不引入任何新东西。它们共享同一条"walkAST 找调用点 → 抽信息 → 就地改写 → 必要时顶部补集中声明"的流水线，差异只在改写手法与是否需要 mount 集中声明。

下一章的 `defineModels` 要复用的正是这条流水线——只不过这次收集到的字段会同时合成 `defineProps` 与 `defineEmits` 两份声明，再额外用一个运行时帮手把两边粘成可写 ref。重写器骨架不变，多出来的那一层是"双向绑定"的运行时桥。