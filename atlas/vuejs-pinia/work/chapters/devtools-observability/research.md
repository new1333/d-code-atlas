# 开发者工具的可观测性接入 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个动作执行时常常会在内部连续改好几次状态，还会调用别的动作；开发者在调试器里看到的是一连串零散的"某字段变了"事件，根本拼不出"是哪个动作、第几步、带什么参数引发的"。没有一套外化的"事件流 + 归组"机制，状态管理的调试就只能靠 `console.log` 猜时序。

- **一句话核心思想**：**把已有的两条变更管道外化成时间线事件，再用一个 Proxy 在动作执行期间把"当前动作"刷写进一个隐式上下文变量，让被动触发的变更事件自动带上同一个分组标识。**

- **设计动机（为什么需要它）**：可观测性的本质矛盾是"想看清运行时行为，但又不能让观测机制污染核心代码、拖累生产"。Pinia 的解法是——不另起炉灶探测变更，而是把"插件扩展点"当成接入位、把"状态变更双管道"当成现成的事件源，整套观测层只在开发构建里装配。
  - **承前去重信号**：本章只看"观测层如何复用既有能力"，不复讲底层原理——
    - "以插件形式接入、随每个 store 组装时被调用"（已在第 9 章『插件扩展总线』讲透统一扩展点的注册/合并/作用域回收；本章只看 devtools 作为该扩展点的一个具体消费者，在每个 store 上订阅了什么、改写了什么）。
    - "复用状态变更双管道作为事件源 + 手动开关管控通知时机"（已在第 7 章『状态变更的双管道：动作拦截与批量合并』讲透动作包裹层的 before/after/onError 与 `$patch` 的监听开关；本章只看这两条管道的输出如何被外化成时间线事件，以及那个"监听开关"在此处以同构形态再次出现）。
    - "订阅随 store 存活"（detached，源自第 1 章『随作用域清理的发布订阅』；本章只复用其 detached 选项让 devtools 订阅不被组件卸载回收）。
  - 本章真正的新原理只有一个：**用 Proxy 把"当前正在执行哪个动作"这个隐式上下文，在每次状态读写时刷写一遍，从而让被动触发的变更订阅能自带分组标识、完成"变更→动作"的归组。**

- **关键权衡（2~4 条，三段式）**：
  1. **复用既有变更管道作为事件源，而非自建一套变更探测** → 换来了零侵入核心（观测层完全在核心之外订阅，核心无需为调试埋专用钩子）+ 观测到的就是生产行为本身 → 代价是事件粒度被既有管道的规则锁死（一次 `$patch` 只产一条事件、动作内的直接赋值各产一条），且订阅必须显式声明脱离作用域才能随 store 存活。
  2. **用 Proxy 包裹 store、在 get/set 陷阱里反复刷写"当前动作"指针来实现归组** → 换来了"无需用户改写动作调用约定，就能把动作执行期间被被动触发的多次变更、连同嵌套调用的内层动作，都正确归到当时正在执行的那一个动作上" → 代价是 (a) 这只对"经 `this` 访问状态"的 Options API 动作有效（Setup Store 的动作以闭包持有状态、不走 `this`，Proxy 拦截不到，只能退化为"进函数设、出函数清"的粗粒度）；(b) 对**异步动作** `await` 之后的变更，指针早已被清空，无法归组——源码注释明确指向"异步上下文提案"作为未来正解。
  3. **整套观测机制只存在于开发构建（一个构建期常量在生产为假，配合摇树把整块裁除）** → 换来了生产包零运行时开销、零额外体积 → 代价是生产环境彻底无可观测性（出问题只能靠日志），且开发期与生产行为存在细微差异（Proxy 包裹、detached 订阅只在 dev 存在）。
  4. （承前复用，非新权衡）从调试器直接改状态时，用"进入编辑关掉时间线、编辑完再开"避免观测回环——这与第 7 章 `$patch` 的监听开关同构，Writer 可一句带过，不必重讲。

