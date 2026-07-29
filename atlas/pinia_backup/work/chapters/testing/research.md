# @pinia/testing 测试夹具 · 源码精读

> 本章 sourceFiles：`packages/testing/src/testing.ts`、`packages/testing/src/restoreGetters.ts`、`packages/testing/src/diagnostics.ts`（外加入口 `packages/testing/src/index.ts`）。包入口仅做 re-export，无逻辑。
> 源码位置: packages/testing/src/index.ts:1-6

## 概念要点

### 1. 本质：一组「借助 Pinia 插件管线桩化 store」的测试夹具
`createTestingPinia()` 先 `createPinia()` 得到一个普通 Pinia 实例，然后把若干**插件**直接 `push` 进 `pinia._p`（插件管线），让每个 store 在被创建时（`store.ts` 里 `pinia._p.forEach(extender => extender({store, app, pinia, options}))`）自动被改写——注入初始 state、覆写 getter、用 spy 桩化 actions/`$patch`/`$reset`。
- 源码位置: packages/testing/src/testing.ts:113（`createPinia()`）
- 源码位置: packages/testing/src/testing.ts:116、123、126、146（四处 `pinia._p.push`）
- 交叉引用（插件被消费处）: packages/pinia/src/store.ts:717-724（`pinia._p.forEach` 把每个插件以 `{ store, app, pinia, options }` 上下文调用）

### 2. 插件压栈顺序是设计核心（action 桩化必须「最后」执行）
`createTestingPinia` 内按以下顺序向 `pinia._p` 直接 `push`（**不**走 `pinia.use()`，故绕过 `toBeInstalled` 队列）：
1. 初始 state 注入插件：命中 `initialState[store.$id]` 时深合并到 `store.$state`。
2. 用户传入的 `plugins[]`（逐个 push）。
3. `WritableComputed` 插件：让 store 上的计算属性可被手动赋值覆写。
4. action/`$patch`/`$reset` 桩化插件：最后压入。

注释明说：「bypass waiting for the app to be installed to ensure the action stubbing happens last」——即直接写 `_p`、并把桩化插件放最后，保证 store 装配时**用户的插件先跑、桩化最后覆盖**。
- 源码位置: packages/testing/src/testing.ts:122（顺序注释）
- 源码位置: packages/testing/src/testing.ts:146-157（最后压入的桩化插件）

> 关联事实（属 pinia-instance 章，仅供 Writer 理解机制）：`pinia.use(plugin)` 在 `app.use(pinia)` 之前调用时，插件先进 `toBeInstalled` 队列，直到 install 时才 `forEach` 灌入 `_p`；而 testing 这里直接写 `_p`，故插件即时生效、不受是否 `app.use` 影响。
- 交叉引用: packages/pinia/src/createPinia.ts:18（`let _p = []`）、:34（install 时 `toBeInstalled.forEach(p => _p.push(p))`）、:38-42（`use()`：`!_a` 时入队，否则入 `_p`）

### 3. 默认「全部 actions 被替换为空 spy（不执行原逻辑）」
`stubActions` 选项默认 `true`（JSDoc `@default true`）。桩化插件对 `options.actions` 的每个 key：若 `shouldStubAction(...)` 为真 → `createSpy()`（空 spy，**原 action 代码不执行**）；为假 → `createSpy(store[action])`（spy 包裹原函数，**原逻辑仍执行**，仅被监视）。
- 源码位置: packages/testing/src/testing.ts:31-43（`stubActions` JSDoc 与 `@default true`）、:107（默认值）、:150-152（桩 vs 包裹的分支）
- `shouldStubAction` 三种形态：`boolean`→原样返回；`string[]`→`includes(action)`；`function`→`stubActions(action, store)`。
- 源码位置: packages/testing/src/testing.ts:270-283

### 4. `$patch` / `$reset` 用同一桩化机制，但默认不桩
`store.$patch = stubPatch ? createSpy() : createSpy(store.$patch)`，`$reset` 同理。`stubPatch`/`stubReset` 默认均为 `false`，即默认**仍执行**真实 `$patch`/`$reset`，只是被 spy 包了一层。
- 源码位置: packages/testing/src/testing.ts:155-156、:108-109（默认值）
- 注意：actions 循环里 `if (action === '$reset') return` 显式跳过，`$reset` 由下面的独立行处理（因为 `$reset` 不是用户定义的 action，而是实例 API）。
- 源码位置: packages/testing/src/testing.ts:148

