# 核心类型契约与全局声明 · 源码精读

> 本章 sourceFiles：`packages/pinia/src/types.ts`、`packages/pinia/src/globalExtensions.ts`、`packages/pinia/src/env.ts`。
> 三者都是「契约层」：types.ts 提供贯穿全库的类型骨架（几乎全为纯类型，运行时产物只有 `isPlainObject` 与 `MutationType` 枚举）；globalExtensions.ts 通过模块增强给 Vue 注入 `$pinia`；env.ts 仅 1 行环境探测常量。下文每条论断均标注源码位置（相对 `work/source`，POSIX 路径）。

## 概念要点

### A. env.ts —— 单常量环境探测

- 全文件只有一条导出：`export const IS_CLIENT = typeof window !== 'undefined'`。
  源码位置: packages/pinia/src/env.ts:1
- 语义：运行时探测是否存在 `window` 对象，用于区分浏览器客户端与 SSR（Node 等无 `window` 环境）。
- 它**不是** Vue 提供的响应式工具，而是一个朴素的布尔常量，在打包后直接内联为 `true`/`false`，便于 tree-shake 掉仅客户端分支。

### B. globalExtensions.ts —— Vue 模块声明增强（纯副作用文件）

- 文件用 `declare module 'vue' { ... }` 对 Vue 的类型做「声明合并（declaration merging）」增强。文件末尾 `export {}`（源码位置: packages/pinia/src/globalExtensions.ts:25）只是为了把本文件标记为**模块**，从而让 `declare module 'vue'` 生效——它本身不导出任何运行时值。
- 增强内容（源码位置: packages/pinia/src/globalExtensions.ts:4-22）：
  - `interface GlobalComponents {}`（第 7 行）：**空接口**。注释说明这是为了不破坏基于顺序的 auto import 类型（引用 PR #2730）。
  - `interface ComponentCustomProperties`（第 8-21 行）新增两项：
    - `$pinia: Pinia`（第 12 行）：组件实例上可访问应用级 Pinia 实例。
    - `_pStores?: Record<string, StoreGeneric>`（第 20 行）：`@internal`，devtools 用来列举当前实例化的 store。
- 两个 import 均为 **type-only**：`import type { Pinia } from './rootStore'`、`import type { StoreGeneric } from './types'`（源码位置: packages/pinia/src/globalExtensions.ts:1-2）。说明此文件完全在类型层工作。
- 该文件在 index.ts 中以 `export * from './globalExtensions'`（源码位置: packages/pinia/src/index.ts:79）被引入，目的是「被引入即触发模块增强」，并不传递任何具体导出。

### C. types.ts —— 贯穿全库的类型骨架

#### C1. 基础类型

- `StateTree = Record<PropertyKey, any>`（源码位置: packages/pinia/src/types.ts:14）：所有 store state 的根类型。`PropertyKey = string | number | symbol`，故 state 的键可以是任意属性键。
- `isPlainObject`（源码位置: packages/pinia/src/types.ts:16-29）：**运行时**类型守卫（本章为数不多的运行时产物之一）。判定逻辑为四项合取：
  1. `o` 真值；
  2. `typeof o === 'object'`；
  3. `Object.prototype.toString.call(o) === '[object Object]'`；
  4. `typeof o.toJSON !== 'function'`。
  - 第 4 项特意排除带 `toJSON` 的对象（如 `Date`），即 Date 等不被视为「普通 state 对象」。
  - 有两个重载（第 16-18 行泛型版、第 19-22 行 `any` 版），最终返回 `o is StateTree`。
- `_DeepPartial<T>`（源码位置: packages/pinia/src/types.ts:36）：递归 `Partial`，`{ [K in keyof T]?: _DeepPartial<T[K]> }`。注释明确「For internal use **only**」「Used by Store['$patch']」。是 `$patch` 对象重载的入参类型。

#### C2. MutationType 枚举（运行时产物）

