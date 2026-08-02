# Vue DevTools 集成：时间线与 store 检查器 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：状态库装好后，"为什么这个值变了"几乎是个黑盒——你看不到是哪个 action 改了 state，更分不清一次 action 调用里它触发了多少次零散变更；想手动改个值做调试、想导出整份状态做回归对照、想看新注册了哪些 store……统统没地方下手。devtools 集成要解决的就是"让状态库从黑盒变成可观测、可操作的开发期面板"。

- **一句话核心思想**：把状态库当成一个可观测系统，把已有的"订阅原语"翻译成时间线事件，再用一个模块级全局 running id 把"一次 action 调用"和它内部产生的所有零散 mutation 串成同一组。

- **设计动机（为什么需要它）**：状态库天然有三个观测点——action 进入/离开、state mutation、自定义属性变更。把这些观测点接到 Vue DevTools 提供的插件 API 上，就能获得现成的时间线、检查器、编辑能力，而不必自造一套 UI。同时让整套能力作为"一个特殊的 Pinia 插件"挂上去，生产构建里这一整段代码可以被常量折叠直接 tree-shake 掉，零运行时成本。

- **关键权衡（核心）**：
  - **devtools 实现为插件而非内建代码路径 → 换来生产期可整段 tree-shake（编译期常量 `__USE_DEVTOOLS__` 为 false 时整段消失）→ 代价是 action 与 mutation 的"分组关联"必须用一个 Proxy 拦截 store 的读写来兜底，且 setup store 的异步 action（await 之后的 mutation）因为 JS 没有 async context 仍然无法可靠关联**。
  - **用模块级全局变量 `activeAction`（running id）关联 action 与 mutation → 换来极简实现（不修改订阅/action 的签名）→ 代价是严格的同步原语顺序：wrapper 先 set id → 同步执行 action → action 内每次 get/set 经 Proxy 把 id 重置 → mutation 触发订阅回调时读到 id 给事件打 groupId → action 返回后立即清空；任何 await 之后的 mutation 都丢关联**。
  - **应用级与 store 级两个入口分工（一次性注册 vs 每 store 挂载）→ 换来 timeline 层/inspector 在 app.use 时就显示出来（即使还没建任何 store），而每个 store 的订阅只在它出生时才接 → 代价是同一个 setupDevtoolsPlugin 被调用 N+1 次，靠模块级 `componentStateTypes` 数组在多次调用间共享状态**。
  - **inspector 编辑路径的前置改写（按 path 判断是 state 子字段、自定义属性还是 writable computed，决定前置 '$state' 或 'state'）→ 换来 devtools 编辑器一套 path 同时覆盖根 pinia 与单 store 两种语义 → 代价是用户在面板里编辑会触发反向 mutation，必须用一个 `isTimelineActive` 标志临时关闭时间线再恢复，否则会自己给自己产生噪音事件**。

- **最小心智模型（3～7 步）**：
  1. 创建 Pinia 实例时，若开了 devtools 标记，把"devtools 插件"先放进待安装队列；此时还没有 app，无法真正注册。
  2. app.use(pinia) 触发 install：先调一次"应用级注册"——创建 mutations timeline 层、创建 pinia inspector、注册全局 copy/paste/save/import 动作；然后把待安装队列里的插件（含 devtools 插件）真正塞进插件表。
  3. 之后每创建一个 store，在插件应用阶段都会跑一次 devtools 插件：判定是 options API 还是 setup（决定是否用 Proxy 兜底）、把每个 action 包成"set id → 跑原 action → 清 id"的 wrapper、再调一次 store 级挂载。
  4. store 级挂载里：用订阅原语挂上 action 拦截（detached，跨 scope 存活）、mutation 订阅（detached + sync flush）、对每个自定义属性起一个 deep watch。
  5. 用户调 action foo()：wrapper 把 running id++、active id 设上 → 同步执行原 action（每次 get/set 经 Proxy 把 active id 刷新到当前 id）→ mutation 触发订阅回调，事件 groupId 取自 active id → action 返回/抛错时清空 active id 并发 end/error 事件，与 start 事件共享同一个 groupId。
  6. 用户在 inspector 选中某 store：getInspectorState 回调把 $state + getters + 自定义属性拼成 devtools 能展示的数据结构；同时把该 store 暴露到 window 方便控制台调试。
  7. 用户编辑某字段：editInspectorState 改写 path（前置 '$state'/'state'）、临时关 isTimelineActive、调 payload.set 触发响应式更新、再恢复 isTimelineActive；这样面板编辑不会反向污染时间线。

