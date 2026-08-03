# 过滤器与搜索：声明式 schema + 字段 DSL · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：大型 monorepo 里依赖动辄几千个。用户要"找关注的子集"——按包名/版本范围、模块类型、来源(prod/dev)、依赖深度、被依赖关系、license、维护者、是否 dts/可选/私有/workspace……没有这套机制，要么写死一组互相不知道彼此存在的表单控件，要么退化成纯子串搜索把什么都匹配出来。

- **一句话核心思想**：**把"字段声明 + 字符串→闭包编译 + 谓词组合"三件套压成一份响应式状态，让任意筛选条件最终都坍缩成"一个 (pkg)=>bool"**。

- **设计动机（为什么需要它）**：解决"多维筛选 + 即时反馈 + 可分享查询"三件事在工程上无法用一条 if-else 链表达的问题。声明式 schema 让字段、默认值、归类集中可枚举；构造式谓词把字符串规格（带版本范围、通配符）编译成 O(1) 闭包；搜索 DSL 让高级用户在一行里组合多维查询。三者合一，才让"改一个开关 → 列表瞬时刷新"成为可能。

- **关键权衡**：
  1. **声明式 schema 集中登记所有字段** → 换来 reset、activated 列表、URL 序列化都从同一份 schema 自动派生（不用手维护三份字段表）→ 代价是新增字段必须改 schema 否则不参与 reset/URL 同步，schema 之外散落的字段会被"看不见"。
  2. **把字符串规格（如 `name@^1.0.0`、`*eslint*`）编译成闭包** → 换来运行期对每个包只跑一遍预编译好的判断（无需重复 parse）→ 代价是状态每次变化都要重建谓词图（靠响应式 computed 缓存兜底，否则会爆）。
  3. **搜索框用 `field:value` 前缀 DSL（而非结构化表单）** → 换来高级用户一行写完多维查询、可粘贴分享、与 URL 天然兼容 → 代价是新手要学语法、未识别的前缀静默退化为普通文本（无报错反馈）。
  4. **select / exclude / compare 三类过滤合到同一份响应式状态** → 换来一处声明、全前端共用、改一处即触发整条响应式链路 → 代价是 URL ↔ state 双向同步需要"防自激"机制（监听器要识别"这是我自己触发的更新"），否则会震荡。

- **最小心智模型（6 步）**：
  1. 启动时从声明式 schema 派生默认值，初始化一份响应式 state
  2. 用户改动 state（toggle 数组项、输入搜索词、勾选 boolean 开关……）
  3. 选择类筛选：把 state 编译成一组谓词，按"全部必须通过"合并成总谓词
  4. 搜索词：先经过防抖，再用前缀正则拆出 `field:value` 字段条件与剩余文本
  5. 排除类筛选：走独立路径（语义不同：是"丢掉"而非"留下"）
  6. 上游 computed payload 用这两条谓词筛原始数据 → 渲染

- **最小原理演示**：
  - 应演示：一个几十行的"schema 驱动过滤器"——
    - 一份字段表（每条带 default 与 category 标签）
    - 一个 state（普通对象或 reactive 即可）
    - 一个"把 state 编译成总谓词"的函数（条件 → 谓词数组 → AND 折叠）
    - 一个"把搜索串拆出 not/license/author 前缀与剩余文本"的解析函数
    - 一个"把字符串规格（含通配符）编译成单包判断闭包"的函数
    - 一组 demo 数据 + 应用过滤 + 打印结果
  - 应故意省略：Vue 组件集成、URL 序列化、debounce、图闭包查询（依赖前置章节，本章不演）、所有具体业务字段（modules/depths/clusters 等）、UI 绑定、错误恢复。
  - **演示载体建议**：纯 TS/JS 脚本，可直接 `node`/`bun` 跑通。机制本身是纯函数与闭包，无宿主依赖——不要套 Vue 组件外壳，那样会绑死前端框架且看不出"编译-组合"的内核。本章属于"机制可独立演透"的典型，能跑最有助于读者建立直觉。

