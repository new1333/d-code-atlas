# createPinia：effectScope 状态根与插件装载 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个应用里有几十个 store，每个都带着自己的响应式 state、计算属性、侦听器和订阅。如果这些副作用散落在各自组件的作用域里，组件一卸载副作用就没了；服务端渲染时还要把"全部 store 的状态"打包成一份传给客户端。没有这么一个"根"，你既无法在测试后一键清掉所有副作用，也无法把全部状态序列化成单一快照。

- **一句话核心思想**：把"所有 store 的副作用"和"所有 store 的状态"收口到一个可手动启停的容器里——副作用统一挂在一个可停止的作用域根之下，状态统一收进一张按 store 编号寻址的扁平字典。

- **设计动机（为什么需要它）**：Pinia 要同时满足三件事——(a) store 的响应式副作用能随实例整体回收（测试、多实例场景）；(b) 服务端能把全部状态序列化成一份可传输快照；(c) 作为普通 Vue 插件挂到 app、又能在组件注入上下文之外被取用。把"副作用根"和"状态总账"都收口到同一个根对象上，是同时满足这三者的最小结构。

- **关键权衡（4 条，本章核心）**：
  - **扁平字典 vs 按 store 嵌套**：选择"一张扁平字典、用 store 编号当 key"统一存放全部状态 → 换来服务端只需序列化这一个字典对象、且状态变更接口能用统一的 `字典[当前 store]` 一处寻址 → 代价是 setup 形态的 store 里用户自己 new 出来的状态引用必须被"搬"进字典对应槽位，才能维持单一真源（option 形态则直接把状态工厂返回值写进字典）。
  - **独立作用域当副作用根**：选择一个脱离任何组件生命周期的"独立作用域"当根，每个 store 的副作用都挂在它的子作用域下 → 换来"停止根作用域 = 一键回收全部 store 副作用"，且 store 副作用不会因某个组件卸载而消失 → 代价是这个根作用域不会自动被垃圾回收，必须显式销毁（或随 app 卸载），用错场景会泄漏。
  - **插件延迟入队**：选择"应用装载前注册的插件先暂存、等应用装上这个根之后再统一并入正式插件队列" → 换来"插件执行顺序与注册时机无关"的确定性（store 装配时队列已完整且有序）→ 代价是多了一个暂存中间态，装载前注册的插件实际生效要等到应用挂载之后。
  - **容器自身不参与响应式代理**：选择让根容器对象本身被标记为不进入响应式系统 → 换来它持有的字典、注册表仍按各自原语义工作，且容器被存进任何响应式上下文也不触发额外代理开销 → 代价极小（容器只是个普通对象引用）。

- **最小心智模型（6 步）**：
  1. 建一个可手动停止的、脱离组件生命周期的独立作用域，当"副作用根"。
  2. 在这个根里放一张空的响应式字典，用 store 编号当 key。
  3. 让这个根对象同时扮演 Vue 插件：被应用装载时把自己挂上去，并暴露给"组件内 / 组件外"两条取用路径。
  4. 注册插件时先暂存；等应用装载后，再把暂存的一并并入正式队列。
  5. 每个 store 首次创建时：把自己的副作用挂到根作用域的一个子作用域下、把自己的状态写进字典对应槽位。
  6. 销毁时停止根作用域，连带回收所有 store 的副作用，并清空字典与注册表。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的从零实现，演透「副作用收口 + 扁平字典 + 插件暂存/并入 + 一键销毁」四件事。骨架：建一个可停止的独立作用域当根；建一个空响应式对象当字典；提供"注册插件"方法，按"应用是否已挂载"决定暂存还是直接入队；提供"应用装载"钩子，挂载时把暂存插件并入正式队列；建一个迷你 store：在根作用域内跑一段依赖状态的副作用、并把状态写进字典某 key；最后销毁 = 停止根作用域，演示停止后那段副作用不再触发、字典被清空。
  - **演的是**：权衡 1（字典统一寻址与单一真源）、权衡 2（根作用域一键回收）、权衡 3（暂存→并入的延迟入队）。
  - **应故意省略**：容器不参与响应式代理的标记、devtools 分支、客户端/SSR 守卫、SSR 真实序列化、状态变更接口的深度合并、option/setup 双形态归一、store 装配时的属性自动分类——这些都是别的章或工程旁路，不追求工程完整、不追求可独立安装。

