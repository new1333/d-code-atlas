---
title: 导航失败的语义化分类
---

# 导航失败的语义化分类

> 本章属于 primitive 层。前置：无（全书的底层章节之一）。
> 学完你能：用一句话讲清「为什么把导航失败建成可恢复值而不是异常、为什么用位掩码给失败分类、为什么用隐藏标记而非子类做识别」。

## 1. 为什么需要它（设计动机）

上一章解决了「拿到一条 path，该匹配到哪一条用户配置」——靠评分从所有候选里选出唯一赢家。但「选出赢家」只是导航的一步。从用户点了一个链接，到 URL 真的换过去、页面真的渲染出来，中间还有大量「没走到底」的情况：

- `beforeEach` 守卫看了看目标，回了句 `false`，把这次导航拦下
- 用户手快连点两次，第二次挤掉了第一次，第一次没机会跑完
- 目标 URL 跟当前完全一样，再导航一次没意义
- 守卫返回了一个新的位置，意思是「别去原来那、去这儿」

这些都不算「出错」，更像是「这次导航的合理结局」。可如果它们都用 `throw` 或 `Promise.reject` 来表达，会立刻撞上三件麻烦事：

第一，控制台会被 `Unhandled promise rejection` 刷屏。用户连点两次本是个无害的交互，控制台却看起来像程序崩了一样。

第二，上层拿不到语义。`afterEach` 钩子、监控埋点、错误日志，所有这些想对导航结果做点什么的代码，都只拿到一个 `Error` 对象。它们没法回答「这次到底是用户取消了，还是真出 bug 了」——而这恰恰是它们最需要知道的。

第三，重定向这种「换目标继续」的语义没法用「终止信号」表达。它不是结束，是改方向。

矛盾的核心在这里：导航「没成功」本是上层关心的正常语义，但异常通道天然只表达「出错了」。把正常语义塞进异常通道，就会被错误监测机制误报、被全局 errorHandler 误吞、被未捕获告警污染日志。

本章做的事，是给这些「没走到底」的结局一个不带故障含义的表达方式。

## 2. 核心思想

导航「没走到底」其实有两种：作为故障的没成功（`throw`），和作为结局的没成功（`return`）。整套机制的本质，是把失败从前者搬到后者。失败于是成了一种**带标签的数据**，不再是一种信号。

## 3. 心智模型

### 3.1 五种「没走到底」的形态

先把这些场景一一对应到一种失败种类：

| 场景 | 失败种类 | 备注 |
|---|---|---|
| 守卫拒绝（返回 `false` 或抛错） | aborted | 已中止 |
| 被更新的导航取代 | cancelled | 已取消 |
| 目标与当前位置同位 | duplicated | 重复 |
| 守卫返回了一个新位置 | redirect | 重定向，**携带新目标** |
| 路径在路由表里找不到匹配 | matcher-not-found | 仅内部 |

前三种是用户能感知的「正常结局」，对外公开。后两种是框架内部用来驱动控制流——重定向要触发再导航，匹配不到要直接报错。这个「公开 vs 内部」的边界后续会再展开。

### 3.2 失败值长什么样

一个失败值就是一个**普通 `Error` 对象**，往上面贴三样东西：

- `type`：一个数字，标记它是上面五种里的哪一种
- 一个**隐藏标记**（用模块级 `Symbol` 当键）：声明「这是本库造的失败值」
- 业务字段（`from`、`to`）：方便上层拿来打日志、做埋点

注意——它**不是** `class NavigationFailure extends Error`。就是一个 `Object.assign(new Error(msg), { type, [MARK]: true, from, to })`。这个反直觉的选择后面权衡小节会解释。

### 3.3 识别一个失败值

要回答两个问题：「这玩意儿是不是本库造的失败值」和「它属于我关心的某种失败吗」。一个三段式谓词搞定：

```
instanceof Error           // 是个内置 Error（跨 realm 稳定）
&& MARK in error           // 带本库的隐藏标记
&& (mask == null || !!(error.type & mask))  // 是我关心的种类
```

第三个条件是「按位查」，下面位掩码小节展开。

### 3.4 失败值在 promise 链里怎么流动

关键规则：失败值走 resolve 通道回传，不走 reject。

