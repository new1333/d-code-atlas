# 测试：以插件重塑 store 行为 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：单测 store 时你几乎总要改写它的行为——不想真跑某个 action 的网络/副作用、想给状态塞一份初始值、想临时把某个只读派生值（getter）冻结成固定值来测某个分支。但这些「测试期」能力 store 本身一个都没有，它没有「测试模式」开关。使用者最朴素的冲动是去 fork 一套测试专用 store，或往核心里塞 `if (测试)` 分支——两条路都会污染生产代码。

- **一句话核心思想**：**把测试需要的所有行为改写，全部表达成「在 store 装配完成的那一刻插入一段重塑逻辑」**——即把插件当成装配期回调来用，而不是新写一套测试专用 store。

- **设计动机（为什么需要它；含承前去重）**：
  - 承前：第 9 章「插件系统」已讲透插件「收上下文、返回扩展、合并进 store」的注册/合并机制；第 4 章「Store 装配」已讲透装配时在自身作用域内逐个跑插件队列。**这两套机制本章不重演。** 本章只看它们被测试库逼出来的一个新侧面：**插件完全可以不返回任何扩展，只拿到刚装配好的 store 引用、就地变异它**——把插件当成「装配完成回调」。本章的全部新意都建立在这个侧面上。
  - 动机：让测试人体工学零成本搭在已有装配机制上，从而核心生产路径不出现任何测试分支。唯一的例外是一个极小的「测试标志」——而且它本身就是在装配期设上的，核心只在两处读它（绕过实例解析参数、跳过会破坏测试桩的可观测层重包），并非一条独立的测试代码路径。

- **关键权衡（核心原料，4 条）**：
  1. **选择「预装一组插件在装配期重塑 store」而非「写测试专用 store 或核心测试分支」** → 换来核心零污染、测试与生产走完全相同的装配路径（测到的就是生产行为）→ 代价是重塑只能发生在「装配完成那一刻」这个固定时机，所以所有改写都得想办法塞进这个窗口：初始态靠此刻合并进状态对象、action 桩化靠此刻直接覆盖 store 上的方法。
  2. **选择「把桩化与监视统一表达成 spy 包裹」** → 换来一套配置（全桩 / 指定名字桩 / 仅监视不桩）同时覆盖 action、状态补丁方法、重置方法三类可调用对象 → 代价是强制使用者必须提供一个 spy 工厂，缺了或传错（传了已调用的实例而非工厂）就直接抛错，不给静默降级。
  3. **选择「让 action 桩化插件刻意排在插件队列最末」** → 换来它能覆盖更早插件（如可观测层对 action 的代理包裹）对 action 的改写，保证「测试桩说了算」→ 代价是插件入队顺序成为一个隐式契约：用户自传的插件一律插在测试重塑插件之前，不能后置覆盖测试行为。
  4. **选择「为『覆盖只读 getter』这个本不该可能的能力，直捣响应式计算属性的内部实现」** → 换来测试里能临时把一个只读派生值冻结成任意值、且事后能恢复成真计算 → 代价是依赖 Vue 计算属性**非公开**的三个内部字段（缓存值、脏标记、getter 函数句柄），是整个测试库唯一的逃生口，一旦 Vue 改动这些内部实现就会失效。

- **最小心智模型（7 步）**：
  1. 建一个普通 pinia 实例。
  2. 往它的插件队列里按固定顺序塞四段重塑逻辑：灌初始态 → 用户的插件 → 可写 getter 包装 → action/补丁/重置桩化。
  3. 给实例打上测试标志，并把它设为当前活跃实例。
  4. 测试里调用某个 useStore 时，装配照常进行，四段插件在「装配完成」那一刻依次拿到刚建好的 store。
  5. 初始态插件把预设状态深合并进该 store 的状态对象；action 插件按配置把每个 action 换成「空 spy」（不跑原逻辑）或「包住原函数的 spy」（照跑但记录调用）。
  6. getter 包装插件把每个只读计算属性换成一个新的**可写**计算属性：读时透传原值（默认完全透明）；写一个非空值则把底层原计算属性切到「冻结成该值」态、写空值（undefined）则切回「恢复真计算」态。
  7. 测试代码读到的就是已被重塑的 store；想改写某 getter 直接给它赋值即可，想恢复就把该属性置回 undefined。

- **最小原理演示（替代旧「复刻范围」）**：
  - 应演示：一个从零写的「微型测试 pinia」，只演两条原理——(i) **插件 = 装配完成回调，就地变异 store**（演权衡 1）；(ii) **可写包装器劫持只读计算属性的两个内部模式：冻结成指定值 / 恢复真计算**（演权衡 4，逃生口）。建议几十行、造一个极简「计算属性实现」（自带缓存值/脏标记/getter 句柄三字段）来演逃生口，**不必引真 Vue**。
  - 应故意省略：多框架 spy 工厂探测（jest/vitest 全局判断）、空 app 触发安装、深合并对 Map/Set/ref/reactive 的处理、状态补丁/重置方法的桩化、类型体操、诊断错误码、生产构建标志。
  - 演示载体建议：**一段可 `node`/`bun` 直接跑的 TS/JS 脚本（能跑最好，非硬要求）**。理由：本仓库主语言是 TS，且本章机制是纯运行时对象操作、不依赖 Vue SFC 或编译期变换；一段裸脚本就能演透「插件变异 store」和「劫持计算属性缓存」两个核心动作，不需要启动 Vue 应用或测试框架。给脚本配一个手写的迷你 computed（三字段内部状态）即可演逃生口，比引真 Vue 更能看清原理。

