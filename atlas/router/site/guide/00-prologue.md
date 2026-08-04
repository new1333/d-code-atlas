# 导读：vue-router 源码解读

## 这本书在讲什么：一句话主线

你大概写过 `router.push({ name: 'usr' })`，把 `user` 少打一个字母，浏览器白屏；或者点浏览器后退，页面"啪"地跳回顶部而不是停在你刚才看的那一行；又或者连点两次导航，屏幕闪了一下跳回旧页。一个单页应用的路由器，到底在替你解决哪些别人没解决好的麻烦？

把全书十六章读下来，能凝成这么一句话——**vue-router 把"路由"从一串扁平的 URL 字符串，重新解释成一个结构化的对象：一条从根到叶排好序的 matched 记录链，外加解码后的参数。这条链一旦立起来，"我是不还在原地""该渲染哪几层组件""哪些链接该高亮""哪些守卫该跑"就都不再靠比字符串，而是靠这条链的引用、包含、下标关系精确得出。**

打个比方（只用这一次）：URL 字符串像是信封上一行扁平的地址 `/users/42/posts/7`；而 matched 链像是把这栋楼拆成"第几街区 → 第几栋 → 第几间"的层级坐标，外加每层一个门牌号（params）。要判断"我现在是不是在用户这片区域"，比坐标显然比比字符串前缀靠谱。

这条 matched 链是全书的脊柱。围绕它，十六章做了三件贯穿始终、互不相干却彼此呼应的事：

- **把能提前算好的全部前移**——评分在注册期算、匹配表在注册期编译、类型在构建期推导、路由表在新解析器里干脆构建期定死。运行期的热路径，几乎只剩一次正则命中、一次指针回溯。
- **把一切中断和失败做成可分类、可恢复的结构化值**——失败带种类位标志、重定向复用失败通道、取消是可恢复值而非异常、"没匹配上"在新解析器里是一次可抛的异常。它们都不再是笼统地 `throw`。
- **把又长又异步的导航做成一个可随时取消的状态机**——一块谁都能看到的"公共白板"记下当前在途的那条导航，再在每个阶段之间插一道身份校验："我还是最新那次操作吗？"

这三件事如何分解到各 layer、各章：

- `primitive`（第 1–5 章）负责把 URL 和配置各自拆成可用的零件——怎么编解码、怎么定义"同一位置"、怎么给模式评分、怎么给失败建模、怎么把浏览器 history 包成窄接口。
- `composite`（第 6–11 章）把这些零件总装成一台能跑的导航机器——匹配表、守卫管线、滚动恢复、导航主循环、嵌套视图、激活链接。
- `system`（第 12–16 章）再把动态性和正确性尽量往前推——编译期类型推导、文件路由、导航期数据加载、新一代解析器，最后由文件路由的类型生成把整条线收口。

## 怎么读这本书：两条阅读路线

### 一、线性路线（按 `topoOrder` 从头读到尾）

这是一条"先造零件、再总装、最后推前"的路线，每章承接上一章打开的缺口：

1. **url-encoding-query** — 先把地基铺平：URL 怎么按段安全编解码，以及用 `null`/`undefined` 区分查询串里两种"没有"。
2. **route-location-url** — 承接编码能力，把 URL 拆成 path/query/hash，并定义什么叫"同一个位置"——为后面的重复导航短路铺好语义。
3. **path-pattern-ranking** — 转向配置侧：路径模式怎么用状态机拆词、怎么从模式本身派生"具体性评分"，把"谁该优先"从声明顺序里摘出来。
4. **navigation-failure-types** — 打开另一个缺口：导航"没走到底"该怎么表达，才不污染错误通道。
5. **history-abstraction** — 把浏览器那套靠不住的历史接口，包成一个带方向账本的窄接口，三种实现透明可换。
6. **route-matcher-table** — 把第 3 章的分数和第 4 章的失败值接起来：配置树摊平成带父指针的有序表，一次命中再沿指针反推出 matched 链。
7. **navigation-guards** — 拿着 matched 链切离开/更新/进入三组，把守卫统一成 Promise 顺序链，任一 reject 即短路。
8. **scroll-restoration** — 把"滚到哪"绑死在导航生命周期的特定时刻，靠 `position − delta` 让存取对称。
9. **router-core-navigation** — 总装高潮：一块公共白板加几道闸门，把又长又异步的导航变成可取消的状态机。
10. **router-view-nesting** — 凭 matched 链 + 一个往下传的 depth 整数，零配置渲染任意深的嵌套视图。
11. **router-link-active** — 同一条 matched 链的另一种消费：用"链包含 + params 子集"判定激活态。
12. **typed-routes** — 跳到编译期：留一个空接口当类型插槽，让构建产物把精确路由表"反向注入"进来。
13. **file-routing-conventions** — 用前缀树装拓扑，用分桶意见表让四个来源的元数据读时深合并。
14. **data-loaders** — 把取数据从组件挂载后挪到导航确认前，用暂存→提交两阶段让数据跟着导航走。
15. **route-resolver** — 换个视角看匹配：把"没匹配上"做成异常，把类型校验下沉到匹配层，对照第 6 章的评分排序树。
16. **file-routing-codegen** — 闭环全书：同一棵路由树一次性投影成运行时数组、类型表、固定匹配器三种产物。

