# 统一配置体系与版本感知默认值

## 一个让人头疼的场景

想象你在维护三个 Vue 项目：一个是三年前的老项目，还跑在 Vue 3.2；一个是去年的，Vue 3.3；还有刚搭起来的新项目，Vue 3.4。你三个项目都想用 vue-macros 这个库，因为它有三十多个语法糖宏能让代码更舒服。

但你很快发现一个问题：有些宏是「为旧 Vue 补齐的语法糖」——比如 `shortEmits`，Vue 3.3 之前原生不支持简洁写法，所以宏来补；3.3 之后原生支持了，宏再来一遍就是多余转换，搞不好还和原生行为打架。还有一些像 `shortBind`，是 3.4 才原生吸收的，那在 3.4 项目里就该关掉。

如果每个宏都写死一个固定开关，必然在某一侧出错：旧版该补的不补，新版该收的没收。

你真正想要的是这样一句话：**「我几乎不用配，库自己看我的 Vue 版本，决定哪些宏该上、哪些宏可以撤。」**

这一章讲的就是 vue-macros 怎么做到这件事。核心一句话：**默认值不是常量，是「检测到的 Vue 版本号」的函数。**

## 一张「版本门槛表」就是全部玄机

打个比方：这就像一道带自动门禁的入口，每个人（特性）胸前都挂着一块牌子，上面写「仅限身高 1.2 米以下进入」。门口有个测身高的人（版本探测），测完逐个对照，过线的放行、不过线的拦下。整张「谁挂什么牌子」的表，就是配置的源头。

vue-macros 把三十多个特性收进了一张表，每个特性配一个**默认门槛**。门槛只有两种写法：

- 一个布尔值（`true` / `false`）：写死开或关。
- 一个版本号（如 `3.3`）：意思是「检测到的 Vue 版本 **小于** 这个数才默认开」。

注意第二种——这是整章的精髓。被新版 Vue 原生吸收的语法糖（`shortEmits`、`defineSlots`、`shortBind` 等）门槛就是「该版本号」，于是在新版下自动关、旧版下自动开。**同一个默认值，在不同版本下算出不同行为。**

## 自底向上：从原始件到最终配置

讲清楚这张表怎么运转，得从最底层的那几块往上搭。

### 第一块：三个「全局量」

合并配置前，先有三个公共量要确定：

- **根目录 `root`**：项目装在哪。后面所有「读磁盘配置」「读 vue 包版本」都得知道去哪个目录读。
- **Vue 版本号 `version`**：用 `local-pkg` 沿 `root` 解析已安装的 `vue` 包，读它的 `version` 字段，`parseFloat` 取出来。Vue 2.x 还会取整（`Math.trunc`）。探测不到时给个回退默认（如 3.5）并 warn 一声。
- **生产环境标记 `isProduction`**：直接看 `process.env.NODE_ENV === 'production'`。

这三个量是「全局上下文」——**每个特性最终都需要它们**，所以探测一次、统一注入，比每个特性各自探测强得多。这是后面权衡 2 要展开的点。

### 第二块：两层用户配置合并

用户可以两处写配置：

- **磁盘配置文件**：约定文件名 `vue-macros.config.{mts,cts,ts,mjs,cjs,js,json}`，或 `package.json` 里的 `vueMacros` 字段。这是「项目级的偏好」。
- **调用时传入的选项**：在 vite 配置里 `VueMacros({ ... })` 这样传。这是「这次装配的覆盖」。

合并规则非常简单：**后者逐字段覆盖前者，浅合并**。说人话就是：你在调用时传了的字段就赢，没传的字段 fallback 到磁盘文件。

### 第三块：每个特性的「最终配置」

合出来的那份对象，每个特性名下还有一个值——可能是用户没动它（缺省）、可能是用户显式给的（`true` / `false` / 一个带参数的对象）。对每个特性，按下面这个流程算出它最终的配置：

