---
title: '@pinia/testing 测试夹具'
---

# @pinia/testing 测试夹具

组件与 store 的单元测试里，你往往不想真去跑 action 的网络/副作用，只关心「它被调用了没」「传参对不对」。`@pinia/testing` 给出的答案是 **`createTestingPinia`**：造一个普通 Pinia 实例，再借**插件管线**把每个 store 的 actions/`$patch`/`$reset` 换成 spy、注入初始 state、并允许覆写计算属性。

本章自底向上拆解这套夹具。前置概念来自 **pinia-instance**（插件管线 `pinia._p`、`setActivePinia`、`toBeInstalled`）、**store-definition**（`useStore`、`options.actions`）、**store-instance-api**（`$patch` 的 `mergeReactiveObjects`、`$reset`）。

---

## 一、底层原语①：插件管线 `pinia._p` 如何被 store 消费

回顾 pinia-instance 章：Pinia 根实例持有插件数组 `pinia._p`。每当一个 store 被装配，`store.ts` 会按顺序把每个插件以统一上下文调用一次：

```
useStore() → createSetupStore/createOptionsStore
   └─ pinia._p.forEach(extender => extender({ store, app, pinia, options }))
```

> 交叉引用：`packages/pinia/src/store.ts:717-724`。

`createTestingPinia` 的全部魔力，就是**往这个 `_p` 数组里 push 四个插件**。关键在于它**直接写 `pinia._p`**，而不是 `pinia.use()`——后者在 `app.use(pinia)` 之前只会把插件塞进 `toBeInstalled` 队列（见 `packages/pinia/src/createPinia.ts:38-42`）。直接写 `_p` 意味着插件**即时生效**，不受是否 `app.use` 影响，这也为「桩化插件必须最后执行」提供了前提。

## 二、底层原语②：`createSpy` 工厂的解析与校验

桩化的底层零件是一个「造 spy」的工厂。`createTestingPinia` 按序探测：用户传入 → `jest.fn`（Jest）→ 全局 `vi.fn`（Vitest `globals:true`）。探测不到或传入非法时，抛出诊断码。

```ts
// 源码 packages/testing/src/testing.ts:128-143  ｜ replica/index.ts 同段
const createSpy =
  _createSpy ||
  // @ts-ignore
  (typeof jest !== 'undefined' && (jest.fn as typeof _createSpy)) ||
  (typeof vi !== 'undefined' && vi.fn)
/* istanbul ignore if */
if (!createSpy) {
  throw diagnostics.PINIA_TESTING_C0001()
} else if (
  typeof createSpy !== 'function' ||
  // When users pass vi.fn() instead of vi.fn
  // https://github.com/vuejs/pinia/issues/2896
  'mockReturnValue' in createSpy
) {
  throw diagnostics.PINIA_TESTING_C0002()
}
```

两个诊断码定义在 `diagnostics.ts`，**以 throw 形式抛出**（故不挂 console reporter，否则同一信息打印两次）：

- `PINIA_TESTING_C0001`：未配置 `createSpy`（fix：传 `vi.fn`/`jest.fn`）。
- `PINIA_TESTING_C0002`：`createSpy` 非法（fix：传函数本身，而非 `vi.fn()` 实例）。

> 源码 `packages/testing/src/diagnostics.ts:9-22`。抛出点分别在 `testing.ts:135`、`testing.ts:142`。

⚠️ 第三个条件 `'mockReturnValue' in createSpy` 是个**真实坑位**（issue #2896）：用户误把 `vi.fn()`（已造好的 spy 实例）当成工厂传进来——此时 `createSpy` 本身不是函数、却带着 `mockReturnValue` 属性，正是这条把它拦下。

> 注意：全局 `vi` 在文件顶部以 `declare var vi` 声明（`testing.ts:87-91`），仅作 TS 通过；运行期若 Vitest 未开 `globals:true`，`vi` 为 `undefined`，于是走到 C0001。

## 三、组合机制：`createTestingPinia` 的四阶段压栈装配

把零件拼起来。`createTestingPinia` 主体是一条装配链：

