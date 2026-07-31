# 插件系统：store 扩展点与混入

> 前置：本章承接「store 装配机器」。在那里我们已经看到 `createSetupStore` 把 options/setup 双形态归一、把返回值按 state/getter/action 三分支自动分类、把 ref 迁进 `pinia.state.value` 保持单一真源。但装配到这一步，store 还只是「框架定义好的骨架」。本章回答的是：**在那副骨架搭好之后、交给业务用之前，怎么让人合法地往里加点东西。**

## 场景与核心思想

库作者或应用开发者经常想给**每一个** store 统一加点东西——调试钩子、测试替身、自动持久化、路由实例注入。如果没有插件系统，只能靠继承或猴子补丁，既脆弱又难和官方更新兼容。用户真正要的不是「再多一个 API」，而是：**在我建好一个 store 之后、交给业务用之前，给我一个介入点。**

Pinia 的解法只有一句话：

> 在每个 store 装配到尾声时，把所有登记过的「扩展函数」挨个跑一遍，它们返回什么对象，就把这个对象原样贴到 store 上——**一个统一钩子，养活 devtools、testing、用户自定义三类消费者。**

这是一个典型的「开闭」设计：需求增减都不碰装配主线，装配机器只负责「遍历 + 贴上去」。

## 一、契约：一个函数，四样上下文

插件系统最小的原语是一个类型契约 `PiniaPlugin`——它就是一个函数。函数长这样：

```ts
// rootStore.ts —— 插件契约（概念）
interface PiniaPlugin {
  (context: PiniaPluginContext): Partial<PiniaCustomProperties> | void
}
```

入参只有一份 `context`，但这份 context 携带了插件可能需要的一切，共四样：

| 字段 | 含义 | 典型用途 |
|------|------|----------|
| `store` | 正在被扩展的那个 store | 往它上面贴属性 |
| `pinia` | 持有它的 Pinia 实例 | 读 `_s` 里别的 store、读全局 state |
| `app` | 当前 Vue 应用 | 注入 app 级依赖（路由、i18n） |
| `options` | 该 store 的定义选项（已整理出 actions 清单） | 按动作名做拦截、按 store 配置分支 |

返回值是「一个对象，或什么都不返回（void）」。**返回的对象会被合并进 store**——这些键值表现得就像原生长在 store 上。这就是 devtools、testing、用户三方共用的唯一扩展点。注意 `options` 不是原始定义，而是装配时整理过的一份拷贝：核心会先 `assign({ actions: {} }, options)` 造出 `optionsForPlugin`，再把分类好的 actions 逐个填进去，让插件拿到的是「整理过的动作清单」。

## 二、扩展槽：`use` 登记，`_p` 收存

有了契约，还得有地方存放已登记的插件。Pinia 实例上挂着两个相关的成员：

- **`use(plugin): Pinia`**——登记一个插件，返回 `this`，因此可以链式 `pinia.use(A).use(B)`。
- **`_p: PiniaPlugin[]`**——「已安装插件」数组，装配时**严格按它的顺序**遍历执行。

`use` 内部有一个关键的时机判断：**如果应用还没挂载（`!this._a`），插件先去「等候队列」`toBeInstalled` 暂存；如果已经挂载，就直接 `_p.push`。** 真正把暂存件搬进 `_p`，是在应用挂载（`install`）那一刻统一完成的——`toBeInstalled` 整体倒入 `_p`，**顺序即登记顺序**。

这条机制把「扩展什么时候真正生效」和「插件什么时候被登记」解耦了：你在 `app.use(pinia)` 之前登记也好、之后登记也好，最终 `_p` 里的顺序都与登记顺序一致。内置的 devtools 扩展，正是在 `createPinia` 末尾经 `pinia.use(devtoolsPlugin)` 登记——它和用户插件走的是同一条路径。

## 三、装配尾声：统一钩子如何被跑起来

