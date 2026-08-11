---
title: 路由匹配表：从配置到 matched 链
---

# 路由匹配表：从配置到 matched 链

> 本章属于 composite 层。前置：路径模式编译与优先级评分、导航失败的语义化分类。
> 学完你能：用一句话讲清「为什么把路由配置预编译成一张有序扁平表 + 命中后沿父指针反推组件链」是配置形状与匹配形状之间的桥，以及它付出了哪些代价。

## 1. 为什么需要它

上一章 History 抽象把 URL 模型封装成了可导航、可监听的窄接口：push、replace、listen 都齐了。但 URL 一变化，从那段字符串到「该渲染哪些组件、参数是什么」之间的桥还没人造。

想象一个真实场景：用户写了一棵嵌套的配置树——`/users` 下面挂着 `/users/:id` 再挂着 `/users/:id/posts`，`/users` 还带个别名 `/u`。每次导航拿到一个目标（可能是路由名、可能是完整路径、也可能是相对当前位置的偏移），必须立刻回答两件事：**该渲染哪几个组件（包括所有祖先组件）、参数是什么**。

这里藏着一个结构性矛盾：**配置的形状是树**（嵌套、别名、重定向，天然带层级），**但匹配的形状是线**（一个 URL 对一条记录，要给确定的答案）。如果每次导航都重新遍历配置树逐条比对，既慢，又处理不了「同一段 URL 被多条模式命中时该选谁」的歧义。比如 `/users/list` 同时被 `/users/:id` 和 `/users/list` 命中，到底谁该赢？

所以需要一座桥：把树展平进一张可线性扫描的有序表，同时又不能丢父子关系——否则就算匹配到了 `/users/:id`，也不知道要顺手把 `/users` 的 Users 组件一起渲染。

「评分排序」怎么从模式本身派生具体性分数，已经在「路径模式编译与优先级评分」讲透，本章只看分数怎么被消费来维持一张始终有序的运行期表。找不到匹配时抛什么语义化错误，已经在「导航失败的语义化分类」讲透，本章只把它当作 resolve 的失败出口。

## 2. 核心思想

把配置树在**注册期**一次性预编译成一张按具体性评分排序的扁平匹配表，运行期解析只剩「一次正则命中 + 沿父指针反推组件链」。

这句话的关键不在「把路径编译成正则」（那是前一章），而在两件新事：把树压成扁平有序表，再用父指针把压扁时丢掉的父子关系挂回来。两步合起来，运行期才能既拿到线性扫描的速度、又拿到树形还原的完整组件链。

## 3. 心智模型

运行期 imaginate 出来的样子，是**两套并行结构 + 三种解析入口 + 一条父指针回溯链**。

**两套并行结构**：
- `matchers`：按分数降序排列的数组，是按路径解析时的扫描源。一次 `find(m => m.re.test(path))` 就拿到最高分命中。
- `matcherMap`：名字到表项的哈希表，是按名解析时的 O(1) 索引。一次 `get(name)` 直接定位。

**一个表项身上挂两组东西**：路径解析器（正则、分数、参数键、parse、stringify，承前章产物）+ 规范化记录（组件、守卫、实例缓存）+ 三个指针字段（`parent` / `children` / `alias`）。前一半负责「这条 URL 是不是我」；后一半负责「命中我之后，组件链怎么拼回来」。

**三种解析入口**：
- 按 `path` 来：线性找第一个正则命中的表项，再 parse 出参数。
- 按 `name` 来：查名字映射，按 `matcher.keys` 过滤参数，再 stringify 反解出路径。
- 按相对位置来：基于 `currentLocation` 定位当前 matcher，合并传入参数后反解路径。

**一条父指针回溯链**：无论从哪个入口进来，命中后都做同一件事——`while (parent) { matched.unshift(record); parent = parent.parent }`。逆序 unshift 使祖先排在前、当前在最末，正好对齐 RouterView「由外到内」的渲染顺序。

