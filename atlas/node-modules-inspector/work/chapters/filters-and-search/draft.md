# 过滤器与搜索：声明式 schema + 字段 DSL

## 你打开了一个 monorepo，然后呢

想象你刚拉下一个大型 monorepo，跑完 `pnpm install`，node_modules 里躺着四千多个包。你想找的是其中十几个：所有 license 不是 MIT 的、所有版本低于 1.0 的 vue 全家桶、所有作为可选依赖被装进来的。

如果工具只给你一个搜索框，你输 `vue`，它把所有名字里含 vue 的全列出来——里面有 200 条，你想要的 10 条埋在里面。如果工具给你一堆互相不认识的勾选框，每勾一个就要重写一份逻辑，加新字段就是改一次前端代码。

这一章讲的，就是把「多维筛选 + 即时反馈 + 可分享查询」这三件诉求，落到一份 **声明式 schema + 构造式谓词 + 字段 DSL** 的三件套上。

## 从最底层那块开始：把字符串规格变成函数

整个机制里最底层的东西，是一个看起来不起眼的小函数：把字符串 `'@vue/core@^3.0.0'` 编译成一个 `(pkg) => boolean` 的闭包。

为什么需要它？因为用户在 UI 里选中的「我要 focus @vue/core@^3.0.0」是一段字符串，而最后要去判断每一个包是否匹配，需要一个函数。**这段字符串不能每次筛数据时都重新解析一遍**——四千个包乘以每帧重算，立刻爆。

所以先做一次「编译」，之后对每个包只跑预编译好的判断：

```ts
function constructPackageFilter(range: string) {
  // 用 \b@ 拆出 name 与 version（\b 是词边界，避开 scope 名字里的 @）
  const [name, version = '*'] = range.split(/\b@/)

  // name 里有 * → 编译成正则；否则原样保留做字面量比较
  const nameMatch = name.includes('*')
    ? new RegExp('^' + [...name].map(c =>
        c === '*' ? '.*' : c === '.' ? '\\.' : c
      ).join('') + '$')
    : name

  // 返回闭包：对每个包跑同样的判断
  return (pkg: { name: string, version: string }) => {
    const isNameMatch = nameMatch instanceof RegExp
      ? nameMatch.test(pkg.name)
      : pkg.name === name
    const isVersionMatch =
      version === '*' ||
      pkg.version === version /* 或 satisfies(pkg.version, version) */
    return isNameMatch && isVersionMatch
  }
}
```

跑起来：

```ts
const isTarget = constructPackageFilter('@vue/core@^3.0.0')
isTarget({ name: '@vue/core', version: '3.4.21' })  // true
isTarget({ name: '@vue/core', version: '2.7.16' })  // false（版本不匹配）
isTarget({ name: 'vue',       version: '3.4.21' })  // false（名字不匹配）

const isAnythingVue = constructPackageFilter('*vue*')
isAnythingVue({ name: '@vue/shared', version: '3.4.0' })  // true
isAnythingVue({ name: 'vite',        version: '5.0.0' })  // false
```

说人话就是：**一次编译，多次复用**。这就是整个机制最底层的那块积木。

几个值得记住的细节：
- `\b@` 用来拆 name 和 version。为什么要 `\b`（词边界）？因为 scope 名字里也有 `@`（`@vue/core`），不能简单按 `@` 拆——得拆的是「词边界之后的 @」，也就是真正的版本分隔符。
- `*` → `.*`、`.` → `\.`。只支持 `*` 一种通配符，不支持 `?`，因为够用了。
- `version` 三种情况：`*`（任意）/ 字面量（精确匹配）/ 其它（用 `satisfies()` 做 semver 范围匹配，比如 `^1.0.0`）。

## 多条规格合到一起：some / every

用户往往不止选一个包。比如 focus 了 `['@vue/core', '*eslint*']`，意思是「这两种任一命中就算」。这时候需要把多个单包闭包合并成一个：

```ts
function constructPackageFilters(
  ranges: (string | ((pkg: any) => boolean))[],
  mode: 'some' | 'every',
) {
  const fs = ranges.map(r =>
    typeof r === 'string' ? constructPackageFilter(r) : r
  )
  return (pkg: any) =>
    mode === 'some' ? fs.some(f => f(pkg)) : fs.every(f => f(pkg))
}
```