把前两节拼起来，就得到了插件在装配流程里的位置。承接 store-assembly 的分类归位，整个尾巴是这样的：

```
useStore() 首次调用（某个 store 第一次被创建）
        │
        ▼
createSetupStore 分类归位
  state → 迁入 pinia.state.value；getter/action 各自归位
        │
        ▼
_s.set(id, store)  注册进实例表（供别的 store 互引、不死循环）
        │
        ▼
定义并挂上热更新方法（_hotUpdate 等）
        │   ← 故意放在插件之前：让插件有机会覆盖它
        ▼
遍历 pinia._p（严格按登记顺序）
  └─ scope.run(() => extender({ store, app, pinia, options }))
        │
        ▼
__DEV__ 合并前响应式检查（普通对象 → PINIA_R1006 警告）
        │
        ▼
assign(store, extensions)  浅合并进 store
        │
        ▼
（hydrate 旧状态 / 返回给调用方）
```

读这段流程要抓住两个细节。**第一，热更新方法被有意放在插件遍历之前。** 注释明说：「把热更新方法放在插件之前，是为了让插件能覆盖它。」加上 `assign` 是「后写覆盖先写」的浅合并，这意味着**插件拥有覆盖 store 任何既有属性（含内部方法）的能力**——这是有意留出的覆盖口，测试替身、用户重写动作都依赖它。

**第二，每个插件都跑在该 store 自己的副作用作用域里（`scope.run(...)`）。** 这个 `scope` 就是 store 创建时建立的那个 `effectScope`。它带来一个直接后果：插件返回的 `ref` / `computed` 会被这个作用域追踪，store `$dispose`（即 `scope.stop()`）时一并回收——插件**无需自己管生命周期**。

下面是装配尾巴的核心代码（按概念精简，真实代码标注见章末「源码对照」）：

```ts
// store.ts —— 装配尾声：跑插件、合并前检查、混入（本章灵魂）
pinia._p.forEach((extender) => {
  const extensions = scope.run(() =>           // 在 store 自己的 effectScope 内执行
    extender({ store, app: pinia._a, pinia, options: optionsForPlugin })
  )!

  if (__DEV__) {
    // 合并前检查：把「会丢响应性的普通对象」揪出来（详见权衡④）
    for (const key in extensions) {
      const value = extensions[key]
      if (typeof value === 'object' && !isRef(value) && !isReactive(value) && !value?.__v_skip) {
        diagnostics.PINIA_R1006({ key, id: $id })
      }
    }
  }

  assign(store, extensions)   // 浅合并进响应式 store
})
```

## 四、最小原理演示：一个会扩展 store 的伪装配尾巴

为了把「统一钩子 + 作用域隔离 + 顺序确定 + 合并前检查」这条权衡链演透，下面是一个几十行的**伪 pinia**。它不追求工程完整、不可独立安装，只追求演透「一个钩子如何被多类消费者复用」。

```ts
// 伪代码：仅演示插件钩子链，非真实实现
import { effectScope, ref, isRef, isReactive } from 'vue'

function createMiniPinia() {
  const _p = []              // 已登记插件，顺序即生效顺序
  const toBeInstalled = []   // 应用挂载前的等候队列

  const mini = {
    use(plugin) {
      // 真实实现里：未挂载 → toBeInstalled.push；已挂载 → _p.push
      toBeInstalled.push(plugin)
      return mini                       // 返回自身，可链式 use().use()
    },
    install() {
      // 应用挂载那一刻：整体搬入正式列表，顺序即登记顺序
      toBeInstalled.forEach((p) => _p.push(p))
    },
    _p,
    buildStore(store) {
      const scope = effectScope()       // 该 store 自己的作用域
      _p.forEach((extender) => {
        const ret = scope.run(() =>     // 关键：在 store 作用域内执行插件
          extender({ store, pinia: mini, options: store.$options })
        )
        // 合并前检查：揪出「会丢响应性的普通对象」
        for (const key in ret) {
          const v = ret[key]
          if (typeof v === 'object' && !isRef(v) && !isReactive(v) && !v?.__v_skip) {
            console.warn(`插件返回的 "${key}" 是普通对象，解构后会丢响应性`)
          }
        }
        Object.assign(store, ret)       // 浅合并进 store
      })
      return scope                      // scope.stop() 时插件副作用一并回收
    },
  }
  return mini
}

// 用法：三类消费者共用同一个钩子
const pinia = createMiniPinia()
pinia
  .use(({ store }) => ({ counter: ref(0) }))      // 注入响应式状态
  .use(({ store }) => ({ reset() { store.counter = 0 } })) // 注入方法
  .use(() => ({ raw: { a: 1 } }))                 // ⚠ 触发丢响应性警告
  .install()

const store = { $options: {}, $id: 'cart' }
const scope = pinia.buildStore(store)

store.counter   // ref(0)，随 scope 生灭
store.reset()   // 方法
store.raw       // { a: 1 }，但已收到警告
```

