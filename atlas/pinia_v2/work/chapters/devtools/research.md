# Vue Devtools 集成 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：状态管理库最难调试的地方是"这个状态是怎么变成现在这样的"——你看到 store 里某个值错了，却不知道是哪个动作、哪次提交、哪条异步链路改的。浏览器自带的调试器只能看"现在的值"，看不到"变更的历史与归因"。没有这套机制，用户只能到处手动 `console.log`，或在动作里打断点逆向追踪。

- **一句话核心思想**：**把状态变更的"旁观通道"接到已有的订阅原语上，再用一个代理把每次变更归因到触发它的动作。**

- **设计动机（为什么需要它）**：状态库已经内置了两套现成的"变更通知"——状态订阅（`$subscribe`）和动作订阅（`$onAction`）。devtools 不需要另起一套事件源去偷听状态变化，而是直接复用这两条通道，把它们桥接成外部调试工具能消费的"检查器树刷新 + 时间线事件"。但光有"发生了变更"还不够，调试时真正有价值的是"这次变更属于哪次动作调用"——于是引入第二层：用一个代理对象裹住动作执行期的上下文，在动作跑的时候举起一面"当前活跃动作"的旗子，让动作体内触发的所有变更都自动带上这面旗子。这样时间线上"一次动作调用"就不再是孤立事件，而是把它引发的所有状态变更串成一组的因果链。

- **关键权衡（本 Atlas 的核心）**：
  - **代理归因 vs 动作形态分裂**：用一个代理包裹动作的上下文、在每次属性读写时把"当前活跃动作序号"写进一个全局指针 → 换来了时间线能把"动作开始 → 动作体内的若干次状态变更 → 动作结束"按同一分组串成一条因果链 → 代价是这套代理方案对"选项式 store"（同步、状态变更发生在调用栈内）有效，对"组合式 store"（动作可能返回 Promise 后异步改状态）只能退化成"调用前后立/清旗子"的粗粒度窗口，异步链路上的变更无法被归因（源码注释明确指向"需要语言级异步上下文"才能彻底解决）。
  - **同步 + 脱离订阅换可靠归因**：devtools 的状态订阅刻意用"脱离作用域 + 同步刷新"两个选项 → 换来了订阅与整个应用同生命周期（不随组件销毁而漏接事件）、且回调在状态变更的同一同步栈内立即触发（旗子还没被清掉，归因一定命中）→ 代价是"同步触发 + 旁观所有变更"极易形成回环（devtools 自己写状态也会触发订阅），必须再用一个手动开关在"自己编辑时"暂时关掉时间线广播。
  - **复用插件机制换零侵入**：整套 devtools 桥接被写成一个"普通的 store 扩展插件"，挂载点与任何第三方插件完全相同 → 换来了零侵入核心装配逻辑、不维护第二套事件源、随 store 装配自动接入 → 代价是归因的正确性强依赖一处脆弱的跨函数时序：动作序号的自增必须发生在"动作前置钩子"里、且严格先于"动作体内读取该序号"，两个本可独立演进的函数靠一个共享的全局计数器隐式耦合。
  - **全局壳与逐 store 桥接分离**：把"建立检查器面板、时间线图层、全局导入导出按钮"做成只跑一次的全局壳，把"挂订阅、接事件"做成每个 store 装配时各跑一次的逐 store 桥接 → 换来了多 store 增量接入、面板复用 → 代价是两处都要重复声明同一份插件描述，靠共享的面板标识/图层标识字符串来保持关联。