注意一个逃生口：`ranges` 数组里允许混入「已经是函数」的项，会跳过编译直接合入。这意味着——如果你后面要扩展出某种图查询谓词（比如「在依赖图里和我关注的包有连通关系」），不用动这套编译机制，自己写个 `(pkg) => bool` 直接塞进数组就行。

## 字段集中登记：声明式 schema

到这里，单看一个字段，我们已经有能力把它编译成判断了。问题是：一个真实过滤器有十几个字段——搜索框、focus 列表、模块类型、来源、深度、cluster……还有排除类的（排除 dts、排除私有包）、对比类的（A 组 vs B 组）。

最朴素的写法是：每个字段定义自己的 state、自己的 reset、自己的「是否激活」判断。然后字段一多就开始漏：reset 时漏掉某个字段、URL 序列化时漏掉某个字段、activated 高亮提示里漏掉某个字段。

这套机制不这么干。它把所有字段先登记到 **一份 schema** 里：

```ts
const FILTERS_SCHEMA = {
  search:       { type: String,  default: '',     category: 'select' },
  focus:        { type: Array,   default: null,   category: 'select' },
  why:          { type: Array,   default: null,   category: 'select' },
  depths:       { type: Array,   default: null,   category: 'select' },
  clusters:     { type: Array,   default: null,   category: 'select' },
  clustersMode: { type: String,  default: 'or',   category: 'option' },

  excludes:        { type: Array,   default: null,  category: 'exclude' },
  excludeDts:      { type: Boolean, default: true,  category: 'exclude' },
  excludeDev:      { type: Boolean, default: false, category: 'exclude' },
  excludeOptional: { type: Boolean, default: true,  category: 'exclude' },
  // ...
}
```

每条字段只挂三件事：**类型 / 默认值 / 归类**。说人话就是——这块 schema 是一块公共留言板，谁想从字段里读默认值、谁想列出「所有 select 类字段」、谁想做 reset，都来这里看一眼，不需要再去翻别的角落。

从这份 schema 直接派生出三件事：

```ts
// 1. 默认 state：把每条的 default 抠出来
const FILTERS_DEFAULT = Object.fromEntries(
  Object.entries(FILTERS_SCHEMA).map(([k, v]) => [k, v.default])
)

// 2. select 类字段名集合
const FILTER_KEYS_SELECT = Object.entries(FILTERS_SCHEMA)
  .filter(([_, v]) => v.category === 'select').map(([k]) => k)

// 3. exclude 类字段名集合
const FILTER_KEYS_EXCLUDES = Object.entries(FILTERS_SCHEMA)
  .filter(([_, v]) => v.category === 'exclude').map(([k]) => k)
```

这三件事后面要反复用——reset 时遍历 keys、activated 列表也遍历 keys、URL 序列化也按 keys 来。**任何一处新增字段，只要在 schema 里登记一行，下游全部自动跟上。**

## select 类总谓词：用数组折叠表达多维 AND

state 是一份响应式对象，里头每个字段都可能改。最终我们要把所有 select 类字段塌缩成「一个针对包的判断」。

最干净的写法是：**先把每个字段编译成一条独立的谓词，push 到数组里，最后用 `every` 折叠**。这相当于把「这个包要留下来」拆成「条件 1 满意 AND 条件 2 满意 AND ……」这样一串串联判断：

```ts
function buildSelectPredicate(state: any) {
  const predicates: ((pkg: any) => boolean)[] = []

  if (state.focus?.length) {
    const matchFocus = constructPackageFilters(state.focus, 'some')
    predicates.push(pkg => matchFocus(pkg))
  }
  if (state.depths?.length) {
    const depths = state.depths.map(Number)
    predicates.push(pkg => depths.includes(pkg.depth))
  }
  if (state.sourceType === 'prod') {
    predicates.push(pkg => pkg.isProd || pkg.workspace)
  }
  // ...其它 select 字段同样 push 一条

  // 关键：所有条件 AND 起来
  return (pkg: any) => predicates.every(fn => fn(pkg))
}
```

最后那一行 `predicates.every(fn => fn(pkg))` 就是核心。换句话说：「**这个包要留下来，得让所有 select 条件都点头。**」任意一条不满意，就淘汰。

这种写法的好处是扩展极简：新加一个字段，就在中间插一个 `if + predicates.push`，不动其它代码。

## exclude 类：走另一条路