逐行指回原理：`_p` 数组承担「顺序确定」（权衡③）；`scope.run` 承担「作用域隔离、副作用随 store 生灭」（权衡②）；`forEach` + `Object.assign` 承担「统一钩子、返回值浅合并」（权衡①）；合并前的 `for...in` 检查承担「在解包前分辨普通对象」（权衡④）。

## 五、关键权衡：四条「选择 → 换来 → 代价」

插件系统的全部设计意图，都浓缩在这四条权衡里。每一条都是「做了某个选择 → 换来了什么 → 付出了什么代价」。

**权衡①　统一扩展点（装配末尾跑、返回值浅合并）。**
**换来：** devtools、testing、用户自定义三类消费者共用同一条介入路径，store 能获得任意注入能力；又因 `assign` 后写覆盖先写、且插件排在热更新方法之后，扩展甚至可以覆盖前面装配出的任意同名属性（含内部方法）。**代价：** 插件返回的「普通对象」会被浅合并进响应式 store，**假装**长在响应式 store 上却根本不参与响应式——解构后静默失效。所以必须靠运行时警告（PINIA_R1006）+ 类型空接口双管齐下，约束用户把意图表达清楚（用 `ref`/`markRaw`）。

**权衡②　插件在该 store 自己的副作用作用域内执行（`scope.run`）。**
**换来：** 插件返回的 `ref`/`computed` 自动挂在该 store 作用域下，store `$dispose`（`scope.stop`）时随之一并回收，插件**完全不必自己管生命周期**。**代价：** 插件如果需要「跨多个 store 存活」的长效副作用（比如一个全局的事件总线），就必须**自行另开一个独立 effectScope 隔离**，否则该副作用会绑死在某个 store 上、随它提前销毁。

**权衡③　先暂存再统一入队、严格按登记顺序执行。**
**换来：** 「扩展生效顺序 = 登记顺序」是确定的。这条确定性是测试替身的命根子——`createTestingPinia` 的 spy 插件正是靠**排在最后**，才能把真实动作覆盖掉。同时也让插件生效与「应用何时挂载」这一时机彻底解耦。**代价：** 插件真正生效要等到应用挂载那一刻之后；在那之前，`use` 登记的插件只能排队等候，对还未挂载的应用无法产生任何效果。

**权衡④　在合并进 store 之前检查插件的原始返回值。**
**换来：** 能分辨「插件给的是普通对象、还是响应式值、还是显式跳过（`markRaw`）的值」。这个时机选择是关键——**一旦合并进响应式 store，`ref`/`reactive` 值会被解包，从此和普通对象再也无法区分**，警告就无从下手。注释甚至点明边界：`null` 也被算作对象（`typeof null === 'object'`），所以返回 `{ x: null }` 同样会触发警告。**代价：** 这项检查包在 `__DEV__` guard 内，**生产构建被完全裁掉**——线上即便误注入普通对象也不会有任何提示。