- `enum MutationType`（源码位置: packages/pinia/src/types.ts:43-68）：订阅回调（subscription）的变更类型。
  - `direct = 'direct'`：直接改 state（`store.x = ...`、`store.$state.x = ...`、`store.list.push(...)`）。
  - `patchObject = 'patch object'`：`$patch` 传对象。
  - `patchFunction = 'patch function'`：`$patch` 传函数。
- **易混淆点**：枚举的字符串值带**空格**（`'patch object'`、`'patch function'`），不是 camelCase。注释 `// TODO: can we change these to numbers?`（第 39 行）暗示作者曾想改用数字。
- 它是值（enum 编译为对象），在 index.ts 中以 `export { MutationType } from './types'`（源码位置: packages/pinia/src/index.ts:52）作为**值**导出，而其余几乎全部以 `export type` 导出。

#### C3. Subscription（`$subscribe`）相关类型

- `_SubscriptionCallbackMutationBase`（源码位置: packages/pinia/src/types.ts:73-90）：内部基类，含 `type: MutationType`、`storeId: string`、`events?: DebuggerEvent[] | DebuggerEvent`。`events` 标注「🔴 DEV ONLY, DO NOT use for production code」，来自 Vue 的 reactivity debugging。
- 三个子类型（按 mutation 类型区分，用字面量 `type` 收窄）：
  - `SubscriptionCallbackMutationDirect`（源码位置: packages/pinia/src/types.ts:97-101）：`type: MutationType.direct`，`events: DebuggerEvent`（单个且必填）。
  - `SubscriptionCallbackMutationPatchObject<S>`（源码位置: packages/pinia/src/types.ts:107-118）：`type: MutationType.patchObject`，`events: DebuggerEvent[]`，且带 `payload: _DeepPartial<UnwrapRef<S>>`（即 `$patch` 传入的对象）。
  - `SubscriptionCallbackMutationPatchFunction`（源码位置: packages/pinia/src/types.ts:124-133）：`type: MutationType.patchFunction`，`events: DebuggerEvent[]`，**没有 payload**（第 132 行的 payload 被注释掉了）。
- `SubscriptionCallbackMutation<S>`（源码位置: packages/pinia/src/types.ts:138-141）：上述三者的**联合类型**。
- `SubscriptionCallback<S>`（源码位置: packages/pinia/src/types.ts:146-158）：`(mutation: SubscriptionCallbackMutation<S>, state: UnwrapRef<S>) => void`。第二个参数 `state` 注释为「与 `store.$state` 相同」。

#### C4. Action 监听（`$onAction`）相关类型

- `_StoreOnActionListenerContext<Store, ActionName extends string, A>`（源码位置: packages/pinia/src/types.ts:165-202）：内部类型。字段：
  - `name: ActionName`；
  - `store: Store`；
  - `args`：`A extends Record<ActionName, _Method> ? Parameters<A[ActionName]> : unknown[]`（条件式推断 action 参数）；
  - `after`：action 完成钩子，回调参数为 `Awaited<ReturnType<A[ActionName]>>`——即若 action 返回 Promise 会被**解包**为 resolved 值；
  - `onError`：失败钩子，注释「Return `false` to catch the error and stop it from propagating」。
- `StoreOnActionListenerContext<Id,S,G,A>`（源码位置: packages/pinia/src/types.ts:208-219）：对外类型。当 `_ActionsTree extends A`（泛化/未知 actions 场景）退化为 `_StoreOnActionListenerContext<StoreGeneric, string, _ActionsTree>`；否则用映射类型 `{ [Name in keyof A]: Name extends string ? _StoreOnActionListenerContext<Store<...>, Name, A> : never }[keyof A]` 产出「每个 action 一个上下文」的联合。
- `StoreOnActionListener<Id,S,G,A>`（源码位置: packages/pinia/src/types.ts:224-237）：`$onAction` 的回调签名。注意第 235 行 `{ } extends A ? _ActionsTree : A`——因 `StoreOnActionListenerContext` 对 `{}` 会产出 `never`，这里做了兜底。

