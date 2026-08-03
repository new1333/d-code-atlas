# defineModels：从类型合成 props/emits 双向绑定 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：Vue 的 `v-model` 协议要求子组件**同时**声明一根 prop 和一个 `update:该字段` 事件，且两者的类型要对得上。手写意味着同一份「这个字段是什么」要在 `defineProps` 和 `defineEmits` 里各抄一遍，字段一改名两处都得改、类型还容易对不齐。用户真正想表达的是「这是一个双向绑定的字段」，却被协议逼着拆成两半分别登记。

- **一句话核心思想**：**一份类型，编译期把它双向展开成 prop 与 `update:` 事件，再用两种运行时形态把这对 prop/event 粘成一个可写单元。**

- **设计动机（为什么需要它）**：Vue 的双向绑定在协议层是「prop 下行 + 事件上行」两根线，但用户的心智是「一个字段」。本宏把这俩用一份类型收束起来：编译期替用户把这一份类型**翻译成 Vue 原生宏能识别的 props 类型与 emits 类型**，运行时再补上「写它就等于发事件」的粘合，让用户拿到一个可写的本地句柄。
  - 承前去重：解析 SFC、懒解析 setup AST、基于偏移的增量改写（已在第 1 章『SFC 解析与增量 AST 编辑』讲透），本章只看它的新侧面——**一个宏在同一次转换里同时叠加「类型交集改写」「整节点替换」「跨 AST 改写赋值」三种增量编辑**。
  - 承前去重：往源码注入磁盘上不存在的 helper 模块（已在第 3 章『编译期注入虚拟 helper 模块』讲透），本章只看它的新侧面——**同一次转换按模式二选一，注入不同的运行时 helper**。
  - 承前去重：把更顺手的写法在编译期改写成原生 `defineProps`/`defineEmits`（已在第 4 章『props/emit 宏的编译期重写与类型转换』讲透），本章只看它的新侧面——**不是重写某个写法，而是从一份「描述双向绑定」的类型，一次性同时合成 props 和 emits 两个原生宏的类型**。

- **关键权衡（本章核心，3 条）**：
  1. **编译期把单类型双向展开成 props/emits 的类型交集** → 换来用户只写一份类型就拿到符合 `v-model` 协议的 prop+event 对（且类型天然一致） → 代价是编译期要做类型交集拼接（把新字段以 `旧类型 & { 新字段 }` 的形式叠进去），并且字段名与 `update:` 事件名按硬约定绑定（`update:${字段名}`），事件名不可自由命名（除非用专门的选项类型）。
  2. **「返回 ref」模式靠一个 passive 可写代理（写它即触发 `update:` 事件）做粘合** → 换来用户拿到的是标准 ref、读写语义透明、链式赋值天然成立、且不侵入普通赋值语法 → 代价是用户必须显式写 `.value`，且依赖外部运行时（该代理借宿主实例的 `$emit` 兜底发事件）。
  3. **「赋值即触发」模式把所有指向该字段的赋值/自增表达式静态改写成「发事件」调用** → 换来用户像写普通变量一样 `字段 = 值` 就完成双向更新、无 `.value` 心智负担、语法最简 → 代价是编译期必须遍历整段 setup 识别每一个指向该字段的赋值（含 `+=`、`++`、链式赋值、解构重命名、变量遮蔽），且这个「变量」本质不是真变量（它从 props 解构而来、对其赋值被替换成发事件，本地副本不会自动同步），**侵入了赋值语义**。

