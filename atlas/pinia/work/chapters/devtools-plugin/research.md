# DevTools 集成：作为 Pinia 插件的可观测层 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：调试一个 store 时，你既看不到「状态是在哪一刻、被谁改的」，也看不出「这一次动作调用」和「随后那一串状态变化」之间到底有没有因果关系——动作流和状态流是两条对不上的线；而一旦上了生产，你又不想让这整套调试设施拖大你的包体、拖慢运行时。

- **一句话核心思想**：DevTools 也是一个插件——它不侵入核心，而是复用核心对外的两个订阅频道去「旁观」状态与动作，再用一层动作代理把原本散落的状态变更重新「缝合」归因到引发它们的那个动作。

- **设计动机（为什么需要它）**：核心追求「最小可用、可 tree-shake」，因此绝不愿把可观测代码焊死进核心。于是把整套调试设施做成一个与用户自写插件无特权的普通插件，挂进同一条装配通路。**承前**：核心早已在订阅系统章建立了「状态变更订阅」与「动作调用包裹」两个对外频道——本章是这两个频道的**消费者**，不重讲频道本身；状态变更模型章建立的「打补丁期间暂停监听、事后再恢复」的协调思想，在本章以「编辑期间暂停时间线录制」的形式再次出现（已在第 6 章『订阅系统』与第 5 章『状态变更模型』讲透该协调族，本章只看它在可观测侧的镜像）；本章真正的新侧面是——把两条**独立**的流重新缝合出「动作→变更」的因果关系，以及整套可观测层借一个编译期开关被整体剔除。

- **关键权衡（本 Atlas 的核心）**：
  1. **DevTools 即插件，而非核心内置**：选择把整套可观测层做成一个普通插件、走与用户插件同一条装配通路 → 换来核心与可观测彻底解耦（核心零侵入）+ 生产期可整体 tree-shake → 代价是它想感知状态与动作时不能直捣核心内部，只能复用核心对外的订阅频道，表达力受限于频道能提供什么。
  2. **用代理包裹动作以重建「动作→变更」因果**：选择在每个动作外层套一层代理（进入时打一个「当前动作」标记）→ 换来时间线里能把一次动作引发的所有状态变更归因、折叠到同一组 → 代价是对动作做了侵入式代理包裹（须绕开响应式追踪的副作用），且对 setup store 的**异步动作**（await 之后的变更）归因不精确——标记在动作同步返回时就被清空，跨不过 await。
  3. **编辑状态时暂停时间线录制以防自激**：选择在面板编辑状态期间用一个录制开关关掉、事后再恢复 → 换来「用户手动改状态」不会被记成一条新的变更事件（避免回环噪音）→ 代价是每条编辑入口前后都要成对维护这个开关，且要接受「编辑期间的订阅通知被静默丢弃」这一约定。
  4. **编译期开关换取生产期整体剔除**：选择用一个编译期常量门控整段注册 → 换来生产包里完全不包含这套代码（零体积、零运行时开销）→ 代价是要在构建配置里维护该常量的多份目标取值，并在源码各处成对写守卫判断，增加条件分支的维护成本。

