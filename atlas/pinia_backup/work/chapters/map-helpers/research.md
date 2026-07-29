# Options API 映射辅助 · 源码精读

> 本章唯一源文件：`packages/pinia/src/mapHelpers.ts`（555 行）。以下所有相对路径以 `root=work/source` 为基准。

## 0. 模块定位与一句话总结

本模块为 **Options API 组件**（即不走 `setup()` 的传统 `computed` / `methods` 写法）提供「展开使用 store」的桥接工具。核心思想：每个 map 函数返回一个 **「键 → 取值函数（或 get/set 对象）」的普通对象**，组件用 `...mapXxx()` 把它展开进 `computed` / `methods` 字段；Vue 在运行时调用这些函数，函数内部通过 `this.$pinia` 取到当前组件注入的 Pinia 实例，再 `useStore(this.$pinia)` 取到 store。

源码位置: `packages/pinia/src/mapHelpers.ts:1-9`（import 区可见依赖仅为 Vue 类型 + 本库 `types` + `diagnostics`，无运行时副作用依赖）

公共导出（运行时）共 5 个：`mapStores`、`mapState`、`mapGetters`（alias）、`mapActions`、`mapWritableState`，外加可变全局 `mapStoreSuffix` 与其 setter `setMapStoreSuffix`。
源码位置: `packages/pinia/src/mapHelpers.ts:62, 71, 101, 194/231/250, 296, 337/370/387, 468/486/504`

## 1. 概念要点

### 1.1「返回函数而非值」是本模块的根本设计

所有 map 函数都不在调用时一次性求值，而是返回 **惰性的取值函数**。例如 `mapState` 数组分支里，每个键的值是一个 `function(this: ComponentPublicInstance)`，函数体里才执行 `useStore(this.$pinia)[key]`：

```ts
reduced[key] = function (this: ComponentPublicInstance) {
  // @ts-expect-error: FIXME: should work?
  return useStore(this.$pinia)[key]
} as () => any
```

源码位置: `packages/pinia/src/mapHelpers.ts:262-265`

**为什么这么写（从代码与注释推断）**：
- Options API 的 `computed` 字段期望的就是「取值函数」、`methods` 字段期望的就是「方法函数」——返回函数恰好对齐 Vue 的字段约定，可直接 `...` 展开。
- 每次访问都重新 `useStore(this.$pinia)`，保证在 **HMR 热替换、SSR 多实例、测试替换 store** 后仍拿到「当前正确实例」，而不是 map 调用那一刻缓存的旧 store。

### 1.2 `this.$pinia` 是与组件世界的唯一连接点

每个生成的函数都用 **普通 `function`**（非箭头函数）声明并标注 `this: ComponentPublicInstance`，从而拿到组件实例，再读全局注入的 `$pinia`：

- `$pinia` 的类型来自 Vue 的模块声明增强，类型为 `Pinia`：`$pinia: Pinia`
  源码位置: `packages/pinia/src/globalExtensions.ts:10-12`
- 随后 `useStore(this.$pinia)` 返回该 pinia 上的 store 实例（`useStore` 即 `defineStore` 返回的 `StoreDefinition`，详见 store-definition 章）。

**推断**：这正是 Options API 能「跨组件实例、跨请求」正确取 store 的关键——store 不在 map 时绑定，而在组件渲染求值时按 `this.$pinia` 现取。

### 1.3 数组 / 对象双形态 + reduce 拼接

`mapState`、`mapActions`、`mapWritableState` 三者结构高度同构：都先用 `Array.isArray(keysOrMapper)` 分流，再用 `reduce` 把目标对象逐键拼出来。

- 数组形态：键名 = store 上的属性名，直接 `store[key]`。
- 对象形态：键名 = 自定义别名，值是「store 上的属性名（字符串）」或「自定义函数」。

源码位置（以 `mapState` 为例）:
- 数组分支: `packages/pinia/src/mapHelpers.ts:259-269`
- 对象分支: `packages/pinia/src/mapHelpers.ts:270-289`

## 2. 关键调用链

### 2.1 mapState（state + getter → computed getter）

数组形态：
```
组件 computed 求值
  → mapState 生成的 function(this)
    → useStore(this.$pinia)            // 取 store 实例
      → store[key]                     // 读 state 属性或 getter
```
源码位置: `packages/pinia/src/mapHelpers.ts:262-265`

对象形态（value 为函数时多一步）：
```
组件 computed 求值
  → mapState 生成的 function(this)
    → useStore(this.$pinia) → store
    → typeof storeKey === 'function'
        ? storeKey.call(this, store)   // 自定义 mapper，可访问组件 this
        : store[storeKey]              // 字符串别名，直接取属性
```
源码位置: `packages/pinia/src/mapHelpers.ts:273-285`

> 注意：对象形态的 mapper 函数通过 `.call(this, store)` 调用，因此其函数体内可用 `this` 访问组件实例；但 JSDoc 明确「it won't be typed」（TS 不为其标注 this 类型）。
> 源码位置: `packages/pinia/src/mapHelpers.ts:163-166`（JSDoc）、`278-282`（实现）