想象一面墙的目录卡片：每张卡片开个小窗（正则）只让某种形状的 URL 透过；卡片按精确度从左到右排，最具体的靠最左；卡片背面贴着「我爸是哪张卡」的标签。查 URL 时从左往右扫到第一张能透过的卡，就翻背面标签一路回溯到顶，把整串卡片摘下来——那就是要渲染的组件链。

## 4. 关键权衡

### 注册期预编译，换运行期极简解析

**选择**：用户调 `addRoute` 那一刻就把每条路径编译成正则、解析/反解函数、分数（编译细节承前章），然后插入有序表——而不是把这种工作拖到 resolve 时按需做。

**换来**：运行期解析 `path` 时只剩一次 `find(m => m.re.test(path))`，命中的是表上第一个正则通过的表项（因为表已按分数降序，第一个就是最具体的）；解析 `name` 时是一次哈希查表。每次导航开销是「O(表长) 次正则 test + 一次 parse + 一次指针回溯」，跟配置树的深度无关——树再深，组件链也是沿指针反推的常数步。

**代价**：路由表成了「可变、有维护成本的结构」。增删一条路由开销大（二分定位 + 数组移动），并且必须同步维护三套结构：有序数组、名字到表项的映射、别名反向引用。任一处不一致整张表就坏了。这是一种典型的「把复杂度从高频读路径搬到低频写路径」的取舍：导航每秒可能发生几十次，路由表变更一辈子可能就几次。

**本质矛盾**：编译开销 vs 运行期性能。这种「读多写少 → 把成本挪到写」的骨架，在数据库索引、JIT 编译器、缓存预热里都能看到同一种形状。

### 树展平加双向指针，换匹配无需递归

**选择**：递归把嵌套配置树拍平进一个扁平数组，但每个表项同时携带 `parent` 和 `children` 双向指针——既享受线性扫描的简单，又能在命中后沿 `parent` 反推出完整组件链。

**换来**：解析的核心循环里没有任何递归。「找表项」是数组 `find`，「拼组件链」是 `while (parent)`，两种操作都是恒定结构。树形复杂度被压平进了数组排序。

**代价**：父子关系再也不能「靠路径嵌套表达」，必须在注册期手工处理两件事：

- **父子路径拼接**。子路径首字符非 `/` 时才算相对路径，中间的分隔符 `/` 仅在「父路径不以 `/` 结尾且子路径非空」时补上。把树压成串的关键就在这几行小心翼翼的代码：
  ```ts
  if (parent && path[0] !== '/') {
    const parentPath = parent.record.path
    const connectingSlash = parentPath.endsWith('/') ? '' : '/'
    normalizedRecord.path = parentPath + (path && connectingSlash + path)
  }
  ```
- **同分排序调整**。父子分数相同时（典型场景：父 `/a` 与子拼出的 `/a` 空路径），分数比较函数看不出谁先谁后；必须额外在二分插入时查「同分祖先」并把后代挪到祖先之前，否则命中祖先会提前短路，漏掉更具体的后代。

**本质矛盾**：扁平数据的扫描速度 vs 树形结构的关系还原。鱼和熊掌都想要的代价，是关系要靠指针手工缝合、歧义要靠规则逐条补全。这种「扁平存储 + 指针重建关系」的形状，在 ORM 关联映射、文档数据库、虚拟 DOM diff 里都能看到。

### 别名共享同一份记录，换一处定义多处生效

**选择**：为每个别名单独建一个表项，它有自己的路径、自己的正则、自己的分数，跟原表项平起平坐地住进 `matchers` 数组里；但它的「记录归属」指针指向**同一个原始记录**——组件、守卫、已挂载实例缓存全部共享。

**换来**：同一段组件逻辑可以被多条路径命中，异步组件缓存挂在原记录上、所有别名共用一份（避免每个别名各自实例化一份组件）。删除原记录时，级联递归清掉所有别名表项，不会留下指向虚空的孤儿。

**代价**：别名路径必须拥有与原路径相同的必要参数，否则解析出来的参数对不上（注册期有校验告警）。同时，名字映射里只登记原记录、别名靠原记录的 `alias` 列表间接可达——这意味着别名「能命中、不能按名直查」，要按名跳别名必须走原记录。

