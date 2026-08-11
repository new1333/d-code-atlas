# 过滤器与搜索：声明式 schema + 字段 DSL

> 本章属于 composite 层。前置：resolvePackage：把磁盘包变可读节点。
> 学完你能：用一句话讲清"为什么这套多维筛选要做成 schema 驱动 + 字符串编译成闭包 + 搜索 DSL 拆解"，以及它在交互即时反馈和 URL 可分享之间做的取舍。

## 1. 为什么需要它

上一章把磁盘上的包一个个变成了字段齐全的可读节点，name、version、license、authors、深度都长出来了。但几千个节点堆在一起，用户怎么找到自己关心的那十几个？

设想你在排查"为什么 bundle 这么大"。心里其实有几个并行的问句：是不是新装了 dev 依赖？license 合规吗？有没有重复版本？dts 没排除吗？回答任意一条都需要"按某个维度筛一下"，回答多条需要把筛子叠起来。

如果你是给这个产品写表单的产品经理，本能做法是给每个维度配一个控件——一个下拉选 modules、一个多选框选 license、一个文本框输入名字、几个勾选框控制 exclude。这种做法在工程上有三个无解的问题：

第一，控件之间彼此不知道对方存在。focus 选了一个包，搜索框的 "vite" 还在生效，列表到底按谁的来？没有统一的真相源就只能每个控件各自触发各自的事件，叠出来的行为靠运气。

第二，"我现在筛了啥"这件事不能从控件反推。用户点了一堆开关，回头看自己开了什么、怎么分享给同事，只能挨个截图。要支持 URL 分享、reset、激活态高亮，得有人维护一份"哪些字段算筛选状态"的清单，跟字段的真实定义两份对不齐就出 bug。

第三，"输入 `vite@^1.0.0` 想匹配版本范围内的 vite" 这种需求做不成。表单控件天然只能给一个固定值，没法表达版本范围或通配符。要想支持，得给每个字段单独写一个 mini 解析器。

多维筛选的统一组合、筛选状态的统一描述、复杂规格的统一表达，三件事压在一起，靠 if-else 链拼不出来。需要把整套筛选机制抽象到"声明 + 编译 + 组合"三层。

## 2. 核心思想

换一种姿势：让所有筛选控件都不再 emit 事件、不再持有自己的状态，而是把"我想留下什么"翻译成一个函数。focus 选了 vite 就翻译成 `pkg => pkg.name === 'vite'`；search 输入了 'MIT' 就翻译成 `pkg => pkg.license === 'MIT'`。

这些函数签名全部一致：`(pkg) => boolean`。整张过滤器就是把这些函数收集起来、用 AND 折叠成一个大函数的过程。控件不再是"事件源"，而是"谓词参数"。

这个抽象一旦立住，"多维组合"、"即时反馈"、"URL 可分享"就成了同一个机制的不同侧面：组合就是函数的 AND 折叠；即时反馈就是响应式缓存加谓词重建；URL 分享就是状态的反序列化。

## 3. 心智模型

整体六步走，从字段声明一直到上游筛数据：

```
schema 声明字段 → reactive state 持值 → 用户改动 state
                                          ↓
            ┌─────────────────────────────┴───┐
            ↓                                  ↓
   select 类条件 → 编译成谓词数组        exclude 类条件 → 走独立分支
            ↓                                  ↓
       predicates.every(...)             四条 boolean 开关 + excludes 谓词
            ↓                                  ↓
            └─────────────► 上游 payload：用两条谓词共同筛原始数据
```

字段被分成三类（compare 一类本章不演）：

- **select 类**：focus、why、search、depths、sourceType、clusters、modules，这些是"必须全部通过才留下"的条件。
- **exclude 类**：excludeDts、excludeDev、excludeOptional、excludePrivate、excludes，这些是"任一命中就丢掉"的条件。
- **option 类**：clustersMode 这种调节 select 行为的开关。

为什么 select 和 exclude 走两套谓词而不是统一一条？语义不同，混淆会出错。一条"丢掉 dev 包"的 exclude 不能写成"留下非 dev 包"的 select，因为前者对没有 flatClusters 字段的包该默认丢，后者该默认留。

字段值有三类形状：

- 字符串：search、sourceType（值如 'prod'/'dev'）。
- 数组：focus、why、excludes、depths、clusters，元素是字符串规格（如 `vite@^1.0.0`、`*eslint*`）或原始值。
- 布尔：excludeDts 等开关。

数组字段最有意思的地方是：元素是个**字符串规格**，`@foo/bar@^1.0.0` 表示"任何符合 ^1.0.0 范围的 @foo/bar"、`*eslint*` 表示"任何 name 含 eslint 的包"。这些字符串不是直接拿去 `===` 比较的，而是被**编译成闭包**。

