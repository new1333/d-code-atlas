# 响应式语法糖：赋值即 .value

写过 Composition API 的人，大概都干过这种事：明明只想让一个数字自增，却每次都得惦记着那个 `.value`。

```ts
const count = ref(0)
function inc() { count.value++ }                 // 每次都得 .value
const double = computed(() => count.value * 2)   // 这里也是
```

声明成响应式之后，它反而比普通变量更难用——读要 `.value`、写要 `.value`、传进模板字符串还得 `.value`。你心里大概会嘀咕：**声明的时候已经告诉过你它是响应式的了，为什么用的时候还要我每次提醒？** 这章讲的这个宏，就是来替你把这句「提醒」省掉的：

```ts
const count = $ref(0)
function inc() { count++ }                       // 当普通变量写
const double = $computed(() => count * 2)        // 这里也不用 .value
```

## 它到底想解决什么

先说结论：**运行时它什么新东西都没发明**。`count` 在运行时就是一个地地道道的 Vue `ref`，跟你自己手写 `ref(0)` 一模一样，传给任何要 ref 的 API 都行。宏做的事只有一件——**在编译期替你把 `.value` 填好**。

打个比方：编译期先抄一张「响应式花名册」，把所有用 `$ref` / `$()` / `$computed` 声明的名字记上去；然后拿着这张花名册，把你源码里对这些名字的每一处使用，就地改成 `.value` 访问。花名册上有的名字，出场就得带 `.value` 这个工牌；不在册上的，原样放过。

> 这套「解析源码 → 按需解析 AST → 用增量字符串编辑器改写 → 自己算偏移」的底座，第 1 章已经讲透了，这里不重复。本章直接站在它上面，只关心一个新问题：**怎么用这套底座，做一次「针对标识符读写的定向重写」**——不新增任何解析或编辑设施，只是在它之上，把「这个变量是响应式的」这件事，翻译成源码里的一处处 `.value`。下文用到的 `appendLeft`（在某位置之后插入）、`overwrite`（覆盖一段）、`remove`（删一段），都是第 1 章那套增量编辑器的基本动作。

## 自底向上：从一张花名册开始

### 谁是响应式变量：识别「ref 创建调用」

花名册不是凭空来的，得先能认出「哪些声明是在造响应式变量」。宏把合法的来源收敛成两类：

- 转换符 `$()`：`const count = $(ref(0))`、`const { x } = $(useFoo())`——`$` 包住任意一个返回值，把结果登记成响应式。
- 简写 `$ref` / `$computed` / `$shallowRef` / `$toRef` / `$customRef`：`const count = $ref(0)`——直接就是 ref 工厂。

判断逻辑很直白：看到一个 `const x = 某调用()`，就看那个调用的名字是不是 `$`，或者是不是 `$` 开头且去掉 `$` 后落在简写白名单里。是的话，`x` 就上花名册。

这里有个贴心的守卫：**如果当前作用域里已经有人把 `$` 这个名字拿去当普通变量用了（被遮蔽），就不再把 `$` 当转换符**。想象一下用户自己写了 `const $ = 1`，你要是还把后面的 `$(...)` 当糖去删，就把人家的合法代码毁了。所以识别之前先看一眼「这个作用域里 `$` 是不是已经被占了」。

### 作用域：一摞套着的房间

光有花名册还不够。真实代码里变量是有作用域的——外层声明一个 `count`，函数里又声明一个同名 `count`，这俩不是一回事。所以花名册不是一张大平表，而是一摞**从外到内套着的房间**：

- 最外面是大厅（根作用域），顶层声明的 `count`、`double` 都登记在这里。
- 进一个函数体、进一个 `{ }` 块、进一个 `catch`，就各自开一间新房，把这一层声明的名字登记进新房。
- 查名字的时候，**站在最里屋开始喊，先在自己屋找，没有就去外屋，一直找到大厅**——最先找到的那层说了算。这样内层同名变量就能正确盖住外层。

