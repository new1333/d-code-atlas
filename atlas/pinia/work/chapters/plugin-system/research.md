# 插件系统：context 注入的 store 增强 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：当开发者想给「所有 store」统一加一类能力——日志、持久化、权限、测试桩、可观测面板——而又不想在每个 store 定义里重复抄、不想 fork 框架源码时，就需要一个统一的扩展点。没有它，这类横切关注点要么散落在各处 store，要么根本无处安放；尤其框架自己的开发者工具也属于这类「想挂到每个 store 上」的能力，更需要一个对内对外都通用的机制。

- **一句话核心思想**：插件就是一个「拿到当前 store 和它的全局上下文、返回一组扩展、就地合并进 store」的增强函数；它运行时借用 store 自己的作用域，因此注入的响应式数据会自动随 store 生灭。

- **设计动机（为什么需要它）**：这个机制是为了解决「横切增强既要对每个 store 生效、又要享受 store 的全部生命周期与响应式待遇」这个矛盾——它换来了「注入的新状态/计算属性/方法自动具备响应性、能被定向提取、并随 store 回收」的能力。
  - 承前 1：插件「跑在 store 的作用域里」复用的正是前置章建立的「store 在根作用域下开一个子作用域跑装配」的机制（已在第 4 章『Store 装配』讲透），本章只看它的新侧面——**为什么外来的插件扩展也必须跑进这个作用域、以及由此给插件作者带来的约束**。
  - 承前 2：插件表本身挂在那个承载全部能力的单例 Pinia 实例上（已在第 1 章『Pinia 实例：根状态、注册表与全局活跃上下文』讲透），本章只看它的新侧面——**插件从「注册入队」到「逐个 store 跑一遍」的注册时序**。

- **关键权衡**：
  1. **让插件在 store 自己的作用域内执行 → 换来**插件返回的响应式数据自动归该 store 托管、store 被销毁时随之一并回收、且能被响应式系统与定向提取正常处理；**代价是**插件不能返回「裸的纯对象」——一旦合并进 store，响应式值会被解包、与纯对象再也无法区分，而纯对象既不归作用域托管、也会被定向提取忽略，所以作者必须显式地用 ref/reactive 或显式标记「非响应式」，否则在开发期会收到一条提示性告警。
  2. **用「待安装暂存队列」+「应用挂载时一次性灌入已安装表」处理注册时机 → 换来**插件注册函数可以在应用正式挂载 Pinia 之前就自由调用（框架自己就靠这一点，在挂载之前就把内置的开发者工具插件预装上）；**代价是**内部要同时维护「暂存队列」和「已安装表」两份数据，并在挂载那一刻做一次 flush。
  3. **在装配时动态构造一份传给插件的 options 上下文，并把「setup 语法 store」的 action 逐一收集进去 → 换来**插件经由上下文能看到任意写法的 store 的全部 action（setup 语法的 action 只有装配跑完才存在，必须主动收集）；**代价是**装配路径里要多一次浅合并、多一次逐属性收集。
  4. **把插件注入的每个键登记进一个「自定义属性集合」 → 换来**开发者工具能区分「这是插件注入的外来属性」与 store 自身的状态/计算属性，从而在展示与编辑时区别对待；**代价是**多维护一个集合与登记动作。（⚠️ 注意修正：定向提取工具**并不**读这个集合，它是凭「是否响应式」来判断的——所以这条权衡只服务开发者工具。）

