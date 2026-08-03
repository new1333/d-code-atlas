# SSR 与状态水合：单一根状态的序列化契约 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：服务端把带状态的页面渲染成 HTML 发给浏览器，浏览器激活页面时，如果客户端重新算出来的状态和服务端不一致，就会出现「水合不匹配」——界面闪烁、事件错位、甚至报错。用户真正撞上的问题是：服务端那份状态怎么原样、完整地搬到客户端，让两边每个 store 都一模一样。

- **一句话核心思想**：所有 store 的状态都汇聚进**同一个根状态对象**——序列化它、回填它，就是跨网络搬移状态的**全部契约**，不需要任何额外的序列化协议。

- **设计动机（为什么需要它）**：这个机制是为了解决「状态跨网络精确还原」这个矛盾而生的，换来的是「框架无关、零额外序列化代码」——任何能做 JSON 的运行时都能搬这套状态。
  - **承前关系（供 Writer 跨章去重）**：前置章「Store 装配」在装配时已把每个 store 的 state **镜像进那一个根状态对象**（那是为了换来『单一可序列化状态树』）——本章正是**兑现**那个权衡：正因为状态汇聚在一处，SSR 序列化只需要那一个对象。本章只看它的新侧面：**客户端怎么把这一个对象按 key 拆还给各 store**（已在第 4 章『Store 装配』讲透镜像那一步，本章不重讲镜像，只讲回填）。同时前置章「状态变更模型」建立的**深合并工具**，本章在水合 Set/Map 时直接复用（已在第 5 章讲透，本章只引用它处理集合）。

- **关键权衡（本 Atlas 的核心，4 条）**：
  1. **「用单一根状态对象当序列化契约，而非给每个 store 单独的序列化协议」** → 换来框架无关、零额外序列化代码（服务端序列化那一个对象、客户端回填那一个对象即可）→ 代价是 setup 语法 store 因为 state 是命令式逐个创建的，必须**逐 key** 把入站值灌回各个 state 容器，多了一段「按 key 水合」的胶水代码。
  2. **「水合集合时先清空默认值再灌入站值，而非把默认值和入站值深度合并」** → 换来与 `$patch` 完全一致的合并语义、避免把 store 里声明的默认集合内容错误地和服务端值混在一起 → 代价是 setup 里给集合设的默认值在客户端水合时会被直接丢弃。
  3. **「提供一对『应否水合』的标记 API，让 setup store 能声明『这个有状态对象不是真状态』」** → 换来可以把路由实例、第三方有状态对象安全放进 setup store 而不被序列化发往客户端（否则会把不该序列化的东西发给浏览器）→ 代价是使用者得**主动**给这类非状态对象打标记，漏打就会触发序列化。
  4. **「option 语法 store 给一个可选的自定义水合钩子当逃生口」** → 换来 customRef、本地存储这类「服务端值 ≠ 客户端值」的特殊响应式能被手动对齐 → 代价是这个钩子仅 option store 可用，setup store 因默认逐 key 灌值机制已覆盖大部分情况，特殊响应式需自行处理。

- **最小心智模型（6 步）**：
  1. 服务端跑完所有 store 后，状态根对象里躺着 `{ 每个store的id: 该store的state }` 这样一张扁平映射表。
  2. 序列化阶段：把这一整个根对象转成 JSON，作为 HTML 的载荷发往客户端。
  3. 客户端反序列化：把载荷整个回填进**同一个根对象**。
  4. 客户端首次用到某个 store 时触发装配，装配过程读出「这个 store 在根里已有的入站状态」。
  5a. **option 语法 store**：它的 state 直接从根对象里取（天然就是入站值），默认已水合；可选的自定义钩子处理特殊响应式。
  5b. **setup 语法 store**：遍历 setup 返回的每个 state 容器，逐 key 把入站值灌进去（简单值直接赋、集合先清空再灌、对象递归赋），再反向把容器注册回根对象保持双向同步。
  6. **跳过**：被「不应水合」标记的对象（如路由实例）不灌值，避免被序列化。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一段几十行的从零实现，演透三件事——(a) 一个根对象 `{ id: state }` 就是全部契约；(b) 给定入站状态和一个「命令式创建若干 state 容器」的 setup 函数，装配时**按 key** 把入站值灌进每个容器；(c) 被标记为「跳过水合」的对象不参与灌值。每一行对应上面的某条原理：根对象 ↔ 权衡 1；按 key 灌值 ↔ setup store 水合；集合先清后灌 ↔ 权衡 2；跳过标记 ↔ 权衡 3。
  - **应故意省略**：真正的 ref/reactive 响应式实现（可用 `{ value }` 简化）、effectScope 托管、整个 reactive 包装、option store 的自定义水合钩子分支、`$patch` 暂停监听、devtools、真正的网络/HTML 载荷传输。**不追求工程完整**，只演透「一个根即契约 + 按 key 拆还」。
  - **演示载体建议**：本仓库主语言是 TS/JS，建议写成一个能 `node`/`bun` 直接跑的独立脚本（用极简的 `{ value }` 模拟响应式容器即可，能跑最好但非硬要求）。原则：**载体服务于『演透原理』**，不必真的接 vue、不必真起 SSR 服务器——用「服务端打印 JSON → 客户端读 JSON 再灌值」两段函数对照就能演透。