这里有个容易忽略的细节：普通变量也要登记，只不过标成「假」。为什么？因为如果内层有个普通变量 `let count = 1`，它把外层的响应式 `count` 盖住了，那么内层用到 `count` 时**不该**补 `.value`。把内层这个普通 `count` 记成「假」，查表查到它就直接停、不补 `.value`——这正是遮蔽该有的行为。说人话就是：花名册不仅要记「谁是响应式」，还得记「谁虽然同名但不是」，才能在该停的地方停下来。

### 为什么必须两遍：先登记，再改写

现在到了一个关键设计决定。你可能会想：能不能一边遍历一边干——遇到声明就记，遇到引用就改，一趟走完？不行。因为**引用可以出现在声明之前**：函数会被提升、回调里可能引用到后面才声明的 ref、嵌套闭包里的使用顺序千奇百怪。如果单遍走，等你改到某处引用时，可能还没走到它的声明，花名册上还没有这个名字，你就不知道该不该补 `.value`。

所以宏老老实实分两趟：

1. **第一遍·登记**：只扫声明，把所有名字（响应式的标 true、普通的标 false）登记进对应的作用域房间，把整摞花名册先建完整。
2. **第二遍·改写**：再从头遍历每一处「引用」，拿完整的册子查表，命中响应式就补 `.value`。

册子建完才动笔，这样不管引用在声明的上面、下面、还是某个埋得很深的回调里，查表都能查到。

### 改写的三种长相

第二遍查表命中之后，根据这个引用长什么样，改法不一样：

- **普通引用** `count * 2` → 在标识符后面 `appendLeft('.value')`，变成 `count.value * 2`。
- **对象简写** `{ foo }` → 不能只在后面加，要补成 `{ foo: foo.value }`，否则语法不对。
- **`$$()` 转义** → 这是个反向开关：`$$(count)` 的意思是「在这里我要的是 ref 对象本身，别给我补 `.value`」。进入 `$$(...)` 就打开一个「转义区」，区域里对响应式变量的引用**跳过** `.value`，同时把 `$$` 两个字删掉。

（还有一条保命规则：用 `const` 声明的响应式变量，要是被放到了赋值或自增的左边，编译器直接报错——const 的 ref 不能重新赋值。这条属于正确性护栏，不展开。）

## 一条流水线

把上面串起来，一份源码从进到出是这样走的：

```
源码字符串
  │
  ├─ 正则粗筛：源码里没有 $ref / $() / $computed 这类痕迹？
  │     └─ 是 → 原样返回，后面全不干（绝大多数文件走这条捷径）
  │
  ├─ 解析成 AST
  │
  ├─ 第一遍 walkScope：扫所有声明 → 建作用域花名册
  │     （$ref/$() 声明的记 true，普通变量记 false；函数体/块/catch 各开一层）
  │
  ├─ 第二遍 walkAST：遍历每个标识符引用
  │     ├─ 从最内层作用域向外查表
  │     ├─ 命中 true  → 补 .value（或修对象简写）
  │     ├─ 命中 props → 改成 __props.xxx（SFC 场景，本章不展开）
  │     └─ 处于 $$() → 跳过 .value，删掉 $$
  │
  ├─ 顶部注入 helper：import { ref as _ref, computed as _computed } from 'vue'
  │
  └─ 输出新字符串 + sourcemap
```

## 把原理跑起来：最小演示

下面这段脚本只演核心三件事——**两遍遍历 + 作用域花名册 + 引用处补 `.value`**，外加 `$$()` 转义。它用 `@babel/parser` 解析、用 `magic-string` 改写，能直接跑：

