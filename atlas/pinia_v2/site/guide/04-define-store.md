# defineStore：useStore 工厂与懒实例化

## 一、先回答一个问题：定义和取用，该不该同时发生

想象你在写一个中型应用，几十个组件都要读写同一份「计数器」状态。最自然的写法是先定义一个状态库，然后在每个组件里取用它：

```ts
const useCounter = defineStore('counter', () => ref(0))
// ...在组件 A、B、C 里
const counter = useCounter()
```

这段代码看似平淡，背后藏着一个被默默解决的问题：**如果「定义」一个状态库就意味着立刻把它建出来**，会发生什么？

- 没被任何组件用到的库也会被强行实例化——纯属浪费；
- 「定义」和「取用」混在一起，你没法做到「先统一注册一堆定义，再在需要的地方按需取实例」；
- 同一个库被多个组件取用时，无法保证拿到的是「全应用唯一的那一份」。

使用者真正想要的是一句话：**我写一行定义，之后在任何地方调一下，就能拿到「全应用唯一、且只在该被用到时才建出来」的那份状态。** 这正是 `defineStore` 要给的承诺。

## 二、核心思想：定义期什么也不建，只造一个「取用入口」

把承诺拆成两半，对应代码里两个完全分离的时刻：

```
定义期（defineStore 被调用）
  └─ 不创建任何实例，只整理参数、把 id 绑进一个闭包，返回「取用入口」useStore

取用期（useStore 被调用）
  └─ 拿到状态根 pinia → 查它的注册表 → 没有就现场装配并缓存，有就直接返回缓存
```

一句话核心思想：**定义时不建任何东西，只造一个取用入口；真到被调用时，才按 id 去注册表里查——没有就现场装配一个并缓存，有就直接返回缓存。** 于是天然得到「懒创建 + 全应用单例」。

要理解取用期那串动作，需要上一章已经搭好的几块积木。

## 三、前置原语（来自上一章 createPinia / active-pinia）

`defineStore` 自己不持有状态，它依赖状态根（Pinia 实例）上的几个原语。这些都在上一章建立过，这里只回顾它们「是什么、本章怎么用」：

| 原语 | 它是什么 | 本章怎么用 |
|---|---|---|
| `pinia._s` | 挂在每个 Pinia 实例上的 **store 注册表**，一张 `id → store` 的 Map | 单例缓存的核心载体：装配前 `has(id)` 查、装配时 `set(id)` 写、返回前 `get(id)` 取 |
| `activePinia` | 一个 **模块级可变指针**，指向「当前活跃的 Pinia」 | 组件注入上下文之外（store 互引、SSR）也能取到状态根的兜底手段 |
| `setActivePinia` | 直接把 `activePinia` 赋值为给定实例 | 取用入口解析到 pinia 后立刻调用它，让装配期间的内部代码能取到正确实例 |
| `piniaSymbol` | provide/inject 用的 **InjectionKey** | 组件内的取用入口靠 `inject(piniaSymbol)` 自动拿到当前应用的 pinia |

注意一个关键事实：**单例的键是 `id`，但注册表 `_s` 挂在具体的 Pinia 实例上**。也就是说单例作用域 =「某个 Pinia 实例 + 某个 id」。不同 Pinia 实例下同一个 id 是不同的 store——这正是 SSR 多请求隔离的基础（每个请求各建一个 Pinia，各自 `_s` 互不干扰）。

## 四、定义期：工厂的工厂，零副作用

`defineStore` 对外有三个签名，但运行时只认一个实现。前两个重载（配置式、函数式）**只为 TypeScript 类型推断服务**，让两种写法各自得到精确的 `state/getter/action` 类型；真正干活的只有实现签名：

```ts
// 三个对外重载，运行时都合流到唯一一个实现
defineStore(id, options)                  // ① 配置式：options 描述 state/getters/actions
defineStore(id, storeSetup, options?)     // ② 函数式：一个 setup 函数返回一切
defineStore(id, setup?, setupOptions?)    // ← 实现签名：真正运行的只有它
```

两种形态在入口处用一句话判定分流，之后共用**同一条取用路径**：

```ts
const isSetupStore = typeof setup === 'function'
// 配置式的 options 在第 2 参，函数式的 options 在第 3 参
options = isSetupStore ? setupOptions : setup
```

