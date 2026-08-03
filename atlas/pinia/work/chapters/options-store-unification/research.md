# Options Store：双作者语法统一于单一装配路径 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：Pinia 给了两种写 store 的姿势——Options 式（像 Vuex，声明 state/getters/actions 三个字段）和 Setup 式（像 Vue 组合式函数，body 里 ref/computed/function 随意混）。如果两种语法各走一套独立的内部装配逻辑，插件、订阅、SSR、HMR、devtools 都得维护两份、行为还可能分叉。使用者最怕的就是「我用 setup 写的 store，在订阅/插件/devtools 里的行为和 options 写的 store 不一样」。

- **一句话核心思想**：把 Options 式语法**翻译**成一个 Setup 式的 setup 函数，让两种作者语法共用**同一条**内部装配流水线——「两种作者语法、一条装配路径」。

- **设计动机（为什么需要它）**：用「翻译层」换取实现统一与跨语法一致的能力（插件/订阅/SSR/HMR 都只写一份、对两种语法行为相同）。承前去重信号——
  - 装配主干（effectScope 托管、返回值分类、state 镜像进根状态、reactive 包装、「先占位注册再懒装配」）**已在第 4 章『Store 装配』讲透**，本章只看 option store 如何把自己**翻译成**那个 setup 函数；
  - $patch 的双形态与「暂停监听→手动触发一次」批处理**已在第 5 章『状态变更模型』讲透**（$reset 路由回 $patch 在那章作为批处理入口提过），本章的新角度不是批处理本身，而是**为什么 $reset 只有 option store 有**——这是统一路径的必然代价。

- **关键权衡（本 Atlas 核心）**：
  1. 把 option store 的 state 做成「根状态[id] 的 toRefs」而不是独立的 ref → 换来两种语法装配后**状态存储位置完全一致**（都在那棵根状态树上，插件/订阅/SSR 无需区分）→ 代价是 option store 的 state 形状必须**静态声明**（先于 setup 写进根状态），无法像 setup store 那样在 setup body 里命令式创建。
  2. 把每个 getter 包成 computed、actions 原样保留，再 assign 成一个 setup 返回对象 → 换来**完全复用**装配函数的返回值分类逻辑（它本就会识别 ref/computed/function）→ 代价是 option store 的 getter 多了一层 computed 闭包，每次求值都要先设活跃 pinia、再从注册表取 store 实例（为支持 getter 里跨 store 引用）。
  3. ★**核心代价**：option store 因 state 由一个无参工厂 `state()` 静态声明、可随时重新求值出确定初始值，故能**合成**重置方法（再调 state()、经一次 patch 写回）；setup store 的 state 是 setup 闭包里命令式创建的 ref，框架拿不到这个工厂、无法知道如何重建初始值，故重置方法不可用（dev 抛错、prod 静默空操作）。**重置方法的有无，正是「统一到一条路径」的必然代价**——同一条路径无法对两种 state 来源一视同仁。
  4. 用一个布尔标志（语义＝「state 形状是否静态声明」）穿透装配函数，只在三处局部点控制差异（是否需要空占位、是否需要把 setup 里的 ref 迁移进根状态、是否合成重置方法）→ 换来装配主干只有一份、差异点高度局部化 → 代价是这个布尔在阅读装配逻辑时是个「隐藏分支」，需靠注释点明它在哪几处起作用。

- **最小心智模型（3～7 步）**：
  1. defineStore 看 setup 参数是不是函数，判定是 setup 式还是 options 式。
  2. options 式走专门的 options 构造器：先确保根状态[id] 存在（不存在就调 state() 初始化）。
  3. **合成**一个 setup 函数，返回 `{ ...根状态[id] 的 toRefs, ...actions, ...每个 getter 包成的 computed }`。
  4. 把这个 setup 连同「state 形状已知」标志交给同一条装配函数——后续的分类/镜像/reactive 包装/插件/订阅全部走同一路。
  5. 装配函数凭该标志决定三处差异点：跳过空占位、跳过 ref 迁移、合成重置方法。
  6. 用户调重置方法时：重新求值 state() 得初始快照 → 经一次 patch 把当前状态 assign 成初始状态（复用批处理，只发一条订阅）。