- **正文不宜展开的细节**：
  - 某条 default 值随部署形态（webcontainer 与否）变化——扯远到部署层
  - 数组字段默认 `null` 与 `[]` 的语义差异（影响"是否激活"判定）
  - 重置时为何要 `structuredClone(toRaw(...))`（避免 reactive proxy 污染默认值）
  - `!` 前缀触发 invert 的语义（对整条谓词取反，而非单字段）
  - 浅层 deepEqual 的限制（只支持原始值与一维数组，不支持嵌套对象）
  - `author:` 字段对 GitHub handle 与纯名字的两套匹配路径

- **推荐的一个执行轨迹例子**：
  输入：用户在搜索框输入 `vite not:@vitejs license:MIT author:yyx990803`
  → 解析阶段：抽出 not 条件=`@vitejs`、license 条件=`MIT`、author 条件=`yyx990803`，剩余 text=`vite`
  → 状态更新：search 触发 200ms 防抖，重算解析结果
  → 谓词重建：选择类谓词数组追加一条新谓词——对每包检查：标识串不匹配 `@vitejs`、license 匹配 `MIT`、authors 含 `yyx990803`、且标识串含子串 `vite`
  → 上游 payload 用新谓词筛原始数据 → 渲染过滤后列表

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **schema 即单一真相源**：每条字段登记 `type` / `default` / `category` 三元，下游 reset、activated、URL 序列化都从这一份派生。源码位置: packages/node-modules-inspector/src/shared/filters.ts:24-54

- **category 四类**：`select`（include 类，如 search/focus/why/sourceType/depths/clusters/modules）、`exclude`（排除规则，如 excludeDts/excludeDev/excludes 等）、`compare`（A/B 对比两组状态）、`option`（其它配置如 clustersMode）。源码位置: packages/node-modules-inspector/src/shared/filters.ts:27

- **默认值可与 payload 自带 config 合并**：在 schema 默认值之上展开 `rawPayload.config.defaultFilters`，允许后端 payload 携带推荐默认。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:17-22

- **state 是单一 reactive 对象**：所有筛选字段（不分 select/exclude/compare）都在同一份 reactive 里，外部直接 mutate 即触发响应式更新。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:34

- **search 走 200ms 防抖**：避免每按一键就重建整张谓词图。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:35

- **focus/why/excludes 三条数组都复用同一份"构造式谓词工厂"**：传字符串数组（如 `['@foo/bar@^1.0.0', '*eslint*']`）+ mode（这里都 `'some'` 即"任一匹配"），返回一个 `(pkg)=>bool`。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:38-40

- **字符串规格 → 闭包的编译规则**：用 `\b@` 拆出 name 与 version；name 含 `*` 转成 RegExp（`.` 被转义）；version `*` 表示任意、字串相等表示精确、否则用 `satisfies()` 做 semver 范围匹配；最终闭包对每个 pkg 跑 `isNameMatch && isVersionMatch`。源码位置: packages/node-modules-tools/src/utils/filter.ts:17-29

- **多条件构造器复用同一份编译器**：接收字符串数组（或自定义谓词）+ mode(`'some'|'every'`)，把每条编译后用 some/every 合并；允许数组里混入自定义函数谓词。源码位置: packages/node-modules-tools/src/utils/filter.ts:31-39

- **搜索 DSL 用单条全局正则匹配所有 `field:value`**：value 支持双引号/单引号/反引号包裹（含空格）或非空白串。源码位置: packages/node-modules-inspector/src/app/utils/search-parser.ts:9

- **DSL 只识别三个字段**：`not:`（排除）、`license:`（license 正则）、`author:`（作者正则）。其它字段走 `default: continue` 静默忽略——是"宽容退化"而非报错。源码位置: packages/node-modules-inspector/src/app/utils/search-parser.ts:44-59

- **匹配到的字段从原文裁掉，剩余作子串**：把所有 `field:value` 段按索引倒序裁掉，再把多空格折叠、trim，剩下的当 `text` 子串匹配 pkg.spec。源码位置: packages/node-modules-inspector/src/app/utils/search-parser.ts:64-71