- **最小心智模型（7 步）**：
  1. 创建 Pinia 实例时，若开启开发者工具，内置的开发者工具插件就被注册函数丢进「待安装暂存队列」。
  2. 用户后续注册的插件：若应用还没挂载，也进暂存队列；若已挂载，直接进已安装表。
  3. 应用挂载 Pinia（触发 install）：设置活跃 Pinia、完成注入，并把暂存队列整体 flush 进已安装表，清空队列。
  4. 某个 store 首次被使用而装配：先在 store 自己的子作用域里把 setup 返回值分类装配成 store 对象，并把这个「还在装配中」的 store 先占位放进注册表。
  5. 装配走到末尾：遍历已安装插件表，**在 store 的作用域内**逐个调用插件，传入 `{ 当前 store, 应用, pinia, options }` 这套上下文。
  6. 每个插件返回的扩展：开发期先把每个键登记进自定义属性集合、检查其中有没有「裸纯对象」并告警，然后就地合并进 store。
  7. store 被显式销毁时，它的作用域停止，插件当初注入的响应式数据随之一并回收。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个从零的「迷你 Pinia + 插件」骨架——`createMiniPinia()` 带 `use`/`install`（含暂存队列与挂载时 flush）、装配 store 时在自己作用域内跑插件、把插件返回值合并进 store；用两个对照插件演关键思想：一个返回 ref（被作用域托管、store 销毁后失效）、一个返回裸纯对象（触发告警、合并进 store 却不响应式）。**这段演示演的是权衡 1（作用域托管 ↔ 禁止裸纯对象）和权衡 2（注册时机暂存）这两条灵魂**。
  - 应故意省略：HMR、开发者工具内部、SSR 水合、订阅、$patch 的双形态、完整泛型、诊断信息的完整文案。
  - 演示载体建议：本仓库主语言是 TypeScript/JS，且本章机制完全落在「注册时序 + 作用域托管 + 就地合并」这一层、没有任何 GUI/宿主依赖，**建议写成一段可被 `bun run`/`node` 直接跑的独立脚本**（能跑最好，非硬要求）。一句话原则：载体服务于「演透原理」，本章用纯脚本即可演透，不需要起 Vue 应用。

- **正文不宜展开的细节**：开发者工具具体如何消费「自定义属性集合」（属下一章开发者工具集成）；开发者工具插件内部对 action 的 Proxy 包裹与时间线归因（同上）；@pinia/testing 那套重塑行为的插件实现（属测试章）；与本机制无关的另一条开发期告警（关于 $state 构造函数的）；HMR 热更新与插件运行顺序的交互。

- **推荐的一个执行轨迹例子**：
  - 输入：用户写了一个返回 `{ count: ref(0), config: { theme: 'dark' } }` 的插件并注册它。
  - 关键中间态：挂载前插件躺在暂存队列；挂载时 flush 进已安装表；某 store 装配到末尾时，在 store 作用域内调用插件拿到这个返回对象。
  - 关键分支：`count` 是 ref → 登记进自定义属性集合、合并进 store、被作用域托管、响应式可改可订阅；`config` 是裸纯对象 → 开发期触发告警（提示要么包成响应式、要么显式标记非响应式），仍合并进 store 但不具备响应性、定向提取会忽略它。
  - 输出：`store.count` 响应式可读写；`store.config` 存在但非响应式；store 销毁后，`count` 关联的响应式副作用随之失效。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **插件即函数**：类型上是一个收 context、返回「部分扩展属性」或什么都不返回的函数，返回值合并进 store。源码位置: packages/pinia/src/rootStore.ts:162-172
