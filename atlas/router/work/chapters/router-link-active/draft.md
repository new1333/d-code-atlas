# RouterLink 与激活态判定

> 本章属于 composite 层。前置：Router 核心与导航主循环。
> 学完你能：用一句话讲清「为什么激活态判定必须落在 matched 链 + 参数子集上，而不是 URL 字符串前缀」。

## 1. 为什么需要它

几乎每个多页应用都有一排「我现在在哪儿」的指示灯：顶部 Tab、侧边菜单、面包屑、分页器。它们都共享同一个问题——给定一个链接，怎么判断它是不是「当前正在显示的页面」。

最朴素的写法是拿当前 URL 跟链接地址做字符串前缀比较：当前在 `/users/123`，链接是 `/users`，前缀命中，亮。但这种判法在真实路由系统里几乎处处翻车：

- 当前在 `/users/123/posts/456`，那个指向 `/users/123` 的链接该不该亮？字符串前缀会说该亮，但点过去其实是跳到了「父页面」，跟「我在这一页」不是一回事。
- 别名路由（同一组件挂多个路径）怎么算？字符串前缀完全无法识别两条路径指向同一界面。
- 路径参数是 `'123'` 还是 `['123']`、是不是被 URL 编码过，字符串层面千差万别，但语义上是同一个值。

矛盾的根源在于：**URL 字符串是给浏览器/人看的扁平表象，路由位置在内部是立体的**，它带着父子层级的 matched 链、带结构化参数、还可能带别名指针。拿扁平字符串去比立体对象，必然丢信息。

> 上一章 RouterView 把 matched 链当成「渲染到第几层」的标尺，凭注入的 depth 选出该画的组件。本章复用这把标尺，但换个方向用：不问「我渲染到第几层」，而问「这条链接的目标，是不是当前层或它的祖先」。

## 2. 核心思想

不再问「URL 长得像不像」，而问「这条链接的目标位置，在 matched 树上是不是当前位置自身或它的一个祖先；如果是，再问目标参数是不是当前参数的一个子集」。

判定从「字符串同形」变成了「结构上被包含」。

## 3. 心智模型

链接判定有五个关键数据：

- **target**：使用者给链接的目标，可以是字符串（`'/users/123'`）或位置对象（`{ name: 'user', params: { id: '123' } }`）。
- **resolved location**：target 经路由解析后得到的结构化位置，包含一条 matched 记录链 + 一组 params + 一个 href 字符串。解析器是前置章的内容，本章只把它当黑盒。
- **currentRoute**：当前正在显示的路由，同样有自己的 matched 链和 params。
- **activeRecordIndex**：resolved location 的 matched 链末端那条记录，在 `currentRoute.matched` 里的下标。`-1` 表示「不在当前链上」。
- **isActive / isExactActive**：两档布尔判定结果，松档表达「在范围内」，紧档表达「精准命中」。

判定的流程是一条窄管道：

```
target
  → resolve → { matched 末端 record, params }
  → 在 currentRoute.matched 里 findIndex → activeRecordIndex
  → isActive      = index > -1 && 当前参数包含目标参数（子集）
  → isExactActive = index > -1 && index 在链末端 && 参数全等
```

子集判定的方向很重要：遍历的是**目标**参数，要求**当前**参数逐键匹配得上，但允许当前参数多带一些键。所以「链接只关心 `id`，当前还带着 `postId`」是成立的，这正是祖先链接亮的根因。

记录比较时还有个别名归一的小机关：`isSameRouteRecord` 比的是 `(a.aliasOf || a) === (b.aliasOf || b)`，所有别名都回溯到原始记录再做引用相等。别名路由因此不会因为路径不同就被误判成「不同的界面」。

> 「两个位置怎么算完全相等」是前置章『路由位置与 URL 解析』为导航短路建立的判定；本章只在它基础上松绑出「子集」这一档来表达「祖先/包含」关系，不重述全等的定义。

## 4. 关键权衡

### 结构化匹配换别名与嵌套的正确性

把目标先 resolve 成结构化位置，再用 matched 链 + 参数做判定，绕开了字符串前缀的所有坑：别名通过 `aliasOf` 归一到同一记录、参数是数组还是单值都走同一套比较逻辑、父子嵌套关系直接由链上位置决定。

**换来**的是「别名路由天然正确、参数形态无关、嵌套父子精确」这三件事一起成立。