## 4. 关键权衡

### schema 当唯一真相源，reset 与 URL 序列化都从它派生

字段、类型、默认值、归类四元组集中登记在一份 schema 里。下游所有需要"枚举字段"的地方——重置、激活态高亮、URL 序列化、防抖输入——都从这一份派生，没有任何地方硬编码"我有 N 个字段"。

换来：新增一个筛选维度只要改 schema 一处，reset、URL、activated 自动跟上，不会出现"加了字段但 reset 没生效"这种 bug。

代价：散落在 schema 之外的字段不参与这套机制。如果某天有人图省事在某个组件里写了个旁路筛选状态，它就不会进 reset、不会进 URL、用户分享链接时丢。schema 的"集中"是用"配额式纪律"换的。

本质矛盾是**字段元数据要集中可枚举**与**字段定义天然散落在使用点**这两件事在打架。这套设计把所有筛选字段强行登记到一份表里，是用配额换一致性——你要新增字段，必须先到表里挂号。

### 把字符串规格预编译成闭包

focus、why、excludes 里的字符串规格不是每次判断时现 parse 的。状态一变，就把每个字符串编译成一个 `(pkg) => boolean` 闭包：name 里的 `*` 转成 RegExp、`@` 拆出 name 和 version、版本号交给 semver satisfies。

换来：判断每个包时只调用预编译好的函数，不再重复 parse。对一个 5000 节点的图、每秒可能跑几十次筛选来说，这是把 N×M 的 parse 成本降到 M 次（M 是筛选条件数，远小于 N）。

代价：状态每次变化都要重建整个谓词图。focus 加一项、excludes 减一项、search 改一个字，理论上都要重新编译所有规格。要不是靠响应式 computed 把"无变化的字段"短路掉，状态改动会爆。

本质矛盾是**判断逻辑要按数据定制**与**判断本身要跑成千上万次**。把定制推到编译期、把执行留给运行期，这是把"解释执行"换成"编译执行"的经典手法，跟正则预编译、SQL prepare statement 是同一种取舍。

### 搜索框用 field:value 前缀 DSL，而非结构化表单

搜索框接受的不是一个值，而是 `vite not:@vitejs license:MIT author:yyx990803` 这样的一行字符串。一条全局正则一次性把所有 `field:value` 段抠出来分字段归类（not→排除、license→许可、author→作者），剩余文本当子串匹配。

换来：高级用户一行写完多维查询，可以粘贴、可以分享、天然能塞进 URL hash，跟"可分享查询"无缝对接。结构化表单永远做不到 `not:@vitejs license:MIT author:yyx990803` 这种密度。

代价有两面。一是新手要学语法，看到搜索框里的冒号不知道什么意思，得查文档。二是 DSL 对错误的反馈很糟糕。拼错字段名（比如写成 `licence:`）会**静默退化**为普通子串，没有报错。未识别的字段直接被忽略，整段 `licence:MIT` 留在原文里当普通子串去匹配 spec。这是有意为之的"宽容退化"，比报错友好，但调试时容易让人怀疑人生。

本质矛盾是**查询要表达力强**与**输入要快**。表单把表达力给了 UI 控件、把输入速度交给了鼠标点击；DSL 反过来，把表达力给了语法密度、把输入速度交给了键盘。代价就是 DSL 必须容忍模糊输入，既不能像 SQL 那样严格校验报错（用户体验差），也不能完全放弃多维（退化成纯子串）。

### select / exclude / compare 三类合到同一份响应式 state

所有筛选字段不分语义都住进同一个 reactive 对象。改 focus 数组也好、改 excludeDts 布尔也好、改 compareA 也好，都是 mutate 同一个 state。整条响应式链路（state → computed 谓词 → 上游 payload → 渲染）都从这一个入口触发。

换来：一处声明、全前端共用、改一处即触发整条响应式链。任何一个上游 consumer 都不需要知道"我现在订阅的是哪一类筛选"，因为它们都来自同一个 state。

代价是 URL ↔ state 双向同步要做**防自激**，监听器要识别"这是我自己触发的更新，不要再回流"。否则 URL 变化 → 写回 state → state 变化 → 写回 URL → URL 变化，死循环。这就是为什么后续章节会引入 `ignorableWatch` 这类工具。

本质矛盾是**多类筛选语义不同**与**状态更新要统一驱动渲染**。语义差异（"任一命中丢" vs "全部命中留" vs "AB 两组对比"）下沉到谓词层面去处理，reactive state 只管"统一存放所有可变字段"。这是把语义差异和状态容器解耦，代价是双向同步需要额外机制兜底。