- **最小心智模型（3～7 步）**：
  1. 扫描 setup 顶层语句，识别三类宏调用：原生 `defineProps`/`defineEmits`（记录其类型声明与左值）、返回 ref 的宏（「运行时模式」）、赋值即触发的宏（「响应式转换模式」），据此确定本组件走哪种模式。
  2. 从该双向绑定宏的泛型类型字面量里抽出每个字段，得到一张「字段名 → { 类型注解, 是否可选, 绑定选项 }」的映射表。
  3. 据这张表合成两段类型文本：prop 端是 `字段: 类型`，事件端是 `(evt: 'update:字段', value: 类型): void`。
  4. 以**类型交集**把这两段注入到用户已有的 `defineProps`/`defineEmits` 类型上；用户若没写，就就地生成这两个原生宏。
  5. 分模式落地运行时粘合：运行时模式把宏调用整段替换成一个「返回可写代理集合」的 helper 调用（按字段名解构出每个字段的代理）；响应式转换模式则删掉宏声明，改成「从 props 解构出字段别名」。
  6. （仅响应式转换模式）遍历整段 setup，把每个指向某字段别名的赋值/自增表达式，改写成「向父组件发 `update:` 事件」的 helper 调用，并正确处理复合赋值、重命名与同名变量遮蔽。
  7. 输出改写后的代码与 sourcemap。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的从零实现，演**「一份类型 → 双向展开 + 两种粘合」**这条主线。骨架：(a) 给定源码片段里某个带泛型字面量的宏调用；(b) 用简单解析（正则或手写小解析）抽出字段名与类型；(c) 生成两段文本——一段当 props 类型、一段当 `update:` 事件类型；(d) 运行时粘合的最小版「可写代理」：一个对象，读返回 prop 值、写则调用 emit(`update:字段`, 值)；(e) 响应式转换粘合的最小版：把 `字段 = 值` 字符串替换成 `emit('update:字段', 值)`。每一行都要对应上面某个原理点。
  - **应故意省略**：绑定选项类型（`ModelOptions`）、`withDefaults`、接口形式类型、解构重命名、作用域解析、复合赋值/自增、sourcemap、偏移修正、多字段并发、虚拟模块的 resolveId/load 机制（第 3 章已演）、SFC 解析（第 1 章已演）。**不追求工程完整**，只追求演透「双向展开 + 两种粘合」。
  - **演示载体建议**：本章仓库是 TS，建议写成一段能 `bun run`/`node` 直接跑的独立脚本（能跑最好，非硬要求）。把「可写代理」用 ES Proxy 或 getter/setter 实现即可，无需引入真实 Vue 运行时——一个假 emit 函数打印调用即可演透原理。

- **正文不宜展开的细节**（供 Writer 裁剪）：`ModelOptions<T, Options>` 包装类型的解析分支；`withDefaults` 包裹的穿透；emits 未被接收时自动补一个临时变量接住返回值；`$defineModels` 与 `defineModels` 两个宏名常量的字面差异；选项元组里「省略默认值」的产物体积优化；错误处理（重复声明、非类型参数、rest 元素、运行时参数冲突）；与 volar 的类型层镜像（留给系统层章节）。

- **推荐的一个执行轨迹例子**：
  - 输入（响应式转换模式）：`let { modelValue } = $赋值即触发宏<{ modelValue: string }>();  modelValue = 'hi'`
  - 中间态：声明语句被删除 → 生成 `let { modelValue } = defineProps<{ modelValue: string }>()`；同时 emits 类型被注入 `(evt: 'update:modelValue', value: string): void`；赋值表达式被改写。
  - 输出关键：`发事件helper(emit, 'update:modelValue', 'hi')`——一句赋值变成了向父组件的通报，本地 `modelValue` 这个「变量」其实只是 props 的解构别名。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **模式由宏名决定**：调用「返回 ref 的宏」走 runtime 模式，调用「带 `$` 前缀的赋值即触发宏」走 reactivity-transform 模式；两者互斥，重复声明直接抛错。源码位置: packages/define-models/src/core/index.ts:106-113
