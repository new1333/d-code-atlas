# 文件路由：约定与前缀树

> 本章属于 system 层。前置：路由匹配表：从配置到 matched 链。
> 学完你能：用一句话讲清"文件路由如何用前缀树承载父子拓扑、用按来源分桶的属性表让多来源共存而非互斥"。

## 1. 为什么需要它

上一章把"类型安全路由"推到了编译期——靠模块增强把路由名表注入 TS，让 `router.push({ name: '...' })` 在写代码时就能查得到。但这份被推导的"路由名清单"本身从哪来？如果还是手写一份 `routes` 配置数组、再手抄一遍到类型层，迟早会漏——配置漏写一条，类型推导再准也救不回来。

让路由配置自己从文件系统里长出来，就是这一章要解决的问题。

想象一个管理后台：百来个页面、三四层嵌套是常态。每加一个页面，要在 `routes` 数组里找到正确的父节点、嵌进去、起一个 `name`、配上 `meta`、可能还要补个 `alias`——加一个页面同时动三四样东西。文件路由把这件事反转过来：在 `pages/` 下新建一个 `.vue` 文件，路由就有了。零配置的便利，在这里是质的提升。

但纯约定（只认文件名）很快会撞墙：这条路由想改个 `path`、加个别名、给个 `meta`、条件性删掉——文件名表达不了。传统做法是直接 eject 整套方案、自己写配置。这就把"零配置"和"可定制"放在了对立面：要么吃下约定的天花板，要么把约定整个扔掉。

这一章讲的机制是为了化解这对矛盾：既不让用户为每条路由手写配置，又不让约定成为天花板。从"丢个文件进来就生效"到"我要精细控制这一条路由"之间，应该有一条不必 eject 的平滑梯度。

> 关于范围：前置章「路由匹配表：从配置到 matched 链」讲的是**下游**——它把一份 `routes` 配置数组递归编译成 matcher 树、处理别名展开、按 score 排序。本章是它的**上游**：把**文件系统**编译成那份 `routes` 数组，再喂给匹配表。两个"树"不在同一层面：本章的前缀树是构建期的中间产物，匹配表里的 matcher 树是运行期匹配用的。

## 2. 核心思想

把路由的"父子拓扑"和"属性归属"拆成正交两层——结构交给前缀树（文件名即声明），属性交给按来源分桶的深合并表（约定只是起点，不是天花板）。

## 3. 心智模型

整套机制可以拆成两块来看。

**结构层——前缀树承载拓扑**

每个文件被剥掉页面根前缀、去掉扩展名后得到一个"路由路径"，比如 `pages/users/[id].vue` 的路由路径是 `users/[id]`。这个路径按 `/` 切段，每段一个节点，逐段下沉，叶子挂组件文件。

像查字典一样：根节点是 `pages/`，下面挂着 `users` 这一段；`users` 下又挂着 `index` 和 `[id]` 两个段；`index` 和 `[id]` 是叶子，分别挂着 `users/index.vue` 和 `users/[id].vue` 两个组件文件。`pages/users/index.vue` 这条路由的父子链 `users → index` 由树结构自动表达出来了。

每个节点还维护一张 `filePath → node` 的反查表，给 watcher 用：文件改了，要 O(1) 找到对应节点去改它的属性。

**属性层——按来源分桶的覆盖表**

每个节点除了挂组件，内部还有一张 `_overrides: Map<来源标识, 覆盖块>`。来源标识大致有三种：

- **约定**（`CONVENTION`）：从文件名约定推出来的部分，比如 `[id]` 段形态是 `:id`、`_parent` 设 `name:false` 不单独匹配。
- **文件来源**（以 `filePath` 为 key）：从文件内容抽出来的，包括 `<route>` 路由块和 `definePage` 编译宏的字段。
- **钩子来源**（`EDITS`）：用户写的 `extendRoute` 钩子修改的字段，通过可编辑节点写入。

各来源各占一桶，互不覆盖地并存。约定桶永远最先、钩子桶永远最后、各文件来源按字典序排中间。读取时按这个顺序 `reduce` 逐层深合并，所以"约定是起点，钩子永远是最终逃生舱"。

**合并语义按字段分策略**——这是另一个关键设计：合并不是简单的"后者覆盖前者"，每种字段有自己的合并语义：

- `alias` 数组拼接（多来源都能贡献别名）
- `meta` 深合并（嵌套对象不丢字段）
- `params` 按 path/query 分组合并
- 其它字段（`name`、`path` 等）后者胜，但 `falsy` 不覆盖（`b[key] ?? a[key]`）

这套心智可以一句话讲清：**结构来自树，属性来自合并；合并不是覆盖，是按字段约定好的合流**。

