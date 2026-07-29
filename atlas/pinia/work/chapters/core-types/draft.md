# 核心类型契约与全局声明

> 本章精读 Pinia 的「契约层」：`packages/pinia/src/` 下的 `env.ts`、`globalExtensions.ts`、`types.ts`。它们几乎不产生运行时代码，却用 TypeScript 类型系统为整个库立下骨架——后续所有运行时模块（store 装配、插件、devtools、HMR）都围着这套契约转。
>
> 下文源码位置以 `types.ts:L14` 这样的简写标注，均相对 `work/source/packages/pinia/src/`。

本章自底向上，从最轻的一行常量讲起，依次到 Vue 模块增强，最后落到贯穿全库的 `types.ts`。三者关系如下：

```
env.ts            globalExtensions.ts           types.ts
IS_CLIENT ──┐    declare module 'vue' ──┐      StateTree / isPlainObject / MutationType
(运行时常量) │    $pinia / _pStores      │      $patch / Store / StoreGeneric / StoreDefinition
            │    (类型层注入 Vue)        │      PiniaCustom* 插件扩展缝
            └── 被 store.ts / rootStore.ts 等 4 处消费
                       │
                       └─→ Store 等类型 ←── types.ts 定义
```

一句话点题：**`Store` 是用 TypeScript 交集（intersection）拼装出来的类型**——它不是单一 interface，而是 6 个部分的交集。本章的目标就是把这句话拆开，让你看到这 6 个成员各自是什么。

## 一、env.ts —— 单常量环境探测

整文件只有一行（`env.ts:1`）：

```ts
export const IS_CLIENT = typeof window !== 'undefined'
```

- **语义**：运行时探测当前环境是否存在 `window` 对象。浏览器里有 `window`，Node/SSR 渲染期没有。
- **它不是 Vue 响应式工具**，而是一个朴素的布尔常量。打包后它会被直接内联为 `true`/`false`，便于 bundler 把仅客户端的分支 tree-shake 掉。
- **输入 / 输出样例**：

  | 运行环境 | `typeof window` | `IS_CLIENT` | 用途 |
  |---|---|---|---|
  | 浏览器 / 主线程 | `'object'` | `true` | 启用 devtools、文件下载等 |
  | Node SSR | `'undefined'` | `false` | 跳过客户端能力、走 SSR 报错分支 |

- **被谁消费**：`IS_CLIENT` 被四处导入，消费模式高度统一——「**开发期 / devtools 能力 × 客户端**」双重门控。例如 `rootStore.ts:51` 的 `if (!pinia && !IS_CLIENT)`：SSR 下若拿不到活跃 pinia 实例就报错；`store.ts` 中多处形如 `__DEV__ && IS_CLIENT`，即「既要开发环境、又要是浏览器」才走 devtools 分支。它作为「契约」给了整库一个统一的客户端探测口径。

## 二、globalExtensions.ts —— Vue 模块声明增强

这个文件**没有运行时导出**，却能让任何 Vue 组件实例上凭空多出类型正确的 `$pinia`。全文如下（`globalExtensions.ts:1-25`）：

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
    _pStores?: Record<string, StoreGeneric>
  }
}