- **最小心智模型（3～7 步）**：
  1. 应用安装 Pinia 时**还没有任何 store**，但 DevTools 面板需要先存在 → 所以分两段注册：安装时先建好「时间线层 + 检视器」的空壳，等每个 store 出生时再挂监听。
  2. DevTools 作为一个普通插件排在「插件队列」里，和用户自写插件走同一条装配通路 → 它能自动拿到每一个新生的 store。
  3. 拿到 store 后**不自己去轮询状态**，而是订阅核心已有的「状态变更」与「动作调用」两个频道，把核心事件翻译成时间线事件。
  4. 但这两条是独立流，DevTools 想把它们归到一组（「这次状态变化是这个动作引起的」）→ 给每个动作套一层代理，进入时打「当前动作」标记，状态变更事件带上这个标记当分组号。
  5. 用户在面板里直接改状态时，这次修改也会流经状态订阅频道 → 若不处理会自我触发一条假的「变更」事件 → 改之前关掉录制、改完再开。
  6. 生产环境根本不需要这套东西 → 用一个编译期常量把整段注册代码变成死代码，让打包器整体剔除。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只演透两条核心权衡**的从零实现（几十行）——(a) 动作代理重建因果、(b) 录制开关防自激。建一个只有 `state` + 两个订阅频道（「状态变更」「动作调用」）的最小 store：给动作套代理，进入时设 `activeActionId`，状态变更事件带 `groupId = activeActionId` → 演因果归因；再提供一个「外部编辑 state」入口，编辑时置 `recording = false`、编辑后恢复 → 演防自激。**每一行都要对应上面权衡 2 / 权衡 3**。
  - 应故意省略：真实的 Vue 响应式、真实的 devtools-api 宿主对接、检视器 UI、复制/粘贴/导入导出、编译期开关的构建配置、HMR 包裹——这些都不服务于「演透原理」。
  - **演示载体建议**：本章机制依赖 Vue DevTools 宿主（`setupDevtoolsPlugin`），强求真跑扩展不现实。建议写成一段**能 `node`/`bun` 直接跑的独立 TS 脚本**，模拟宿主交互：用普通对象 + 手动触发回调假扮「状态订阅频道」和「动作包裹频道」，重点演「代理如何把两条流的 eventId 缝合成同一 groupId」与「开关如何吞掉自激事件」。载体服务于演透原理，不是服务于能接真宿主。

- **正文不宜展开的细节**：检视器状态格式化（`_custom` 包装、getters/customProperties 分组显示）、组件检视器里 option store 与 setup store 的 state 展开差异、file-saver 的跨浏览器下载降级链、复制/粘贴的剪贴板权限与「页面未聚焦」错误处理、store 内部字段设为 non-enumerable 以避免在检视器里冒充 state、`globalThis.$pinia`/`$store` 调试出口——这些供 Writer 裁剪或放注释，不占正文原理篇幅。