### 2.2 mapActions（action → methods）

```
组件触发方法（传入 ...args）
  → mapActions 生成的 function(this, ...args)
    → useStore(this.$pinia)[key](...args)   // 取 action 并透传参数
```
源码位置:
- 数组分支: `packages/pinia/src/mapHelpers.ts:400-406`
- 对象分支: `packages/pinia/src/mapHelpers.ts:412-418`

与 mapState 的差异：函数签名多了 `...args: any[]` 并透传给 action，因为 action 是方法、需接受参数。

### 2.3 mapWritableState（可写 state → 带 setter 的 computed）

```
组件读取  → get(this)  → useStore(this.$pinia)[key]
组件赋值  → set(this, value) → useStore(this.$pinia)[key] = value   // 直接写 store 属性
```
源码位置:
- 数组分支: `packages/pinia/src/mapHelpers.ts:521-531`
- 对象分支: `packages/pinia/src/mapHelpers.ts:538-549`

**关键差异**：value 不是函数，而是 `{ get, set }` 对象，对应 Vue「带 setter 的 computed」。`set` 是 **直接对 store 属性赋值**（`store[key] = value`），因此 JSDoc 明确：与 `mapState` 不同，**只能映射 state 属性、不能映射 getter**（getter 是只读计算属性，写入会失败）。
源码位置: `packages/pinia/src/mapHelpers.ts:460-464`（JSDoc 说明）、`529`、`547`（赋值实现）

### 2.4 mapStores（多 store → computed，键名 = id + 后缀）

```
组件 computed 求值
  → mapStores 生成的 function(this)
    → useStore(this.$pinia)   // 返回整个 store 实例
```
源码位置: `packages/pinia/src/mapHelpers.ts:109-117`

键名拼接：`reduced[useStore.$id + mapStoreSuffix]`，即「store 的 `$id` + 全局后缀（默认 `'Store'`）」。
源码位置: `packages/pinia/src/mapHelpers.ts:111`

### 2.5 mapGetters（deprecated alias）

```ts
export const mapGetters = mapState
```
源码位置: `packages/pinia/src/mapHelpers.ts:296`（含 `@deprecated use mapState() instead`，`292-295`）

仅为兼容旧 API 的别名，无独立实现。

## 3. 后缀定制机制（mapStoreSuffix / setMapStoreSuffix）

- `mapStoreSuffix` 是 **模块级 `let` 可变变量**，初值 `'Store'`：
  ```ts
  export let mapStoreSuffix = 'Store'
  ```
  源码位置: `packages/pinia/src/mapHelpers.ts:62`

- `setMapStoreSuffix(suffix)` 直接覆写该全局变量（可设为空串）：
  源码位置: `packages/pinia/src/mapHelpers.ts:71-77`

- 类型侧用空接口 `MapStoresCustomization` 供用户 **声明式合并**（`interface MapStoresCustomization { suffix: 'MySuffix' }`），以便 `_StoreObject` 在编译期拼出正确的键名类型。
  源码位置: `packages/pinia/src/mapHelpers.ts:17-21`（接口）、`26-53`（`_StoreObject` 消费该接口）、`64-70`（JSDoc 提示需扩展接口）

**易混淆点**：后缀是 **运行时全局可变状态**（`let`），改了会影响所有后续 `mapStores` 调用；而 TS 类型拼接依赖用户手动扩展 `MapStoresCustomization` 接口——两者需同步，否则运行时键名与类型不一致。

## 4. dev-only 误用保护（仅 mapStores）

`mapStores` 开头有一段 dev-only 兜底，处理用户误把 store 数组当单个参数传入的情况：

```ts
if (__DEV__ && Array.isArray(stores[0])) {
  diagnostics.PINIA_R1001()
  stores = stores[0]
}
```
源码位置: `packages/pinia/src/mapHelpers.ts:104-107`

- 触发条件：`mapStores([useAuthStore, useCartStore])`（错误地把数组整体作为一个参数）。
- dev 行为：调用 `diagnostics.PINIA_R1001()` 报告，并把 `stores` 修正为内层数组继续运行。
- 该诊断条目的文案明确「This will fail in production」（生产环境会失败）：
  源码位置: `packages/pinia/src/diagnostics.ts:11-15`
- **`__DEV__` 是编译期常量**，生产构建会被 tree-shake 掉整段判断；这也是本模块与 `diagnostics` 模块的唯一连接点。

## 5. 类型工具（内部 `_` 前缀导出）

文件导出一批以 `_` 开头、标注「For internal use **only**」的类型，用于给上述运行时函数标注返回类型，使其能被组件 `...` 展开后获得正确推导：