## 5. 最小原理演示

下面这段代码**只演透核心思想**：schema 派生默认值、字符串规格编译成闭包、搜索 DSL 拆解、谓词数组折叠成总判断。其它一切（Vue 组件、URL 序列化、debounce、图闭包查询、具体业务字段）都故意省略。

```ts
// 字段声明：每条登记 type / default / category 三元
const FILTERS_SCHEMA = {
  search:     { type: String,  default: '',    category: 'select'  },
  focus:      { type: Array,   default: null,  category: 'select'  },
  excludes:   { type: Array,   default: null,  category: 'exclude' },
  excludeDts: { type: Boolean, default: true,  category: 'exclude' },
} as const

// 默认值从 schema 自动派生；reset、activated、URL 序列化都只看它
const DEFAULTS = Object.fromEntries(
  Object.entries(FILTERS_SCHEMA).map(([k, v]) => [k, v.default]),
)

// 字符串规格编译成 O(1) 闭包：vite@^1.0.0 / *eslint* / vite
function makePackagePredicate(spec: string) {
  const [pkgName, versionSpec = '*'] = spec.split(/\b@/)
  const namePattern = pkgName.includes('*')
    ? new RegExp('^' + [...pkgName].map(c =>
        c === '*' ? '.*' : c === '.' ? '\\.' : c).join('') + '$')
    : pkgName
  return (pkg: { name: string; version: string }) => {
    const nameOk = namePattern instanceof RegExp
      ? namePattern.test(pkg.name)
      : pkg.name === pkgName
    // 教学简化：跳过 semver satisfies
    const versionOk = versionSpec === '*' || pkg.version === versionSpec
    return nameOk && versionOk
  }
}

// 多条规格 + mode → 单个组合谓词
function combinePredicates(
  specs: (string | ((p: any) => boolean))[],
  mode: 'some' | 'every',
) {
  const preds = specs.map(s =>
    typeof s === 'string' ? makePackagePredicate(s) : s)
  return (pkg: any) =>
    mode === 'some'
      ? preds.some(p => p(pkg))
      : preds.every(p => p(pkg))
}

// 搜索 DSL：一条全局正则一次抓出所有 field:value，剩余文本当子串
const RE_FIELDS = /\b(\w+):("[^"]*"|'[^']*'|`[^`]*`|\S*)/g