#### C5. Store 的「内部属性」与「带 state 的基类型」

- `StoreProperties<Id>`（源码位置: packages/pinia/src/types.ts:242-302）：定义 store 实例上的一批**内部/开发期**字段（这些是真实运行时属性，非纯类型）：
  - `$id: Id`；
  - `_p: Pinia`（`@internal`，挂载的 pinia 实例）；
  - `_getters?: string[]`（devtools 取 getter 列表，生产环境移除）；
  - `_isOptionsAPI?: boolean`（devtools 判断 Options vs Setup）；
  - `_customProperties: Set<string>`（插件新增属性的键集合，devtools 展示用）；
  - `_hotUpdate(useStore: StoreGeneric): void`、`_hotUpdating: boolean`、`_hmrPayload: { state: string[]; hotState: Ref<StateTree>; actions: _ActionsTree; getters: _ActionsTree }`（均为 HMR/开发期用，`@internal`）。
- `_StoreWithState<Id,S,G,A>`（源码位置: packages/pinia/src/types.ts:307-407）：`extends StoreProperties<Id>`，承载实例级运行时 API：
  - `$state: UnwrapRef<S> & PiniaCustomStateProperties<S>`（第 316 行，注释说明 set 它会内部走 `$patch`）；
  - `$patch` 有**两个重载**：对象版 `(_DeepPartial<UnwrapRef<S>>) => void`（第 323 行）；函数版（第 332-335 行）`$patch<F extends (state: UnwrapRef<S>) => any>(stateMutator: ReturnType<F> extends Promise<any> ? never : F): void`——**用条件类型显式禁止 async**（注释「prevents the user from using `async`」）；
  - `$reset(): void`、`$subscribe(callback, options?: { detached?: boolean } & WatchOptions): () => void`、`$onAction(callback, detached?): () => void`、`$dispose(): void`（第 340-406 行）。`$subscribe`/`$onAction` 均返回「移除回调的函数」，并在组件内调用时随卸载自动清理（除非 `detached`）。

#### C6. action/getter 的「展开」工具类型

- `_Method = (...args: any[]) => any`（源码位置: packages/pinia/src/types.ts:414）。
- `_StoreWithActions<A>`（源码位置: packages/pinia/src/types.ts:426-430）：把每个 action 映射为保留 `infer P`/`infer R` 的函数签名（`A[k] extends (...args: infer P) => infer R ? (...args: P) => R : never`）。
- `_StoreWithGetters<G>` = `_StoreWithGetters_Readonly<G> & _StoreWithGetters_Writable<G>`（源码位置: packages/pinia/src/types.ts:436-437），分两半：
  - `_StoreWithGetters_Readonly<G>`（源码位置: packages/pinia/src/types.ts:442-448）：键筛选条件为「`G[K]` 是函数 **或** `ComputedRef extends G[K]`」；值类型为 `G[K] extends (...args) => infer R ? R : UnwrapRef<G[K]>`——即 getter 的返回值类型被解包。
  - `_StoreWithGetters_Writable<G>`（源码位置: packages/pinia/src/types.ts:453-459）：仅当 `G[K] extends WritableComputedRef<any>` 时纳入，值为 `G[K] extends Readonly<WritableComputedRef<infer R>> ? R : never`。注释指出 TS 限制（microsoft/TypeScript#43826）：动态键下无法区分 getter/setter 不同类型。

#### C7. Store / StoreGeneric / StoreDefinition —— 三大对外类型

