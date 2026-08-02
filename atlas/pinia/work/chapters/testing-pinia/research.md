# @pinia/testing：用插件桩化 action 与 $patch · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在单元测试里，被测组件触发了一个 store action，但 action 内部可能发请求、写 localStorage、依赖其他 store——你只想断言「这个 action 被调用了，参数是 X」，并不想让真实副作用跑起来。直接用真 Pinia 的话，action 会真执行、改 state、产生副作用，单元测试退化为又慢又脆的集成测试。

- **一句话核心思想**：**复用生产线的同一套插件钩子，在测试里把 store 的可变部件「换装」**——不为测试另起一条 store 工厂。

- **设计动机（为什么需要它）**：如果另起炉灶造一个「测试专用 store 工厂」，就会和真实的 store 创建路径分叉，每次 Pinia 升级都得同步改两份；选择「插件复用」意味着所有桩化都跑在和 production 完全相同的 store 创建管线上，行为一致性来自机制共享，不是来自重新模仿。

- **关键权衡（直接喂 Writer「关键权衡」小节）**：
  1. **绕过 app.use 安装队列、直接 push 进活动插件列表** → 换来「纯 store 测试不需要 createApp 也能让插件生效」 → 代价是依赖 app 实例的（业务）插件必须额外伪造一个空 app 调一次 app.use，否则那些插件永不执行。
  2. **四个内部插件按固定顺序追加（预设 state → 用户插件 → 可写 getter → action 桩化）** → 换来「用户插件看到的是真实 getter/action，最后才被桩化」 → 代价是用户无法调整这个顺序；极少数依赖「桩化后 action」的用户插件会拿到 spy 而非原函数。
  3. **可写 getter 借助 Vue 计算引用的内部缓存字段做覆写** → 换来「`store.double = 3` 这种自然写法可行，且原生懒求值/缓存语义保留」 → 代价是绑死 Vue reactivity 内部实现，Vue 升级改这些私有字段就会破坏能力；并且需要一个 `restoreGetter` 显式回滚（设回 undefined 触发恢复分支）。
  4. **默认全桩 + 三种粒度（布尔/数组/谓词）** → 换来「零配置上手 + 精细控制」 → 代价是新用户常常困惑「我的 action 怎么没生效」，需要读文档才知默认是全桩（这是最常见 issue 来源）。

- **最小心智模型（3～7 步）**：
  1. 创建一个普通 Pinia 实例。
  2. 按固定顺序把 4 个内部改造器追加进它的活动插件列表（绕过「等待 app.use」的待安装队列）。
  3. 可选：若业务插件依赖 app 实例，伪造一个空 app 调一次 app.use。
  4. 把这个测试 Pinia 设为当前活跃实例（让组件外的 useStore 也能拿到它）。
  5. 测试中 useStore() 触发 store 创建，创建末尾按插件顺序逐个跑改造器：注入预设 state → 跑用户插件 → 把每个 getter 包成可写 → 把每个 action 换成 spy。
  6. 测试里调 store.someAction() 实际跑的是 spy（默认全桩不执行原代码），用 spy 的断言 API 检查调用次数/参数。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达「插件换装」核心思想**的从零实现，约 25 行；每一行对应「权衡 #1（绕过安装队列）」与「权衡 #4（默认全桩）」。其他权衡（可写 getter、多粒度 stubActions）在演示里**故意不做**。
  - 应故意省略：可写 getter 的 ComputedRefImpl 私有字段操控（复杂度最高，正文配图讲清即可）、mergeReactiveObjects（与 patch-and-merge 章重合）、多形态 stubActions 谓词分支、fakeApp 路径、createSpy 工厂的三段 fallback、TS 高级类型推导。
  - **演示载体建议**：本章机制是**纯 TS、不依赖 DOM/浏览器**，建议写成一段 ~25 行的 `tsx`/`bun`/`vitest` 可跑脚本（能跑最好，非硬要求）。无需 Vue 组件挂载，因为桩化发生在 store 创建管线里，与组件树无关。最小骨架：

    ```ts
    import { createPinia, defineStore } from 'pinia'

    // 一个最小 spy 工厂：占位真实测试框架的 vi.fn / jest.fn
    function makeSpy() {
      const fn = (...args: any[]) => { (fn as any).calls.push(args) }
      ;(fn as any).calls = []
      return fn as any
    }

    // 思想核心：复用 pinia 的插件钩子做「换装」
    function createTestingPinia() {
      const pinia = createPinia()
      // 真实实现里是 pinia._p.push(...)（绕过 app.use 的待安装队列）
      // 这里用伪 API 表达同一思想：注册一个「每次 store 创建时调用」的改造器
      registerStorePlugin(pinia, ({ store, options }) => {
        for (const name in options.actions) {
          store[name] = makeSpy()           // 全桩：丢弃原实现
        }
      })
      return pinia
    }

    // 用法：action 被替换为空 spy，调用不会真改 state，但调用记录可断言
    const pinia = createTestingPinia()
    const useStore = defineStore('counter', {
      state: () => ({ n: 0 }),
      actions: { inc() { this.n++ } },
    })
    const s = useStore(pinia)
    s.inc()
    console.log(s.n)            // 0  （原 action 没跑）
    console.log(s.inc.calls)    // [[]]（但调用被记录）
    ```

    这段演示演的是「权衡 #1 + #4」：通过插件钩子复用生产线、默认全桩换装。Writer 写正文时可直接复用此骨架，把可写 getter / 谓词 stubActions 作为「进阶变体」分小节展开。