分流之后呢？`defineStore` **没有** 调用任何装配函数，只是整理好参数、把 `id / isSetupStore / setup / options` 绑进一个闭包，然后返回 `useStore`：

```ts
function useStore(pinia?, hot?) {
  // ...取用期的全部逻辑都在这里（下一节展开）...
}
useStore.$id = id   // 暴露 id 给 Options API 的映射辅助函数
return useStore     // 取用入口本身是个闭包，状态极小
```

> **这就是「工厂的工厂」**：`defineStore` 是一个「造工厂的工厂」，它返回的 `useStore` 才是真正「取实例」的工厂。

这里有个被刻意标注的细节：`defineStore` 上方写着 `/*! #__NO_SIDE_EFFECTS__ */`，注释是 `// allows unused stores to be tree shaken`。它向打包器声明——**调用这个函数没有副作用**。于是只要你定义了某个 store 却从没在任何地方 `useXxx()` 取用过，整段定义连同它引用的 setup 函数都会被摇树优化删除，bundle 不会因此膨胀。

## 五、取用期：一次 `useStore()` 调用的执行轨迹

真正建实例的动作发生在 `useStore` 被调用时。一条完整的轨迹如下：

```
useStore() 被调用
  ├─ 解析状态根 pinia：显式传参 → inject(piniaSymbol) → null
  ├─ setActivePinia(pinia)：把它设为当前活跃指针
  ├─ pinia._s.has(id) ?
  │     否 → createSetupStore / createOptionsStore（装配内部会顺手 _s.set 缓存）
  │     是 → 跳过装配
  └─ return pinia._s.get(id)   ← 无论走哪条路，最终都从缓存取那一个
```

对应的核心代码（已略去 DEV 报错与 HMR 分支，只看主链）：

```ts
function useStore(pinia?, hot?) {
  const hasContext = hasInjectionContext()
  // 解析状态根：测试旁路 → 显式传参 → 组件注入 → null
  pinia =
    (__TEST__ && activePinia?._testing ? null : pinia) ||
    (hasContext ? inject(piniaSymbol, null) : null)
  if (pinia) setActivePinia(pinia)

  // ...DEV 下若无活跃指针，抛友好错误并指引 app.use(pinia)...

  pinia = activePinia!

  // 仅当注册表无此 id 才装配（装配过程内部会自行 _s.set 写入缓存）
  if (!pinia._s.has(id)) {
    if (isSetupStore) createSetupStore(id, setup, options, pinia)
    else createOptionsStore(id, options, pinia)
  }

  // 恒从缓存取值：永远返回注册表里那一个 → 单例
  const store = pinia._s.get(id)!
  return store
}
```

逐段对应心智模型：

1. **解析 pinia**（优先级：显式传参 → 组件注入 → 兜底为 null）。`hasInjectionContext()` 先探一下当前有没有组件注入上下文：有就 `inject(piniaSymbol)` 自动取当前应用的 pinia，没有就只能靠显式传参或后续的 `activePinia` 兜底。
2. **设活跃指针**。解析到 pinia 后立刻 `setActivePinia(pinia)`，目的是让装配机器内部（getter/action 里）再次读取「当前活跃 pinia」时能拿到正确实例。
3. **懒判定**。`if (!pinia._s.has(id))` 是整个机制的命门：注册表里**有**就直接跳过装配，**没有**才去现场装配。而装配过程内部会顺手 `pinia._s.set(id, store)` 把自己写进注册表（注释才说 *creating the store registers it in `pinia._s`*）。
4. **恒从缓存取值**。装配与否，最后都执行 `pinia._s.get(id)!` 再返回。这一行看似多余——刚装配完为什么不直接返回新对象？它保证了「永远返回注册表里那一个」：哪怕装配逻辑将来发生变化，外部拿到的也一定是缓存里登记的那份。

把整条链走一遍：

```ts
const useCounter = defineStore('counter', () => ref(0))
// 此刻：拿到 useCounter 闭包，useCounter.$id === 'counter'
//       但尚未创建任何实例，注册表里也没有 'counter'

const a = useCounter(pinia)   // 注册表无 'counter' → 现场装配 → 写入注册表 → 返回
const b = useCounter(pinia)   // 注册表已命中 → 跳过装配 → a === b ✅ 单例成立
```

