# RouterLink 与激活态判定 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：导航类应用里，几乎每个页面都会有一排「当前在哪个页面」的高亮链接（顶部 Tab、侧边菜单、面包屑）。如果靠「当前 URL 是不是以这个链接的地址开头」来判断，会在带参数的动态路由、别名路由、嵌套子页面上一团糟：父链接该不该亮、参数变了还算不算在当前页、两个不同路径指向同一界面时怎么办。使用者要的不是「字符串长得像」，而是「我此刻确实在这个界面的范围内」。

- **一句话核心思想**：把「当前是否在这个链接上」从「URL 字符串前缀比较」换成「目标记录是否落在当前匹配链上，且目标参数是否是当前参数的子集」的结构化判定。

- **设计动机（为什么需要它）**：这个机制要解决的矛盾是——「URL 字符串」是给人/浏览器看的扁平表象，而「路由位置」在内部是带父子层级（匹配记录链）、带结构化参数、还可能带别名的立体对象；用扁平字符串去比立体对象必然失真。它换来的能力是：祖先链接天然算「激活」、只有真正命中末端且参数全等才算「精确激活」、别名路由自动归一、参数是数组还是单值都不影响判定。
  - **承前（跨章去重信号）**：本章复用的「把链接地址解析成结构化位置（含匹配记录链 + 参数）」来自前置章『Router 核心与导航主循环』的解析器（链接只是它的一个消费者，本章只看「消费侧」这个新侧面）；本章复用的「按记录引用相等 + 参数结构判定两个位置关系」来自前置章『路由位置与 URL 解析』（那章用它判定「同一位置」做导航短路，本章只看它的**新侧面**：把「全等」松绑成「子集」，从而表达「祖先/包含」关系）。Writer 讲激活判定时，不要再重讲「匹配记录链是怎么 resolve 出来的」「两个位置怎么算相等」，直接复用前置章结论，聚焦「全等 → 子集」这一步松绑。

- **关键权衡（核心原料，3 条）**：
  1. **结构化匹配 vs URL 字符串前缀**：选择用「目标末端记录是否出现在当前匹配链里 + 参数子集」判定激活 → 换来了别名（同一界面的多个路径）天然正确、参数的数组/编码形态不影响判定、嵌套父子关系精确 → 代价是必须先把链接解析成结构化位置、必须依赖注入到的路由上下文，不能纯靠两个字符串就算出来。
  2. **激活用「子集」、精确激活用「全等」+「必须在末端」**：选择把激活判定拆成松紧两档——松档只要「记录在链上 + 链接参数是当前参数的子集」（于是祖先链接自动亮）；紧档额外要求「记录正好在链的最后一格 + 参数完全相等」 → 换来了「范围高亮」与「精确命中」两种 UX 需求用同一套数据自然表达 → 代价是维护两套比较函数，且松档的子集比较刻意**不**做「单值数组等价」（数组必须同长度逐元素相等），与紧档的全等比较行为有细微差异，使用者要分别理解。
  3. **把全部行为抽成无渲染的组合式函数 vs 组件内置**：选择把「解析、激活判定、点击导航」全部塞进一个对外暴露的组合式函数，组件本体退成一层薄壳渲染器（外加一个「自定义渲染」开关把薄壳也扒掉） → 换来了使用者可以完全自定义链接长相（按钮、列表项、复杂结构）而不必 fork 组件 → 代价是组件 API 变成「函数 + 渲染」双形态，类型上还得为「是否渲染原生锚点标签」单独分叉。

- **最小心智模型（6 步）**：
  1. 使用者给链接一个目标（字符串或位置对象）。
  2. 链接用注入到的路由上下文，把目标解析成结构化位置：一条匹配记录链 + 一组参数 + 一个 href。
  3. 判「记录是否在链上」：取目标匹配链的末端记录，去当前匹配链里找它的下标；找不到时再试「父记录」（处理空子路由/同级兄弟的退化）。
  4. 判「激活」：下标 ≥ 0 且当前参数**包含**目标参数（子集）。
  5. 判「精确激活」：在激活基础上，下标正好是当前链最后一格、且参数**完全相等**。
  6. 渲染：自定义开关打开则把判定结果交回插槽由使用者画，否则画一个原生锚点标签，用激活/精确激活驱动类名与无障碍属性；点击先过拦截（修饰键/新标签/非左键一律放行给浏览器），通过才阻止默认行为并触发内部导航。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的从零实现，演「结构化子集匹配」这一核心思想。要素：(a) 一条「当前匹配记录链」+「当前参数」；(b) 记录带别名指针，相等判定时归一到原始记录；(c) 一个「子集比较」（遍历目标参数，要求当前参数逐键匹配，但允许当前参数多带键）；(d) `isActive = 末端记录在链上 && 子集成立`、`isExactActive = 在链末端 && 参数全等`。明确写出：**这段演的是权衡 #1（结构化 vs 字符串）和 #2（子集 vs 全等的两档松紧）**，配一个「当前在 `/users/123/posts/456`，链接指向 `/users/123`」的断言，验证「祖先链接 active 但非 exact」。
  - **应故意省略**：点击拦截（修饰键/target 等）、视图过渡、devtools 上下文、类名三级优先级、无障碍属性的可选取值、条件类型那套 props 分叉、HMR/SSR 适配——这些都不表达核心思想。
  - **演示载体建议**：**首选 TS/JS**。本章核心是「数据结构上的子集/全等判定 + 别名归一 + 匹配链查找」，纯属算法/数据结构层面的原理，TS/JS 完全能忠实演透，且本 Atlas 产物就是 JS 生态站点，读者最易跑通。配最小 `package.json` 用 `node`/`bun run` 直接断言即可。**无需**退回原仓库语言（Vue 单文件组件只是壳，不承载原理）。