- **最小心智模型（3～7 步）**：
  1. 容器创建时（仅开发构建 + 浏览器 + Proxy 可用）：把观测层挂上插件链，并在应用安装时注册全局的时间线层与检查器面板。
  2. 每个 store 组装完成、观测插件被调用：先把该 store 的每个动作改写一遍（为归组埋点），再把这个 store 登记进检查器树。
  3. 为该 store 订阅两条既有管道：动作生命周期订阅产出动作的"起/止/出错"事件；状态变更订阅产出每一次状态改动事件。两者都声明脱离作用域、且以同步节奏触发，保证时序对得上。
  4. 用户调用某动作：改写过的动作包裹层把"当前动作标识"写进一个模块级变量（Options API 下，还会让动作的 `this` 经过 Proxy，每次读写状态都把这个标识重新刷一遍）。
  5. 动作体内对状态的修改触发状态变更订阅，生成的事件带上"分组标识 = 当前动作标识"，于是被调试器归到该动作名下。
  6. 动作返回或出错：清空当前动作标识，动作订阅补一条结束事件，闭合这一组。
  7. 用户从调试器面板直接编辑状态：进入编辑前关掉时间线开关、编辑完再开，避免编辑本身被记成新事件。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个**小到只演"归组"**的从零实现——一个模块级"当前动作标识"变量；一个假 store（state + 两个动作，其中一个会调用另一个，演示嵌套）；一个把每个动作改写成"设标识→用 Proxy 包 `this`（get/set 重刷标识）→跑原动作→清标识"的函数；一个假的状态变更订阅（每次 state 被 set 就推一条带分组标识的事件）。要能跑出："一个动作改两次状态 → 两条变更事件同组"、"内层动作期间 → 归到内层、内层返回后外层继续改 → 再次归到外层（Proxy 重刷的威力）"、"裸改状态（不经动作）→ 分组标识为空，落单"。**这段演示演的就是权衡 2**：Proxy 的 get/set 重刷让嵌套/链式调用不会让指针被内层清空而错乱。
  - **应故意省略**：真实的 Vue DevTools API、检查器树与面板的格式适配、复制/粘贴/导出/导入状态等 UX 动作、HMR 包裹、组件检查对接、`isTimelineActive` 回环开关（作为脚注提一句即可）、可写计算属性的可编辑判定、自定义属性的 deep watch。**不追求工程完整，只追求演透"归组"。**
  - **演示载体建议**：**首选 TS/JS**。理由：本章核心机制（Proxy 陷阱 + 一个隐式上下文变量 + 订阅事件收集）是纯语言级逻辑，**不依赖 Vue 运行时的响应式语义**——store 在演示里就是一个普通对象、订阅就是 set 拦截后的回调，TS/JS 完全能忠实演透，且本 Atlas 产物本身是 JS 生态的 VitePress 站，读者 `node`/`bun` 一行就能跑。**无需退回原仓库主语言**（本就是 TS）。配一个最小 `package.json` 使其能直接跑即可。

- **正文不宜展开的细节**：
  - 检查器树/状态的格式适配（把内部形状翻译成 DevTools 面板期望的节点/字段结构、`_custom.display` 的用法）——属适配胶水，点到"有一层适配器把 Pinia 形状翻成 DevTools 形状"即可。
  - 面板上的全局动作（序列化复制 / 粘贴替换 / 存 JSON / 读 JSON）、节点动作（对该 store 调 `$reset`）、各类 `toast` 提示——DevTools UX 胶水，不展开。
  - 与组件调试器的对接（组件实例上挂的 store 集合、Options vs Setup 在面板里的展平差异、组件状态编辑路径改写）——属另一条对接线，不展开。
  - 自定义属性的深度监听、热更新时补一条事件并刷新面板、store dispose 时刷新面板——都是边缘钩子，列举即可。

- **推荐的一个执行轨迹例子**：
  - **输入**：某 store 有动作 `incrementTwice`（连续把计数加两次），开发者调用 `store.incrementTwice()`。
  - **关键中间态**：动作订阅先记一条"🛫 start"（分组标识=1）；动作体里两次 `this.count++` 各触发一次状态变更订阅，记两条变更事件（**均分组标识=1**）；动作返回，清空当前动作标识，动作订阅补一条"🛬 end"（分组标识=1）。
  - **输出**：调试器时间线把"1 条 start + 2 条变更 + 1 条 end"折叠成一组；而若直接 `store.count++`（不经动作），只会产生一条**分组标识为空**的散落变更事件，不被归入任何动作。

## 概念要点

