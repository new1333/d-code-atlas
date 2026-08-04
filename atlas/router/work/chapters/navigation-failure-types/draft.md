# 导航失败的语义化分类

想象你在写一个后台系统的路由。用户从 `/orders` 点进 `/settings`，但你不想让没权限的人进去，于是挂了个 `beforeEach` 守卫，权限不够就 `return false`。导航确实没成功——可这是你**故意**拦下的，不是程序出 bug。要是你用 `throw` 来表达"没导航成功"，控制台立刻弹出一串红色的 `Unhandled promise rejection`，用户吓一跳，以为页面崩了。

这一章讲的就是 vue-router 怎么解决"没走到底"的表达问题。核心就一句话：**把导航失败当成一个带着种类标签的普通返回值，而不是一个异常**。

## 一、为什么不能用"抛异常"了事

很多人第一反应是：导航没成功，那就 `reject` 嘛，Promise 不就是干这个的？听起来很自然，放到导航场景里却会出大问题。

导航"没走到底"的情况其实有很多种，而且大部分根本不算出错：

- 守卫主动拦下（`return false`）——这是业务逻辑，正常
- 用户手快连点了两下，后一次把前一次挤掉了——正常
- 目标地址就是当前页，重复了——正常，本来就不用动
- 守卫说"别去那儿，去这儿"，要重定向——正常

这些都走 `reject`，有两个直接的坏处。第一，控制台会被未捕获的 rejection 刷屏，把真异常淹没。第二，上层的 `afterEach` 钩子拿到的就是一个模糊的 Error，它根本分不清"这次是被守卫拦了，还是被新导航取消了，还是单纯重复了"——而这恰恰是它想知道的。

所以 vue-router 的选择是：**这些预期内的"没成功"，走 return 通道，安安静静地把一个失败值传回去；只有真异常（守卫里 `throw`、代码真坏了）才走 reject 通道**。

打个比方，失败值像一封挂号信，信封上写清楚"这次为什么没成"，可以层层传递、被安安静静地拆开分类；异常则像拉火警，一响全楼都得看。导航里大部分"没成"都是日常挂号信，不该动不动拉火警。

## 二、给失败值贴上种类标签

既然要走 return 通道，那返回的东西就得**自带种类**。一个光秃秃的 `false` 或者 `null` 是不够的——`afterEach` 拿到 `null`，它怎么知道是成功了，还是被取消了？

于是失败值长这样：它本质上是一个 Error 对象当底座，额外挂了三样东西——

- `type`：失败种类，一个数字
- `from` / `to`：从哪去哪
- 一个隐藏标记（下一节细讲）

说人话就是，失败值是一个**有身份、有上下文的值**。它知道自己是什么种类的失败，也知道发生在哪条路径上。`afterEach(to, from, failure)` 的第三个参数拿到的就是这个东西，想分类处理随手就能查。

## 三、用位掩码，让"种类"可以组合着问

光有种类还不够。很多时候上层关心的是"一类"，不是"一种"。

比如你想在 `afterEach` 里做埋点："只要是被守卫中止、或者被新导航取消的，都算'用户没到达目标'，统一记一条日志"。要分别写的话是：

```ts
if (failure.type === ABORTED || failure.type === CANCELLED) { /* ... */ }
```

每多关心一种，就得再串一个 `||`，种类一多又啰嗦又容易漏。

vue-router 的做法是把每种失败分配一个 2 的幂：1、2、4、8、16。这样每种失败在自己的二进制位上是唯一的，组合查询就压成了一条按位与：

```ts
if (failure.type & (ABORTED | CANCELLED)) { /* ... */ }
```

`ABORTED | CANCELLED` 是 `4 | 8 = 12`，任何 `type` 只要在这两位上有任意一位亮着，按位与就非零，判定成立。换成开关板来理解最直观：每种失败是一个独立开关，"中止或取消"等于"这两个开关只要任意一个亮，就算命中"。

> 顺带一提，内部这个枚举用的是 `const enum`，注释特别强调成员值**必须写字面量**（写 `= 4`，不能写 `1 << 2`），否则它没法在编译期被内联掉。这是 TS 的硬约束，知道有这回事就行，不影响原理。

这里还有个**双层枚举**的小心思：内部用 `const enum`（编译期内联成数字，运行时根本不存在这个对象，图快）；对外公开一个普通的 `enum`，让你能写 `NavigationFailureType.aborted` 这样好认的名字（图对人友好）。两套枚举的值是一一对应的，等于维护了一份同值的映射。

## 四、靠一个隐藏标记，认出"自家人"

失败值要在 Promise 链里和真异常混着流动，所以框架得有办法在任意一个 `.catch` 里快速判断："手里这个 error，到底是我们自己造的失败值，还是真异常？"

