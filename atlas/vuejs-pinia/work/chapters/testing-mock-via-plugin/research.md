# 测试替身：借插件实现 Mock · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：单测一个组件时，它依赖的 store 动作往往会真的去发请求、写状态、触发一连串副作用——于是测试又慢又脆，被测对象被淹没在整条链路里。开发者真正想要的是：动作变成"哑炮"但能断言"它被调过、参数是什么"、初始状态可预设、计算属性可钉死成定值，从而把组件或单个 store 从整棵应用里隔离出来。

- **一句话核心思想**：把 mock 实现成**一个排在插件链最末尾的普通 pinia 插件**，复用组装总线"后装者覆盖先装者"的能力，零侵入地劫持每个 store——不开任何测试后门。

- **设计动机（为什么需要它）**：之所以能用一个独立 npm 包就完成 mocking，是因为前置章已经把"统一扩展点"建好了——任何插件都能在每个 store 组装完毕时拿到 `{ store, options }` 并自由改写它。本章正是站在这个肩膀上。（已在第 9 章『插件扩展总线』讲透"插件按注册顺序执行、返回值合并进 store"，本章只看它的新侧面：**插件执行顺序被武器化成覆盖能力——最后一个插件能盖掉前面所有人装上的动作**；此外还要看两个第 9 章没涉及的新侧面：直接读写响应式系统内部缓存字段以让计算属性可被钉死、以及用一个跨包标志位让开发者工具主动让位。）

- **关键权衡（本 Atlas 的核心）**：
  1. **复用总线、零侵入核心 → 换来 mock 随 store 组装自动生效、与业务插件天然共存 → 代价是 mock 生死系于插件顺序**：mock 插件必须排在插件链最末尾，若它先于业务插件注册，业务插件会把刚装上的替身覆盖回去（源码注释直接点明这一意图）。
  2. **用一个工厂函数"参数的有无"表达两种语义 → 换来极简 API**：同一个造 spy 的工厂，不传原函数 = 替换（动作变哑炮）；传原函数 = 包裹（原逻辑照跑、只是多一层可断言）。再配一个三档粒度的开关（布尔/动作名数组/谓词），一套机制同时支持"全替死""只替死几个""原样跑只观察"三种测试策略 → 代价是工厂必须自己处理"原函数可能为空"，用户误用易踩坑（故配两条错误码兜底，并校验"误把已调用的 spy 实例当工厂传进来"的情况）。
  3. **直接读写响应式系统的内部缓存字段 → 换来计算属性可被测试钉死成定值、又能赋空还原 → 代价是强耦合底层响应式库的私有实现**（注释自承类型"藏了内部属性"），底层库版本升级有破坏风险。
  4. **设一个全局"我正在测试"标志，让开发者工具据此跳过会把动作重包一层代理的逻辑 → 换来 mock 与 devtools 可共存、替身不会被冲掉 → 代价是引入一条跨包的隐式协议**（两个系统必须互相知情，否则 devtools 的时间线分组会覆盖刚装好的替身）。