- **正文不宜展开的细节（供 Writer 裁剪）**：条件类型把「是否渲染原生锚点」反映到 props 类型（自定义模式不接受锚点属性）；devtools 上下文把激活态暴露给 Vue 调试面板（带 `flush:'post'` 的 watchEffect）；点击拦截里「Weex 事件可能没有 preventDefault」这类历史兼容注释；视图过渡可选地把导航 promise 包进 `document.startViewTransition`；`aria-current` 的六种合法取值与默认 `'page'`；类名「prop > 全局 > 默认」的三级优先。

- **推荐的一个执行轨迹例子**：当前路由 `/users/123/posts/456`（匹配链 = `[users, user, post]`，参数 = `{id:'123', postId:'456'}`），有一个链接指向 `{name:'user', params:{id:'123'}}`（解析后匹配链 = `[users, user]`，参数 = `{id:'123'}`）。查末端记录 `user` → 在当前链下标 1（≥0）；激活：当前参数 `{id:'123',postId:'456'}` 包含目标 `{id:'123'}` → 真；精确激活：下标 1 ≠ 链长 3-1 → 假。**结果：该链接 active 但非 exact active**——这正是「祖先链接算激活」的预期行为。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **headless 抽象**：所有逻辑都在一个对外暴露的组合式函数里实现，返回 `{ route, href, isActive, isExactActive, navigate }`；组件 setup 只做 `reactive(useLink(props))` 再渲染。源码位置: packages/router/src/RouterLink.ts:135-260, 288-289

- **解析成结构化位置**：用 `computed` 把目标经 `router.resolve(to)` 变成结构化位置（含 matched 链 + params + href），dev 下还会校验目标是否真的是合法路由位置（否则上报诊断码 R0050）。源码位置: packages/router/src/RouterLink.ts:144-157

- **「记录是否在链上」的下标计算**：取目标 matched 链的末端 record，在 `currentRoute.matched` 里 `findIndex`；找不到时退化去试父 record（处理「父与子 path 相同」即空子路由 / 当前在同级兄弟的退化情形），整个 computed 返回一个下标（-1 表示不在链上）。源码位置: packages/router/src/RouterLink.ts:159-187

- **激活（松档）= 在链上 + 参数子集**：`activeRecordIndex > -1 && includesParams(currentRoute.params, route.params)`。源码位置: packages/router/src/RouterLink.ts:189-193

- **精确激活（紧档）= 在链末端 + 参数全等**：`activeRecordIndex > -1 && activeRecordIndex === currentRoute.matched.length - 1 && isSameRouteLocationParams(currentRoute.params, route.params)`。源码位置: packages/router/src/RouterLink.ts:194-199

- **子集比较的语义**：遍历的是**目标**参数（inner），要求**当前**参数（outer）逐键匹配；outer 可以多带 inner 没有的键（故祖先链接成立）。标量直接全等；数组要求 outer 也是同长度数组且逐元素相等——**刻意不做**「单值 ≡ 长度1数组」的退化等价。源码位置: packages/router/src/RouterLink.ts:408-430

- **记录相等的别名归一**：`isSameRouteRecord` 比较 `(a.aliasOf || a) === (b.aliasOf || b)`，即所有别名都回溯到原始 record 比较——这是别名路由也能正确判激活的关键。源码位置: packages/router/src/location.ts:198-203

- **全等比较的语义（紧档用）**：先比键数长度，再逐键比；值比较支持「单值 ≡ 长度1数组」的退化（`isEquivalentArray`），行为比上面的子集比较更宽松。源码位置: packages/router/src/location.ts:205-228

- **点击拦截后才导航**：拦截放行条件——任一修饰键(meta/alt/ctrl/shift)按下、`defaultPrevented`、非左键(button≠0)、`target="_blank"`，任一成立即「不劫持」交还浏览器；全部不成立才 `preventDefault` 并按 replace/普通 选择 `router.replace`/`router.push`。源码位置: packages/router/src/RouterLink.ts:201-219, 388-406