### 5. createSpy 的自动探测与校验（jest.fn / vi.fn）
若用户未传 `createSpy`，按序探测全局：`jest.fn`（Jest）→ 全局 `vi.fn`（Vitest）。探测不到则抛 `PINIA_TESTING_C0001`；若传入的不是函数（或具有 `mockReturnValue` 属性——即用户误传 `vi.fn()` 实例而非 `vi.fn` 工厂）则抛 `PINIA_TESTING_C0002`。
- 源码位置: packages/testing/src/testing.ts:128-143
- `'mockReturnValue' in createSpy` 这条专门兜底 issue #2896（误传 `vi.fn()`）。
- 源码位置: packages/testing/src/testing.ts:138-141（含注释链接 https://github.com/vuejs/pinia/issues/2896）
- 全局 `vi` 在文件顶部以 `declare var vi` 声明（`undefined | { fn }`），供 TS 通过。
- 源码位置: packages/testing/src/testing.ts:87-91
- 传 `createSpy` 时注意（JSDoc）：桩化分支只把 `fn` 参数置 `undefined`，用户自写的 `createSpy` 仍须自己处理「无原函数」情况。
- 源码位置: packages/testing/src/testing.ts:38-41、51-53、70-75

### 6. 初始 state：`initialState[store.$id]` 深合并
初始 state 插件：若 `initialState[store.$id]` 存在，调用本地 `mergeReactiveObjects(store.$state, initialState[store.$id])` 深合并。`mergeReactiveObjects` 是本文件**自带的本地副本**（与 pinia `store.ts` 里 `$patch` 用的同名函数同源、但未复用），递归合并「双方都是普通对象」的键，遇 ref/reactive 直接整体替换。
- 源码位置: packages/testing/src/testing.ts:116-120
- 源码位置: packages/testing/src/testing.ts:179-205（`mergeReactiveObjects`，注释「no need to go through symbols because they cannot be serialized anyway」:183）
- 辅助 `isPlainObject`：`toString` 为 `[object Object]` 且无 `toJSON`。
- 源码位置: packages/testing/src/testing.ts:207-218

### 7. getter 覆写：操作 Vue 响应式内部字段（`WritableComputed` 插件）
`WritableComputed` 遍历 `toRaw(store)` 上的每个 key，若 `isComputed`（既是 ref 又含 `effect` 字段）则用一个新的 `computed` 替换：`get` 透传原 computed 的 `.value`；`set(newValue)` 通过改写**原 computed 的内部字段**实现覆写——
- `newValue === undefined`：**还原**——恢复 `originalComputed.fn = originalFn`、删除缓存 `_value`、置 `_dirty = true` 强制重算。
- 否则：置 `originalComputed.fn = overriddenFn`（`overriddenFn` 返回缓存 `_value`）、把 `_value = newValue`。
- 最后 `triggerRef(originalComputed)` 通知依赖。

从而测试中可 `store.someGetter = 'mock'` 覆写、`store.someGetter = undefined` 还原。所有内部字段访问均 `@ts-expect-error: private api`，属「黑魔法」。
- 源码位置: packages/testing/src/testing.ts:220-224（`isComputed`）、:226-261（`WritableComputed`）
- 源码位置: packages/testing/src/testing.ts:125-126（注释「allow computed to be manually overridden」+ push）

### 8. `fakeApp` 与 `app` 访问器
`fakeApp: true` 时 `createApp({}).use(pinia)`：建空 App 并 install pinia。注释解释——某些插件「等 pinia 被 install 才执行」，fakeApp 让它们跑起来。返回的 `TestingPinia` 额外暴露 `app` 属性（getter 返回 `this._a`），仅 fakeApp（或用户自行 install）后才有意义。
- 源码位置: packages/testing/src/testing.ts:62-68（JSDoc）、:159-162（实现）
- 源码位置: packages/testing/src/testing.ts:82-85（`TestingPinia extends Pinia { app: App }`）、:168-174（`defineProperty` 的 `app` getter 返回 `_a`）
- 关联事实（属 pinia-instance 章）：install 时 `pinia._a = app` 并 flush `toBeInstalled`→`_p`。
- 交叉引用: packages/pinia/src/createPinia.ts:27、:34