| 类型 | 作用 | 源码位置 |
|---|---|---|
| `_StoreObject<S>` | 由 `StoreDefinition` 推出 `{ id+suffix: () => Store }` 形态 | `26-53` |
| `_Spread<A>` | 递归把多个 store 的 `_StoreObject` 交叉合并（`mapStores` 返回类型） | `58-60` |
| `_MapStateReturn` | mapState **数组**形态返回类型 | `123-136` |
| `_MapStateObjectReturn` | mapState **对象**形态返回类型（支持 value 为函数） | `141-156` |
| `_MapActionsReturn` / `_MapActionsObjectReturn` | mapActions 数组 / 对象形态返回类型 | `301-303`、`308-310` |
| `_MapWritableStateKeys` | 可写键集合：`keyof UnwrapRef<S> | keyof _StoreWithGetters_Writable<G>` | `428-430` |
| `_MapWritableStateReturn` / `_MapWritableStateObjectReturn` | mapWritableState 返回类型，值为 `{ get; set }` | `435-444`、`449-458` |

**需 Writer 注意**：实现中散布大量 `// @ts-expect-error` 与 `// FIXME: should work?` 注释（如 `263`、`272`、`283`、`399`、`404`、`411`、`416`）。这表明这些类型是 **手工对齐 Vue Options API 运行时约定**（computed 期望函数、methods 期望函数、可写 computed 期望 `{get,set}`）的拼接产物，存在已知的类型摩擦点——属正常现象，非 bug，写章节时可点明「类型为运行时结构服务」。

## 6. 重载结构（三个 map 函数均为「对象重载 + 数组重载 + 实现签名」三段式）

`mapState`、`mapActions`、`mapWritableState` 各自有 **3 个签名**：对象形态重载、数组形态重载、最后一个是「实现签名」（参数最宽泛、`any`/联合类型，函数体据此分流）。

以 `mapState` 为例：
- 对象重载: `packages/pinia/src/mapHelpers.ts:194-206`
- 数组重载: `packages/pinia/src/mapHelpers.ts:231-240`
- 实现签名 + 函数体: `packages/pinia/src/mapHelpers.ts:250-290`

`mapActions` 三段: `337-346` / `370-378` / `387-423`
`mapWritableState` 三段: `468-477` / `486-495` / `504-554`

> 这种「窄重载在前、宽实现兜底」的排列是 TS 重载解析的标准写法：调用点匹配到窄重载获得精确类型，运行时统一进实现签名按 `Array.isArray` 分流。

## 7. 易混淆 / 需 Writer 注意（汇总）

1. **mapWritableState 只能映射 state，不能映射 getter**：因 `set` 直接 `store[key] = value` 写属性，getter 只读会失败。JSDoc 已明确「only `state` properties can be added」。
   源码位置: `packages/pinia/src/mapHelpers.ts:460-464`、`529`、`547`

2. **mapGetters === mapState**（deprecated 别名），二者完全等价，无独立逻辑。
   源码位置: `packages/pinia/src/mapHelpers.ts:296`

3. **mapStores 的键名由 `$id + mapStoreSuffix` 决定**，与 defineStore 的函数名无关，取决于 store 的 id。
   源码位置: `packages/pinia/src/mapHelpers.ts:111`

4. **对象形态 mapper 函数内可用 `this` 但无类型支持**：`.call(this, store)` 让自定义 mapper 能读组件实例，但 TS 不标注其 this。
   源码位置: `packages/pinia/src/mapHelpers.ts:163-166`、`278-282`

5. **`mapStoreSuffix` 是全局可变 `let`**：`setMapStoreSuffix` 产生全局副作用；类型正确性依赖用户手动扩展 `MapStoresCustomization` 接口，二者需同步。
   源码位置: `packages/pinia/src/mapHelpers.ts:62`、`71-77`、`17-21`

6. **dev-only 数组兜底只在 mapStores 有**：`mapState`/`mapActions`/`mapWritableState` 误传数组时会被当作「单元素对象」处理（因 `Array.isArray` 走数组分支，但 reduce 出的键会是数字索引），无诊断保护——这是 mapStores 与其余三个的显著差异。
   源码位置: `packages/pinia/src/mapHelpers.ts:104-107`（仅 mapStores 有保护）；对比 `259`、`397`、`518`（其余三者直接 `Array.isArray` 分流无兜底）

7. **本模块零写入、零订阅**：不碰 `$patch`/`$subscribe`/`$onAction`，只读/只调 store；与 subscription-primitive 章无耦合。依赖图上仅 `dependsOn: ["store-definition"]`，符合「只需 StoreDefinition 即可工作」。
   源码位置: `work/outline.json:96-97`

## 8. 未理解 / 待确认

- `_StoreObject` 中 `${infer RealId}${...}` 这段模板字面量类型的「剥后缀」逻辑（`packages/pinia/src/mapHelpers.ts:40-47`）较为晦涩：其意图似乎是「从拼接了后缀的键反推真实 id」，但仅服务于类型推导，对运行时无影响。建议 Writer 讲类型时点到为止，不必深究其内部推断细节——若需精确解释，需另开 TS playground 验证，此处标注为「未深入验证」。