- **两个入口、两层职责**：一个在应用安装时注册全局面板（时间线层、检查器、组件检查钩子、状态编辑钩子、全局 `$pinia`/`$store` 暴露）；另一个是 per-store 的 Pinia 插件，对每个 store 做动作改写 + 订阅接入。源码位置: packages/pinia/src/devtools/plugin.ts:62, plugin.ts:570-609, plugin.ts:313-512
- **per-store 插件做的事（顺序）**：判定 Options/Setup → 改写所有动作（归组埋点）→ 包装热更新（让新动作也归组）→ 把 store 登记进面板（挂动作订阅、状态订阅、自定义属性监听、热更新事件、dispose 回调）。源码位置: packages/pinia/src/devtools/plugin.ts:582-608, plugin.ts:313-511
- **复用动作生命周期订阅（detached）**：订阅动作的 before/after/onError，产出"🛫 start / 🛬 end / 💥 error"三类时间线事件，三者共用同一个 `groupId = runningActionId++`。第二参 `true` 表示脱离作用域、随 store 存活。源码位置: packages/pinia/src/devtools/plugin.ts:344-400
- **复用状态变更订阅（detached + sync）**：每次 `$state` 变更产一条时间线事件，按变更类型（直接赋值 / `$patch` 函数 / `$patch` 对象）给出标题与副标题 emoji，并附带原始调试事件。`flush: 'sync'` 保证事件在变更当下同步触发，使归组时序成立。源码位置: packages/pinia/src/devtools/plugin.ts:428-471
- **【本章核心】隐式当前动作指针 + Proxy 归组**：模块级 `activeAction` 变量持有"当前动作 id"；改写后的动作在调用时设值、返回后清空；Options API 下额外用 Proxy 包 `this`，每次 get/set 都把 `activeAction` 重刷为当前动作 id，使嵌套/链式调用在内层动作返回后、外层继续访问状态时能**重新夺回**指针。状态订阅生成的事件直接带 `groupId: activeAction`，于是被动触发的变更自动归到当时正在跑的动作。源码位置: packages/pinia/src/devtools/plugin.ts:514-515, plugin.ts:525-565, plugin.ts:436-444
- **Proxy 只对 Options API 启用**：`wrapWithProxy = store._isOptionsAPI`。注释明示 Setup Store 需要异步上下文提案才能真正解决——反推 Setup 动作以闭包持有状态、不经 `this`，Proxy on `this` 拦截不到，故只享受"进设出清"的粗粒度。源码位置: packages/pinia/src/devtools/plugin.ts:589, plugin.ts:541-552, plugin.ts:554-561
- **异步动作的已知局限**：动作包裹层在 `.apply()` 返回后立即清空 `activeAction`；对异步动作而言，`await` 之后的变更发生时指针已是空，故无法归组。注释自述这是"宁可不归组也不误归组"的保守选择。源码位置: packages/pinia/src/devtools/plugin.ts:558-559
- **回环防护（承前模式复用）**：当用户从检查器/组件面板直接改状态，先 `isTimelineActive = false` 再执行编辑、之后恢复 `true`；状态订阅回调里见 `!isTimelineActive` 即 `return`，跳过本次事件。与第 7 章 `$patch` 的监听开关同构。源码位置: packages/pinia/src/devtools/plugin.ts:29, plugin.ts:279-281, plugin.ts:304-306, plugin.ts:433
- **热更新 / dispose 的边缘钩子**：包装热更新以对新动作再做归组改写、并补一条"🔥 HMR update"事件、刷新面板；包装 `$dispose` 以在销毁后刷新面板并按设置 toast。源码位置: packages/pinia/src/devtools/plugin.ts:473-492, plugin.ts:593-601, plugin.ts:494-502
- **@pinia/testing 互斥**：若容器带 `_testing` 标志（测试替身已 mock 动作），则跳过动作改写，避免覆盖 mock。源码位置: packages/pinia/src/devtools/plugin.ts:585-590
- **门禁：仅开发构建 + 客户端 + Proxy 可用**：观测插件只在 `__USE_DEVTOOLS__ && IS_CLIENT && typeof Proxy !== 'undefined'` 时被 `pinia.use` 挂载；`__USE_DEVTOOLS__` 是构建期常量，生产构建（`esm-browser.prod` / `iife.prod`）直接定义为 `false`，整块被摇树裁除。源码位置: packages/pinia/src/createPinia.ts:56-60, packages/pinia/src/createPinia.ts:31-33, packages/pinia/tsdown.config.ts:26, tsdown.config.ts:60-63, tsdown.config.ts:96-99
- **适配层职责（formatting）**：把 Pinia 内部形状翻译为 DevTools 期望形状——检查器树（根节点 + 每个 store 一节点）、检查器状态（根视图列所有 store 的 state/getters；单 store 视图列 state/getters/customProperties）、变更事件展平（数组型 `$patch` 事件聚合为 keys/operations/oldValue/newValue；单事件给 operation/key/old/new）、变更类型枚举映射为人类可读标题。源码位置: packages/pinia/src/devtools/formatting.ts:97-109, formatting.ts:111-171, formatting.ts:173-202, formatting.ts:204-215
- **工具层职责（utils）**：`toastMessage`（带 🍍 前缀的 console 输出，按类型选 error/warn/debug）；`isPinia`（鸭型判定 `'_a' in o && 'install' in o`，用于区分根容器与单 store）；`isWritableComputed`（用 `toRaw` 取原值后判定 `isRef && !isReadonly`，决定 getter 在面板里是否可编辑）。源码位置: packages/pinia/src/devtools/utils.ts:11-24, utils.ts:26-28, utils.ts:34-37

