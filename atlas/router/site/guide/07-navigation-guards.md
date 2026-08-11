---
title: 导航守卫管线
---

# 导航守卫管线

> 本章属于 composite 层。前置：路由匹配表：从配置到 matched 链、导航失败的语义化分类。
> 学完你能：把风格各异的导航钩子统一成「一个返回 Promise 的函数」，并讲清「放行是 resolve、拒绝和重定向都是带种类的 reject」这条统一控制流换来什么、代价是什么。

## 1. 为什么需要它（设计动机）

上一章把路由配置编译成匹配表，导航一来就沿 parent 链反推出 to / from 两条 matched 链。但 matched 链只是「该渲染哪些组件」的答案，「这次跳转到底该不该放行」还没有着落——这正是本章的入口。

想象一下：你在写一个后台管理系统。进 `/admin` 前要先去后端拿用户角色；编辑表单页要离开时弹窗「未保存，确认走？」；登录失效的请求要把用户甩去 `/login`。这些判断散得到处都是——组件里手写离开确认、全局手写鉴权拦截、各自又要支持异步。

把这些诉求合起来，守卫管线必须同时扛住五件事：

- **异步**：鉴权、预拉数据都是异步的，守卫不能假设它能同步返回；
- **可取消**：守卫还在等网络时，用户又点了一次跳转，前一次必须能作废；
- **可重定向**：登录失效就要换目的地，但「换目的地」本质是「启动一次新导航」，控制流跟「报错」完全不同；
- **多时机**：钩子要能挂在「离开前 / 进入前 / 已确认」三个不同时机；
- **双 API**：社区里既有回调式（`next(false)`），也有返回值式（`return false`），同一套管线要无缝兼容。

少任何一件事，守卫都拼不成可用。本章要做的，就是给这五件事一个统一的执行单元和一条统一的控制流。

## 2. 核心思想

把每一个风格各异的导航钩子，统一适配成「一个返回 Promise 的函数」；钩子的三种意图——放行、拒绝、重定向——分别对应这个 Promise 的 resolve、带「中止」种类的 reject、带「重定向」种类的 reject。

整条管线就是一条按固定顺序串起来的 Promise 链：前一个 resolve 才跑下一个，任一 reject 立刻短路。Promise 链天然提供了「顺序 + 异步 + 短路」，前置章已经建好的失败语义化分类机制刚好提供了「带种类的 reject」——两个机制一拼，就是守卫管线的全部骨架。

## 3. 心智模型

钩子入队前的预备工作，是把 to / from 两条 matched 链按记录引用相等（别名归一）切成三组：

```
from.matched = [用户列表, 用户详情]
to.matched   = [登录]

按记录引用相等比对：
  用户列表：to 里没有 → leaving
  用户详情：to 里没有 → leaving
  登录：    from 里没有 → entering

leavingRecords  = [用户列表, 用户详情]
updatingRecords = []
enteringRecords = [登录]
```

为什么要切三组？因为同一条记录上可能挂着三种不同时机的钩子（`beforeRouteLeave` / `beforeRouteUpdate` / `beforeRouteEnter`），只有先知道这条记录是「要走」「要留」还是「要来」，才能判断该跑它身上的哪个钩子。

接着按固定顺序把每组里的钩子串成队列：

```
leaving.reverse() 的 beforeRouteLeave   ← 子先于父离开
→ 各记录的 leaveGuards（组合式注册）
→ 全局 beforeEach
→ updatingRecords 的 beforeRouteUpdate + 各记录 updateGuards
→ enteringRecords 的 beforeEnter（路由级）
→ enteringRecords 的 beforeRouteEnter
→ 全局 beforeResolve
```

每一段都把队列里的钩子 reduce 成一条顺序 Promise 链：前一个 resolve 才跑下一个，任一 reject 整段短路。段与段之间夹着「取消检查」（属下一章 Router 主循环的事），用来让新导航作废旧导航。

整个管线的入参只是 to / from 两条 matched 链；产物是一个 Promise——resolve 就是放行，reject 就是带种类的失败（中止 / 取消 / 重定向 / 报错）。

## 4. 关键权衡

### 用形参数量在两套 API 之间切换

社区里同时存在两套写法：