- **一个字段在编译期被合成两条类型**：prop 端 `${key}${typeAnnotation}`（含可选 `?`），事件端 `(evt: 'update:${key}', value${typeAnnotation}): void`，事件名由字段名硬拼接而成。源码位置: packages/define-models/src/core/index.ts:206-217, 459-465
- **类型以「交集」叠加而非替换**：用增量编辑把用户原有的 props/emits 类型整节点改写成 `(旧类型) & { 新字段 }`，从而保留用户已声明的其它字段；用户若没写原生宏则就地生成。源码位置: packages/define-models/src/core/index.ts:219-226, 264-282
- **runtime 模式的运行时粘合**：宏调用被整节点替换为 helper 调用，helper 对每个字段返回一个 passive 可写代理；解构后用户拿到每个字段的代理（读写需 `.value`）。源码位置: packages/define-models/src/core/index.ts:286-311；helper 实现: packages/define-models/src/core/helper/use-vmodel.ts:4-28
- **reactivity-transform 模式侵入侵赋值语义**：宏声明被删除、字段改为从 props 解构的别名；随后遍历整段 setup，把对该别名的赋值（含 `+=`、`++`、链式、重命名）改写为「发 `update:` 事件」的 helper 调用。源码位置: packages/define-models/src/core/index.ts:313-364, 385, 399-414
- **作用域比对识别「真正的 model 赋值」**：改写赋值时用遍历器提供的作用域表查出左侧标识符对应的声明节点，再与「已登记的 model 标识符集合」比对，借此正确处理同名变量遮蔽（只改写真正指向 model 的那一个）。源码位置: packages/define-models/src/core/index.ts:52, 121-124, 341-343, 353-355
- **解构重命名靠别名表还原事件名**：`{ modelValue: visible }` 时建立 `别名 visible → 原字段 modelValue` 的映射，改写 `visible = x` 时用原字段名拼 `update:` 事件。源码位置: packages/define-models/src/core/index.ts:434-443, 325, 332
- **`ModelOptions<T, Options>` 在类型层同时表达值类型与绑定元信息**：遇到该引用类型时，取第 1 个类型参数作为真实值类型，取第 2 个（如 `{ defaultValue }`）作为运行时选项，透传到 helper 元组的第 4 项。源码位置: packages/define-models/src/core/index.ts:165-190, 299-305
- **emits 未被接收时自动补接住变量**：若用户的 `defineEmits` 没有左值，编译期在它前面补一个临时变量接住返回值，供响应式转换模式的「发事件」helper 使用。源码位置: packages/define-models/src/core/index.ts:93-96, 272-273
- **运行时参数冲突即报错**：若用户的 `defineProps`/`defineEmits` 带了运行时参数（非纯类型声明），无法做类型交集注入，直接抛错。源码位置: packages/define-models/src/core/index.ts:70-73, 422-425

## 关键调用链

```
transformDefineModels(code, id)
 ├─ parseSFC → getSetupAst            // 懒解析（第1章），拿 setup 顶层语句
 ├─ 遍历 setupAst 顶层语句
 │   ├─ processDefinePropsOrEmits      // 识别原生 defineProps/defineEmits，收类型声明与左值
 │   └─ processDefineModels            // 识别双向绑定宏，定模式，收类型声明/左值/标识符集合
 ├─ extractPropsDefinitions(modelTypeDecl)  // 泛型字面量 → 字段映射表
 ├─ rewriteMacros()
 │   ├─ rewriteDefines                 // 注入 props/emits 类型交集（或就地生成原生宏）
 │   └─ rewriteRuntime   (仅 runtime)  // 宏调用整节点 → 返回可写代理集合的 helper 调用
 ├─ processAssignModelVariable (仅 rt) // walkAST 把赋值/自增 → 发事件 helper 调用
 └─ generateTransform(s, id)           // 输出 code + sourcemap
```
源码位置: packages/define-models/src/core/index.ts:31-453（主流程 366-452）

## 源码摘录（带行号，全文累计 ≤ 30 行）

// (1) 一份类型 → 双向展开成 props 文本与 emits 文本（演「双向展开」原理）
源码位置: packages/define-models/src/core/index.ts:206-217
```ts
const propsText = Object.entries(map)
  .map(([key, { typeAnnotation }]) => `${getPropKey(key)}${typeAnnotation}`)
  .join(';\n')
const emitsText = Object.entries(map)
  .map(([key, { typeAnnotation }]) =>
    `(evt: '${getEventKey(key)}', value${typeAnnotation}): void;`)
  .join('\n  ')
```

// (2) 以类型交集叠加到用户已有 props 类型上（演「叠加而非替换」原理）
源码位置: packages/define-models/src/core/index.ts:219-226
```ts
s.overwriteNode(
  propsTypeDecl!,
  `(${s.sliceNode(propsTypeDecl!, { offset: setupOffset })}) & {\n  ${propsText}\n}`,
  { offset: setupOffset },
)
```