// normally this is only needed in .d.ts files
export {}
```

逐点拆解：

1. **`declare module 'vue' { ... }` 是「声明合并」（declaration merging）**。它不是修改 Vue 源码，而是告诉 TypeScript：「请把花括号里的成员并入 Vue 自带的 `vue` 模块类型」。这是 TypeScript 的模块增强（module augmentation）机制。
2. **增强了两处**（`globalExtensions.ts:8-21`）：
   - `interface ComponentCustomProperties` 新增 `$pinia: Pinia`（组件实例可直接访问应用级 Pinia 实例）与 `_pStores?`（`@internal`，devtools 用来列举已实例化的 store）。
   - `interface GlobalComponents {}` 是**空接口**，注释说明它只为不破坏基于顺序的 auto import 类型（见 PR #2730）。
3. **两个 import 都是 `import type`**（`globalExtensions.ts:1-2`）——纯类型导入，编译期擦除，零运行时开销。这也呼应了「契约层」定位。
4. **末尾 `export {}`**（`globalExtensions.ts:25`）是点睛之笔：它本身不导出任何值，唯一作用是把本文件**标记为一个「模块」**（而非全局脚本）。只有模块文件里的 `declare module 'vue'` 才会被 TS 当作对该模块的增强；脚本文件里的同名声明会被当成全局污染。注释「normally this is only needed in .d.ts files」正是在解释这个反常之处。
5. **触发机制**：`index.ts:79` 用 `export * from './globalExtensions'` 引入它。该 export 不传递任何具名值，纯粹是「**被 import 一次**」——只要 Pinia 被项目引入，这个副作用声明合并就生效，全局 `$pinia` 类型随之可用。

## 三、types.ts —— 贯穿全库的类型骨架

这是本章主菜。`types.ts` 有七百余行，但**几乎全是纯类型**，真正的运行时产物只有两个：函数 `isPlainObject` 与枚举 `MutationType`。我们按自底向上的顺序，从根类型讲起。

### 3.1 根类型 StateTree 与 isPlainObject 守卫

所有 store 的 state，无论形状如何，根类型都是（`types.ts:14`）：

```ts
export type StateTree = Record<PropertyKey, any>
```

`PropertyKey = string | number | symbol`，所以 state 的键可以是任意属性键——这是「能装下任意 state」的最宽松契约。

`isPlainObject` 是本章为数不多的运行时产物，一个类型守卫（`types.ts:16-29`）：

```ts
export function isPlainObject<S extends StateTree>(
  value: S | unknown
): value is S
export function isPlainObject(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  o: any
): o is StateTree {
  return (
    o &&
    typeof o === 'object' &&
    Object.prototype.toString.call(o) === '[object Object]' &&
    typeof o.toJSON !== 'function'
  )
}
```

它是两个重载：泛型版（`types.ts:16-18`）与 `any` 版（`types.ts:19-29`），最终都返回 `o is StateTree`。判定逻辑是四项**合取**（全部为真才返回 true）：

| # | 条件 | 排除什么 |
|---|---|---|
| 1 | `o` 真值 | 排除 `null`/`undefined`/`0` 等 |
| 2 | `typeof o === 'object'` | 排除原始值 |
| 3 | `Object.prototype.toString.call(o) === '[object Object]'` | 排除数组、Map、Set 等内置对象 |
| 4 | `typeof o.toJSON !== 'function'` | **排除带 `toJSON` 的对象（如 `Date`）** |

第 4 项最值得注意——它特意把 `Date`、`Moment` 这类带 `toJSON` 的对象**排除**出「普通 state 对象」之列。输入输出样例：

```
isPlainObject({ a: 1 })          // true
isPlainObject([])                // false  （条件 3，数组 toString 是 [object Array]）
isPlainObject(new Map())         // false  （条件 3）
isPlainObject(new Date())        // false  （条件 4，Date.prototype.toJSON 是函数）
isPlainObject(null)              // false  （条件 1）
```

这个守卫是 `$patch` 对象深合并（`mergeReactiveObjects`，属 store-instance-api 章）的前置判定源——它决定了「哪些对象可以被当普通 state 递归合并」。

### 3.2 MutationType 枚举（运行时产物）

第二个运行时产物是订阅回调里的变更类型枚举（`types.ts:43-68`）：

```ts
// TODO: can we change these to numbers?
export enum MutationType {
  direct = 'direct',
  patchObject = 'patch object',
  patchFunction = 'patch function',
}
```

三个变体对应三种改 state 的方式：

- `direct = 'direct'`：直接改，如 `store.x = ...`、`store.$state.x = ...`、`store.list.push(...)`。
- `patchObject = 'patch object'`：`$patch` 传对象。
- `patchFunction = 'patch function'`：`$patch` 传函数。

⚠️ **易错点**：枚举的字符串值**带空格**（`'patch object'`、`'patch function'`），不是 camelCase。源码第 39 行还有一句 `TODO: can we change these to numbers?`，暗示作者曾想改用数字。若你在 `$subscribe` 回调里判断 `mutation.type`，**必须用带空格的字面量**，写成 `'patchObject'` 会永远匹配失败。

因为它是 `enum`（编译为对象，是值而非纯类型），`index.ts:52` 把它作为**值** `export { MutationType }` 导出，而 `types.ts` 中其余几乎所有东西都是 `export type` 导出。

在 `$subscribe` 回调里，`mutation` 的类型是三者联合，靠字面量 `type` 收窄。区分示例如下：

```ts
store.$subscribe((mutation, state) => {
  switch (mutation.type) {
    case MutationType.direct:
      // mutation.events 是单个 DebuggerEvent（必填），无 payload
      break
    case MutationType.patchObject:
      // mutation.events 是数组；mutation.payload 是 $patch 传入的对象
      console.log('对象补丁内容：', mutation.payload)
      break
    case MutationType.patchFunction:
      // mutation.events 是数组；⚠️ 没有 payload（payload 被注释掉了，types.ts:132）
      break
  }
})
```

注意 patchFunction 变体**没有 `payload`**（`types.ts:124-133`，该字段被注释），只有 patchObject 变体带 `payload: _DeepPartial<UnwrapRef<S>>`。

### 3.3 $patch 的双重重载：_DeepPartial 与「禁止 async」

`_DeepPartial<T>` 是 `$patch` 对象重载的入参类型（`types.ts:36`），是递归版的 `Partial`，注释明确「For internal use **only**」：

```ts
export type _DeepPartial<T> = { [K in keyof T]?: _DeepPartial<T[K]> }
```

`$patch` 有两个重载（`types.ts:323` 与 `types.ts:332-335`），第二个重载用条件类型**在编译期禁止 async**，是 Pinia 类型设计的得意之笔：

```ts
$patch<F extends (state: UnwrapRef<S>) => any>(
  // this prevents the user from using `async` which isn't allowed
  stateMutator: ReturnType<F> extends Promise<any> ? never : F
): void
```

机制拆解：

- 泛型 `F` 约束为「接收 state、返回任意值」的函数。
- 入参类型是 `ReturnType<F> extends Promise<any> ? never : F`——**如果 `F` 的返回值是 Promise，就把入参类型变成 `never`**，于是 `async (state) => {...}` 这样的实参无法赋给 `never`，TS 直接报错。
- 为什么必须同步？因为 `$patch(function)` 内部依赖同步的状态快照，async 会让 mutation 时序无法预测。Pinia 用类型系统把这类误用拦在编译期，而非运行时。

### 3.4 Store —— 大型交集的构造

终于回到开篇的论断。`Store` 的定义（`types.ts:464-476`）正是一个由 6 个成员拼成的交集：

```ts
export type Store<
  Id extends string = string,
  S extends StateTree = {},
  G /* extends GettersTree<S>*/ = {},
  A /* extends ActionsTree */ = {},
