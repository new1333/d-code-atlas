# 测试替身：作为插件链的 spy 注入 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：单元测试组件时，真实 store 的 action 会真去发请求、读写全局状态，把测试弄得脏脏的；getter 往往依赖外部数据，断言时难以控制返回值；而每个测试都要手动给每个 `useStore` 传 pinia 实例，又啰嗦又容易漏。

- **一句话核心思想**：不另造一套"假 store"，而是把测试替身**伪装成一串插件**，顺着真实 store 的装配管线一路走到末端，在最后一刻悄悄把 action / `$patch` / `$reset` / getter 换成 spy。

- **设计动机（为什么需要它）**：替身只想"换掉会引发副作用的少数几样东西"，其余（响应式结构、订阅、插件扩展）必须和真实 store 完全一致，否则测出来的行为不可信。复用真实装配管线、只在末端做替换，恰好满足"结构与真实 store 同构，只差被替换的部分"这个矛盾。

- **关键权衡（选择 → 换来 → 代价）**：
  1. **把替身插件直接塞进"已生效插件队列"，而非走应用安装流程** → 换来在纯单元测试里**无需真实 app / 组件挂载**就能让替换生效 → 代价是必须**自己保证替换插件排在队列最末**（否则被更晚入队的插件覆盖），于是对用户自带插件要主动"插队"到替身之前。
  2. **让同一个 spy 工厂同时承担"丢弃原实现"与"放行但记录调用"两种角色**（无参造空壳 vs 传入原函数做包裹）→ 换来**一套机制既支持完全 mock、也支持 spy-through** → 代价是 spy 工厂的调用契约必须能区分"要不要原函数"，传错会静默走错分支，故需要额外校验并在误用时直接报错。
  3. **为让只读 getter 可被测试覆写，深入响应式内部改写 computed 的内部字段与缓存值** → 换来测试里能**直接给一个只读计算属性赋任意值** → 代价是**强耦合响应式库的私有实现**，上游升级有破坏风险，且必须配一个"恢复原值"的旁路。
  4. **把"要替换哪些 action"做成布尔 / 名单 / 谓词三种形态** → 换来"全 mock / 指名 mock / 按规则 mock"覆盖不同测试策略 → 代价是选项类型变成联合体、心智与文档成本上升（而 `$patch` / `$reset` 只有布尔两态，粒度不对等）。

- **最小心智模型（3～7 步）**：
  1. 创建一个**真实** pinia 实例（不是 mock），拿到它内部的"已生效插件队列"。
  2. 按序往队列里塞四类插件：初态合并 → 用户自带插件 → getter 改写 → action / `$patch` / `$reset` 替换（**最后塞**）。
  3. 解析 spy 工厂：优先用用户传入的，否则自动探测当前测试框架自带的 spy 工厂；缺失或传错（把已实例化的 spy 当成工厂传）就**直接抛错**。
  4. 给 pinia 打上"测试中"标记，并把它设为全局活跃实例（这样被测代码不传 pinia 也能命中它）。
  5. （可选）若用户要求，造一个空应用执行一次安装，把那些走"待安装队列"的插件也冲进已生效队列，并补上应用上下文。
  6. **延迟生效点**：当被测代码首次取用某 store 时，装配管线按队列顺序逐一跑插件——跑到末端时，action 已被换成 spy。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**几十行**的从零实现，只演核心思想——"创建真实 pinia → 往其插件队列末端推一个'替身插件'→ 该插件在 store 装配时把 action 换成空 spy → 设为活跃 pinia"。被测代码取用 store 时即得到被替换的版本。**每一行都对应上面权衡①②**（直接入队、末端覆盖、spy 双角色）。
  - 应故意省略：getter 改写的响应式内部 hack、spy 工厂的框架自动探测与传参校验、空应用安装、恢复 getter 的辅助函数、完整泛型、诊断目录。**不追求工程完整、不追求可独立 install**，只演透"替身即插件、末端替换"这一思想。

- **正文不宜展开的细节**：spy 工厂对测试框架的自动探测，以及两种误用（未配置 / 把实例当工厂）的报错码；初态合并工具与核心同名工具在 Map/Set 处理上的差异；getter 改写里对 setup store 触发重算的响应式时序细节；恢复 getter 的辅助函数目前仍是未定型的占位实现。

- **推荐的一个执行轨迹例子**：输入——创建测试 pinia 并配置"只替换指定名字的 action"；随后被测组件取用该 store。关键中间态——store 装配时插件队列跑到末端，指定 action 被换成空壳（其余 action 被包成"仍执行但记录调用"的 spy，`$patch`/`$reset` 同样被包裹放行）。输出——调用那个指定 action 不发任何请求、返回 undefined，但测试可断言"它被以这些参数调用过"；其余 action 正常执行。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **替身不另起实现，全部走插件队列**：`createTestingPinia` 先 `createPinia()` 拿到一个真实 pinia，然后直接往 `pinia._p`（"已生效插件队列"）里依次 `push` 四个插件——初态合并、用户插件、getter 改写、action 替换。源码位置: packages/testing/src/testing.ts:113-157

- **action 替换插件刻意排在最后**：替换 action / `$patch` / `$reset` 的插件（testing.ts:146）在 `WritableComputed`（testing.ts:126）之后 push，是队列里最后一个；用户经 `plugins` 选项传入的插件被主动插在替身之前（testing.ts:122-123，注释明示 "ensure the action stubbing happens last"）。源码位置: packages/testing/src/testing.ts:122-157

