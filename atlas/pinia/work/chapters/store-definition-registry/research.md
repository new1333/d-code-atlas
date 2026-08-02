# defineStore：懒注册与 store 注册表 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：
  一个项目里有几十上百个状态模块，每个组件、每个路由守卫、每个工具函数都想用其中几个。如果"定义 = 实例化"，模块加载时所有 store 全建起来——既无法 tree-shake、又让初始化非常重；如果"每次用都新建"——状态就再也不是单例、跨组件同步就废了。更头疼的是两个 store 互相依赖（A 用 B、B 又用 A），如果"建完才能给别人用"，就会无限递归。

- **一句话核心思想**：
  **「工厂不立即生产、按需查表注册；先发空名片进通讯录，谁要用谁再补全」**——`useStore` 是查表入口而非工厂调用，未命中才创建，创建的瞬间就把半成品塞进表里。

- **设计动机（为什么需要它）**：
  把"定义 store 的形状"和"实例化 store"解耦：模块顶层只声明形状，实例化推迟到第一次有人用。同时让多个 store 之间可以通过"按 id 取"的方式互相引用，而不需要在加载期解决依赖顺序。最后，让"setup 外"的调用方（路由守卫、API 拦截器、单测）也能拿到正确的 pinia 实例。

- **关键权衡（4 条，本 Atlas 核心原料）**：
  1. **「懒实例化 + Map 缓存 + `#__NO_SIDE_EFFECTS__` 标注」→ 换来未用 store 可被 tree-shake、同一 pinia 内永远单例；代价是首次调用要做完整 setup（跑 effectScope、分类返回值），有可见的初始化成本，HMR 还必须专门设计"已注册的 store 如何热替换"。**
  2. **「跑 setup 前先把半成品 store 写进注册表」→ 换来 A 引用 B、B 引用 A 这种循环引用不死递归（A 调 B 时 B 已在表里，哪怕还不完整）；代价是 setup 函数体内拿到的"对方 store"是个不完整对象，不能立即读对方的属性，getter 必须延迟到首次求值时再从注册表懒取（不能闭包捕获半成品引用）。**
  3. **「全局模块级单例 activePinia 兜底」→ 换来"setup 外调用 useStore"的极强便利（路由守卫、API、worker、test 都能用）；代价是 SSR 多请求共享同一全局变量，必须在每请求入口显式 `setActivePinia(new pinia)` 防止跨请求状态污染，dev 下 getActivePinia 还会在没 inject 时抛诊断码 R1004 提醒。**
  4. **「显式参数 + inject + activePinia 三路兜底，并额外给测试模式开一个 `_testing` 后门」→ 换来"组件内隐式 / 外部显式 / 测试桩强制覆盖"三种使用姿势都自然；代价是优先级链路隐晦（测试模式 → 显式参数 → inject → 全局 fallback），新人不易一眼看懂"为什么不传 pinia 也能跑"。**

- **最小心智模型（6 步）**：
  1. 顶层模块加载时，调用 `defineStore(id, setupOrOptions)` —— 这一步只把 id/setup/options 收进闭包、把 id 挂到返回函数上，**完全不创建 store**。
  2. 业务代码（组件、守卫、test）第一次调 `useStore(pinia?)` —— 函数才真正开始工作。
  3. **解析 pinia**：测试模式优先用全局活跃实例；否则按"显式参数 → 组件内 inject(Symbol) → 全局活跃实例"三路兜底；拿到后立刻 `setActivePinia(pinia)`。
  4. **查注册表**：注册表里 `has(id)`？命中 → 直接跳到第 6 步。
  5. **未命中**：调用底层构建器；构建器在**跑 setup 之前**就把半成品 store（只含 `$id`/`$patch` 等骨架）写进注册表，然后再去装配真正的 state/getter/action。
  6. **从注册表 `get(id)` 拿到完整 store**（即便是刚创建的）返回给调用方；同一 pinia 后续任何调用都走第 4 步命中分支，零成本取单例。