**本质矛盾**：路径的多样性 vs 组件状态的一致性。同一段 UI 想被多个 URL 入口复用，但组件状态（缓存、守卫、实例）只该有一份——别名表项负责把多个入口分流到同一段实现。

### 判别联合用互斥标记描述五种变体

**选择**：把用户配置的形态拆成五个变体（单组件 / 单组件带子路由 / 多命名视图 / 多命名视图带子路由 / 纯重定向），用「互斥的 `never` 字段」锁死组合——同时写了 `component` 又写了 `redirect` 是合法的 TypeScript 写法，但写出来在编译期就报红。

**换来**：规范化逻辑能放心用「属性存在性」分支判断五种变体，不必做运行期猜测；错误配置在用户写代码时就报红，而不是上线后撞到一个没考虑过的分支。

**代价**：五个接口定义较长，用户第一次看到「我写了 `component`，为什么 `redirect` 报错」时需要理解 `component?: never` 表示这个变体里这个字段必须不存在这条 TS 惯用法。代价薄到不展开——主要是换来类型安全，代价是用户多学一条互斥规则。

**本质矛盾**：配置表达力 vs 类型安全。把「互斥变体」上提到类型层而不是运行期校验，是用编译器的成本换运行时不会撞到不该撞的分支。

## 5. 最小原理演示

下面这段演示只演透核心思想：递归把配置树拍平成带父指针的扁平表项数组、按分数二分插入、命中后沿父指针 unshift 出组件链，再加一条别名共享记录。每一段都对应上面某条权衡。

```ts
type RawRoute = {
  path: string
  component?: Function
  name?: string
  alias?: string[]
  children?: RawRoute[]
}

type Record = { path: string; component?: Function; name?: string }

type Matcher = {
  path: string
  re: RegExp
  score: number               // 简化：仅用静态段数当分数（前章的真实算法此处压缩成一档）
  record: Record
  parent: Matcher | null
  aliasOf: Matcher | null     // 非空表示这是别名表项，指向原始表项
}

// 工具：路径模式编译成正则（:param → 捕获组；承前章的细粒度编译此处极度简化）
function compileToRegex(path: string): RegExp {
  return new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$')
}

function scoreOf(path: string): number {
  return path.split('/').filter(seg => seg && !seg.startsWith(':')).length
}

// 注册期：递归把配置树拍平进扁平数组，同时挂双向指针
function buildMatchers(raw: RawRoute[], parent: Matcher | null = null): Matcher[] {
  const out: Matcher[] = []
  for (const r of raw) {
    // 子路径首字符非 / 时算相对路径，手工补一个分隔符——树压成串的关键
    const fullPath = parent && !r.path.startsWith('/')
      ? parent.path + '/' + r.path
      : r.path

    const m: Matcher = {
      path: fullPath,
      re: compileToRegex(fullPath),
      score: scoreOf(fullPath),
      record: { path: fullPath, component: r.component, name: r.name },
      parent,
      aliasOf: null,
    }
    out.push(m)

    // 别名各自有路径/正则/分数，但 record 字段直接复用原表项的对象引用
    // 同一份组件/守卫/实例缓存被多条路径共享
    for (const aliasPath of r.alias ?? []) {
      out.push({
        path: aliasPath,
        re: compileToRegex(aliasPath),
        score: scoreOf(aliasPath),
        record: m.record,
        parent,
        aliasOf: m,
      })
    }

    // 先建好 matcher 才能作为 parent 传给子调用——递归建树的前序
    if (r.children) out.push(...buildMatchers(r.children, m))
  }
  return out
}

// 二分插入：保持按分数降序，使「第一个正则命中的」就是「最具体的命中」
function insertSorted(table: Matcher[], m: Matcher): void {
  let lo = 0, hi = table.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (table[mid].score > m.score) lo = mid + 1
    else hi = mid
  }
  table.splice(lo, 0, m)
}

// 运行期解析：一次正则命中 + 沿父指针 unshift 出组件链
function resolve(table: Matcher[], path: string) {
  // 表已按分数降序，find 返回的首个命中即最高分匹配，无需回溯比较多个候选
  const matcher = table.find(m => m.re.test(path))
  if (!matcher) throw new Error('MATCHER_NOT_FOUND')  // 失败出口的语义化分类承前章

  const matched: Record[] = []
  let p: Matcher | null = matcher
  while (p) {
    matched.unshift(p.record)  // 逆序插入：祖先在前、当前在末，对齐由外到内的渲染顺序
    p = p.parent
  }
  return { matched }
}
```