- **正文不宜展开的细节**：spy 工厂的多框架探测与「工厂本身 vs 工厂调用结果」的校验（对应一个已知 issue）；深合并里判定纯对象的细节（与状态变更模型章同源，不重复）；空 app 选项触发的安装副作用；测试实例上 app 取值透传底层应用实例的细节；桩化判定函数的「布尔 / 名字数组 / 谓词」三分支。

- **推荐的一个执行轨迹例子**：输入 `createTestingPinia({ initialState: { cart: { items: 2 } }, stubActions: ['checkout'] })`，测试里 `useCartStore()`；中间态——装配 cart store 时，初始态插件把 items 合并为 2，action 插件把 checkout 换成空 spy、其余 action 包成会真跑的 spy，getter 插件把每个 getter 换成透明可写包装；输出——调 checkout 不执行原逻辑且调用可断言，某 getter 可被直接赋值临时改写、用专门的恢复函数置回 undefined 后又变回真计算。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 测试库的核心 API 是一个工厂：建一个普通 pinia 实例后，往其插件队列里顺序塞四段「重塑插件」，再打上测试标志、设为活跃实例。全程不写任何测试专用 store。源码位置: packages/testing/src/testing.ts:104-177
- **关键观察：四段插件都不返回扩展对象，只就地变异 store**——初始态插件合并状态、action 插件覆盖方法、getter 插件替换计算属性。它们把插件机制当成「装配完成回调」用（与「插件返回扩展、由装配器合并」的典型用法不同）。源码位置: packages/testing/src/testing.ts:116-157, 226-261
- 插件队列顺序是硬契约：初始态 → 用户自传插件 → 可写 getter 包装 → action/补丁/重置桩化。注释明言「绕过等待 app 安装，以确保 action 桩化最后发生」。源码位置: packages/testing/src/testing.ts:116-126
- 用户自传的插件被直接推进队列（不经 app 安装延迟队列），故测试自身插件的执行不依赖 app 安装；空 app 选项只在用户插件需要真实应用上下文时才有意义。源码位置: packages/testing/src/testing.ts:123, 159-162（对比核心延迟队列 packages/pinia/src/createPinia.ts:20, 34, 38-45）
- action 桩化的核心三目：桩化时换成空 spy（原逻辑不跑）、否则换成包住原函数的 spy（照跑但记录）。补丁方法与重置方法同理，分别由两个独立开关控制（默认补丁/重置不桩、仅被监视）。源码位置: packages/testing/src/testing.ts:146-157
- 桩化判定支持三种形态：布尔（全桩/全不桩）、名字数组、谓词函数；默认全桩。源码位置: packages/testing/src/testing.ts:270-283
- spy 工厂是强制项：探测两个测试框架全局，取不到则抛错；还校验「传入的是工厂本身而非已调用结果」（已知 issue）。源码位置: packages/testing/src/testing.ts:128-143（错误码定义 packages/testing/src/diagnostics.ts:11-20）
- **逃生口（核心原理）**：可写 getter 包装插件遍历 store 的原始对象，用「是否为带 effect 的 ref」识别出计算属性 getter，把每个替换成一个新的可写计算属性——读透传原值（默认透明、不改行为）；写则直捣原计算属性内部字段在「冻结」与「恢复」两态间切换。源码位置: packages/testing/src/testing.ts:220-261
- 识别计算属性的手法是「`isRef(v) && 'effect' in v`」——与 storeToRefs 章识别 getter 的判定同源（跨章复用，本章不重复讲透）。源码位置: packages/testing/src/testing.ts:220-224
- 恢复 getter 的辅助函数极简：把指定属性置回 undefined。它依赖两件事才成立——(a) 可写 getter 包装插件已把该 getter 换成可写计算属性；(b) Vue 对 reactive 对象上「已是 ref 的属性」赋非 ref 值时，会自动写入该 ref 的值（自动解包），从而把赋值路由进包装计算属性的 setter、触发其「恢复」分支。源码位置: packages/testing/src/restoreGetters.ts:13-16
- 测试标志在核心被消费于两处：(1) useStore 解析 pinia 时，若处于测试模式则**忽略传入的 pinia 参数**、恒走活跃实例；(2) 可观测层在装配时若发现测试模式，则**不重包 action**，以免覆盖测试桩。源码位置: packages/pinia/src/store.ts:888；packages/pinia/src/devtools/plugin.ts:585（字段声明 packages/pinia/src/rootStore.ts:107-111）
- 入口文件仅做三个具名导出，无逻辑。源码位置: packages/testing/src/index.ts:4-5