```ts
import { parse } from '@babel/parser'
import MagicString from 'magic-string'

// 把 $ref / $() / $computed 声明的变量，在每一处引用自动补上 .value
function transform(src: string): string {
  const ast = parse(src, { sourceType: 'module', plugins: ['typescript'] })
  const s = new MagicString(src)

  // 花名册：true=响应式（引用处补 .value），false=普通变量（登记了，但别动它）
  const scopes: Record<string, boolean>[] = [{}]   // 作用域栈，最底下是根作用域
  let escape = false                                // 是否正处在 $$(...) 内

  const top = () => scopes[scopes.length - 1]
  const isSugar = (c: string) => c === '$' || /^\$(ref|computed|shallowRef)$/.test(c)

  // 从最内层向外查表，第一个命中的为准（内层同名变量遮蔽外层）
  const lookup = (name: string) => {
    for (let i = scopes.length - 1; i >= 0; i--)
      if (name in scopes[i]) return scopes[i][name]
  }

  // —— 第一遍·登记：把每个声明的名字按「是不是响应式糖」记进当前作用域 ——
  function declare(body: any[]) {
    for (const stmt of body)
      if (stmt.type === 'VariableDeclaration')
        for (const d of stmt.declarations) {
          const init = d.init
          const ok = init?.type === 'CallExpression' &&
            init.callee.type === 'Identifier' && isSugar(init.callee.name)
          top()[d.id.name] = !!ok   // true=响应式，false=普通（登记防误改）
        }
  }

  // —— 第二遍·改写：遍历引用，命中响应式就补 .value；遇 $$() 进转义 ——
  function visit(node: any, parent: any) {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'BlockStatement') { scopes.push({}); declare(node.body) }  // 进块开新作用域

    if (node.type === 'CallExpression' && node.callee?.name === '$$') {
      escape = true                                              // 进 $$()：区域内不补 .value
      s.remove(node.callee.start, node.callee.end)               // 删掉 $$ 符号
      node.arguments.forEach((a: any) => visit(a, node))
      escape = false
      return
    }

    if (node.type === 'Identifier' &&
        parent?.type !== 'VariableDeclarator' &&                 // 排除声明位的名字
        !escape && lookup(node.name) === true)
      s.appendLeft(node.end, '.value')                           // x --> x.value

    for (const k in node) {                                       // 递归子节点
      const v = node[k]
      if (Array.isArray(v)) v.forEach((c: any) => visit(c, node))
      else if (v && typeof v.type === 'string') visit(v, node)
    }

    if (node.type === 'BlockStatement') scopes.pop()             // 出块关作用域
  }

  declare(ast.program.body)   // 先把所有顶层声明登记完
  visit(ast.program, null)    // 再遍历引用改写
  return s.toString()
}
```

喂进去这段：

```ts
const count = $ref(0)
const double = $computed(() => count * 2)
function inc() {
  count++
  watch($$(count), cb)
}
```

走一遍轨迹：

1. **登记**：`count`、`double` 在根作用域记成 `true`；`inc` 是函数声明（演示里简化，未单独登记）。
2. **改写 `count * 2`**：`count` 查表命中 `true` → `count.value * 2`。
3. **改写 `count++`**：`count` 命中 `true` → `count.value++`（`inc` 函数体开了新作用域，但内层没遮蔽，查到外层的 true）。
4. **`$$(count)`**：打开转义区，删掉 `$$`，里面的 `count` 跳过 `.value`——所以传给 `watch` 的是 ref 对象本身。

得到：

```ts
const count = $ref(0)
const double = $computed(() => count.value * 2)
function inc() {
  count.value++
  watch((count), cb)
}
```

注意两点：`$ref` / `$computed` 本身没被改名（真源码会把它们改成注入的 `_ref` / `_computed` 并在顶部加 import，演示为了聚焦省略了）；`watch((count), cb)` 多出来的括号，是删掉 `$$` 后留下的、原本属于调用的那对括号，无害。

> 演示为求简明，只排除了 `VariableDeclarator` 处的声明名。真实实现更精确：用一个 WeakSet 把所有「声明位」的标识符（函数名、参数、解构出来的 key、`defineProps` 解构的变量）统一排除，还跳过 TS 类型节点、用 `isReferencedIdentifier` 判断「这到底是不是一处引用」。

## 关键权衡

### 权衡一：静态文本改写，换取「无 .value」的书写体验

这是整章最核心的一个决定。