具体说，守卫拒绝时，那个失败值**先在守卫链内部**以 reject 形式短路（避免继续跑后续守卫）。上游的 `.catch` 接到它，做个二分判断：

- 是已知失败 → 把它**转成 resolve 返回值**交给下一个 `.then`（继续收尾：决定要不要回滚历史、要不要把 failure 透给 `afterEach`）
- 不是已知失败（即真异常）→ `triggerError`：调 `onError` 监听、`console.error` + 诊断码、最后 `Promise.reject`

链尾永远挂一个 `.catch(noop)`，明确为「吞掉残留」，确保控制台不会再有未捕获告警。已知失败已经在前面被转成返回值了，这个 noop 接住的是「链中又被某段 `.then` 漏掉的真异常」。

## 4. 关键权衡

### 用「值」而非「异常」传递预期失败

这是整套设计的总闸。

**选择**：守卫拒绝、被取消、重复，这些预期内的「没走到底」，全部以**值**的形式（resolve 返回）在 promise 链里流动；只有无法识别的真异常才走 reject。

**换来**：

- `afterEach` 拿到的是结构化的 failure 对象，可以按种类分支处理
- 控制台不会被「正常中止」误报成未捕获 rejection
- 全局 errorHandler 不会被无害的取消事件刷屏

**代价**：整条导航 promise 链必须在每个 `.catch` 里刻意做「已知失败 vs 真异常」的二分分流。心智负担并没有消失，只是从用户身上转到了框架内部。写框架的人必须时刻警惕：拿到一个 error 别直接 `triggerError`，先 `isNavigationFailure` 谓词一遍。漏判一处就会把「正常中止」升级成「程序异常」。

**化解的本质矛盾**：「正常结局」和「程序出错」都表现为「没成功」，但前者是数据、后者是故障——必须用不同通道承载，否则错误监测机制会把它们当成同一件事。

### 用位掩码（2 的幂）编码失败种类

失败种类这个数字不是 1/2/3/4/5 顺序排，而是 1/2/4/8/16——每个种类独占一位。

**换来**：上层可以用**一次按位与**问「多种失败」：

```
// 「被中止或被取消」都算正常，不用细分
if (failure.type & (ErrorTypes.NAVIGATION_ABORTED | ErrorTypes.NAVIGATION_CANCELLED)) {
  // 不报错、不回滚
}
```

判定压成一条 `type & mask` 表达式，无需写一堆 `||`。如果种类是顺序整数，就得 `type === aborted || type === cancelled`，加一种就得改判定。

**代价**：`type` 字段对人是个「魔数」——看到 `4` 没人知道那是「已中止」。可读性全靠枚举别名 `NavigationFailureType.aborted` 补。框架还得维护两套同值映射：内部 `const enum`（编译期内联、零运行时开销）+ 公开 `enum`（真实运行时对象，让用户能 `Router.NavigationFailureType.aborted` 引用）。

> 顺便提一句源码里一个挺刁钻的约束：内部用 `const enum` 时，成员值必须是**字面量**（写 `= 4`），不能写成位移表达式 `1 << 2`——否则它在「被当值用」的场合无法被编译期内联。这是 TS `const enum` 的硬约束，不是设计偏好。

**化解的本质矛盾**：「我想知道精确种类」和「我想一次问多种」对立——顺序整数让单种查询自然但组合查询啰嗦，位掩码让组合查询变成一条算式但单种查询要靠别名补可读性。

### 用「内置 Error + 隐藏标记」而非自定义子类

按习惯，给错误分类的标准做法是写一堆子类：`class NavigationAborted extends Error`、`class NavigationCancelled extends Error`……然后用 `instanceof NavigationAborted` 来判。这里**偏偏不这么干**。

**选择**：所有失败值都是**内置 `Error`** + 一个模块级 `Symbol` 标记属性，靠 `MARK in error` 做鸭子判定。

**换来**：「这是不是一个失败值」的最外层判定（`instanceof Error`）是**跨 realm 稳定**的——内置 `Error` 的 `instanceof` 不会因为代码压缩、多 bundle 拼装、或者页面上同时存在两个 vue-router 副本而失效。子类构造器就脆弱得多：压缩会改它的名字，多副本会让两个 `NavigationAborted` 类互不相认。