```ts
// 旧回调式：声明三个形参，使用者自己在函数体里调 next
router.beforeEach((to, from, next) => {
  if (!isLogin) next(false)
  else next()
})

// 新返回值式：声明两个形参，直接 return
router.beforeEach((to, from) => {
  if (!isLogin) return false
})
```

让两套 API 走两条不同的执行路径，整个管线就要分叉维护。这里选了一个看似 hack 的判据：**用函数声明的形参数量（`guard.length`）是否小于 3 来区分**。旧签名固定三参 `(to, from, next)`，length ≥ 3；新签名只用 `(to, from)`，length < 3。切到 `length < 3` 时，把钩子的返回值 `.then(next)` 自动喂给继续回调；否则什么都不做，等使用者自己调 next：

```ts
let guardCall = Promise.resolve(guardReturn)
if (guard.length < 3) guardCall = guardCall.then(next)
```

换来的是：两套 API 共用同一条执行管线、对使用者零迁移成本——一份守卫代码用新写法也好、旧写法也好，跑的都是同一个适配器。

代价是：判定依赖 `Function.length` 这个隐式契约。`length` 反映的是第一个有默认值之前的形参数量，默认参数、剩余参数、解构都会扰动它：

```ts
const g1 = (to, from, next = () => {}) => {} // length=2，被误判为新 API
const g2 = (...args) => {}                    // length=0，被误判为新 API
```

文档要专门提醒使用者「不要给旧式守卫加默认参数」。这是为「零迁移兼容」付出的契约维护成本。

**本质矛盾**：API 在演进，但已有的使用者代码不能动。库作者没法让历史代码自己升级签名，于是借 `Function.length` 这个本就存在的语言特性作隐式契约，把「版本切换」这件事从配置项挪到函数声明里。读者带走的是：当一个库要兼容多套 API、又不想让使用者感知版本号时，「在语言层面找一个稳定的隐式信号」比「加配置项」更轻。

### 把拒绝和重定向都收编进带种类的 reject

继续回调是整条管线的翻译中枢。它的入参有四种可能：

| 使用者写法 | 入参 | 翻译成 |
|---|---|---|
| `next(false)` | 布尔 false | reject(中止种类) |
| `next(Error)` | Error 实例 | reject(这个错误) |
| `next('/login')` | 路由位置 | reject(重定向种类) |
| `next()` / `next(true)` | 其它 | resolve |

为什么「重定向」这种本质是「转去启动新导航」的正常控制流，也要走 reject？

如果走 resolve，链就会继续往下跑——可既然要重定向了，当前这条导航就该终止，不该再跑后面的进入钩子。**只有 reject 才能立刻短路整条链**。又因为重定向和「真的报错」控制流相似（都要终止当前导航）、但语义完全不同（重定向要启动新导航，报错不要），所以必须为它单设一种失败种类：

```ts
const next = (valid) => {
  if (valid === false)
    reject(createFailure(FailureType.aborted, { from, to }))
  else if (valid instanceof Error) reject(valid)
  else if (isRouteLocation(valid))
    reject(createFailure(FailureType.redirect, { from: to, to: valid }))
  else resolve()
}
```

换来的是：上层只需一个 catch 就拿到结构化失败原因，且与顺序链天然契合（一个 reject 立刻短路）。失败种类的表示复用了前置章「导航失败的语义化分类」，本章不必自己造一套。

代价是：「重定向」得借 reject 表达，听起来违反直觉——它明明是正常控制流。这是为「让 reject 同时承担中止 + 重定向两种终止」付出的语义代价：必须有可靠的失败种类机制兜底，否则重定向会和真报错混在一起。

**本质矛盾**：控制流要统一（一条链、一种短路机制），但失败语义要精确（中止 / 取消 / 重定向 / 报错各不相同）。读者带走的是：当一套异步管线既要支持「正常终止」（重定向）又要支持「异常终止」（报错）时，把它们都收进 reject、再用「种类」区分，比给正常控制流单开一条旁路更简洁——旁路一多，链就断了。

### 在导航期提前拉懒加载 chunk 并原地替换记录

路由组件普遍写成工厂函数：

```ts
const routes = [
  { path: '/admin', component: () => import('./Admin.vue') }
]
```

按惯性，组件 chunk 该等渲染时再拉。但守卫管线已经在跑异步钩子了——它本来就在等网络。顺势在这里把组件 chunk 也拉了，渲染时直接命中已解析对象，零额外等待。