```
createTestingPinia(options)
  ├─ createPinia()                         // 普通 Pinia 实例（testing.ts:113）
  ├─ _p.push( 初始 state 深合并插件 )       // ① initialState[store.$id] → mergeReactiveObjects
  ├─ plugins.forEach(p => _p.push(p))      // ② 用户插件（绕过 toBeInstalled）
  ├─ _p.push(WritableComputed)             // ③ 计算属性可覆写
  ├─ 解析/校验 createSpy                    //    jest.fn | vi.fn | 用户传入（C0001/C0002）
  ├─ _p.push( 桩化插件 )                    // ④ actions/$patch/$reset 桩化（必须最后）
  ├─ (fakeApp) createApp({}).use(pinia)
  ├─ pinia._testing = true; setActivePinia(pinia)
  └─ defineProperty(pinia, 'app', getter→_a); return pinia
```

**压栈顺序是设计核心**。源码注释直言：「bypass waiting for the app to be installed to ensure the action stubbing happens last」（`testing.ts:122`）——用户插件先 push、桩化插件最后 push，而 `_p.forEach` 严格按序执行，于是**用户插件对 action 的任何改写都会被最后的桩化插件覆盖**。

## 四、action 桩化语义：默认「全桩、不执行原逻辑」

桩化插件对 `options.actions` 的每个 key，依据 `shouldStubAction(...)` 决定走哪一支：

```ts
// 源码 packages/testing/src/testing.ts:146-157  ｜ replica/index.ts 同段
pinia._p.push(({ store, options }) => {
  Object.keys(options.actions).forEach((action) => {
    if (action === '$reset') return

    store[action] = shouldStubAction(stubActions, action, store)
      ? createSpy()
      : createSpy(store[action])
  })

  store.$patch = stubPatch ? createSpy() : createSpy(store.$patch)
  store.$reset = stubReset ? createSpy() : createSpy(store.$reset)
})
```

两支语义截然不同，务必分清：

| `shouldStubAction` 结果 | 调用 | 语义 |
|---|---|---|
| `true`（桩化） | `createSpy()` 无参 | **空 spy**，原 action 代码**不执行** |
| `false`（监视） | `createSpy(store[action])` | spy **包裹**原函数，**仍执行**原逻辑 |

`shouldStubAction` 支持三种 `stubActions` 形态（`testing.ts:270-283`）：

```ts
function shouldStubAction(stubActions, action, store): boolean {
  if (typeof stubActions === 'boolean') return stubActions          // 全桩 / 全不桩
  else if (Array.isArray(stubActions)) return stubActions.includes(action) // 按名桩
  else if (typeof stubActions === 'function') return stubActions(action, store) // 自定义
  return false
}
```

`stubActions` **默认 `true`**（`testing.ts:107`）——即默认每个 action 都被换成空 spy、原逻辑不跑。

⚠️ 自定义 `createSpy` 时，桩化分支调用的是**无参** `createSpy()`，监视分支才传原函数。JSDoc 反复强调（`testing.ts:38-41`）：你自写的 `createSpy` 必须自己处理「没有原函数」的情况，框架只会把 `fn` 参数置 `undefined`。

## 五、`$patch` / `$reset`：同一机制，但默认**不桩**

`store.$patch = stubPatch ? createSpy() : createSpy(store.$patch)`，`$reset` 同理。但 `stubPatch`/`stubReset` **默认均为 `false`**（`testing.ts:108-109`）——即默认 `$patch`/`$reset` **仍真实改 state**，只是被 spy 包了一层用于断言「被调用」。

> 这点和 actions 默认全桩**正好相反**。一句话记住：**默认被全桩的只有 actions**；`$patch`/`$reset` 默认照样生效。

另一个细节：actions 循环里 `if (action === '$reset') return`（`testing.ts:148`）显式跳过 `$reset`，因为 `$reset` 不是用户定义的 action，而是 store 实例 API，故由下面独立的 `store.$reset = …` 行单独处理。

## 六、初始 state：`initialState[store.$id]` 深合并

第一个插件负责注入测试用初始状态。命中 `initialState[store.$id]` 时，调用本地 `mergeReactiveObjects` 深合并到 `store.$state`（`testing.ts:116-120`）。

> 注意：`mergeReactiveObjects`/`isPlainObject` 是 testing 包**自带的本地副本**，与 pinia 主库 `store.ts` 里 `$patch` 用的同名函数逻辑同源、但**并未复用**（`testing.ts:179-218`）。不要说「复用了 pinia 的」，应说「自带一份等价实现」。

`isPlainObject` 判定 `toString === '[object Object]'` 且无 `toJSON`；`mergeReactiveObjects` 递归合并「双方都是普通对象」的键，遇 ref/reactive 直接整体替换。完整实现见文末 replica 的 `mergeReactiveObjects`/`isPlainObject` 两段。

## 七、计算属性覆写：`WritableComputed` 与 Vue 内部黑魔法