- **正文不宜展开的细节**：
  - 内置 `mergeReactiveObjects` / `isPlainObject` 与 patch-and-merge 章重合，正文一句话带过「复用了同款深度合并」即可，不重述。
  - `diagnostics` 用 `nostics` 库定义错误码（PINIA_TESTING_C0001/C0002）的写法——属工程化细节。
  - `declare var vi` 的全局类型双形态（undefined | { fn }) 技巧——TS 边角。
  - `pinia._testing = true` 标志位的下游消费方（devtools 等可能读取）——本章不展开。
  - `Object.defineProperty(pinia, 'app', ...)` 把内部 `_a` 暴露成只读 `app` 的 get 代理——可作「随手带过的便利字段」处理。

- **推荐的一个执行轨迹例子**：
  - 输入：`createTestingPinia({ stubActions: false })` + 一个 counter store，其 action `inc(amount)` 使 `n += amount`。
  - 关键中间态：
    1. 4 个内部改造器按「initialState → (无用户插件) → 可写 getter → action 桩化」顺序追加进活动插件列表。
    2. `useStore(pinia)` 触发 store 创建，末尾按序跑改造器；inc 不是 $reset，进入桩化分支。
    3. 因 `stubActions=false`，桩化逻辑选择「spy 包原 fn」而非「空 spy」，于是 `store.inc` = `spy(原 inc)`。
  - 输出：测试里调 `store.inc(5)` → spy 记录 `args=[5]` 并转调原 inc → `state.n` 从 0 变 5；`expect(store.inc).toHaveBeenCalledWith(5)` 与 `expect(store.n).toBe(5)` 同时通过。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **入口 API 形态**：`createTestingPinia(options?)` 返回一个普通 `Pinia` 实例（接口上扩展为 `TestingPinia`，多一个只读 `app` 字段），可直接 `mount(Component, { global: { plugins: [pinia] } })` 或 `setActivePinia(pinia)` 后在组件外用 `useStore()`。源码位置: packages/testing/src/testing.ts:104-177

- **绕过 toBeInstalled 队列**：所有内部改造器都用 `pinia._p.push(...)` 直接追加到**活动插件列表**，而不是走 `app.use(pinia)` 触发的待安装队列。源码注释明确点出这是为了「确保桩化最后发生」。源码位置: packages/testing/src/testing.ts:116, 123, 126, 146

- **四个内部改造器的固定顺序**：(1) initialState 注入 → (2) 用户传入的 `plugins[]` → (3) WritableComputed（getter 可写化）→ (4) action/$patch/$reset 桩化。这个顺序在 `createTestingPinia` 体内由四段 `_p.push` 的书写顺序固定。源码位置: packages/testing/src/testing.ts:116-157

- **initialState 注入逻辑**：改造器遍历 store，若 `initialState[store.$id]` 存在则 `mergeReactiveObjects(store.$state, ...)`，按 store id 分桶。源码位置: packages/testing/src/testing.ts:116-120

- **createSpy 三段 fallback**：用户 `_createSpy` → 全局 `jest.fn`（typeof 未定义则跳过）→ 全局 `vi.fn`。若都没有，抛 `PINIA_TESTING_C0001`；若用户误传已调用的 `vi.fn()`（带 `mockReturnValue`），抛 `PINIA_TESTING_C0002`。源码位置: packages/testing/src/testing.ts:128-143

