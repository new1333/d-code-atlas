---
title: "defineModels：从类型合成 props/emits 双向绑定"
---

# defineModels：从类型合成 props/emits 双向绑定

## 1. 痛点：同一个字段，要在两个地方各登记一次

想象你在写一个计数器组件，父组件要用 `v-model` 控制它。Vue 的 `v-model` 协议要求子组件**同时**有两样东西：一根叫 `modelValue` 的 prop，和一个叫 `update:modelValue` 的事件。

写出来是这样：

```ts
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()
```

你会觉得哪里不对劲：`modelValue` 这个字段，你定义了一次类型 `string`，然后又把同一个 `string` 抄到事件签名里。字段一改名（比如 `modelValue` → `count`），prop 和事件名两处都得改；类型一变，两处都得跟。你心里想表达的是「这是一个双向绑定的字段」，但协议逼你把它拆成两半，分别塞进两个宏。

`defineModels` 就是来消灭这份重复的。它让你**只写一份类型**，编译期替你把这一份类型同时展开成 prop 和事件，运行时再把这俩粘成一个能读能写的整体。

## 2. 先看协议底子：双向绑定 = 一根下行 + 一根上行

要理解 `defineModels` 在粘合什么，得先看它要粘的两根线。

Vue 的双向绑定说白了是两条线在走：

- **下行**：父组件把值通过 prop 传给子组件；
- **上行**：子组件要改值时，不能直接改父组件的变量（单向数据流），只能「喊一声」——发个 `update:modelValue` 事件把新值通报上去，父组件听到后自己改。

父组件写 `v-model="x"`，Vue 帮它展开成 `:modelValue="x"` 加上 `@update:modelValue="x = $event"`，等价于：值往下传，变化往上喊。这两条线合起来才是「双向」。

`defineModels` 做的事，就是在「一份类型」和「这两根线」之间做翻译。下面三小节拆开看它怎么翻。

## 3. 双向展开：一份类型，翻成两段文本

还记得第 1 节那段又臭又长的 `defineProps` 加 `defineEmits` 吗？宏干的第一件事，就是别让你再写它。它把你给的那份类型，翻成 prop 和事件两段文本。

你给宏一个泛型类型字面量：

```ts
defineModels<{ modelValue: string; count: number }>()
```

宏扫一遍这个字面量，为每个字段造一张卡片：`{ 字段名, 类型, 事件名 }`。事件名没有自由发挥的余地，直接按硬约定拼成 `update:${字段名}`——`modelValue` 对应 `update:modelValue`，`count` 对应 `update:count`。然后拿这张卡片表合成两段文本：

```
prop 端： modelValue: string; count: number
事件端： (evt: 'update:modelValue', value: string): void;
         (evt: 'update:count', value: number): void
```

左边那段当 `defineProps` 的类型，右边那段当 `defineEmits` 的类型。注意事件签名里的 `value` 类型跟 prop 一模一样——因为它们本来就来自同一张卡片，想对不上都难。这就是「一份类型」换来的天然一致性。

### 用交集叠进去，而不是替换

用户可能已经自己写过 `defineProps<{ foo: number }>()`。宏不能把人家原有的 `foo` 字段抹掉。它不替换，而是把新字段**以类型交集的形式叠进去**：

```ts
// 用户原本： defineProps<{ foo: number }>()
// 注入后：
defineProps<({ foo: number }) & {
  modelValue: string
  count: number
}>()
```

`(旧类型) & { 新字段 }` 这个写法，旧字段照常生效，新字段加了进来。用户压根没写 `defineProps`，宏就就地生成一个。`defineEmits` 同理。

这里有个前置概念要回指：怎么扫描 SFC、怎么懒解析 setup 的 AST、怎么用偏移做增量改写，是所有宏共用的地基，第 1 章「SFC 解析与增量 AST 编辑」已讲透。本章只看它用这套地基的**新侧面**——**一个宏，在这一次转换里，同时叠加了三种增量编辑**：把 prop 类型做交集改写（类型层）、把 emit 类型做交集改写（类型层）、再视模式对宏调用本身做整节点替换或对赋值表达式做改写（语句层）。三种编辑叠在同一次改写里、共用一套偏移。