读法：`buildMatchers` 演的是权衡「树展平加双向指针」——树被压成扁平数组、父子关系靠 `parent` 字段挂回；`compileToRegex` 和 `scoreOf` 都在注册期一次完成、运行期不再触碰，演的是权衡「注册期预编译」；别名表项的 `record` 字段直接复用原表项对象引用，演的是权衡「别名共享同一份记录」；`while (p) matched.unshift(p.record)` 演的是核心思想本身——无递归还原组件链。

## 6. 执行轨迹

以配置 `{ path: '/users', component: Users, alias: '/u', children: [{ path: ':id', component: UserDetail }] }` 走一遍。

**注册期**（addRoute 递归）：

1. 规范化 `/users`：分数 1（一个静态段），`parent: null`，`aliasOf: null`。二分插入 → `matchers = [/users]`。
2. 展开别名 `/u`：分数 1，`aliasOf` 指向上一步的 `/users` 表项，`record` 共享同一份 Users 组件定义。插入 → `matchers = [/users, /u]`（同分时按插入顺序排）。
3. 递归子路由 `:id`：相对路径，拼成 `/users/:id`（父路径 `/users` 不以 `/` 结尾，补一个 `/`）。分数 1（一个静态段 + 一个动态段，简化算法只数静态段）。`parent` 指向 `/users` 表项。插入 → `matchers = [/users, /u, /users/:id]`。
4. 实际工程里别名 `/u` 也会展开自己的子树路径 `/u/:id`，record 共享 UserDetail。表里再多一条。

**运行期**（resolve `/users/42`）：

1. 进入 `path` 分支。`matchers.find(m => m.re.test('/users/42'))` 从头扫：
   - `/users` 的正则 `^/users$` 不通过；
   - `/u` 的正则 `^/u$` 不通过；
   - `/users/:id` 的正则 `^/users/([^/]+)$` 通过。停在这里。
2. `matcher.parse('/users/42')` 得到 `{ id: '42' }`。
3. 命中后沿父指针回溯：当前 `matcher` 是 `/users/:id` → `unshift(UserDetail)` → 走到 `parent = /users` → `unshift(Users)` → 走到 `parent = null`，结束。`matched = [Users, UserDetail]`，祖先在前、当前在末。
4. 合并各层 `meta`，返回 `{ name: undefined, path: '/users/42', params: { id: '42' }, matched: [Users, UserDetail] }`。

整个解析过程零递归遍历配置树：「找表项」是一次数组扫描，「拼组件链」是三次 `unshift`。

## 7. 教学简化说明

本章演示故意省略了：真实的字符级评分算法（承前章已演）；参数键的可选/可重复细节、props 规范化、守卫集合实例化、所有开发期校验告警；query、hash、编码；重定向记录的单独处理；以及「同分父子时把后代挪到祖先之前」的边界调整；纯分组路由（无组件/无名/无重定向）不入 `matchers` 数组但仍作 parent 的过滤规则。这些都是工程化包装，不在原理主线上。

## 8. 小结

注册期把树压成有序扁平表、运行期只做一次正则命中加沿父指针反推，这是把「树形配置」与「线性匹配」两种形状捏到一起的代价：用低频的写时编译换高频的读时极简，用扁平存储加指针重建关系，用别名共享记录换多处入口指向同一份状态。matched 链到手之后，下一章「导航守卫管线」就在这条链上串联起一长串异步钩子，决定这次导航到底要不要放它过去。