- **context 四件套**：`{ pinia, app, store, options }`——当前被增强的 store、当前 Vue 应用、pinia 实例、定义该 store 的选项。源码位置: packages/pinia/src/rootStore.ts:132-157
- **注册分两路**：`pinia.use(plugin)` 在「应用尚未 install（`!this._a`）」时入暂存队列 `toBeInstalled`，否则直接 push 进已安装表 `_p`。源码位置: packages/pinia/src/createPinia.ts:38-45
- **install 时 flush**：`install(app)` 末尾把 `toBeInstalled` 全部灌进 `_p` 并清空队列，此后新注册的插件直接进 `_p`。源码位置: packages/pinia/src/createPinia.ts:34-35
- **框架自举用插件**：`createPinia()` 末尾，若 `__USE_DEVTOOLS__ && IS_CLIENT && typeof Proxy !== 'undefined'`，会 `pinia.use(devtoolsPlugin)` 把整套开发者工具当普通插件预装——说明插件系统同时承载「用户扩展」与「框架自身系统级能力」。源码位置: packages/pinia/src/createPinia.ts:58-60
- **dispose 清空插件**：`disposePinia` 里 `pinia._p.splice(0)` 清空已安装表（连同停作用域、清注册表、清 state）。源码位置: packages/pinia/src/createPinia.ts:72-79
- **插件运行点**：`createSetupStore` 装配流程的**最末尾**，遍历 `pinia._p`，在 **store 自己的 effectScope（`scope`）内**调用每个插件。源码位置: packages/pinia/src/store.ts:717-725
- **作用域托管是核心**：`scope.run(() => extender(context))` 保证插件返回的 ref/computed/reactive 被 store 的 effectScope 捕获；`$dispose` 调 `scope.stop()` 时这些响应式自动回收。源码位置: packages/pinia/src/store.ts:718（运行）, 350（dispose 调 scope.stop）
- **传给插件的 options 是动态构造的**：`optionsForPlugin = assign({ actions: {} }, options)`——保证始终有 `actions` 字段（即使 setup 语法 store 原本没有）。源码位置: packages/pinia/src/store.ts:232-235
- **setup store 的 action 被收集进 optionsForPlugin**：装配时分类遍历 setup 返回值，凡 function 都填进 `optionsForPlugin.actions[key]`，并附注释「list actions so they can be used in plugins」。源码位置: packages/pinia/src/store.ts:540-554
- **扩展就地合并**：插件返回的 `extensions` 经 `assign(store, extensions)` 合并进 store（在此之前已先 `assign(toRaw(store), setupStore)`）。源码位置: packages/pinia/src/store.ts:753
- **自定义属性集合的创建条件**：`_customProperties = markRaw(new Set<string>())` 仅在 `__DEV__ || (__USE_DEVTOOLS__ && IS_CLIENT)` 下挂到 store；生产且非 devtools 构建里根本不存在。源码位置: packages/pinia/src/store.ts:478-490
- **登记插件键**：devtools 开启时，把插件返回的每个 key 加进 `store._customProperties`。源码位置: packages/pinia/src/store.ts:728-732
- **纯对象告警（赋值前检查）**：dev 下、在 `assign(store, extensions)` **之前**遍历 extensions，对「typeof object 且非 ref、非 reactive、非 `__v_skip`」的值触发 `PINIA_R1006`。注释点明为何要在赋值前查：「once assigned to the store, a reactive() value is unwrapped and indistinguishable from a plain object」。源码位置: packages/pinia/src/store.ts:734-751
- **PINIA_R1006 文案与修法**：告警说该属性「not reactive ... so storeToRefs() ignores it」；修法是「该响应式就 ref()/reactive()/shallowRef()，否则用 markRaw() 显式跳过」。源码位置: packages/pinia/src/diagnostics.ts:38-42
- **`__v_skip` 即 markRaw 的标记**：markRaw 给对象置 `__v_skip=true`，故告警检查里的 `!value?.__v_skip` 正是「markRaw 过的值跳过告警」的判据。源码位置: packages/pinia/src/store.ts:746
- **⚠️ 修正 outline summary**：`_customProperties` 的**实际消费方全在 devtools**（formatting 里转成可展示的自定义属性列表；plugin.ts 里编辑 state 时跳过它、并遍历它做处理），**storeToRefs 并不读它**——storeToRefs 是凭 isRef/isReactive/`.effect` 判断的。插件返回纯对象「影响 storeToRefs」是因为它不响应式，而非因为没登记。源码位置: packages/pinia/src/devtools/formatting.ts:162-163, packages/pinia/src/devtools/plugin.ts:269,402
- **内部属性在 devtools 下设为不可枚举**：`_p`/`_hmrPayload`/`_getters`/`_customProperties` 在 devtools 构建下被重定义为 `enumerable: false`，避免在面板里列出。源码位置: packages/pinia/src/store.ts:696-714

## 关键调用链

注册时序：
`pinia.use(plugin)` →（应用未 install）`toBeInstalled.push(plugin)` → `install(app)` 时 `toBeInstalled.forEach(p => _p.push(p))` + 清空 → 此后 `use` 直接 `_p.push`。