- `Store<Id,S,G,A>`（源码位置: packages/pinia/src/types.ts:464-476）：**核心类型**，是一个大型**交集（intersection）**：
  - `_StoreWithState<Id, S, G, A>`（含 `$id`/`$patch`/`$reset`/`$subscribe`/`$onAction`/`$dispose`/`$state` 及全部内部字段）；
  - `UnwrapRef<S>`——**state 的每个键被「拍平」直接挂到 store 上**（所以能 `store.xxx` 访问 state）；
  - `_StoreWithGetters<G>`；
  - `(_ActionsTree extends A ? {} : A)`——仅当 actions 非泛化时才把 actions 并入；
  - `PiniaCustomProperties<Id, S, G, A>`（插件属性增强点）；
  - `PiniaCustomStateProperties<S>`（插件 state 增强点）。
  - 四个泛型参数都有默认值（`Id=string, S={}, G={}, A={}`），且 `G`/`A` 的约束被注释掉（注释「in this type we forget about this because otherwise the type is recursive」，见第 421 行）。
- `StoreGeneric`（源码位置: packages/pinia/src/types.ts:483-488）：`Store<string, StateTree, _GettersTree<StateTree>, _ActionsTree>`。注释「Generic and type-unsafe version of Store. Doesn't fail on access with strings」——故意放宽类型，让「不关心具体 store 形状」的通用函数（如内部装配、devtools、HMR）能接受任意 store 而不被类型系统卡住。
- `StoreDefinition<Id,S,G,A>`（源码位置: packages/pinia/src/types.ts:493-518）：**`defineStore()` 的返回类型**。本身是可调用签名 `(pinia?: Pinia | null | undefined, hot?: StoreGeneric) => Store<Id,S,G,A>`，并带静态属性 `$id: Id` 与 `_pinia?: Pinia`（`@internal`，dev only HMR 用）。

#### C8. 插件增强点（空接口，靠声明合并扩展）

- `PiniaCustomProperties<Id,S,G,A>`（源码位置: packages/pinia/src/types.ts:523-528）：**空接口**。注释「Interface to be extended by the user when they add properties through plugins」。这是「`pinia.use()` 往 store 实例上加属性」的类型扩展缝。
- `PiniaCustomStateProperties<S>`（源码位置: packages/pinia/src/types.ts:533）：**空接口**。注释「Properties that are added to every `store.$state` by `pinia.use()`」。这是「往 `$state` 上加属性」的扩展缝。
  - 两者都在 `Store` 的交集里出现（types.ts:475-476），所以用户/插件 `declare module 'pinia'` 扩展这两个接口后，类型会自动并入每个 store。

#### C9. Tree 类型与 Setup Store 提取工具

- `_GettersTree<S>`（源码位置: packages/pinia/src/types.ts:539-543）：`Record<string, ((state: UnwrapRef<S> & UnwrapRef<PiniaCustomStateProperties<S>>) => any) | (() => any)>`。
- `_ActionsTree = Record<string, _Method>`（源码位置: packages/pinia/src/types.ts:549）。
- 三个 `_*FromSetupStore_Keys`（源码位置: packages/pinia/src/types.ts:555-573）：从 setup store 返回对象中按值类型**提取键**——
  - `_ExtractStateFromSetupStore_Keys`：`SS[K] extends _Method | ComputedRef ? never : K`（既非方法也非 computed → 归为 state）；
  - `_ExtractActionsFromSetupStore_Keys`：`SS[K] extends _Method ? K`；
  - `_ExtractGettersFromSetupStore_Keys`：`SS[K] extends ComputedRef ? K`。
- `_Extract*FromSetupStore<SS>`（源码位置: packages/pinia/src/types.ts:584-600）：对上面的键做 `Pick`，并把 `undefined | void` 的 setup 返回兜底为 `{}`。注释「Type that enables refactoring through IDE」。
- `_UnwrapAll<SS> = { [K in keyof SS]: UnwrapRef<SS[K]> }`（源码位置: packages/pinia/src/types.ts:579）。

#### C10. defineStore 的 Options 家族

