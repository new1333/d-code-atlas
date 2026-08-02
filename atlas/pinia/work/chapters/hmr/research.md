# HMR：保留状态下的 store 热更新 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：开发时改了一行 store 代码（加个 action、改个 getter），Vite 默认走整页刷新——刚刚登录的用户态、填了一半的表单、跑了一半的异步流程全没了；就算不刷页，已经 import 了旧 store 的组件也还在用旧的 action 函数。开发者希望"换实现，留状态"。
- **一句话核心思想**：**用一个临时影子 store 跑通新代码、再把它的零件换装到老 store 的同一个壳上**——保留响应式对象身份，让组件毫无感知。
- **设计动机（为什么需要它）**：Pinia 的 store 是一个 reactive 代理对象，已经被无数组件 `useStore()` 持有、绑定到模板、订阅了 `$subscribe`。HMR 不能简单"重建对象"——一旦换身份，所有依赖都会断。所以必须找一种方式：**让旧的 store 对象"长出"新的方法、丢掉被删的字段、保留状态值**。
- **关键权衡**：
  - **就地属性替换 vs. 重建 store 对象**：选了前者 → 换来了"组件持有的 store 引用无需任何改动、响应式订阅全部保留" → 代价是 `_hotUpdate` 必须逐字段处理 state/getter/action，逻辑复杂且必须区分 option store 与 setup store。
  - **新建 `'__hot:'+id` 影子 store 复用 setup 管线 vs. 直接读新模块导出**：选了前者 → 换来了"无需为 HMR 单独写一套'解析新代码'的路径，完全复用 createSetupStore" → 代价是临时污染 `pinia._s` 和 `pinia.state.value`，必须手动清理。
  - **option store 走 deep merge、setup store 走整值转移**：选了这种**不对称处理** → 换来了"option store 已声明完整 state 形状，可按 key 细粒度保留旧值；setup store 因可运行时新增字段，必须整值转移避免丢字段" → 代价是同一份 `_hotUpdate` 内嵌两条分支，理解成本翻倍。
  - **HMR 期间临时关掉 `isListening` vs. 让 watcher 正常触发**：选了前者 → 换来了"$subscribe 不会被 HMR 的 state 搬运误报为 mutation" → 代价是这套 listening flag 机制和 `$patch` 共用，承担了两种语义。
  - **id 漂移强制 `hot.invalidate()` 整页重载 vs. 静默接受新 id**：选了前者 → 换来了"store 身份稳定可追踪，devtools 和缓存语义不会被绕晕" → 代价是这次编辑彻底失去 HMR 收益（开发者会注意到这是少数会触发整刷的情形）。
- **最小心智模型（3～7 步）**：
  1. Vite 检测到 store 文件改动 → 触发用户注册的 `import.meta.hot.accept` 回调（即 `acceptHMRUpdate` 返回的函数）。
  2. 回调遍历**新模块的所有导出**，用"是不是函数 + 有没有 `$id` 字符串"这种鸭子类型识别哪些是 store 定义。
  3. 从 `hot.data` 拿到上次缓存的 pinia 实例（首次从 `useStore._pinia` 兜底）；若拿不到说明 store 还没被用过，直接 return 不做任何事。
  4. 对每个被识别的 store 定义，调用 `useStore(pinia, existingStore)`——**把"老 store"作为第二个参数 `hot` 传入**，这是整个机制的"暗号"。
  5. `useStore` 见到 `hot` 入参就进入 HMR 模式：用一个带 `'__hot:'` 前缀的临时 id 跑一遍常规 setup 流水线，得到一份"新代码的影子 store"。
  6. 调 `existingStore._hotUpdate(影子 store)`——这是核心手术：逐项替换 actions/getters、按 store 类型搬运 state、删掉被移除的字段；过程中老 store 这个 reactive 对象的身份始终不变。
  7. 清理：把临时 id 从 `pinia._s` 和 `pinia.state.value` 里删掉，相当于影子完成器官捐献后离场。
- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个表达"换零件不换壳"核心思想的最小实现（30~50 行）——
    - `makeStore(id, factory)` 返回一个 `reactive({ $id, _parts, ...runtime })`；factory 返回 `{ state, getters, actions }`。
    - 给 store 装 `_hotUpdate(newFactory)` 方法：跑新 factory 得到新 parts，遍历新 parts 把 action/getter 逐个赋值到 `this` 上（reactive 代理保证组件看到的引用不变），删掉新 parts 里没有的旧 key；state 走"老值优先、新结构兜底"的策略。
    - `simulateHMR(useStore, newFactory)`：找到已注册的 store、调 `_hotUpdate`——演完核心闭环。
  - **演的是哪条权衡/思想**：演透"就地替换属性而非重建 store"——这是 HMR 章的灵魂。
  - **应故意省略**：Vite 真实接线（`import.meta.hot`）、option/setup 二分merge 的细节、`isListening` 关闭、devtools 集成、影子 store 的 `'__hot:'` 前缀（演示里可以直接构造新 parts 不必走完整 setup）。
  - **演示载体建议**：本仓库是 TS，**建议写成能 `bun run`/`npx tsx` 直接跑的脚本**（不要求真接 Vite）。脚本里手动模拟"老 store 已被某组件持有 → 触发 hot update → 验证老引用上的方法已变、但响应式监听仍工作"。这是最容易让读者"摸到"对象身份保留的小载体。
- **正文不宜展开的细节**：
  - `_hmrPayload` 的 `markRaw` 包装（防响应式追踪）。
  - `_getters` 数组与 devtools 自定义属性 `_customProperties`。
  - `Object.defineProperty` 把 `_p`/`_hmrPayload`/`_getters` 设为 nonEnumerable（藏起来不被 devtools 列出）。
  - `useStore._pinia` 缓存（首次 HMR 时让 `acceptHMRUpdate` 找到 pinia）。
  - `onTrigger` 中的 `_hotUpdating` 标志位（避免 HMR 期间的 watcher 事件被错误归集到下一次 patch 的 debuggerEvents）。
  - option store 的 `hydrate` 钩子（与 HMR 无直接关系）。
- **推荐的一个执行轨迹例子**：
  - 输入：开发者保存 `userStore.ts`，把 `login()` 函数体改了，并新增 `logout()` action。
  - 关键中间态：Vite 推送新模块 → `acceptHMRUpdate` 遍历导出，识别到 `useUser`，命中 `pinia._s.has('user')` → 调 `useUser(pinia, existingUserStore)` → 在 `'__hot:user'` 临时 id 下跑新 setup → `existingUserStore._hotUpdate(shadow)`：`login` 被赋为新版 action 包裹，`logout` 被新增到 store，state 完全沿用旧 ref → 影子被清理。
  - 输出：任何 `useUser().login()` 的组件下一次调用跑的是新代码、`logout` 可用、登录态值未丢、组件无需重新挂载。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **HMR 入口在用户代码里**：Pinia 不主动监听模块变化。开发者必须显式写 `import.meta.hot.accept(acceptHMRUpdate(useStore, import.meta.hot))`；这意味着 Pinia 提供"接受更新的能力"，触发时机由用户/Vite 决定。源码位置: `packages/pinia/src/hmr.ts:78-83`