- **最小原理演示**：
  - **应演示**：一段 ~60 行的脚本，演"Proxy + 模块级 running id + 严格同步顺序"这一核心机制。具体：用 Vue 的 reactive 创建一个 store 对象、用一个数组模拟 timeline events、用一个订阅函数监听 store 变更 push 事件（带 groupId）；然后定义 wrapAction(store, name) 把每个 action 替换成「set runningId → 用 Proxy(store) 跑原 action → clear runningId」；最后写一个 action `incTwice` 内部改两次 state，调它，看 timeline 里出现两条 change 事件共享同一个 groupId。这段演示直接演「为什么必须用 Proxy 兜底」+「为什么 await 之后丢关联」。
  - **应故意省略**：真正的 setupDevtoolsPlugin 调用、inspector 渲染细节、文件导入导出、HMR 接管、customProperties watch、错误提示 toast、根 pinia 节点 vs 单 store 的格式分支。
  - **演示载体建议**：本仓库主语言是 TS，建议写一段能 `node demo.mjs` 或 `bun run` 直接跑的纯 JS（最小依赖 vue 的 reactive/effect 即可，甚至可以手写一个最简 publish/subscribe 替代 vue 来突出"机制 vs 框架"的边界）。重点是演透"Proxy + 全局变量 + 同步原语顺序"这个机制本身，不追求接通真正的 Vue DevTools。

- **正文不宜展开的细节**：文件导入导出（saveAs / 隐藏的 `<input type=file>`）的浏览器兼容细节、clipboard API 的 "Document is not focused" 处理、CustomInspectorState / CustomState 等 devtools-api 的 TS 类型枚举、`declare global` 把 $pinia/$store 暴露到 window 的类型 hack、toastMessage 的不同 logType 颜色、nodeActions 在根 pinia vs 单 store 的不同（根没有 reset）。

- **推荐的一个执行轨迹例子**：输入 = 用户在 devtools 面板把 count: 1 改成 5 → 关键中间态 = editInspectorState 回调被调，path 改写为 ['$state', 'count']、isTimelineActive 临时置 false、payload.set 触发响应式写入、$subscribe 回调被触发但因 isTimelineActive=false 跳过时间线事件、isTimelineActive 恢复 true、sendInspectorState 刷新右侧面板 → 输出 = store.count===5，timeline 没新事件，inspector 显示新值。这条轨迹演的是「编辑面板与时间线互不打架」那条权衡。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **两条接入路径**：(1) `registerPiniaDevtools(app, pinia)` 在 app.use 时跑一次，建立全局 timeline 层 + inspector，不依赖任何 store；(2) `devtoolsPlugin({app, store, options})` 是一个标准的 Pinia 插件，每创建一个 store 跑一次，负责该 store 的订阅与生命周期挂钩。两者都被 `__USE_DEVTOOLS__ && IS_CLIENT` 守卫，devtools 插件额外要求 `typeof Proxy !== 'undefined'`。
  源码位置: packages/pinia/src/createPinia.ts:31-33, 58-60; packages/pinia/src/devtools/plugin.ts:62, 570-609

- **插件挂载时机**：`pinia.use(devtoolsPlugin)` 在 createPinia 末尾调用，但此时 `_a` 还是 null，于是被推进 `toBeInstalled` 队列；等到 install hook 跑 `toBeInstalled.forEach(p => _p.push(p))` 时才真正进入 `_p`。这跟普通插件走同一条路径，没有特殊待遇。
  源码位置: packages/pinia/src/createPinia.ts:38-45, 56-60