**代价**是判定不能纯靠两个字符串算出来。必须先调一次 `router.resolve` 把目标展开成结构化位置，还必须从注入上下文拿到 currentRoute。脱离路由实例，链接什么也算不出。

**这条权衡化解的本质矛盾**：扁平字符串表象 vs 立体路由对象。前者是 URL 给浏览器的接口，后者是路由系统的内部表示；任何判定如果停在字符串层，就注定吃掉所有结构信息。把判定下沉到结构层，是这个矛盾的通解。

### 激活松、精确激活紧的两档设计

把判定拆成松紧两档：

- **松档（isActive）**：记录在链上 + 当前参数**包含**目标参数（子集）。祖先链接天然成立。
- **紧档（isExactActive）**：在松档基础上，要求记录正好在链的**末端**、且参数**完全相等**。

**换来**的是「我在这一片」与「我精准在这一格」两种 UX 需求用同一组数据自然表达。菜单条只要高亮当前大类、面包屑末端要精确标记当前页，同一个链接同时给出两个布尔，使用方按需取用。

**代价**有两层。一是维护两套比较函数（子集 vs 全等），使用方要分别理解。二是这两套函数对「单值 vs 长度 1 数组」**刻意**做了不同处理：松档的子集比较要求严格同形态，单值和 `[v]` 视作不等；紧档的全等比较走更宽松的「等价数组」判定，单值和 `[v]` 视作等价。这种细微差异是为了让两档分别贴合各自的语义——松档要严守「父级不能凭参数形态蒙混成激活」，紧档要兼容「路径里单个参数在编码层被规整成数组」的常见情形。

**这条权衡化解的本质矛盾**：「范围归属感」vs「精确身份」。同一个链接在不同 UI 语境下要回答的不是同一个问题。菜单关心范围，面包屑关心精确身份；强行用一档布尔回答两个问题，必然有一边别扭。两档松紧就是把这两个问题显式拆开。

### 全部逻辑塞进组合式函数，组件退成薄壳

把「解析、判定、点击导航」全部塞进一个对外暴露的 `useLink` 组合式函数，组件本体只做一层 reactive 包装 + 渲染分叉。再加一个 `custom` 开关，连这层锚点壳也扒掉，把判定结果以插槽参数交还给使用者。

**换来**的是完全自定义渲染的能力：想把链接画成 `<li>`、画成按钮、画成带图标的卡片，都不必 fork 组件。

**代价**是组件 API 变成「函数 + 渲染」双形态。类型层得分叉处理：`custom: true` 时 props 不接受锚点属性（因为根本不画 `<a>`），`custom: false` 时透传 `target`、`rel` 等但禁止覆盖 `href`。使用者的认知成本因此分成两半——要么用默认壳，要么完全接管。

**这条权衡化解的本质矛盾**：「开箱即用」vs「完全可控」。任何 UI 组件都会撞上这对矛盾：给一套合理的默认值，就让深度定制者受限；完全裸露 internals，又让简单场景的使用者写一堆样板。把 headless 函数和薄壳组件并列对外暴露，是 Vue 生态里这对矛盾的标准解法。

## 5. 最小原理演示

下面这段几十行的实现，只演「结构化子集匹配」这一核心思想：matched 链查找、别名归一、子集与全等两档比较。点击拦截、视图过渡、类名优先级、aria-current 都不演。