- **最小原理演示（替代复刻范围）**：演的是权衡 3＋4——「翻译 + 单一装配路径 + 重置方法的有无」。骨架（每一行对应一个原理点）：
  ```js
  // 唯一装配路径（第 4 章已讲透，此处极简版）
  function assemble(id, setup, { stateShapeDeclared }) {
    if (!stateShapeDeclared && !root[id]) root[id] = {}      // setup 式才占位（权衡4）
    const ret = setup()
    for (const k in ret) {
      const v = ret[k]
      if (isRef(v) && !isComputed(v)) { if (!stateShapeDeclared) root[id][k] = v } // setup 式才迁移（权衡4）
      else if (typeof v === 'function') ret[k] = wrapAction(v, k)
    }
    ret.$reset = stateShapeDeclared                          // ★ 只有 option 能合成（权衡3）
      ? () => onePatch(root[id], options.state())           // state() 可重求值
      : () => { throw 'setup store: $reset 不可用' }
    return ret
  }
  // options 语法 → 翻译成 setup，再走同一条 assemble
  function defineOptionsStore(id, { state, getters, actions }) {
    return assemble(id, () => ({
      ...toRefs(ensureRootState(id, state)),                // state 镜像成 ref（权衡1）
      ...actions,                                           // actions 原样（权衡2）
      ...mapValues(getters, g => computed(() => g.call(store, store))) // getter→computed（权衡2）
    }), { stateShapeDeclared: true })
  }
  // setup 语法 → 直接走同一条 assemble
  function defineSetupStore(id, setup) { return assemble(id, setup, { stateShapeDeclared: false }) }
  ```
  - 应故意省略：effectScope、reactive 包装、插件、订阅、HMR、computed 的真实响应式（用 isRef/isComputed 占位判断即可）、SSR 水合。
  - **演示载体建议**：本仓库是 TS/JS，机制是纯数据流与函数合成、不依赖运行时宿主——建议写成能 `node`/`bun` 直接跑的脚本（能跑最好，非硬要求）。用几个 isRef/computed 的极简 mock 就能演透「翻译 + 统一路径 + 重置方法有无」这三件事，无需拉起 Vue。

- **正文不宜展开的细节**：markRaw 包 computed 的原因（避免被外层 reactive 二次代理）；dev/hot 分支（热更新时 localState 走 `toRefs(ref(state()).value)`）；getter 里 `.call(store, store)` 既传 this 又传首参的来历（让 getter 既能 this. 引用别的 getter、又能用首参）；HMR 热更新里 option vs setup 的 state 迁移差异（整值迁移 vs patchObject 调和）——属第 11 章 HMR；重置方法用 assign 是浅覆盖（只覆盖顶层 key、不删多余 key、不深合并）的边角；option store 专用的 `hydrate` 钩子——属第 13 章 SSR。

- **推荐的一个执行轨迹例子**：输入 `defineStore('cart', { state:()=>({items:0}), getters:{count:s=>s.items}, actions:{add(){this.items++} } })` 后首次 `useStore()` → 中间态：根状态['cart']={items:0}；合成的 setup 返回 `{ items:<toRef>, count:<computed>, add:<fn> }`；装配分类后 items 识别为 state（已在根状态、跳过迁移）、count 识别为 computed、add 包成 action，并合成重置方法 → 输出：一个 reactive store；再调 `store.$reset()` → state() 再得 {items:0} → 一次 patch(assign) → items 回 0，且只触发一次订阅。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 要点 1：defineStore 凭 `typeof setup === 'function'` 区分两种语法，分别路由到 setup 装配 / options 构造器。源码位置: packages/pinia/src/store.ts:879, 902-908
- 要点 2：options 构造器不写装配逻辑，只合成 setup 函数后转交同一条装配函数，第 6 个参数 `true` 即「isOptionsStore」标志。源码位置: packages/pinia/src/store.ts:209
- 要点 3：合成的 setup 返回 `assign(toRefs(根状态[id]), actions, computedGetters)`——三件东西拼成一个 setup 返回对象。源码位置: packages/pinia/src/store.ts:179-206
- 要点 4：option store 的 state 先于 setup 写进根状态（toRefs 镜像），故装配函数对 option store 跳过「创建空占位 {}」和「把 setup 里的 ref 迁移进根状态」两步。源码位置: packages/pinia/src/store.ts:167-170, 273-278, 513-533
- 要点 5：每个 getter 被 `markRaw(computed(...))` 包裹，求值时先 `setActivePinia(pinia)`、再从注册表取 store、再 `getters[name].call(store, store)`。源码位置: packages/pinia/src/store.ts:188-201
- 要点 6：重置方法仅 option store 合成——调 `state()` 取初始快照、再 `$patch(($state)=>assign($state, newState))` 复用批处理；setup store 在 dev 抛错、prod 为 noop。源码位置: packages/pinia/src/store.ts:330-347
- 要点 7：isOptionsStore 标志精确控制三处差异：state 占位守卫、state ref 迁移跳过、重置方法合成。源码位置: packages/pinia/src/store.ts:275, 514, 330