## 关键调用链

**装配链（开发构建）**：
createPinia →（满足门禁）`pinia.use(devtoolsPlugin)` → 应用 install 时 `registerPiniaDevtools`（注册时间线层 `pinia:mutations`、检查器 `pinia`、组件/检查器各类事件钩子、全局动作）→ 每个 store 组装完成触发 `devtoolsPlugin({app,store,options})` → `patchActionForGrouping`（Proxy 改写动作）+ `addStoreToDevtools`（挂 `$onAction` / `$subscribe` / 自定义属性 watch / 热更新 / dispose 包装）。
源码位置: packages/pinia/src/createPinia.ts:58-60, packages/pinia/src/devtools/plugin.ts:62-311, plugin.ts:570-609, plugin.ts:313-512

**归组时序链（用户调用动作）**：
动作订阅 before 钩子 `runningActionId++`（分配本次 groupId）→ 改写后的动作包裹层执行：`_actionId = runningActionId` → `activeAction = _actionId`（Options API 下 Proxy 在每次 get/set 重刷 `activeAction`）→ 原动作体 `.apply(trackedStore)` 执行、期间对状态的修改**同步**触发 `$subscribe` → 变更事件带 `groupId: activeAction` 进时间线 → 动作体返回 → `activeAction = undefined` → after/onError 钩子补结束事件。
源码位置: packages/pinia/src/devtools/plugin.ts:344-360, plugin.ts:538-561, plugin.ts:428-468

## 源码摘录（带行号，全文累计 ≤ 30 行）

**摘录 A｜归组核心：Proxy 包 `this` 反复刷写当前动作指针 + 进设出清**（演权衡 2，本章灵魂）
```ts
// plugin.ts:541-559
      const trackedStore = wrapWithProxy
        ? new Proxy(store, {
            get(...args) {
              activeAction = _actionId
              return Reflect.get(...args)
            },
            set(...args) {
              activeAction = _actionId
              return Reflect.set(...args)
            },
          })
        : store
      activeAction = _actionId
      const retValue = actions[actionName].apply(
        trackedStore,
        arguments as unknown as any[]
      )
      // this is safer as async actions in Setup Stores would associate mutations done outside of the action
      activeAction = undefined
```

**摘录 B｜状态变更事件携带分组标识 = 当前动作指针**（演"被动订阅如何被归组"）
```ts
// plugin.ts:436-444
          const eventData: TimelineEvent = {
            time: now(),
            title: formatMutationType(type),
            data: assign(
              { store: formatDisplay(store.$id) },
              formatEventData(events)
            ),
            groupId: activeAction,
          }
```

## 易混淆 / 边界 / 推断

- **事实**：动作订阅与状态订阅都传了 `detached: true`（动作订阅是 `$onAction(cb, true)`，状态订阅是 `$subscribe(cb, { detached: true, flush: 'sync' })`），让两条订阅脱离调用方作用域、随 store 存活——这是对第 1 章 detached 选项的直接复用。源码位置: packages/pinia/src/devtools/plugin.ts:400, plugin.ts:470
- **事实**：`flush: 'sync'` 是归组成立的隐藏前提——若状态订阅异步触发，`activeAction` 在事件生成时可能已被清空，归组就会失败。源码位置: packages/pinia/src/devtools/plugin.ts:470
- **事实**：`_actionId = runningActionId` 与 `$onAction` before 钩子里的 `runningActionId++` 配合——before 钩子先于动作体执行、先自增，故动作包裹层取到的 `runningActionId` 恰为本次 groupId，两者一致。源码位置: packages/pinia/src/devtools/plugin.ts:345, plugin.ts:540
- **推断**：Proxy 仅对 Options API 启用，根因是 Setup Store 的动作以闭包持有 state（如 `() => { count.value++ }`），不经 `this` 访问状态，故 Proxy 套在 `this` 上拦不到——由源码注释"For Setup Stores we need https://github.com/tc39/proposal-async-context"反推。源码位置: packages/pinia/src/devtools/plugin.ts:554, plugin.ts:589
- **推断**：动作返回后**立即**清空 `activeAction` 是"宁可不归组、也不误归组"的保守取舍——对异步动作，`await` 之后的变更会落入未分组（groupId 为 undefined），这是被接受的代价。源码位置: packages/pinia/src/devtools/plugin.ts:558-559
- **推断**：`isTimelineActive` 为模块级单例，未针对多 Pinia 实例做隔离；若同页同时存在多个活跃 Pinia（非常规场景），从面板编辑其一可能影响其它的回环防护。源码未做隔离处理，推断为已知局限。源码位置: packages/pinia/src/devtools/plugin.ts:29
- **未理解**：暂无阻断性未理解项。