```ts
type RouteRecord = { path: string; aliasOf?: RouteRecord }
type Params = Record<string, string | string[]>

// 别名归一：所有别名都回溯到原始记录再做引用相等
function isSameRouteRecord(a: RouteRecord, b: RouteRecord): boolean {
  return (a.aliasOf || a) === (b.aliasOf || b)
}

// 松档子集比较：遍历目标参数（inner），要求当前参数（outer）逐键匹配；
// 标量直接全等；数组必须同长度逐元素相等，刻意不做「单值 ≡ [v]」的退化
function includesParams(outer: Params, inner: Params): boolean {
  for (const key in inner) {
    const innerValue = inner[key]
    const outerValue = outer[key]
    if (typeof innerValue === 'string') {
      if (innerValue !== outerValue) return false
    } else {
      if (!Array.isArray(outerValue)) return false
      if (outerValue.length !== innerValue.length) return false
      if (innerValue.some((v, i) => v !== outerValue[i])) return false
    }
  }
  return true
}

// 紧档全等比较：键集合必须相同，但「单值 ≡ [v]」视作等价
function isSameRouteLocationParams(a: Params, b: Params): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    const av = a[key]
    const bv = b[key]
    const arrA = Array.isArray(av) ? av : [av]
    const arrB = Array.isArray(bv) ? bv : [bv]
    if (arrA.length !== arrB.length) return false
    if (arrA.some((v, i) => v !== arrB[i])) return false
  }
  return true
}

// 一条链接的判定全部状态
function useLinkActive(
  target: { matched: RouteRecord[]; params: Params },
  currentRoute: { matched: RouteRecord[]; params: Params }
) {
  // 取目标 matched 链末端记录，在当前链里找下标
  const endRecord = target.matched[target.matched.length - 1]
  let activeRecordIndex = currentRoute.matched.findIndex(r =>
    isSameRouteRecord(r, endRecord)
  )
  // 退化分支：找不到末端时试父记录（处理空子路由或同级兄弟的边界）
  if (activeRecordIndex < 0 && target.matched.length >= 2) {
    const parentRecord = target.matched[target.matched.length - 2]
    activeRecordIndex = currentRoute.matched.findIndex(r =>
      isSameRouteRecord(r, parentRecord)
    )
  }

  const isActive =
    activeRecordIndex > -1 &&
    includesParams(currentRoute.params, target.params)

  const isExactActive =
    activeRecordIndex > -1 &&
    activeRecordIndex === currentRoute.matched.length - 1 &&
    isSameRouteLocationParams(currentRoute.params, target.params)

  return { activeRecordIndex, isActive, isExactActive }
}
```

这段实现演了三件事：matched 链上的下标查找演「结构化匹配」、`includesParams` 演子集方向（outer 容许比 inner 多键）、`isSameRouteLocationParams` 演紧档对键集合的严格要求。两档对单值/数组的差异也写在代码里。

## 6. 执行轨迹

走一个具体例子。当前路由是 `/users/123/posts/456`，路由表里这条路径解析出：

```
currentRoute.matched = [users, user, post]
currentRoute.params   = { id: '123', postId: '456' }
```

页面上有一个链接，目标写成 `{ name: 'user', params: { id: '123' } }`，经 `router.resolve` 后展开成：

```
target.matched = [users, user]
target.params  = { id: '123' }
```

判定流程一步步走：

1. **找末端记录下标**：`target.matched` 末端是 `user`，在 `currentRoute.matched` 里 `findIndex` 命中下标 `1`。
2. **算松档 isActive**：`1 > -1` 成立；`includesParams({ id: '123', postId: '456' }, { id: '123' })` 遍历目标参数只有 `id`，当前参数逐键匹配 → `true`。**isActive = true**。
3. **算紧档 isExactActive**：`1 > -1` 成立；`1 === 3 - 1` 不成立（下标 1 不是链末端）。**isExactActive = false**。

结果：这个指向父级 `user` 的链接 active 但不是 exact active，正是「祖先链接算激活」的预期行为。如果改成链接指向 `/users/123/posts/456` 本身（末端 `post`、参数全等），两档都会同时成立。

## 7. 教学简化说明

上面的演示故意省略了一组不表达核心思想的细节：点击事件对修饰键/新标签/非左键的拦截（决定要不要把点击交还浏览器）、`router.push` 与 `router.replace` 的选择、视图过渡（`document.startViewTransition` 的可选包装）、devtools 把激活态暴露给 Vue 调试面板、`aria-current` 的取值规则、类名「prop > 全局 > 默认」的三级优先级，以及条件类型把「是否渲染原生 `<a>`」反映到 props 类型分叉的那一层。这些是工程完整度，不是激活判定的原理。

## 8. 小结

激活态判定的灵魂不在「比 URL」，而在「比结构」——把目标先 resolve 到 matched 链 + 参数的层面，再用「链上 + 子集」表达范围、用「链末端 + 全等」表达精确。两档松紧、别名归一、单值与数组的差异处理，都是为了让结构化判定在真实路由的别名、嵌套、参数形态面前不翻车。

下一章换轨：从「运行期怎么判定」转到「编译期怎么推导」——看类型系统怎么从路由表里反推出每个 `name` 对应的 params 形状，把拼写错误前移到 IDE 红波浪线。