## 关键调用链

defineStore 返回的 useStore → 首次调用且注册表无此 id → 按 `typeof setup === 'function'` 分流：
- options 式：createOptionsStore → 合成 setup(){ toRefs(根状态) + actions + computed(getters) } → createSetupStore(..., isOptionsStore=true)
- setup 式：createSetupStore(..., isOptionsStore=undefined)
→ createSetupStore 主干：分类循环(assign store + toRaw(store)) → 定义 $state → 跑插件 → (option store 且有 hydrate 钩子时) hydrate → 返回 store

源码位置: packages/pinia/src/store.ts:859-908（defineStore 路由）, 149-212（createOptionsStore）, 214-781（createSetupStore）

## 源码摘录（带行号，全文累计 ≤ 30 行）

摘录 1——options 构造器合成的 setup（翻译的心脏；省略 hot 分支与 dev 诊断）：
```ts
// packages/pinia/src/store.ts:166-209
function setup() {
  if (!initialState && (!__DEV__ || !hot))
    pinia.state.value[id] = state ? state() : {}        // ① state 先落根状态
  const localState = toRefs(pinia.state.value[id])       // ② 镜像成 ref（省略 hot 分支）
  return assign(localState, actions,                     // ③ actions 原样
    Object.keys(getters || {}).reduce((cg, name) => {
      cg[name] = markRaw(computed(() => {                 // ④ getter 包成 computed
        setActivePinia(pinia)
        const store = pinia._s.get(id)!
        return getters![name].call(store, store)
      })); return cg
    }, {} as Record<string, ComputedRef>))
}
store = createSetupStore(id, setup, options, pinia, hot, true) // true = isOptionsStore
```

摘录 2——重置方法的条件定义（统一路径的核心代价）：
```ts
// packages/pinia/src/store.ts:330-347
const $reset = isOptionsStore
  ? function $reset(this: _StoreWithState<Id, S, G, A>) {
      const { state } = options as DefineStoreOptions<Id, S, G, A>
      const newState: _DeepPartial<UnwrapRef<S>> = state ? state() : {}
      this.$patch(($state) => { assign($state, newState) })   // 复用 $patch 批处理
    }
  : __DEV__
    ? () => { throw new Error(`🍍: Store "${$id}" is built using the setup syntax and does not implement $reset().`) }
    : noop
```

## 易混淆 / 边界 / 推断

- 事实：option store 的重置方法用 `assign` 是**浅覆盖**——只覆盖 newState 里有的顶层 key，不会删除当前 state 中 newState 没有的 key，也不深合并嵌套对象。源码位置: packages/pinia/src/store.ts:335-338
- 事实：getter 的 `.call(store, store)` 把整个 store 同时当 `this` 和首参传入，所以 getter 函数签名里的 `state` 参数实际收到的是**整个 store**（含 getters/state），而非裸 state——这正是 getter 能引用其他 getter 的原因。源码位置: packages/pinia/src/store.ts:199
- 推断（标注为推断）：option store 能合成重置方法的根本前提是「state 是无参工厂 `state()`、可重复求值出确定初始值」；setup store 的 ref 在闭包里命令式创建、框架拿不到该工厂，故无法自动重置。依据：重置方法分支的唯一判据是 isOptionsStore，而该标志的语义正是「state 形状静态声明」。源码位置: packages/pinia/src/store.ts:330-347
- 事实：option store 的 state 在 setup 内先写进 `pinia.state.value[id]` 再 toRefs 出来；装配函数因此对 option store 跳过「创建空占位」与「把 setup ref 迁移进根状态」——因为 state 本就已落在根状态里。源码位置: packages/pinia/src/store.ts:169, 275, 514
- 未理解（留给后续章）：option store 在 HMR `_hotUpdate` 中用 patchObject 按新形状**调和** state、而 setup store 整值迁移的差异（store.ts:607-622）逻辑较细；本章只点到「option store state 形状已知」这一根因，深入调和细节留给第 11 章 HMR。