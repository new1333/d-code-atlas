# 配置系统：一份配置驱动两条管线

> 本章属于 system 层。前置：双轨制——编译变换与 IDE 类型支持为何必须并存。
> 学完你能：用一句话讲清「为什么 vue-macros 要把一份配置当成两条管线的契约、这份契约为什么天生会漂移、又靠什么补救」。

## 1. 为什么需要它（设计动机）

上一章讲 vue-tsc 把 IDE 的类型能力搬到了 CLI——让编辑器里看到的红线和 CI 里跑出的类型错误终于对得上。但那只是把**类型这条线**内部的一致性补齐了：IDE 和 CLI 说到底都跑在 TS 语言服务那一侧。

真正更宽的裂缝在另一头：真正改你代码的是**打包器**（Vite/Rollup/webpack）那条线，它跑在一个独立进程里；给你类型提示和报错的是 **IDE 的语言服务**，另一个独立进程。你在 `vite.config.ts` 里写 `VueMacros({ defineModels: true })` 启用一个宏，打包器认了，构建一切正常。可一回到编辑器，`defineModels` 那行全是红线——IDE 那条线根本没收到「你开了这个宏」的通知。反过来也一样：你在 tsconfig 里配了 volar 插件，编辑器乖巧地给提示，CI 一打包却报错。

痛点不是「某个宏不会配」，而是「我明明只配置了一次，为什么构建和编辑器像是活在两个世界」。双轨架构（双轨制那章已经讲透它为何必须并存）把「真改代码」和「假装改代码给类型看」拆成了两条管线，但两条管线迟早要回答同一个问题：**到底哪些宏开着、各自用什么参数？** 如果让它们各读各的临时配置，漂移几乎是注定的。配置系统就是为了堵这个口子：把一份声明式配置当成两条管线共享的契约，让你只表达一次意图，两侧（理想情况下）就自动对齐。

## 2. 核心思想

一句话：**一份声明式配置是两条管线的唯一真相源**——构建侧和 IDE 侧各自从同一份 schema 派生自己的注册表，「编译器做什么」和「IDE 懂什么」在构造层面就被绑在一起，而不是靠运行时互相通气。

## 3. 心智模型

配置的生命周期其实只有一条主线，但它会分叉成两个物理副本：

```
你写一份 Options（宏名 → 开关 / 子选项）
        │
        ├──▶ 打包器配置里  ──▶ unplugin 插件读取
        └──▶ tsconfig 里    ──▶ @vue-macros/volar 读取
                    │
        两侧各自跑 resolveOptions(你的输入, 框架版本)
        叠加默认层（默认全开 + 版本感知默认）
                    │
                    ▼
        解析结果：{ 宏名: { enabled, ...子选项 } }
                    │
        ├──▶ 构建侧：开着的宏 → 注册对应 AST 变换器
        └──▶ IDE 侧：开着的宏 → 注册对应虚拟代码生成器
```

几个关键的不变量：

- **Options 的形状**就是一个「宏名 → 开关」的映射，值要么是布尔（纯开关），要么是对象（开关 + 这个宏自己的子选项）。这是特性开关的最小单位。
- **两个物理落点**：一份在打包器配置（驱动 unplugin），一份在 tsconfig 的 `vueCompilerOptions`（驱动 volar）。为什么必须两份？因为语言服务跑在 IDE 进程里，打包器跑在另一个进程里，两边天生读不到对方的配置文件。
- **两侧互不通信**：运行时两条管线各自按自己的注册表干活，谁也不知道对方存在。一致性不是靠「运行时同步」保证的，而是靠「同一份 schema + 同一套默认逻辑」在构造期就静态对齐。

换句话说，这份配置干的其实只有一件事：**把「该开哪些宏」这个决策，在两条管线启动之前就钉死成同一个答案。**

## 4. 关键权衡

这是本章的重头戏。配置系统看着简单（不就是个对象嘛），但它每一个设计选择都在跟同一个本质矛盾较劲：**「一份真相」的理想，撞上「两个独立进程」的现实。**

### 权衡 1：同一份 schema，却落到两个物理副本