- **选择**：在编译期把源码文本里的 `x` 直接改成 `x.value`（`appendLeft` 插一段字符串），而不是在运行时搞一个 Proxy / 自动解包的包装器去「假装」它是个普通变量。
- **换来**：**零额外运行时开销**——产出的代码就是你手写 `ref().value` 的样子，没有多出任何对象、任何拦截层；**与原生 ref 完全兼容**，拿到的就是 Vue 原生的 ref，传给 `watch`、`toRef` 等任何期望 ref 的 API 都没问题；**TS 类型推导不受影响**，因为运行时类型本来就是 `Ref<T>`，`.value` 自然推出 `T`。
- **代价**：**失去语法透明性**。你翻开编译产物、或断点调试时看到的 `count.value` 是编译器塞进去的，不是你写的；更微妙的是，源码里 `count++` 看着像改一个数字，实际改的是一个 ref，读代码的人必须先知道「`count` 被宏接管了」才能正确理解。更实际地，为了**不误改**，得堆大量保守的静态判定：要分清一个 `count` 到底是「声明它」（声明位不能补 `.value`）还是「用它」；要跳过 TS 类型标注里的名字（类型位置的 `count` 不是引用）；要跳过对象简写的 key、解构出来的占位名；`const` ref 放到赋值左边要直接报错……这些判定漏一个，就会把不该加 `.value` 的地方加了、或该加的漏了。这部分判定占了真实代码相当大的篇幅——这正是「换无 `.value` 体验」要付的账单。

### 权衡二：两遍遍历（先登记、后改写），换取引用正确性

- **选择**：先 `walkScope` 把全部声明一次性登记进花名册，再 `walkAST` 遍历引用查表改写，而不是单遍边走边改。
- **换来**：**引用可以出现在任意位置**——声明之前（函数提升、回调引用后定义的 ref）、任意深的嵌套闭包里——都能被正确识别为响应式。因为登记是事先全做完的，改写时册子已经完整。
- **代价**：**跑两趟遍历**；而且为了把作用域算对，得**自己手工维护一个词法作用域栈**——进函数体、进块、进 `catch` 各压一层，出来各弹一层，还要把函数参数、`catch` 参数登记到对应层。这套手写的作用域管理就是正确性的成本。还有一处更隐蔽的代价：为了判断「`$` 转换符有没有被局部变量遮蔽」，每次识别 ref 创建调用都要把整条作用域栈合并成一个新对象看一眼——在超大文件、极多作用域时这是实打实的开销，但正确性优先，认了。

（顺带一提正则预筛这条小机制：进解析之前，先用一条正则看源码有没有 `$ref(`/`$()` 之类痕迹，没有就直接原样返回。换来绝大多数无糖文件零成本跳过——不解析、不建 AST；代价是正则有边界误判，比如注释里恰好写了 `$ref(`，但它只决定「要不要进入解析」，误判顶多多跑一次解析，最终改不改仍由 AST 说了算，不影响输出正确性。）

至于解构（`const { x } = $(useFoo())`），真源码用「把整个解构模式替换成一个临时变量，再在后面逐个字段 `toRef` 取出来」的拆法，换来了响应式解构的完整语法（含默认值、嵌套、重命名），代价是生成临时变量和一段路径拼接逻辑——这属于工程完整度，不是原理重点，不展开。

## 小结

一句话收束：**编译期造一张响应式花名册，然后照着册子，在源码每一处引用上把 `.value` 补好**。运行时还是那个原生 ref，宏只是替你填了那个总忘加的 `.value`；为此付出的代价是失去语法透明性、以及一整套为「不误改」服务的保守静态判定和手写作用域栈。

本章所有改写都发生在「已经解析好的一个 script / script setup 块内部」——这是第 1 章底座给我们的前提。下一章要动的，正是这个前提本身：**把「一个 SFC 只能有一个 script setup」这个框框打开**——让整文件即 setup、加独立的 setup 块、甚至把 setup 内联定义的子组件抽成虚拟模块再 import 回来。