具体做法是：抽取组件守卫这一步，对工厂函数式组件立即调用触发 chunk 请求，解析后原地写回它所属的记录：

```ts
guards.push(() => componentPromise.then(resolved => {
  const comp = isESModule(resolved) ? resolved.default : resolved
  record.mods[name] = resolved              // 给 data-loaders 等插件用
  record.components[name] = comp            // 原地替换：下次直接命中
  const guard = (comp.__vccOpts || comp)[guardType]
  return guard && guardToPromiseFn(guard, ...)()
}))
```

换来的是：导航走完时组件已就绪、渲染零额外等待；首次解析后记录被原地替换成已解析对象，后续导航直接命中，**全生命周期只请求一次 chunk**。

代价是：导航管线与模块加载耦合——加载失败要被翻译成可读错误；记录在导航期会被 mutating（任何并发读到这条记录的代码都要假设它的 components 字段会变）；DEV 模式下还要校验 `import()` 没被误写成 `() => import()`。

**本质矛盾**：渲染必须等组件就绪（串行），但 chunk 请求本可以更早发出（并行）。读者带走的是：当管线里已经有一段在等异步（守卫等网络），那么这段时间里能并行启动的工作都应该顺手启动——把「拉取」与「等待」重叠，而不是把拉取留到下一段串行等待时才开始。

### 让组合式守卫与组件生命周期绑定

`onBeforeRouteLeave` / `onBeforeRouteUpdate` 让任意组件（不限路由组件）都能挂守卫。怎么把守卫挂到「正确的记录」上？答案是 `inject(matchedRouteKey)`——组件渲染时，RouterView 会向它注入「你现在所属的匹配记录」，组件内的组合式 API 就把守卫加入该记录的 leaveGuards / updateGuards Set。

注册和注销绑到组件生命周期：`onMounted` 加入、`onUnmounted` 移除、keep-alive 的 `onActivated` 重新加入、`onDeactivated` 移除。

换来的是：不限路由组件、任意组件都能挂守卫，且随组件存活自动清理，不用使用者手动卸钩。

代价是：必须专门处理 keep-alive——同一组件实例可能被复用到不同路由上。重新激活时不能直接复用旧记录引用，必须重新读当前的 `activeRecordRef.value`，否则会把守卫挂到上一条记录上。

**本质矛盾**：守卫在概念上属于某条记录，但组件实例属于它自己（可能被 keep-alive 复用到多条记录）。读者带走的是：当一套 API 要让副作用「跟数据走」而不是「跟实例走」时，不能假设实例与数据是一对一的——必须为「实例会被复用到不同数据」单设一条重激活路径。

## 5. 最小原理演示

下面这个几十行的适配器，演透三件事：① 用 `length < 3` 在两套 API 之间切换；② 继续回调把四种入参翻译成 resolve / 带种类的 reject；③ 把一组守卫 reduce 成顺序链、任一 reject 短路。完整工程还有更多东西（懒加载替换、keep-alive 重激活、DEV 警告、组件就绪回收集），都在「教学简化」里省略。

```ts
// 失败种类：复用前置章「导航失败的语义化分类」的位标志 + 工厂
const FailureType = {
  aborted: Symbol('aborted'),
  redirect: Symbol('redirect'),
  error: Symbol('error'),
} as const

function createFailure(type: symbol, payload: any) {
  return { type, ...payload }
}

function isRouteLocation(x: any) {
  return typeof x === 'string' || (x && typeof x.path === 'string')
}

// 把任意风格的守卫适配成 () => Promise<void>
function guardToPromiseFn(guard: Function, to: any, from: any) {
  return () => new Promise<void>((resolve, reject) => {
    // 继续回调：守卫意图的翻译中枢
    const next = (valid?: any) => {
      if (valid === false)
        reject(createFailure(FailureType.aborted, { from, to }))
      else if (valid instanceof Error)
        reject(createFailure(FailureType.error, { cause: valid }))
      else if (isRouteLocation(valid))
        reject(createFailure(FailureType.redirect, { from: to, to: valid }))
      else resolve() // true / undefined / 函数都视作放行
    }

    // 调一次守卫：旧 API 自己调 next，新 API 由我们把返回值喂给 next
    const guardReturn = guard(to, from, next)
    let guardCall = Promise.resolve(guardReturn)
    if (guard.length < 3) guardCall = guardCall.then(next)
    guardCall.catch(reject)
  })
}

// 把一组守卫 reduce 成顺序链：前一个 resolve 才跑下一个，任一 reject 短路
function runGuardQueue(guards: Array<() => Promise<void>>) {
  return guards.reduce((p, g) => p.then(() => g()), Promise.resolve())
}

// 跑一遍：length 如何决定走哪条 API 分支
const newApiGuard = (to: any, from: any) => false           // length=2，新 API
const oldApiGuard = (to: any, from: any, next: Function) => // length=3，旧 API
  setTimeout(() => next(), 100)

guardToPromiseFn(newApiGuard, { path: '/b' }, { path: '/a' })()
  .catch(f => console.log(f.type))   // aborted
guardToPromiseFn(oldApiGuard, { path: '/b' }, { path: '/a' })()
  .then(() => console.log('放行'))    // 100ms 后：放行

// 整条链：第二段被中止，第三段根本不会跑
runGuardQueue([
  guardToPromiseFn(() => {}, { path: '/b' }, { path: '/a' }),
  guardToPromiseFn(newApiGuard, { path: '/b' }, { path: '/a' }),
  guardToPromiseFn(() => console.log('跑到我了'), { path: '/b' }, { path: '/a' }),
]).catch(f => console.log('链短路：', f.type)) // 链短路：aborted
```

