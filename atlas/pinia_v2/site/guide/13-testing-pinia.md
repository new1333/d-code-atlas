# 测试替身：作为插件链的 spy 注入

## 一、痛点：测组件时，store 总是"太真"

单元测试一个组件时，真实 store 的 action 会真的去发请求、读写全局状态，把测试弄脏；getter 往往依赖外部数据，断言时难以控制其返回值；而每个测试又得手动给每个 `useStore` 传一个 pinia 实例，啰嗦还容易漏。

一个朴素念头是"造一套假 store"。但这套假实现必须和真 store 在响应式结构、订阅、插件扩展上逐一对齐，否则测出来的行为根本不可信——你测的是替身，不是被测代码。于是问题变成：**能不能复用真 store 的装配管线，只在最后一刻把会引发副作用的少数几样东西换掉？**

## 二、前置：插件队列是唯一的扩展点

这一章建立在两个前置概念之上（见「createPinia」「插件系统」两章）：

- **`createPinia()` 产出一个真实 Pinia**，内部维护两个关键容器：`_p`（**已生效插件队列**，数组、按序执行）与 `state.value`（扁平状态字典）。另有 `use(plugin)`：在 app 安装前，插件先进"待安装队列"，安装后再统一冲入 `_p`。
- **插件在每个 store 装配末尾按 `_p` 顺序执行一次**。每个插件收到上下文 `{ store, options, pinia }`，其返回值会被合并进 store。这是 devtools 与 testing **共用**的唯一扩展点。

结论很直接：**想要统一地改写每个 store 的行为，插件是唯一诚实的接缝**。替身要做的事，本质上就是一个"会改写 store"的插件。

## 三、核心思想：不造假 store，造"最后入队的插件"

替身策略是：不另起一套实现，而是把测试替身**伪装成一串插件**，顺着真实 store 的装配管线一路走到末端，在最后一刻悄悄把 action / `$patch` / `$reset` / getter 换成 spy。

这恰好化解了开头的矛盾——替身只想"换掉会引发副作用的少数几样东西"，其余（响应式结构、订阅、插件扩展）必须和真实 store 完全一致。**复用真实装配管线、只在末端做替换**，得到的就是"结构与真实 store 同构，只差被替换的部分"。

## 四、最小心智模型（6 步）

1. 创建一个**真实** pinia 实例（不是 mock），拿到它内部的"已生效插件队列" `_p`。
2. 按序往 `_p` 末端塞四类插件：初态合并 → 用户自带插件 → getter 改写 → action / `$patch` / `$reset` 替换（**最后塞**）。
3. 解析 spy 工厂：优先用用户传入的，否则自动探测当前测试框架自带的；缺失或误传（把已实例化的 spy 当成工厂传）就**直接抛错**。
4. 给 pinia 打上"测试中"标记 `_testing`，并把它设为全局活跃实例。
5. （可选）若要求 `fakeApp`，造一个空应用执行一次 `app.use(pinia)`。
6. **延迟生效点**：当被测代码首次取用某 store 时，装配管线按 `_p` 顺序逐一跑插件——跑到末端时，action 已被换成 spy。

插件入队顺序（文字流程，箭头表示 `_p` 末端往后追加）：

```
createTestingPinia()
   │  直接 push 进 pinia._p（已生效队列）
   ▼
[初态合并] → [用户插件…] → [WritableComputed] → [action/$patch/$reset 替换（最末）]
                                                          │
              store 装配时 _p.forEach 逐个执行 → 跑到这里时，action 已是 spy
```

关键在于"最末"：替身替换插件刻意排在队列最后，且对用户自带插件主动"插队"到替身之前，确保替换不被任何更晚入队的插件覆盖。

## 五、最小原理演示（从零实现）

下面这段几十行的从零实现，只演透一件事：**创建真实 pinia → 往其插件队列末端推一个替身插件 → 该插件在 store 装配时把 action 换成 spy → 设为活跃 pinia**。它故意省略了 getter 改写的响应式内部 hack、spy 工厂的自动探测与校验、空应用安装、恢复 getter 等工程细节，每一行只对应"直接入队、末端覆盖、spy 双角色"这一思想。

```ts
import { createPinia, setActivePinia, defineStore } from 'pinia'

// spy 工厂：传了原函数就"包裹放行"（spy-through），不传就"丢空壳"（完全 mock）
function createSpy(fn?) {
  const calls: any[][] = []
  const spy = (...args: any[]) => {
    calls.push(args)                       // 记录调用参数
    return fn ? fn(...args) : undefined    // 有原函数就照常执行，否则吃掉副作用
  }
  ;(spy as any).mock = { calls }
  return spy
}

export function createTestingPiniaLite() {
  const pinia = createPinia()              // ① 真实 pinia，结构与生产 store 同构

  // ② 把替身插件直接 push 进已生效队列 _p 的末端（不走 use()，无需 app 安装）
  pinia._p.push(({ store, options }) => {
    Object.keys(options.actions).forEach((action) => {
      store[action] = createSpy()          // 末端替换：丢弃原实现，换成空壳 spy
    })                                     // 因排在最末，后续无插件能再覆盖它
  })

  pinia._testing = true                    // ④ 打"测试中"标记
  setActivePinia(pinia)                    // ④ 设为全局活跃，被测代码不传 pinia 也能命中
  return pinia
}
```

