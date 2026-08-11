# 统一配置体系与版本感知默认值

> 本章属于 system 层。前置：「一次编写、六套构建器适配」。
> 学完你能：用一句话讲清为什么 vue-macros 的默认配置不是常量、而是「Vue 版本号的函数」——以及它换来了什么、付出了什么。

## 1. 为什么需要它

上一章末尾留了个钩子：`short-bind`、`short-vmodel` 这些单点宏在 plugin 层调 `detectVueVersion()` 是为了**变换逻辑**本身的版本差异（旧版允许 `:foo`、新版只认 `::foo`），至于「这个宏在新旧 Vue 下默认开还是关」的另一层版本感知，归配置层管。本章就接着这另一层讲。

把视角拉到整个 vue-macros：三十多个特性里，相当一部分的命运和 Vue 版本绑死——`shortEmits`、`defineSlots` 这类语法糖在 3.3 之后被 Vue 原生吸收；`short-bind` 在 3.4 之后原生支持；另一些是给旧版补齐能力的垫片。想象一个用户在两个项目里都用 vue-macros：项目 A 跑 Vue 3.2、项目 B 跑 Vue 3.4。如果每个特性都写死一个固定默认（比如「`shortEmits` 默认开」），那它要么在项目 B 里做无用转换、甚至跟原生能力打架，要么就得用户自己关掉。反过来默认都关，项目 A 就少了一块补齐能力。

**问题不在于「该开还是该关」，而在于「该开还是该关」这件事本身就取决于一个外部状态——当前项目装的 Vue 版本。** 这一层要解决的，就是把这个外部状态接到配置体系里，让用户几乎不用动配置，库自己按 Vue 版本决定哪些宏该上。

## 2. 核心思想

默认值不是常量，而是「检测到的 Vue 版本号」的函数。同一份配置在 Vue 3.2 和 Vue 3.4 项目里跑出来长出不同的形状——前者把 `shortEmits` 算成开、后者把它算成关，用户完全不用感知。

## 3. 心智模型

先把整条解析路径画清楚：从磁盘一路读到最终配置，一共七步，每一步都在把「版本号」和「用户意图」往最终开关里拼。

1. **读磁盘配置**：按约定文件名（`vue-macros.config.*`）和 `package.json` 里的字段，把用户写在磁盘上的配置读进来。
2. **探版本**：用 `local-pkg` 按 `root` 路径解析已安装的 `vue` 包，读它的 `version` 字段。
3. **合并**：把磁盘配置和「调用时传入的选项」浅合并——后者逐字段覆盖前者。
4. **补全局默认**：三个全局量（`root` 缺省 `cwd`、`version` 缺省探到的版本、`isProduction` 缺省 `NODE_ENV === 'production'`）补齐。
5. **逐特性算门槛默认**：每个特性在调用处都有一个门槛值（布尔或数字）。门槛是布尔就直接当默认值；门槛是数字就按 `version < 门槛` 算出默认开或关。
6. **用户优先**：用户显式给过的，就用用户的；否则用第 5 步算出的默认。
7. **`false` 即关闭**：最终值是 `false` 的特性原样返回 `false`；否则把全局量合并进去，得到带上下文的完整配置对象。

整张表汇总后交给前置章讲过的那条 `resolvePlugin → bundler 入口` 装配管道——某特性是 `false`，对应的宏实例就不会被创建、从管道里消失。

## 4. 关键权衡

### 把版本号当默认门槛，而不是写死布尔

每个特性的「默认开关」在源码里不是一个布尔，而是一个版本数字（或一个布尔）。规则是「检测到的版本 < 该数字才默认开」。比如 `shortEmits` 的门槛是 `3.3`——Vue 3.3 之后原生支持，于是 3.2 项目里默认开、3.4 项目里默认关。

- **换来**：同一份配置在新旧 Vue 下行为自适应——新版里被吸收的语法糖自动停止做无用转换，旧版里自动补齐。用户零配置即可用。
- **代价**：用户必须理解每个特性有自己的版本门槛；升级 Vue 时某个宏可能「静默关闭」，依赖它的代码不会报错、只是相应转换不再发生——这是一体两面的副作用。
- **化解的本质矛盾**：「默认值随环境漂移」与「用户不想手动改配置」在打架——把版本号塞进默认值定义里，让漂移本身被默认值吸收掉，而不是逼用户去手改。