## 4. 关键权衡

### 用前缀树而非扁平数组承载拓扑

第一个选择是用什么数据结构表达路由集合。

最直观的做法是一份扁平的 `routes` 数组，和手写配置一模一样，只是从文件生成。但路由本质上是**树性的**：父子关系、嵌套视图、参数沿父链累积、group 文件夹折叠路径，所有这些都依赖于"谁是谁的子"。扁平数组下，每次插入都得扫一遍数组找父节点，改的时候还得额外维护一张 parent 指针表。

用前缀树（每个节点持有 `children: Map<string, TreeNode>`，按 `/` 递归切分逐段下沉）换来的是：**嵌套关系、parent 链、参数累积、group 折叠全部免费成立**。新增一条 `users/[id]/edit` 不需要"找到 users 节点再嵌进去"，沿 `users → [id] → edit` 自然下沉就到了。

代价是增删要按 `/` 递归切分、删空节点要向上回溯清理（不能留空目录污染树）、遍历要走 DFS 而非直接 `for`。但这些都是局部、可预测的构建期开销——运行期路由器拿到的还是一份干净的 `routes` 数组。

**本质矛盾**：路由的"声明形式"（文件路径字符串）是线性的，但路由的"含义"（嵌套、参数继承）是树性的。前缀树这个选择，就是承认后者——把声明形式编译成与含义同构的数据结构，后续所有"按父子关系做事"的逻辑都不再需要额外拼接。

### 按来源分桶，让多来源共存而非互斥

第二个选择是属性怎么存。最简单的做法是"写时合并"——每个来源改完直接覆盖到节点的单一字段表里。简单、读起来也快。

但这个做法隐含的语义是"先来后到 / 后来居上"。一旦选了它，就回答不了一个要命的问题：**如果文件名约定、`<route>` 块、`definePage` 宏、扩展钩子都给同一条路由贡献了不同字段，谁覆盖谁、谁的字段被抹掉了？**

选择"按来源分桶 + 读时排序深合并"换来的是：**四个来源可以同时向同一条路由贡献不同字段，互不抹掉**。约定贡献 `path: ':id'`、文件里的 `definePage` 贡献 `meta: { auth: true }`、扩展钩子贡献 `alias: ['/u/:id']`——三者在各自桶里各占一格，读取时合流成一条完整路由。`<route>` 块改 `meta.auth` 不会丢掉钩子加的 `alias`，钩子加 `alias` 也不会覆盖文件里的 `path`。

代价有两个：一是每次读属性都要重新排序 + reduce 深合并（源码留有 perf TODO，暗示这是已知开销）；二是"合并"必须按字段逐一定义语义——`alias` 拼接、`meta` 深合并、`name` 后者胜、`params` 分组……每种字段的合流规则都要单独写、单独想清楚，一处疏漏就会丢字段。

**本质矛盾**：约定想强（保证一致性）、文件想就近声明（开发者想在该路由的文件里写它的 meta）、钩子想兜底（架构师想在最后一关统一加权限）——三种角色都想"拥有"同一条路由的字段。按来源分桶承认了这种多元所有权，用深合并把"谁说了算"从"先来后到"换成"按字段合流"。

### 字符级状态机把文件名解析成路由形态

第三个选择是文件名的解析方式。文件名只是字符串，但路由段的语义有多种：静态（`users`）、动态参数（`[id]` → `:id`）、可选参数（`[[id]]`）、带类型（`[id=parser]`）、通配（`[...path]`）、不贡献路径的 group（`(group)`）、点嵌套（`a.b` → `a/b`）。

最简单的做法是几条 if/else 加字符串切分。但很快会陷入"括号嵌套怎么处理"、"通配前要不要斜杠"、"hex 转义如何识别"这类边界地狱。

选择"字符级状态机"换来的是**一套文法统一表达所有形态**：`[id]` / `[[id]]` / `[id=parser]` / `[...path]` / `[x+HH]` / `.` 都在同一台状态机里走完。每种形态对应一个明确的状态分支，状态机的确定性让边界情况（如可选参数前的斜杠要移入非捕获组）变成可分析、可测试的转换规则，而不是散落在各处的 ad-hoc 判断。

代价是状态机本身分支多、边界细，维护这份文法需要谨慎。但这是把复杂性**集中**到一处，而非散落到所有路由上。

**本质矛盾**：文件名只能是一个字符串，但路由段的语义要表达多种（静态/动态/可选/通配/嵌套/类型化）。状态机把"字符串"和"语义"之间的多对一映射显式化、确定化。

### 约定打底，逃逸舱按层级叠

