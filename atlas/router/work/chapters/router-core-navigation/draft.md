# Router 核心与导航主循环

> 本章属于 composite 层。前置：路由匹配表、History 抽象、导航守卫管线、导航失败的语义化分类、滚动位置恢复、路由位置与 URL 解析。
> 学完你能：用一句话讲清「为什么用一个可变在途令牌 + 手动散布的检查点，就能把一条不可预测的异步守卫链变成随时可取消的状态机」。

## 1. 为什么需要它

上一章把滚动可见性绑到了导航生命周期上：滚动该恢复时由导航收尾触发，而不是由数据到达触发。但滚动只是一个「零件」。前面几章还造好了别的零件：守卫怎么串成 promise 链、失败怎么分类、URL 怎么抽象、位置怎么判等。它们各自都讲清楚了，却没人回答两件事：一是谁来按顺序调用它们、并在一切就绪后把结果同时落到 URL、状态与视图上；二是谁来在异步让出执行权的空窗里，判定一条导航已经过期。

想象用户在 `/a` 页面快速连点：先点了 `/b`，B 的进入守卫要 `await import('/b-chunk.js')`；50 毫秒还没到，用户又点了 `/c`。如果没人管这件事会发生什么？B 的守卫在 50 毫秒后恢复，继续往下走，把它自己的 URL、组件、滚动强加到当前页面——而用户已经明确表达了「我要去 /c」。这就是幽灵导航：旧导航的回魂把新页面的状态覆盖成它自己的样子。

要解决它，就得有一台机器干两件事：一是把零件按顺序编排起来，让守卫、滚动、URL、状态各在其位；二是在每两个阶段之间插一个「检查站」，让任何阶段都能被新导航作废，最后才把成功通过的结果落到 URL、`currentRoute` 和视图上。这台机器就是本章的主角。

## 2. 核心思想

**把「异步取消」这个看似复杂的问题，降维成「一个共享令牌的引用比较」问题。**

整条守卫链不需要 AbortController，也不需要给每个 promise 注入取消方法。它只需要一个**闭包级的可变变量**——`pendingLocation`——记录「现在在途的是哪一条导航」。每个阶段跑完都看一眼：令牌还是不是我？不是我，立刻短路；是我，继续。

打个比方：想象小餐馆厨房的订单夹。每个新订单挂上去就代表「正在做」，新订单来时旧订单还挂在上面没擦掉——但厨师每开始下一步都会瞄一眼，发现最上面那张不是自己手里的单，立刻丢掉手里这盘菜。整条流水线不需要任何人去「通知」旧厨师停下，只需要订单夹是大家共享的就行。`pendingLocation` 就是这张订单夹。

## 3. 心智模型

主循环是一个状态机，由几个角色协作：

- **在途令牌 `pendingLocation`**：闭包级可变变量，承载「当前占有在途的目标位置」。
- **当前路由 `currentRoute`**：浅响应 ref，承载「已经落定、视图正在渲染」的位置。
- **起始哨兵 `START_LOCATION_NORMALIZED`**：两者初始化时都指向它，标志「还没发生过导航」。

主循环的入口分两条：编程导航（`push`/`replace`）和浏览器导航（前进/后退经 `history.listen` 回调进入）。两条入口都汇到同一个四段式：

```
pushWithRedirect        ← 入口、令牌占有、重定向递归、重复短路
  ↓
navigate                ← 串守卫队列、阶段间检查
  ↓
finalizeNavigation      ← 改 URL、浅替换 currentRoute、滚动、宣告就绪
  ↓
triggerAfterEach        ← 通知全局后置钩子（不阻塞）
```

第一次导航落定时（无论成功失败），`markAsReady` 才会把 history 监听器挂上去——在此之前浏览器的前进/后退暂时不在意，因为这本就是不该有的「未就绪」窗口。

## 4. 关键权衡

### 单一可变令牌换无需 AbortController 的取消语义

异步取消在通用层面是一件难事：`Promise` 一旦创建就不可撤销，AbortController 要层层透传，取消 token 要污染每个异步函数的签名。本章没走任何一条路，而是选了**闭包里的一个可变变量 + 阶段之间手动散布的检查点**。

换来的是：取消退化成一次引用比较 `pendingLocation !== to`，整条 promise 链只要检查不通过就抛 `NAVIGATION_CANCELLED` 自动短路。它天然兼容守卫章把旧式 `next` 回调 promise 化那套链——因为取消根本不进 promise 内部，只在 promise 链的接缝处检查。

代价是检查点的位置是**手动**塞进每个阶段之间的：离开守卫之后、全局前置之后、更新之后、进入前之后、进入之后、解析前之后，六个位置各 push 一次取消检查函数到守卫队列里，收尾函数开头再查一次。这种「裸的显式插入」换来了清晰可读（每个检查点的位置一眼可见、不会吞掉守卫自己的异常），代价是新增一个阶段必须记得补一次检查，漏一个就会有幽灵导航。这是「显式优于魔法」与「容易漏写」之间典型的一次权衡。