同样，往源码注入一个磁盘上不存在的 helper 模块这套机制（虚拟 id + resolveId/load 拦截），第 3 章「编译期注入虚拟 helper 模块」已展开。本章只看**新侧面**：**同一次转换里，按模式二选一，注入不同的 helper**——runtime 模式注入 `useVModel`，reactivity 模式注入 `emitHelper`，两个 helper 各自撑起一种粘合方式。

而跟第 4 章「props/emit 宏的编译期重写」相比，这里有个根本区别：第 4 章那些宏是把**某种更顺手的写法改写成原生 `defineProps`/`defineEmits`**（纯重写器，不引入新运行时能力）；`defineModels` 不是重写某个写法，而是**从一份「描述双向绑定」的类型，一次性同时合成 props 和 emits 两个原生宏的类型**，外加一套运行时粘合。它真的多带来了一种运行时能力。

## 4. 粘合：两种模式，两种代价

展开类型只是把协议的形状凑齐了。但用户拿到手还差一步：`modelValue` 这个东西，得能**读**它（拿当前值）、能**写**它（改了之后向上通报）。怎么把读和写接到一起去，`defineModels` 给了两套方案，由宏名决定走哪套：

- 写 `defineModels()` → **runtime 模式**（返回 ref）；
- 写 `$defineModels()`（带美元符）→ **reactivity-transform 模式**（赋值即触发）。

两者互斥，重复声明直接抛错。

### 模式一：返回一个能读能写的代理

runtime 模式下，宏调用被整段替换成一个 helper 调用，这个 helper 给每个字段返回一个**可写代理**（一个 passive ref）：

```ts
// 用户写的
const { modelValue } = defineModels<{ modelValue: string }>()

// 编译后大致长这样
const { modelValue } = useVModel(props, emit)
// modelValue 是个 { value } 对象：读 .value 拿 prop 值，写 .value 就触发 emit
```

这个代理说人话就是「一个带开关的盒子」：你读它的 `.value`，它把父组件传下来的 prop 值递给你；你给它的 `.value` 赋值，它转身就喊一嗓子 `update:modelValue`。读写透明，且因为是标准 ref，链式赋值（`a.value = b.value = x`）天然成立——setter 会一个接一个触发 emit。

### 模式二：赋值即触发，把赋值语句整个改写

reactivity-transform 模式走得更激进。用户写：

```ts
let { modelValue } = $defineModels<{ modelValue: string }>()
modelValue = 'hi'
```

编译期发生两件事：

1. **声明语句被删掉**，`modelValue` 改成从 `defineProps` 解构出来的别名（`let { modelValue } = defineProps<...>()`）。也就是说，这个所谓的「变量」，本质是 prop 的一个本地副本。
2. **整段 setup 被扫一遍**，凡是给 `modelValue` 赋值的地方，都被静态改写成「发事件」：

```ts
// modelValue = 'hi'  →  emitHelper(emit, 'update:modelValue', 'hi')
```

赋值动作被换成了向上通报。用户感觉自己在「给变量赋值」，实际每写一个 `=`，编译期都替你换成了一句「喂，父组件，modelValue 变成 'hi' 了」。

这套方案的吸引力是**语法最简**——没有 `.value`，写起来跟普通变量一模一样。但它的代价比模式一重得多，下一节专门讲。

## 5. 关键权衡

### 权衡一：编译期把单类型双向展开，换来「一份类型 = 一对协议对」

**选择**：在编译期，把用户给的那一份类型，翻成 prop 端和事件端两段文本，以类型交集叠进 `defineProps`/`defineEmits`。