- **最小心智模型（3～7 步）**：
  1. 先造一个普通的 pinia 容器（不做任何特殊化）。
  2. 往它的插件链里**按固定顺序**依次追加四个插件：初始状态注入 → 用户的业务插件 → 计算属性可覆写 → 动作/批量改/重置的替身。
  3. 探测当前测试运行时（jest 还是 vitest）以选定造 spy 的工厂；若都没有则强制要求用户自传，并对误用做校验。
  4. 当被测代码调用 `useStore()`、触发某个 store 组装时，**核心的插件总线**按追加顺序逐个执行这些插件。
  5. 轮到最后那个替身插件时，它把每个动作（以及批量改、重置）换成（或包成）spy，盖在真动作之上。
  6. 开发者工具插件看到"我正在测试"标志，主动跳过会把动作重包代理的分组逻辑，避免覆盖替身。
  7. 把增强后的容器设为"当前活跃实例"返回，使组件外也能直接 `useStore()`。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个**小到只表达"插件总线 + 顺序覆盖"核心思想**的从零实现（几十行 TS/JS 即可）：手写一个最小容器，内部维护一个插件数组、提供注册方法；组装 store 时遍历该数组逐个调用插件、把返回值合并进 store。再造一个"测试容器"工厂：先注册一个会往 store 上挂"真动作"的业务插件，**最后**注册一个把动作换成 spy 的替身插件。然后用两个对照用例演透"权衡 1"——(a) 替身排最后：调用 store 动作命中 spy、真逻辑不跑；(b) 替身排最前、业务插件排其后：spy 被业务插件装回的真动作覆盖、调用命中真逻辑。每行都要对应"插件按序覆盖"这一条原理。
  - **应故意省略**：计算属性可覆写那段对响应式内部缓存字段的 hack（太深且版本耦合）、初始状态深合并的边界、spy 工厂的运行时探测与校验、假应用触发安装、与开发者工具的让位协议——这些都只是旁路，演示不追求工程完整。
  - **演示载体建议**：**首选 TS/JS**。本章核心机制（插件总线的顺序覆盖语义、顺序敏感性、造 spy 工厂"参数有无即双语义"）本质是数据结构与调用时序问题，TS/JS 可忠实演透；且本 Atlas 产物本身是 JS 生态站点，读者用 `bun run`/`node` 即可跑。**无需退回原仓库语言**（pinia 本身就是 TS，TS/JS 即原仓库语言）。配一个最小 `package.json` 让脚本能直接执行。

- **正文不宜展开的细节**：计算属性覆写时具体动了响应式系统的哪些私有缓存字段（`_value`/脏标记/计算函数/触发依赖）、以及为何要触发依赖刷新——这些是底层 hack，正文知道"它直接改了响应式内部缓存"足矣；初始状态深合并与"批量改"合并逻辑的同源/差异（合并管道已在第 7 章讲过，本章不重讲）；造 spy 工厂对 jest/vitest 全局变量的探测分支；把 `app` 字段映射到容器内部真实应用实例的那个访问器细节。