### 9. `pinia._testing = true` + `setActivePinia(pinia)`：让测试构建无需注入上下文
`createTestingPinia` 末尾置 `pinia._testing = true` 并 `setActivePinia(pinia)`。该标记被 `store.ts` 的 `useStore` 在 `__TEST__` 构建中消费：当存在带 `_testing` 的 `activePinia` 时，忽略传给 useStore 的 pinia 实参，改走注入/活跃实例路径——使测试中「不挂载组件也能拿到 store」成为可能。
- 源码位置: packages/testing/src/testing.ts:164、:166
- 交叉引用（消费处，属 store-definition 章）: packages/pinia/src/store.ts:888（`(__TEST__ && activePinia && activePinia._testing ? null : pinia) || ...`）
- 交叉引用（类型声明）: packages/pinia/src/rootStore.ts:111（`_testing?: boolean`）
- 交叉引用（devtools 也读该标记做桩化旁路）: packages/pinia/src/devtools/plugin.ts:585（`if (!store._p._testing)`）

### 10. 诊断码（nostics，抛出而非控制台报告）
`diagnostics.ts` 用 `nostics` 的 `defineDiagnostics` 定义两个用户向诊断码，**均以 throw 形式抛出**，故不挂 console reporter（否则同一信息打印两次）。两个码：
- `PINIA_TESTING_C0001`：未配置 `createSpy`（fix：传 `vi.fn`/`jest.fn`）。
- `PINIA_TESTING_C0002`：`createSpy` 非法（fix：传函数本身而非 `vi.fn()` 实例）。
- 源码位置: packages/testing/src/diagnostics.ts:9-22
- 抛出点：`C0001` 在 packages/testing/src/testing.ts:135；`C0002` 在 packages/testing/src/testing.ts:142。
- 命名规律（供 Writer 衔接 diagnostics 章）：`PINIA_TESTING_C{序号}`，与 pinia 主库的 `PINIA_R1xxx` 等同属 nostics 目录体系，只是 testing 包用 `C`（creation/config 类）前缀。
- 源码位置: packages/testing/src/diagnostics.ts:1（`import { defineDiagnostics } from 'nostics'`）

### 11. `restoreGetters.ts`：实验性 getter 还原工具（TODO 未完成）
`restoreGetter(store, getter)` 有两个重载（类型化 `Store<...>` 版 + 泛型 setup-store 版），实现仅一行：`store[getter] = undefined`——把被覆写的 getter 置空来「还原」。文件首部 `// TODO: more testing, document and release`，表明该工具**尚未正式文档化/发布**。
- 源码位置: packages/testing/src/restoreGetters.ts:3（TODO）、:5-12（两个重载签名）、:13-16（实现，`@ts-expect-error: private api`）
- 注意：该文件**未被 `index.ts` 导出**（入口只导出 `createTestingPinia`/`TestingPinia`/`TestingOptions`），属内部/未公开 API。
- 源码位置: packages/testing/src/index.ts:1-6

## 关键调用链

**装配链（createTestingPinia 内部压栈顺序）**：
```
createTestingPinia(options)
  └─ createPinia()                                   // 普通 Pinia 实例
  └─ pinia._p.push( 初始 state 深合并插件 )           // 1. initialState[store.$id] → mergeReactiveObjects
  └─ plugins.forEach(p => pinia._p.push(p))           // 2. 用户插件
  └─ pinia._p.push(WritableComputed)                  // 3. 计算属性可覆写
  └─ 解析/校验 createSpy (jest.fn | vi.fn | 用户传入)  // C0001/C0002 校验
  └─ pinia._p.push( 桩化插件 )                        // 4. actions/$patch/$reset 桩化（最后）
  └─ (fakeApp) createApp({}).use(pinia)
  └─ pinia._testing = true; setActivePinia(pinia)
  └─ defineProperty(pinia, 'app', getter → _a)
  └─ return pinia as TestingPinia
```
- 源码位置: packages/testing/src/testing.ts:104-177