理想是一份配置喂两条管线，现实是打包器和语言服务是两个互不可见的进程。所以配置不得不**物理上写两份**（打包器一份、tsconfig 一份），但**逻辑上共享同一个 schema**。

- **选择**：schema 同源，物理落点分开。
- **换来**：两条管线能各自独立启动，IDE 的语言服务不用拉起打包器，打包器也不必依赖 TS 服务器。
- **代价**：两份配置得靠工具或人的纪律保持同步，否则就出现**开关漂移**——打包器开了宏 A、tsconfig 没开，于是构建正确变换、编辑器却满屏红线。

这条权衡化解的本质矛盾，是「逻辑同源」和「物理隔离」的对立：只要两条管线跑在两个进程里，你就没法真的只写一份配置；你能做的只是让两份副本指向同一个 schema，再用工具去抹平副本之间的缝隙。Vue Macros 后来做了一次 `unify bundler & volar config` 的重构，让 IDE 侧能从打包器配置派生出 volar 配置，正是对这个矛盾的直接补救：它没法消灭两个进程，但能消灭手工双写。

### 权衡 2：一个开关，同时门控两侧注册

一个特性开关不是「文档里的可选说明」，它是硬开关：打开 `defineModels`，意味着构建侧要注册它的 AST 变换器、IDE 侧要注册它的虚拟代码生成器，两侧同时挂载。

- **选择**：开关与两侧实现 1:1 绑定。
- **换来**：强一致。只要一个宏双侧都实现了，开关一开两侧就同时就位，不会出现「构建认、IDE 不认」。
- **代价**：任一侧新增一个宏，**必须双侧同时实现**，否则这个 flag 在缺实现的那侧就沦为**哑开关**——用户以为开了，实则那一侧无声失效，没有任何报错告诉你「这里其实没接上」。

这里的本质矛盾，是「开关的简洁」和「实现的对称」之间的张力：从用户视角，一个 flag 就是一个意图；但从实现视角，一个 flag 是两份独立的代码（变换器 + 虚拟代码生成器）。把它们绑成一个开关，用起来清爽，维护时却要时刻记得「改一侧必须改另一侧」。

### 权衡 3：默认全开（opt-out），而不是默认全关（opt-in）

官方的策略是：除少数行为激进的宏外，其余**默认全部启用**。装上就能用，零配置。

- **选择**：opt-out（默认开，不想要的显式关）。
- **换来**：零配置即用，采用门槛降到最低——这也是宏作为「编译器能力临时扩张」能快速铺开的前提。
- **代价**：用户可能无意中启用了并不想要的激进语法变换；而且「默认集合」本身不是稳定契约，它会随官方编译器的演进而变动。

这里有个很容易踩的坑，也是下一条权衡的引子：**「默认全开」不等于「默认稳定」**。今天默认开着的宏，明天官方编译器原生支持了，它就可能被默认关掉。所以在团队多成员、多版本的环境里，显式写明开关比依赖默认更可靠。

### 权衡 4：版本感知默认值

这是最巧妙、也最容易埋雷的一条。当配置检测到项目用的是 Vue ≥ 3.3 时，`defineOptions`、`shortEmits` 这类宏会被**默认关闭**——因为这些能力已经被官方编译器原生支持了，宏不再需要补位。

- **选择**：默认值随框架版本动态变化。
- **换来**：宏能优雅退场。官方编译器一跟上，宏就自动让位，用户什么都不用做，代码也不会因为同时有宏变换和官方变换而打架。
- **代价**：默认行为依赖一次**版本探测**，而且对用户完全不透明。同一份配置文件，在 Vue 3.2 和 3.3 项目里行为可能不同；出了问题去查配置，配置明明一行没改，排查起来极易困惑。

这条权衡化解的本质矛盾，是「宏的临时性」和「配置的稳定性」的对立：宏生来就是编译器能力的临时扩张，它注定要随官方能力收敛而退场；但配置文件天然追求「写一次就稳」。版本感知默认是把「宏会退场」这个事实塞进默认值里，让退场自动发生，代价则是把「配置行为取决于隐式的版本探测」这个复杂性转嫁给了排查者。（这条其实是下一章「宏的生态演进」在配置层的一次预演，先在这里埋下。）