- **应用级注册（registerPiniaDevtools）做了什么**：用 `setupDevtoolsPlugin` 注册一个 'dev.esm.pinia' 插件；创建 timeline 层 `pinia:mutations`（color: 0xe5df88）；创建 inspector 'pinia'，挂 4 个全局 actions（复制/粘贴/保存/导入 state）和 1 个 nodeAction（per-store reset）；监听 inspectComponent（把组件实例上的 `_pStores` 暴露到组件状态面板）、getInspectorTree（返回 root + 所有 store 节点，支持 filter）、getInspectorState（格式化选中节点的 state/getters）、editInspectorState、editComponentState。同时把 `pinia` 暴露到 `globalThis.$pinia`。
  源码位置: packages/pinia/src/devtools/plugin.ts:80-148, 227, 229-249

- **timeline 层与 inspector 的 id 常量**：`MUTATIONS_LAYER_ID = 'pinia:mutations'`，`INSPECTOR_ID = 'pinia'`；root 节点 id 是 `PINIA_ROOT_ID = '_root'`，label 是 `'🍍 Pinia (root)'`。
  源码位置: packages/pinia/src/devtools/plugin.ts:32-33; packages/pinia/src/devtools/formatting.ts:94-95

- **store 级挂载（addStoreToDevtools）的四个订阅/拦截**：
  1. `store.$onAction(({ after, onError, name, args }) => {...}, true)` —— detached，开一个 start 事件（groupId = runningActionId++），after 回调开 end 事件、onError 开 error 事件，三事件共享同一 groupId。
  2. `store._customProperties.forEach(name => watch(() => unref(store[name]), ..., { deep: true }))` —— 对自定义属性做 deep watch，变更时 notifyComponentUpdate + sendInspectorState，时间线事件 groupId 取模块级 `activeAction`。
  3. `store.$subscribe((mv, state) => {...}, { detached: true, flush: 'sync' })` —— detached 且 sync flush，确保 mutation 一发生就立刻发事件；事件 groupId 也取 `activeAction`；通过 `formatMutationType` 把 direct/patchFunction/patchObject 映射成 'mutation'/'$patch'。
  4. 包装 `store._hotUpdate` 与 `store.$dispose`，让 HMR 和 dispose 也产生时间线事件 + 刷新 inspector。
  源码位置: packages/pinia/src/devtools/plugin.ts:344-471, 473-502

- **action 分组的核心机制（patchActionForGrouping）**：把每个 action 名下的原 action 备份出来，再用一个新函数替换 store 上的 action；新函数内部：(a) 记下当前 running id；(b) 若 `wrapWithProxy=true` 则用 Proxy 包裹 store，Proxy 的 get/set 陷阱里把模块级 `activeAction` 重置为当前 id；(c) `activeAction = _actionId` 再调原 action.apply(trackedStore)；(d) 调完立即 `activeAction = undefined`。注释里明确说"For Setup Stores we need https://github.com/tc39/proposal-async-context"——这是异步 setup-store action 无法可靠关联的根因。
  源码位置: packages/pinia/src/devtools/plugin.ts:525-565

- **为什么 wrapWithProxy 因 store 类型而异**：devtoolsPlugin 入口处 `store._isOptionsAPI = !!options.state`，然后调 `patchActionForGrouping(store, Object.keys(options.actions), store._isOptionsAPI)`。即 options API store 用 Proxy 兜底（因为它的 action 通过 `this.x = y` 改 state，Proxy 能拦到）；setup store 不用 Proxy（因为它的 action 通过闭包里的 ref 改 state，Proxy 拦不到，只能靠"调 action 前后置/清 activeAction"抓住同步窗口）。
  源码位置: packages/pinia/src/devtools/plugin.ts:582, 585-602

- **HMR 与 testing 的交互**：devtoolsPlugin 也包装了 `store._hotUpdate`，HMR 之后立即对新 actions 再跑一次 `patchActionForGrouping`（用新模块的 action 名单）；同时跳过 `store.$id.startsWith('__hot:')` 的临时 store；`store._p._testing` 为 true 时（即 @pinia/testing 环境）整个 patchActionForGrouping 都不跑，避免覆盖被 stub 的 action。
  源码位置: packages/pinia/src/devtools/plugin.ts:577-602