- **最小原理演示（含演示载体建议）**：
  - **应演示**：一个 **30~50 行的极简 store 注册表 + useStore 工厂**，刻意演「**循环引用如何因半成品注册而不死递归**」这条最关键的权衡。核心是：useStore 内部 `if (registry.has(id)) return registry.get(id)`；构建器入口立刻 `registry.set(id, halfBuilt)` 再跑用户 setup；setup 内调对方的 useStore 时，对方哪怕半成品也已能拿到引用。
  - **应故意省略**：响应式包装（不需要 Vue，用 plain object 即可演机制）、effectScope、插件、订阅、HMR、devtools、SSR 测试模式、computed/getter 分类。
  - **演示载体建议**：**TS/JS 脚本，可 `node`/`bun run` 直接跑**（不需要 Vue 工具链）。用一个 `Map<string, Store>` 模拟注册表、一个 `let activePinia` 模拟全局单例。打印 setup 内拿到的"对方 store"是不是不完整（属性还没填），并验证最终双方装配完毕后互相持有的引用有效。重点演"先注册半成品"这一行的存在与否、对死递归的影响。
  - 这段演示**演的是「关键权衡第 2 条」**：先发空名片 → 换循环引用不死 → 代价是 setup 内拿到的对方不完整。

- **正文不宜展开的细节**：
  - useStore 函数上挂的 `_pinia` 字段（dev only，devtools 用）。
  - 组件实例上挂的 `_pStores` 缓存（devtools 用于反查"哪些组件用了这个 store"）。
  - defineStore 的三个 TypeScript 重载签名精确差异（setup / options / fallback）。
  - HMR 路径用 `'__hot:' + id` 临时注册一个新 store、再 `_hotUpdate` 替换旧 store 的细节 —— 交给 hmr 章。
  - 测试模式 `activePinia._testing` 标记的语义和 createTestingPinia 如何设置它 —— 交给 testing-pinia 章。

- **推荐的一个执行轨迹例子**：
  - **输入**：模块顶层 `useA = defineStore('a', () => { const b = useB(); return { count: ref(0), bMsg: () => b.msg } })`，`useB` 反过来 setup 内 `useA()`。
  - **关键中间态**：用户在组件里调 `useA()` → 注册表 has('a') = false → 构建 a、立刻 set('a', 半成品A) → 跑 a 的 setup → setup 内 `useB()` → 注册表 has('b') = false → 构建 b、set('b', 半成品B) → 跑 b 的 setup → setup 内 `useA()` → **这次 has('a') = true（虽然 a 半成品）→ 返回半成品 a 的引用** → b 装配完成 → a 的 setup 拿到完整 b → a 装配完成。
  - **输出**：a、b 都装配完毕、互相持有的引用最终都有效。如果改成"先跑完 setup 再注册"，就会 a→b→a→b→… 无限递归爆栈。这一行差异就是本机制存在的全部理由。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- `defineStore` 在模块加载时被调用，但它**不创建 store**，只把 id/setup/options 收进闭包，返回一个 `useStore` 函数；返回前把 id 作为属性挂在 `useStore.$id` 上，让闭包外（如 mapHelpers）也能读到。函数整体被标注 `/*! #__NO_SIDE_EFFECTS__ */`，告知 bundler 调用 defineStore 本身无副作用、未用到的 store 可被 tree-shake。
  源码位置: packages/pinia/src/store.ts:858-953

- `useStore(pinia?, hot?)` 是真正的"按需实例化 + 查表"入口。pinia 解析优先级为：**测试模式 + 全局活跃实例带 `_testing` 标记 → 强制忽略显式参数**；否则按 **显式参数 → `inject(piniaSymbol, null)` → null** 三路。拿到 pinia 后立刻 `setActivePinia(pinia)` 把它写进模块级全局变量；解析失败且 `__DEV__` 下无 activePinia 时直接抛错，链接到官方 SSR 文档。
  源码位置: packages/pinia/src/store.ts:883-900

- 注册表是 Pinia 实例上的 `_s: Map<string, StoreGeneric>`，由 `createPinia()` 初始化为空 Map；`useStore` 末尾一律 `pinia._s.get(id)!` 取 store（绝不直接用刚创建的本地引用，强制走表）。
  源码位置: packages/pinia/src/createPinia.ts:52
  源码位置: packages/pinia/src/store.ts:902-917

- "懒注册"的核心判定：`if (!pinia._s.has(id))` 才走 `createSetupStore` 或 `createOptionsStore`。两个分支通过 `isSetupStore = typeof setup === 'function'` 在 defineStore 入口判定。命中分支后**不再 create**，保证同一 pinia 内 store 永远是单例。
  源码位置: packages/pinia/src/store.ts:879-882
  源码位置: packages/pinia/src/store.ts:902-909

