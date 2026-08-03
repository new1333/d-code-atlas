# 统一配置体系与版本感知默认值 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：这个库有三十多个可开关的宏，其中相当一部分是「为旧版 Vue 补齐、或被新版 Vue 原生吸收」的语法糖。用户在不同项目里跑的 Vue 版本不同：在旧版里不补就缺功能，在新版里又补了等于做无用转换甚至和新原生能力打架。如果给每个宏写死一个固定的「默认开/关」，必然在某一侧出错。使用者真正想要的是「我几乎不用配，库自己按我的 Vue 版本决定哪些宏该上」。

- **一句话核心思想**：**默认值不是常量，是「检测到的 Vue 版本号」的函数**——同一份配置在不同版本下自动长出不同行为。

- **设计动机（为什么需要它）**：这套配置体系是为了解决「三十多个特性的默认开关随运行环境（Vue 版本）漂移」这个矛盾而生的，换来的是「用户零配置即可用、且不会在新版 Vue 下做多余转换」的能力。承前关系：它服务的对象是前置章「一次编写、六套构建器适配」里那条 `resolvePlugin → 各 bundler 入口` 的装配管道——那条管道的「分发机制」已在前置章讲透，本章**只看新侧面**：喂给装配管道的那份「每个特性开或关、带什么参数」的最终配置，究竟是怎么算出来的，尤其是「版本号如何成为默认值的来源」。配置加载本身还要支持从磁盘配置文件读取，因此走的是异步加载（见下方权衡）。

- **关键权衡（核心原料）**：
  1. **版本号当默认门槛**：把每个特性的默认开关从「写死的布尔」改成「一个版本数字」，规则是「检测到的版本 < 该数字才默认开」→ 换来了同一份配置在新旧 Vue 下行为自适应（被新版原生吸收的语法糖在新版下自动关闭、在旧版下自动补齐）→ 代价是用户必须理解每个特性的版本门槛，且升级 Vue 时某个宏可能「静默关闭」，令依赖它的代码突然失效而不报错。
  2. **三层合并 + 全局上下文一次性下发**：把「磁盘配置文件」「用户调用时传入的选项」按前者被后者覆盖地合并，再把三个全局量（项目根、Vue 版本、是否生产环境）注入到每一个特性的最终配置里 → 换来了「全局上下文探测一次、各特性无需各自重复探测」的便利、以及配置来源单一可控 → 代价是合并语义是隐式的（传入选项永远覆盖文件，且都是浅合并），用户对「文件 vs 调用谁赢」没有显式信号。
  3. **用 `false` 当「关闭」哨兵**：用字面量 `false` 表示某特性彻底关闭，其余情况（无论 `true` 还是对象）都合并出一份带文件过滤条件的（include/exclude）的配置 → 换来了下游管道只需一个二元判定（`=== false` 就跳过、否则就用），且类型上把「关闭」也纳入 → 代价是「关闭(`false`)」与「开启但无额外参数(`true`/空对象)」必须用不同字面量区分，新手配置时容易混。
  4. **配置解析做成异步动作**：因为要读磁盘上的配置文件，把整个解析入口用「可同步可异步」的双模包装（对外伪装成同步签名、内部实际是 async）→ 换来了上层装配管道可以先 `await` 完配置再决定实例化哪些宏（即「先解析、再装配」的清晰时序）→ 代价是配置解析成了带 I/O 的异步步骤，必须在装配管道启动前完成，增加了一个不可违反的时序约束。

- **最小心智模型（3～7 步）**：
  1. 从磁盘读配置文件（约定文件名 + `package.json` 里的字段），拿到用户写下的配置。
  2. 探测当前项目的 Vue 版本号（读已安装的 vue 包的版本字段）。
  3. 合并：磁盘配置 ← 用户调用时传入的选项覆盖（后者赢）。
  4. 补齐三个全局量（根目录、版本号、生产环境标记）的默认值。
  5. 对每个特性查它的「默认门槛」：门槛是布尔就用布尔；门槛是数字就按「版本 < 数字」算出默认开或关。
  6. 用户显式给过该特性的值就用用户的；否则用第 5 步算出的默认。
  7. 结果是 `false`（关闭）就原样返回；否则把全局量合并进去，得到该特性的最终配置。整张表汇总后交给下游装配管道。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的「版本感知默认开关表」骨架。核心只演两条权衡——「默认值 = 版本的函数」和「`false` 哨兵 + 全局量合并」。结构：一张「特性名 → 默认门槛（布尔或数字）」的表；一个 `resolve(features, version, userOpts)` 函数：对每项算 `默认 = typeof 门槛 === 'number' ? version < 门槛 : 门槛`，`用户值 ?? 默认`，为 `false` 则跳过、否则返回 `{ ...globalCtx, ...用户对象 }`。每行都对应上面某个原理点（数字门槛对应权衡1、`?? 默认`对应合并、`false`对应权衡3）。
  - **应故意省略**：真实的磁盘配置文件加载（unconfig 的多源匹配）、双模异步包装的具体转译、三十多个特性各自的专属字段、HMR、与具体构建器的接线。**不追求工程完整，只追求演透原理。**
  - **演示载体建议**：本仓库主语言是 TypeScript，建议写成一段能被 `bun run`/`node`（或 `tsx`）直接跑的独立 `.ts` 脚本：造一张含「固定默认(`true`)、版本门槛(`3.3`)、固定关(`false`)」三类特性的小表，硬编两个版本号（如 3.2 与 3.4）各跑一次，打印同一份用户配置在两版本下的开关差异——直观演透「同一配置、两套行为」。能跑最好但非硬要求；关键是打印出「3.2 下某特性开、3.4 下关」的对比轨迹。