- **推荐的一个执行轨迹例子**：输入——一个购物车 store，动作 `addItem` 会发请求落库；测试用 `createTestingPinia({ stubActions: true })` 装配。关键中间态——被测组件里调 `useStore()` 时 store 组装，插件总线依序跑，最后那个替身插件把 `addItem` 换成不传原函数的空 spy。输出——组件里调 `cart.addItem(payload)` 不再发请求（哑炮），但断言 `cart.addItem.mock.calls` 能看到"被调一次、参数正是 payload"，组件与真实后端被干净隔离。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **整体结构**：`createTestingPinia` = 先 `createPinia()` 拿普通容器，再往插件链追加四个插件、做 spy 工厂探测/校验、设测试标志、置为活跃实例、暴露 `app` 访问器。源码位置: packages/testing/src/testing.ts:104-177
- **mock 复用插件总线，非测试后门**：核心组装引擎在 store 创建后 `pinia._p.forEach((extender) => ...)` 按注册顺序执行每个插件，并把返回的扩展合并进 store；testing 正是借这条总线进入每个 store。源码位置: packages/pinia/src/store.ts:716-725
- **插件链 `_p` 的来源与时序**：容器内部维护 `_p` 数组；`use(plugin)` 在 app 已安装时直接 push、未安装时先暂存到 `toBeInstalled`、待 `install` 时再批量入列——这决定了"等不等 app 安装"会影响插件相对顺序。源码位置: packages/pinia/src/createPinia.ts:18, 34, 38-45, 47
- **四个插件的注册顺序（顺序即生死）**：① 初始状态注入 ② 用户业务插件（注释明说"绕过等 app 安装，确保动作替身排在最后"）③ 计算属性可覆写 ④ 动作/$patch/$reset 替身。替身插件被最后 push，故在总线按序执行时最后生效、能覆盖前面所有人装上的动作。源码位置: packages/testing/src/testing.ts:116-126, 146-157
- **造 spy 工厂的"参数有无"双语义**：替身插件里，动作被判定为"替死"时调 `createSpy()`（不传原函数 → 空 spy → 原逻辑不跑），否则调 `createSpy(store[action])`（传原函数 → 包裹 → 原逻辑仍跑、外加可断言）；`$patch`/`$reset` 由各自开关控制，默认 false（包裹、保留原行为）。源码位置: packages/testing/src/testing.ts:150-156
- **三档粒度的替死判定**：`shouldStubAction` 支持 布尔 / 动作名字符串数组 / 谓词函数 `(actionName, store) => boolean` 三种形态，默认 `stubActions=true`（全部替死）。源码位置: packages/testing/src/testing.ts:270-283, 107
- **spy 工厂的运行时探测与校验**：依次尝试用户自传 → jest.fn（若 jest 全局存在）→ vi.fn（若 vitest 全局存在）；都没有则抛 C0001；若用户误传"已调用的 spy 实例"（带 `mockReturnValue`）而非工厂，抛 C0002。源码位置: packages/testing/src/testing.ts:128-143；诊断定义: packages/testing/src/diagnostics.ts:11-20
- **初始状态注入**：该插件按 `store.$id` 从 `initialState` 取该 store 的初态，用 `mergeReactiveObjects` 深合并进 `store.$state`；因在 store 创建后才跑，能覆盖 store 自身 setup 出来的初态。合并实现独立于核心 `$patch`（普通对象递归、ref/reactive 整体替换、跳过带 toJSON 的对象）。源码位置: packages/testing/src/testing.ts:116-120, 179-218
- **计算属性可覆写（动响应式内部字段）**：`WritableComputed` 插件遍历 `toRaw(store)`，用 `isRef(v) && 'effect' in v` 探测计算属性；对每个计算属性新建一个可写 computed 包一层——读时转发原值，写非空值时把原计算属性的内部缓存字段直接钉成该定值、并把其计算函数改写成"只返回该定值"，写 undefined 时则恢复原计算函数并清缓存、置脏标记强制重算，再触发依赖刷新。注：`import type { ComputedRefImpl } from '@vue/reactivity'` 注释自承"实现类型含最新内部字段，其它类型则藏起内部属性"。源码位置: packages/testing/src/testing.ts:13-15, 126, 220-261
- **跨包让位协议**：testing 设 `pinia._testing = true`；开发者工具插件在给动作做时间线分组前检查该标志，为真就跳过 `patchActionForGrouping`（该函数会把动作包成代理，会覆盖 testing 装的替身）——注释引用 issue #2298 "Do not overwrite actions mocked by @pinia/testing"。源码位置: packages/testing/src/testing.ts:164；packages/pinia/src/devtools/plugin.ts:584-602
- **假应用触发安装**：`fakeApp` 选项 `createApp({}).use(pinia)`，触发容器 install，使那些"等 pinia 安装后才执行"的业务插件得以运行（默认不开则此类插件不跑）。源码位置: packages/testing/src/testing.ts:63-68, 159-162
- **暴露 app 与置活跃实例**：用 `Object.defineProperty` 把 `pinia.app` 映射到内部的 `_a`（install 后才赋值的真实 app）；并 `setActivePinia(pinia)` 让组件外可直接 `useStore()`。源码位置: packages/testing/src/testing.ts:166-176

## 关键调用链

createTestingPinia() 
  → createPinia()                                     [拿普通容器]
  → pinia._p.push(初始状态注入)                          [testing.ts:116-121]
  → plugins.forEach(p => pinia._p.push(p))             [业务插件；注释:确保替身最后]
  → pinia._p.push(WritableComputed)                    [计算属性可覆写]
  → pinia._p.push(动作/$patch/$reset 替身)              [双语义 spy]
  → (可选) createApp({}).use(pinia)                    [fakeApp 触发安装]
  → pinia._testing = true; setActivePinia(pinia)       [设标志 + 置活跃]

—— 此后任何 useStore() 触发 store 组装时 ——>
pinia._p.forEach(extender => extender({store, options}))   [store.ts:717]
  依序: 初始状态 → 业务插件 → 计算属性覆写 → 替身(最后覆盖动作)