- **正文不宜展开的细节**：容器标记不参与响应式代理的具体必要性、devtools 分支与"客户端 + 可用 Proxy"的双重守卫、devtools 插件本身也在建根末尾经"注册插件"路径登记（故同样走暂存）、`globalProperties.$pinia` 与 `provide(symbol)` 两条挂载路径的差异、根对象上一个供测试替身旁路用的标志字段。

- **推荐的一个执行轨迹例子**：输入 `新建 app → 注册业务插件（此时未挂应用，进暂存）→ 应用装载这个根 → 首次取用某个 store`；关键中间态——装载钩子把根挂上应用并把暂存插件并入正式队列，store 装配时在根作用域内开一个子作用域跑 setup、把状态写进字典对应槽位；输出 `销毁这个根 → 根作用域停止使该 store 的计算属性/侦听器失活，字典与注册表清空`。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- `createPinia()` 返回的对象**同时是 Vue 插件（带 install）+ 状态根**：它既被 `app.use(pinia)` 装载，又持有全部副作用作用域、状态字典、store 注册表与插件队列。源码位置: packages/pinia/src/createPinia.ts:22-54；字段类型见 packages/pinia/src/rootStore.ts:63-112。
- **副作用根 = 一个 detached effectScope**：`effectScope(true)` 的 `true` 表示脱离调用时活跃作用域、不自动随父作用域销毁，生命周期由 pinia 自管；赋值给内部字段 `_e`。源码位置: packages/pinia/src/createPinia.ts:11,51；类型 packages/pinia/src/rootStore.ts:92-97。
- **状态总账 = 扁平字典**：`state` 是 `ref<Record<string, StateTree>>`，按 storeId 当 key，全部 store 的状态最终都落到这张字典里，是唯一真源。源码位置: packages/pinia/src/createPinia.ts:14-16,53；类型 packages/pinia/src/rootStore.ts:66-69。
- **两种 store 形态都写同一张字典**：option store 在 setup 适配器里直接 `pinia.state.value[id] = state ? state() : {}`；setup store 把用户在 setup 内新建的 ref/reactive **迁移**进 `pinia.state.value[$id][key]`。源码位置: packages/pinia/src/store.ts:169（option 直接写）、packages/pinia/src/store.ts:532（setup 迁移）。
- **状态变更接口统一寻址字典**：函数态 mutator 操作 `pinia.state.value[$id]`，偏对象态经深度合并写回同一个槽位——无论哪种形态，寻址入口一致。源码位置: packages/pinia/src/store.ts:300,307。
- **插件队列的两段式**：内部用 `_p`（已生效队列）与 `toBeInstalled`（装载前暂存）两个数组；`use(plugin)` 按"app 是否已挂"分流；`install` 时把暂存全部并入 `_p`。源码位置: packages/pinia/src/createPinia.ts:18-20,34-35,38-45。
- **store 装配末尾按 `_p` 顺序执行每个插件**，返回对象混入 store——这是 devtools/testing 共用的唯一扩展点。源码位置: packages/pinia/src/store.ts:717-723。
- **store 副作用挂在根作用域的子作用域下**：装配时 `pinia._e.run(() => (scope = effectScope()).run(() => setup(...)))`，外层 `_e` 是根、内层新建的是单 store 作用域。源码位置: packages/pinia/src/store.ts:500-502。
- **install 做四件事**：`setActivePinia(pinia)`（让组件外能取用）、`pinia._a = app`、`app.provide(piniaSymbol, pinia)` + `globalProperties.$pinia`、（dev 且 client 时）注册 devtools。源码位置: packages/pinia/src/createPinia.ts:23-35。
- **`markRaw(pinia)`**：根容器自身不进入响应式代理系统，其持有的 ref/Map 仍各自按原语义响应。源码位置: packages/pinia/src/createPinia.ts:22。
- **devtools 也在建根末尾经 `use` 登记**：因登记时 `_a` 尚未设置，它同样进暂存、待 install 时并入。源码位置: packages/pinia/src/createPinia.ts:58-60（登记）、39-40（分流进暂存）。

## 关键调用链