1. 取出该特性的**默认门槛**（布尔或版本号）。
2. 算默认值：门槛是布尔就直接用；门槛是数字就 `version < 门槛`。
3. 用户显式给过就用用户的，否则用默认（`用户值 ?? 默认`）。
4. 算出来是 `false` 就原样返回 `false`（关闭）；否则把三个全局量合并进去，得到该特性的最终配置。

整张表跑一遍，得到一份「每个特性要么是 `false`、要么是带全局上下文的配置」的结果表。这就是喂给下游装配管道的东西——管道里看到 `false` 就跳过该宏，看到对象就实例化它。

## 心智模型：七步流水线

把上面拼成一张全景图：

```
磁盘配置文件 ──┐
               ├─→ 合并（磁盘 ← 调用覆盖）─┐
调用传入选项 ──┘                            │
                                            ├─→ 逐特性解析
三个全局量（root/version/isProduction）─────┘
                                            │
                                            ↓
              ┌─────────────────────────────────────┐
              │ 对每个特性：                          │
              │   默认门槛 → 算默认（version<门槛？） │
              │   用户值 ?? 默认                       │
              │   false 则关闭 / 否则合并全局量        │
              └─────────────────────────────────────┘
                                            │
                                            ↓
              每特性: false | 带全局上下文的配置
                                            │
                                            ↓
                  喂给下游装配管道（前置章已展开）
```

展开成七步：

1. 读磁盘配置文件（约定文件名 + `package.json#vueMacros`）。
2. 探测 Vue 版本（`local-pkg` 读 `vue` 包版本）。
3. 合并：磁盘配置 ← 调用选项覆盖。
4. 补三个全局量的默认值。
5. 逐特性查门槛：布尔用布尔；数字按 `version < 数字` 算默认。
6. 用户显式给过就用用户的；否则用第 5 步算出的默认。
7. 结果 `false` 就原样返回；否则合并全局量得到最终配置。

最后这张表交给装配管道，前置章已讲过它怎么把每个特性分发到对应 bundler 入口，本章不重复。

## 最小演示：版本感知开关表

下面这段几十行的脚本，演透了两条原理：**默认值 = 版本的函数**，以及 **`false` 哨兵 + 全局量合并**。完全从零实现，不依赖任何具体构建器，能用 `bun run` 或 `tsx` 直接跑。

```ts
// version-aware-config.ts
// 一张极简的「特性 → 默认门槛」表
// 门槛只有两种：布尔（写死开/关）、数字（version < 数字 才默认开）
type Threshold = boolean | number

const featureTable = {
  // 默认开的特性
  defineModels: true,
  betterDefine: true,
  // 「被新版 Vue 原生吸收」的语法糖：旧版补、新版关
  shortEmits: 3.3, // Vue 3.3 起原生支持
  defineSlots: 3.3,
  shortBind: 3.4, // Vue 3.4 起原生支持
  // 默认关的特性（实验性，需显式启用）
  defineStylex: false,
} as const

type FeatureName = keyof typeof featureTable

// 全局上下文：探测一次、各特性共享
type GlobalCtx = {
  root: string
  version: number
  isProduction: boolean
}

// 单特性解析：算默认 → 用户值优先 → false 或合并全局量
function resolveFeature<K extends FeatureName>(
  name: K,
  global: GlobalCtx,
  userValue: boolean | object | undefined,
): false | (GlobalCtx & object) {
  // 第一步：算「版本感知的默认值」
  const threshold: Threshold = featureTable[name]
  const defaultEnabled =
    typeof threshold === 'boolean' ? threshold : global.version < threshold

  // 第二步：用户值优先
  const resolved = userValue ?? defaultEnabled

  // 第三步：false 是唯一的关闭哨兵
  if (!resolved) return false

  // 否则把全局量合并进去
  // 用户给 true 表示「开但无额外参数」、给对象表示「开且带参数」
  return {
    ...global,
    ...(resolved === true ? {} : resolved),
  }
}

// 跑一遍：同一份用户配置、两个 Vue 版本，看差异
function run(userOpts: Record<string, any>, version: number) {
  const global: GlobalCtx = {
    root: '/fake/project',
    version,
    isProduction: false,
  }
  console.log(`\n=== Vue ${version} ===`)
  for (const name of Object.keys(featureTable) as FeatureName[]) {
    const result = resolveFeature(name, global, userOpts[name])
    console.log(
      `  ${name.padEnd(14)} ->`,
      result === false
        ? '关闭（管道跳过）'
        : '开启，配置 = ' + JSON.stringify(result),
    )
  }
}

// 同一份空用户配置，分别在 Vue 3.2 和 3.4 下跑
const emptyUserConfig: Record<string, any> = {}
run(emptyUserConfig, 3.2)
run(emptyUserConfig, 3.4)
```