第四个选择是组织哲学：约定优先，每高一层都开一道逃逸舱。

- **约定**：文件名决定 path/name/段形态——零配置
- **`<route>` 块 / `definePage` 宏**：在文件内部就近声明 meta/alias/components——文件级定制
- **`extendRoute` 钩子**：构建期对每条路由可编程改写——架构级定制
- **`beforeWriteFiles` 钩子**：写文件前对整棵树最后一次扫——全局兜底

每层逃逸舱只覆盖它关心的字段，其余字段走下层的默认。换来的是**渐进式复杂度**——简单场景零配置、复杂场景逐级定制、全程不必 eject。

代价是：同一条路由的元数据可能散落在四处（文件名一段、文件内一块、钩子里又一段），调试时要追完所有来源才能拼出最终配置。配套的冲突检测（同名视图、重复路由）和明确的优先级规则是这套设计的必要补丁，没有它们，散落的元数据会变成隐性 bug 温床。

**本质矛盾**：约定想强（一致性、零配置）、但又必须可逃逸（应对真实业务的奇形怪状）。强行可定制（无约定）和强行约定（无逃逸）都会失败——这套设计选"约定打底、按层级开逃逸舱"，把矛盾化解成"何时使用哪一层"。

## 5. 最小原理演示

下面这段演示只演透两件事：**前缀树按 `/` 递归建树**，和**节点上的属性按来源分桶、读时排序深合并**。文件名状态机的全部分支、命名视图、HMR、watcher 全部省略。

```ts
// 来源标识：约定永远最前，钩子永远最后，文件来源字典序居中
const CONVENTION = Symbol('convention')
const EDITS = Symbol('edits')

// 按字段分策略的深合并
function mergeOverride(a: any, b: any): any {
  const out: any = { ...a }
  for (const key of Object.keys(b)) {
    if (key === 'alias') {
      out[key] = [].concat(a.alias || [], b.alias || [])  // 别名拼接
    } else if (key === 'meta') {
      out[key] = { ...(a.meta || {}), ...(b.meta || {}) } // meta 深合并
    } else {
      out[key] = b[key] ?? a[key]                          // 后者胜但 falsy 不覆盖
    }
  }
  return out
}

class TreeNode {
  children = new Map<string, TreeNode>()
  _overrides = new Map<symbol | string, any>()  // 按来源分桶的覆盖表
  components = new Map<string, string>()        // viewName -> filePath

  constructor(public segment: string, public parent: TreeNode | null) {}

  // routePath 已剥掉页面根前缀和扩展名；按 / 切段、逐段下沉、叶子挂组件
  insert(routePath: string, filePath: string) {
    const [head, ...tail] = routePath.split('/')
    if (head === '_parent' && tail.length === 0) {
      // _parent 约定：挂到当前节点而非新建子节点，且 name:false 不单独参与匹配
      this.components.set('default', filePath)
      this._overrides.set(CONVENTION, { name: false })
      return
    }
    if (!this.children.has(head)) {
      this.children.set(head, new TreeNode(head, this))
    }
    const child = this.children.get(head)!
    if (tail.length === 0) {
      child.components.set('default', filePath)
      // 约定桶：段形态（演示只处理两种约定）
      const param = head.match(/^\[(.+?)\]$/)
      const path = param ? `:${param[1]}` : (head === 'index' ? '' : head)
      child._overrides.set(CONVENTION, { path })
    } else {
      child.insert(tail.join('/'), filePath)
    }
  }

  // 读取时按固定优先级排序、reduce 逐层深合并
  get overrides(): any {
    return [...this._overrides.entries()]
      .sort(([a], [b]) => {
        if (a === CONVENTION) return -1   // 约定最前
        if (b === CONVENTION) return 1
        if (a === EDITS) return 1         // 钩子最后
        if (b === EDITS) return -1
        return a < b ? -1 : 1             // 文件来源之间字典序
      })
      .reduce((acc, [, block]) => mergeOverride(acc, block), {})
  }
}

const root = new TreeNode('', null)

// 三来源演示
root.insert('users/index', 'pages/users/index.vue')
root.insert('users/[id]',   'pages/users/[id].vue')

// 文件来源：<route> 块或 definePage 抽出来的字段，按 filePath 入桶
root.children.get('users')!.children.get('[id]')!
  ._overrides.set('pages/users/[id].vue', { meta: { auth: true } })

// 钩子来源：用户 extendRoute 写入（EDITS 永远最后，优先级最高）
root.children.get('users')!.children.get('[id]')!
  ._overrides.set(EDITS, { alias: ['/u/:id'] })

const idNode = root.children.get('users')!.children.get('[id]')!
console.log(idNode.overrides)
// { path: ':id', meta: { auth: true }, alias: ['/u/:id'] }
```

