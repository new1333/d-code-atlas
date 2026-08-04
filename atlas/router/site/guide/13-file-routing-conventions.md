# 文件路由：约定与前缀树

想象你接手一个后台系统，左边菜单两百多个页面，路由还分三四层嵌套。你打开 `routes.ts`，迎面一个巨大的数组——每加一个页面，都得：在数组里塞一条记录、想清楚它挂在哪个父路由下、同步它的 `name`/`meta`/`alias`、再祈祷别和别的路由撞名。加一个页面改三处，删一个页面还得回来翻配置。

文件路由就是来终结这件事的：在 `pages/` 下新建一个 `.vue` 文件，它就自动变成一条路由；文件夹怎么嵌套，路由就怎么嵌套，配置一个字都不用写。这一步体验非常好。

但很快你会撞墙。产品说："这条 `users/[id]`，默认 path 我想改一下，叫 `users/:userId`"、"给它挂个别名 `/u/:id`"、"它的 `meta.auth` 要设成 `true`"。这些都不是文件名能表达的东西——如果方案只认文件名，你现在的唯一出路就是把整套文件路由 eject 掉，退回手写配置。

这一章讲的就是：怎么做到"简单场景零配置、复杂场景逐条精细控制、中间不用 eject"。靠的不是一套更聪明的文件名约定，而是两件更底层的东西——一棵**前缀树**，和一张**按来源分桶、按固定座次深合并**的属性表。

> 先对齐一个边界：这一章的终点是产出一份 `routes` 数组（每条含 `path`/`name`/`meta`/`alias`/`components`）。这份数组之后怎么被编译成可匹配的 matcher 表、别名怎么展开成额外的匹配项，是前置章「路由匹配表」已经讲透的，这里不重复。本章只盯一件事：**怎么从文件系统的拓扑，加上多个来源的元数据，生成那份配置数组**。

## 底层第一件：前缀树，让文件夹结构直接就是路由树

你建一个 `pages/users/[id].vue`，它在路由上理应是 `users` 的孩子。这个父子关系从哪来？答案朴素得有点反常识：**文件夹就告诉你了**。每段路径就是树的一层，每多一个 `/` 就往下沉一层，文件本身挂在叶子节点上。

说人话就是：你根本不用在路由配置里声明 `users` 是谁的父亲——树的形状本身就把这层关系装下来了。

建树的过程就是按 `/` 把路径切成段、逐段下沉，直到最后一段把组件挂上去：

```
路径 users/[id] 的切分与下沉：
root
 └─ users          （第一段，建/进入 users 节点）
     └─ [id]       （第二段，建/进入 [id] 节点 → 叶子，挂组件 pages/users/[id].vue）
```

这里有两个"看着像普通文件、其实有特殊语义"的约定，值得拎出来，因为它们都是靠树的结构免费实现的，不是额外开洞：

- **`index` 映射父路径本身**：`users/index.vue` 不是 `users/index` 这条路由，而是 `users` 这条路由本身（`index` 段折叠成空段）。所以"一个文件夹的主页"和"这个文件夹的布局"是同一个节点。
- **`_parent` 挂在当前节点、且不单独参与匹配**：`users/_parent.vue` 不会新建一个 `users/_parent` 子节点，而是把组件挂到 `users` 这个节点上，并顺手给它打上 `name: false`——意思是"我只是个布局壳子，别让用户能直接导航到我"。这样 `users/_parent.vue` 和 `users/index.vue` 才不会撞成两条路由。

为什么非得用树，不能用一个大数组？这正是本章的第一条权衡（见文末）。这里先记住结论：**树把"嵌套、parent 链、参数沿父链自然累积、`(group)` 文件夹自动折叠路径"这些事一次性都送给你了**，代价是增删改时要按 `/` 递归、遍历要走 DFS。

## 文件名段，怎么变成路由形态

光有树还不够。节点叫 `[id]`，它在 URL 上到底匹配什么？显然不是字面的 `[id]`，而是动态参数 `:id`。这一步是文件名约定在起作用：方括号 `[param]` 变成 `:param`、`(group)` 文件夹不贡献路径只用来分组、`[[param]]` 是可选参数、`[...param]` 是通配。

实现上，这是一个**字符级状态机**，把文件名段逐一吃进去、吐出"这段的路径形态 + 参数 + 子段"。这一套文法统一表达了动态/可选/带类型/通配/转义，文件名本身就是声明。不过状态机的边界很细（可选参数前的斜杠要挪进非捕获组之类），那是另一章的料，本章演示里只用到最常见的 `[id]` 和 `index`，够你看懂机制。