## 5. 最小原理演示

下面这段代码不追求工程完整，只为演透一件事：**一份配置如何门控两条管线、漂移为何必然、版本感知默认怎么起作用。** 真实的 AST 变换、虚拟代码生成、打包器适配全部省略。

```ts
// ====== 1. 共享 schema：两条管线签的是同一份契约 ======
type MacroName = 'defineOptions' | 'defineModels' | 'shortEmits' | 'setupSFC'

// 权衡 3：默认全开，但行为激进的宏默认关
const DISABLED_BY_DEFAULT = new Set<MacroName>(['setupSFC'])
// 权衡 4：Vue ≥ 3.3 已被官方原生支持的宏，默认关（让位于官方能力）
const NATIVE_SINCE_3_3 = new Set<MacroName>(['defineOptions', 'shortEmits'])

// Options 的形状：宏名 → 布尔（纯开关）或对象（开关 + 子选项，这里子选项从简）
type UserOptions = Partial<Record<MacroName, boolean | { enabled?: boolean }>>
type Resolved = Record<MacroName, { enabled: boolean }>

// ====== 2. 默认层：把「用户没写的」补全成「每个宏开没开」 ======
function resolveOptions(user: UserOptions, vueVersion: number): Resolved {
  const all: MacroName[] = ['defineOptions', 'defineModels', 'shortEmits', 'setupSFC']
  const resolved = {} as Resolved
  for (const name of all) {
    const given = user[name]
    let enabled: boolean
    if (typeof given === 'boolean') {
      enabled = given                             // 用户显式说了 → 听用户的
    } else if (given && typeof given.enabled === 'boolean') {
      enabled = given.enabled                     // 子选项里显式说了 → 同样听用户的
    } else {
      const optOut = !DISABLED_BY_DEFAULT.has(name)                   // 默认全开
      const shadowedByNative = vueVersion >= 3.3 && NATIVE_SINCE_3_3.has(name) // 被官方覆盖 → 关
      enabled = optOut && !shadowedByNative
    }
    resolved[name] = { enabled }
  }
  return resolved
}

// ====== 3. 两条管线，从【同一个】resolved 派生各自的注册表 ======
// 真实代码里这两个函数内部完全不同（注册 AST visitor vs 生成虚拟代码），
// 这里为了演透「双侧派生自同一份 resolved」，把它们的差异抹平，只保留「读同一个输入」。
function registerBuildPipeline(resolved: Resolved): MacroName[] {
  return (Object.entries(resolved) as [MacroName, { enabled: boolean }][])
    .filter(([, o]) => o.enabled).map(([n]) => n)   // 开着的 → 注册 AST 变换器
}
function registerIdePipeline(resolved: Resolved): MacroName[] {
  return (Object.entries(resolved) as [MacroName, { enabled: boolean }][])
    .filter(([, o]) => o.enabled).map(([n]) => n)   // 开着的 → 注册虚拟代码生成器
}

// ====== 4. 一致：用户写一次，两侧派生同源（理想情形） ======
const resolved = resolveOptions({ defineModels: true, setupSFC: true }, 3.2)
//   → { defineOptions:{on}, defineModels:{on}, shortEmits:{on}, setupSFC:{on} }
console.log(registerBuildPipeline(resolved)) // ['defineOptions','defineModels','shortEmits','setupSFC']
console.log(registerIdePipeline(resolved))   // 同上 → 两侧注册表一致，不漂移

// 换到 Vue 3.3：defineOptions / shortEmits 被官方覆盖，自动默认关
const resolved33 = resolveOptions({ defineModels: true }, 3.3)
//   → { defineOptions:{off}, defineModels:{on}, shortEmits:{off}, setupSFC:{off} }

// ====== 5. 漂移：两条管线读了【不同的】options —— 契约破裂 ======
const buildResolved = resolveOptions({ setupSFC: true }, 3.2)  // 打包器侧显式开了「默认关」的宏
const ideResolved   = resolveOptions({}, 3.2)                  // IDE 侧漏配
//   build: setupSFC → on（听用户的）→ 变换器就位 → 运行期代码正确
//   ide:   setupSFC → off（默认关，用户没写）→ 不注册虚拟代码 → 编辑器红线，尽管能跑
```