```
app.use(pinia)
  → pinia.install(app)
    → setActivePinia(pinia) + app.provide(piniaSymbol) + globalProperties.$pinia
    → toBeInstalled.forEach(p => _p.push(p))   // 暂存插件并入正式队列
pinia.use(plugin)
  → (!this._a ? toBeInstalled : _p).push(plugin)
useStore() 首次
  → createSetupStore
    → pinia._e.run(() => effectScope().run(setup))   // store 副作用挂到根的子作用域
    → setup 内写 pinia.state.value[id]               // 状态落进扁平字典
    → pinia._p.forEach(extender => extender({...}))  // 按序执行插件
    → pinia._s.set(id, store)                        // 登记进 store 注册表
disposePinia(pinia)
  → pinia._e.stop()   // 级联停止所有 store 子作用域的副作用
  → pinia._s.clear() / pinia._p.splice(0) / pinia.state.value = {} / pinia._a = null
```
源码位置: packages/pinia/src/createPinia.ts:23-45,72-79；装配侧 packages/pinia/src/store.ts:500-502,717-723。

## 源码摘录（带行号，全文累计 ≤ 30 行）

> 根作用域 + 扁平字典（对应权衡 1、2 与心智模型步骤 1-2）。源码位置: packages/pinia/src/createPinia.ts:11,14-16

```ts
  const scope = effectScope(true)
  const state = scope.run<Ref<Record<string, StateTree>>>(() =>
    ref<Record<string, StateTree>>({})
  )!
```

> 插件暂存与 install 时并入正式队列（对应权衡 3）。源码位置: packages/pinia/src/createPinia.ts:34-45

```ts
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

> 一键销毁：停止根作用域即级联回收全部 store 副作用（对应权衡 2、心智模型步骤 6）。源码位置: packages/pinia/src/createPinia.ts:72-79

```ts
export function disposePinia(pinia: Pinia) {
  pinia._e.stop()
  pinia._s.clear()
  pinia._p.splice(0)
  pinia.state.value = {}
  pinia._a = null
}
```

> 消费侧·store 副作用挂在根作用域的子作用域下（对应权衡 2、心智模型步骤 5）。源码位置: packages/pinia/src/store.ts:500-502

```ts
  const setupStore = runWithContext(() =>
    pinia._e.run(() => (scope = effectScope()).run(() => setup({ action }))!)
  )!
```

> 消费侧·setup store 把用户的状态引用搬进扁平字典对应槽位（对应权衡 1）。源码位置: packages/pinia/src/store.ts:532

```ts
        pinia.state.value[$id][key] = prop
```

## 易混淆 / 边界 / 推断

- **事实**：`effectScope(true)` 的 `true` 表示 detached（脱离调用时活跃作用域、不随父作用域自动销毁），故 pinia 的副作用根独立于任何组件存活。源码位置: packages/pinia/src/createPinia.ts:11。
- **推断（标注为推断）**：`pinia._e.run(() => effectScope().run(...))` 中，内层新建的 `effectScope()` 未传 `true`（非 detached），会被记录在外层 `_e` 的作用域树下，因此 `_e.stop()` 能级联停止它——这是"一键回收全部 store 副作用"的机制依据。源码未对此嵌套显式注释，此因果链依据 Vue effectScope 的公开行为推断。源码位置: packages/pinia/src/store.ts:500-502。
- **事实**：`state` 在 `install` 时不被预填充；源码注释 NOTE（"could check the window object for a state"）标注的是 SSR hydration 的预留位置，但当前实现把 hydration 推迟到 store 装配时按 `pinia.state.value[id]` 是否已存在来判断。源码位置: packages/pinia/src/createPinia.ts:12-13（注释）、packages/pinia/src/store.ts:162-169。
- **事实**：devtools 登记受 `__USE_DEVTOOLS__ && IS_CLIENT && typeof Proxy !== 'undefined'` 三重守卫——SSR / 非 client / 无 Proxy 环境不挂 devtools。源码位置: packages/pinia/src/createPinia.ts:31,58。
- **边界**：dispose 后 `_a` 被置 null，注释明确"Once disposed, the pinia instance cannot be used anymore"——实例不可复活。源码位置: packages/pinia/src/createPinia.ts:65-71,78。
- **推断（标注为推断）**：`markRaw(pinia)` 的必要性——防止根容器在某处被包进响应式对象时被深度代理，从而破坏其内部 ref/Map 的引用语义。源码无显式注释，属推断。源码位置: packages/pinia/src/createPinia.ts:22。
- **未理解**：无明显无法解读之处；上述两处推断均已有标注。