第三个插件让 store 上的 getter 可被手动赋值（`store.someGetter = 'mock'`），赋 `undefined` 则还原。它遍历 `toRaw(store)`，命中 `isComputed` 的键就替换成一个可写 `computed`：

```ts
// 源码 packages/testing/src/testing.ts:226-261  ｜ replica/index.ts 同段
function WritableComputed({ store }: PiniaPluginContext) {
  const rawStore = toRaw(store)
  for (const key in rawStore) {
    const originalComputed = rawStore[key]
    if (isComputed(originalComputed)) {
      const originalFn = originalComputed.fn
      const overriddenFn = () =>
        // @ts-expect-error: internal cached value
        originalComputed._value

      rawStore[key] = computed<unknown>({
        get() { return originalComputed.value },
        set(newValue) {
          if (newValue === undefined) {
            originalComputed.fn = originalFn
            // @ts-expect-error: private api to remove the current cached value
            delete originalComputed._value
            // @ts-expect-error: private api to force the recomputation
            originalComputed._dirty = true
          } else {
            originalComputed.fn = overriddenFn
            // @ts-expect-error: private api
            originalComputed._value = newValue
          }
          triggerRef(originalComputed)
        },
      })
    }
  }
}
```

`isComputed` 用「既是 ref 又含 `effect` 字段」区分 computed 与普通 ref（`testing.ts:220-224`）。覆写/还原的内部链路如下：

```
store.getter = 'mock'
  → set('mock') → originalComputed.fn = overriddenFn; _value = 'mock'; triggerRef(...)
store.getter（读）→ get() → originalComputed.value（此时 fn 已返回缓存 _value）→ 'mock'

store.getter = undefined
  → set(undefined) → fn = originalFn; delete _value; _dirty = true; triggerRef(...)
store.getter（读）→ fn 还原为原逻辑 → 强制重算
```

⚠️ 这是**绑死 Vue reactivity 内部结构**的黑魔法：直接读写 `originalComputed.fn/_value/_dirty` 并 `triggerRef`，全部 `@ts-expect-error: private api`。这些字段来自 `@vue/reactivity` 的 `ComputedRefImpl`（非公开稳定 API，`testing.ts:13-15`）。Vue 升级可能破坏它——属「为测试便利而用的脆弱技巧」。

## 八、`fakeApp` / `_testing` / `setActivePinia` / `app` 访问器

装配链末尾的三处收尾（`testing.ts:159-174`）：

1. **`fakeApp: true`** 时 `createApp({}).use(pinia)`：建空 App 并 install pinia。注释解释——某些插件**等 pinia 被 install 才执行**，`fakeApp` 让它们跑起来。默认 `false`，意味着经 `pinia.use()`（如 devtools）入 `toBeInstalled` 队列的插件**不会被 flush**；若你的测试插件依赖 install 时机，须显式开 `fakeApp`。
2. **`pinia._testing = true` + `setActivePinia(pinia)`**：置测试标记并把该 pinia 设为活跃。该标记的**真正消费方在 pinia 主库**——`useStore` 在 `__TEST__` 构建中据此忽略传入的 pinia 实参、改走活跃实例（`packages/pinia/src/store.ts:888`）；devtools 也据此旁路桩化（`packages/pinia/src/devtools/plugin.ts:585`）。它是 testing 包与主库之间的**契约**。
3. **`app` 访问器**：返回的 `TestingPinia` 额外暴露 `app`（getter 返回 `this._a`），仅 `fakeApp`（或用户自行 install）后 `_a` 才有值。类型 `TestingPinia extends Pinia { app: App }`（`testing.ts:82-85`）。

## 九、`restoreGetters.ts`：实验性、未导出

`restoreGetter(store, getter)` 两个重载，实现仅一行 `store[getter] = undefined`——把被覆写的 getter 置空来「还原」（`restoreGetters.ts:13-16`）。文件首部标注 `// TODO: more testing, document and release`，且**未被 `index.ts` 导出**（入口只导出 `createTestingPinia`/`TestingPinia`/`TestingOptions`，`index.ts:1-6`）——属孤立、未公开、TODO 状态的实验文件，勿当作稳定 API。

---

## 十、可运行复刻（replica/）

> 应上一轮 Critic 要求，本章配套一套**可独立 `bun run` 的最小脚手架**。正文 §2/§3/§4/§6/§7 各 `ts` 片段即为下方 `replica/index.ts` 的对应段落（逐字一致），仅把 `nostics` 的 `defineDiagnostics` 内联成简化版以消除外部依赖。