- **最小心智模型（3～7 步）**：
  1. 创建状态库实例时，若开启了 devtools，就把桥接插件当作普通扩展注册进去（每个 store 装配时都会跑到它），并在库安装到应用时再单独建立一次性的全局调试面板。
  2. 每个 store 装配到末尾时，桥接插件先判定它是"选项式"还是"组合式"，再用代理把它的动作们包一层（为归因做准备），然后给这个 store 挂上事件桥接。
  3. 事件桥接给 store 挂三个监听：脱离作用域 + 同步刷新的状态订阅、脱离作用域的动作订阅、对自定义属性的侦听——三者都把变更翻译成"刷新检查器 + 追加时间线事件"。
  4. 用户调用某个动作时：动作订阅的前置回调先自增一个全局序号作为本次调用的分组标识并广播"开始"事件；随后被代理包过的动作体执行，在执行期间举起"当前活跃动作"旗子。
  5. 动作体内触发的状态变更，经同步状态订阅立刻广播为时间线事件，事件带上"当前活跃动作"旗子，于是与开始/结束事件归为同一组。
  6. 用户直接在调试面板里编辑状态时：编辑处理先关掉时间线开关 → 写入 → 再打开，避免这次写入被状态订阅当成"外部变更"又广播一遍（防回环）。
  7. 热更新与销毁也被包了一层，额外刷新面板，保证面板与实际 store 列表一致。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个只表达"代理归因"这条核心权衡的从零实现（几十行）。要素：一个全局 `activeAction` 指针、一个自增 `runningId`；`patchActions(store, names)` 用代理裹住每个动作，代理的 get/set 都把 `activeAction` 设成当前动作 id；`subscribeState(cb)` 在状态变更时回调，事件携带 `groupId = activeAction`；一个 demo 动作体内连续改两个字段，观察这两个变更事件与动作的 start/end 事件共用同一个 groupId。**这段演示演的是「代理归因 vs 同步订阅」这条权衡——为什么必须同步订阅、为什么代理只能在同步窗口内生效。**
  - **应故意省略**：完整的检查器树渲染、导入导出（剪贴板/文件）、组件面板集成、可写计算属性的编辑特判、热更新/销毁包装、全局面板的按钮系统、与具体调试协议的对接、类型体操。这些是工程化外壳，与核心原理无关。

- **正文不宜展开的细节**：鸭子类型判定是否为根实例（`_a` + `install`）；检查器节点路径前插 `$state`/`state` 的两种重写策略；可写计算属性才允许在面板编辑的判定；选项式 store 在组件检查器里以 `_custom` 形式展示并附带"重置"按钮的特例；剪贴板"页面未聚焦"错误的友好提示；全局状态导入时"已实例化 vs 未实例化"两种处理。这些供 Writer 裁剪，不是主线。

- **推荐的一个执行轨迹例子**：
  - 输入：用户调用 `store.increment()`，其内部执行 `this.count++` 和 `this.history.push(count)`。
  - 关键中间态：动作前置钩子先拿到分组序号 `groupId=1` 并广播 🛫 开始事件；代理裹着的动作体执行，旗子被举起指向序号 1；两次字段写入各自触发同步状态订阅，广播两个变更事件，均带 `groupId=1`；动作结束钩子广播 🛬 结束事件，带 `groupId=1`。
  - 输出：时间线上四个事件被同一分组串成一条"increment 引发了 count 与 history 两处变更"的因果链——这正是没有这套机制时用户永远看不到的东西。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- devtools 通过**两个入口**接入状态库：安装到应用时调一次全局注册（建面板/图层/组件钩子/全局动作），实例创建时把桥接逻辑作为**普通扩展插件**推入插件队列（每个 store 装配时各跑一次）。两处都受"开启了 devtools 且在客户端且宿主支持代理"三重守卫。源码位置: packages/pinia/src/createPinia.ts:31-32、58-59