每一行都对应上面某个原理点：`DISABLED_BY_DEFAULT` 是权衡 3、`NATIVE_SINCE_3_3` 是权衡 4、`resolveOptions` 是默认层、两个 `register*` 是双侧门控（权衡 2）、最后一段漂移是权衡 1 的代价。

注意第 4、5 步的对比：当两条管线读**同一个** `resolved`（第 4 步），注册表天然一致；一旦它们读了**不同的**输入（第 5 步，这正是「两个物理副本」的现实），漂移立刻发生。「同一份 schema、两个副本」这条权衡的全部实质就在这里。

## 6. 执行轨迹

拿一个具体场景走一遍。你在打包器配置里写 `{ defineModels: true }`，项目用的是 Vue 3.2。

1. **物理分叉**：这份意图落到两个地方——打包器配置（unplugin 读）、tsconfig 的 `vueCompilerOptions`（volar 读）。
2. **各自 resolve**：两侧用同一个 schema 跑 `resolveOptions({ defineModels: true }, 3.2)`。
   - `defineModels`：用户显式开 → `enabled: true`。
   - `defineOptions`、`shortEmits`：用户没写 → 默认全开，且 3.2 < 3.3 不被官方覆盖 → `enabled: true`。
   - `setupSFC`：用户没写 → 在默认关闭名单里 → `enabled: false`。
   - 解析结果：`{ defineOptions:{on}, defineModels:{on}, shortEmits:{on}, setupSFC:{off} }`。
3. **双侧注册**：构建侧给 `defineOptions/defineModels/shortEmits` 挂上 AST 变换器；IDE 侧（若 tsconfig 已同步）挂上同名的虚拟代码生成器。
4. **结果**：构建正确变换，IDE 也给出对应类型提示，两侧一致。

现在故意制造漂移。先试一个直觉上会漂移的：你只在打包器侧开了 `defineModels`，忘了在 tsconfig 里配。

- 打包器侧 resolve → `defineModels: { on }` → 变换器就位 → 运行期正确。
- IDE 侧 resolve 时 `defineModels` 不在输入里，但它「默认全开」→ `enabled: true` → 虚拟代码生成器照样注册。

没有漂移！这其实暴露了「默认全开」的一个隐性好处：漏配一个默认开的宏，两侧仍然一致。真正会漂移的是**默认关的宏**，比如 `setupSFC`——你只在打包器侧显式写 `setupSFC: true`，IDE 侧没配，打包器变换了、IDE 不认，于是红线，而代码照常跑。这正是上一节演示里漂移那段用 `setupSFC` 的原因。一句话点透：契约破裂的瞬间，就是你启用了一个「两侧没有共享同一份解析结果」的宏，而默认关的宏恰恰最容易掉进这条缝。

## 7. 教学简化说明

这段演示故意省略了：真实的 AST 变换实现、真实的虚拟代码生成、打包器工厂怎么把 transform 适配到 Vite/webpack、include/exclude 的 glob 匹配（它用来隔离几个会冲突的导出宏）、版本探测到底怎么从 `package.json` 读版本号，以及 `unify` 重构后两侧配置究竟怎么共享。这些都不影响理解「一份配置如何门控两条管线」。

## 8. 小结

配置系统把「该开哪些宏」这个决策，在两条管线启动之前钉死成同一个答案。它没法消灭两个进程，只能用同一份 schema 让两份物理副本指向同一个真相——漂移是这套设计与生俱来的代价，得靠 `unify` 这类工具去缝补。

其中最值得带走的是那条版本感知默认：宏会随官方编译器跟上而自动退场。这不是配置系统的边缘特性，而是宏这种东西的宿命——它本来就是编译器能力的临时扩张。下一章就把这件事讲透：零运行时换来的是什么代价，以及宏为什么注定要退场。