## 六、类型扩展点：两个空接口与声明合并

运行时的钩子解决了「能不能贴上去」，但 TS 用户还会问：贴上去的属性怎么有类型提示？Pinia 的答案是**两个故意留空的接口**：

```ts
// types.ts —— 两个由用户扩展的空接口
export interface PiniaCustomProperties<Id, S, G, A> {}
export interface PiniaCustomStateProperties<S> {}
```

注释写着「Interface to be extended by the user」。Store 的类型通过 `& PiniaCustomProperties<...> & PiniaCustomStateProperties<S>` 把它们组合进来。用户只需在自己的项目里用声明合并补签名：

```ts
// 用户侧（任意 .ts 文件）
declare module 'pinia' {
  export interface PiniaCustomProperties {
    // 给所有 store 补上 router 类型
    router: import('vue-router').Router
  }
}
```

之后任意 `store.router` 在编辑器里都有完整提示。注意插件契约的返回类型是 `Partial<PiniaCustomProperties & PiniaCustomStateProperties> | void`——这意味着**类型和运行时是配套的**：你返回什么键，就该在空接口里声明什么键。

> **易混淆边界：** `globalExtensions.ts` 里也用了 `declare module 'vue'`，但它扩展的是 **Vue 组件实例属性**（`this.$pinia`、devtools 用的 `_pStores`），**不是** store 的插件属性。它和上面这两个空接口是两套独立的「声明合并」手法——别把它们写成同一回事。

## 七、执行轨迹：一次插件注入的全程

把上面的机制串成一个具体例子，看「输入 → 中间态 → 输出」：

- **输入**：一个返回 `{ counter: ref(0), reset: () => {} }` 的插件，外加一个刚分类归位好的空 store。
- **中间态①**：`scope.run` 在该 store 作用域内执行插件，拿到返回对象。
- **中间态②**：合并前检查逐键扫描——`counter` 是 `ref` → 跳过；`reset` 是 `function`（不满足 `typeof === 'object'`）→ 跳过；检查全过，无警告。
- **输出**：`store.counter` 现在是响应式值（解构仍保响应性）；`store.reset` 是方法；二者都挂在该 store 作用域下，`store.$dispose()` 时自动回收。

对比一个反面输入——插件返回 `{ raw: { a: 1 } }`：中间态②里 `raw` 是普通对象、非 ref、非 reactive、无 `__v_skip` → 触发 PINIA_R1006 警告；输出里 `store.raw` 仍然被合并进去了（检查不阻断合并，只警告），但它不参与响应式，解构后是一份静止的快照。这正解释了权衡①的代价为何需要警告兜底。

## 附：源码对照

正文按概念铺陈，下表把核心机制精确指回源码位置（共 5 处），便于回读。

| 机制 | 源码位置 |
|------|----------|
| 装配尾声：遍历 `_p`、`scope.run` 跑插件、合并前检查、`assign` 混入 | `store.ts:716-754` |
| 合并前响应式检查（PINIA_R1006，含 `null` 边界、`__v_skip` 跳过） | `store.ts:734-751` |
| store 自己的 `effectScope`（插件在其中执行、`$dispose` 时回收） | `store.ts:500-502` |
| `use` 登记、`toBeInstalled` 暂存、`install` 时统一入队（顺序即登记顺序） | `createPinia.ts:18-44` |
| 两个用户扩展空接口（`PiniaCustomProperties` / `PiniaCustomStateProperties`） | `types.ts:523-533` |

> 补充：插件契约 `PiniaPlugin` 与上下文 `PiniaPluginContext`（四字段）定义在 `rootStore.ts`；`Pinia` 接口上的 `use` / `_p` 声明也在 `rootStore.ts`，实现在 `createPinia.ts`。`globalExtensions.ts` 扩展的是 Vue 组件实例属性（非 store 属性），属另一套声明合并，不在本章主线。