- **生产环境零成本**：`acceptHMRUpdate` 在非 `__DEV__` 下直接返回空函数 `() => {}`，整个 HMR 链路在生产 bundle 里被彻底剥除。源码位置: `packages/pinia/src/hmr.ts:85-87`
- **鸭子类型识别 store**：`isUseStore` 仅判 `typeof fn === 'function' && typeof fn.$id === 'string'`——因为 `defineStore` 返回的 `useStore` 函数上挂了字符串 `$id`。这是 HMR 遍历模块导出时唯一的识别手段。源码位置: `packages/pinia/src/hmr.ts:20-22`
- **pinia 实例的跨次缓存**：`acceptHMRUpdate` 优先从 `hot.data.pinia`（Vite 在多次热更新间持久化的对象）取 pinia，首次 fallback 到 `initialUseStore._pinia`（首次使用 store 时被写入），随后立即写回 `hot.data.pinia`。这保证即便 store 文件多次热更新，pinia 始终是同一个。源码位置: `packages/pinia/src/hmr.ts:89-97`
- **id 漂移 = 整页重载**：若新模块里某个 `useStore.$id` 与初始 `initialUseStore.$id` 不一致，调 `diagnostics.PINIA_R1005` 报警告并 `hot.invalidate()`——Vite 会放弃 HMR 改走整页刷新。源码位置: `packages/pinia/src/hmr.ts:107-111`；诊断文案在 `packages/pinia/src/diagnostics.ts:33-37`
- **`hot` 参数的双重身份**：`acceptHMRUpdate` 调 `useStore(pinia, existingStore)` 时把"老 store"作为第二个参数（命名 `hot`）传入。`useStore` 内部完全靠这个参数 truthy 与否切换 HMR 模式——这是非常 compact 的 API 复用。源码位置: `packages/pinia/src/hmr.ts:118` 与 `packages/pinia/src/store.ts:883`
- **`useStore._pinia` 缓存的写入时机**：仅当 `pinia._s` 里没有该 store 时（即首次创建分支）才在创建后写入 `_pinia`。所以一个 store 文件被首次使用后，HMR 才能找到 pinia。源码位置: `packages/pinia/src/store.ts:911-914`
- **影子 store 用 `'__hot:'+id` 临时 id**：避免覆盖 `_s` 里的真实 store 条目，跑完 setup 流水线后再删。源码位置: `packages/pinia/src/store.ts:919-923`
- **HMR 模式下 setup 流水线的差异**：在 `createSetupStore` 内部，`hot=true` 时——
  - state 不写入 `pinia.state.value[$id]`，而是记录到 `_hmrPayload.state[]` 和 `hotState` ref 中。
  - action 不被 `action()` 包裹（保留 raw function），因为 `_hotUpdate` 会自己重包一次绑定到老 store 的 scope。
  - getter 仅记录到 `_hmrPayload.getters`。
  - `$state` getter 返回 `hotState.value` 而非真实 state。
  源码位置: `packages/pinia/src/store.ts:510-571`, `583-589`
- **`_hmrPayload` 是 HMR 的"零件清单"**：`markRaw({ actions: {}, getters: {}, state: [], hotState })`——记录这份影子 store 拆解后的可移植零件，供 `_hotUpdate` 消费。源码位置: `packages/pinia/src/store.ts:424-429`
- **`_hotUpdate` 注册时机早于插件**：注释明确"add the hotUpdate before plugins to allow them to override it"——用户插件若想自定义 HMR 行为可覆盖该方法。源码位置: `packages/pinia/src/store.ts:597-600`
- **`_hotUpdating` 标志位**：在 `$subscribeOptions.onTrigger` 里，只有 `isListening === false && !store._hotUpdating` 才会把 watcher 事件收集到 debuggerEvents。HMR 期间虽然也会暂时关掉 isListening，但通过 `_hotUpdating` 标志区分，避免被误塞进 patch 的批量事件里。源码位置: `packages/pinia/src/store.ts:251-261`, `601`, `692`
- **listening 关闭策略与 `$patch` 完全一致**：sync 立即恢复、async 在 `nextTick` 恢复。复用同一套机制服务两种语义。源码位置: `packages/pinia/src/store.ts:639-645`（对比 `$patch` 的 `293-321`）
- **option store 的 state hydration 在 HMR 时的差异**：`createOptionsStore` 内的 `setup()` 在 `__DEV__ && hot` 时**不复用** `pinia.state.value[id]`，而是新 `ref(state()).value` toRefs 出来——这样影子 store 的 state 完全独立，等 `_hotUpdate` 决定如何合并。源码位置: `packages/pinia/src/store.ts:172-177`
- **option store 与 setup store 在 `_hotUpdate` 中合并策略不同**：option store 对 plain object 子节点用 `patchObject` 做 deep merge（保留旧值的同时接纳新结构），setup store 直接整值转移（避免丢掉运行时新增字段）。代码内联注释引用了 issue #2611 解释这一不对称。源码位置: `packages/pinia/src/store.ts:602-628`

## 关键调用链