## 关键调用链

工厂主体：
```
createTestingPinia(options)
  → createPinia()
  → pinia._p.push(初始态插件)
  → 用户 plugins 逐个 pinia._p.push(...)
  → pinia._p.push(可写 getter 包装插件)
  → pinia._p.push(action/补丁/重置 桩化插件)
  → pinia._testing = true; setActivePinia(pinia)
```
（测试里）useStore() → 装配（createSetupStore）→ `pinia._p.forEach(extender => extender({ store, app, pinia, options }))` → 四段插件依次就地变异刚建好的 store → 返回重塑后的 store。
插件被装配器调用的位置：源码位置: packages/pinia/src/store.ts:717-725

逃生口（getter 覆盖/恢复）：
```
测试代码: store.myGetter = 99
  → Vue reactive set-trap（目标属性已是 ref，新值非 ref）
  → 包装计算属性的 set(99)
  → 切原计算属性到「冻结」态（getter 句柄改为返回缓存值，缓存值置为 99）
  → triggerRef 通知依赖

恢复: restoreGetter(store, 'myGetter')  // 即 store.myGetter = undefined
  → 包装计算属性的 set(undefined)
  → 还原原计算属性（getter 句柄改回原函数、清缓存值、置脏标记强制重算）
```
源码位置: packages/testing/src/testing.ts:238-257；packages/testing/src/restoreGetters.ts:13-16

## 源码摘录（带行号，全文累计 ≤ 30 行）

插件入队顺序（核心契约——四段重塑、action 桩化刻意最后）：
```ts
  pinia._p.push(({ store }) => {
    if (initialState[store.$id]) {
      mergeReactiveObjects(store.$state, initialState[store.$id])
    }
  })
  // bypass waiting for the app to be installed to ensure the action stubbing happens last
  plugins.forEach((plugin) => pinia._p.push(plugin))
  // allow computed to be manually overridden
  pinia._p.push(WritableComputed)
```
源码位置: packages/testing/src/testing.ts:116-126

action 桩化的三目（空 spy = 不跑原逻辑；包原函数的 spy = 照跑但记录）：
```ts
      store[action] = shouldStubAction(stubActions, action, store)
        ? createSpy()
        : createSpy(store[action])
```
源码位置: packages/testing/src/testing.ts:150-152

逃生口——可写包装计算属性的 setter（冻结/恢复两态，直捣内部字段）：
```ts
        set(newValue) {
          // reset the computed to its original value by setting it to its initial state
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
        },
```
源码位置: packages/testing/src/testing.ts:242-257

## 易混淆 / 边界 / 推断

- 事实：四段重塑插件均**不返回扩展对象**，只就地变异 store（初始态合并 `$state`、action 覆盖方法、getter 替换计算属性）。它们实质把插件当「装配完成回调」用，是对插件机制的略带 off-label 用法。
- 事实：测试插件直推插件队列，不经核心的「安装前延迟队列」；故其执行不依赖 `app.use`。
- 推断（有注释支撑）：`fakeApp` 选项**不是**为了让测试自身插件跑起来（它们已直推队列），而是为用户自传插件提供真实应用上下文（应用实例/provide/全局属性）。工厂文件注释「plugins will wait for pinia to be installed」指的正是核心延迟队列的行为，测试库靠直推绕开了它。源码位置: packages/testing/src/testing.ts:159-162；packages/pinia/src/createPinia.ts:34-45
- 事实：逃生口依赖 Vue `ComputedRefImpl` 的**非公开**内部字段（缓存值 `_value`、脏标记 `_dirty`、getter 句柄 `fn`）——这些无公开 API，是整个测试库唯一触碰 Vue 内部实现之处。源码位置: packages/testing/src/testing.ts:15, 231-257（类型来源 `@vue/reactivity` 的 `ComputedRefImpl`）
- 事实：恢复 getter 的辅助函数仅在已装「可写 getter 包装插件」时有效；它靠 Vue「对 reactive 对象上已有 ref 的属性赋非 ref 值时写入该 ref.value」的自动解包，把 `store[getter] = undefined` 路由进包装计算属性的 setter。源码位置: packages/testing/src/restoreGetters.ts:13-16
- 事实：可观测层装配时会检查测试标志，若处于测试模式则跳过对 action 的重包，避免覆盖测试桩（对应核心仓库 issue #2298）。`store._p` 即 pinia 实例。源码位置: packages/pinia/src/devtools/plugin.ts:585；`store._p = pinia` 见 packages/pinia/src/store.ts:432
- 事实：识别计算属性用 `'effect' in v`，与 storeToRefs 章同源；深合并函数与状态变更模型章同源（本章均不重复讲透）。
- 边界：遍历 `options.actions` 时 `if (action === '$reset') return` 是防御性跳过——重置方法紧接其后被单独桩化/监视，不在此处理。源码位置: packages/testing/src/testing.ts:147-148, 156
- 未理解：无。三个指定文件（含被主文件引用的诊断文件）均已读懂；核心侧消费测试标志的两处亦已核对。