**代价**：放弃了 `instanceof NavigationFailure` 带来的 TS 自动 narrowing。只能靠一个谓词函数 + TS 函数重载模拟类型守卫：

```ts
function isNavigationFailure(
  error: unknown,
  type?: ...
): error is NavigationFailure { ... }
```

写起来比 `instanceof` 啰嗦，IDE 的 auto-narrowing 也没那么顺。

> **一个容易被过度宣称的点**：源码用的是 `Symbol()`（每次调用唯一，per-copy），不是 `Symbol.for()`（全局共享）。所以「是否本库造的失败」这一层判定，在两个独立的 vue-router 副本之间**并不**比子类 instanceof 更强：两个副本各有各的 Symbol，互不相认。准确的说法是「跨 realm 稳定的内置 Error 判定 + 标记式扩展」——前者保最外层可靠，后者保「在本副本内」能区分失败值和普通 Error。别讲成「Symbol 本身跨 realm」。

**化解的本质矛盾**：「我想给错误一个具体类型」和「这个类型识别手段必须抗压缩、抗多副本」对立——子类 narrowing 优雅但脆弱，标记式鸭子判定不优雅但稳。

### 把「重定向」也建模成「携带新目标的失败」

最反直觉的一条。

守卫返回了一个新位置，按理说这跟「拒绝」不一样，它是要「换目标继续」。可本章偏偏把它也做成一种失败值，只是 `type` 是 redirect 位、`to` 字段放的是新目标。

**换来**：重定向**复用整套失败传递通道**。守卫产出一个带目标的失败 → 上游 `.catch` 捕获 → 判定种类是 redirect → 取出 `to` 字段，**递归再调一次 `pushWithRedirect(to)`**。整套收尾、分流、链尾吞残留的逻辑一行都不用改。

如果不这么建模，重定向就得是独立机制——守卫的「拒绝」和「改方向」要分两条 promise 链处理，再各自有一套收尾。代码量翻倍，bug 也翻倍。

**代价**：失败种类被强行分成「对用户可见的 3 种」和「仅内部的 2 种（redirect / matcher-not-found）」。API 表面、文档、类型导出边界都得刻意区分这两层——公开枚举只暴露 aborted/cancelled/duplicated，redirect 和 matcher-not-found 留 internal。用户初次碰到时常困惑「为什么我的 `afterEach` 看不到重定向」。

**化解的本质矛盾**：「重定向语义上不是失败」（它是改方向继续）和「重定向机制上必须短路当前导航」（否则会和后续守卫冲突）对立——把它建模成「携带新目标的失败」同时满足了两者：当前导航确实终止了，但新目标也带出来了。

## 5. 最小原理演示

下面这段几十行的 TS 把上面四条权衡都演一遍：位掩码编码、隐藏标记识别、值/异常二分、重定向即带目标的失败。每一行都对应一个原理点，不演示原理的工程细节（DEV 文案、TS 重载、回滚历史、afterEach 调度）一律省略。