- **正文不宜展开的细节**（供 Writer 裁剪）：根状态对象本身是用一个被显式作用域托管的 ref 创建的（便于一次性销毁，已在第 1/4 章讲过）；option store 的 state 直接来自根对象（已在第 4 章装配讲过）；深合并工具的完整语义（Map/Set 处理，已在第 5 章讲透，本章只引用）；`$patch` 暂停监听批处理（已在第 5 章讲透）；真正把 JSON 载荷塞进 HTML/从 payload 回填的动作由框架（Nuxt/Vue SSR）完成，pinia 本身只暴露那一个根对象。

- **推荐的一个执行轨迹例子**：输入——服务端用 setup 语法定义购物车 store（`count` 默认 0、`items` 默认空数组），某请求中 `count` 被改成 3；中间态——状态根对象变成 `{ cart: { count: 3, items: [] } }` → 序列化为 JSON 载荷；客户端——回填根对象 → 首次用购物车 store 触发装配 → 读出入站状态 → 逐 key 灌值（`count` 置 3、`items` 置空）→ 注册回根对象 → store 读出来与服务端 HTML 完全一致，无水合不匹配。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **SSR 契约的根**：整个 SSR 的状态契约就是 `pinia.state.value`——一个 `ref<Record<string, StateTree>>`，其 value 是 `{ [storeId]: stateObject }` 的扁平映射。服务端 `JSON.stringify` 它、客户端回填它，即完成跨网络搬移。源码位置: packages/pinia/src/createPinia.ts:14-16, 53
- 源码注释明确暗示：客户端可「检查 window 对象上的状态并直接回填」（这一步由 Vue SSR / Nuxt 等框架完成，pinia 自身不在此处做）。源码位置: packages/pinia/src/createPinia.ts:12-13
- **装配时读入站状态**：`createSetupStore` 一开始就 `const initialState = pinia.state.value[$id]`，这就是判断「是否处于水合场景」的依据——非空即有入站状态需要水合。源码位置: packages/pinia/src/store.ts:271
- **setup store 无入站时初始化占位**：若非 option store 且根状态里没有本 id 的占位，先 `pinia.state.value[$id] = {}`，为后续「逐 key 注册回根」准备容器。源码位置: packages/pinia/src/store.ts:275-278
- **setup store 逐 key 水合（本章核心）**：装配遍历 setup 返回值时，对每个「是 state 的 ref/reactive（非 computed）」属性：先 `shouldHydrate(prop)` 判断该属性是否应水合；应水合时——ref 直接 `prop.value = initialState[key]`；Set/Map 先 `prop.clear()` 再深合并；其它 reactive 对象递归赋值；最后 `pinia.state.value[$id][key] = prop` 把容器注册回根状态，保持根与 store 双向同步。源码位置: packages/pinia/src/store.ts:514-533
- **跳过水合的标记 API**：`skipHydrate(obj)` 用 `Object.defineProperty` 给对象打上一个不可枚举的 symbol 标记；`shouldHydrate(obj)` 反向判断（null/非对象一律视为应水合，对象则检查是否被打过标记）。源码位置: packages/pinia/src/store.ts:115-140
- **该 API 的设计意图（注释明示）**：setup store 里返回的「有状态但不是真状态」的对象（如路由实例），用它标记后可跳过水合，避免被序列化发给客户端。源码位置: packages/pinia/src/store.ts:119-122
- **option store 默认天然水合**：option store 的 setup 直接 `toRefs(pinia.state.value[id])` 取根状态，根状态里是什么 state 就是什么，无需逐 key 灌值。源码位置: packages/pinia/src/store.ts:177
- **option store 的可选水合钩子（逃生口）**：当有入站状态、是 option store、且定义了 `options.hydrate` 时，装配末尾调用 `options.hydrate(store.$state, initialState)`。源码位置: packages/pinia/src/store.ts:766-776
- **水合钩子的用途（类型注释）**：当 state 里用了 customRef/computed，或用了「服务端与客户端值不同」的 ref（如 `useLocalStorage`）时，需要手动对齐。源码位置: packages/pinia/src/types.ts:652-673
- **集合先 clear 再合并的原因（注释）**：避免把 setup 里声明的默认集合值与服务端值合并，且刻意不直接用深合并工具来做，以保持与 `$patch` 一致的合并语义。源码位置: packages/pinia/src/store.ts:520-525
- **推断**：深合并工具的注释提到 setup store 里某属性类型可能在 SSR 期间变化（如 Map → undefined），水合要能覆盖默认值——说明按 key 灌值是「整体覆盖」而非「增量合并」语义。源码位置: packages/pinia/src/store.ts:102-104（标注为推断）