- **正文不宜展开的细节**：双模异步包装（quansync）的宏转译机制本身（属第三方库内部）；配置文件匹配的扩展名优先级与 `package.json` 字段重写规则；三十多个特性各自的 `OptionsXxx` 专属字段（属各宏自己的章）；`OptionsCommon` 里给 Nuxt 用的 SSR 客户端判定上下文（属框架集成章）；eslint 排序注解等工程化脚手架。

- **推荐的一个执行轨迹例子**：输入——同一份空用户配置、两次运行，一次项目装的是 Vue 3.2、一次是 Vue 3.4。关键中间态——「emits 简写语法糖」特性的门槛是 3.3，于是默认值在 3.2 下算成 `开`、在 3.4 下算成 `关`。输出——3.2 运行得到「该特性开启、带全局上下文的配置对象」；3.4 运行得到 `false`（关闭、装配管道跳过它）。一句话：同一份配置，版本不同则行为不同。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 整套体系的入口是一个被双模异步包装的解析函数：先从磁盘读配置文件，再合并用户传入选项，再逐特性算默认。源码位置: packages/config/src/options.ts:228-231
- 「特性表」是一个把三十多个特性名映射到各自选项类型的接口，每个字段都带 `@default` 注释；其中一部分注释是**版本条件**（如 `vueVersion < 3.3`、`vueVersion < 3.4`），把「版本即默认来源」直接写进了类型文档。源码位置: packages/config/src/options.ts:63-215
- 三类版本门槛实例：被新版原生吸收的「选项宏 / 插槽宏 / emits 简写」门槛为 3.3（`@default vueVersion < 3.3`），「短绑定语法糖」门槛为 3.4，其余多为固定 `true`（默认开）或固定 `false`（默认关、实验性或需显式启用）。源码位置: packages/config/src/options.ts:96-98,119-123,201-209
- 三个全局量在合并阶段补默认：根目录缺省用 cwd；版本号缺省用 `detectVueVersion(root)`；生产环境标记缺省用 `NODE_ENV === 'production'`。源码位置: packages/config/src/options.ts:239-241
- 版本探测实现：用 local-pkg 按 `root` 路径解析已安装的 `vue` 包，读其 version 字段并 `parseFloat`；Vue 2.x 取整数（`Math.trunc`）；探测不到（如无 require）时 warn 并回退默认 3.5。源码位置: packages/common/src/dep.ts:20-45
- 单特性解析的核心规则（权衡1+3 的落地）：门槛为布尔时直接当默认值；门槛为数字时 `version < 门槛` 才默认开；用户值（`??`）优先于默认；值为假（`false`/未给且默认关）则返回 `false`，否则把全局量合并进去（用户给 `true` 表示「开但无额外参数」）。源码位置: packages/config/src/options.ts:283-296
- 合并优先级是「磁盘配置 ← 调用时传入选项」（后者逐字段覆盖前者，浅合并）；特性子选项从合并后对象的剩余部分（`...subOptions`）取出。源码位置: packages/config/src/options.ts:234-237
- 解析结果的类型把「关闭」显式纳入：每个特性解析后为 `false | 该特性的完整选项`，且全局公共部分为 `Required`。源码位置: packages/config/src/options.ts:224-226
- 磁盘配置加载用 unconfig，约定源为 `vue-macros.config.{mts,cts,ts,mjs,cjs,js,json}` 及 `package.json#vueMacros` 字段；同样被双模异步包装，供解析入口 await。源码位置: packages/config/src/config.ts:5-23
- `defineConfig` 只是一个返回原值的类型辅助函数（且 `Omit` 掉不该由用户配置的 `plugins` 字段），不引入运行时逻辑，仅为编辑器类型提示与文档入口。源码位置: packages/config/src/define.ts:3-7
- 公共选项类型：`OptionsCommon` 继承自 `BaseOptions`（含 `version`/`isProduction`）但显式 `Omit` 掉了文件过滤字段（include/exclude），把过滤条件下沉到每个特性的子选项里，并额外加 `root`/`plugins`/`nuxtContext`。源码位置: packages/config/src/options.ts:50-61；BaseOptions/FilterOptions 定义 源码位置: packages/common/src/options.ts:3-6, packages/common/src/unplugin.ts:17-20
- 下游消费方式（承前接管道）：主聚合插件在一个 async IIFE 里先 `await resolveOptions(userOptions)`，再把每个特性的结果（`options.xxx`）喂给前置章的 `resolvePlugin(宏, framework, options.xxx)`；当某特性为 `false` 时该宏不被实例化、从管道中消失。源码位置: packages/macros/src/index.ts:57-110