> = _StoreWithState<Id, S, G, A> &   // ① 实例级运行时 API + 内部字段
  UnwrapRef<S> &                      // ② state 被拍平，直接挂到 store 上
  _StoreWithGetters<G> &              // ③ getter 解包后挂到 store 上
  (_ActionsTree extends A ? {} : A) & // ④ 仅当 actions 具体时并入 actions
  PiniaCustomProperties<Id, S, G, A> &// ⑤ 插件「实例属性」扩展缝
  PiniaCustomStateProperties<S>       // ⑥ 插件「state 属性」扩展缝
```

这就是「Store 是 TS 交集拼装」论断的全部落点。把 6 个成员逐一对应到你能用到的能力：

```
store.$id / store.$patch / store.$reset / store.$subscribe / store.$onAction / store.$dispose
store.$state          ←─── ① _StoreWithState<...>（extends StoreProperties）
                          （含 _p/_getters/_hmrPayload 等内部元数据）
store.count           ←─── ② UnwrapRef<S>（state 拍平：state.count 直接变 store.count）
store.doubleCount     ←─── ③ _StoreWithGetters<G>（getter 返回值被 UnwrapRef 解包）
store.increment()     ←─── ④ (_ActionsTree extends A ? {} : A)（actions 非泛化才并入）
store.$router(插件加) ←─── ⑤ PiniaCustomProperties（用户 declare module 扩展）
store.$state.$x       ←─── ⑥ PiniaCustomStateProperties（插件往 $state 加属性）
```

要点：

- **state 被「拍平」**（成员 ②，`UnwrapRef<S>`）。这是为什么你能直接 `store.xxx` 访问 state 里的字段——它们被解包后铺到了 store 实例上。同理 getter（成员 ③）也把返回值解包后铺上来。
- **成员 ④ 的条件表达式**：`_ActionsTree extends A ? {} : A`。当 `A` 是泛化/未知 actions（退化为 `_ActionsTree`）时并入 `{}`，否则才把具体 `A` 并入。这样能避免在「不知道 actions 形状」时类型出错。
- **四个泛型都有默认值**（`Id=string, S={}, G={}, A={}`），且 `G`/`A` 的约束被注释掉了——源码第 421 行注释「in this type we forget about this because otherwise the type is recursive」，因为带约束会让类型递归不终止。
- **内部元数据**：成员 ① 通过 `StoreProperties<Id>`（`types.ts:242-302`）带上一批 `_` 前缀字段——`_p`（挂载的 pinia 实例）、`_getters?`、`_isOptionsAPI?`、`_customProperties`、`_hotUpdate()`、`_hmrPayload` 等。它们**不是纯类型**，而是 devtools/HMR 真正读写的运行时属性，生产环境部分会被移除（注释多处标 `Removed in production`）。

### 3.5 StoreGeneric 与 StoreDefinition

围绕 `Store` 还有两个对外类型（`types.ts:483-518`）：

```ts
export type StoreGeneric = Store<
  string, StateTree, _GettersTree<StateTree>, _ActionsTree