## 关键调用链

SSR 序列化链（服务端）：
各 store 装配 → state 经「逐 key 注册」镜像进 `pinia.state.value[$id]`（store.ts:532）→ 框架 `JSON.stringify(pinia.state.value)` 发往客户端
源码位置: packages/pinia/src/store.ts:532；契约根 packages/pinia/src/createPinia.ts:14-16

SSR 水合链（客户端）：
框架回填 `pinia.state.value`（由 Vue SSR/Nuxt 完成）→ 首次 `useStore(id)` 触发 `createSetupStore`/`createOptionsStore`（store.ts:904-907）→ 读 `initialState = pinia.state.value[$id]`（store.ts:271）→【setup store】遍历返回值逐 key 灌值（store.ts:514-533）／【option store】state 直接取自根（store.ts:177）+ 末尾可选 `hydrate` 钩子（store.ts:766-776）
源码位置: packages/pinia/src/store.ts

## 源码摘录（带行号，全文累计 ≤ 30 行）

根状态对象的创建（SSR 契约的「根」）：
```ts
  // NOTE: here we could check the window object for a state and directly set it
  // if there is anything like it with Vue 3 SSR
  const state = scope.run<Ref<Record<string, StateTree>>>(() =>
    ref<Record<string, StateTree>>({})
  )!
```
源码位置: packages/pinia/src/createPinia.ts:12-16

setup store 逐 key 水合（本章核心机制）：
```ts
        // in setup stores we must hydrate the state and sync pinia state tree with the refs the user just created
        if (initialState && shouldHydrate(prop)) {
          if (isRef(prop)) {
            prop.value = initialState[key as keyof UnwrapRef<S>]
          } else {
            // clear keyed collections to avoid merging during hydration any
            // default values done here rather than mergeReactiveObjects to
            // keep `$patch` merging behavior
            if (prop instanceof Set || prop instanceof Map) {
              prop.clear()
            }
            mergeReactiveObjects(prop, initialState[key])
          }
        }
        // transfer the ref to the pinia state to keep everything in sync
        pinia.state.value[$id][key] = prop
```
源码位置: packages/pinia/src/store.ts:515-533

「应否水合」的判断（支撑跳过非状态对象）：
```ts
export function shouldHydrate(obj: any) {
  return (
    !obj || typeof obj !== 'object' || !Object.hasOwn(obj, skipHydrateSymbol)
  )
}
```
源码位置: packages/pinia/src/store.ts:136-140（`skipHydrate` 对应在 126-128，用 `Object.defineProperty(obj, skipHydrateSymbol, {})` 打标记）

## 易混淆 / 边界 / 推断

- **事实**：option store 与 setup store 的水合路径不同——option store 因 state 形状已知（来自 `state()` 声明），state 直接取自根对象，天然水合，仅有可选自定义钩子；setup store 因 state 命令式创建，必须逐 key 灌值并反向注册回根。这与第 4 章「装配」里「option/setup 两种语法统一于一条装配路径」并不矛盾——装配路径统一，但**state 来源不同导致水合细节分叉**。源码位置: packages/pinia/src/store.ts:177 vs 514-533
- **事实**：`shouldHydrate` 对 `null` 和非对象一律返回 true（视为应水合），只有「被打过 skipHydrate symbol 标记的对象」才返回 false。因此 skipHydrate 仅对「对象」生效。源码位置: packages/pinia/src/store.ts:136-140
- **推断**：pinia 本身不提供「序列化进 HTML / 从 payload 回填」的代码，只暴露 `pinia.state.value` 这一个可序列化根；真正搬移 JSON 的动作由框架（Nuxt payload、Vue SSR）完成。这一推断来自 createPinia 注释（「could check the window」）与本文件无任何 stringify/parse 代码。源码位置: packages/pinia/src/createPinia.ts:12-13
- **未理解**：`createOptionsStore` 的 setup 中，热更新分支（`__DEV__ && hot`）用 `toRefs(ref(state ? state() : {}).value)` 而非取根状态，其与水合的交互关系属 HMR 机制（第 11 章），本章不展开。源码位置: packages/pinia/src/store.ts:173-177