// (3) 响应式转换模式：把指向 model 的赋值静态改写为「发事件」（演「赋值即 emit、侵入赋值语义」原理）
源码位置: packages/define-models/src/core/index.ts:338-351
```ts
walkAST(setupAst!, { leave(node) {
  if (node.type === 'AssignmentExpression') {
    if (node.left.type !== 'Identifier') return
    const id = this.scope[node.left.name] as Identifier
    if (!modelIdentifiers.has(id)) return     // 作用域比对，处理变量遮蔽
    const left = s.sliceNode(node.left, { offset: setupOffset })
    let right = s.sliceNode(node.right, { offset: setupOffset })
    if (node.operator !== '=')                // 复合赋值 += 等还原成算式
      right = `${left} ${node.operator.replace(/=$/, '')} ${right}`
    overwrite(node, id, right)                // → emitHelper(emit,'update:key',right)
  }
}})
```

// (4) runtime 模式的运行时粘合：每个字段返回 passive 可写代理（演「写它即发事件」原理）
源码位置: packages/define-models/src/core/helper/use-vmodel.ts:13-25
```ts
if (typeof _k === 'string') {
  ret[_k] = useVModel(props, _k, undefined, { eventName: `update:${_k}`, passive: true })
} else {
  const [key, prop = key, eventName = `update:${key}`, options = {}] = _k
  ret[key] = useVModel(props, prop, undefined, { eventName, passive: true, ...(options as any) })
}
```

## 易混淆 / 边界 / 推断

- **事实**：runtime 模式**不**改写赋值——`processAssignModelVariable` 仅在 reactivity-transform 模式被调用（`if (mode === 'reactivity-transform' && hasDefineModels)`）。runtime 模式下的链式赋值（如 `a.value = b.value = x`）完全靠 passive ref 的 setter 自身连续触发 emit，编译期不介入。源码位置: packages/define-models/src/core/index.ts:449-450
- **事实**：reactivity-transform 模式下「model 变量」不是真变量——声明语句被删除，字段改为从 `defineProps` 解构的别名；对其赋值被替换成发事件调用，本地别名不会因发事件而自动同步（解构丢失响应性是该模式的固有代价）。源码位置: packages/define-models/src/core/index.ts:242-262, 313-336
- **事实**：`emitHelper` 在发完事件后**返回所赋的值**（`return args.length > 0 ? args[0] : value`），且对后缀 `++`/`--` 会把旧值作为第 4 个参数透传，以保住赋值/自增表达式的原返回值语义（使改写后的表达式可继续参与链式或传参）。源码位置: packages/define-models/src/core/helper/emit-helper.ts:3-11；调用处: packages/define-models/src/core/index.ts:326-336, 352-361
- **事实**：`ModelOptions` 的第 2 个类型参数被当作运行时选项（如 `defaultValue`）原样字符串化后透传给 helper 元组第 4 项，并非参与 props/emits 的值类型。源码位置: packages/define-models/src/core/index.ts:175-189, 300-305
- **推断（标注为推断）**：`getPropKey/getEventKey` 的 `omitDefault=true` 分支（runtime 模式生成 helper 元组时）刻意返回 `undefined`，让产物里元组只保留必要的非默认项（因为 key===prop、event===`update:key` 已由 helper 默认值兜底）——属产物体积优化，不影响语义。源码位置: packages/define-models/src/core/index.ts:295-297, 459-465
- **边界**：组件必须用纯类型声明 `defineProps`/`defineEmits` 才能与本宏共存；带运行时参数（含 `withDefaults` 的第一个参数本身仍是类型，但若 `defineProps(运行时对象)`）会触发 `runtimeDefineFn` 报错。源码位置: packages/define-models/src/core/index.ts:56-73, 422-425
- **未理解**：`rewriteMacros` 前有两行被注释的 `resolveObjectExpression(defaultsAst)`（line 445-446），疑似曾计划把 `withDefaults` 的默认值透传到 model 的运行时选项，但已搁置；当前 `ModelOptions.defaultValue` 走的是类型层而非 `withDefaults` 通道。源码位置: packages/define-models/src/core/index.ts:445-446