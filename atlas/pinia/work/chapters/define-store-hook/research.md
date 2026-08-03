# defineStore：惰性 useStore 闭包与注册表缓存 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：如果「定义一个 store」就直接得到一个实例，那么三件糟心事会立刻发生——① 只要 import 了某个 store 模块，它就被创建（哪怕你这次根本没用到它），既无法被打包器剔除，也在 SSR 下白白跑一遍 setup；② 同一份 store 代码无法在多个 app / 多个 Pinia 容器下各取各的实例；③ store 之间互相引用时，模块加载即实例化会撞上初始化顺序问题。Pinia 用一个反直觉的 API 形状同时治这三件事：**定义不返回实例，而返回一个「调用入口函数」**。

- **一句话核心思想**：定义时只把 id 与选项「闭包」进一个调用入口函数、绝不创建实例；真正的实例化推迟到首次调用这个入口——按调用解析出当前要用的 Pinia 容器、按需创建并把实例缓存进注册表，此后每次调用命中缓存即复用同一实例。这就是「**store 即可组合 hook**」。

- **设计动机（为什么需要它）**：这个机制是为了化解「**定义阶段能不能有副作用**」这个矛盾——把定义做成零副作用的纯声明，换来了 tree-shake 能力、按需实例化、多容器隔离与解耦的初始化顺序。其中「承前」部分必须点明：本章依赖的**注册表、全局活跃实例、注入键**这三件基础设施已在第 1 章『Pinia 实例：根状态、注册表与全局活跃上下文』讲透（含「注入优先、全局只作兜底」那条核心权衡），**本章不重讲它们**，只看「把它们组织成一个『返回函数而非实例』的定义 API」这个新侧面——以及调用入口在此基础上**多出的一条『显式传参优先』**和「解析后把该容器推为活跃」这个动作。

- **关键权衡（本 Atlas 的核心，共 3 条）**：
  1. **用『返回调用入口函数而非实例』换取惰性创建 + 定义零副作用（可 tree-shake、可剔除未用 store）+ 解耦的初始化顺序 → 代价是每次调用都要做一次「解析容器 + 查注册表」**。这是全章灵魂权衡。
  2. **在调用入口里按优先级解析容器（显式传参 > 注入 > 全局活跃兜底），并把解析到的容器推为全局活跃 → 换来『同一个入口在不同 app / 不同容器下能取到不同实例』的多容器能力，也让 SSR / 测试可控 → 代价是入口必须在『有活跃上下文』时调用，否则在 dev 下直接报错、prod 下会拿到错误实例**。（相对第 1 章的新侧面正是这条：第 1 章的取活跃实例原语是「注入优先、全局兜底」且不接受参数；本章入口在此之上多了「显式传参优先」与「解析后推为活跃」。）
  3. **在定义阶段就凭『setup 参数是不是函数』一次性分流两种作者语法、并把选项归一为单一形状 → 换来一个调用入口同时服务 option 与 setup 两种写法 → 代价是实例化时要分派到两条装配路径（这是下一章的主题，本章只点到为止）**。