- `DefineStoreOptionsBase<S, Store>`（源码位置: packages/pinia/src/types.ts:607）：**空接口**，option/setup 两种 store 共享的扩展点。
- `DefineStoreOptions<Id,S,G,A>`（源码位置: packages/pinia/src/types.ts:613-674）：**Options Store** 的选项。`extends DefineStoreOptionsBase<S, Store<Id,S,G,A>>`。字段：
  - `id: Id`；
  - `state?: () => S`（注释强调「**Must be an arrow function**」以保证类型）；
  - `getters?: G & ThisType<UnwrapRef<S> & _StoreWithGetters<G> & PiniaCustomProperties> & _GettersTree<S>`（第 633-635 行，`ThisType` 让写 getter 时 `this` 有类型）；
  - `actions?: A & ThisType<A & UnwrapRef<S> & _StoreWithState<...> & _StoreWithGetters<G> & PiniaCustomProperties>`（第 640-647 行，同理给 action 的 `this`）；
  - `hydrate?(storeState: UnwrapRef<S>, initialState: UnwrapRef<S>): void`（第 673 行，**SSR** 专用：当 state 含 client-only ref/customRef/computed、单纯拷贝不够时手动 hydrate，示例见注释第 658-668 行，如 `useLocalStorage`）。
- `DefineSetupStoreOptions<Id,S,G,A>`（源码位置: packages/pinia/src/types.ts:680-693）：**Setup Store** 的选项。`actions?: A` 注释明确「Added by useStore(). SHOULD NOT be added by the user」——setup store 的 actions 是 `useStore()` 提取出来的，不是用户在 options 里写的。
- `DefineStoreOptionsInPlugin<Id,S,G,A>`（源码位置: packages/pinia/src/types.ts:698-710）：**插件看到的 options 形态**。`= Omit<DefineStoreOptions<Id,S,G,A>, 'id' | 'actions'> & { actions: A }`。即插件拿到的 options **去掉了 `id`**，且 `actions` **一定存在**（注释「Defaults to an empty object if no actions are defined」）。

#### C11. 杂项工具类型

- `_Empty {}`（源码位置: packages/pinia/src/types.ts:715）。
- `_Simplify<T>`（源码位置: packages/pinia/src/types.ts:721-723）：`_Empty extends T ? _Empty : { [key in keyof T]: T[key] } & {}`——把复杂交集/映射「摊平」成可读对象类型，纯为 IDE 可读性。

## 关键调用链 / 依赖关系

> 本章三个文件是「契约层」，被其它章节的运行时模块消费。以下是它们与外部的连接（仅列出方向与落点，不展开对方实现——那属于其它章节）。

1. **types.ts ↔ rootStore.ts（Pinia 类型）**
   types.ts 第 9 行 `import { Pinia } from './rootStore'`，用 `Pinia` 标注 `_p: Pinia`（types.ts:253）等。注意此处是**值导入（非 `import type`）**，但 `Pinia` 在 rootStore.ts:63 实为 `interface`（纯类型），故编译期即被擦除。对比 globalExtensions.ts:1 用的是 `import type { Pinia }`——两处导入风格不一致（一处值导入、一处类型导入），效果相同。
   源码位置: packages/pinia/src/types.ts:9；packages/pinia/src/globalExtensions.ts:1；packages/pinia/src/rootStore.ts:63

2. **types.ts → index.ts（对外导出）**
   index.ts:16-51 以 `export type { ... }` 批量导出 types.ts 中几乎所有类型；唯独 `MutationType` 在 index.ts:52 以**值** `export { MutationType }` 导出（因它是 enum）。
   源码位置: packages/pinia/src/index.ts:16-52

3. **globalExtensions.ts → index.ts → Vue 类型增强**
   index.ts:79 `export * from './globalExtensions'`。该导出不传任何具名值，纯粹是为了「被 import 一次」从而触发 `declare module 'vue'` 的声明合并，使全局 `$pinia`、`_pStores` 类型可用。
   源码位置: packages/pinia/src/index.ts:79；packages/pinia/src/globalExtensions.ts:4-22

