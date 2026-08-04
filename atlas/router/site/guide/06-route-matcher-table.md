# 路由匹配表：从配置到 matched 链

## 你写的是一棵树，浏览器问的是一条线

想象你在配置路由，多半会写成这样——一层套一层：

```ts
const routes = [
  {
    path: '/users',
    component: Users,
    alias: '/u',
    children: [
      { path: ':id', component: UserDetail },
    ],
  },
]
```

这棵树对你很好读：`Users` 是外壳，`UserDetail` 嵌在它里面，`/u` 是 `/users` 的小名。可运行期每次导航，浏览器甩过来的是一个冷冰冰的 URL（比如 `/users/42`），它不管你的树长什么样，就要你立刻回答两件事：**这次该渲染哪几个组件（连祖先一起算）？参数是什么？**

这里有个根本的不对仗——**配置的形状是树**（嵌套、还带别名），**匹配的形状却是线**（一个 URL 对一条记录）。如果每次导航都重新去遍历这棵树、逐条拿模式去比对，一来慢，二来碰到好几条模式都能匹配同一个 URL 时，你根本说不清该选谁。

解法说人话就是：**趁还没开始导航，先把这棵树整个摊开成一张排好序的清单**，摊的时候顺手在每条后面写一句"我爸是谁"。等导航真来了，你只要从清单里挑第一条能对上的，再顺着"我爸是谁"一路往回找，就能凑齐该渲染的整串组件。整个运行期都不必再碰那棵树。

打个比方：图书馆把所有书按索书号排成一长溜（一张有序清单），你从头扫一眼就能锁定最合适的那本；至于"这本书属于哪套丛书、上册是谁"，扉页上写着指引，顺藤摸瓜就能把整套凑齐。书架是平的（线性数组），但"父子关系"靠书页上的备注重建（指针）。

这一章就讲这张清单怎么造出来、又怎么被用起来。

## 一个表项长什么样：一个能认路的解析器，外加四个指针

自底向上，先看这张清单里**一行**长什么样。

每行叫一个**表项**（matcher）。它身兼两职：

- **前半截是个路径解析器**——带一条正则 `re`、一个分数 `score`、一组参数键 `keys`，外加 `parse`（从 URL 抠参数）和 `stringify`（反过来把参数拼回 URL）。这一截是上一章《路径模式编译与优先级评分》的产物：把 `"/users/:id"` 这种模式编译成一个能干活的对象。本章直接拿来用，不再讲它怎么编出来的。
- **后半截是四个指针字段**——`record`（这条路由的全部配置）、`parent`（我爸是谁）、`children`（我的孩子们）、`alias`（跟我绑在一起、删我要一起删的别名）。

关键就在这后半截。把树摊平进数组，本来意味着父子关系丢了；但每个表项都揣着 `parent`，关系就又接回来了。换句话说，**数据结构上是线性的，逻辑上却仍是一棵树**——线性是为了匹配时能快速扫描，指针是为了命中后能还原组件链。这正是本章最核心的一个设计。

## 第一步：把用户五花八门的写法，熨成同一种

用户配置路由的写法很自由：可能写 `component`（单组件），可能写 `components`（多命名视图），可能啥组件都不给（只用来分组），`children`、`meta` 也可能干脆没写。如果运行期到处都得判一遍"这个字段在不在、是哪种形态"，代码会很乱。

所以加入路由的第一件事是**规范化**：把 `component` 统一成 `components.default`，把可能缺失的 `children`/`meta` 补成"永远存在"的形态，再预先开好几个运行期才用得上的空字段（守卫集合、已挂载组件实例的缓存等）。

熨平之后，下游所有逻辑都可以放心假设"字段都在、形态统一"，不用再写一堆 `if`。这是用一点点注册期的整理，换来运行期代码的清爽。

## 第二步：把树拍平，但留住父子关系

规范完一条记录，就轮到**递归**了。这一步要做两件相互纠缠的事：把相对路径拼成完整路径，同时把父子指针接上。