- "半成品先注册"是循环引用安全的根因。`createSetupStore` 在跑用户 setup **之前**先 `pinia._s.set($id, store)`（store 此刻只有 `$id`、`$patch`、`$onAction`、`$subscribe`、`$dispose` 等骨架属性，state/getter/action 还没装配）。代码上方的注释明确写出"so the setup of stores can instantiate each other before they are finished without creating infinite loops"。
  源码位置: packages/pinia/src/store.ts:491-494

- 半成品注册的代价由 getter 承担：option store 的每个 getter 在 computed 内部用 `pinia._s.get(id)!` 重新取 store（而不是闭包捕获外层半成品），保证 getter 真正被求值时拿到的是已装配完毕的 store。这种"延迟取"是"先注册半成品"的必要配套。
  源码位置: packages/pinia/src/store.ts:188-200

- 三路 pinia 解析里"全局 activePinia 兜底"由独立的模块级变量支撑：`rootStore.ts` 用 `export let activePinia` + `setActivePinia` 维护一个全局单例。`getActivePinia()` 在 dev 下且非客户端（即 SSR）发现既无 inject 又无 activePinia 时，触发诊断码 **PINIA_R1004**，提示"useStore 是 composable、应在 setup 顶部调用或显式传 pinia"。
  源码位置: packages/pinia/src/rootStore.ts:27-58
  源码位置: packages/pinia/src/diagnostics.ts:28-32

- 测试模式特殊分支：`__TEST__ && activePinia && activePinia._testing` 时把传入的 pinia 参数强制改成 `null`，让 `createTestingPinia()` 设置的 `_testing: true` 实例自动接管所有 useStore 调用，免去单测里每处都显式传 pinia。
  源码位置: packages/pinia/src/store.ts:884-889

- 注销路径同样通过注册表：`$dispose()` 调 `scope.stop()` 停 effectScope 后 `pinia._s.delete($id)`，把 store 从注册表移除，下次 useStore 会重建。HMR 也复用注册表：用 `'__hot:' + id` 临时造一个新 store、调旧 store 的 `_hotUpdate` 替换内容、再 `pinia._s.delete(hotId)` 清掉临时键。
  源码位置: packages/pinia/src/store.ts:349-354
  源码位置: packages/pinia/src/store.ts:919-930

## 关键调用链

```
defineStore(id, setupOrOptions)        // 仅闭包，不创建
   └─> useStore.$id = id; return useStore

useStore(pinia?, hot?)                  // 第一次或后续每次调用都走这里
   ├─> 解析 pinia：测试模式 _testing || 显式参数 || inject(piniaSymbol) || null
   ├─> setActivePinia(pinia)
   ├─> if (!pinia._s.has(id)):
   │      ├─> createSetupStore(id, setup, options, pinia)         // setup 路径
   │      │     ├─> pinia._s.set($id, halfBuiltStore)             // ★ 半成品先入表
   │      │     ├─> scope.run(() => setup({ action }))            // 用户 setup
   │      │     │     └─> (用户 setup 内可能调别的 useStore)
   │      │     ├─> 分类 setup 返回值为 state/getter/action
   │      │     ├─> assign(store, setupStore) + assign(toRaw(store), setupStore)
   │      │     ├─> 跑插件 pinia._p.forEach(...)
   │      │     └─> isListening = true; return store
   │      └─> createOptionsStore(id, options, pinia)              // options 路径
   │            └─> 内部组装 setup → 调上面的 createSetupStore(...,isOptionsStore=true)
   └─> return pinia._s.get(id)!                                   // 强制走表
```

源码位置: packages/pinia/src/store.ts:859-953（defineStore/useStore）
源码位置: packages/pinia/src/store.ts:214-502（createSetupStore 顶部到 set 半成品）
源码位置: packages/pinia/src/store.ts:149-212（createOptionsStore 翻译为 setup）

## 源码摘录（带行号，全文累计 ≤ 30 行）