4. **env.ts (IS_CLIENT) → 运行时模块**
   `IS_CLIENT` 被 4 处消费，模式均为「开发期/devtools 能力 × 客户端」双重门控：
   - store.ts:50 导入，用于 store.ts:479、562、696、728、932（如 `__USE_DEVTOOLS__ && IS_CLIENT`、`__DEV__ && IS_CLIENT`）；
   - rootStore.ts:20 导入，用于 rootStore.ts:51 `if (!pinia && !IS_CLIENT)`（SSR 下无活跃 pinia 的报错分支）；
   - createPinia.ts:4 导入，用于 createPinia.ts:31、58（devtools 接入门控）；
   - devtools/file-saver.ts:10 导入，用于 file-saver.ts:110 `!IS_CLIENT`（服务端无 `saveAs`）。
   源码位置: packages/pinia/src/env.ts:1

5. **PiniaCustom* 空接口 → 插件机制**
   `PiniaCustomProperties`/`PiniaCustomStateProperties` 在 `Store` 交集里（types.ts:475-476）出现，又在 rootStore.ts:11,16 被导入、用于 `PiniaPlugin` 的返回类型 `Partial<PiniaCustomProperties & PiniaCustomStateProperties> | void`（rootStore.ts:171）。这就是「插件返回的对象会被并入 store」的类型契约基础。
   源码位置: packages/pinia/src/types.ts:523-533,475-476；packages/pinia/src/rootStore.ts:171

## 源码摘录（带行号）

### env.ts 全文
```ts
export const IS_CLIENT = typeof window !== 'undefined'
```
源码位置: packages/pinia/src/env.ts:1

### globalExtensions.ts 全文
```ts
import type { Pinia } from './rootStore'
import type { StoreGeneric } from './types'

declare module 'vue' {
  // This seems to be needed to not break auto import types based on the order
  // https://github.com/vuejs/pinia/pull/2730
  interface GlobalComponents {}
  interface ComponentCustomProperties {
    /** Access to the application's Pinia */
    $pinia: Pinia
    /** @internal */
    _pStores?: Record<string, StoreGeneric>
  }
}

// normally this is only needed in .d.ts files
export {}
```
源码位置: packages/pinia/src/globalExtensions.ts:1-26

### types.ts —— 核心类型 Store 的交集构造
```ts
export type Store<
  Id extends string = string,
  S extends StateTree = {},
  G /* extends GettersTree<S>*/ = {},
  A /* extends ActionsTree */ = {},
> = _StoreWithState<Id, S, G, A> &
  UnwrapRef<S> &
  _StoreWithGetters<G> &
  (_ActionsTree extends A ? {} : A) &
  PiniaCustomProperties<Id, S, G, A> &
  PiniaCustomStateProperties<S>
```
源码位置: packages/pinia/src/types.ts:464-476

### types.ts —— $patch 禁止 async 的条件类型
```ts
$patch<F extends (state: UnwrapRef<S>) => any>(
  // this prevents the user from using `async` which isn't allowed
  stateMutator: ReturnType<F> extends Promise<any> ? never : F
): void
```
源码位置: packages/pinia/src/types.ts:332-335

### types.ts —— 插件看到的 options（去 id、actions 必在）
```ts
export interface DefineStoreOptionsInPlugin<
  Id extends string, S extends StateTree, G, A,
> extends Omit<DefineStoreOptions<Id, S, G, A>, 'id' | 'actions'> {
  actions: A
}
```
源码位置: packages/pinia/src/types.ts:698-710

## 易混淆 / 需 Writer 注意