- **最小心智模型（7 步）**：
  1. **定义**：调用定义函数时，只把 id、归一化后的选项、以及「是不是 setup 语法」这个标记闭包进一个入口函数，立即返回它；不创建任何实例、不产生副作用。
  2. **首次调用入口**：拿到一个可选的「显式容器」参数，开始按优先级解析：测试旁路 → 显式传参 → 注入 → 全局活跃兜底。
  3. **推为活跃**：把解析到的容器设为「全局活跃容器」，让随后装配链路里的 getter / action 都能取到正确的它。
  4. **查注册表**：看该容器的注册表里有没有这个 id——有，直接跳到第 6 步。
  5. **创建并占位注册**：没有就调对应的装配函数；装配函数会先把半成品实例塞进注册表（这一步的深意留给下一章）。
  6. **取出返回**：从注册表取出该 id 对应的实例返回。
  7. **再次调用**：从第 2 步起重复，但第 4 步命中缓存，于是同一入口反复调用拿到的是**同一个实例**。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个从零写的、只表达核心思想的入口函数（约 20 行）。它要同时演透三条权衡——「返回函数而非实例」「按调用解析容器并推为活跃」「注册表缓存」。每一行都对应上面某个原理点。
  - **应故意省略**：装配函数的内部（那是下一章）、effect scope、响应式包装、option/setup 两种语法的差异化处理、HMR、devtools 缓存、类型泛型。
  - **演示载体建议**：本仓库主语言是 TS/JS，建议写成一段能被 `node`/`bun` 直接跑的脚本——用一个模块级变量模拟「全局活跃容器」、用一个普通对象/Map 模拟「注入」（全局变量即可，不必真接 Vue 的注入系统）、用一个 Map 当注册表。用一组断言演：定义后注册表仍空（惰性）；首次调用后注册表写入且返回实例；再次调用拿到同一实例（缓存）；传不同「容器」能取到不同实例（按调用选容器）。一句话原则：**载体服务于"演透原理"，不必接入真实 Vue**。
  - **演示演的是**：权衡 1（返回函数 + 惰性 + 缓存）与权衡 2（按调用解析容器）。

- **正文不宜展开的细节**：测试模式的旁路（测试时强制忽略显式传入的容器参数、改走全局活跃，服务于测试库、属测试章）；HMR 临时实例分支（属 HMR 章）；dev 下把实例缓存到组件实例供 devtools（属 DevTools 章）；dev 下在入口函数上记录「首次创建该 store 的容器」供 HMR；类型层面为何入口内部用类型擦除版的 Store（纯粹是 TS 表达力限制，非原理）。

- **推荐的一个执行轨迹例子**：
  - 输入：定义 `const useCount = defineStore('count', () => ({ n: ref(0), inc() {} }))`——此刻**没有任何 store 被创建**，`useCount` 只是一个挂着 `$id` 的函数，注册表里没有 `'count'`。
  - 首次：`const s1 = useCount()`——解析容器（经注入拿到 app 的容器）→ 推为活跃 → 注册表无 `'count'` → 装配并写入注册表 → 返回实例。
  - 再次：`const s2 = useCount()`——注册表命中 `'count'` → 直接取出 → `s1 === s2`（同一实例）。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **定义函数有三个重载，但实现只有一个**：两个 option/setup 重载签名用于类型推断（store.ts:828-855），真正的实现签名是第三个（store.ts:859-864），用 `any` 收参后再内部归一——这是为了让「option 语法」和「setup 语法」共用同一段运行时逻辑。源码位置: packages/pinia/src/store.ts:828-864

- **定义即「零副作用」，靠注解让打包器 tree-shake**：实现签名上方标了 `/*! #__NO_SIDE_EFFECTS__ */`，同行注释写明 `// allows unused stores to be tree shaken`。这正是「返回函数而非实例」能换来的 tree-shake 能力的直接证据——调用 defineStore 不创建实例、不注册全局，故未使用的 store 可被安全剔除。源码位置: packages/pinia/src/store.ts:857-858

- **凭 setup 参数类型一次性分流两种语法**：`const isSetupStore = typeof setup === 'function'`（store.ts:879），再把选项归一为 `options = isSetupStore ? setupOptions : setup`（store.ts:881）。这个布尔标记随后在入口里决定走哪条装配路径，是「一个入口服务两种作者语法」的关键开关。源码位置: packages/pinia/src/store.ts:879-881

- **入口函数返回类型是「可调用接口」而非实例**：`StoreDefinition` 是一个带 call signature `(pinia?, hot?) => Store` 的 interface，外加 `$id` 字段（供 mapHelpers）和 dev 专属 `_pinia`（供 HMR）。它类型化地表达了「defineStore 返回的是函数 + 元数据，不是 store 对象」。源码位置: packages/pinia/src/types.ts:493-518