- **推荐的一个执行轨迹例子**：输入——组件里调用 `store.increment()`，动作体内改 `count`。关键中间态——动作代理进入，设 `activeActionId = 5`；动作体改 `count`；状态订阅频道触发，事件带 `groupId = 5`；动作同步返回，`activeActionId` 清空。输出——DevTools 时间线上「increment 起飞」与「count 变更」两条事件被同一 `groupId = 5` 归到一组，可折叠查看其因果关系。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- **DevTools 即一个标准 Pinia 插件**：`devtoolsPlugin` 是收 `{ app, store, options }` 上下文的普通插件函数，在 `createPinia()` 里经 `pinia.use(devtoolsPlugin)` 入队，与用户插件无特权区别。源码位置: packages/pinia/src/devtools/plugin.ts:570-575, packages/pinia/src/createPinia.ts:58-60
- **两层注册（全局层 + per-store 层）**：全局层 `registerPiniaDevtools(app, pinia)` 在 `install()` 时调用，负责在「还没有任何 store」时就建好时间线层、检视器、全局动作与检视器事件回调——让 Pinia 面板一安装就可见；per-store 层 `addStoreToDevtools(app, store)` 在每个 store 装配、跑插件时调用，负责挂监听。源码位置: packages/pinia/src/createPinia.ts:31-33, packages/pinia/src/devtools/plugin.ts:62, 313, packages/pinia/src/store.ts:717
- **复用核心已有订阅频道，不自造监听**：per-store 层不去轮询状态，而是订阅核心对外的 `$onAction`（detached）与 `$subscribe`（detached + flush:sync），把核心事件翻译成时间线事件。源码位置: packages/pinia/src/devtools/plugin.ts:344-400, 428-471
- **动作→变更因果重建靠代理**：`patchActionForGrouping` 给每个 action 套壳，进入时令 `activeAction = runningActionId`；状态变更事件与自定义属性变更事件都带 `groupId: activeAction`，从而把一次动作引发的所有事件归到同一组。源码位置: packages/pinia/src/devtools/plugin.ts:525-565, 419, 443, 514-515
- **option store 用代理、setup store 不用**：是否套 `new Proxy` 由 `store._isOptionsAPI` 决定；注释指出 setup store 要等 tc39 async-context 提案才能精确归因。源码位置: packages/pinia/src/devtools/plugin.ts:541-552, 554, 589
- **setup store 异步动作归因失效**：动作同步返回后立即 `activeAction = undefined`，故 `await` 之后的 state 变更无法再归因到该动作（注释明确这是「更安全」的取舍）。源码位置: packages/pinia/src/devtools/plugin.ts:560-562
- **录制开关防自激**：检视器/组件状态编辑入口在 `payload.set`（会触发 `$subscribe`）前后成对置 `isTimelineActive` 为 false/true；订阅回调里 `if (!isTimelineActive) return` 吞掉自激事件。源码位置: packages/pinia/src/devtools/plugin.ts:279-281, 304-306, 433
- **`__USE_DEVTOOLS__` 编译期开关**：声明为编译期常量，由构建配置定义为 `((__DEV__ || __VUE_PROD_DEVTOOLS__) && !__TEST__)`，prod 默认为 false；多处 `__USE_DEVTOOLS__ && IS_CLIENT` 守卫使整段注册在 prod 成为死代码被剔除。源码位置: packages/pinia/src/global.d.ts:4, packages/pinia/tsdown.config.ts:24, 43, 60, 80, 96, packages/pinia/src/createPinia.ts:31, 58
- **全局 state 操作直捣单一根状态**：复制/粘贴/保存/导入直接读写 `pinia.state.value`；回填时已实例化的 store 用 `Object.assign` 打补丁，未实例化的直接设到根状态上（等其创建时水合）。源码位置: packages/pinia/src/devtools/actions.ts:35, 47-50, 62-69, 122-133
- **检视器编辑的 path 重写**：编辑普通属性时把 `$state` 前置到路径；唯有插件自定义属性或可写 computed 才允许直接设到 store 上（借 `_customProperties` 与 `isWritableComputed` 判定）。源码位置: packages/pinia/src/devtools/plugin.ts:262-278, packages/pinia/src/devtools/utils.ts:34-37
- **store 内部字段对检视器隐藏**：在 devtools 开关下，把 `_p/_hmrPayload/_getters/_customProperties` 定义为 non-enumerable，避免它们在检视器里被当成普通 state 列出。源码位置: packages/pinia/src/store.ts:696-713
- **`_isOptionsAPI` 是 devtools 专属字段**：由 `devtoolsPlugin` 写入（`!!options.state`），核心 `store.ts` 中不存在该字段——印证「DevTools 即插件、核心零侵入」。源码位置: packages/pinia/src/devtools/plugin.ts:582
- **HMR 与 @pinia/testing 的边界处理**：`__hot:` 前缀的临时 store 跳过 devtools 注册；`_testing` 标志下跳过对动作的代理重裹（避免覆盖测试桩）；热更新后还会对新动作重新做代理包裹。源码位置: packages/pinia/src/devtools/plugin.ts:577, 585-601
- **window 调试出口**：检视器打开时把 pinia 实例与当前选中 store 暴露到 `globalThis.$pinia`/`$store`，便于控制台调试。源码位置: packages/pinia/src/devtools/plugin.ts:227, 243-245

## 关键调用链
createPinia() → pinia.use(devtoolsPlugin) [入队 toBeInstalled]
app.use(pinia) → install() → registerPiniaDevtools(app, pinia) [建时间线层 + 检视器 + 全局动作 + 检视器事件回调] + toBeInstalled 灌进 _p
首次 useStore() → createSetupStore → pinia._p.forEach(extender => extender({store, app, pinia, options})) [store.ts:717] → devtoolsPlugin({app, store, options}) → patchActionForGrouping(store) + addStoreToDevtools(app, store)
addStoreToDevtools → 包裹 store.$onAction / $subscribe / _hotUpdate / $dispose → 每次 action/state 变化 → api.addTimelineEvent(layerId: 'pinia:mutations')
源码位置: packages/pinia/src/createPinia.ts:23-60, packages/pinia/src/store.ts:716-732, packages/pinia/src/devtools/plugin.ts:313-511