- **`!` 前缀触发整条谓词取反**：搜索串开头加 `!`，最终谓词被 `pkg => !predicate(pkg)` 包裹。源码位置: packages/node-modules-inspector/src/app/utils/search-parser.ts:28-31，及 packages/node-modules-inspector/src/app/state/filters.ts:141-144

- **parseSearch 与 serializedSearch 互为逆运算**：后者用 `unescapeRegExp` 把 RegExp 还原回字符串，含空格的值加引号——保证 URL 双向同步不丢信息。源码位置: packages/node-modules-inspector/src/app/utils/search-parser.ts:88-109

- **filterSelectPredicate 的"谓词数组 + .every()"模式**：每个 select 类条件 push 一条谓词，最后 `predicates.every(fn => fn(pkg))` 做总判断——把"多维 AND"用数组折叠表达的标准模式。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:57-148

- **focus 与 why 不只直接匹配，还扩展到图闭包**：focus 扩展到 `flatDependents`（依赖此包的节点也保留），why 扩展到 `flatDependencies`（此包依赖的节点也保留）——把图查询融入筛选。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:60-67

- **excludes 走独立路径 filtersExcludePredicate**：与 select 类谓词分开，因为语义不同（"排除"而非"选择"）。它先跑 4 条 boolean 开关（dts/dev/optional/private），最后再跑 excludes 数组的构造式谓词。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:42-55

- **createToggle 处理数组状态的增删**：toggle=true 追加（去重），toggle=false 过滤掉；过滤后若为空则置 null（保持"未设置"语义而非空数组）。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:161-186

- **reset 按 category 分类**：select 与 exclude 各有 reset 按钮，遍历对应 keys 重置回默认（`structuredClone(toRaw(...))` 避免 reactive proxy 污染）。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:204-220

- **activated 用 isDeepEqual 与默认值比对**：列出"当前与默认不同的字段"——驱动 UI 上"已激活筛选"的高亮提示。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:210, 219

- **isDeepEqual 是浅层实现**：只支持原始值与一维数组的逐位比较，不支持嵌套对象——够用于本场景的筛选字段，但写正文时不要扩展到通用 deep equal。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:150-159

## 关键调用链

启动：
- `FILTERS_SCHEMA` → `objectMap` 派生 `FILTERS_DEFAULT` → 与 `rawPayload.config.defaultFilters` 合并 → `filtersDefault`(computed)
- `filtersDefault.value` → `reactive(...)` → `state`

状态读取（每条都 computed 缓存）：
- `state.search` → `useDebounce(200)` → `searchDebounced` → `parseSearch` → `searchParsed`
- `state.excludes` → `constructPackageFilters('some')` → `filtersExclude`
- `state.focus` → `constructPackageFilters('some')` → `filtersFocus`
- `state.why` → `constructPackageFilters('some')` → `filtersWhy`

谓词生成：
- `filterSelectPredicate`(computed)：收集 focus/why/depths/sourceType/clusters/modules/search 七条 select 类谓词 → `predicates.every(...)`
- `filtersExcludePredicate`(函数)：excludeDts/excludeDev/excludeOptional/excludePrivate 四条 boolean + excludes 谓词

用户操作：
- toggle：`createToggle('focus'|'why'|'excludes')` → mutate `state[key]` 数组
- reset：`filters.select.reset()` / `filters.exclude.reset()` → 用 `FILTER_KEYS_*` 遍历重置

下游消费（供上游 payload 章参考）：
- payload computed 用 `filterSelectPredicate` + `filtersExcludePredicate` 双谓词筛 `rawPayload`

源码位置: packages/node-modules-inspector/src/app/state/filters.ts:34-148

## 源码摘录（带行号，全文累计 30 行）

FilterSchema 接口与 schema 开头（packages/node-modules-inspector/src/shared/filters.ts:24-31，8 行）：