## 底层第二件：一个节点的"多来源意见表"

到目前为止一切都很顺：一个文件决定一条路由。但真正棘手的问题来了——**一条路由的 `path`、`name`、`meta`、`alias`，可能从四个不同的地方冒出来**：

1. 文件名约定（`[id]` → 路径形态 `:id`，`_parent` → `name: false`）；
2. 文件里写的 `<route>` 路由块（一段声明式配置）；
3. 文件里调的 `definePage()` 编译宏（专门设 `meta`/`path` 等）；
4. 构建期的 `extendRoute` 扩展钩子（用户写的 JS，能干任何事）。

如果用"后者覆盖前者"的扁平写法，这四者就会互相打架：钩子设了 `alias`，就把文件里 `<route>` 块设的 `alias` 抹掉了。这显然不对——别名明明可以两个都要。

所以每个节点内部不是存"一份配置"，而是存一张**按来源分桶的意见表**：`Map<来源标识, 覆盖块>`。每个来源各占一桶，谁也不覆盖谁地并存。

打个比方：这就像一场评审会。**文件名约定是"默认意见"**，座次最低，没人表态时它说了算；**文件里 `<route>` 块和 `definePage()` 是"文件本人的意见"**，各占一栏；**用户扩展钩子是"终审主席"**，座次最高，永远最后拍板。关键在于——**写入时分桶互不干扰，读取时才按既定座次把各栏意见揉成一份**。

## 读时深合并：按座次揉成一份

既然是"揉成一份"，就得有揉的规矩。两件事：先排座次，再按字段定合并策略。

**排座次**：约定标识永远最前（地基）、用户钩子标识永远最后（逃生舱）、其余各文件来源之间按文件名字典序。然后从低到高逐层合并——所以最后合并的钩子，对任何字段都拥有最终发言权。

**合并策略按字段分别定义**（不是一刀切的"后者盖前者"）：

| 字段 | 合并策略 | 为什么这么定 |
| --- | --- | --- |
| `alias` | 数组拼接（两份都要） | 别名天然可以有多个，谁也别覆盖谁 |
| `meta` | 深合并（逐字段往下揉） | `meta` 是一堆散字段，各来源各设几个很正常 |
| `path`/`name` 等标量 | 后者胜，但 falsy 不覆盖（`b[key] ?? a[key]`） | 标量只能取一个值，但谁没设就不该去清空别人 |

这套策略是整章的"心脏"——它让四个来源能同时往同一条路由贡献不同字段，互不抹掉。换句话说，**"约定给路径、文件给 meta、钩子给别名"这三件事可以同时成立在同一条路由上**。

## 四来源接入 + 完整流水线

把上面两件东西拼起来，从磁盘上的文件到运行中的路由器，完整流水线是这样的：

```
扫描 pages/（glob 列文件）
  → 每个文件算出 routePath（剥掉页面根前缀、去扩展名、加可选 path 前缀）
  → routeTree.insert(routePath, filePath)        按 / 递归建树，叶子挂组件
  → 读文件内容，抽出 <route> 块 / definePage()     作为一栏，挂到对应节点的意见表
  → 读每个节点：四来源排序 + 按字段深合并 → 这条路由的最终属性
  → 遍历树，对每条路由调 extendRoute 钩子        钩子写的字段进"逃生舱"桶，优先级最高
  → 把整棵树序列化成 routes 数组
  → 经虚拟模块 vue-router/auto-routes 热替换进运行中的路由器
```

注意"约定优先 + 多层逃逸舱"这条主线：简单场景，文件名约定就够，啥都不用写；要加 `meta`，写个 `<route>` 块或 `definePage()`；要程序化改路由，上 `extendRoute` 钩子。每一层都让你多一分控制力，但没有任何一层逼你 eject。而所有这些钩子的修改，最终都走的是**同一个合并通道**——钩子的 setter 把字段写进那张意见表的"逃生舱"桶，和文件来源平起平坐地参与深合并。这就是为什么钩子能"兜底"却不会绕开规则。

最后产物那份 `routes` 数组，正是前置章「路由匹配表」的输入——它接着去编译 matcher、按 score 排序、做匹配。本章到此交棒。

## 最小演示：从零写一遍这套机制