- **MutationType 的字符串值带空格**（`'patch object'`、`'patch function'`），且作者 TODO 想改成数字（types.ts:39）。Writer 若举运行时例子（如判断 mutation.type）须用带空格的字面量，不要写成 `patchObject`。
- **`SubscriptionCallbackMutationPatchFunction` 没有 `payload`**（types.ts:124-133，payload 被注释）。只有 patchObject 变体带 payload。Writer 讲 `$subscribe` 收到的 mutation 时要区分三种变体。
- **`$patch` 函数重载显式禁止 async**（types.ts:332-335，`ReturnType<F> extends Promise<any> ? never : F`）。这是个值得展开的设计点：Pinia 用类型系统在编译期就拦掉「async stateMutator」，因为 `$patch(function)` 内部依赖同步快照。
- **Store 是大型交集，state 被「拍平」**（types.ts:470 `UnwrapRef<S>`）。所以 `store.foo` 既来自 state、也可能来自 getter/action/插件属性——同名优先级由交集顺序与具体装配决定，Writer 讲「store 上能访问到什么」时要说明这个扁平结构。
- **StoreProperties/Store 携带大量 `_` 前缀内部字段**（`_p`/`_getters`/`_isOptionsAPI`/`_customProperties`/`_hotUpdate`/`_hmrPayload` 等，types.ts:242-302）。这些**不是纯类型**，而是 devtools/HMR 真正读写的运行时属性；生产环境部分会被移除（注释多处标 `Removed in production`）。Writer 讲 store 实例结构时应提及这层「内部元数据」。
- **StoreGeneric 是「故意类型不安全」的别名**（types.ts:483-488）。它不是用户 API，而是供 Pinia 自身通用代码（装配、devtools、HMR）绕开严格类型用。Writer 不要把它当成「推荐的泛型 store 类型」来推荐。
- **`PiniaCustomProperties` / `PiniaCustomStateProperties` 是空接口扩展缝**（types.ts:523-533）。它们是插件机制的类型基石：用户/插件通过 `declare module 'pinia'` 声明合并来扩展。Writer 讲插件扩展能力时这是关键入口。
- **`isPlainObject` 排除带 `toJSON` 的对象**（types.ts:27，`typeof o.toJSON !== 'function'`）。故 `Date`、`Moment` 等不被当普通 state 对象——这点在讲 `$patch` 深合并/mergeReactiveObjects 的前置判定时可能相关（mergeReactiveObjects 属于 store-instance-api 章，此处仅提示判定源）。
- **`DefineStoreOptionsInPlugin` 与用户写的 `DefineStoreOptions` 形状不同**（types.ts:698-710）：插件拿到的是 `Omit<..., 'id'|'actions'> & { actions: A }`，即无 `id`、`actions` 必在。Writer 讲插件 context 时要区分「用户视角的 options」与「插件视角的 options」。
- **types.ts 几乎全是纯类型**，运行时产物仅 `isPlainObject`（函数）与 `MutationType`（enum）。Writer 描述本章时可强调「契约层/编译期为主、运行时极轻」，与后续运行时章节（store.ts 等）形成对照。
- **types.ts 对 `Pinia` 用值导入而 globalExtensions.ts 用 type 导入**（types.ts:9 vs globalExtensions.ts:1）。这是风格不一致的小细节，不影响行为（`Pinia` 是 interface，值导入会被擦除），但若 Writer 做「导入规范」点评可提及。

## 未理解 / 待确认

- `_StoreWithGetters_Writable` 中 `G[K] extends Readonly<WritableComputedRef<infer R>> ? R : never`（types.ts:458）的 `Readonly<WritableComputedRef<...>>` 包装语义未完全确认其必要性；注释指向 TS#43826（动态键下 getter/setter 类型无法分离）。推断：这是为「可写计算属性 getter」分支保留值类型，但精确机制建议结合 test-dts 用例佐证（test-dts 属其它目录，本章未深入）。
```ts
export type _StoreWithGetters_Writable<G> = {
  [K in keyof G as G[K] extends WritableComputedRef<any>
    ? K
    : never]: G[K] extends Readonly<WritableComputedRef<infer R>> ? R : never
}
```
源码位置: packages/pinia/src/types.ts:453-459