```ts
export interface FilterSchema<Type> {
  type: StringConstructor | ArrayConstructor | BooleanConstructor
  default: Type
  category: 'select' | 'exclude' | 'compare' | 'option'
}

export const FILTERS_SCHEMA: {
  [x in keyof FilterOptions]: FilterSchema<FilterOptions[x]>
```

字符串规格编译出的闭包主体（packages/node-modules-tools/src/utils/filter.ts:24-28，5 行）：

```ts
  return (pkg) => {
    const isNameMatch = nameMatch instanceof RegExp ? nameMatch.test(pkg.name) : pkg.name === name
    const isVersionMatch = version === '*' || pkg.version === version || satisfies(pkg.version, version)
    return isNameMatch && isVersionMatch
  }
```

搜索 DSL 的全局匹配正则（packages/node-modules-inspector/src/app/utils/search-parser.ts:9，1 行）：

```ts
const RE_COLLON_FIELDS = /\b(\w+):("[^"]*"|'[^']*'|`[^`]*`|\S*)/g
```

字段派发分支（packages/node-modules-inspector/src/app/utils/search-parser.ts:44-58，15 行）：

```ts
    switch (field) {
      case 'not':
        if (value)
          exclude.push(createRegExp(value, 'gi'))
        break
      case 'license':
        if (value)
          license.push(createRegExp(value, 'gi'))
        break
      case 'author':
        if (value)
          author.push(createRegExp(value, 'gi'))
        break
      default:
        continue
```

select 类总谓词的最终折叠（packages/node-modules-inspector/src/app/state/filters.ts:147，1 行）：

```ts
  return (pkg: PackageNode) => predicates.every(i => i(pkg))
```

## 易混淆 / 边界 / 推断

- **事实**：`excludeWorkspace` 的默认值依赖 `import.meta.env.BACKEND === 'webcontainer'`——webcontainer 模式下默认排除 workspace 包（演示场景不关心 monorepo 内部）。源码位置: packages/node-modules-inspector/src/shared/filters.ts:53

- **事实**：`focus` 与 `why` 在筛选时除直接匹配外，分别扩展到 `flatDependents` / `flatDependencies`，且文件里留有 `// TODO: flatDependents use filtersFocus` 注释，提示作者认为当前实现可改进（让 flatDependents 也走构造式谓词）。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:61

- **事实**：搜索 DSL 未识别的字段（如 `foo:bar`）会被 `continue` 忽略且不会被从原文裁掉，会作为子串进入 text 匹配。源码位置: packages/node-modules-inspector/src/app/utils/search-parser.ts:57-58

- **推断**：未识别字段被 `continue` 跳过、且其 `field:value` 段没被加入 removal 列表——是有意为之，避免误吞用户的合法子串，也省得报错。源码无显式注释佐证，仅从行为推断。

- **推断**：select / exclude 走两套不同谓词（而非统一一条），是因为语义不同——exclude 是"任一命中即丢"，select 是"全部命中才留"，混淆会出错。这条由代码组织反推，无显式注释。

- **事实**：`invert` (`!` 前缀) 是对整条谓词取反，而非单字段——`!a b` 等价于"非（匹配 a 且 匹配 b）"。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:141-144

- **未理解**：`clustersMode: 'and' | 'or'` 控制多个 cluster 标签的合并方式，默认 `'or'`——为何默认 or 而非 and？无注释，仅从默认值推断"用户更可能想看任意匹配的并集"。

- **边界**：`isDeepEqual` 只支持一维数组与原始值；若未来 filter state 出现嵌套对象（如 `{a: 1}`），activated 判定会失效。源码位置: packages/node-modules-inspector/src/app/state/filters.ts:150-159

- **边界**：`constructPackageFilter` 的通配符 `*` → `.*`，但不支持 `?` 单字符通配；name 中的 `.` 会被转义成 `\.`。源码位置: packages/node-modules-tools/src/utils/filter.ts:21

- **边界**：`constructPackageFilters` 允许 ranges 数组里混入"自定义函数谓词"，会跳过编译直接合入 some/every——给图查询等高级用法留了逃生口。源码位置: packages/node-modules-tools/src/utils/filter.ts:31-39