devtools 插件见 _testing=true → 跳过 patchActionForGrouping  [devtools/plugin.ts:585]

## 源码摘录（带行号，全文累计 ≤ 30 行）

四插件的注册顺序（顺序即生死的直接证据）：

```ts
// packages/testing/src/testing.ts
116:  // allow adding initial state
117:  pinia._p.push(({ store }) => {
118:    if (initialState[store.$id]) {
119:      mergeReactiveObjects(store.$state, initialState[store.$id])
120:    }
121:  })
122:
123:  // bypass waiting for the app to be installed to ensure the action stubbing happens last
124:  plugins.forEach((plugin) => pinia._p.push(plugin))
125:
126:  // allow computed to be manually overridden
127:  pinia._p.push(WritableComputed)
```

替身插件——造 spy 工厂"参数有无"的双语义 + $patch/$reset：

```ts
// packages/testing/src/testing.ts
146:  pinia._p.push(({ store, options }) => {
147:    Object.keys(options.actions).forEach((action) => {
148:      if (action === '$reset') return
149:
150:      store[action] = shouldStubAction(stubActions, action, store)
151:        ? createSpy()                  // 不传原函数 = 替换 = 哑炮
152:        : createSpy(store[action])     // 传原函数 = 包裹 = 原逻辑照跑
153:    })
154:
155:    store.$patch = stubPatch ? createSpy() : createSpy(store.$patch)
156:    store.$reset = stubReset ? createSpy() : createSpy(store.$reset)
```

跨包让位协议——标志位与 devtools 的避让：

```ts
// packages/testing/src/testing.ts
164:  pinia._testing = true

// packages/pinia/src/devtools/plugin.ts
584:  // Do not overwrite actions mocked by @pinia/testing (#2298)
585:  if (!store._p._testing) {
586:    patchActionForGrouping(
587:      store as StoreGeneric,
```

## 易混淆 / 边界 / 推断

- **事实**：`stubActions` 默认 `true`（动作全替死、不跑原逻辑），而 `stubPatch`/`stubReset` 默认 `false`（仍保留原行为、只加 spy 观察层）——即"动作默认哑、改状态默认真"，这是测试隔离与"断言被调"之间的默认折中。源码位置: packages/testing/src/testing.ts:107-110
- **事实**：`createSpy` 即便用全局 `vi.fn`/`jest.fn`，替死分支传入的也是 `undefined`（不传原函数），故用户自传的工厂必须自行处理"原函数为空"的情况——选项注释里反复 NOTE 强调。源码位置: packages/testing/src/testing.ts:38-40, 51-53, 75
- **推断**：替身插件对每个动作直接赋值 `store[action] = ...` 能生效，前提是 store 此刻已是可写代理且动作已由核心组装挂上——这印证了替身插件必须跑在核心组装"之后"、又最好跑在业务插件"之后"，故排在链尾。（由 `pinia._p.forEach` 在组装末尾执行 + push 顺序共同推断，标注为推断。）
- **推断**：`WritableComputed` 走 `toRaw(store)` 再遍历，是为了绕过 reactive 代理直接拿到计算属性的真实内部句柄、进而改其私有缓存字段；若不走 raw，代理会拦截写入、无法触达内部字段。源码位置: packages/testing/src/testing.ts:226-257（推断）
- **边界**：计算属性覆写强依赖底层响应式库的内部字段名（缓存值、脏标记、计算函数），这些非公开 API；底层库重构字段名时本机制会断——这是注释明示"实现类型含最新内部字段、对外类型则藏起"的根因。源码位置: packages/testing/src/testing.ts:13-15
- **未理解**：`WritableComputed` 中"setup store 下还需 `triggerRef(originalComputed)` 触发依赖"这条注释提及的精确触发路径（为何 computed 自身的 set 已写缓存仍需手动触发依赖刷新）未在源码内完全展开，留待 Writer 谨慎处理，正文可只说"手动触发依赖刷新"而不深入。源码位置: packages/testing/src/testing.ts:255-257