### 三层合并，全局上下文一次性下发

整套合并是「磁盘配置 ← 调用时传入选项」的浅覆盖，然后把 `root`/`version`/`isProduction` 三个全局量单独提到一张 `globalOptions` 里，给每个特性的最终配置都注入一份。

- **换来**：探测成本只付一次（探版本是一次磁盘 I/O），各特性不必各自重复探测；配置来源也只剩两层（文件、调用），单一可控。
- **代价**：合并语义是隐式的——传入选项永远覆盖文件，且是浅合并。用户对「文件 vs 调用谁赢」没有显式信号，新手写一份又改一份时容易困惑。
- **化解的本质矛盾**：「特性级独立性」与「全局上下文一致性」在打架——各特性只关心自己的子选项，全局量统一注入，不重复也不漂移。

### 用字面量 `false` 当关闭哨兵

下游看到的解析结果，对每个特性要么是 `false`（关闭），要么是一个完整的选项对象（开启，至少含全局量）。`true`、空对象 `{}` 在「开启」语义上等价（都展开成「只含全局量」），只有 `false` 是唯一的关闭信号。

- **换来**：下游管道只需要一个二元判定——`=== false` 就跳过、否则就用。类型也把「关闭」显式纳入，没有「`undefined` 表示关闭」这种模糊态。
- **代价**：「关闭(`false`)」与「开启但无额外参数(`true`/空对象)」必须用不同字面量区分，新手配置时容易混——尤其想「关掉某个特性」时下意识写 `null` 或 `undefined` 都没用，必须显式写 `false`。
- **化解的本质矛盾**：「API 形状简单（二元判定）」与「类型完整覆盖关闭态」在打架——把关闭做成字面量而不是缺省，下游消费时的判定降到一次比较。

### 配置解析做成异步动作

整个解析入口用 `quansync` 包成「可同步可异步」的双模函数：内部真正去读磁盘配置文件是 async，但对外暴露的签名看上去能同步调用。

- **换来**：上层装配管道可以先 `await resolveOptions(userOptions)` 拿到完整配置，再决定实例化哪些宏——「先解析、再装配」的时序清晰：配置不全就没法判断哪些宏该上。
- **代价**：配置解析成了带 I/O 的异步步骤，必须在装配管道启动前完成——这是一个不可违反的时序约束。如果有人误把解析放到「已经实例化宏之后」，就会拿到不完整的配置。
- **化解的本质矛盾**：「需要读磁盘（异步 I/O）」与「下游消费想要简单同步签名」在打架——用双模包装把两边都安抚下来，但要付一次时序约束的代价。

## 5. 最小原理演示

下面这段几十行的脚本只演透两件事：**版本号如何左右默认开关**，以及 **`false` 哨兵 + 全局量合并**。它故意不读磁盘、不双模包装、不接任何构建器。

```ts
// 一张小特性表：每个特性配一个门槛
// 门槛是布尔 → 直接当默认值
// 门槛是数字 → version < 门槛 才默认开
type Threshold = boolean | number

const featureTable = {
  defineModels:  true,   // 固定默认开（所有版本都需要）
  shortEmits:    3.3,    // 3.3 之后被 Vue 原生吸收，旧版才需要补
  shortBind:     3.4,    // 3.4 之后原生支持
  exportExpose:  false,  // 默认关，需显式启用
} satisfies Record<string, Threshold>

// 全局上下文：探测一次、所有特性共享
type GlobalCtx = { root: string; version: number; isProduction: boolean }

// 单特性解析：算门槛默认 → 用户优先 → false 即关闭 → 合并全局量
function resolveFeature<K extends keyof typeof featureTable>(
  name: K,
  ctx: GlobalCtx,
  userValue?: boolean | Record<string, unknown>,
): false | (GlobalCtx & Record<string, unknown>) {
  const threshold = featureTable[name]
  // 默认值是版本的函数：版本数字与当前版本号比较得出开或关
  const defaultEnabled =
    typeof threshold === 'boolean' ? threshold : ctx.version < threshold
  const value = userValue ?? defaultEnabled
  // false 是唯一的关闭哨兵
  if (value === false) return false
  // 开启：把全局量合并进去（true / 空对象 / 子选项 都走这条）
  const subOptions = value === true ? {} : value
  return { ...ctx, ...subOptions }
}

// 入口：对每个特性调一次 resolveFeature
function resolveOptions(
  ctx: GlobalCtx,
  userOptions: Partial<Record<keyof typeof featureTable, boolean | object>> = {},
) {
  const result = {} as Record<string, false | (GlobalCtx & Record<string, unknown>)>
  for (const name of Object.keys(featureTable) as (keyof typeof featureTable)[]) {
    result[name] = resolveFeature(name, ctx, userOptions[name])
  }
  return result
}
```