**执行轨迹**：配好 lite pinia 后，被测组件首次 `useStore()` 命中活跃 pinia，装配管线跑到末端替身插件，action 已被换成空壳 spy。此时调用该 action 不发任何请求、返回 `undefined`，但 `spy.mock.calls` 已记下调用参数——测试可据此断言"它被以这些参数调用过"。

`createSpy` 的两行 `return` 正是 spy 的双角色：传 `fn` 时它是"放行但记录"，不传时它是"完全 mock"。这套机制同时覆盖了"我只想知道 action 被调过"和"我要彻底掐断副作用"两种诉求。

## 六、四个关键权衡

**① 直接入队 vs 走安装流程**。替身插件直接塞进 `_p`（已生效队列），而非 `pinia.use()`（会先进待安装队列）。换来：纯单元测试里**无需真实 app / 组件挂载**就能让替换生效。代价：必须自己保证替换插件排在 `_p` 最末（否则被更晚入队的插件覆盖），所以对用户自带插件要主动插到替身之前——四个插件按序入队并保末端替换的逻辑见 `packages/testing/src/testing.ts:113-157`。

> **厘清一个常见误解**：替换生效**不依赖 `fakeApp`**。替身插件已直接在 `_p` 里，store 一装配就会跑到它。`fakeApp` 只负责把经 `pinia.use()` 进入待安装队列的"用户自带插件"冲进 `_p`、并给 `_a` 赋值供需要 app 上下文的插件使用——它从不替替身插件"激活"替换。

**② 一个 spy 工厂，两种角色**。stub 时无参 `createSpy()`（空壳、丢弃原实现），不 stub 时 `createSpy(store[action])`（包裹原实现、spy-through）；`$patch` / `$reset` 同理。换来：**一套机制既支持完全 mock、也支持 spy-through**。代价：调用契约必须能区分"要不要原函数"，传错会静默走错分支，故解析阶段额外校验、误用直接报错。

**③ 只读 getter 可覆写 = 响应式内部 hack**。`WritableComputed` 插件遍历 `toRaw(store)`，识别 computed（判定 `isRef(v) && 'effect' in v`，即 `ComputedRefImpl` 特征），包一层新的可写 computed；`set` 非 undefined 时改原 computed 的内部 `fn` 为"恒返回缓存值"并塞入新值，`set` undefined 时换回原 `fn` 并置脏强制重算（`packages/testing/src/testing.ts:226-261`）。换来：测试里能**直接给一个只读计算属性赋任意值**。代价：强耦合 `@vue/reactivity` 私有字段（`fn`/`_value`/`_dirty`），上游升级有破坏风险，故必须配一个"恢复原值"的旁路——`restoreGetter` 仅 `store[getter] = undefined`，靠上一步 `set(undefined)` 分支触发"换回原 fn、置脏重算"来撤销覆写（该文件自带 TODO，尚未正式定型）。

**④ stubActions 三态粒度**。`shouldStubAction` 的三分支判定支持 `boolean`（全替 / 全不替）、`string[]`（按名替）、`(name, store) => boolean`（谓词）。换来："全 mock / 指名 mock / 按规则 mock"覆盖不同测试策略。代价：选项类型变成联合体、心智与文档成本上升；而 `$patch` / `$reset` 只有布尔两态（`stubPatch` / `stubReset`），粒度不对等。

## 七、延迟生效与 `_testing` 旁路

前面反复说"延迟生效"，到底何时替换真正发生？**不是** `createTestingPinia` 执行的那一刻——那一步只是把四个插件入队。它们真正执行，是在被测代码首次 `useStore()` 触发 store 装配时：装配管线遍历 `_p` 逐一运行插件（应用循环见 `packages/pinia/src/store.ts:717-754`），循环跑到末端那一个，action 此刻才被换成 spy。这解释了为什么"排最末"如此关键：顺序就是替换的优先级。

而被测代码又如何**不传 pinia** 就能命中这个测试 pinia？靠 `_testing` 旁路：`createTestingPinia` 设 `_testing = true` 并 `setActivePinia(pinia)`；在 store 工厂里，构建期 `__TEST__` 门控下、当 `activePinia._testing` 为真时，**忽略**调用方传入的 pinia 参数，改用全局活跃（即测试）pinia（旁路判定见 `packages/pinia/src/store.ts:888`）。于是测试里 `useStore()` 即便带了别的 pinia 参数也会被无视，统一命中那个"末端已埋好 spy"的测试实例。

至此整条链路闭合：替身以插件形态直接入队并排到最末 → `_testing` 让被测代码无视传入参数命中它 → store 装配时延迟跑到末端完成替换。没有造假 store，只有一串"排在最后"的真插件。