**换来**：用户只写一份类型，就拿到符合 `v-model` 协议的「prop + 对应事件」一对，而且两者类型天然一致（同源）。字段改名、改类型，只动一处。`v-model` 那套「prop 下行、事件上行」的协议形状，用户再也不用手动凑。

**代价**：一是编译期得做类型交集的字符串拼接（`(旧类型) & { 新字段 }`），不是简单赋值；二是**事件名按硬约定绑定**——`update:${字段名}` 写死，事件名不可自由命名。如果某个字段你想叫一个别的事件名，得专门用选项类型去指明，绕一层。

### 权衡二：runtime 模式用可写代理做粘合，换来「标准 ref、读写透明」

**选择**：返回一个 passive 可写代理（读返回 prop 值、写则触发 `update:` 事件）来做 prop 和 event 的粘合。

**换来**：用户拿到的是标准 ref，读写语义透明、链式赋值天然成立、且**不侵入普通赋值语法**——你用的是正常的 `.value` 写法，编译期不会去偷偷改你的赋值语句，所见即所得。

**代价**：用户必须显式写 `.value`（ref 的老毛病）；且这个代理依赖外部运行时——它借宿主组件实例的 `$emit` 来兜底发事件，所以必须有真实的 Vue 运行时环境，不是纯函数。

### 权衡三：reactivity-transform 模式静态改写赋值，换来「无 .value、语法最简」，代价是侵入赋值语义

**选择**：删掉宏声明、字段改为 props 解构别名，然后遍历整段 setup，把每个指向该字段的赋值表达式静态改写成「发事件」调用。

**换来**：用户像写普通变量一样 `modelValue = 'hi'` 就完成了双向更新，没有 `.value` 心智负担，语法是两种模式里最简的。

**代价**分两层，都不轻：

1. **编译期要做大量静态分析**。赋值不只是 `modelValue = x` 这一种。还有 `modelValue += 1`（复合赋值，得还原成 `modelValue + 1` 再发）、`modelValue++`（自增，得算出旧值/新值）、链式赋值、解构重命名（`{ modelValue: visible }` 时，得建立 `visible → modelValue` 的别名表，改写 `visible = x` 时用原字段名拼事件）、甚至**同名变量遮蔽**——你在 setup 里又声明了一个局部 `modelValue`，改写时得靠作用域表比对，只改真正指向 model 的那一个，不能误伤局部变量。每一种都要正确处理，漏一种就是 bug。

2. **更隐蔽的代价：这个「变量」根本不是真变量**。它的声明语句被删了，本质是从 `defineProps` 解构出来的别名。你给它赋值，编译期把赋值换成了发事件——但**本地这个别名并不会因为发了事件就自动更新**。你写下 `modelValue = 'hi'` 之后，本地 `modelValue` 在这次渲染里还是旧值，要等父组件把新值通过 prop 传回来、重新渲染，别名才跟着变。在「赋值完立刻读」这种场景下，行为会和真变量的直觉不符——解构本身就会丢失响应性，这是该模式固有的代价。

一个对比能看清楚两条路：同样是「写它就触发事件」，runtime 模式靠代理的 setter（运行时机制，所见即所得，但要 `.value`）；reactivity 模式靠编译期改写赋值语句（语法最简，但赋值语义被偷偷改了、变量也不是真变量）。**一边拿运行时透明换语法简洁，一边拿语法简洁换运行时透明**，没有两全。

## 6. 原理演示

下面这段脚本从零实现「一份类型 → 双向展开 + 两种粘合」这条主线。每一行对应上面某个原理点。不追求工程完整——省掉了绑定选项、`withDefaults`、接口形式类型、复合赋值/自增、sourcemap、偏移修正（那些是真实宏的工程细节，不影响你看懂主线）。