**`replica/package.json`**

```json
{
  "name": "pinia-testing-replica",
  "private": true,
  "type": "module",
  "scripts": { "start": "bun run index.ts", "test": "bun test" },
  "dependencies": { "pinia": "^2", "vue": "^3" },
  "devDependencies": {}
}
```

**`replica/index.ts`**（完整文件，正文各片段按源码顺序拼接即此）

```ts
// replica/index.ts — createTestingPinia 最小可运行复刻
// 对应源码：packages/testing/src/testing.ts
import { computed, createApp, isReactive, isRef, toRaw, triggerRef } from 'vue'
import type { App, ComputedRef, WritableComputedRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type {
  Pinia, PiniaPlugin, PiniaPluginContext, StateTree, StoreGeneric, _DeepPartial,
} from 'pinia'
import type { ComputedRefImpl } from '@vue/reactivity'

// 源码用 nostics 的 defineDiagnostics（diagnostics.ts:9-22）；此处内联简化版以消除外部依赖
const diagnostics = {
  PINIA_TESTING_C0001: () => new Error('[C0001] 必须配置 createSpy 选项'),
  PINIA_TESTING_C0002: () => new Error('[C0002] createSpy 非法：传函数本身，而非 vi.fn() 实例'),
}

declare var vi: undefined | { fn: (fn?: (...a: any[]) => any) => (...a: any[]) => any }

export interface TestingOptions {
  initialState?: StateTree
  plugins?: PiniaPlugin[]
  stubActions?: boolean | string[] | ((actionName: string, store: StoreGeneric) => boolean)
  stubPatch?: boolean
  stubReset?: boolean
  fakeApp?: boolean
  createSpy?: (fn?: (...a: any[]) => any) => (...a: any[]) => any
}
export interface TestingPinia extends Pinia { app: App }

export function createTestingPinia({
  initialState = {}, plugins = [], stubActions = true,
  stubPatch = false, stubReset = false, fakeApp = false, createSpy: _createSpy,
}: TestingOptions = {}): TestingPinia {
  const pinia = createPinia()

  // 1) 初始 state 深合并
  pinia._p.push(({ store }) => {
    if (initialState[store.$id]) mergeReactiveObjects(store.$state, initialState[store.$id])
  })

  // 2) 用户插件：直接写 _p（绕过 toBeInstalled），保证桩化最后执行
  plugins.forEach((p) => pinia._p.push(p))

  // 3) 计算属性可手动覆写
  pinia._p.push(WritableComputed)

  // createSpy 解析与校验（jest.fn → vi.fn → 用户传入）
  const createSpy =
    _createSpy ||
    (typeof jest !== 'undefined' && (jest.fn as typeof _createSpy)) ||
    (typeof vi !== 'undefined' && vi.fn)
  if (!createSpy) throw diagnostics.PINIA_TESTING_C0001()
  else if (typeof createSpy !== 'function' || 'mockReturnValue' in createSpy)
    throw diagnostics.PINIA_TESTING_C0002()

  // 4) 桩化插件：actions / $patch / $reset（最后压入）
  pinia._p.push(({ store, options }) => {
    Object.keys(options.actions).forEach((action) => {
      if (action === '$reset') return
      store[action] = shouldStubAction(stubActions, action, store)
        ? createSpy()
        : createSpy(store[action])
    })
    store.$patch = stubPatch ? createSpy() : createSpy(store.$patch)
    store.$reset = stubReset ? createSpy() : createSpy(store.$reset)
  })

  if (fakeApp) { const app = createApp({}); app.use(pinia) }

  pinia._testing = true
  setActivePinia(pinia)

  Object.defineProperty(pinia, 'app', {
    configurable: true, enumerable: true, get(): App { return this._a },
  })

  return pinia as TestingPinia
}

function mergeReactiveObjects<T extends StateTree>(target: T, patchToApply: _DeepPartial<T>): T {
  for (const key in patchToApply) {
    if (!Object.hasOwn(patchToApply, key)) continue
    const subPatch = patchToApply[key]
    const targetValue = target[key]
    if (
      isPlainObject(targetValue) && isPlainObject(subPatch) && Object.hasOwn(target, key) &&
      !isRef(subPatch) && !isReactive(subPatch)
    ) {
      target[key] = mergeReactiveObjects(targetValue, subPatch)
    } else {
      // @ts-expect-error: subPatch is a valid value
      target[key] = subPatch
    }
  }
  return target
}

function isPlainObject<S extends StateTree>(value: S | unknown): value is S
function isPlainObject(o: any): o is StateTree {
  return (
    o && typeof o === 'object' &&
    Object.prototype.toString.call(o) === '[object Object]' &&
    typeof o.toJSON !== 'function'
  )
}

function isComputed<T>(
  v: ComputedRef<T> | WritableComputedRef<T> | unknown
): v is (ComputedRef<T> | WritableComputedRef<T>) & ComputedRefImpl<T> {
  return !!v && isRef(v) && 'effect' in v
}

function WritableComputed({ store }: PiniaPluginContext) {
  const rawStore = toRaw(store)
  for (const key in rawStore) {
    const originalComputed = rawStore[key]
    if (isComputed(originalComputed)) {
      const originalFn = originalComputed.fn
      const overriddenFn = () =>
        // @ts-expect-error: internal cached value
        originalComputed._value
      rawStore[key] = computed<unknown>({
        get() { return originalComputed.value },
        set(newValue) {
          if (newValue === undefined) {
            originalComputed.fn = originalFn
            // @ts-expect-error: private api to remove the current cached value
            delete originalComputed._value
            // @ts-expect-error: private api to force the recomputation
            originalComputed._dirty = true
          } else {
            originalComputed.fn = overriddenFn
            // @ts-expect-error: private api
            originalComputed._value = newValue
          }
          triggerRef(originalComputed)
        },
      })
    }
  }
}

function shouldStubAction(
  stubActions: TestingOptions['stubActions'], action: string, store: StoreGeneric
): boolean {
  if (typeof stubActions === 'boolean') return stubActions
  else if (Array.isArray(stubActions)) return stubActions.includes(action)
  else if (typeof stubActions === 'function') return stubActions(action, store)
  return false
}
```

