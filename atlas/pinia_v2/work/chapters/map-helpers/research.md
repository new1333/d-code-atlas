# mapHelpers：Options API 适配 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个项目里有很多用「选项式写法」（声明 `computed`/`methods` 对象）的组件，它们没有 `setup()` 函数。如果状态库只能在 `setup()` 里调用，这些老组件就得全部改写成组合式才能用上 store。使用者要的是：像展开一个普通对象那样，把 store 里的状态、计算属性、动作「铺」进组件已有的 `computed`/`methods` 字段，而不写一行 `setup`。

- **一句话核心思想**：**映射即惰性取用器——注册时只放进一个未执行的函数，等组件真正访问该属性、`this` 已经是组件实例时，才去「取 store、取属性」。** 这是全章灵魂句。

- **设计动机（为什么需要它）**：取用 store 这件事依赖运行时上下文（需要拿到「当前应用挂的那个状态库实例」，而该实例要到 `app.use()` 之后才存在）。若在定义组件时就立即取 store，时机太早、上下文还没有。于是把「取用」推迟：每个映射产物是一个普通函数，它被展开进 `computed`/`methods` 后由框架在合适的时机、带着正确的 `this` 去调用——这样既绕开了「必须有 setup」，又等到了上下文齐备的那一刻。

- **关键权衡（核心原料）**：
  1. **把每个映射写成「带 this 的函数」而非立即求值的值** → 换来可直接展开进选项式的 `computed`/`methods`、用户零 setup 改造 → 代价是这些产物必须依赖组件实例上一个由插件安装时挂载的全局属性来拿到状态库实例，且每次属性访问都要重新走一遍「取实例→取单例 store」的调用链（store 虽是缓存的单例，但取用器调用本身不省）。
  2. **可写访问与只读访问拆成两套 API**：只读那套返回「取值函数」（框架包成只读计算属性），可写那套返回 `{ get, set }`（框架包成可写计算属性，能喂给双向绑定）→ 换来能精确表达「只读派生值不可写、原始状态可双向绑定」的语义，避免误写只读派生值 → 代价是使用者必须主动选对 API：只读访问和可写（如 `v-model`）访问是两个不同的函数，且可写那套的映射值只接受「原始状态键名」，不接受自定义函数。
  3. **同一函数同时接受「数组」和「对象」两种入参**，内部用一次类型判断分流 → 换来既能「键名同名铺开」又能「重命名 / 用函数派生」的灵活 → 代价是每个映射函数要维护多个重载签名，实现里出现大量类型断言抑制注释。
  4. **命名后缀用「模块级可变变量 + 一个 setter」**而非配置对象 → 换来一行调用就能全局改「整库访问」的命名后缀 → 代价是引入了非局部的可变状态（改一处影响全局），且类型层面要靠一处「声明合并接口」配合才能让改后缀的类型也跟着对上。

- **最小心智模型（以「映射一个只读状态属性」为例，6 步）**：
  1. 使用者在组件 `computed` 里写 `...mapState(状态库工厂, ['count'])`。
  2. 该函数立即执行，遍历每个键，为每个键生成一个**未执行**的取用器函数（函数体是「拿当前 this 对应的状态库实例 → 取该键的值」），装进结果对象返回。
  3. 结果对象被展开进 `computed`，框架把这些函数登记为该组件的计算属性。
  4. 组件渲染或代码访问 `this.count` 时，框架调用对应取用器，此时 `this` 是组件实例。
  5. 取用器从组件实例上那个「插件安装时挂的全局属性」拿到状态库实例。
  6. 用该实例取出（首次则懒创建）对应 store 单例，返回 `store.count`；框架据此建立响应式依赖。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达「惰性取用器」思想**的从零实现（几十行）。要点是——(a) 一个伪造的「状态库工厂」（带一个能当命名用的标识符）；(b) 一个只读映射函数，返回 `{ [key]: function() { return 取库(this.上的全局引用)[key] } }`；(c) 一个可写映射函数，返回 `{ [key]: { get, set } }`，set 里把值写回 store；(d) 用一个伪造的「组件实例对象」(上面挂好那个全局引用) 当 `this` 去调用，亲眼看到「定义时不求值、调用时才取值、set 能写回」。**这段演示演的是权衡 1（惰性取用换零 setup）+ 权衡 2（可写 vs 只读显式区分）这两条**。
  - 应故意省略：完整的 TS 泛型与多重载、数组/对象双形态的完整覆盖（演示只演一种即可点透）、命名后缀可变状态、开发期诊断警告、devtools 集成、与 `this` 上下文绑定的边界细节。**不追求工程完整、不追求可独立 install**，只追求「演透：映射产物是个被推迟执行的取用器」。

- **正文不宜展开的细节**（供 Writer 裁剪）：大量「仅供类型推导」的内部工具类型（把状态库工厂数组映射成「键→取用器」对象类型的递归类型）；开发模式下「误把状态库放进数组再传入」的容错与警告；命名后缀的声明合并接口；`mapGetters` 是 `mapState` 的废弃别名（因本库不区分 getter 与 state，都是 store 属性）；对象形态映射值「可以是函数」并能把组件 `this` 透传给该函数的细节。

- **推荐的一个执行轨迹例子**：
  - 输入：组件声明 `computed: { ...mapState(useCounterStore, ['count']) }`，随后访问 `this.count`。
  - 关键中间态：① `mapState` 执行期 → 产出 `{ count: function(this){ return 取库(this.$pinia)['count'] } }`；② 展开登记期 → 框架把 `count` 登记为计算属性，函数仍未执行；③ 访问期 → `this` 为组件实例，从其全局属性取到状态库实例，再取 store 单例。
  - 输出：`this.count` 返回 `store.count` 的当前值，且建立了响应式依赖（store 里 `count` 变 → 该计算属性重算）。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **本章只有一个源文件**：`packages/pinia/src/mapHelpers.ts`（全部公共 API 都在此）。它是「system」层适配器，依赖 define-store 章节的 `useStore` 工厂。