- **入口内部用类型擦除版的 Store**：`useStore` 内部一律按 `StoreGeneric` 处理（store.ts:883、948），因为闭包内部无法也无需保留具体泛型——这是「返回函数而非实例」在类型层面的必然代价（具体泛型只在外部重载签名上对调用方暴露）。源码位置: packages/pinia/src/store.ts:883,948 与 packages/pinia/src/types.ts:483-488

- **容器解析的四级优先级（本章相对第 1 章的新侧面）**：`pinia = (__TEST__ && activePinia && activePinia._testing ? null : pinia) || (hasContext ? inject(piniaSymbol, null) : null)`。即：① 测试旁路（测试模式下强制忽略传入参数）；② 显式传参；③ 有注入上下文则注入；④ 否则 null。随后 `if (pinia) setActivePinia(pinia)` 把解析结果推为全局活跃，再 `pinia = activePinia!` 兜底。对比第 1 章的取活跃容器原语（rootStore.ts:47-58，注入优先 + 全局兜底、不接受参数），本入口多了「显式传参优先」与「解析后推为活跃」两步——这是「按调用选容器」的核心。源码位置: packages/pinia/src/store.ts:884-900 与 packages/pinia/src/rootStore.ts:47-58,36

- **惰性创建 + 注册表缓存**：`if (!pinia._s.has(id))` 才分派装配（store.ts:902-908），随后 `const store = pinia._s.get(id)!` 取出返回（store.ts:917）。注释明说 `// creating the store registers it in pinia._s`——即「装配函数会负责把自己塞进注册表」，所以本入口只需 has/get。注册表 `_s: Map<string, StoreGeneric>` 的定义在第 1 章。源码位置: packages/pinia/src/store.ts:902-917 与 packages/pinia/src/rootStore.ts:104

- **「装配即注册」发生在装配函数内部、且在跑 setup 之前**：createSetupStore 在 `pinia._s.set($id, store)` 之后才跑 setup（store.ts:494，注释 492-493 解释「先占位注册是为了让 store 之间互相引用不死循环」）。这条原理的深意属于下一章，本章只需知道「装配函数保证了 has(id) 在下次调用时命中」。源码位置: packages/pinia/src/store.ts:492-502

- **入口函数挂 `$id` 作为元数据**：`useStore.$id = id`（store.ts:951）让 mapHelpers 能不调用入口就拿到 store 的 id（mapHelpers 据此生成 computed）。这是「入口函数本身也是数据载体」的体现。源码位置: packages/pinia/src/store.ts:951-953

## 关键调用链

定义阶段（零副作用）：
`defineStore(id, setup|options)` → 归一 options、记 `isSetupStore`（store.ts:879-881）→ 闭包进 `useStore` → `useStore.$id = id` → `return useStore`（store.ts:951-953）

首次实例化阶段：
`useStore(pinia?)` → `hasInjectionContext()`（store.ts:884）→ 解析容器：测试旁路 / 显式传参 / `inject(piniaSymbol)`（store.ts:888-889；piniaSymbol 见 rootStore.ts:125-127）→ `setActivePinia(pinia)` 推为活跃（store.ts:890；setActivePinia 见 rootStore.ts:36）→ `pinia = activePinia!` 兜底（store.ts:900）→ `if (!pinia._s.has(id))`（store.ts:902）→ `createSetupStore` 或 `createOptionsStore`（store.ts:904-908）→ 装配函数内部 `pinia._s.set($id, store)`（store.ts:494）→ `pinia._s.get(id)!` 返回（store.ts:917）

## 源码摘录（带行号，全文累计 ≤ 30 行）