```ts
// 失败种类用 2 的幂编码：每个种类独占一位，组合查询靠按位与
const FAILURE = {
  aborted:    1,
  redirect:   2,
  cancelled:  4,
  duplicated: 8,
} as const

// 模块级 Symbol 当隐藏标记键，本模块内唯一，外部伪造不出来
const MARK = Symbol('navigation-failure')

// 失败值 = 普通 Error + 贴 type + 贴标记 + 贴业务字段
// 不写 class extends Error，靠内置 Error + 标记做识别
function makeFailure(type: number, msg: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(msg), { type, [MARK]: true }, extra)
}

// 三段式识别：内置 Error（跨 realm 稳）+ 本库标记 + 按位查种类
function isFailure(err: unknown, mask?: number): err is Error & { type: number } {
  return (
    err instanceof Error &&
    (MARK in err) &&
    (mask == null || !!((err as any).type & mask))
  )
}

// 一个最小导航器：登记 pending 当作取消基准
let pending: string | null = null

async function navigate(from: string, to: string, guard: () => unknown): Promise<Error | null> {
  pending = to
  const g = guard()

  // 守卫返回 false：产出 aborted 失败值，走 return 通道
  if (g === false) return makeFailure(FAILURE.aborted, `aborted: ${from}→${to}`, { from, to })

  // 守卫返回一个新位置：产出 redirect 失败值（携带新目标）
  if (typeof g === 'string') {
    return makeFailure(FAILURE.redirect, `redirect: ${from}→${g}`, { from, to: g })
  }

  // 被更新的导航取代：产出 cancelled 失败值
  if (pending !== to) {
    return makeFailure(FAILURE.cancelled, `cancelled: ${from}→${to}`, { from, to })
  }

  // 真异常：throw 走 reject 通道（演示用，不真跑业务）
  if (g instanceof Error) throw g

  return null // 成功
}

// 收尾逻辑：按位查种类，决定怎么处理
async function pushWithRedirect(from: string, to: string, guard: () => unknown) {
  try {
    const failure = await navigate(from, to, guard)

    if (failure) {
      // 重定向：取出新目标，递归再导航一次（复用整套收尾通道）
      if (isFailure(failure, FAILURE.redirect)) {
        const next = (failure as any).to as string
        return pushWithRedirect(to, next, guard)
      }
      // 其它已知失败：作为「值」返回给上层（afterEach 会拿到）
      return failure
    }
    return null // 成功
  } catch (e) {
    // 真异常通道：到这里说明不是已知失败，报错 + 上抛
    console.error('[router] unexpected error:', e)
    throw e
  }
}
```

执行轨迹在下一节展开。

## 6. 执行轨迹

输入：用户从 `/a` 点链接去 `/b`，某个 `beforeEach` 返回 `false`。

```
1. navigate('/a', '/b', () => false) 被调用
   pending = '/b'

2. guard() 返回 false
   → makeFailure(FAILURE.aborted, 'aborted: /a→/b', { from:'/a', to:'/b' })
   → 一个普通 Error，type=1, MARK=true, from='/a', to='/b'
   → return 这个失败值（注意：return，不是 throw）

3. pushWithRedirect 的 await navigate(...) 拿到这个 failure
   → isFailure(failure, FAILURE.redirect) 为 false（type=1 & 2 = 0）
   → 不递归再导航，直接 return failure 给上层

4. 上层（用户的 afterEach 钩子）拿到这个 failure：
   afterEach((to, from, failure) => {
     if (failure && isFailure(failure, FAILURE.aborted | FAILURE.cancelled)) {
       // 用户连点或被守卫拦下，都算正常
       return
     }
     // 真异常会走另一条路，根本到不了这里
   })

5. 链尾 .catch(noop) 兜底，本例没真异常，noop 不触发
   控制台干净：没有 Unhandled rejection
```

**对照场景**：如果守卫里写 `throw new Error('boom')`——

```
1. navigate('/a', '/b', () => { throw new Error('boom') })
   guard() 抛出 Error('boom')

2. navigate 内部 try/catch 没接住，直接冒泡
   → pushWithRedirect 的 try 接到这个 e
   → e 是 Error，但 MARK in e 为 false → 不是已知失败
   → console.error + throw e（走 reject 通道）

3. 上层接到 reject：这就是真异常路径
   afterEach 拿不到，触发 onError 监听
```

两条路径用同一个 `try { ... } catch (e)` 区分——失败值走 return、真异常走 throw。这就是「值/异常二分」的全部含义。

## 7. 教学简化说明

本章故意省略了：

- 完整的守卫管线（leave → beforeEach → update → beforeEnter → enter → beforeResolve 的串行 promise 链），留给「导航守卫管线」一章
- history 回滚（aborted/cancelled 要不要 `go(-1)`）的具体规则，留给「Router 核心与导航主循环」一章
- DEV 文案表、TS 函数重载签名、内部诊断码、MatcherError 的 `currentLocation` 字段等工程化细节
- 公开枚举刻意只暴露 3 种、把 redirect/matcher-not-found 留 internal 的导出边界（已一句话提及，不展开）

## 8. 小结

失败本身被分了类、压成了位、用标记藏好了身份，但真正改写的是它的**通道**：从「程序崩了」的 throw，搬到「这次结局如此」的 return。整套机制不是给错误加细节，而是给「没成功」扩词。下一章离开失败话题，去看路由库如何把浏览器 URL 模型抽象成一层可导航、可监听的窄接口——那是导航能跑起来的另一块地基。