- **action 桩化的两条分支**：`shouldStubAction(...) ? createSpy() : createSpy(store[action])`——要桩就给空 spy（不调原 action），不桩就给「包原 fn 的 spy」（仍执行原代码）。`$reset` 在 actions 遍历里被显式 `return` 跳过，由独立的 `stubReset` 选项控制。源码位置: packages/testing/src/testing.ts:147-156

- **stubActions 的三种形态**：`boolean`（全桩/全不桩）、`string[]`（按名字白名单）、`(actionName, store) => boolean`（谓词精细控制）。`shouldStubAction` 内三分支判断。源码位置: packages/testing/src/testing.ts:270-283

- **WritableComputed 的劫持对象**：遍历 `toRaw(store)` 的每个 key，凡 `isComputed`（即 `isRef(v) && 'effect' in v`）的，用一个新的 `computed({ get, set })` 替换。get 委托原 computed；set 走「改原 computed 内部字段」的恢复/覆写分支。源码位置: packages/testing/src/testing.ts:226-261

- **WritableComputed setter 的两条分支**：
  - `newValue !== undefined`：把原 computed 的 `fn` 换成「返回固定 _value」的覆盖函数，并把 `_value = newValue`——后续读取恒返回 newValue。
  - `newValue === undefined`：恢复原 `fn`、`delete _value`、`_dirty = true`——下次读取会重算。
  - 两条分支末尾都 `triggerRef(originalComputed)` 通知 setup store 链路上的依赖。源码位置: packages/testing/src/testing.ts:243-257

- **isComputed 判定**：通过 `'effect' in v` 区分 computed 与普通 ref——computed 内部持有 `effect` 字段（Vue reactivity 实现细节）。源码位置: packages/testing/src/testing.ts:220-224

- **fakeApp 路径**：若业务插件依赖 `_a`（app 实例），用户须传 `fakeApp: true`，函数末尾会 `createApp({}).use(pinia)` 触发待安装队列执行。源码位置: packages/testing/src/testing.ts:159-162

- **`_testing = true` 标志**：写到一个未公开字段上，供 devtools 等下游识别「这是测试 Pinia」。源码位置: packages/testing/src/testing.ts:164

- **setActivePinia**：使组件外的 `useStore()` 能拿到这个测试 pinia，无需 mount 组件即可直接 `useStore()`。源码位置: packages/testing/src/testing.ts:166

- **app getter**：用 `Object.defineProperty` 把内部的 `_a` 暴露成只读 `app`，让测试可以 `pinia.app` 拿到 fakeApp 创建的 app。源码位置: packages/testing/src/testing.ts:168-174

- **restoreGetter**：单独导出的工具函数，把指定 getter 在 store 上设回 `undefined`——结合 WritableComputed 的 setter，传 `undefined` 触发「恢复原 fn + 强制重算」分支，从而回滚之前的覆写。源码位置: packages/testing/src/restoreGetters.ts:13-16

- **包入口**：从 index.ts 仅导出 `createTestingPinia` 函数与 `TestingPinia`/`TestingOptions` 类型——单一公开入口。源码位置: packages/testing/src/index.ts:4-5

## 关键调用链

```
createTestingPinia(options)
  └─ createPinia()                                    // 创建普通实例
  └─ pinia._p.push(initialStatePlugin)                // 顺序 #1
  └─ plugins.forEach(p => pinia._p.push(p))           // 顺序 #2
  └─ pinia._p.push(WritableComputed)                  // 顺序 #3
  └─ pinia._p.push(stubActionsPlugin)                 // 顺序 #4
  └─ if (fakeApp) createApp({}).use(pinia)            // 触发待安装队列
  └─ pinia._testing = true
  └─ setActivePinia(pinia)
  └─ defineProperty(pinia, 'app', getter→_a)
  └─ return pinia

// 测试中 useStore(pinia) 时（走 Pinia 既有的 createSetupStore/createOptionsStore 路径）
useStore(pinia)
  └─ createSetupStore(...)
       └─ for (plugin of pinia._p) plugin({ store, options })  // ← 桩化在这里发生
            ├─ #1 initialState: mergeReactiveObjects(store.$state, init)
            ├─ #3 WritableComputed: toRaw(store) 遍历，computed 替换为可写
            └─ #4 stubActions: options.actions 遍历，store[action] = createSpy(...) / createSpy(原 fn)
```