定义归一与零副作用（演权衡 1：返回函数 + 定义零副作用）：
```ts
// allows unused stores to be tree shaken
/*! #__NO_SIDE_EFFECTS__ */
export function defineStore(id: any, setup?: any, setupOptions?: any): StoreDefinition {
  // ...
  const isSetupStore = typeof setup === 'function'
  options = isSetupStore ? setupOptions : setup

  function useStore(pinia?: Pinia | null, hot?: StoreGeneric): StoreGeneric {
    // ...
  }

  useStore.$id = id
  return useStore
}
```
源码位置: packages/pinia/src/store.ts:857-882,951-953

入口的容器解析 + 缓存（演权衡 2 按调用解析、权衡 1 惰性缓存）：
```ts
function useStore(pinia?: Pinia | null, hot?: StoreGeneric): StoreGeneric {
  const hasContext = hasInjectionContext()
  pinia =
    (__TEST__ && activePinia && activePinia._testing ? null : pinia) ||
    (hasContext ? inject(piniaSymbol, null) : null)
  if (pinia) setActivePinia(pinia)
  // ... dev 下无 activePinia 则抛错 ...
  pinia = activePinia!

  if (!pinia._s.has(id)) {
    // creating the store registers it in `pinia._s`
    if (isSetupStore) createSetupStore(id, setup, options, pinia)
    else createOptionsStore(id, options as any, pinia)
  }
  const store: StoreGeneric = pinia._s.get(id)!
  return store as any
}
```
源码位置: packages/pinia/src/store.ts:883-917

## 易混淆 / 边界 / 推断

- **事实**：入口**没有**直接调用第 1 章的 `getActivePinia()`，而是手动内联了「注入优先 + 全局兜底」逻辑，并在前面多了「显式传参 / 测试旁路」、在后面多了 `setActivePinia(pinia)`。推断原因：`getActivePinia` 不接受参数、也不会把结果推为活跃，而本入口恰恰需要「按调用选容器」并让后续装配链路（getter/action 内部的 setActivePinia）拿到正确的它。源码位置: packages/pinia/src/store.ts:884-900 与 packages/pinia/src/rootStore.ts:47-58

- **事实**：入口在 dev 下若 `!activePinia` 会抛错（store.ts:892-898），明确提示「是否在 app.use(pinia) 之前就用了 store」。这印证权衡 2 的代价——入口必须在有活跃上下文时调用。

- **事实**：入口内部不维护任何「是否已创建」的私有标志，唯一事实来源是注册表 `pinia._s`。因此「销毁一个 store」就是 `pinia._s.delete($id)`（见 `$dispose`，store.ts:349-354）——下次调用入口会重建。这把缓存的生命周期完全挂在注册表上，是「注册表即缓存」的直接体现。源码位置: packages/pinia/src/store.ts:349-354,902

- **事实**：测试旁路 `__TEST__ && activePinia._testing` 会把调用方显式传入的容器参数置为 null，强制走全局活跃——这是 `@pinia/testing` 的 `createTestingPinia` 能在不每次传参的情况下重塑 store 行为的入口级基础（属测试章，本章不展开）。源码位置: packages/pinia/src/store.ts:888 与 packages/pinia/src/rootStore.ts:111

- **推断（标注为推断）**：`useStore._pinia = pinia` 仅在 dev 下、首次创建时记录（store.ts:911-914），结合其 `_pinia?: Pinia` 的 `@internal Dev only pinia for HMR` 注释（types.ts:513-517），推断它是 HMR 用来定位「该 store 归属哪个容器」的线索，与 prod 行为无关。

- **跨章边界（重要，供 Writer 不越界）**：`createSetupStore` / `createOptionsStore` 的装配内部（effectScope 托管、返回值分类、state 镜像、先占位注册再装配的深意）**全部属于下一章『Store 装配』**。本章只把它们当作「负责创建并写注册表的黑盒」，不展开其内部。`$patch`/`$reset`/`$subscribe`/`$onAction` 等也不在本章。

- **未理解**：无。本章聚焦的「定义 → 入口闭包 → 缓存与容器解析」链路已读透；装配内部留待下一章。