跑两次，对比同一份用户配置在两版本下的形状差异：

```ts
const emptyUserConfig = {}  // 用户什么都不传

const onVue32 = resolveOptions(
  { root: '/proj-a', version: 3.2, isProduction: false },
  emptyUserConfig,
)
const onVue34 = resolveOptions(
  { root: '/proj-b', version: 3.4, isProduction: false },
  emptyUserConfig,
)
console.log(onVue32.shortEmits)  // { root: '/proj-a', version: 3.2, ... } —— 3.2 < 3.3，默认开
console.log(onVue34.shortEmits)  // false —— 3.4 ≥ 3.3，默认关
```

## 6. 执行轨迹

把 `shortEmits` 这一个特性在两个项目里各跑一遍，看每一步状态：

**项目 A：Vue 3.2、空用户配置**

| 步骤 | 状态 |
|---|---|
| 1. 读磁盘 | 用户没写文件，得到 `{}` |
| 2. 探版本 | 读到 `vue@3.2.5`，解析为 `3.2` |
| 3. 合并 | `{}` ← `{}` 浅覆盖 → `{}` |
| 4. 补全局 | `globalOptions = { root: '/proj-a', version: 3.2, isProduction: false }` |
| 5. 算门槛默认 | 门槛 `3.3`，`3.2 < 3.3` → `defaultEnabled = true` |
| 6. 用户优先 | 用户没给 `shortEmits`，用默认 `true` |
| 7. `false` 即关闭？ | 不是 `false` → 返回 `{ ...globalOptions, ...({}) }` |

**最终输出**：`{ root: '/proj-a', version: 3.2, isProduction: false }`——装配管道看到不是 `false`，就把 `shortEmits` 实例化、塞进管道。

**项目 B：Vue 3.4、空用户配置**

| 步骤 | 状态 |
|---|---|
| 1. 读磁盘 | `{}` |
| 2. 探版本 | 读到 `vue@3.4.0`，解析为 `3.4` |
| 3. 合并 | `{}` |
| 4. 补全局 | `globalOptions = { root: '/proj-b', version: 3.4, isProduction: false }` |
| 5. 算门槛默认 | 门槛 `3.3`，`3.4 < 3.3` 为 `false` → `defaultEnabled = false` |
| 6. 用户优先 | 用户没给，用默认 `false` |
| 7. `false` 即关闭？ | 是 → 返回 `false` |

**最终输出**：`false`——装配管道跳过 `shortEmits`、不实例化它。同一份用户配置，两个版本，两套行为：3.2 项目拿到补齐能力、3.4 项目不重复造轮子。

## 7. 教学简化说明

上面的演示故意省略了：磁盘配置的多源匹配（`unconfig` 怎么按优先级找文件）、`quansync` 双模异步包装的转译机制、三十多个特性各自的专属字段（属各宏自己的章）、HMR 与具体构建器的接线。这些都不影响理解「版本即默认来源」这条主线。

## 8. 小结

升 Vue 不改配置，库自己就把被原生吸收的语法糖关掉、把旧版缺的能力补上——这就是版本感知默认值换来的事。代价是每个特性有自己的版本门槛，升 Vue 时某个宏可能无声关闭。

这份最终配置喂给装配管道时，每个特性是 `false` 就被丢掉、是一个对象就被实例化——下一章「主聚合插件与转换管道顺序编排」就接着讲：剩下的这些宏实例按什么顺序串成一条管道。