最容易想到的办法是写个子类：`class NavigationFailure extends Error`，然后到处 `error instanceof NavigationFailure`。vue-router 没这么做。它用的是**普通 Error 当底座 + 一个隐藏标记属性**：

```ts
const MARK = Symbol('navigation failure')

const failure = Object.assign(new Error(msg), {
  type,
  [MARK]: true,
  from,
  to,
})
```

判定一个东西是不是失败值，是三段式：

```ts
error instanceof Error      // 最外层：到底是不是个 Error
  && MARK in error          // 中间层：是不是本模块盖过章的
  && (mask == null || !!(error.type & mask)) // 内层：是不是要的那种
```

为什么不用子类？两个考虑。第一，`instanceof` 依赖那个子类构造器，一旦代码被压缩、或者页面上同时存在两份库的副本，构造器对不上，`instanceof` 就悄悄失效了——这种 bug 极其难查。第二，最外层那道 `error instanceof Error` 用的是内置的 `Error`，它在跨 iframe、跨 realm 时是稳的，能先把"根本不是 Error 的乱七八糟值"挡在外面。

这里有个容易吹过头的地方，得说清楚：那个标记用的是 `Symbol()`，每次调用都唯一、跟着模块实例走；它**不是** `Symbol.for()`（那种全局共享的）。所以这个标记保证的是"同一个模块实例能认出自己造的失败值"，并不是说两份各自独立加载的库副本能互相认。准确的描述是"跨 realm 稳定的内置 Error 判定 + 标记式扩展"，别简化成"Symbol 能跨 realm"。

## 五、重定向也是"失败"，只不过带着新目标

最有意思的一招，是把**重定向也当成一种失败值**。

守卫有时候不是简单地放行或拒绝，而是说"别去 `/settings`，去 `/login`"。你完全可以为重定向单独发明一套控制流，但 vue-router 选择让它复用整条失败通道：重定向就是一个 `type` 是重定向位、但 `to` 字段填的是新目标的失败值。

```ts
const redirect = makeFailure(REDIRECT, { from: '/settings', to: '/login' })
```

这样做的好处是，产出失败值、传递失败值、上层捕获失败值这套机器，重定向一行额外代码都不用写就能蹭上。上层捕获到一个重定向失败值，看看它带的目标，再朝那个目标发起一次新导航就行了——整条逻辑是一个递归，复用得很彻底。

代价当然也有：失败种类从此被劈成两半。对用户可见的有三种（中止、取消、重复），重定向和"没匹配到路由"这两种被刻意留成了内部使用，不暴露在公开的 `NavigationFailureType` 里。所以 API 表面和文档得分清"用户能见到的失败"和"库内部用的失败"，别混着讲。

## 六、把整条管子拼起来：一个玩具导航器

下面是从零写的最小演示，把上面四件事（return-vs-throw、位掩码、隐藏标记、重定向复用）一次性演透，没有任何 vue-router 运行时依赖。存成 `nav.ts`，配一个最小的 `package.json`（`{ "type": "module" }`），用 `bun run nav.ts` 或 `npx tsx nav.ts` 就能跑。

先是值模型本身——位标志、隐藏标记、造失败值、三段式判定：

```ts
// 位标志：每种失败占独立的一位
export const ABORTED = 4
export const CANCELLED = 8
export const DUPLICATED = 16
export const REDIRECT = 2

// 模块私有的隐藏标记，外人伪造不了
const MARK = Symbol('nav-failure')

// 造失败值：普通 Error 当底座，贴上种类 + 标记 + 上下文
export function makeFailure(type: number, info: { from: string; to: string }) {
  return Object.assign(new Error(`nav: ${info.from} -> ${info.to}`), {
    type,
    [MARK]: true,
    ...info,
  })
}

// 三段式判定：是不是失败值？是不是某种（或某几种）失败？
export function isFailure(err: unknown, mask?: number) {
  return (
    err instanceof Error &&
    MARK in err &&
    (mask == null || !!((err as any).type & mask))
  )
}
```

有了值的模型，再写一个会"产出失败值"的 `navigate`。关键看它**什么时候 return、什么时候 throw**：

```ts
let pending = '' // 当前正要去的目标，作为"是否被取代"的基准

export async function navigate(
  to: string,
  guard: (to: string) => boolean | string
) {
  const from = pending
  pending = to // 一开始就登记"我现在要去哪"

  const verdict = guard(to)

  if (verdict === false) return makeFailure(ABORTED, { from, to })        // 守卫拒绝 → 中止
  if (typeof verdict === 'string') return makeFailure(REDIRECT, { from, to: verdict }) // 重定向
  if (to === from) return makeFailure(DUPLICATED, { from, to })           // 本来就在这 → 重复
  if (pending !== to) return makeFailure(CANCELLED, { from, to })         // 中途被更新的导航抢了 → 取消

  pending = to // 落定
  return undefined // 真正成功
}
```