function parseSearch(input: string) {
  let text = input
  const fields: Record<string, RegExp[]> = {}
  const removal: [number, number][] = []

  for (const match of text.matchAll(RE_FIELDS)) {
    const field = match[1]
    let value = match[2]
    // 未识别字段直接跳过，整段留在原文当子串
    if (!['not', 'license', 'author'].includes(field)) continue
    if (/^["'`].*["'`]$/.test(value)) value = value.slice(1, -1)
    ;(fields[field] ||= []).push(new RegExp(value, 'gi'))
    removal.push([match.index!, match.index! + match[0].length])
  }
  // 倒序裁掉已识别字段，剩余按子串匹配
  for (const [s, e] of removal.sort((a, b) => b[0] - a[0]))
    text = text.slice(0, s) + text.slice(e)
  return { text: text.replace(/\s+/g, ' ').trim(), fields }
}

// select 类条件收集到谓词数组，再 .every() 折叠成总谓词
function buildSelectPredicate(
  state: any,
  parsed: ReturnType<typeof parseSearch>,
) {
  const predicates: ((p: any) => boolean)[] = []

  // 数组类条件预编译成单个谓词
  if (state.focus?.length)
    predicates.push(combinePredicates(state.focus, 'some'))

  // 搜索词也编译成一条谓词，混进同一个数组
  if (parsed.text || Object.keys(parsed.fields).length) {
    predicates.push((pkg: any) => {
      if (parsed.fields.not?.some(re => re.test(pkg.spec))) return false
      if (parsed.fields.license
          && !parsed.fields.license.some(re => re.test(pkg.license)))
        return false
      if (parsed.fields.author
          && !pkg.authors?.some((a: any) =>
              parsed.fields.author.some(re => re.test(a.github || a.name))))
        return false
      if (parsed.text && !pkg.spec.includes(parsed.text)) return false
      return true
    })
  }

  // 所有谓词 AND 折叠
  return (pkg: any) => predicates.every(fn => fn(pkg))
}

// 演示数据：四个包
const pkgs = [
  { name: 'vite', version: '5.0.0', spec: 'vite@5.0.0',
    license: 'MIT', authors: [{ type: 'github', github: 'yyx990803' }] },
  { name: '@vitejs/plugin-vue', version: '5.0.0', spec: '@vitejs/plugin-vue@5.0.0',
    license: 'MIT', authors: [{ type: 'github', github: 'yyx990803' }] },
  { name: 'eslint', version: '8.50.0', spec: 'eslint@8.50.0',
    license: 'MIT', authors: [{ type: 'github', github: 'nzakas' }] },
  { name: 'typescript', version: '5.2.2', spec: 'typescript@5.2.2',
    license: 'Apache-2.0', authors: [{ type: 'github', github: 'typescript-bot' }] },
]

// 跑一遍：focus=['vite'] 配合搜索 'license:MIT not:typescript'
const state = { focus: ['vite'] }
const parsed = parseSearch('license:MIT not:typescript')
const predicate = buildSelectPredicate(state, parsed)

console.log(pkgs.filter(predicate).map(p => p.spec))
// → ['vite@5.0.0']
```

跑出来只剩 vite。`vite` 通过 focus 谓词（name 相等、version `*` 任意），又通过搜索谓词（license 是 MIT、spec 不含 typescript）。其它的：`@vitejs/plugin-vue` 与 `eslint` 虽然 license 也匹配，但 focus 谓词不通过；`typescript` 直接被 `not:typescript` 排掉。

## 6. 执行轨迹

跟着用户在搜索框输入 `vite not:@vitejs license:MIT author:yyx990803` 走一遍，看状态和谓词怎么变。

**初始状态**：搜索框为空，state.search = ''。`filterSelectPredicate` 是一个空谓词数组折叠出的恒真函数，所有包都通过。

**用户敲下整行**：state.search 变成 `'vite not:@vitejs license:MIT author:yyx990803'`。useDebounce 把这个变化推迟 200ms，避免每按一键就重建整张谓词图。

**200ms 后 debounce 触发**：`searchParsed` computed 重新求值，parseSearch 跑一遍：

- 全局正则 `\b(\w+):(...)` 一次扫过整行，命中三段：`not:@vitejs`、`license:MIT`、`author:yyx990803`。
- 字段分流：`@vitejs` → not 数组（编译成 RegExp）、`MIT` → license 数组、`yyx990803` → author 数组。
- 三段按倒序从原文裁掉，剩余 `vite` 折叠多空格、trim，作为 text 子串。

parsed 最终是 `{ text: 'vite', not: [/@vitejs/gi], license: [/MIT/gi], author: [/yyx990803/gi] }`。

**谓词重建**：`filterSelectPredicate` 重新求值，把搜索谓词 push 进 predicates 数组。搜索谓词对每个包做四件事：

1. spec 是否匹配任一 not 正则？匹配则丢。
2. license 是否匹配任一 license 正则？都不匹配则丢。
3. authors 是否任一匹配 author 正则？都不匹配则丢。
4. spec 是否含 text 子串？不含则丢。

四关全过才留下。

**对四个测试包逐个走**：

- `vite@5.0.0`：spec 不含 @vitejs、license=MIT 匹配、authors 含 yyx990803、spec 含 'vite'，通过。
- `@vitejs/plugin-vue@5.0.0`：spec 含 @vitejs，第一关就被 not 丢掉。
- `eslint@8.50.0`：author 是 nzakas，第三关失败。
- `typescript@5.2.2`：license 是 Apache-2.0，第二关失败。

**渲染**：上游 payload computed 拿到新谓词，重新筛 rawPayload，把过滤后的节点交给视图层。整个过程从敲完键盘到屏幕刷新，对用户来说是"瞬时"。

## 7. 教学简化说明

本章演示故意省略了：Vue 组件外壳与 reactive 集成、URL 序列化与反序列化、debounce 时机、图闭包查询（focus 扩展到 flatDependents、why 扩展到 flatDependencies，这部分依赖前置章节的依赖图物化）、exclude 类谓词的独立分支、`!` 前缀触发整条谓词取反、createToggle 处理数组增删、activated 用 isDeepEqual 与默认值比对、所有具体业务字段（modules/depths/clusters 等）。这些都是工程层细节，原理演示不需要它们。

## 8. 小结

这一章把"判断命中"抽象成了一个可组合的函数值：schema 当真相源、字符串规格编译成闭包、搜索 DSL 拆多维条件、谓词数组折叠成总判断。改一个开关 → 重建一组谓词 → 上游瞬时刷新，这是声明式筛选与响应式凑在一起的化学反应。

下一章会切回数据视角：用同一份 PackageNode 数据，按 depName 聚合、用 semver 范围判定 migrated/behind、按 consumer 分组，算出"该升哪些依赖"的 actionable 列表。