源码位置: packages/pinia/src/mapHelpers.ts:1-554

- **`this.$pinia` 的来源——这是整章机制的地基**：状态库实例在 `app.use(pinia)` 的安装阶段被挂到应用全局属性上，所以任何选项式组件的 `this.$pinia` 都能取到它；类型层面通过向 Vue 的「组件自定义属性」接口做声明合并来补上该属性的类型。
源码位置: packages/pinia/src/createPinia.ts:29
源码位置: packages/pinia/src/globalExtensions.ts:8-12

- **取用器的统一形态**：四个映射函数生成的每个产物，本质都是一个「在组件实例上下文执行的函数」，函数体里都出现同一表达式——用 `this.$pinia` 调用状态库工厂、再按下标取属性。区别只在「返回值本身」还是「返回值后调用它」还是「包成 get/set」。
源码位置: packages/pinia/src/mapHelpers.ts:114（取整个 store）
源码位置: packages/pinia/src/mapHelpers.ts:264（取属性值）
源码位置: packages/pinia/src/mapHelpers.ts:405（取动作并调用）
源码位置: packages/pinia/src/mapHelpers.ts:523,529（可写的 get/set）

- **`mapStores`——铺开「整个 store」**：遍历传入的每个状态库工厂，用「工厂的标识符 + 命名后缀」作为键，值为「返回整个 store 的取用器」。该标识符是 defineStore 给工厂函数附加的属性。
源码位置: packages/pinia/src/mapHelpers.ts:101-118（命名拼键见 110-111）
（工厂标识符来源）源码位置: packages/pinia/src/store.ts:951

- **`mapState`——只读访问 state/getter**：返回的每个值是「取值函数」（无 setter），展开进 `computed` 即只读计算属性。同时支持数组（键同名）与对象（可重命名、且对象的值可以是「接收 store 的自定义函数」，该函数被调用时 `this` 绑定到组件实例）。
源码位置: packages/pinia/src/mapHelpers.ts:250-290（对象形态自定义函数见 273-285）

- **`mapGetters` 是 `mapState` 的废弃别名**：直接 `export const mapGetters = mapState`，标注 deprecated。原因：本库里 getter 与 state 都是 store 上的普通属性，无需区分，故统一用 `mapState`。
源码位置: packages/pinia/src/mapHelpers.ts:296

- **`mapActions`——铺开动作进 `methods`**：返回的每个值是「带剩余参数转发的函数」，调用时先取 store 再 `store[key](...args)`。对象形态的值只能是字符串键名（不像 `mapState` 那样支持自定义函数）。
源码位置: packages/pinia/src/mapHelpers.ts:387-423

- **`mapWritableState`——可写访问（区别于 `mapState` 的关键）**：返回的每个值是 `{ get, set }` 对，get 取值、set 把值写回 store，故能用于 `v-model` 等双向绑定。文档注释明确「只能加 state 属性」（因其面向可写语义）。
源码位置: packages/pinia/src/mapHelpers.ts:504-554（数组形态 get/set 见 519-535）

- **命名后缀是模块级可变状态**：默认后缀为 `"Store"`（故 id 为 `user` → 访问器名 `userStore`）；通过 `setMapStoreSuffix` 可改（含置空）。类型上预留一个空接口供用户用「声明合并」补 `suffix` 字段，使改后缀后类型也正确。
源码位置: packages/pinia/src/mapHelpers.ts:62-77
源码位置: packages/pinia/src/mapHelpers.ts:17-21

- **开发期容错诊断**：若使用者误把状态库工厂放进数组再传给 `mapStores`（即第一个参数是数组），开发模式下会触发一条诊断警告（提示「生产环境会失败」）并自动展开该数组让它继续跑通。
源码位置: packages/pinia/src/mapHelpers.ts:104-107
（诊断条目定义）源码位置: packages/pinia/src/diagnostics.ts:11-14

- **数组/对象双形态归一**：`mapState`/`mapActions`/`mapWritableState` 各有两个「数组/对象」重载签名 + 一个用 `Array.isArray` 分流的实现重载；实现里多处用类型断言抑制注释（标注 FIXME），属已知类型推导短板。
源码位置: packages/pinia/src/mapHelpers.ts:259,397,518

## 关键调用链

组件访问 `this.xxx`
  → 取用器函数被框架调用（this = 组件实例）
  → 读 `this.$pinia`（由 createPinia 的 install 挂到应用全局属性）
  → `useStore(pinia)`（defineStore 工厂：取已注册单例，首次则懒创建并登记）
  → `store[key]`（属性值）/ `store[key](...args)`（动作）/ `store[key] = v`（可写 set）

支撑事实：
- 全局属性挂载 源码位置: packages/pinia/src/createPinia.ts:29
- 工厂签名与单例取用 源码位置: packages/pinia/src/store.ts:883-917
- 取用器四种产物 源码位置: packages/pinia/src/mapHelpers.ts:114,264,405,523

## 源码摘录（带行号，全文累计 ≤ 30 行）

mapStores 的取用器——命名靠「工厂标识符 + 全局后缀」，取 store 靠 `this.$pinia`（演示权衡 1：惰性取用器）：
```ts
111	    reduced[useStore.$id + mapStoreSuffix] = function (
112	      this: ComponentPublicInstance
113	    ) {
114	      return useStore(this.$pinia)
115	    }