注意上面**没有一处 `throw`**。四种"没走到底"全都是 `return` 一个失败值。现在跑几个场景，看上层怎么消费：

```ts
async function main() {
  // 1) 守卫拒绝：拿到一个"中止"失败值
  const r1 = await navigate('/b', () => false)
  console.log(isFailure(r1, ABORTED)) // true

  // 2) 组合查询：中止或取消，都算"没到达目标"
  const r2 = await navigate('/c', () => false)
  console.log(isFailure(r2, ABORTED | CANCELLED)) // true，一条按位与搞定

  // 3) 真异常：不 return，直接 throw，根本不进失败值的逻辑
  try {
    await navigate('/d', () => { throw new Error('真坏了') })
  } catch (e) {
    console.log(isFailure(e)) // false —— 真异常不归失败值管
  }
}
main()
```

一次完整的执行轨迹长这样（用户从 `/a` 去 `/b`，守卫返回 `false`）：

```
开始导航，登记 pending='/b'
  → 跑守卫，得到 false
  → return 失败值 { type: ABORTED(4), from:'/a', to:'/b', [MARK]:true }
  → 上层拿到非空 failure：URL 不动（停在 /a），按种类不回滚
  → afterEach('/b', '/a', failure) 把分类好的失败交给业务
  → 链尾 .catch(noop) 吞掉残留，控制台干干净净

对照：守卫里直接 throw new Error('boom')
  → 同一个 catch 判定 isFailure 为 false
  → 走 onError 监听 / console.error / reject 这条"真异常"通道
```

这就是"值/异常二分"的全部样子：**预期内的没成功走 return，真坏了才走 throw**，两条通道泾渭分明。

## 七、关键权衡

把上面散落的几个设计选择收一下，每条都讲清"选了什么、换来什么、付出什么"。

**1. 用返回值（resolve）而非异常（reject）传递预期失败。** 换来的好处很实在：`afterEach` 能拿到一个结构化的、带种类的失败值去做分类处理，而且因为走的是正常 resolve 通道，绝不会触发"未捕获的 rejection"告警，控制台干净。代价是：整条导航 Promise 链里，每一个 `.catch` 都得刻意做一遍"这是已知失败，还是真异常"的二分判断，这块心智负担从用户那边挪到了框架内部。

**2. 用位掩码（2 的幂）编码失败种类。** 换来的是"一次按位与就能问多种失败"（`aborted | cancelled`），判定压成一条 `type & mask` 表达式，比一串 `||` 干净得多，也方便组合扩展。代价是：`type` 字段对人来说就是个魔数（4、8、16），离开枚举别名根本读不懂；而且得维护"内部 `const enum`（编译期内联）/ 公开 runtime enum"两份同值映射。

**3. 用"内置 Error + 隐藏标记"而非自定义子类。** 换来的是"这到底是不是个失败值"的判定，不依赖那个容易被压缩、被多副本冲掉的子类构造器——最外层靠跨 realm 稳定的内置 `Error` 兜底，内层靠私有标记确认身份。代价是：放弃了 `instanceof NavigationFailure` 带来的类型收窄，只能靠谓词函数加一组 TS 重载来模拟类型守卫，写起来绕一点。

**4. 把重定向也建模成"带新目标的失败值"。** 换来的是重定向整套蹭用了失败传递通道——产出失败值、上层捕获、再发起新导航，递归一圈，零额外机制。代价是：失败种类被劈成"用户可见 3 种"和"仅内部 2 种（重定向、未匹配）"，API 表面和文档必须刻意区分这两类，不然用户会对着公开枚举找重定向而找不到。

这四条权衡其实是一条主线上的四个面：**让"导航没成功"成为一种可分类、可查询、不污染错误通道的正常结果**——为此，失败值得带种类（权衡 2）、得能自我识别（权衡 3）、得走 return 不走 throw（权衡 1），连重定向都得借这套壳（权衡 4）。

## 小结

这一章只搭了"失败值"这根管子的形状：它是个带种类位掩码、带隐藏标记、能被三段式认出的普通 Error 值，走 return 通道安静流动。至于这些值在守卫链里怎么被产出、在导航主循环里怎么被按位分流去决定回滚和 `afterEach`，那要等到后面讲导航守卫和 Router 核心时再展开——本章的任务是把"值"本身建对。

下一章，我们先去拆另一块地基：把浏览器的 URL 模型抽象成一个"可导航 + 可监听"的窄接口，让 html5、hash、memory 三种实现能互换。那是另一个独立的基础件，和失败值模型一样，都是后面组装 Router 要用到的零件。