### 二、按主题路线（带着具体问题进来）

- **"导航到底怎么跑、又怎么被取消的"**：route-location-url（判等）→ navigation-failure-types（失败值）→ navigation-guards（守卫链）→ router-core-navigation（主循环与取消）。这是 vue-router 运行时的心脏四 章。
- **"路由怎么匹配，撞车了谁优先"**：path-pattern-ranking（评分怎么来）→ route-matcher-table（匹配表怎么用分数）→ route-resolver（新一代解析器为什么干脆砍掉评分）。
- **"我想要类型安全"**：typed-routes（消费侧：注入与开关）→ file-routing-codegen（生成侧：谁把精确类型贴进公告板）。
- **"我用文件路由，想知道它背后干了什么"**：file-routing-conventions（约定与前缀树）→ file-routing-codegen（类型生成与热更新）。
- **"视图怎么渲染、链接怎么高亮"**：router-view-nesting（嵌套渲染）→ router-link-active（激活判定）。这两章是同一条 matched 链的两种消费方式，连读最见贯通。
- **"底层数据模型——URL、位置、历史"**：url-encoding-query → route-location-url → history-abstraction。
- **"数据获取和滚动怎么和导航生命周期绑住"**：scroll-restoration → data-loaders。两者用的是同一套"绑导航、防串页"的思路。

## 贯穿全书的核心原理

这几条原理在多章以不同化身反复现身。一旦你认出"这其实是同一个原理的又一次现身"，理解就会贯通。