源码位置: packages/testing/src/testing.ts:104-177（注册侧）+ 226-261 / 146-157（被调用侧的改造器）

## 源码摘录（带行号，全文累计 ≤ 30 行）

```ts
// testing.ts:122-126 — 顺序硬编码 + 绕过待安装队列的关键注释
  // bypass waiting for the app to be installed to ensure the action stubbing happens last
  plugins.forEach((plugin) => pinia._p.push(plugin))

  // allow computed to be manually overridden
  pinia._p.push(WritableComputed)
```

```ts
// testing.ts:146-157 — action/$patch/$reset 桩化：要桩给空 spy，不桩给包原 fn 的 spy
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

```ts
// testing.ts:243-257 — WritableComputed setter：操控 Vue 计算引用的内部字段做覆写/恢复
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
          // this allows to trigger the original computed in setup stores
          triggerRef(originalComputed)
```

```ts
// restoreGetters.ts:13-16 — restoreGetter：setter 传 undefined 触发恢复分支
export function restoreGetter<G>(store: Store, getter: any): void {
  // @ts-expect-error: private api
  store[getter] = undefined
}
```

（合计 27 行）

## 易混淆 / 边界 / 推断

- **事实**：`stubActions` 默认值是 `true`，意味着不传任何 options 时**所有 action 都不执行原代码**——这是最常见的「我调了 action 怎么 state 没变」陷阱来源。源码位置: packages/testing/src/testing.ts:107

- **事实**：`$reset` 在 options.actions 遍历中被显式跳过（`if (action === '$reset') return`），原因是它由独立的 `stubReset` 选项控制——setup store 的 `$reset` 本身就是用户自定义函数，会和真 action 混在 options.actions 里，必须先排除。源码位置: packages/testing/src/testing.ts:148

- **事实**：`createSpy` 既能从全局 `jest` 取，也能从全局 `vi` 取；前提是 Vitest 项目开了 `globals: true`，否则 `vi` 未定义会一路 fallback 到抛 PINIA_TESTING_C0001。源码位置: packages/testing/src/testing.ts:128-143

- **事实**：`isComputed` 用 `'effect' in v` 判定——这依赖 Vue reactivity 暴露在 ComputedRefImpl 上的 `effect` 字段；与 storeToRefs 章使用同款判定（不同仓库章可能用 `v.effect` 直接访问）。源码位置: packages/testing/src/testing.ts:220-224

- **事实**：`WritableComputed` 只对 setup store 返回的 computed 生效（因为 options store 的 getter 也被内部翻译成 markRaw(computed(...))，最终也落到 raw store 上）。两条 store 语法共用同一条改造路径。源码位置: packages/testing/src/testing.ts:226-261

- **推断**：`mergeReactiveObjects` 在本仓库**重新实现了一份**而非 import 自 pinia 主包——推测是为了避免引入循环依赖或为了在 testing 包内独立演进；行为与 patch-and-merge 章描述的版本等价（处理 plain object 递归合并、跳过 ref/reactive 子节点）。源码位置: packages/testing/src/testing.ts:179-218

- **推断**：`WritableComputed` 的 setter 用 `triggerRef(originalComputed)` 收尾——推断是 setup store 链路上某些依赖可能直接订阅了原 computed 的 `RefImpl`，仅改内部字段不足以触发它们，必须显式 trigger。源码位置: packages/testing/src/testing.ts:256

- **推断**：把 `$patch` 和 `$reset` 也用 `createSpy(原函数)` 包裹（默认 `stubPatch=false`/`stubReset=false`）——目的是即使不桩化也允许断言「`$patch` 被调了几次、参数是什么」，这是测试中很常见的需求。源码位置: packages/testing/src/testing.ts:155-156

- **未理解**：`WritableComputed` 中 `overriddenFn` 注释掉了一行 `// originalComputed.fn = overriddenFn`（在 set 之外的位置），但实际在 setter 的 else 分支里又设置了 `originalComputed.fn = overriddenFn`——这行被注释的代码是早期实验残留还是有意保留作 future hook？源码里看不出明确意图。源码位置: packages/testing/src/testing.ts:236

- **边界**：若用户的 action 名与 `$reset` 重名（极端罕见），该 action 会被无条件跳过桩化——这是 `if (action === '$reset') return` 的副作用，文档未明确警告。源码位置: packages/testing/src/testing.ts:148