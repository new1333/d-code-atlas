# defineModels：从类型合成 props/emits 双向绑定

> 本章属于 composite 层。前置：SFC 解析与增量 AST 编辑、编译期注入虚拟 helper 模块、props/emit 宏的编译期重写与类型转换。
> 学完你能：用一句话讲清「为什么 defineModels 要把一份类型编译期双向展开、又为什么提供 runtime / reactivity-transform 两种粘合形态」。

## 1. 为什么需要它

上一章我们看了怎么把 `$defineProps`、ShortEmits、defineProp 这些「更顺手或更旧的写法」在编译期改写成原生 `defineProps` / `defineEmits`。那批宏都是**一对一**重写：一种输入写法 → 一个原生宏。但 Vue 的双向绑定协议在这里留了个口子。

写一个 `v-model` 子组件时，你要的不是一根 prop，也不是一个事件，而是「一个双向的字段」。可 Vue 协议要求你把它**拆成两半**登记：

```ts
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
```

字段一改名，两处都得动；类型一改，两处都得对齐；要写五个 v-model 字段，这种成对的样板就抄五遍。你心里真正想说的是「这是一个双向绑定的字段」，可协议逼你把它翻译成「一根下行的 prop + 一个上行的事件」。更糟的是，子组件内要「写它」还得绕一层——`emit('update:modelValue', newVal)`，而不是像本地变量那样直接 `modelValue = newVal`。

`defineModels` 就是冲这个矛盾来的：让用户写**一份类型**描述一个双向字段，编译期替他把这一份类型翻译成 Vue 协议要的 prop + `update:` 事件对，运行时再补上「写它就等于发事件」的粘合。

## 2. 核心思想

**一份类型，编译期把它双向展开成 prop 与 `update:` 事件，再用两种运行时形态把这对 prop/event 粘成一个可写单元。**

这个抽象骨架是「翻译 + 粘合」：编译期翻译负责把用户的单一概念落成 Vue 协议要的两根线，运行时粘合负责在子组件内部把这两根线重新捏成一个能读能写的本地句柄。**展开是给协议看的，粘合是给开发者用的**。这是它跟上一章那些「纯重写器」宏最根本的区别：那些宏只翻译、不粘合，运行时什么也没多。

## 3. 心智模型

把整个流程想成一条流水线，每一步都对源码做一次基于偏移的增量改写（这套机制第 1 章讲透了，本章只看它的新用法）：

```
源码
  ↓ ① 扫 setup 顶层，定模式（runtime 还是 reactivity-transform）
  ↓ ② 从宏的泛型字面量抽出「字段名 → { 类型, 是否可选 }」映射表
  ↓ ③ 把表双向展开：propsText + emitsText 两段文本
  ↓ ④ 以类型交集注入到用户已有的 defineProps / defineEmits 类型上
  ↓ ⑤ 按模式落地运行时粘合（runtime: 整节点替换为 helper 调用；rt: 改为从 props 解构别名）
  ↓ ⑥ （仅 rt）walkAST 把对该别名的赋值改写为「发 update: 事件」helper 调用
改写后的源码 + sourcemap
```

关键数据结构就一张表：`字段名 → { 类型注解, 是否可选 }`。一切 props/emits 文本、helper 元组、改写规则都从这张表派生出来。

## 4. 关键权衡

### 4.1 双向展开成类型交集，而非各写各的

选了**编译期一次性合成**：把字段表翻译成 props 类型文本和 emits 类型文本，再用 `(旧类型) & { 新字段 }` 的**类型交集**形式注入到用户已有的 `defineProps` / `defineEmits` 上。换来的是用户只写一份类型就拿到类型天然一致的 prop + event 对，且能与用户已声明的其它字段共存。代价有两条：一是编译期要做类型交集的字符串拼接（不是替换），稍有泄漏会破坏用户原类型；二是字段名与事件名按硬约定绑定（`update:${字段名}`），事件名**不可自由命名**，想自定义事件名得用专门的选项元组。

化解的**本质矛盾**：双向绑定协议要求「prop/event 成对出现」，而开发者的心智里只有「一个字段」。这条权衡把「成对」压回了「一份」，让协议与心智对齐。

### 4.2 runtime 模式：用 passive 可写代理做粘合