**先建对象，再递归孩子**——这是顺序上的关键。必须先把当前这条的表项创建出来，才能把它当作 `parent` 传给子调用的递归。对象不存在，子就没法挂上来。

父子路径的拼接是手工活，因为树里存的是相对路径（孩子写 `:id`），而最终要拿来匹配的是绝对路径（`/users/:id`）。规则很朴素：

```ts
// 子路径不以 / 开头，才算相对路径
if (parent && path[0] !== '/') {
  const parentPath = parent.record.path
  // 父路径已经以 / 结尾就不重复加，否则补一个分隔斜杠
  const connectingSlash =
    parentPath[parentPath.length - 1] === '/' ? '' : '/'
  normalizedRecord.path = parent.record.path + connectingSlash + path
}
```

就这么几行，处理的是"树形存储"到"字符串拼接"的转换。看着不起眼，但斜杠加错一位，整条路径就匹配不上——这是把树摊平必须付出的手工代价之一。

## 第三步：别名——一份定义，挂到多条路径上

别名（alias）是个常见需求：`/users` 想同时能用 `/u` 访问。怎么实现？

朴素想法是复制一份记录。但复制会有麻烦：异步组件加载后的缓存、注册的守卫，如果每条路径各存一份，就重复了，状态也对不齐。

这里的做法更巧：**为每个别名单独建一个表项**（它有自己的正则、自己的分数、自己的路径，毕竟 `/u` 和 `/users` 长得不一样），但所有别名表项的 `record.aliasOf` 都**指向同一个原始记录**。组件、守卫、实例缓存全部共享原始记录那一份。

于是同一个组件逻辑，能被多条路径命中；而删除原始记录时，顺着 `alias` 列表一级级清，别名会跟着一起消失。一份定义，多处生效，删一处全干净。代价是别名路径必须拥有和原路径相同的必要参数（否则解析出来的参数对不上）——这点注册期会校验提醒。

## 第四步：塞进一张始终排好序的表

到目前为止我们造出了一堆表项，现在要把它们组织起来。匹配表内部其实同时养着**两套结构**：

- **`matchers`：一个有序数组**，按分数从高到低排。运行期按路径解析时，就从它里面扫。
- **`matcherMap`：一个 名字 → 表项 的映射**。运行期按名字解析时，O(1) 直接查表。

按路径走数组、按名字走哈希，各取所长。但还没完——不是所有表项都该进表。有一种**纯分组路由**：既没组件、又没名字、也没重定向，它存在的唯一目的是把一堆子路由组织在一起，自己根本不会被访问到。这种表项**不进 `matchers` 数组**（进了也是命中后无物可渲染），但它照样当别人的 `parent`，该接的指针一个不少。

至于排序，这里只消费上一章讲透的那套分数（静态段 > 动态段 > 正则 > 通配），不重新推导。新路由加进来时，用**二分查找**定位该插的位置，再 `splice` 进去——表始终保持有序，不必每次匹配前再排一遍。

有一个细节值得单独说：当**父子俩分数相同**时，光按分数排会出 bug——祖先可能挡在后代前面被先扫到，于是命中了较宽泛的祖先、漏掉了更具体的后代。所以插入时还有第二阶段调整：往上找有没有同分的祖先表项，有的话就把当前这条插到**那位祖先的前面**，保证"同分时后代排在祖先之前"。这条规则只在父子同分这个边界上起作用，分数不同的父子本来就由分数决定了先后。

## 第五步：导航来了——一次命中，沿指针回溯

表建好了，运行期 `resolve` 就轻松了。它按输入分三条路：