讲透本质矛盾：异步取消要求「随时可外部干预」，而 promise 模型本质是「一旦发起就不可撤销」。把不可撤销的链条截成可撤销的小段、用共享状态串联，是这类问题的一个通解骨架，不止导航——搜索框 debounce、连续表单提交、切换标签页拉数据，凡是「异步链 + 可被新事件取代」的场景都可以套这个模式。

### shallowRef 整体替换换视图更新的可控边界

`currentRoute` 没用 `ref` 或 `reactive`，而是 `shallowRef(START_LOCATION_NORMALIZED)`。这意味着只有 `.value = newObj` 这种**整体替换**才会触发响应式更新；matched 数组里某个组件实例的变化、params 对象里某个字段的变化都不会被深响应捕获。

换来的是：组件树不会因为路由内部某个细节变动而频繁重渲染。视图只在「整条路由切换」时更新，这正是路由该有的语义。

代价是：消费者不能 mutate `currentRoute.value.params.id = '123'` 来期待视图更新，必须整体替换引用。Options API 还更麻烦：`$route` 是个挂在全局属性上的 getter，模板里访问 `$route.params.id` 时模板的渲染 effect 抓的是 `$route` 这个 getter 返回的对象。为了在 Options API 下也能正确响应，主循环额外构造了一个 `shallowReactive` 的代理对象，对每个字段定义 getter 重新指向 `currentRoute.value[key]`，让两层引用都保持响应。

讲透本质矛盾：响应式系统希望「精细到字段」的依赖追踪，而路由语义希望「整条切换」的可见性边界。用 shallow 加字段代理双管齐下，是「领域语义优先于响应式原语默认行为」的典型取舍。

### 监听器延迟挂载换就绪协议

`setupListeners`（也就是把 `routerHistory.listen` 真正挂上、开始接管浏览器前进/后退）**不在构造期挂**，而是推迟到首次导航落定的 `markAsReady` 里才挂。

换来的是：初始导航的 `push(routerHistory.location)` 不会被自己挂的 listen 回调当成浏览器导航再触发一次；多个 app 共用一个 router 时也不会重复挂载（`removeHistoryListener` 守卫加 `started` 标志双保险）。同时 `isReady()` 给了上层一个明确的「现在 router 可以接受用户交互了」的 promise 时间点，SSR 时这个时间点尤其关键。

代价是：就绪之前浏览器的前进/后退确实不会被捕获。但这是一个本就该避免的窗口期——用户面对一个还没完成首次导航的页面，谈不上交互；把就绪 promise 暴露出去，正好把「现在才可交互」这件事讲清楚。

讲透本质矛盾：模块初始化希望「构造完即就绪」，而浏览器导航的接入希望「先让初始 URL 落定再开始监听」。把监听推迟到首次导航落定之后，是用「一次性的就绪门」换取「初始导航不被自触发」。任何「自身既是事件源又是事件消费者」的系统都要解决这种自激问题。

### 诊断码目录换 tree-shake 与永久稳定

所有运行时警告集中在 `defineDiagnostics({ codes })` 目录里，每条码有四件事：稳定的 `VUE_ROUTER_R####` 编号、`why`（只讲问题不讲补救）、`fix`（只讲补救不重复问题）、可选的 `docs` 链接。调用点全是 `diagnostics.X({...})` 这种裸表达式语句，包在 `__DEV__` 守卫后。

换来的是：生产构建能把整本诊断目录 tree-shake 掉（裸表达式语句没有返回值依赖，最小化器可以放心删）；码号永久稳定，可以被测试断言、可以被生产错误日志反查；`why/fix` 严格分工让两条信息互补而不重复。

代价是：每加一条诊断都得维护码号加双字段加文档链接；调用语法被约束成不能依赖返回值。这是「工程化的纪律」换「可观测性的长期价值」的取舍。

讲透本质矛盾：开发者希望诊断调用「就地、自由、可表达」，而长期维护希望诊断「集中、可裁剪、可索引」。用目录加裸表达式调用，把自由表达上交成纪律，换长期的可维护性。

## 5. 最小原理演示

下面这段代码只演示核心思想：**一个可变令牌 + 阶段间手动检查 = 可取消的异步导航**。它故意省略守卫 arity 切换、重定向递归、滚动、URL 编解码、Vue 响应式、history 三实现、devtools——这些都是旁路与工程化。