runtime 模式选了**把宏调用整节点替换成一个 helper 调用**，这个 helper 对每个字段返回一个 passive 可写代理——读它返回 prop 值，写它则触发 `update:` 事件。换来的是用户拿到的是**标准 ref**：读写语义透明、`a.value = b.value = x` 这种链式赋值天然成立、且**完全不改写用户的赋值表达式**——编译期干净利落，源码长什么样、产物就长什么样。代价是用户必须显式写 `.value`，并且这个代理依赖一个外部运行时（`useVModel`，借宿主实例的 `$emit` 兜底发事件），这个 helper 通过第 3 章那套虚拟模块机制注入到源码里。

### 4.3 reactivity-transform 模式：静态改写赋值表达式

reactivity-transform 模式选了**把所有指向某字段的赋值/自增表达式静态改写成发事件调用**：声明语句被删除，字段改为从 `defineProps` 解构的别名；然后 walkAST 整段 setup，对每个赋值表达式查作用域，若左侧标识符是已登记的 model，就把这行赋值改写为 `emitHelper(emit, 'update:字段', 值)`。换来的是用户像写普通变量一样 `字段 = 值` 完成双向更新，无 `.value` 心智负担，语法最简。

代价分两层。表层：编译期必须遍历整段 setup 识别**每一个**指向该字段的赋值，含 `+=`、`++`、链式赋值、解构重命名、同名变量遮蔽（靠作用域比对来分辨「这是 model 别名还是恰好同名的本地变量」）。深层：这个「变量」**本质不是真变量**，它从 props 解构而来，对其赋值被替换成发事件，但**本地副本不会因父组件的状态变化而自动同步**——解构丢失响应性是该模式固有的代价。

4.2 与 4.3 化解的是**同一个本质矛盾**的两端：开发者想要「一个能像普通变量一样赋值的双向字段」，可这个赋值必须变成「向父组件通报」。要么保住语法透明、付出 `.value`（4.2），要么消掉 `.value`、付出赋值语义的侵入（4.3）。**这是双向绑定「下行 prop + 上行 event」协议在子组件内部必然要付出的代价，宏只能把它从开发者眼前挪到编译期，不能消灭它。**

## 5. 最小原理演示

下面这段代码从零演透「一份类型 → 双向展开 + 两种粘合」。它不依赖 Vue 运行时，一个假 emit 函数就能跑通原理。

```ts
// 演示「从泛型字面量抽字段表」（教学简化：正则代替 AST 解析）
function extractFields(generic: string): Map<string, { type: string; optional: boolean }> {
  const fields = new Map<string, { type: string; optional: boolean }>()
  for (const m of generic.matchAll(/(\w+)(\?)?:\s*([^,}>]+)/g)) {
    fields.set(m[1], { type: m[3].trim(), optional: !!m[2] })
  }
  return fields
}

// 演示「双向展开」：一份字段表 → props 文本 + emits 文本
function expand(fields: Map<string, { type: string; optional: boolean }>) {
  const propsText = [...fields]
    .map(([k, v]) => `${k}${v.optional ? '?' : ''}: ${v.type}`)
    .join(';\n')
  // 事件名按硬约定拼成 update:${字段名}
  const emitsText = [...fields]
    .map(([k, v]) => `(evt: 'update:${k}', value${v.optional ? '?' : ''}: ${v.type}): void`)
    .join(';\n  ')
  return { propsText, emitsText }
}

// 演示「以类型交集注入」：旧类型 & { 新字段 }，叠加而非替换
function intersect(oldType: string, addition: string) {
  return `(${oldType}) & {\n  ${addition}\n}`
}

// 演示 runtime 粘合：getter/setter 实现 passive 可写代理，写它即触发 emit
function makeWritableProxies(props: Record<string, any>, emit: (e: string, v: any) => void) {
  const ret: Record<string, any> = {}
  for (const key of Object.keys(props)) {
    Object.defineProperty(ret, key, {
      get: () => props[key],
      set: (v) => emit(`update:${key}`, v),
      enumerable: true,
    })
  }
  return ret
}

// 演示 rt 粘合：把「赋值」静态改写成「发事件」（教学简化：只演 = 单字段）
function rewriteAssignment(src: string, fields: Map<string, { type: string; optional: boolean }>) {
  let out = src
  for (const key of fields.keys()) {
    out = out.replace(
      new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'),
      `emit('update:${key}', $1)`,
    )
  }
  return out
}

// ============= 走一遍主线 =============
const fields = extractFields('{ modelValue: string }')
const { propsText, emitsText } = expand(fields)

console.log(intersect('UserProps', propsText))
// → (UserProps) & { modelValue: string }

console.log(intersect('UserEmits', emitsText))
// → (UserEmits) & { (evt: 'update:modelValue', value: string): void }

// runtime 模式：拿到可写代理，写它即触发事件
const proxies = makeWritableProxies(
  { modelValue: 'hello' },
  (e, v) => console.log(`[emit] ${e} = ${v}`),
)
proxies.modelValue = 'world'   // → [emit] update:modelValue = world

// rt 模式：赋值表达式被静态改写（输入假设声明已改写为 defineProps 解构）
const setupCode = `
let { modelValue } = defineProps<{ modelValue: string }>()
modelValue = 'hi'
`
console.log(rewriteAssignment(setupCode, fields))
// → 第二行 modelValue = 'hi' 被替换为 emit('update:modelValue', 'hi')
```