## 源码摘录（带行号，全文累计 ≤ 30 行）

注册入口——一个普通插件 + 编译期门控（演权衡 1、4）：
```ts
// createPinia.ts:58-60
if (__USE_DEVTOOLS__ && IS_CLIENT && typeof Proxy !== 'undefined') {
  pinia.use(devtoolsPlugin) // 与用户插件走同一队列，无特权
}
```

devtoolsPlugin 主体——标准插件 context 函数（演权衡 1）：
```ts
// plugin.ts:570-609（裁剪）
export function devtoolsPlugin({ app, store, options }: PiniaPluginContext) {
  if (store.$id.startsWith('__hot:')) return
  store._isOptionsAPI = !!options.state
  patchActionForGrouping(store, Object.keys(options.actions), store._isOptionsAPI)
  addStoreToDevtools(app, store) // 内部包裹 $onAction/$subscribe/_hotUpdate/$dispose
}
```

动作代理重建因果——进入时打标记、事件带分组号（演权衡 2）：
```ts
// plugin.ts:537-563（裁剪）
store[actionName] = function () {
  const _actionId = runningActionId
  const trackedStore = wrapWithProxy
    ? new Proxy(store, {
        get(...a) { activeAction = _actionId; return Reflect.get(...a) },
        set(...a) { activeAction = _actionId; return Reflect.set(...a) },
      })
    : store
  activeAction = _actionId
  const ret = actions[actionName].apply(trackedStore, arguments as any)
  activeAction = undefined // await 之后的变更无法再归因
  return ret
}
```

录制开关防自激——编辑前后成对切换（演权衡 3）：
```ts
// plugin.ts:279-281（编辑入口）
isTimelineActive = false
payload.set(inspectedStore, path, payload.state.value) // 会触发 $subscribe
isTimelineActive = true
// plugin.ts:433（订阅回调内）：if (!isTimelineActive) return
```

## 易混淆 / 边界 / 推断
- **事实**：option store（`_isOptionsAPI=true`）才用 `new Proxy` 包动作，setup store 直接用原 store 作 `this`。源码位置: packages/pinia/src/devtools/plugin.ts:541-552, 589
- **推断**：option store 的 action 通过 `this` 访问其它属性/方法，Proxy 能在每次属性访问时刷新 `activeAction`，故代理对其有意义；setup store 的 action 是闭包、不经 `this`，Proxy 拦不到内部访问，故不套（标注为推断，源码仅有「需要 async-context 提案」的注释佐证）。源码位置: packages/pinia/src/devtools/plugin.ts:554
- **事实**：`@pinia/testing` 桩化的动作不会被代理重裹（`store._p._testing` 守卫）；HMR 后会对新动作重新代理包裹。源码位置: packages/pinia/src/devtools/plugin.ts:585-601
- **事实**：`$subscribe` 用 `{ detached: true, flush: 'sync' }` 订阅——detached 使其不随当前作用域回收（store 长生命周期），flush:sync 使变更事件即时上时间线。源码位置: packages/pinia/src/devtools/plugin.ts:470
- **事实**：检视器对 option store 与 setup store 的 state 展示方式不同——option store 用 `_custom` 包装并附「重置」动作，setup store 手动逐 key 解包以规避迁移 ref 的展开问题。源码位置: packages/pinia/src/devtools/plugin.ts:165-182
- **事实**：`file-saver.ts` 是第三方 FileSaver.js 的内联 ESM 改写（头注释署名 Eli Grey / Eduardo San Martin Morote，MIT），非 Pinia 原创逻辑；非客户端环境下 `saveAs` 退化为 noop。源码位置: packages/pinia/src/devtools/file-saver.ts:1-8, 110-111
- **未理解**：`componentStateTypes` 数组被传入 `setupDevtoolsPlugin` 的 `componentStateTypes` 字段，用于在「组件检视器」里登记 store 状态类型；它在 `addStoreToDevtools` 时 push 新 store 类型（plugin.ts:314-316），与 `inspectComponent` 回调（plugin.ts:150-203）读取 `_pStores` 的协同细节未深究，存疑供 Architect/Critic 复核。