## 6. 执行轨迹

输入：从 `/users/123`（matched 链 = `[用户列表, 用户详情]`）跳到 `/login`（matched 链 = `[登录]`）。用户详情上有一个 `beforeRouteLeave` 返回 `false`。

**切分三组**：

```
from.matched = [用户列表, 用户详情]
to.matched   = [登录]

逐项按引用相等比对：
  用户列表：to 里没有 → leaving
  用户详情：to 里没有 → leaving
  登录：    from 里没有 → entering

leavingRecords  = [用户列表, 用户详情]
updatingRecords = []
enteringRecords = [登录]
```

**离开组逆序**：`leavingRecords.reverse()` 得到 `[用户详情, 用户列表]`——子路由先于父路由离开（与挂载顺序相反）。

**抽取守卫入队**：用户详情上挂着 `beforeRouteLeave`，被收进待执行队列。

**跑队列**：

```
用户详情的 beforeRouteLeave 被调：
  返回 false
  → 继续回调走 false 分支
  → reject(createFailure(aborted, { from, to }))
  → Promise 链立刻短路

整条链以 aborted 失败终止。
```

**输出**：导航以「被守卫中止」失败终止。用户列表的 `beforeRouteLeave` 根本不会被调到（链已经短路）；全局 beforeEach、登录页的 beforeEnter 也都不会跑。上层一个 catch 就能凭 `failure.type === aborted` 区分出这是「被守卫拦下」，而不是报错或重定向——这是前置章「失败语义化分类」换来的精确语义。

如果把用户详情上挂的钩子换成 `return '/login'`，同样的链路会 reject 一种 `redirect` 种类的失败，上层凭种类识别后启动一次新导航去 `/login`——这就是「重定向借 reject 表达」的实际走法。

## 7. 教学简化说明

本章演示故意省略了：懒加载组件 chunk 的拉取与原地替换（守卫管线里那段 `componentPromise.then(...)`）、keep-alive 重激活时重新读 `activeRecordRef.value`、DEV-only 弃用警告与「继续回调被调两次」守护、组件就绪回调（`next(vm => ...)`）的按名收集与陈旧导航门禁、effect scope 上下文透传（`runWithContext`）、五守卫段之间的「取消检查」与完整全排序。

完整全排序（哪段先哪段后、段与段之间夹取消检查）属下一章 `navigate()` 的事；本章只演透「单段内一个守卫怎么被适配、整段怎么串成链」。

## 8. 小结

守卫管线的骨架只有三步：把任意风格的钩子统一成 Promise 工厂、把意图翻译成 resolve / 带种类的 reject、reduce 成顺序链。Promise 链天然给了「顺序 + 异步 + 短路」，前置章的失败语义化分类给了「带种类的 reject」——两个机制一拼，五件事（异步、可取消、可重定向、多时机、双 API）就一次扛下了。

下一章会从「位置恢复」这个侧面再看一次导航生命周期：滚动位置为什么不能在数据到达时就应用、为什么必须等到 nextTick 之后且校验过 `to === currentRoute.value` 才动手。