- **编辑路径的 path 改写**：editInspectorState 里，对单 store，若 path 长度≠1、或 path[0] 不在 `_customProperties` 也不是 writable computed、或 path[0] 在 `$state` 里，则前置 '$state'；对根 pinia 则前置 'state'（devtools API 会自动补 .value）。editComponentState 里如果 path[0] !== 'state' 直接拒绝（只允许改 state）。两次编辑都把 `isTimelineActive` 临时关掉再开。
  源码位置: packages/pinia/src/devtools/plugin.ts:262-282, 285-308

- **utils 三个工具**：(a) `toastMessage(msg, type)` 把消息前缀 '🍍 ' 后 console.debug/warn/error；(b) `isPinia(o)` 用鸭子类型 `'_a' in o && 'install' in o` 区分根 pinia 与 store；(c) `isWritableComputed(store, key)` 用 `isRef(toRaw(store)[key]) && !isReadonly(...)` 判定 getter 是否可编辑。
  源码位置: packages/pinia/src/devtools/utils.ts:11-37

- **formatting.ts 的两类格式化**：(a) `formatStoreForInspectorState` —— root pinia 把所有 store 聚合成 {state: [...], getters: [...]}；单 store 则输出 {state: $state keys, getters: _getters keys, customProperties: _customProperties keys}，getters 的 editable 取自 isWritableComputed；(b) `formatEventData` 支持 DebuggerEvent 单个或数组两种形态；`formatMutationType` 把 MutationType 三种值映射成 'mutation'/'$patch'/'unknown'。
  源码位置: packages/pinia/src/devtools/formatting.ts:111-171, 173-215

- **actions.ts（devtools 全局动作，非 store action）**：4 个全局动作——copy 用 `navigator.clipboard.writeText(JSON.stringify(state.value))`、paste 用 readText + `loadStoresState`、save 用 file-saver 的 saveAs 导出 JSON 文件、open 用一个 lazily 创建的隐藏 `<input type=file>` 让用户选文件。`loadStoresState` 区分已实例化的 store（`Object.assign` patch）与新 store 槽（直接 `state.value[key] = ...`）。`checkNotFocusedError` 处理 "Document is not focused" 的友好提示（提示用户开启 Rendering 面板的 "Emulate a focused page"）。
  源码位置: packages/pinia/src/devtools/actions.ts:11-30, 32-120, 122-133

## 关键调用链

```
createPinia() → pinia.use(devtoolsPlugin) → toBeInstalled
app.use(pinia) → install() → registerPiniaDevtools(app, pinia) → setupDevtoolsPlugin
                                  ↓
                            addTimelineLayer / addInspector / on.getInspectorState...

createSetupStore (在 plugins 应用阶段) → devtoolsPlugin({ app, store, options })
                                  ↓
                  patchActionForGrouping(store, actionNames, isOptionsAPI)
                                  ↓
                  addStoreToDevtools(app, store) → setupDevtoolsPlugin
                                  ↓
        $onAction (detached) / watch(custom) / $subscribe (detached, sync) / wrap _hotUpdate / wrap $dispose

用户调 action foo():
  wrappedFoo() → activeAction = runningActionId++
    → 原 action.apply(Proxy(store))（每次 get/set 把 activeAction 重置为当前 id）
      → state 变更 → $subscribe 回调 → addTimelineEvent({ groupId: activeAction })
    → action 返回 → activeAction = undefined
    → $onAction 的 after 回调 → addTimelineEvent({ groupId: 同一个 id })  # end 事件
```
源码位置: packages/pinia/src/createPinia.ts:31-60; packages/pinia/src/devtools/plugin.ts:313-512, 525-609

## 源码摘录（带行号，全文累计 ≤ 30 行）

action 分组的 Proxy 包装（核心权衡的直接体现）：

```ts
// packages/pinia/src/devtools/plugin.ts:537-563
for (const actionName in actions) {
  store[actionName] = function () {
    const _actionId = runningActionId
    const trackedStore = wrapWithProxy
      ? new Proxy(store, {
          get(...args) { activeAction = _actionId; return Reflect.get(...args) },
          set(...args) { activeAction = _actionId; return Reflect.set(...args) },
        })
      : store
    // For Setup Stores we need https://github.com/tc39/proposal-async-context
    activeAction = _actionId
    const retValue = actions[actionName].apply(trackedStore, arguments as unknown as any[])
    // this is safer as async actions in Setup Stores would associate mutations done outside of the action
    activeAction = undefined
    return retValue
  }
}
```