每一行都对应上面某个原理点：`extractFields` 演「抽字段表」、`expand` 演「双向展开」、`intersect` 演「类型交集叠加而非替换」、`makeWritableProxies` 演「runtime 模式的可写代理粘合」、`rewriteAssignment` 演「reactivity-transform 模式侵入赋值语义」。

## 6. 执行轨迹

拿一行真实的源码，看编译期到底发生了什么。输入是 reactivity-transform 模式：

```ts
let { modelValue } = $defineModels<{ modelValue: string }>()
modelValue = 'hi'
```

**第一步：定模式、抽字段表。** 扫到 `$defineModels`（带 `$` 前缀）→ 模式锁定为 reactivity-transform。从泛型字面量抽出字段表：`modelValue → { type: 'string', optional: false }`。

**第二步：双向展开、以类型交集注入。** 合成 propsText = `modelValue: string`；emitsText = `(evt: 'update:modelValue', value: string): void`。假设用户的 `<script setup>` 里已经有 `defineEmits<{ click: [] }>()`，那 emits 类型被整节点改写为：

```ts
({ click: [] }) & { (evt: 'update:modelValue', value: string): void }
```

如果用户没写 `defineEmits`，就**就地生成**一个 `const emit = defineEmits<{ ... }>()`。

**第三步：声明语句改写。** `let { modelValue } = $defineModels<{ modelValue: string }>()` 被整段删除，改成 `let { modelValue } = defineProps<{ modelValue: string }>()`。本地 `modelValue` 现在是 props 的解构别名。

**第四步：赋值表达式改写。** walkAST 走到 `modelValue = 'hi'` 这条 AssignmentExpression。查作用域：左侧 `modelValue` 对应的声明节点正好落在已登记的 model 标识符集合里 → 命中改写条件。这行被改写为：

```ts
emitHelper(emit, 'update:modelValue', 'hi')
```

**结果关键点**：这一句**赋值**变成了**向父组件的通报**。本地 `modelValue` 这个「变量」其实只是 props 的解构别名——你给它赋值并不会让本地的 `modelValue` 真的变成 `'hi'`，解构是值快照、丢失响应性。宏的契约是：「赋值」在 reactivity-transform 模式下只完成「上行通报」这一件事，不完成「修改本地副本」这件事。这是它和真变量最根本的区别。

## 7. 教学简化说明

本章演示故意省略了：`ModelOptions<T, Options>` 包装类型（值类型 + 运行时选项的双层表达）、`withDefaults` 穿透、接口形式类型、解构重命名（`{ modelValue: visible }`）、作用域比对识别同名变量遮蔽、复合赋值（`+=`）与后缀自增（`++`）的算式还原、`emitHelper` 对链式赋值返回值的语义保真、sourcemap、偏移修正、虚拟模块的 resolveId/load 机制（第 3 章已演）、SFC 解析（第 1 章已演）。

## 8. 小结

双向绑定的协议成本（成对登记、双向同步）被宏从开发者眼前挪到了编译期：一份类型双向展开是给协议看的，两种粘合是给开发者用的。runtime 与 reactivity-transform 之争不是风格偏好，而是「`.value` 与赋值侵入」这对不可调和矛盾的两端选择。

下一章我们看 better-define 怎么把这些宏在编译期擦除掉的 TS 类型，**反向**降级成运行时校验对象。