## 六、从零复刻：用几十行演透「懒创建 + 单例」

剥掉双形态分流、解析优先级、测试旁路、HMR、devtools……那些都不是「懒单例」之所以成立的内核。内核只有一个：**一张以 id 为键的注册表，加上一个只在首次装配的取用入口**。下面这段几十行的实现就把它演透了，每一行都对应上面某个原理点：

```js
// 每张状态根自带一张「id -> 实例」注册表
function makePinia() { return { _s: new Map() } }

function defineStore(id, setup) {
  // 【对应核心思想/权衡1】定义期零副作用：不建实例，只返回取用入口
  function useStore(pinia) {
    // 【对应权衡2】懒创建 + 单例缓存：注册表里有就直接拿，没有才现场装配并缓存
    if (!pinia._s.has(id)) pinia._s.set(id, setup())
    // 【对应心智模型第4步】恒从缓存取值：永远返回注册表里那一个
    return pinia._s.get(id)
  }
  useStore.$id = id   // 暴露 id 给映射辅助函数
  return useStore     // 取用入口本身是闭包，绑定了 id
}
```

跑一遍它：第一次 `useStore(pinia)` 时 `_s` 没有 `id`，于是执行 `setup()` 装配并写入；第二次 `_s` 已有，直接 `get` 返回——`a === b`。**全部奥秘就是这一句 `if (!pinia._s.has(id))`。** 真实的 `defineStore` 在这之外加的解析、旁路、HMR，都是为更复杂的运行环境做的加固，不改变这个内核。

## 七、关键权衡

**权衡 1：定义期零副作用，换「未用即删」**
- **设计**：`defineStore` 不立即建 store，只返回 `useStore` 闭包，并用 `#__NO_SIDE_EFFECTS__` 显式声明无副作用。
- **换来**：未被任何地方取用的 store 对打包器而言无副作用，会被摇树优化删除，bundle 不无谓膨胀。
- **代价**：用户每次取用都要先调一次取用入口——多一层闭包调用，且这个入口本身是个带状态的闭包。

**权衡 2：以 id 为键的注册表做单例缓存，换「全应用唯一实例」**
- **设计**：实例缓存在状态根的 `_s: Map<string, store>` 上，命中即返回、未命中才装配。
- **换来**：同一个 id（在同一个 Pinia 下）全应用单例，不同组件多次取用拿到的是同一个实例，跨组件共享天然成立。
- **代价**：实例的生命周期挂在「状态根」上而非组件上——组件卸载不会销毁 store，需要时得手动释放，否则常驻内存。

**权衡 3：pinia 解析有隐式优先级 + 测试旁路，换「组件内外都能取、测试可整体接管」**
- **设计**：解析优先级 = 显式传参 → 组件 `inject(piniaSymbol)` → 兜底；测试模式下若当前活跃的是 testing pinia（带 `_testing` 标志），则**显式传入的参数被强制置 null**，落到 inject/activePinia 路径，让 testing pinia 的全局指针接管。
- **换来**：组件内无参也能自动取到、组件外（SSR、store 互引）可手传或靠全局指针、测试时测试替身能整体接管取用入口。
- **代价**：这套优先级是**隐式的**——新手不易理解「为什么我什么都没传，`useStore()` 也能工作」，也不易察觉测试模式下显式传参会被无视。

> 双形态（配置式 / 函数式）在入口处一句 `typeof setup === 'function'` 判定分流后，共用上面这同一条取用路径。配置式内部还要再套一层适配器才能归一到唯一的装配机器——那是下一章「store 装配机器」的主题，本章不展开。

## 八、源码对照

本章涉及的核心实现集中在以下几处（按阅读顺序）：

- **取用主链全貌**：`store.ts:859` —— `defineStore` 实现签名与其内部 `useStore` 闭包的完整主体（解析、设活跃指针、懒判定、恒从缓存取值）。
- **装配内注册点**：`store.ts:494` —— 装配机器内部 `pinia._s.set($id, store)`，即「creating the store registers it in `pinia._s`」的落点。
- **注册表类型定义**：`rootStore.ts:104` —— `_s: Map<string, StoreGeneric>`，挂在每个 Pinia 实例上的 store 注册表。