- **按名字**：查 `matcherMap`，拿到表项后用 `stringify` 把参数反拼成路径。查不到名字就抛一个"找不到匹配"的错——这种导航失败的语义化分类，上一章《导航失败的语义化分类》已经讲透，这里只当它是解析失败时的出口。
- **按路径**：`matchers.find(m => m.re.test(path))`——线性扫，找**第一个**正则能命中的表项。为什么 find 第一个就够、不用比较多个候选？因为表已经按分数降序排好，首个命中的就是分数最高、最具体的那条，结果既确定又自明，无需回溯。命中后调 `parse` 抠出参数，再清掉那些值为空的可选参数。
- **按相对位置**：既没给名字也没给完整路径（比如 `router.push({ params: { id: 7 } })`），就基于"当前在哪个路由"先定位当前表项，合并传入参数后 `stringify`。

不管走哪条，命中表项之后的活儿都一样——**沿 `parent` 指针一路回溯，把组件链凑齐**：

```ts
const matched = []
let p = matcher
while (p) {
  matched.unshift(p.record)   // 逆序插入，让祖先排在前面
  p = p.parent
}
```

注意是 `unshift`：从命中点往祖先走，但每次往数组头部塞，最终祖先在前、命中点在后——正好是渲染时从外到内的顺序。最后把链上各层记录的 `meta` 逐层合并，一次解析就齐活了：组件链、参数、合并后的元信息，全部到手。**全程零递归遍历配置树**，只有一次正则命中加一次指针回溯。这就是注册期预编译换来的运行期清爽。

## 从零实现一张匹配表

把上面五步串起来，写一个能跑的最小实现。重点演三件事：递归把配置树拍平成"带父指针的表项数组"、按分数二分插入、解析时"找到第一个正则命中的表项、沿父指针 unshift 出组件链"；再演一条别名的共享与级联删除。