- 桥接插件入口在每个 store 装配末尾执行：跳过热更新临时 store（id 以 `__hot:` 开头）、探测是否为选项式 store（`_isOptionsAPI = !!options.state`）、在非 testing 模式下用代理包装动作、并把热更新也升级一层（让 HMR 后的新动作继续被代理包装）、最后调用逐 store 桥接。源码位置: packages/pinia/src/devtools/plugin.ts:576-608
- **代理归因**是全章灵魂：用一个代理裹住动作上下文，在动作执行期把全局 `activeAction` 指针设为当前动作 id；选项式 store 因状态变更是同步的，用代理捕获每次属性读写（细粒度）；组合式 store 因动作可异步，代理在同步窗口外失效，退化为"调用前立旗、调用后清旗"。源码位置: packages/pinia/src/devtools/plugin.ts:525-565
- 动作序号 `runningActionId` 的自增发生在**动作前置钩子**（动作订阅的 before 回调）里，而代理包装的动作体只是**读取**该序号；两者通过共享全局计数器隐式协同，依赖严格时序。源码位置: packages/pinia/src/devtools/plugin.ts:345（自增）、540（读取），注释 539 印证
- 逐 store 桥接挂三个监听：脱离作用域的动作订阅（每次调用发 start/end/error 三个时间线事件，带 groupId）、对自定义属性的深层侦听（变更时刷新面板 + 追加时间线事件，带 groupId=activeAction）、**脱离作用域 + 同步刷新**的状态订阅（变更时刷新面板 + 追加时间线事件，标题由变更类型格式化，带 groupId=activeAction）。源码位置: packages/pinia/src/devtools/plugin.ts:344-471
- `isTimelineActive` 标志防止回环：在处理"用户在面板编辑状态"与"编辑组件上的状态"时，写入前关、写入后开；状态订阅回调开头 `if (!isTimelineActive) return` 拦截，避免 devtools 自身写入被当作外部变更重复广播。源码位置: packages/pinia/src/devtools/plugin.ts:29、279-281、304-306、433
- 全局壳建立：一个"变更"时间线图层 + 一个检查器（带复制/粘贴/保存/导入四个全局动作 + 一个"重置某 store"的节点动作）；并注册组件检查器钩子（把组件上的 store 集合暴露进组件面板）、检查器树/状态查询、检查器编辑等回调；同时把根实例与当前选中 store 暴露到 `globalThis` 便于控制台调试。源码位置: packages/pinia/src/devtools/plugin.ts:80-148、150-203、205-249、227、245
- 导入导出动作：复制/粘贴走剪贴板 API、保存/导入走 JSON 文件；恢复状态时区分"store 已实例化（Object.assign 局部 patch）"与"未实例化（直接写入根状态字典）"。源码位置: packages/pinia/src/devtools/actions.ts:32-133
- 格式化辅助：把 store 的 state/getters/customProperties 渲染成检查器可显示结构；getter 是否可在面板编辑取决于它是否为"非只读 ref"（即可写计算属性）；变更类型映射为时间线标题（直接变更→"mutation"，函数/对象补丁→"$patch"）。源码位置: packages/pinia/src/devtools/formatting.ts:111-215、packages/pinia/src/devtools/utils.ts:34-37

## 关键调用链
createPinia() → [实例创建时] pinia.use(devtoolsPlugin)（推入插件队列）
createPinia().install(app) → registerPiniaDevtools(app, pinia)（建全局壳：图层/检查器/钩子）
store 装配 → 插件队列执行 devtoolsPlugin({app, store, options})
  → patchActionForGrouping(store, actionNames, isOptionsAPI)（代理包动作，设归因旗子）
  → addStoreToDevtools(app, store)
      → store.$onAction(..., detached=true)（start/end/error 时间线事件，自增 groupId）
      → watch(customProperties)（自定义属性变更 → 刷新 + 时间线事件）
      → store.$subscribe(cb, { detached:true, flush:'sync' })（状态变更 → 刷新 + 时间线事件，groupId=activeAction）
      → 包裹 _hotUpdate / $dispose（HMR/销毁 → 额外刷新面板）

动作调用时序（归因命中的关键）：
store.action() → store 内部动作包装器先触发 $onAction before 回调（runningActionId++ 得 groupId，广播 🛫）
  → 代理包过的 action body 执行（读 runningActionId 设 activeAction，体内属性读写经代理继续维持 activeAction）
  → 体内状态变更 → 同步 $subscribe 回调（广播变更事件，groupId=activeAction）
  → $onAction after 回调（清 activeAction，广播 🛬）