你可能要问：exclude 跟 select 不都是「判断要不要这个包」吗，为什么不合到一起？

因为 **语义不一样**。select 是「全命中才留」（AND），exclude 是「任一命中就丢」（OR）。把两套合到一条谓词里很容易写错——比如 `excludeDev` 是一个 boolean 开关，它的语义是「如果 pkg 是 dev 类，就丢掉」，而不是「如果 pkg 不是 dev 类，就留下」。混在 select 里会变成「全部 select 命中 AND 不是 dev」——逻辑上看似等价，但实际上一旦后续加 cluster 扩展、加图闭包扩展，两套语义就开始打架。

所以这套机制选择把 exclude 独立成一条函数，先跑：

```ts
function buildExcludePredicate(state: any) {
  const matchExcludes = state.excludes?.length
    ? constructPackageFilters(state.excludes, 'some')
    : null
  return (pkg: any) => {
    if (state.excludeDts && pkg.module === 'dts') return true
    if (state.excludeDev && pkg.isDevOnly && !pkg.isProd) return true
    if (state.excludeOptional && !pkg.filepath) return true
    if (state.excludePrivate && pkg.private) return true
    if (matchExcludes && matchExcludes(pkg)) return true
    return false
  }
}
```

最上游筛数据时是这两条谓词 **接力**：先问 exclude「这个包要不要丢」，再问 select「这个包要不要留」。

```
原始数据
   │
   ├──► excludePredicate(pkg) === true  ？ → 丢
   │
   └──► selectPredicate(pkg)  === true  ？ → 留 : 丢
```

## 搜索框：一个字符串里塞下多维查询

到这为止，state 里的每个字段都对应一个明确的 UI 控件：勾选框、下拉、tag 列表。但还有一种「高级用户」场景——他不想点十几个控件，他想一行写完：

```
vite not:@vitejs license:MIT author:yyx990803
```

这一行字符串里其实塞了四个条件：标识含 `vite`、scope 不是 `@vitejs`、license 匹配 `MIT`、作者匹配 `yyx990803`。这就是搜索 DSL。

**思路分两步**：先用一条全局正则把所有 `field:value` 抽出来，再把剩下的文本当子串：

```ts
const RE_COLON_FIELDS = /\b(\w+):("[^"]*"|'[^']*'|`[^`]*`|\S*)/g