- **渲染分叉**：`custom` 为真时直接返回插槽 children（不画 `<a>`）；否则画 `<a>`，`aria-current` 仅精确激活时取 `ariaCurrentValue`（默认 `'page'`），`onClick` 绑到 navigate，class 由两级激活态驱动。源码位置: packages/router/src/RouterLink.ts:310-328

- **类名三级优先**：`getLinkClass(propClass, globalClass, defaultClass)` —— prop 级 > 全局 `linkActiveClass`/`linkExactActiveClass` > 内置默认 `router-link-active`/`router-link-exact-active`。源码位置: packages/router/src/RouterLink.ts:292-308, 446-455

- **类型层把「是否渲染 `<a>`」反映到 props**：`custom: true` 时 props 不带锚点属性；否则 `& Omit<AnchorHTMLAttributes,'href'>`（透传 target 等，但禁止覆盖 href）。源码位置: packages/router/src/RouterLink.ts:350-386

## 关键调用链

`useLink(props)` → `inject(routerKey)`/`inject(routeLocationKey)` 取上下文（前置章 install 注入）
  → `computed(router.resolve(unref(props.to)))` 得结构化位置 + href
  → `activeRecordIndex` computed：`currentRoute.matched.findIndex(isSameRouteRecord(末端record))`（退化试父 record）
  → `isActive` = index>-1 && `includesParams(current.params, link.params)`
  → `isExactActive` = index>-1 && index===matched.length-1 && `isSameRouteLocationParams(current.params, link.params)`
组件 setup：`reactive(useLink(props))` → 渲染分叉（custom 走插槽，否则 `<a>` + class + aria-current + onClick=navigate）
点击：`navigate(e)` → `guardEvent(e)` 拦截 → `router.push|replace(to).catch(noop)`（可选包 `startViewTransition`）
源码位置: packages/router/src/RouterLink.ts:135-219, 288-329

## 源码摘录（带行号，全文累计 ≤ 30 行）

激活判定的松紧两档（演权衡 #2）：

```ts
  const isActive = computed<boolean>(
    () =>
      activeRecordIndex.value > -1 &&
      includesParams(currentRoute.params, route.value.params)
  )
  const isExactActive = computed<boolean>(
    () =>
      activeRecordIndex.value > -1 &&
      activeRecordIndex.value === currentRoute.matched.length - 1 &&
      isSameRouteLocationParams(currentRoute.params, route.value.params)
  )
```
源码位置: packages/router/src/RouterLink.ts:189-199

子集比较主体（演权衡 #1/#2：遍历 inner、标量全等、数组同长度逐元素、不做单值退化）：

```ts
  for (const key in inner) {
    const innerValue = inner[key]
    const outerValue = outer[key]
    if (typeof innerValue === 'string') {
      if (innerValue !== outerValue) return false
    } else {
      if (
        !isArray(outerValue) ||
        outerValue.length !== innerValue.length ||
        innerValue.some(
          (value, i) => value.valueOf() !== outerValue[i].valueOf()
        )
      )
        return false
    }
  }

  return true
```
源码位置: packages/router/src/RouterLink.ts:412-429

## 易混淆 / 边界 / 推断

- **事实**：松档（`includesParams`）遍历 inner（目标参数），故「当前参数是目标参数的超集」时成立——这是祖先链接激活的根因；紧档（`isSameRouteLocationParams`）先比键数长度，故要求「键集合完全相同」。两者对「单值 vs 长度1数组」的处理不一致：紧档视作等价、松档视作不等价。源码位置: packages/router/src/RouterLink.ts:408-430, packages/router/src/location.ts:205-228

- **事实**：`activeRecordIndex` 的「退化试父 record」分支只在「父与子 path 相同」时触发（典型是链接指向一个无 path 的空子路由，或当前位于同一父的另一子路由）；这是为嵌套路由的边界情形补的洞，不是主路径。源码位置: packages/router/src/RouterLink.ts:170-186

- **事实**：`navigate` 的 promise 用 `.catch(noop)` 吞掉——导航失败（含被守卫中止/被新导航取消）已在路由核心层上报，这里不重复抛未捕获异常。源码位置: packages/router/src/RouterLink.ts:205-208

- **推断**：`isSameRouteRecord` 用引用相等（`===`）而非 path 字符串，加上 `aliasOf` 归一，意味着「判定激活」依赖「同一 record 对象实例在 matched 链里复用」这一前置不变式（由 matcher 解析期保证）；若两条不同路径解析出不同 record 实例，即便 path 相同也不会被判为同一记录——标注为推断，需对照 matcher 章确认。

- **未理解**：`getOriginalPath` 在退化分支里用于比较父/子 path 是否相同，但其返回值对 `aliasOf` record 取的是 `aliasOf.path`，与 `isSameRouteRecord` 的别名归一逻辑不在同一抽象层——这两处对别名的处理是否在所有别名嵌套组合下一致，未在源码内找到对应测试佐证，留给 Critic/Writer 核对。源码位置: packages/router/src/RouterLink.ts:170-186, 436-438