**store 被创建时（运行期，pinia 主库触发）**：
```
useStore() → createSetupStore/createOptionsStore
  └─ pinia._p.forEach(extender => extender({store, app, pinia, options}))
       ├─ [1] 初始 state 插件: mergeReactiveObjects(store.$state, initialState[$id])
       ├─ [2] 用户插件: 各自扩展
       ├─ [3] WritableComputed: toRaw(store) 遍历 → isComputed 则用可写 computed 替换
       └─ [4] 桩化插件:
            ├─ options.actions 每个 key: shouldStubAction? createSpy() : createSpy(store[action])
            │     （跳过 '$reset'）
            ├─ store.$patch = stubPatch? createSpy() : createSpy(store.$patch)
            └─ store.$reset = stubReset? createSpy() : createSpy(store.$reset)
```
- 交叉引用（触发处）: packages/pinia/src/store.ts:717-724

**getter 覆写/还原链**：
```
store.getter = 'mock'   → WritableComputed 生成的 computed.set('mock')
                          → originalComputed.fn = overriddenFn; _value = 'mock'; triggerRef(...)
store.getter = undefined → computed.set(undefined)
                          → originalComputed.fn = originalFn; delete _value; _dirty = true; triggerRef(...)
store.getter (读)        → computed.get() → originalComputed.value
```
- 源码位置: packages/testing/src/testing.ts:238-258

## 源码摘录（带行号）

### 桩化插件主体（actions + $patch + $reset）
源码位置: packages/testing/src/testing.ts:146-157
```ts
// stub actions
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

### createSpy 解析与校验
源码位置: packages/testing/src/testing.ts:128-143
```ts
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