## 关键调用链
loadConfig(cwd) 【读磁盘配置文件，双模异步】
  → resolveOptions(options, cwd) 【合并 磁盘←调用选项；补 root/version/isProduction 默认；探测 Vue 版本】
    → detectVueVersion(root) 【local-pkg 读 vue 包版本】
    → resolveSubOptions(name, 门槛) 【逐特性：算版本条件默认 → 用户值优先 → false 或合并 globalOptions】
  → OptionsResolved 【每特性: false | 带全局上下文的选项】
    → macros 装配管道: resolvePlugin(宏实例, framework, options.特性) 【===false 即跳过】
源码位置: packages/config/src/config.ts:5-23, packages/config/src/options.ts:228-296, packages/macros/src/index.ts:57-110

## 源码摘录（带行号，全文累计 ≤ 30 行）

特性解析核心（权衡1「版本当门槛」+ 权衡3「false 哨兵 + 全局合并」的落地）：
```ts
// packages/config/src/options.ts:283-296
  function resolveSubOptions<K extends FeatureName>(
    name: K,
    belowVersion: boolean | number = true,
  ): FeatureOptionsMap[K] | false {
    const defaultEnabled =
      typeof belowVersion === 'boolean' ? belowVersion : version! < belowVersion
    const options: OptionalSubOptions<FeatureOptionsMap[K]> =
      subOptions[name] ?? defaultEnabled
    if (!options) return false
    return {
      ...globalOptions,
      ...(options === true ? {} : options),
    }
  }
```

合并 + 全局量补默认（权衡2 的落地）：
```ts
// packages/config/src/options.ts:234-243
  let { isProduction, nuxtContext, plugins, root, version, ...subOptions } = {
    ...config,
    ...options,
  }
  root = root || cwd
  version = version || detectVueVersion(root)
  isProduction = isProduction ?? process.env.NODE_ENV === 'production'
  const globalOptions = { isProduction, root, version }
```

「版本条件默认」直接写进类型文档（权衡1 的可读证据）：
```ts
// packages/config/src/options.ts:119-123
   * @default vueVersion < 3.3
   */
  defineSlots: OptionsDefineSlots
```

## 易混淆 / 边界 / 推断
- **事实**：`true` 与空对象 `{}` 在「开启」语义上等价（都走 `options === true ? {} : options` 分支，最终都是「仅含全局量」），但 `false` 是唯一的关闭哨兵；`undefined` 不会出现在解析结果里（已被默认值 `??` 填补）。源码位置: packages/config/src/options.ts:289-295
- **事实**：版本门槛写在**调用处**的 `resolveSubOptions(name, 3.3)` 实参里，而非特性表接口本身；接口里的 `@default vueVersion < 3.3` 只是给文档/类型看的注释，真正的判定逻辑在调用实参。源码位置: packages/config/src/options.ts:257,262,278,279（实参）vs 96-98,119-123（注释）
- **事实**：`belowVersion` 形参默认值为 `true`，即「不传门槛 = 默认开」；这是大多数特性的情况，少数默认关的特性显式传 `false`（如几个 export-* 与实验性特性）。源码位置: packages/config/src/options.ts:252-280,285
- **推断（标注为推断）**：把默认门槛写成「调用实参」而非「特性表元数据」，是为了让「默认策略」与「特性清单」解耦——新增特性时只需在表里加类型、在调用处加一行带门槛的解析，无需维护一份独立的「默认值注册表」。这是从代码组织方式推断的意图，源码无显式注释说明。
- **推断（标注为推断）**：升级 Vue 导致某特性「静默关闭」是这套设计固有的副作用（如 3.3 后 emits 简写默认关），库似未提供「我为你关掉了 X」的运行时提示——这与「版本即默认来源」的设计是一体两面，属可接受的代价而非 bug。
- **未理解**：双模异步包装（quansync/macro）具体如何在编译期把一个 `async` 函数同时暴露出「可同步调用」的签名——这属于 quansync 库的转译机制，本章源码只见其用法（`quansync(async (...) => {...})` 与 `QuansyncFn<...>` 类型），未见其内部实现，故如实标注。源码位置: packages/config/src/options.ts:15,228-231