下面这段 TS 把"前缀树 + 分桶意见表 + 读时深合并"从零实现了一遍，能直接跑（`bun run file-routing-demo.ts`，或 `npx tsx file-routing-demo.ts`）。为聚焦合并机制，文件名状态机的边界全部省略，约定那栏的路径形态直接手填。

```ts
// file-routing-demo.ts
const CONVENTION = '@@convention' // 文件名约定：座次最低，是地基
const EDITS = '@@edits'           // 用户扩展钩子：座次最高，是逃生舱

// 把来源名换算成"座次"：数小的先合并，后合并者覆盖前者
function rank(src: string): [number, string] {
  if (src === CONVENTION) return [0, '']
  if (src === EDITS) return [2, '']
  return [1, src] // 各文件来源之间，按文件名字典序
}

// 按字段分策略合并：alias 拼接 / meta 深合并 / 其它后者胜但 falsy 不覆盖
function mergeOverride(a: any, b: any): any {
  const merged: any = {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'alias') merged.alias = [].concat(a.alias ?? [], b.alias ?? [])
    else if (key === 'meta') merged.meta = mergeDeep(a.meta ?? {}, b.meta ?? {})
    else merged[key] = b[key] ?? a[key]
  }
  return merged
}
function mergeDeep(a: any, b: any): any {
  const out: any = { ...a }
  for (const k of Object.keys(b))
    out[k] = a[k] && typeof a[k] === 'object' && b[k] && typeof b[k] === 'object'
      ? mergeDeep(a[k], b[k]) : b[k]
  return out
}

class TreeNode {
  children = new Map<string, TreeNode>()
  components = new Map<string, string>()        // viewName -> 文件路径
  private overrides = new Map<string, any>()    // 来源 -> 这一来源的意见块
  constructor(public segment: string, public parent: TreeNode | null = null) {}

  // 按 / 递归建树，叶子挂组件；_parent 挂当前节点并标 name:false
  insert(path: string, filePath: string): TreeNode {
    const [seg, ...rest] = path.split('/')
    if (seg === '_parent' && rest.length === 0) {
      this.overrides.set(CONVENTION, { name: false })
      this.components.set('default', filePath)
      return this
    }
    if (!this.children.has(seg)) this.children.set(seg, new TreeNode(seg, this))
    const child = this.children.get(seg)!
    if (rest.length === 0) child.components.set('default', filePath)
    else child.insert(rest.join('/'), filePath)
    return child
  }

  // 任意来源往这张表里写一栏
  setOverride(source: string, block: any) {
    this.overrides.set(source, { ...(this.overrides.get(source) ?? {}), ...block })
  }

  // 读时：按座次排序，从低到高逐层深合并
  get merged(): any {
    return [...this.overrides.entries()]
      .sort(([a], [b]) => {
        const ra = rank(a), rb = rank(b)
        return ra[0] - rb[0] || ra[1].localeCompare(rb[1])
      })
      .reduce((acc, [, block]) => mergeOverride(acc, block), {})
  }
}

// ===== 演示 =====
const root = new TreeNode('')
root.insert('users/index', 'pages/users/index.vue')
root.insert('users/[id]', 'pages/users/[id].vue')
const idNode = root.children.get('users')!.children.get('[id]')!

// 三个来源，各贡献不同字段
idNode.setOverride(CONVENTION, { path: 'users/:id' })                  // ① 文件名约定给路径形态
idNode.setOverride('pages/users/[id].vue', { meta: { auth: true } })   // ② 文件内 definePage 给 meta
idNode.setOverride(EDITS, { alias: ['/u/:id'] })                       // ③ 用户钩子给别名

console.log(idNode.merged)
// => { path: 'users/:id', meta: { auth: true }, alias: ['/u/:id'] }
//    三来源共存：路径来自约定、meta 来自文件、别名来自钩子，谁也没抹掉谁

// 冲突情形：文件又加了个别名，钩子还想重命名参数
idNode.setOverride('pages/users/[id].vue', { meta: { auth: true }, alias: ['/local/:id'] })
idNode.setOverride(EDITS, { alias: ['/u/:id'], path: 'users/:userId' })

console.log(idNode.merged)
// => { path: 'users/:userId', meta: { auth: true }, alias: ['/local/:id', '/u/:id'] }
//    alias 被收集成两个；path 钩子盖过约定；meta 仍在
```