### WritableComputed（计算属性覆写，操作 Vue 内部字段）
源码位置: packages/testing/src/testing.ts:226-261
```ts
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
        get() {
          return originalComputed.value
        },
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

### isComputed（用 `effect` 字段区分 computed 与 ref）
源码位置: packages/testing/src/testing.ts:220-224
```ts
function isComputed<T>(
  v: ComputedRef<T> | WritableComputedRef<T> | unknown
): v is (ComputedRef<T> | WritableComputedRef<T>) & ComputedRefImpl<T> {
  return !!v && isRef(v) && 'effect' in v
}
```
- 注意：`ComputedRefImpl` 从 `@vue/reactivity` 导入（实现类型，含最新内部字段），注释说明它「type is correct and contains up to date types while the other types hide internal properties」。
- 源码位置: packages/testing/src/testing.ts:13-15

### 诊断目录（nostics）
源码位置: packages/testing/src/diagnostics.ts:9-22
```ts
export const diagnostics = /*#__PURE__*/ defineDiagnostics({
  codes: {
    PINIA_TESTING_C0001: {
      why: 'You must configure the "createSpy" option.',
      fix: 'Pass a createSpy function such as vi.fn or jest.fn to createTestingPinia().',
      docs: 'https://pinia.vuejs.org/cookbook/testing.html#Specifying-the-createSpy-function',
    },
    PINIA_TESTING_C0002: {
      why: 'Invalid "createSpy" option.',
      fix: 'Pass the function itself (e.g. vi.fn), not a called spy like vi.fn().',
      docs: 'https://pinia.vuejs.org/cookbook/testing.html#Specifying-the-createSpy-function',
    },
  },
})
```

### restoreGetter（实验性，未在 index 导出）
源码位置: packages/testing/src/restoreGetters.ts:5-16
```ts
export function restoreGetter<G>(
  store: Store<string, StateTree, G, any>,
  getter: keyof G
): void
export function restoreGetter<SS>(
  store: SS,
  getter: _ExtractGettersFromSetupStore_Keys<SS>
): void
export function restoreGetter<G>(store: Store, getter: any): void {
  // @ts-expect-error: private api
  store[getter] = undefined
}
```

## 易混淆 / 需 Writer 注意

1. **「桩化」有两层语义，别混为一谈**：`stubActions=true` 时 action 被替换成**空 spy**（原代码**不执行**）；`stubActions=false` 时 action 仍是原逻辑、只是被 spy **包裹监视**（仍执行）。`$patch`/`$reset` 默认 `stubX=false`，即默认**仍改 state**——这点和 actions 默认全桩相反，容易让读者误以为「testing pinia 不改任何状态」。务必讲清「默认全桩的只有 actions」。
   - 源码位置: packages/testing/src/testing.ts:107-110（默认值）、:150-156（分支语义）

2. **自定义 `createSpy` 必须自己处理「无原函数」**：桩化分支调用 `createSpy()`（无参），监视分支调用 `createSpy(store[action])`（有原函数）。JSDoc 反复强调（actions/$patch 两处）：传 `createSpy` 时它「only make the fn argument undefined」，用户得自己返回 no-op。
   - 源码位置: packages/testing/src/testing.ts:38-41、51-53

3. **`vi.fn` vs `vi.fn()` 的坑**：校验里 `'mockReturnValue' in createSpy` 专门拦截把 `vi.fn()`（spy 实例）当工厂传进来的误用——这是真实 issue #2896，写章节时是个很好的「常见踩坑」素材。
   - 源码位置: packages/testing/src/testing.ts:136-143

4. **插件压栈顺序为何重要**：testing 直接写 `pinia._p`（非 `pinia.use()`），且把桩化插件放**最后**。Writer 讲「为什么 action 桩化能覆盖用户插件对 action 的改写」时，根源就是「用户插件先 push、桩化最后 push、`_p.forEach` 按序执行」。
   - 源码位置: packages/testing/src/testing.ts:122-126、146

5. **`WritableComputed` 是强依赖 Vue 内部实现的黑魔法**：直接读写 `originalComputed.fn/_value/_dirty` 并 `triggerRef`，全部 `@ts-expect-error: private api`。这些字段来自 `@vue/reactivity` 的 `ComputedRefImpl`（非公开稳定 API）。Writer 讲「计算属性覆写」时要点明：这是**绑死特定 Vue reactivity 内部结构**的实现，Vue 升级可能破坏它——属「为了测试便利而用的脆弱技巧」。
   - 源码位置: packages/testing/src/testing.ts:226-261、:13-15

6. **`mergeReactiveObjects` / `isPlainObject` 是本地副本**：与 pinia 主库 `store.ts` 中 `$patch` 用的同名函数逻辑同源，但 testing 包**没有复用、而是各写一份**。Writer 不宜说「复用了 pinia 的 mergeReactiveObjects」，应说「自带一份等价实现」。
   - 源码位置: packages/testing/src/testing.ts:179-218

7. **`_testing` 标记的跨包语义**：`createTestingPinia` 置 `pinia._testing=true`，但该标记的**真正消费方在 pinia 主库**（`store.ts` 的 `useStore` 在 `__TEST__` 构建里据此忽略注入参数；devtools 也据此旁路）。Writer 讲 testing 时可点一句「该标记是 testing 包与 pinia 主库之间的契约」，但 `useStore` 的完整逻辑属 store-definition 章，勿越界展开。
   - 源码位置: packages/testing/src/testing.ts:164；交叉引用 packages/pinia/src/store.ts:888、devtools/plugin.ts:585

8. **`fakeApp` 默认 false 的后果**：默认不建 App、不 `app.use(pinia)`，意味着 pinia 主库里经 `pinia.use()`（如 devtools）入 `toBeInstalled` 队列的插件**不会被 flush**。若用户的测试插件依赖 install 时机，须显式开 `fakeApp`。
   - 源码位置: packages/testing/src/testing.ts:159-162；交叉引用 packages/pinia/src/createPinia.ts:34

9. **`restoreGetters.ts` 与 `diagnostics.ts` 在包内的可见性差异**：`diagnostics` 被 `testing.ts` 内部 `import` 使用（必经路径）；`restoreGetters` **未被任何文件引用、也未在 `index.ts` 导出**，是孤立/未发布的实验文件。Writer 若提及 `restoreGetter`，应标注其「未公开、TODO 状态」，避免读者以为它是稳定 API。
   - 源码位置: packages/testing/src/index.ts:1-6（无 restoreGetters 导出）、restoreGetters.ts:3（TODO）

10. **诊断码的「抛出 vs 报告」**：`diagnostics.ts` 注释明确——这些码是 `throw` 出去的，故**不挂 console reporter**（否则同一信息重复打印）。这与 pinia 主库某些「收集后统一报告」的诊断不同，Writer 讲 testing 诊断时要区分这两种模式。
    - 源码位置: packages/testing/src/diagnostics.ts:3-8（注释说明 no reporter）