>
```

`StoreGeneric` 是 **「故意类型不安全」的别名**（`types.ts:483-488`），注释原话：「Doesn't fail on access with strings」。它把四个泛型参数全部放宽到最宽形态，让 Pinia 自身的通用代码（装配、devtools、HMR）能接受任意 store 而不被严格类型卡住。**它不是用户 API**，不要当成「推荐的泛型 store 类型」。

```ts
export interface StoreDefinition<Id=string, S=..., G=..., A=...> {
  (pinia?: Pinia | null | undefined, hot?: StoreGeneric): Store<Id,S,G,A>
  $id: Id
  _pinia?: Pinia  // @internal，dev only HMR 用
}
```

`StoreDefinition` 是 **`defineStore()` 的返回类型**（`types.ts:493-518`）：它本身是一个**可调用签名**（带 `pinia`/`hot` 两个参数），并携带静态属性 `$id`。这就是为什么 `const useStore = defineStore(...)` 后，`useStore` 既能当函数调用（`useStore()` 得到 store 实例），又能读 `useStore.$id`。

三者关系一句话：**`StoreDefinition` 是「工厂」，`Store` 是「产品」，`StoreGeneric` 是「把产品标签撕掉后的通用货」**。

### 3.6 PiniaCustom* —— 插件机制的两个扩展缝

成员 ⑤⑥ 来自两个**空接口**（`types.ts:523-533`）：

```ts
export interface PiniaCustomProperties<Id=...,S=...,G=...,A=...> {}
// Interface to be extended by the user when they add properties through plugins

export interface PiniaCustomStateProperties<S=...> {}
// Properties that are added to every `store.$state` by `pinia.use()`
```

它们本身为空，却出现在 `Store` 的交集里（`types.ts:475-476`）。这就是插件机制的类型基石：用户/插件通过 `declare module 'pinia'` 对它们做声明合并，新增字段会自动并入**每一个** store。例如：

```ts
// 用户侧：声明合并扩展 PiniaCustomProperties
declare module 'pinia' {
  export interface PiniaCustomProperties {
    $router: { push(to: string): void }  // 所有 store 实例都会有 $router
  }
}
```

扩展后，`PiniaPlugin`（定义于 rootStore.ts）返回的对象会被并入 store——其返回类型正是 `Partial<PiniaCustomProperties & PiniaCustomStateProperties> | void`。这套「空接口 + 声明合并 + 交集吸纳」三件套，是 Pinia 插件能力在类型层的完整闭环。

## 四、契约层小结与可运行复刻

回看全章：`env.ts` 一个常量、`globalExtensions.ts` 一个副作用模块增强、`types.ts` 一整套类型骨架——**编译期为主、运行时极轻**，这与后续运行时章节（`store.ts` 的装配逻辑）形成鲜明对照。本章建立的 `Store` 交集、`MutationType`、`StateTree` 与两个插件扩展缝，是后续章节引用最频繁的「通用语汇」。

下面给出一份可独立 `bun run` 的最小复刻（仅复刻**运行时产物** `isPlainObject`/`MutationType`/`IS_CLIENT`，纯类型部分已在正文中逐字给出）。文件树：

```
core-types-replica/
├── package.json
└── src/
    ├── env.ts
    ├── types-replica.ts   # isPlainObject + MutationType
    └── main.ts
```

`package.json`（bun 零依赖，无需 install）：

```json
{
  "name": "core-types-replica",
  "private": true,
  "type": "module",
  "scripts": { "start": "bun run src/main.ts" }
}
```

`src/env.ts`（逐字复刻 `env.ts:1`）：

```ts
export const IS_CLIENT = typeof window !== 'undefined'
```

`src/types-replica.ts`（逐字复刻 `types.ts:16-29` 的 `isPlainObject` 与 `types.ts:43-68` 的 `MutationType`）：

```ts
export type StateTree = Record<PropertyKey, any>

export function isPlainObject<S extends StateTree>(
  value: S | unknown
): value is S
export function isPlainObject(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  o: any
): o is StateTree {
  return (
    o &&
    typeof o === 'object' &&
    Object.prototype.toString.call(o) === '[object Object]' &&
    typeof o.toJSON !== 'function'
  )
}

export enum MutationType {
  direct = 'direct',
  patchObject = 'patch object',
  patchFunction = 'patch function',
}
```

`src/main.ts`（演示输入输出，验证 `Date` 被排除、枚举值带空格）：

```ts
import { IS_CLIENT } from './env'
import { isPlainObject, MutationType } from './types-replica'

console.log('IS_CLIENT =', IS_CLIENT) // Node 下为 false
console.log('isPlainObject({a:1}) =', isPlainObject({ a: 1 })) // true
console.log('isPlainObject([])    =', isPlainObject([]))       // false
console.log('isPlainObject(Date)  =', isPlainObject(new Date())) // false（带 toJSON）
console.log('MutationType.patchObject =', MutationType.patchObject) // 'patch object'（带空格！）
```

运行 `bun run src/main.ts`，预期输出末两行为 `false` 与 `'patch object'`——直观印证本章两个易错点：**带 `toJSON` 的对象不被视为普通 state**、**`MutationType` 的字符串值带空格**。