**摘录 A：useStore 的 pinia 解析链（三路兜底 + 测试模式后门）**
```ts
// store.ts:883-890
function useStore(pinia?: Pinia | null, hot?: StoreGeneric): StoreGeneric {
  const hasContext = hasInjectionContext()
  pinia =
    // in test mode, ignore the argument provided as we can always retrieve a
    // pinia instance with getActivePinia()
    (__TEST__ && activePinia && activePinia._testing ? null : pinia) ||
    (hasContext ? inject(piniaSymbol, null) : null)
  if (pinia) setActivePinia(pinia)
```

**摘录 B：注册表查-创建-取 三段**
```ts
// store.ts:902-917
if (!pinia._s.has(id)) {
  // creating the store registers it in `pinia._s`
  if (isSetupStore) {
    createSetupStore(id, setup, options, pinia)
  } else {
    createOptionsStore(id, options as any, pinia)
  }
  /* istanbul ignore else */
  if (__DEV__) {
    // @ts-expect-error: not the right inferred type
    useStore._pinia = pinia
  }
}

const store: StoreGeneric = pinia._s.get(id)!
```

**摘录 C：半成品先入表（循环引用安全的根因；注释直接点明设计意图）**
```ts
// store.ts:491-494
// store the partial store now so the setup of stores can instantiate each other before they are finished without
// creating infinite loops.
pinia._s.set($id, store as Store)
```

**摘录 D：getter 内懒取 store（半成品注册的必要配套）**
```ts
// store.ts:188-200（精简）
computedGetters[name] = markRaw(
  computed(() => {
    setActivePinia(pinia)
    const store = pinia._s.get(id)!   // ← 每次求值懒取，避免捕获半成品
    return getters![name].call(store, store)
  })
)
```

（累计约 26 行，符合 ≤30 行约束；每段都对应钩子里某条权衡或步骤。）

## 易混淆 / 边界 / 推断

- **事实**：`useStore` 即便在 `__DEV__ && hot` 路径里临时创建一个 `'__hot:' + id` 的新 store，最终也不会把它留在注册表里——只是用来调旧 store 的 `_hotUpdate`，然后立刻 `pinia._s.delete(hotId)` 清掉临时键。原 id 对应的 store 始终保留。
  源码位置: packages/pinia/src/store.ts:919-930

- **事实**：`useStore` 上挂载 `_pinia`（dev only，set 在第一次创建后）和 `$id`（defineStore 时就挂），这两个属性不是给用户用的——`_pinia` 给 devtools 反查、`$id` 给 mapHelpers 拼属性名（如 `useCounterStore.$id + 'Store'`）。
  源码位置: packages/pinia/src/store.ts:911-914
  源码位置: packages/pinia/src/store.ts:951

- **推断（标注为推断）**：`useStore._pinia` 只在 `__DEV__` 下赋值，大概率是因为生产环境没人在外部检查它，且 devtools 依赖它做"创建时绑定的 pinia 实例"反查；prod 下省一次赋值。

- **推断（标注为推断）**：`useStore` 末尾不直接返回刚创建的本地 `store` 引用、而是强制 `pinia._s.get(id)!`，目的应是让 HMR `_hotUpdate` 路径下"调用方拿到的永远是注册表里的当前 store"——hot 替换发生在 set 之后、get 之前，调用方就能拿到最新版本。

- **事实**：option store 路径里 getter 用 `pinia._s.get(id)!` 而不是闭包里那个 `store` 变量（即外层半成品）——这是直接证据，证明"延迟取"是配套设计，而非偶然写法。
  源码位置: packages/pinia/src/store.ts:192

- **事实**：测试模式后门 `activePinia._testing` 只在 `__TEST__` 构建里生效，生产/常规 dev 构建里这行条件短路，不会影响正常优先级。
  源码位置: packages/pinia/src/store.ts:888

- **未理解**：`useStore._pinia = pinia` 注释写 "not the right inferred type"，这个赋值在 prod 下完全跳过，是否在某些 devtools 反射场景以外还有别的内部消费方——暂未在本章 sourceFiles 里找到，建议交给 devtools-integration 章节核实。

- **事实**：`Pinia` 接口的 `_s: Map<string, StoreGeneric>` 字段标注 `@internal`，但 mapHelpers 和 HMR 等系统层模块都会直接读写它，事实上是 Pinia 跨模块共享的"主注册表"。
  源码位置: packages/pinia/src/rootStore.ts:99-104