```ts
// demo.mjs —— 跑法：node demo.mjs

// ─── 演透原理用的假运行时 ───
// emit：子组件往上的「喊话通道」，调一次就是通报一次
const emit = (event, value) =>
  console.log(`  [emit] ${event} <- ${JSON.stringify(value)}`)

// ─── 用户真正想写的：一份类型 ───
const modelType = '{ modelValue: string }'

// 【原理点1】从泛型字面量抽字段，得到「字段名 → {类型, 事件名}」的卡片表
function extractFields(typeSrc) {
  const map = {}
  for (const seg of typeSrc.replace(/[{}]/g, '').split(',')) {
    const m = seg.match(/\s*(\w+)\??\s*:\s*(.+)/)
    if (m) map[m[1]] = { type: m[2].trim(), event: `update:${m[1]}` }
  }
  return map
}
const fields = extractFields(modelType)

// 【原理点2】双向展开：一张卡片表 → props 文本 + emits 文本
function expand(map) {
  const propsText = Object.entries(map)
    .map(([k, f]) => `${k}: ${f.type}`).join('; ')
  const emitsText = Object.entries(map)
    .map(([k, f]) => `(evt: '${f.event}', value: ${f.type}): void`).join(' ')
  return { propsText, emitsText }
}
const { propsText, emitsText } = expand(fields)
console.log('props 文本 :', propsText)
console.log('emits 文本 :', emitsText)

// 【原理点3】类型交集叠加：不替换，把新字段叠进用户原有的类型
const userPropsType = '{ foo: number }'
console.log('注入后 props:', `(${userPropsType}) & { ${propsText} }`)

// 【粘合A · runtime 模式】写它即触发 emit 的可写代理（一个带开关的盒子）
function writableProxy(props, key) {
  return {
    get value() { return props[key] },
    set value(v) { emit(`update:${key}`, v) },
  }
}
const fakeProps = { modelValue: 'init' }
const mv = writableProxy(fakeProps, 'modelValue')
console.log('\n[runtime] 读 mv.value =', mv.value)
mv.value = 'hi' // 用户必须写 .value，setter 替你 emit

// 【粘合B · reactivity 模式】把赋值语句静态改写成「发事件」
// （声明语句被删、改为从 props 解构的部分此处省略，只演赋值改写）
function rewriteAssign(code, map) {
  let out = code
  for (const k of Object.keys(map)) {
    out = out.replace(
      new RegExp(`\\b${k}\\s*=\\s*([^;]+);`),
      `emitHelper(emit, 'update:${k}', $1);`,
    )
  }
  return out
}
// emitHelper：发完事件后返回所赋的值，保住赋值表达式的返回语义（链式/传参才不断）
function emitHelper(fn, key, value, ...rest) {
  fn(key, value)
  return rest.length > 0 ? rest[0] : value
}
const userCode =
  `let { modelValue } = $defineModels<{ modelValue: string }>();\nmodelValue = 'hi';`
console.log('\n[reactivity] 改写后:')
console.log(rewriteAssign(userCode, fields))
```

跑一下你会看到：`modelValue = 'hi'` 这句被换成了 `emitHelper(emit, 'update:modelValue', 'hi')`，而 `mv.value = 'hi'` 触发了同一次 emit——两种粘合殊途同归，最后都落到「向上喊一嗓子」上。

## 7. 小结

`defineModels` 把「双向绑定字段」从一个协议层的拆分（prop 加 event 两半），变回用户心智里的「一个字段」：编译期用一份类型同时合成 props 和 emits（类型交集叠加，事件名按硬约定拼），运行时再用两种粘合之一把这个字段变可写。

两条粘合路的取舍是这一章真正要带走的东西：**runtime 模式用可写代理换来了标准 ref 和赋值语义的透明，代价是 `.value`；reactivity-transform 模式用编译期改写赋值换来了最简语法，代价是赋值语义被侵入、变量也不是真变量。** 选哪条，取决于你更在意「所见即所得」还是「少敲几个字符」。

在 `defineModels` 这里，类型只在编译期被展开成 props/emits 的形状、运行时并不校验它。下一章 **better-define** 恰恰换了个方向：把这份 TS 类型**降级成运行时真的会去校验的对象**——让类型成为运行时校验的唯一真相来源。