1. **结构化语义优先于字符串表象（matched 链是脊柱）**。本质：路由在内部是个带父子层级、带结构化参数、还可能带别名的立体对象；拿扁平字符串去比立体对象必然失真。现身：route-location-url（判"同一位置"不比字符串比 matched 链引用相等）、route-matcher-table（构建这条链）、navigation-guards（凭记录引用切离开/更新/进入三组）、router-view-nesting（凭 `matched[depth]` 选组件）、router-link-active（matched 链包含 + params 子集判激活）。
2. **把能在构建期/注册期算好的全部前移，让运行期热路径极简**。本质：贵的一次性工作压到配置或构建阶段，导航时只剩最便宜的查找。现身：path-pattern-ranking（注册期拆词算分排序）、route-matcher-table（注册期预编译成有序表，运行期一次命中）、route-resolver（构建期固定路由表，运行期顺序试错）、file-routing-codegen（一棵树多投影到运行时/类型/匹配器）、typed-routes（把正确性前移到编译期由 tsc 拦下）、data-loaders（把数据获取从组件挂载后挪到导航确认前）。
3. **把中断和失败做成可分类、可恢复的结构化控制流**。本质：不笼统 `throw`，而是让"没成功"自带种类、能被上层精确消费。现身：navigation-failure-types（失败值带位标志 + Symbol 标记，走 return 不走 throw）、navigation-guards（放行/拒绝/重定向三种意图 = resolve / 带不同种类的 reject）、router-core-navigation（取消是可恢复值，绝不被当成未捕获异常）、route-resolver（"没匹配上"抛专用异常 `MatchMiss`，类型校验失败即落选——同一思路的镜像化身）。
4. **可取消异步：公共在途令牌 + "我还是不是最新那次"的身份校验**。本质：又长又异步的操作随时可能被新操作打断，靠一个谁都能看到的"当前在途"标记 + 几次引用比较来作废旧操作。现身：router-core-navigation（`pendingLocation` 公共白板 + 阶段间手动闸门）、data-loaders（`navId` 身份校验，迟到的旧请求连暂存都进不去、回滚不了新数据）、scroll-restoration（应用滚动前再校验 `to === currentRoute`，防连点导航把旧页滚动误投到新页）。
5. **分段/分桶 + 读时合并，而非一刀切或写时覆盖**。本质：不同来源、不同段落脾气不同，硬塞进一套规则会互相打架；分开存放、读取时再按规矩揉成一份。现身：url-encoding-query（按 path/param/query/hash 段细分保留字符集）、file-routing-conventions（每个元数据来源各占一桶、读时按座次深合并）、route-resolver（path 排他、query 沿链合并、hash 只看最深，三段各管各）、data-loaders（`staged` 暂存与 `data` 可见两阶段隔离）。
6. **窄接口/深模块 + 反向注入（细节交给消费方决定）**。本质：门面做窄、把"怎么翻译"的细节倒置给外面塞进来。现身：history-abstraction（六个方法的 `RouterHistory` 窄接口，三种实现透明可换）、route-location-url（`parseQuery` 作为参数注入，编码责任整个倒置）、typed-routes + file-routing-codegen（空 `TypesConfig` 接口 + `declare module` 模块增强，让构建产物反向修改库类型）、router-view-nesting（`provide`/`inject` 把 depth 沿组件树向下递）。

## 全书脉络图

下图按 layer 分三层，依赖箭头严格来自 `outline.json` 的 `dependsOn`，没有臆造新的依赖边。读法：上层章节依赖下层（含同层）章节；越靠下的越是地基，越靠上的越是"把动态性推前"的系统层能力。

```text
═══════════════════════ primitive（地基零件，5 章）═══════════════════════
  三个零依赖地基：  url-encoding-query    path-pattern-ranking    navigation-failure-types
                          │                      │                        │
        route-location-url ┘ (← url-encoding-query)                       │
                │                                                          │
        history-abstraction ┘ (← route-location-url)                       │
                                                                          │
═══════════════════════ composite（总装成机器，6 章）══════════════════════
  route-matcher-table ──────┬──── (← path-pattern-ranking, navigation-failure-types)
                             │
  navigation-guards ────────┴──── (← route-matcher-table, navigation-failure-types)
                             │
  scroll-restoration ─────────── (← history-abstraction, route-location-url)
                             │
  router-core-navigation ──┬── (← route-matcher-table, history-abstraction,
                             │      navigation-guards, navigation-failure-types,
                             │      scroll-restoration, route-location-url)   ← 全书枢纽
                             │
  router-view-nesting ─────── (← router-core-navigation, route-matcher-table)
  router-link-active ──────── (← router-core-navigation)
                             │
═══════════════════════ system（把动态性/正确性推前，5 章）════════════════
  typed-routes ────────────── (← route-matcher-table, navigation-guards, router-core-navigation)
  file-routing-conventions ── (← route-matcher-table)
  data-loaders ────────────── (← router-core-navigation, navigation-guards)
  route-resolver ──────────── (← route-matcher-table, url-encoding-query)   ← 绕回最底层编码
                             │
  file-routing-codegen ────── (← file-routing-conventions, typed-routes, route-resolver)  ← 闭环
```

几个一眼能看出的结构特征：`router-core-navigation` 是全书依赖最重的枢纽（它一把抓了前面六块零件），所以读它之前最好先把 composite 下半段都过一遍；`route-resolver` 看似在最高的 system 层，却直接依赖最底层的 `url-encoding-query`——这正是它"把编码责任重新拆给 path/param 两套"的写照；`file-routing-codegen` 同时依赖 `file-routing-conventions`、`typed-routes`、`route-resolver` 三者，是全书收口的最后一钉，把"构建期固定路由表 + 类型前移 + 编译期正确性"缝成一个闭环。