跑出来的轨迹长这样：

```
=== Vue 3.2 ===
  defineModels   -> 开启，配置 = {"root":"/fake/project","version":3.2,"isProduction":false}
  betterDefine   -> 开启，配置 = {"root":"/fake/project","version":3.2,"isProduction":false}
  shortEmits     -> 开启，配置 = {"root":"/fake/project","version":3.2,"isProduction":false}
  defineSlots    -> 开启，配置 = {"root":"/fake/project","version":3.2,"isProduction":false}
  shortBind      -> 开启，配置 = {"root":"/fake/project","version":3.2,"isProduction":false}
  defineStylex   -> 关闭（管道跳过）

=== Vue 3.4 ===
  defineModels   -> 开启，配置 = {"root":"/fake/project","version":3.4,"isProduction":false}
  betterDefine   -> 开启，配置 = {"root":"/fake/project","version":3.4,"isProduction":false}
  shortEmits     -> 关闭（管道跳过）
  defineSlots    -> 关闭（管道跳过）
  shortBind      -> 关闭（管道跳过）
  defineStylex   -> 关闭（管道跳过）
```

**同一份空配置，仅仅版本号不同**——3.2 下短绑定语法糖全开（旧版需要补）、3.4 下它们全关（新版原生有了，再补就是多余）。这就是「默认值 = 版本的函数」最直白的体现。

> 演示故意省略了真实的磁盘文件加载、双模异步包装的转译细节、三十多个特性的专属字段、HMR 等工程细节。这些不参与「演透原理」，留着只增加噪音。

## 关键权衡

这一章的原理看似简单，背后却有四条值得说的设计取舍。前三条讲透机制本身，最后一条牵出对下游时序的影响。

### 权衡 1（核心）：版本号当默认门槛

**做了什么**：把每个特性的默认开关从「写死的布尔」改成「一个版本数字」，规则是「检测到的版本 < 该数字才默认开」。

**换来什么**：同一份配置在新旧 Vue 下行为自适应——被新版原生吸收的语法糖在新版下自动关闭、在旧版下自动补齐。用户从 3.2 升级到 3.4 时，无需改一行配置，原本补齐的语法糖自动撤掉，不会和新原生能力打架。**同一份 `vue-macros.config.ts` 在不同版本项目里复制粘贴就能用**，这是它最大的用户体验红利。

**代价**：用户必须理解每个特性都有自己的版本门槛——这本身就是一份隐藏的知识。**更棘手的是「静默关闭」**：升级 Vue 时某个宏可能突然关掉，依赖它的代码不会报错，只是悄悄退回原生写法。比如你的 demo 里用 `shortEmits` 的简洁写法演示某件事，从 3.2 升到 3.3 后宏没了，写法在新版 Vue 下若恰好踩到原生不支持的边界，可能要等用户运行时才察觉。这是「版本即默认来源」的一体两面——你接受自动适配的便利，就要承担自动适配的盲区。

### 权衡 2：三层合并 + 全局上下文一次性下发

**做了什么**：把「磁盘配置文件」「用户调用时传入的选项」按前者被后者覆盖地合并（浅合并、逐字段覆盖）；再把三个全局量（`root`、`version`、`isProduction`）注入到每一个特性的最终配置里。