- **spy 的双角色由"是否传原函数"决定**：stub 时 `createSpy()`（空壳、丢弃原实现），不 stub 时 `createSpy(store[action])`（包裹原实现、spy-through）。`$patch`/`$reset` 同理，但只有布尔粒度（`stubPatch`/`stubReset`）。源码位置: packages/testing/src/testing.ts:146-157

- **stubActions 三态粒度**：`shouldStubAction` 支持 `boolean`（全替/全不替）、`string[]`（按名替）、`(name, store) => boolean`（谓词）。源码位置: packages/testing/src/testing.ts:270-283

- **spy 工厂解析与误用校验**：优先用户传入的 `_createSpy`，否则自动探测 `jest.fn` / `vi.fn`；探测不到抛 `PINIA_TESTING_C0001`，若传入的是已实例化的 spy（带 `mockReturnValue`）或非函数抛 `PINIA_TESTING_C0002`。源码位置: packages/testing/src/testing.ts:128-143；诊断定义 packages/testing/src/diagnostics.ts:11-20

- **只读 getter 可覆写：响应式内部 hack**：`WritableComputed` 插件遍历 `toRaw(store)`，对每个 computed（判定 `isRef(v) && 'effect' in v`，即 `ComputedRefImpl` 特征）包一层新的可写 computed；写入非 undefined 时，改原 computed 的内部 `fn` 为"恒返回缓存值"并塞入新值，写入 undefined 时换回原 `fn` 并置脏强制重算。强耦合 `@vue/reactivity` 私有字段（`fn`/`_value`/`_dirty`）。源码位置: packages/testing/src/testing.ts:220-261

- **`_testing` 标志旁路 `useStore(pinia)`**：`createTestingPinia` 设 `pinia._testing = true` 并 `setActivePinia(pinia)`；pinia 在 store 工厂里检测到 `__TEST__ && activePinia._testing` 时，**忽略**调用方传入的 pinia 参数，改用全局活跃（即测试）pinia。注意此旁路受构建期 `__TEST__` 门控。源码位置: packages/testing/src/testing.ts:164-166；判定 packages/pinia/src/store.ts:888；`__TEST__` 定义 packages/pinia/tsdown.config.ts:13

- **`fakeApp` 的真实作用**：仅当 `fakeApp:true` 时造空 app 并 `app.use(pinia)`。它**不是**替身替换生效的前提（替身已直接在 `_p` 里），而是用来 (a) 把经 `pinia.use()` 进入"待安装队列 toBeInstalled"的插件冲入 `_p`，(b) 给 `_a` 赋值供需要 app 上下文的插件使用。源码位置: packages/testing/src/testing.ts:159-162；toBeInstalled 机制 packages/pinia/src/createPinia.ts:34,38-45

- **`app` 访问器**：在 pinia 上定义 `app` getter 返回 `this._a`，对外暴露（可能是 fake 的）应用实例。源码位置: packages/testing/src/testing.ts:168-174

- **restoreGetter 是恢复 getter 的旁路**：`restoreGetters.ts` 的 `restoreGetter` 仅 `store[getter] = undefined`，靠上一步 `WritableComputed` 的 set(undefined) 分支触发"换回原 fn、置脏重算"，从而撤销对某 getter 的覆写。文件自身标注 TODO，尚未正式定型。源码位置: packages/testing/src/restoreGetters.ts:3-16

- **初态合并是核心同名工具的精简副本**：testing.ts 的 `mergeReactiveObjects` 与 pinia 核心 `store.ts:79` 的同名函数逻辑同构，但**省去了 Map/Set 分支**；因核心版未导出、跨包不可复用而就地复制。源码位置: packages/testing/src/testing.ts:179-218；核心版 packages/pinia/src/store.ts:79-113

## 关键调用链

创建期（立即）：
createTestingPinia() → createPinia() → pinia._p.push(初态合并 / 用户插件 / WritableComputed / action替换) → [fakeApp? createApp({}).use(pinia) → install → toBeInstalled 冲入 _p] → pinia._testing=true → setActivePinia(pinia)
源码位置: packages/testing/src/testing.ts:113-166；install 冲入 packages/pinia/src/createPinia.ts:34

生效期（延迟，首次取用 store 时）：
useStore()（命中活跃 pinia）→ createSetupStore/createOptionsStore → pinia._p.forEach(extender) → …末端 action 替换插件：store[action] = shouldStubAction(...) ? createSpy() : createSpy(store[action])
源码位置: 插件应用循环 packages/pinia/src/store.ts:717-754；setup store 的 action 也被收进 optionsForPlugin.actions packages/pinia/src/store.ts:552-554

## 源码摘录（带行号，全文累计 ≤ 30 行）

替身插件按序入队 + 末端替换 + 标志位（演权衡①②，即"直接入队、末端覆盖、spy 双角色"）：
```ts
const pinia = createPinia()
pinia._p.push(({ store }) => { /* 若有 initialState[store.$id] 则合并进 $state */ })
plugins.forEach((plugin) => pinia._p.push(plugin))   // 用户插件，排在替身之前
pinia._p.push(WritableComputed)                      // getter 改写
pinia._p.push(({ store, options }) => {              // 末端：action / $patch / $reset 替换
  Object.keys(options.actions).forEach((action) => {
    if (action === '$reset') return
    store[action] = shouldStubAction(stubActions, action, store)
      ? createSpy()                  // 丢弃原实现
      : createSpy(store[action])     // 包裹原实现（spy-through）
  })
  store.$patch = stubPatch ? createSpy() : createSpy(store.$patch)
  store.$reset = stubReset ? createSpy() : createSpy(store.$reset)
})
if (fakeApp) { createApp({}).use(pinia) }
pinia._testing = true
setActivePinia(pinia)