$subscribe 把 groupId 关联到 activeAction（演示"严格同步顺序"）：

```ts
// packages/pinia/src/devtools/plugin.ts:428-444
store.$subscribe(
  ({ events, type }, state) => {
    api.notifyComponentUpdate()
    api.sendInspectorState(INSPECTOR_ID)
    if (!isTimelineActive) return
    const eventData: TimelineEvent = {
      time: now(),
      title: formatMutationType(type),
      data: assign({ store: formatDisplay(store.$id) }, formatEventData(events)),
      groupId: activeAction,   // ← 关键：取模块级全局变量
    }
    // ...
    api.addTimelineEvent({ layerId: MUTATIONS_LAYER_ID, event: eventData })
  },
  { detached: true, flush: 'sync' }   // ← 关键：sync flush 保证事件即时
)
```

## 易混淆 / 边界 / 推断

- **事实**：devtoolsPlugin 与 registerPiniaDevtools 是两个独立的 setupDevtoolsPlugin 调用，但用的是同一个 id `'dev.esm.pinia'`；Vue DevTools 内部按 id 去重，因此两次调用不会产生两个面板。
  源码位置: packages/pinia/src/devtools/plugin.ts:64, 320

- **事实**：`globalThis.$pinia` 在 registerPiniaDevtools 里赋值一次；`globalThis.$store` 在 getInspectorState 每次用户切换节点时重新赋值（指向当前选中 store 的 toRaw）。两者只在 devtools 打开时才被赋值（因为这些回调只在 devtools 交互时触发）。
  源码位置: packages/pinia/src/devtools/plugin.ts:227, 243-245

- **事实**：`store._isOptionsAPI` 这个属性是 devtoolsPlugin 里第一次设置的（`!!options.state`），不在 store 构建主链路上；它同时被 inspector 用来决定选项 API store 的 state 用 `_custom.value: toRaw($state)` 包装（带 reset action）还是直接 reduce 展开。
  源码位置: packages/pinia/src/devtools/plugin.ts:165-182, 582

- **推断（标注为推断）**：setup store 不用 Proxy，应该是因为 setup store 的 action 通过闭包变量（如 `const count = ref(0); function inc() { count.value++ }`）改状态，而 Proxy 包的是 store 对象本身——闭包写入 ref 时根本不经过 store 的 get/set 陷阱，Proxy 在这里抓不到任何信号，开了也是空跑。注释里"safer as async actions in Setup Stores would associate mutations done outside of the action"暗示作者曾考虑过让 setup store 也保持 activeAction 不清空，但那会导致 action 返回后任何无关 mutation 都被错误关联，所以选择"调完即清"。

- **推断（标注为推断）**：`isTimelineActive` 这个布尔标志只服务于"编辑面板/组件状态时不要产生回声事件"这一个场景——它没有更复杂的开关含义，是模块级单值，所以两个并发的 store 编辑理论上会互相干扰，但因为 JS 单线程、editInspectorState 是同步路径，实际不会出问题。

- **事实**：HMR 期间 devtools 不只接管 `_hotUpdate` 发时间线事件——devtoolsPlugin 自己也包装了 `_hotUpdate`（在 devtoolsPlugin 入口处，独立于 addStoreToDevtools 内部那次包装），目的是 HMR 后用新 action 名单重跑 patchActionForGrouping。这两次包装是叠加的（addStoreToDevtools 那次包装会在 originalHotUpdate 之前再调一次 patchActionForGrouping，但 devtoolsPlugin 入口包装已经做过了——具体顺序需读 toRaw(store)._hotUpdate 赋值的时序）。
  源码位置: packages/pinia/src/devtools/plugin.ts:473-492, 593-601

- **未理解**：editInspectorState 里那段 path 改写条件 `(path.length !== 1 || (!custom && !writable && ) || path[0] in $state)` 的布尔语义相当绕（特别是 `||` 链最后那个 `path[0] in $state`），建议 Writer 在正文里只讲"如果改的是 state 字段就前置 '$state'，否则不前置"这个抽象结论，不要试图把每个分支都讲清，容易把读者绕晕。
  源码位置: packages/pinia/src/devtools/plugin.ts:262-278