```ts
// 演透：单一可变令牌 + 阶段间引用比较 = 可取消的异步导航
// 演的是「单令牌 + 手动插桩」换来「无需 AbortController 即可作废整条 promise 链」

let pending: string | null = null                  // 唯一的「在途导航」令牌

const assertStillCurrent = (to: string) => {
  // 引用比较：令牌已不是我 → 我已被新导航取代
  if (pending !== to) throw Error(`CANCELLED: ${to} 被 ${pending} 取代`)
}

async function runPhases(to: string, phases: (() => Promise<void>)[]) {
  for (const phase of phases) {
    await phase()                                  // 跑完一个阶段
    assertStillCurrent(to)                         // 在下一段之前手动插一次检查
  }
}

async function navigate(to: string, phases: (() => Promise<void>)[]) {
  pending = to                                     // 占有令牌：宣告「现在在途的是我」
  try {
    await runPhases(to, phases)
    assertStillCurrent(to)                         // 收尾前最后一次检查
    console.log(`✅ commit ${to}`)                 // 收尾：把结果落到 URL / 状态 / 视图
  } catch (e) {
    console.log(`⚠️ ${(e as Error).message}`)      // 取消/失败：什么都不落
  }
}

const slow = () => new Promise<void>(r => setTimeout(r, 50))

navigate('/a', [slow, slow])                       // A 启动，守卫很慢
setTimeout(() => navigate('/b', [slow]), 10)       // 10ms 后 B 抢占 → 把令牌改成 /b
// 期望输出：
// ⚠️ CANCELLED: /a 被 /b 取代
// ✅ commit /b
```

读这段代码时盯住一件事：`navigate('/b', ...)` 没有去「通知」`navigate('/a', ...)` 要停下来，它只是改写了 `pending`。A 的取消完全发生在 A 自己的 `assertStillCurrent` 检查里。这就是「把异步取消降维成共享令牌的引用比较」的全部含义。

## 6. 执行轨迹

用户在 `/a` 页面（已经渲染完成）快速连点两次：先 `push('/b')`，B 的进入守卫要 `await import('/b-chunk.js')` 拉懒 chunk；约 10 毫秒后 `push('/c')`，C 守卫很快通过。

时刻 T0：`push('/b')` 进入主循环。

- `pushWithRedirect` 把 `/b` resolve 成完整位置，`pendingLocation` 改写成 `/b`，完成令牌占有。
- 没有重定向，与当前位置 `/a` 不等。
- 进入 `navigate`：离开守卫跑完，检查通过（`pendingLocation === /b`）；全局前置跑完，检查通过；进入守卫开始 `await import('/b-chunk.js')`，B 让出执行权。

时刻 T1（T0 之后约 10ms）：`push('/c')` 进入主循环。

- `pendingLocation` 改写成 `/c`。注意：B 还在 await，但令牌已被 C 改写。
- C 的守卫队列很短，跑完后检查通过（`pendingLocation === /c`）。
- 收尾前最后检查通过：改写 URL 为 `/c`，`currentRoute.value = /c`，处理滚动，`markAsReady`（首次就绪触发，挂上 `history.listen`）。
- 视图切到 C 组件。

时刻 T2（T0 之后约 50ms）：B 的 `await import` 恢复。

- B 继续往下跑「进入守卫之后」的检查：`pendingLocation === /c !== /b`，抛 `NAVIGATION_CANCELLED`。
- B 的 promise 链短路，收尾函数根本不会被调用——URL、`currentRoute`、滚动、视图全都纹丝不动。
- B 的 chunk 文件已被下载并缓存，但 B 组件实例不会被创建，这次网络请求被白嫖了一次，用户可见状态完全正确。

最终输出：视图停在 `/c`，URL 是 `/c`，没有任何幽灵；B 的下载虽然完成了，但被当成无用功丢弃。

## 7. 教学简化说明

本章演示故意省略：

- 守卫 arity 切换（旧 `next` 回调 vs 新返回值 API）、`guardToPromiseFn` 的 promise 化细节，已在守卫章讲过。
- 重定向三种形态与 `redirectedFrom` 链、30 次死循环保护。
- `replace` 复用 `push` 主循环的 `replace: true` 标记。
- 滚动的实际实现、`handleScroll` 的四个参数语义，已在滚动章讲过。
- `currentRoute` 浅响应承载、`shallowReactive` 代理对象的字段 getter 实现。
- `history` 三实现（html5/hash/memory）的接口差异，已在 History 抽象章讲过。
- devtools 的时间线分组、路由树 inspector、`__navigationId` 等 meta 脏标记。
- 诊断目录里 R0001~R0121 各码的具体文案。

## 8. 小结

主循环把分散的零件总装成一台机器，机器的核心燃料是那个可变的在途令牌。一旦看懂「检查站 + 令牌」这一对组合，整条 router 的「可取消、可重定向、可异步」就都坍缩成同一个引用比较问题，这是工程上极简、语义上完备的取消原语。

下一章进到视图侧：「RouterView 嵌套渲染」会讲 RouterView 怎么凭 `currentRoute` 的 matched 数组、向后代注入的 depth，自动选出该渲染的组件，把这台机器落定的位置真正画到屏幕上。