这段代码里每一行都对应上面某个原理点：

- `children = new Map()` + `insert` 按 `/` 切段递归：演的是"前缀树承载拓扑"
- `_overrides = new Map<来源, 覆盖>()`：演的是"按来源分桶"
- `sort` 里 `CONVENTION` / `EDITS` 的特殊处理：演的是"固定优先级排序"
- `mergeOverride` 按 `alias` / `meta` / 其它分策略：演的是"合并语义按字段定义"
- `_parent` 分支 + `name: false`：演的是"约定优先 + 逃逸舱"

## 6. 执行轨迹

把上面这段代码用具体输入走一遍。

**输入**：

- 文件 `pages/users/index.vue` → 路由路径 `users/index`
- 文件 `pages/users/[id].vue` → 路由路径 `users/[id]`
- `[id].vue` 文件内 `definePage({ meta: { auth: true } })`
- 扩展钩子：给 `[id]` 节点加 `alias: '/u/:id'`

**第 1 步：建树（结构层）**

`insert('users/index', 'pages/users/index.vue')`：

- 切段 `['users', 'index']`，根节点 children 没有 `users` → 新建 `users` 节点
- 下沉到 `users`，切段 `['index']`，children 没有 → 新建 `index` 节点
- tail 为空，挂组件 `pages/users/index.vue`，约定桶写 `{ path: '' }`（`index` 映射父路径）

`insert('users/[id]', 'pages/users/[id].vue')`：

- 沿已有的 `users` 节点下沉（不重复建）
- 新建 `[id]` 节点，挂组件 `pages/users/[id].vue`
- 约定桶匹配 `[id]` → 写 `{ path: ':id' }`

**第 2 步：写文件来源（属性层）**

读 `[id].vue` 文件内容，抽 `definePage` 得 `{ meta: { auth: true } }`，以 filePath 为 key 写入该节点桶。

此时 `[id]` 节点的 `_overrides` 有两桶：

- `CONVENTION` → `{ path: ':id' }`
- `'pages/users/[id].vue'` → `{ meta: { auth: true } }`

**第 3 步：写钩子来源**

用户的 `extendRoute` 拿到可编辑节点，调 `node.alias = ['/u/:id']`——这个 setter 把字段写入 `EDITS` 桶。

此时三桶齐：`CONVENTION`、`'pages/users/[id].vue'`、`EDITS`。

**第 4 步：读取时合并**

`idNode.overrides` getter 触发：

- 排序：`CONVENTION`（最前）→ `'pages/users/[id].vue'`（字典序居中）→ `EDITS`（最后）
- reduce：`{}` 合 `CONVENTION` 得 `{ path: ':id' }`；再合文件来源得 `{ path: ':id', meta: { auth: true } }`；再合 `EDITS`，`alias` 走拼接、`meta` 走深合并、`path` 钩子没写保留 `:id`，最终 `{ path: ':id', meta: { auth: true }, alias: ['/u/:id'] }`

**第 5 步：序列化为 routes 数组**

遍历树，对每个"有组件且 `name` 不为 false"的节点产出一条 `RouteRecordRaw`，沿 parent 链拼完整 `path`（`users` + `:id` → `/users/:id`）、累积 `components`、生成 `name`（按文件路径拼）。

最终交给前置章「路由匹配表」的，就是这样一份递归配置数组。

## 7. 教学简化说明

本章演示故意省略了：文件名状态机的全部边界（只演了 `[id]` 和 `index` 两种约定，实际还有 `[[opt]]` / `[id=parser]` / `[...wildcard]` / `(group)` / `.` 嵌套等多种）、命名视图（`@viewName` 后缀、`components` Map 多映射）、HMR 细节（虚拟模块热替换）、watcher 的节流参数（debounce 100ms + throttle 500ms）、dts/codegen 产物（详见下一章）、score 二维结构与节点正则生成（实验 resolver 用，详见对应章节）、paramParsers 目录扫描。

## 8. 小结

文件路由把"路由配置"从手写变成"文件系统 + 多来源属性"：结构上前缀树让父子拓扑、参数累积、group 折叠免费成立；属性上按来源分桶、读时排序深合并，让约定、文件内声明、扩展钩子各占一格而不互相抹掉。约定打底，钩子兜底，中间各层按字段合流——这是"零配置"与"可定制"能共存的根因。

紧邻下一章「导航期数据加载器」会把战场从"路由配置怎么来"转到"路由跳转时数据怎么来"——继续把一件事从组件树里抽出来、上提到导航管线。