```ts
// route-matcher-demo.ts —— 配置树 → 有序匹配表 → 一次命中 + 沿父指针反推
// 用 bun run route-matcher-demo.ts 或 npx tsx route-matcher-demo.ts 运行

type Comp = string // 极简"组件"，用字符串代表，重点是结构

interface RawRoute {
  path: string
  component?: Comp
  alias?: string[]
  children?: RawRoute[]
}

interface RouteRecord {
  path: string
  component: Comp | null
  children: RawRoute[]
  aliasOf?: RouteRecord // 别名指向原始记录；原始记录这里为 undefined
}

// 表项 = 路径解析器(re/keys/score/parse) + 四个指针字段(record/parent/children/alias)
interface Matcher {
  re: RegExp
  keys: string[]
  score: number
  parse: (path: string) => Record<string, string>
  record: RouteRecord
  parent: Matcher | undefined
  children: Matcher[]
  alias: Matcher[]
}

// ① 极简编译器：把 "/users/:id" 编成正则 + 分数 + parse
//    真实的字符级评分见上一章，这里只用"静态段 > 动态段"两档示意
function compile(path: string) {
  const keys: string[] = []
  const segs = path.split('/').filter(Boolean)
  const pattern = segs
    .map(seg => (seg.startsWith(':') ? (keys.push(seg.slice(1)), '([^/]+)') : seg))
    .join('/')
  const re = new RegExp('^/' + pattern + '/?$')
  const parse = (p: string) => {
    const m = re.exec(p)!
    const out: Record<string, string> = {}
    keys.forEach((k, i) => (out[k] = m[i + 1]))
    return out
  }
  // 分数：静态段 4 分，动态段 1 分
  const score = segs.reduce((s, seg) => s + (seg.startsWith(':') ? 1 : 4), 0)
  return { re, keys, score, parse }
}

function createMatcherTable(routes: RawRoute[]) {
  const matchers: Matcher[] = [] // 有序数组，分数从高到低

  function normalize(raw: RawRoute): RouteRecord {
    return { path: raw.path, component: raw.component ?? null, children: raw.children ?? [] }
  }

  // 按分数二分插入，保持数组降序
  function insertSorted(m: Matcher) {
    let lo = 0
    let hi = matchers.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (m.score > matchers[mid].score) hi = mid
      else lo = mid + 1
    }
    matchers.splice(lo, 0, m)
  }

  // 递归建表：parent 必须先建好；original 让别名一脉挂回原始表项，便于级联删除
  function addRoute(raw: RawRoute, parent?: Matcher, original?: Matcher) {
    const main = normalize(raw)
    main.aliasOf = original?.record

    // 展开别名：原始路径 + 每个别名各一条记录，组件定义复用原始记录
    const variants: { record: RouteRecord; path: string; aliasOf?: RouteRecord }[] = [
      { record: main, path: raw.path },
    ]
    for (const a of raw.alias ?? []) variants.push({ record: { ...main }, path: a, aliasOf: main })

    let first: Matcher | undefined // 这一脉里第一个（原始）表项
    for (const v of variants) {
      v.record.aliasOf = v.aliasOf
      // 父子路径拼接：子路径不以 / 开头才算相对
      if (parent && v.path[0] !== '/') {
        const slash = parent.record.path.endsWith('/') ? '' : '/'
        v.record.path = parent.record.path + slash + v.path
      }

      const matcher: Matcher = {
        ...compile(v.record.path),
        record: v.record,
        parent,
        children: [],
        alias: [],
      }
      if (parent) parent.children.push(matcher)

      // 别名挂回原始表项，删原始时能级联清掉
      if (original) original.alias.push(matcher)
      else {
        first = first ?? matcher
        if (first !== matcher) first.alias.push(matcher)
      }

      // 纯分组（无组件）不入表，但照样当别人的父
      if (matcher.record.component) insertSorted(matcher)

      for (const c of raw.children ?? []) addRoute(c, matcher, original)
      if (!original) original = matcher
    }
  }

  // 运行期：一次正则命中 + 沿父指针反推组件链
  function resolve(path: string) {
    const matcher = matchers.find(m => m.re.test(path)) // 表已降序，首个命中即最具体
    if (!matcher) return null
    const params = matcher.parse(path)
    const matched: RouteRecord[] = []
    let p: Matcher | undefined = matcher
    while (p) {
      matched.unshift(p.record) // 逆序插入，祖先在前
      p = p.parent
    }
    return { params, components: matched.map(r => r.component) }
  }

  // 删一条：连带子树和别名一起消失
  function removeRoute(m: Matcher) {
    const i = matchers.indexOf(m)
    if (i >= 0) matchers.splice(i, 1)
    m.children.forEach(removeRoute)
    m.alias.forEach(removeRoute)
  }

  routes.forEach(r => addRoute(r))
  return { matchers, resolve, removeRoute }
}

// —— 跑一遍 ——

// 场景一：嵌套路由，演"拍平 + 父指针 + 一次命中"
const t1 = createMatcherTable([
  { path: '/users', component: 'Users', children: [{ path: ':id', component: 'UserDetail' }] },
])
console.log('表内顺序（分数降序）:', t1.matchers.map(m => `${m.record.path}(${m.score})`))
// [ '/users/:id(5)', '/users(4)' ]
console.log('解析 /users/42:', t1.resolve('/users/42'))
// { params: { id: '42' }, components: [ 'Users', 'UserDetail' ] }

// 场景二：别名，演"一份定义多条路径 + 级联删除"
const t2 = createMatcherTable([{ path: '/home', component: 'Home', alias: ['/index', '/start'] }])
console.log('三条路径都指向 Home:', t2.resolve('/start'))
// { params: {}, components: [ 'Home' ] }
console.log('删前表大小:', t2.matchers.length) // 3
t2.removeRoute(t2.matchers[0])
console.log('删原记录后表大小:', t2.matchers.length) // 0 —— 别名一起没了
```

看场景一的输出：表里 `/users/:id`（分数 5）排在 `/users`（分数 4）前面，所以解析 `/users/42` 时第一个命中的就是更具体的那条，再沿父指针回溯出 `[Users, UserDetail]`——外层组件在前，正好是嵌套渲染的顺序。场景二里，`/home`、`/index`、`/start` 三条路径都解析出同一个 `Home` 组件（共享原始记录），删掉原始记录后表瞬间清空，别名没留一点残渣。

