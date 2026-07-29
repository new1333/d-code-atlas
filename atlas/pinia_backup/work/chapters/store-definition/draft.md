# store 的定义与实例化

> **前置概念**（来自依赖章节）：`createPinia()` 持有根 effectScope、store 注册表 `_s`、插件管线 `_p` 以及根 state 容器 `state.value`（见「Pinia 根实例与活跃上下文」）；`StoreDefinition`/`StateTree` 等类型契约见「核心类型契约」；发布-订阅原语（`addSubscription`/`triggerSubscriptions`）是 `$subscribe`/`$onAction` 的基石（见「发布-订阅原语」）；dev-only 诊断码 `PINIA_R1xxx` 见「运行时诊断」。本章只讲**一个核心**：`defineStore` 如何返回懒工厂，以及 `createSetupStore` 如何把任意 store「装配」成响应式实例。

---

## 一、defineStore：返回懒工厂 `useStore` 闭包

### 1. 三个签名 = 2 个重载 + 1 个实现

很多人以为 `defineStore` 有「三种重载」，但翻开 `store.ts` 用 `export function defineStore` 搜索只命中 **3 处**，前两处没有函数体（只有返回类型，是给类型系统用的重载），第三处才带函数体（运行时真正执行的实现）：

```ts
// 重载 1：Options Store —— store.ts:828-837
export function defineStore<Id, S, G, A>(
  id: Id,
  options: Omit<DefineStoreOptions<Id, S, G, A>, 'id'>
): StoreDefinition<Id, S, G, A>

// 重载 2：Setup Store —— store.ts:846-855
export function defineStore<Id, SS>(
  id: Id,
  storeSetup: (helpers: SetupStoreHelpers) => SS,
  options?: DefineSetupStoreOptions<Id, /* ... */>
): SetupStoreDefinition<Id, SS>

// 实现：带函数体，运行时唯一入口 —— store.ts:859-953
/*! #__NO_SIDE_EFFECTS__ */   // 标记：未被引用的 store 可被 tree-shake
export function defineStore(id: any, setup?: any, setupOptions?: any): StoreDefinition {
  /* ...返回 useStore 闭包... */
}