源码位置: packages/pinia/src/devtools/plugin.ts:344-400、525-565、428-471；挂载点 packages/pinia/src/createPinia.ts:31-59

## 源码摘录（带行号，全文累计 ≤ 30 行）

双入口挂载与三重守卫（packages/pinia/src/createPinia.ts）：
```ts
      if (__USE_DEVTOOLS__ && IS_CLIENT) {
        registerPiniaDevtools(app, pinia)
      }
// ...
  if (__USE_DEVTOOLS__ && IS_CLIENT && typeof Proxy !== 'undefined') {
    pinia.use(devtoolsPlugin)
  }
```
（行 31-33、58-60）

代理归因核心——选项式用代理捕获每次读写，组合式退化为调用窗口（packages/pinia/src/devtools/plugin.ts）：
```ts
  for (const actionName in actions) {
    store[actionName] = function () {
      const _actionId = runningActionId
      const trackedStore = wrapWithProxy
        ? new Proxy(store, {
            get(...args) { activeAction = _actionId; return Reflect.get(...args) },
            set(...args) { activeAction = _actionId; return Reflect.set(...args) },
          })
        : store
      activeAction = _actionId
      const retValue = actions[actionName].apply(trackedStore, arguments as unknown as any[])
      // async 动作在返回后才改状态，此时旗子已被清，无法归因
      activeAction = undefined
      return retValue
    }
  }
```
（行 537-564，精简展示；注释 554/560 指向 async-context 提案）

状态订阅：脱离作用域 + 同步刷新，保证归因可靠；开头用开关拦截回环：
```ts
        ({ events, type }, state) => {
          api.notifyComponentUpdate(); api.sendInspectorState(INSPECTOR_ID)
          if (!isTimelineActive) return
          // ...构造 eventData，groupId: activeAction
        },
        { detached: true, flush: 'sync' }
```
（packages/pinia/src/devtools/plugin.ts:429-470，精简）

面板编辑防回环——写入前后切换开关：
```ts
          isTimelineActive = false
          payload.set(inspectedStore, path, payload.state.value)
          isTimelineActive = true
```
（packages/pinia/src/devtools/plugin.ts:279-281）

## 易混淆 / 边界 / 推断
- **事实**：选项式与组合式 store 走两套归因路径，分界点是 `wrapWithProxy = store._isOptionsAPI`（plugin.ts:589）。选项式 = true 用代理；组合式 = false 仅靠"调用前立旗/调用后清旗"。
- **事实**：testing 模式下（`store._p._testing` 为真）跳过代理包装，避免覆盖测试桩替换掉的动作（注释 #2298，plugin.ts:585）。
- **推断**：`flush: 'sync'` 是归因能命中的必要条件——若用默认的异步批处理刷新，动作体执行完毕、旗子被清空后回调才跑，`activeAction` 已为 undefined，变更事件将失去分组。源码未直说，但从"调用后立即 `activeAction = undefined`"与"同步订阅"的配合可推断。
- **推断**：动作序号自增（动作订阅 before，plugin.ts:345）必须严格先于代理包装体读取（plugin.ts:540），依赖 store 内部"先触发 before 订阅、再执行动作体"的调用顺序；注释"the running action id is incremented in a before action hook"（plugin.ts:539）印证此隐式契约。一旦上游调整动作包装顺序，归因将整体错位。
- **事实**：检查器编辑时对路径做前插重写——根实例前插 `state`，普通 store 默认前插 `$state`，但若是 customProperty 或可写计算属性则直接打到 store（plugin.ts:264-278）。
- **未理解**：代理的 get/set 在动作体内每次属性访问都会重置 `activeAction = _actionId`，理论上即便被嵌套动作调用覆盖也能在返回本动作体后恢复——但跨动作嵌套时 groupId 的归属优先级（是否会被内层动作的序号抢占且不恢复）源码未显式处理，需结合上游动作包装器的嵌套语义进一步验证。