最后一行的输出最能说明问题：**alias 是收集（两个都要），path 是后者胜（钩子盖过约定），meta 是合订（仍在）**——三种字段三种待遇，但都活在同一份合并结果里。整棵树再 DFS 一遍、每节点取一次 `merged`，就是那份 `routes` 数组。

## 关键权衡

看懂演示之后，回头品这几个设计选择。它们才是这一章真正想交付的"为什么"。

**权衡一：用前缀树，而不是扁平数组，来装下路由拓扑。**

这是整个机制的底座。选择树形而不是把所有路由平铺成一个数组，换来的是一整簇能力**免费**成立：嵌套路由的父子关系直接就是树的父子关系、`parent` 链天然存在、参数能沿父链从上往下自然累积、`(group)` 这种"只用来分组、不贡献路径"的文件夹只要让它的段折叠成空串就自动消失、`index` 映射父路径也只需让该段为空。这些在扁平数组里每一条都得手写逻辑去算，在树里它们是结构本身。

代价也很明确：增删一条路由不再是数组 `push`/`splice`，而是按 `/` 递归切分逐段下沉；删除时要判断节点是否被掏空、空了得向上回溯清理；遍历不能简单 `for`，得走 DFS/BFS。这是一笔用"操作复杂度"换"拓扑表达力"的交易，而路由这个领域天然是嵌套的，所以这买卖划算。

**权衡二：每个来源各存一栏、读取时才按固定座次深合并，而不是写入时就覆盖出一个最终值。**

这是心脏。选择"分桶 + 读时合并"而不是"写时覆盖"，换来的是四来源能同时向**同一条路由**贡献不同字段、互不抹掉——演示里"约定给 path、文件给 meta、钩子给 alias"能共存，靠的就是这个。它还带来一个关键副作用：文件监听（watcher）改了某个文件时，只需要动那一栏，别的来源毫发无伤，合并结果自然就跟着变了。而钩子用专属标识、排序永远最后，是刻意让它成为"无论如何约定和文件怎么设，钩子总能兜底"的最终逃生舱，直接支撑了"渐进式复杂度"这条主线。

代价是：**每次读一个节点的属性，都要重新排序 + 逐层深合并**（源码里就留着一条性能 TODO，暗示大树下这确有开销，未来可能加缓存）。更隐蔽的代价是——"合并"这件事没法一刀切，必须**按字段逐一约定语义**：alias 拼接、meta 深合并、标量后者胜。每加一种字段类型，就得想清楚它该怎么揉，否则会出现"两个来源都设了它，结果莫名其妙丢了一个"的 bug。这是用"读时计算成本 + 合并语义维护成本"换"多来源共存与渐进可定制"。

**权衡三：约定优先，配一套多层逃逸舱（`<route>` 块 → `definePage` 宏 → `extendRoute` 钩子）。**

这直接回应了开篇那个"撞墙"的场景。选择把定制能力做成一条阶梯，换来的是从"丢个文件进来就生效"到"我要程序化精细控制这一条路由"之间存在一条**平滑梯度**——你要加个 `meta`，不必碰钩子；你要批量改路由，钩子在那等着。全程任何一档都不逼你 eject 整套方案，这是它相对纯约定式（只认文件名）方案最大的胜场。

代价是：**同一条路由的元数据现在可能散落在四处**（文件名、`<route>` 块、`definePage`、钩子），调试时你得知道某个字段最终是从哪一栏来的。配套的代价是必须有一套明确的优先级规则（本章的座次表）和冲突检测（同名视图被多文件覆盖才算冲突、要告警），否则这种分散会变成隐患。一句话：它用"元数据来源的分散与规则维护"换"复杂度的渐进可控"。

## 小结

文件路由这套机制，说白了就两件底层的东西在撑：**一棵前缀树**把文件夹的父子结构原样装下来，**一张分桶的意见表**让文件名约定、`<route>` 块、`definePage`、扩展钩子四个来源各占一栏、读时按固定座次深合并。两者合起来，把"零配置的便利"和"逐条可定制"这两个原本对立的需求，缝成了一条不必 eject 的平滑梯度。它最终产出的 `routes` 数组，交给前置章的匹配表去编译、去匹配。

再往上一层，下一章「导航期数据加载器」会把另一类东西也接进路由的生命周期——数据获取：用一组导航守卫把取数据从组件树提升到导航管线，让数据的可见性跟着导航走，而不是跟着组件挂载走。