## 几个关键的设计取舍

**取舍一：注册期把所有路径预编译，换来运行期只剩"一次正则命中 + 一次指针回溯"。**
选择在添加路由的那一刻，就把每条路径编译成正则、分数、parse/stringify，并接好父指针——这意味着开销全压在配置阶段。换来的是运行期解析路径时极其简单：线性找到第一个正则通过的表项、调一次 parse、沿指针走一遍，全程零递归；按名字解析更是一次哈希查表。代价是**表是可变的，增删路由开销大**，而且必须同时维护好几套结构（有序数组、名字映射、别名反向引用），任何一处没同步好，整张表就坏了。这是个典型的"把贵的工作前移到一次性阶段、把热路径做到极简"的取舍。

**取舍二：树展平进数组，但用双向指针把父子关系接回来，换来匹配无需递归。**
选择把嵌套配置递归拍平成一个扁平数组，享受线性扫描的简单；同时每个表项都揣着 `parent`（和被推入父亲的 `children`），于是命中之后只要沿 `parent` 一路回溯就能还原完整组件链，不必再回到那棵树上去递归。代价是**"树形相对路径"到"字符串绝对路径"的转换得手工做**——父子路径拼接时那一个分隔斜杠加不加、加在哪，全靠人肉处理，错一位就匹配不上；而且当父子分数相同时，还得多一道"把后代挪到祖先前面"的调整，否则祖先会提前短路、漏掉更具体的后代。换句话说，这个设计换来的是匹配期的简单，付出的是建表期的细碎。

**取舍三：别名各自建表项，但记录共享同一份，换来一处定义多处生效。**
选择为每个别名单独编译出一个表项（它有自己的正则和分数，毕竟 `/u` 和 `/users` 形态不同），但所有别名表项的 `record.aliasOf` 都指向同一个原始记录——组件、守卫、已挂载实例的缓存全部共享。换来的是同一段组件/守卫逻辑能被多条路径复用，删除原始记录时顺着 `alias` 列表级联清理、一条不留。代价是**别名路径必须拥有与原路径相同的必要参数**：原路径有 `:id`，别名也得有，否则别名解析出来的参数对不上原记录的组件，注册期会有校验告警。这是"共享带来一致性约束"的常见代价。

**取舍四：用判别联合 + 互斥的 `never` 字段，把五种路由形态精确锁死，换来编译期就拒绝非法配置。**
用户的路由配置其实有五种合法形态：单组件、单组件带子路由、多命名视图、多命名视图带子路由、纯重定向。选择把它们写成五个类型，靠 `component?: never`、`components?: never`、`redirect?: never`、`children?: never` 这种互斥标记让它们在类型层彼此排斥。于是"同时写了 `component` 又写了 `redirect`"这种非法组合，你在编辑器里就红了，根本到不了运行期；规范化逻辑也能放心用"某个属性在不在"来做分支。代价是**五个接口定义偏长，用户得理解这套互斥规则**——但比起让错误混到运行期再排查，这点学习成本很值。

## 小结

这一章的核心，是用一张**注册期预编译、按分数排好序、靠父指针重建树形关系**的扁平匹配表，去桥接"配置是树、匹配是线"这个根本矛盾。运行期因此变得极其轻：一次正则命中加一次指针回溯，组件链和参数就到手了。别名靠"独立表项共享记录"实现一处定义多处生效；五种路由形态靠判别联合在编译期就被精确区分。

match 出来的这条组件链（`matched` 数组）拿去渲染时，还得先过一道关卡——这些组件到底能不能进入、要不要被拦截或重定向。这就是紧邻的下一章《导航守卫管线》要讲的：怎么把一堆守卫按严格顺序串成一条可异步、可取消的流水线。