function parseSearch(input: string) {
  let text = input
  let invert = false
  const not: RegExp[] = []
  const license: RegExp[] = []
  const author: RegExp[] = []
  const removal: [number, number][] = []

  // 开头加 ! → 整条谓词最后取反
  if (text.startsWith('!')) { invert = true; text = text.slice(1) }

  for (const match of text.matchAll(RE_COLON_FIELDS)) {
    let value = match[2]
    // 去引号（支持 "xxx" 'xxx' `xxx` 三种）
    if (/^["'`].*["'`]$/.test(value)) value = value.slice(1, -1)

    switch (match[1]) {
      case 'not':     if (value) not.push(new RegExp(value, 'gi'));     break
      case 'license': if (value) license.push(new RegExp(value, 'gi')); break
      case 'author':  if (value) author.push(new RegExp(value, 'gi'));  break
      default: continue  // 不认识的字段 → 跳过且不从原文裁掉
    }
    removal.push([match.index!, match.index! + match[0].length])
  }

  // 倒序裁掉所有 field:value 段（倒序是为了不破坏前面索引）
  removal.sort((a, b) => b[0] - a[0])
    .forEach(([s, e]) => { text = text.slice(0, s) + text.slice(e) })

  // 多空格折叠成单空格，trim
  text = text.replace(/\s+/g, ' ').trim()

  return { text, invert, not, license, author }
}
```

跑一下：

```ts
parseSearch('vite not:@vitejs license:MIT author:yyx990803')
// {
//   text: 'vite',
//   not:     [/@vitejs/gi],
//   license: [/MIT/gi],
//   author:  [/yyx990803/gi]
// }
```

几个关键细节：
- **倒序裁掉** 是因为按正序裁会让后面的索引失效。倒着裁不影响前面的位置。
- **`default: continue`** 是「宽容退化」：用户写了 `foo:bar` 这种不认识的字段，**不报错，也不从原文裁掉**，整段 `foo:bar` 会作为子串进入 `text`。这样用户写错了至少能搜到包含这段字符的包，而不是被一个错误弹窗打断。
- **`!` 前缀对整条谓词取反**，不是单字段。`!a b` 的意思是「不是（匹配 a 且 匹配 b）」，跟「不匹配 a 且匹配 b」完全不同。这一点很容易用错。

## 完整执行轨迹

把所有零件接上，用户在搜索框敲下 `vite not:@vitejs license:MIT author:yyx990803` 后会发生什么：

```
1. 用户敲键 → state.search 变化
        │
        ▼
2. useDebounce(200ms) 等 200ms 没新输入才放行
        │  （避免每按一键就重建整张谓词图）
        ▼
3. parseSearch(searchDebounced.value)
   → { text: 'vite', not: [/@vitejs/], license: [/MIT/], author: [/yyx990803/] }
        │
        ▼
4. selectPredicate 重算：
   predicates 数组追加一条新谓词，对每个 pkg 检查：
     - 标识串不匹配 /@vitejs/        → 否则淘汰
     - license 匹配 /MIT/             → 否则淘汰
     - authors 含匹配 /yyx990803/     → 否则淘汰
     - 标识串含子串 'vite'            → 否则淘汰
        │
        ▼
5. 上游 payload 用新谓词筛 rawPayload
        │
        ▼
6. 渲染：列表瞬时刷新
```

整个过程里，**用户感知到的延迟** = 200ms 防抖 + 一次谓词重建 + 一次筛数据。几千个包，闭包都是预编译好的，跑一遍只是几次属性读取和正则 test，不到一帧。

## 把它跑起来：一个最小可运行的演示

下面这份脚本把前面所有零件串起来，能直接 `node`/`bun`/`tsx` 跑通。它故意省略了响应式框架、URL 同步、防抖（这些是工程层，不是原理层），只保留「schema → state → 谓词 → 筛数据」这条内核。

```ts
// demo.ts —— schema 驱动的过滤器
// 跑：bun demo.ts  或  npx tsx demo.ts

// ────────────── 1. schema：字段集中登记 ──────────────
const FILTERS_SCHEMA = {
  search:         { default: '',    category: 'select'  },
  focus:          { default: null,  category: 'select'  },
  sourceType:     { default: null,  category: 'select'  },
  depths:         { default: null,  category: 'select'  },

  excludes:       { default: null,  category: 'exclude' },
  excludeDts:     { default: true,  category: 'exclude' },
  excludePrivate: { default: false, category: 'exclude' },
} as const

type State = { [K in keyof typeof FILTERS_SCHEMA]: any }

const FILTERS_DEFAULT: State = Object.fromEntries(
  Object.entries(FILTERS_SCHEMA).map(([k, v]) => [k, v.default])
) as State

// ────────────── 2. 字符串规格 → 闭包 ──────────────
function constructPackageFilter(range: string) {
  const [name, version = '*'] = range.split(/\b@/)
  const nameMatch = name.includes('*')
    ? new RegExp('^' + [...name].map(c =>
        c === '*' ? '.*' : c === '.' ? '\\.' : c).join('') + '$')
    : name
  return (pkg: { name: string, version: string }) => {
    const nameOk = nameMatch instanceof RegExp
      ? nameMatch.test(pkg.name) : pkg.name === name
    const verOk = version === '*' || pkg.version === version
    return nameOk && verOk
  }
}
function constructPackageFilters(ranges: string[], mode: 'some' | 'every') {
  const fs = ranges.map(constructPackageFilter)
  return (pkg: any) => mode === 'some' ? fs.some(f => f(pkg)) : fs.every(f => f(pkg))
}

// ────────────── 3. 搜索 DSL ──────────────
const RE = /\b(\w+):("[^"]*"|'[^']*'|`[^`]*`|\S*)/g
function parseSearch(input: string) {
  let text = input, invert = false
  const not: RegExp[] = [], license: RegExp[] = [], author: RegExp[] = []
  const removal: [number, number][] = []
  if (text.startsWith('!')) { invert = true; text = text.slice(1) }
  for (const m of text.matchAll(RE)) {
    let v = m[2]
    if (/^["'`].*["'`]$/.test(v)) v = v.slice(1, -1)
    switch (m[1]) {
      case 'not':     if (v) not.push(new RegExp(v, 'gi'));     break
      case 'license': if (v) license.push(new RegExp(v, 'gi')); break
      case 'author':  if (v) author.push(new RegExp(v, 'gi'));  break
      default: continue
    }
    removal.push([m.index!, m.index! + m[0].length])
  }
  removal.sort((a, b) => b[0] - a[0]).forEach(([s, e]) => { text = text.slice(0, s) + text.slice(e) })
  return { text: text.replace(/\s+/g, ' ').trim(), invert, not, license, author }
}

// ────────────── 4. select 总谓词：数组 + every 折叠 ──────────────
function buildSelectPredicate(state: State) {
  const ps: ((pkg: any) => boolean)[] = []
  if (state.focus?.length) {
    const match = constructPackageFilters(state.focus, 'some')
    ps.push(pkg => match(pkg))
  }
  if (state.depths?.length) {
    const ds = state.depths.map(Number)
    ps.push(pkg => ds.includes(pkg.depth))
  }
  if (state.sourceType === 'prod') {
    ps.push(pkg => pkg.isProd || pkg.workspace)
  }
  if (state.search.trim()) {
    const parsed = parseSearch(state.search)
    const p = (pkg: any) => {
      if (parsed.not.some(r => r.test(pkg.spec))) return false
      if (parsed.license.length && !parsed.license.some(r => r.test(pkg.license || ''))) return false
      if (parsed.author.length && !parsed.author.some(r => r.test(pkg.author || ''))) return false
      if (parsed.text && !pkg.spec.includes(parsed.text)) return false
      return true
    }
    ps.push(parsed.invert ? (pkg: any) => !p(pkg) : p)
  }
  return (pkg: any) => ps.every(fn => fn(pkg))
}

// ────────────── 5. exclude 独立路径 ──────────────
function buildExcludePredicate(state: State) {
  const matchExcludes = state.excludes?.length
    ? constructPackageFilters(state.excludes, 'some') : null
  return (pkg: any) => {
    if (state.excludeDts && pkg.module === 'dts') return true
    if (state.excludePrivate && pkg.private) return true
    if (matchExcludes && matchExcludes(pkg)) return true
    return false
  }
}

// ────────────── 6. demo：跑一遍 ──────────────
const packages = [
  { spec: 'vue@3.4.21',                name: 'vue',                version: '3.4.21',  depth: 1, isProd: true,  module: 'esm', license: 'MIT',         author: 'yyx990803', private: false },
  { spec: 'vue@2.7.16',                name: 'vue',                version: '2.7.16',  depth: 2, isProd: false, module: 'cjs', license: 'MIT',         author: 'yyx990803', private: false },
  { spec: '@vitejs/plugin-vue@5.0.0',  name: '@vitejs/plugin-vue', version: '5.0.0',   depth: 1, isProd: true,  module: 'cjs', license: 'MIT',         author: '@vitejs',   private: false },
  { spec: '@types/lodash@4.14.0',      name: '@types/lodash',      version: '4.14.0',  depth: 3, isProd: false, module: 'dts', license: 'MIT',         author: 'types',     private: false },
  { spec: 'lodash@4.17.21',            name: 'lodash',             version: '4.17.21', depth: 2, isProd: true,  module: 'cjs', license: 'Apache-2.0',  author: 'jdalton',   private: false },
  { spec: 'internal-tool@1.0.0',       name: 'internal-tool',      version: '1.0.0',   depth: 1, isProd: true,  module: 'esm', license: 'UNLICENSED',  author: 'me',        private: true  },
]

const state: State = {
  ...FILTERS_DEFAULT,
  search: 'license:MIT not:@vitejs',
  excludePrivate: true,
}

const selectPred = buildSelectPredicate(state)
const excludePred = buildExcludePredicate(state)

const result = packages.filter(p => !excludePred(p) && selectPred(p))
console.log('命中：')
result.forEach(p => console.log('  ' + p.spec))
```

跑出来你会看到：
- `@vitejs/plugin-vue` 被 `not:@vitejs` 排掉
- `lodash` 因为 license 是 `Apache-2.0` 不匹配 `/MIT/` 被排掉
- `internal-tool` 因为 `private: true` 被 exclude 干掉
- `@types/lodash` 因为 module 是 `dts` 被 `excludeDts` 干掉
- 最终留下 `vue@3.4.21` 和 `vue@2.7.16`

试着改 `state.search`、改 `state.focus`、改各种开关，看每次过滤结果怎么变。这是建立直觉最快的方式。

## 这套设计为什么这样做：四条关键权衡

到此原理就讲完了，剩下的篇幅留给「为什么」。这套机制里至少有四个非平凡的取舍，每一个都决定了它能用、但不能什么都做。本章机制比较丰富，所以展开四条；如果只看一条，看权衡 1。

### 权衡 1：把所有字段合到同一份 reactive state，换来全前端共用、代价是双向同步要防自激

**做了什么**：select / exclude / compare / option 四类字段，全部塞进 **同一个 reactive 对象** 里。没有任何字段在另外的 store 里。

**换来什么**：一处声明、全前端共用。组件 A 改 `state.focus`、组件 B 读 `state.focus`、URL 同步逻辑监听 `state.focus`——大家看到的是同一份数据，不存在「A 改了但 B 没刷新」的状态分裂问题。响应式系统会自动触发下游 computed 重算，链路一气呵成。这是个非常「隐形」的好处：你不会注意到它，因为从来没出过问题。

**代价是什么**：一旦引入「URL ↔ state」双向同步，就 **必须** 有一套「识别自己触发的更新」的机制（在 Vue 生态里通常叫 `ignorableWatch`）。否则 URL 变 → 写回 state → 触发 watch → 又写 URL → 又触发……无限循环。这个机制本身不难写，但它属于「合到一起的隐性税」——只要你想用一份 state，就得为双向同步付这个钱。而且调试这种循环时，初看很像「数据自己跳」，要反应过来才知道是自激。

如果当初选择拆成多份 store，URL 同步可以做得更朴素（每个 store 单向流到 URL），但 UI 上「改 A 字段同时影响 B 字段」这种联动就要写跨 store 的订阅。两害相权，作者选了合一起——因为字段联动是这个产品的高频诉求，跨字段联动失败是高发 bug。

### 权衡 2：把字符串规格预编译成闭包，换来 O(1) 运行期、代价是 state 一变就要重建谓词图

**做了什么**：用户在 focus 列表里加 `@vue/core@^3.0.0` 时，**不是**等到筛数据时再去 parse 这段字符串，而是 **马上** 把它编译成一个闭包，存进 computed 缓存。

**换来什么**：每个包在被判断时，只需要跑 `nameMatch.test(pkg.name) && satisfies(pkg.version, version)` 这两步——闭包里的常量（拆好的 name、编译好的 RegExp、版本字符串）都是预存好的，**没有重复 parse 的开销**。四千个包跑一遍，是一份纯函数调用，单帧能跑完。打个不严谨的比方：这就像把正则表达式 `compile` 一次之后反复 `exec`，而不是每次都重建正则。

**代价是什么**：state 一变（比如用户从 focus 列表里删了一项），整张谓词图就得重建——所有 select 字段重新编译一遍。这套机制是靠响应式 `computed` 缓存兜底的：只有真正被读取到的、且依赖变化的 computed 才会重算，没变的字段对应的闭包其实没动。但这个兜底的前提是「你的字段拆得够细」——如果你把所有字段塞到一个 computed 里，那只要任何字段变，整张图都会重建。

换句话说：**这个设计押注「字段变化稀疏」**。如果用户操作是「一次只改一两个字段」（绝大多数 GUI 操作就是这种模式），缓存命中率极高，几乎零重建。但如果操作模式是「每秒改十几个字段同时改」（比如脚本化驱动 UI），这套就开始退化。所幸这个产品没那种场景。

### 权衡 3：搜索框用 field:value DSL 而非结构化表单，换来一行查询可粘贴分享、代价是新手要学语法且写错不报错

**做了什么**：搜索框不只是一个 `<input>`，它是一个迷你查询语言解析器。`license:MIT author:yyx990803` 这种写法被解析成结构化条件。

**换来什么**：高级用户一行写完多维查询；这行字符串 **天然就是可分享的**——粘贴到 URL 里、贴到 issue 里、写进文档里都行。跟 URL 序列化几乎零摩擦（甚至直接当 URL hash 都可以）。如果是结构化表单，分享时得序列化成 JSON 或者 URL 参数数组，反序列化又是一摊事。DSL 还有一个隐性好处：用户可以「部分写」——只写 `license:MIT` 不写别的，比挨个勾选框更快。

**代价是什么**：

1. **新手要学语法**。第一次看到 `not:@vitejs` 的用户不知道这是干嘛的——schema 里没有 `not` 字段，它是个 DSL 关键字。文档得专门讲。
2. **未识别字段静默退化为子串**。用户写了 `licnese:MIT`（拼错），系统不会报错——它会把 `licnese:MIT` 整段当成 text 子串去匹配 `pkg.spec`，结果什么也搜不到。用户会以为「没匹配的包」，实际上是「字段名拼错了」。这是一个真实的可用性陷阱，没有错误反馈兜底。
3. **跟结构化字段的语义有重叠但不一致**。比如「sourceType」既能通过下拉框选，理论上也能写成 `sourceType:prod`——但搜索 DSL 里其实 **只支持** `not` / `license` / `author` 三个字段，其它字段下拉框里的值没法在 DSL 里表达。这种「部分字段在 DSL 里能写、部分不能」的不对称，是工程上的折中留下的疤：高频字段做成 DSL 关键字，低频字段走表单就够。

如果当初选择把所有字段都做成 DSL 关键字，那解析器会复杂得多（要支持数组、嵌套、boolean 表达式），但好处是「DSL 完全替代表单」。作者选了「DSL 只覆盖高频三字段，其它走表单」，是承认了「这三种查询最高频、最值得做成一行」。

### 权衡 4：声明式 schema 集中登记，换来 reset / activated / URL 三处自动派生、代价是 schema 之外的字段会"看不见"

**做了什么**：所有字段先登记到 `FILTERS_SCHEMA`，下游的 reset 集合、activated 高亮列表、URL 序列化键都从 schema **派生** 而非手写。

**换来什么**：新增字段时 **只改 schema 一处**，下游全部跟上。不会出现「加了个字段，但 reset 按钮忘了把它清掉」这种典型 bug。schema 是单一真相源——这是工程上非常有价值的一种约束：把「字段定义」和「字段使用」用一份声明粘到一起，避免散落。

**代价是什么**：

1. **schema 之外散落的字段会被「看不见」**。如果你图省事，在某处直接定义了一个 `state.foo = 'bar'`（没登记到 schema），那它 **不参与 reset**、**不出现在 activated 列表**、**不会被序列化到 URL**。这种字段会在「重置」时残留、在「分享链接」时丢失——一种很隐蔽的状态污染。
2. **字段归类必须二选一/四选一**。如果一个字段的语义跨类（比如既是 select 又影响 exclude），强行归到一类会让另一类的自动化逻辑漏掉它。设计字段时得提前想清楚归类，不能脚踩两只船。
3. **schema 类型设计要严格**。每条字段必须挂 `type` / `default` / `category` 三元，少一个就编译报错——这是好事（约束），但也意味着「快速加个临时字段」的成本变高了，每加一个都得正名。

这个权衡的本质是：**用 schema 的约束换自动化的派生**。你愿意被 schema 约束（每个字段都要正名），就能享受它带来的三处自动化；你想绕开 schema 自由发挥，就要自己维护那三件事。作者选了前者——这套字段集合相对稳定（不会每周加新字段），约束的痛感很低，自动化的收益很高。

## 一句话总结

这套过滤器的设计核心可以浓缩成一句：**把多维筛选问题，统一塌缩成「一份 schema → 一份 state → 一个 (pkg)=>bool」**。

schema 是公共留言板（字段集中登记）；state 是这块留言板的当前快照；最终所有条件塌缩成一个针对包的判断函数。中间用「预编译闭包」让运行期 O(1)、用「谓词数组 + every 折叠」表达多维 AND、用「搜索 DSL」给高级用户一行查询的能力。每一步都是为「即时反馈」和「可分享」这两个产品诉求服务的。

读完这一章，你应该能回答：
- 为什么字符串规格要先编译成闭包？（避免重复 parse，对每个包只跑预存判断）
- 为什么 select 和 exclude 要走两套谓词？（语义不同：全命中才留 vs 任一命中就丢，合在一起容易写错）
- 为什么搜索 DSL 不报错？（宽容退化，未识别字段静默退化为子串，避免打断用户）
- 为什么所有字段都要登记到 schema？（让 reset / activated / URL 三处自动派生，避免字段散落后漏处理）

带着这套心智模型去读上游的 payload 级联和 URL 同步，你会发现它们都是在这套谓词机制之上做工程封装——核心已经在这里定死了。