**换来什么**：「全局上下文探测一次、各特性无需各自重复探测」——三十多个特性谁也不用自己去翻 `package.json`、自己判 NODE_ENV。配置来源也单一可控：磁盘是项目默认、调用是工程覆盖、语义清晰。同时这让特性的子选项类型保持干净——只装该特性自己关心的东西，三个全局量不污染类型签名。

**代价**：合并语义是**隐式的**——传入选项永远覆盖文件，且都是浅合并。用户对「文件 vs 调用谁赢」没有显式信号，嵌套对象（如某特性的子选项）会被整体替换而非深合并。比如磁盘里写了 `defineModels: { include: ['**/*.vue'] }`、调用里写了 `VueMacros({ defineModels: { isProduction: true } })`，合出来的 `defineModels` 只有 `isProduction`、`include` 没了——这通常不是用户预期。新手踩到这个坑很难第一反应过来是浅合并惹的祸。

### 权衡 3：用 `false` 当「关闭」哨兵

**做了什么**：用字面量 `false` 表示某特性彻底关闭，其余情况（无论 `true` 还是对象）都合并出一份带文件过滤条件（include/exclude）的配置。

**换来什么**：下游管道只需要一个二元判定——`=== false` 就跳过、否则就用。类型上把「关闭」也明明白白纳入（解析结果是 `false | 完整选项`），没有「`undefined` 表示关闭吗？」这种含糊空间。装配管道的代码因此极其清爽：`if (options.shortEmits) plugin.use(setupPlugin(options.shortEmits))`，不用判 undefined、不用判 null、不用判空对象。

**代价**：「关闭(`false`)」与「开启但无额外参数(`true` / 空对象)」必须用不同字面量区分，新手配置时容易混。比如有人想关一个特性，可能下意识写 `defineStylex: {}`，结果是开启、只是没传参数——和「关」背道而驰。这种「布尔 vs 空对象语义不对称」的小坑，是把关闭纳入类型的不可避免副产品。换句话说，**类型上的整洁是用配置语义上的微妙换来的**。

### 权衡 4：配置解析做成异步

**做了什么**：因为要读磁盘上的配置文件，把整个解析入口用「可同步可异步」的双模包装（对外伪装成同步签名、内部实际是 `async`），让上层可以 `await resolveOptions(userOptions)`。

**换来什么**：「先解析、再装配」的清晰时序——主聚合插件先 `await` 完配置拿到完整的开关表，再决定实例化哪些宏、跳过哪些。装配管道启动前，所有「关闭的宏」已经在配置阶段从表里消失了，下游不需要二次判定。换句话说，**配置定型这件事有一个明确的、不可绕过的时间点**，过了这个点整张表就只读、谁拿到的都是同一份。

**代价**：配置解析成了带 I/O 的异步步骤，**必须在装配管道启动前完成**，增加了一个不可违反的时序约束。这意味着想在运行时动态改配置（比如某个钩子里翻转开关）是不可能的——它锁死在「启动前一次定型」的语义里。双模异步包装的转译机制本身（quansync 的宏）属第三方库内部，本章只见用法、不展开其内部。

> 这一章的机制相对集中，这四条已把核心讲透——没有再凑数冗余的取舍。

## 这一章和下一章的接口

本章产出是一张「每个特性 → `false` 或 带全局上下文的配置」的表。**紧邻下一章「主聚合插件与转换管道顺序编排」**就要消费这张表：它在一个 async IIFE 里 `await` 完配置，再把每个特性的结果按精心设计的顺序喂给装配管道，串成一条完整的转换流水线。

换句话说，本章解决「**开关怎么算出来**」，下一章解决「**开了的宏按什么顺序跑**」——顺序之所以关键，是因为 `betterDefine` 必须在 `defineProps` 之后才能看到已重写的 props，结构扩展必须先于一切否则后续宏拿不到 script setup。这些下一章详谈。

至于「分发到六套 bundler 入口」的机制本身——前置章已展开，这里不重复。