装配时运行：
`createSetupStore`（占位注册 → 跑 setup → 分类返回值 → 合并 setupStore）→ 末尾 `pinia._p.forEach(extender => scope.run(() => extender({ store, app, pinia, options: optionsForPlugin })))` →（devtools：登记 `_customProperties`）→（dev：纯对象检查 + 告警）→ `assign(store, extensions)`。

销毁回收：
`$dispose()` → `scope.stop()`（插件注入的响应式随 store 作用域一并停止）。
源码位置: packages/pinia/src/store.ts:349-354

## 源码摘录（带行号，全文累计 ≤ 30 行）

注册两路 + install flush（createPinia.ts）：
```ts
// createPinia.ts:23-45
install(app: App) {
  setActivePinia(pinia)
  pinia._a = app
  app.provide(piniaSymbol, pinia)
  app.config.globalProperties.$pinia = pinia
  /* istanbul ignore else */
  if (__USE_DEVTOOLS__ && IS_CLIENT) {
    registerPiniaDevtools(app, pinia)
  }
  toBeInstalled.forEach((plugin) => _p.push(plugin))
  toBeInstalled = []
},

use(plugin) {
  if (!this._a) {
    toBeInstalled.push(plugin)
  } else {
    _p.push(plugin)
  }
  return this
},
```

插件运行 + 登记自定义属性 + 纯对象告警 + 就地合并（store.ts）：
```ts
// store.ts:717-754
pinia._p.forEach((extender) => {
  const extensions = scope.run(() =>
    extender({
      store: store as Store,
      app: pinia._a,
      pinia,
      options: optionsForPlugin,
    })
  )!

  if (__USE_DEVTOOLS__ && IS_CLIENT) {
    Object.keys(extensions || {}).forEach((key) =>
      store._customProperties.add(key)
    )
  }

  // Check properties that are not properly configured. We check the values
  // as the plugin returned them: once assigned to the store, a `reactive()`
  // value is unwrapped and indistinguishable from a plain object.
  if (__DEV__) {
    for (const key in extensions) {
      const value = (extensions as any)[key]
      if (
        typeof value === 'object' &&
        !isRef(value) &&
        !isReactive(value) &&
        !value?.__v_skip
      ) {
        diagnostics.PINIA_R1006({ key, id: $id })
      }
    }
  }

  assign(store, extensions)
})
```

## 易混淆 / 边界 / 推断

- **事实**：`_customProperties` 只在 `__DEV__ || (__USE_DEVTOOLS__ && IS_CLIENT)` 分支创建；纯生产构建里它不存在，相应的「登记插件键」与「设为不可枚举」逻辑也整体消失。
- **事实（修正 summary）**：定向提取工具不依赖 `_customProperties`，它凭响应式特征区分属性；`_customProperties` 真正的服务对象是 devtools。插件返回纯对象会被定向提取忽略，根因是「不响应式」而非「没登记」。
- **推断（有注释佐证，视为事实）**：纯对象检查刻意放在 `assign(store, extensions)` 之前，是因为赋值后 store 作为 `reactive()` 会把嵌套响应式值解包，届时再无法把「原本是 reactive」与「原本就是纯对象」区分开。
- **推断**：框架把 devtools 经由 `pinia.use(devtoolsPlugin)` 注入（而非硬编码进装配流程），意在让插件系统成为「对内对外统一的唯一扩展点」——这是其作为架构基石的设计意图。
- **事实**：`optionsForPlugin = assign({ actions: {} }, options)` 对 option store 而言，`options.actions` 会覆盖回真实 actions；对 setup store 而言保留空对象、随后由分类遍历填充，从而保证插件看到的 `options.actions` 形状稳定、永不为 undefined。
- **事实**：插件运行的 `scope` 与 setup 跑在同一个 store 子 effectScope（`pinia._e.run(() => (scope = effectScope()).run(...))`），故插件注入的响应式与 store 自身 state/getter 同属一个可整体停止的作用域。
- **未理解**：暂无明显未解之处；插件与 HMR 的交互（热更新后插件是否重跑）本章 sourceFiles 未覆盖 HMR 细节，留待 HMR 章核对。