**`replica/assert.test.ts`**（自测桩化语义与计算属性覆写/还原）

```ts
import { defineStore } from 'pinia'
import { createTestingPinia } from './index'

// 自制 createSpy（生产由 jest.fn / vi.fn 提供）
function createSpy(fn?: (...a: any[]) => any) {
  const spy: any = (...args: any[]) => { spy.mock.calls.push(args); return fn?.(...args) }
  spy.mock = { calls: [] as any[][] }
  return spy
}

createTestingPinia({ createSpy })            // 默认 stubActions=true

const useStore = defineStore('counter', {
  state: () => ({ count: 0 }),
  getters: { double: (s: any) => s.count * 2 },
  actions: { inc(this: any) { this.count++ } },
})
const store: any = useStore()

assert(store.count === 0, 'init count = 0')

store.inc()                                  // action 被桩化 → 原逻辑不执行
assert(store.count === 0, 'action 被桩化后 state 不变')
assert(store.inc.mock.calls.length === 1, 'action 仍被 spy 记录')

store.double = 42                            // getter 覆写
assert(store.double === 42, 'getter 可被覆写为 42')
store.double = undefined                     // 还原
assert(store.double === 0, 'getter 赋 undefined 后还原重算')

store.$patch({ count: 9 })                   // $patch 默认 stubPatch=false → 仍改 state
assert(store.count === 9, '$patch 默认仍真实修改 state')

console.log('✓ replica 全部断言通过')

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1) }
}
```

运行：`cd replica && bun install && bun test`。

输入输出示例：上述断言运行后期望输出 `✓ replica 全部断言通过`；若把 `createTestingPinia()` 改成无 `createSpy` 且无 jest/vi 全局，则立即抛 `[C0001] 必须配置 createSpy 选项`。

---

## 小结

- **本质**：一组「借插件管线桩化 store」的测试夹具。`createPinia()` 后直接 `pinia._p.push` 四个插件。
- **压栈顺序是核心**：①初始 state 深合并 → ②用户插件 → ③`WritableComputed` → ④桩化插件（最后）。直接写 `_p` 而非 `pinia.use()`，绕过 `toBeInstalled`，保证桩化最后覆盖。
- **两层「桩化」语义别混**：`createSpy()` 无参=空 spy（不执行原逻辑）；`createSpy(fn)` 有参=包裹监视（仍执行）。actions 默认全桩、`$patch`/`$reset` 默认不桩。
- **计算属性覆写**靠操作 Vue reactivity 内部字段（`fn/_value/_dirty`）的黑魔法实现，脆弱但好用。
- **契约**：`pinia._testing = true` 是 testing 包与 pinia 主库之间的约定，让测试中无需注入即可拿到 store。
