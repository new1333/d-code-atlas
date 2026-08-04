# 导航守卫管线

你刚在一个后台系统里点开「订单详情」，结果页面没跳，而是被弹回了登录页。这背后发生的事比看上去复杂：路由器要在跳转真正发生之前，先跑一圈"关卡"——有的关卡问"你登录了吗"，有的问"表单改了还没保存，确定要走吗"，有的甚至要异步去服务器查权限。关卡可能放行，也可能喊停，还可能说"别去那儿，去这儿"。这一圈关卡，就是**导航守卫管线**。

## 这一圈关卡，到底难在哪

把"这次跳转该不该放行"这件事拆开看，你会发现它同时顶着五个互相打架的要求：

- **要异步**：鉴权、预拉数据都得等网络，关卡不能是同步函数。
- **能被取消**：你刚发起跳转、关卡跑到一半，用户又点了另一个链接——前一次跳转必须作废。
- **能重定向**：关卡不仅要能说"不许去"，还得能说"改去登录页"。
- **多个时机**：使用者想在「离开前、进入前、已经确认」几个不同节点插钩子。
- **两套 API**：社区里同时存在"返回值式"新写法和"回调式"旧写法，得让同一条管线都认。

这五件事缺一个，都拼不出一个能用的守卫系统。本章要讲的就是 vue-router 怎么用一个统一的设计，把这五件事一起兜住。

先交代两个地基，本章直接拿来用、不重复展开：这次跳转的起点和终点各对应一条 **matched 记录链**（它怎么从路由配置编译而来，是第 6 章的主题）；关卡喊"停"时产出的那个**失败值**，是个带种类标记、能被上层精确查询的东西（这件事是第 4 章的主题）。本章只看守卫这一侧怎么用它们。

## 第一步：把"从哪来 / 去哪"切成离开、更新、进入三组

想象你把这次跳转的起点和终点摊在桌上：起点是一条 matched 记录链，终点也是一条。这两条链里有些记录是同一个（对象引用相等），有些只在起点出现，有些只在终点出现。

按"记录的引用是否相等"挨个比对，两条链就被切成三堆：

- 两边都有的 → **更新**（updating）：组件还在，只是参数变了，跑 `beforeRouteUpdate`
- 只在旧链的 → **离开**（leaving）：跑 `beforeRouteLeave`
- 只在新链的 → **进入**（entering）：跑 `beforeRouteEnter` / `beforeEnter`

这里有个容易被忽略的不对称：**离开是子路由先于父路由**（旧链要先 reverse 一下），因为子组件嵌在父组件里面，卸载得从里往外拆；而进入是父先于子，跟挂载顺序一致。

比对靠的是记录对象本身的引用相等（遇到别名，会先折回它指向的那个原始记录再比），不比较路径字符串。这也解释了第 6 章为什么要把 matched 链做成"具体的记录对象引用"——到了守卫这一层，比对只剩一次引用比较，几乎零成本。

## 第二步：把任意风格的守卫，统一成一个返回 Promise 的函数

关卡写法千差万别：有人写同步、有人写 async、有人返回 false、有人调 `next(false)`、有人 `next` 一个新地址。管线想统一调度它们，第一步就是**把每一个守卫都包成一个 `() => Promise<void>`**。

这个适配器内部干两件事。

**第一件，准备一个"继续回调" `next`，把它当成守卫和管线之间的翻译官。** 守卫不管用哪种写法，最终表达的意图就三种：放行、拒绝、重定向。适配器让 `next` 按入参把这三种意图翻译成 Promise 的对应动作：

- `next(false)` 或返回 `false` → reject 一个**中止**种类的失败值（"我不许你过去"）
- `next(某个错误)` 或抛错 → reject 那个错误本身
- `next(一个目标地址)` → reject 一个**重定向**种类的失败值（"别去那儿，去这儿"）
- `next()` / `next(true)` / 什么都不做 → resolve（"放行"）

这里有个值得停下来想的问题：**为什么"重定向"也要走 reject？** 重定向明明是个正常控制流（转去启动一次新导航），不是出错。原因是——它和"拒绝"一样，都意味着"当前这条导航到此为止、别再往下跑了"。让它走 reject，整条管线就能用同一套"任一 reject 立刻短路"的逻辑，不用为重定向单开一条控制流。代价是：得为重定向单设一种失败种类，免得它和真报错混在一起，让上层分不清"是真出错了"还是"只是要换个目的地"。

至于那个"带种类的失败值"长什么样、为什么能被上层按位查询、为什么能跨 realm——那是第 4 章已经搭好的地基。本章只负责一件事：**把守卫这一侧的三种意图，准确地投递成对应种类的失败值**，好让上层一个 catch 就能区分它们。

**第二件，决定守卫的返回值要不要自动喂给 `next`。** 这就引出下一个话题。

## 第三步：靠"函数形参数量"认出你用的是新写法还是旧写法

vue-router 同时支持两套写守卫的 API：

```ts
// 旧写法：回调式，签名固定 (to, from, next)
beforeRouteLeave(to, from, next) {
  if (要拦) next(false)
  else next()
}

// 新写法：返回值式，签名只有 (to, from)
beforeRouteLeave(to, from) {
  if (要拦) return false
  // 什么都不 return 就等于放行
}
```

两套 API 要共用同一条管线，怎么在运行时分？答案是看函数声明的**形参数量**（`Function.length`）：旧写法声明了三个参数 `(to, from, next)`，新写法只有两个 `(to, from)`。于是适配器只需一个判断：

```ts
const ret = guard(to, from, next)
let call = Promise.resolve(ret)
if (guard.length < 3) call = call.then(next) // 新写法：把返回值喂给 next 翻译
// 旧写法：next 交给使用者，由他们在函数体里自己调
```

新写法时，守卫的返回值（可能是 `false`、一个地址、一个 Promise）会被自动喂给 `next` 翻译；旧写法时，适配器把 `next` 递给使用者，由他们自己调。两条分支，靠一个 `length < 3` 自动切换，使用者零迁移成本。

## 第四步：用 reduce 把一队守卫串成一条顺序链

单个守卫已经是个 `() => Promise<void>` 了，一队守卫怎么排着队跑？答案朴素得有点意外——**一个 reduce**：

```ts
function runGuardQueue(guards) {
  return guards.reduce(
    (chain, g) => chain.then(() => g()),
    Promise.resolve()
  )
}
```

把它想象成一条流水线（这是本章唯一一个比方）：每个工位是一个守卫，前一个工位盖了"放行"章（resolve），下一个工位才开始干活；任何一个工位喊"停"（reject），整条线立刻停，后面的工位碰都不用碰。这正是 reject 的短路特性白送的——不用写任何"如果前面失败就跳过后面"的判断，Promise 链自己就会停。

完整的守卫顺序是固定的：

```
离开 beforeRouteLeave → 全局 beforeEach → 更新 beforeRouteUpdate
→ 路由级 beforeEnter → 组件 beforeRouteEnter → 全局 beforeResolve
```

每一段都是这样一条 reduce 出来的链，段与段之间还会插"取消检查"（一旦发现有了更新的导航，整条管线作废）。这些段的**拼接**和取消检查由更上层的导航主循环负责，本章交付的是组成它的零件：切三组、适配器、顺序链。

## 原理演示

把上面四步合起来，下面这个几十行的程序就能演透守卫管线的核心。它故意省略了懒加载、keep-alive、组件就绪回放等细节，只聚焦"切三组 + 适配器 + 形参判别 + 顺序链 + 任一 reject 短路"。用 `tsx`/`bun` 直接跑即可：

```ts
// ---- 失败种类（只演示守卫会产出的两种；真实的可恢复设计见第 4 章）----
const FAIL = { ABORTED: 'ABORTED', REDIRECT: 'REDIRECT' } as const

// ---- 把任意风格的守卫包成 () => Promise<void> ----
function guardToPromise(guard: any, to: any, from: any): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      // 「继续回调」：三种意图 → resolve / 带种类的 reject
      const next = (valid?: any) => {
        if (valid === false) reject({ kind: FAIL.ABORTED, from, to })
        else if (valid instanceof Error) reject(valid)
        else if (valid && typeof valid === 'object' && 'path' in valid)
          reject({ kind: FAIL.REDIRECT, from: to, to: valid })
        else resolve()
      }
      const ret = guard(to, from, next)
      let call = Promise.resolve(ret)
      if (guard.length < 3) call = call.then(next) // 形参数量判 API
      call.catch(reject)
    })
}

// ---- 一队守卫 reduce 成顺序链，任一 reject 短路 ----
function runGuardQueue(guards: Array<() => Promise<void>>) {
  return guards.reduce((chain, g) => chain.then(() => g()), Promise.resolve())
}

// ---- 凭引用相等切离开/更新/进入三组 ----
function extractChangingRecords(to: any, from: any) {
  const leaving: any[] = [], updating: any[] = [], entering: any[] = []
  const len = Math.max(from.matched.length, to.matched.length)
  for (let i = 0; i < len; i++) {
    const rf = from.matched[i]
    if (rf) to.matched.includes(rf) ? updating.push(rf) : leaving.push(rf)
    const rt = to.matched[i]
    if (rt && !from.matched.includes(rt)) entering.push(rt)
  }
  return { leaving, updating, entering }
}
```

跑一条轨迹：从 `/users/123`（matched = `[列表, 详情]`）跳 `/login`（matched = `[登录]`），详情上有个离开钩子返回 `false`。

```ts
const listRec   = { beforeRouteLeave: () => {} }    // 列表：放行
const detailRec = { beforeRouteLeave: () => false } // 详情：要拦
const loginRec  = {}

const from = { matched: [listRec, detailRec] }
const to   = { matched: [loginRec] }

const { leaving } = extractChangingRecords(to, from)
// → [listRec, detailRec]，reverse 后 → [detailRec, listRec]（子先于父离开）

const queue = leaving
  .reverse()
  .map(rec => guardToPromise(rec.beforeRouteLeave, to, from))

runGuardQueue(queue).catch(fail => console.log('导航结束：', fail.kind))
// detailRec 的离开钩子返回 false → next(false) → reject({kind: ABORTED})
// → 链短路 → 打印：导航结束：ABORTED
// 全局 beforeEach 那一段根本没机会跑
```

这条轨迹说明了一件事：**只要离开组里有一个钩子说"不"，整条管线当场短路**，后面那些全局前置、进入钩子碰都不会碰。这正是顺序链 + reject 短路带来的强保证。

## 关键权衡

上面那些机制，每一条背后都有个"为什么这么设计"的故事。

**权衡一：用形参数量判 API。** 选了"看 `guard.length < 3`"这条路 → 换来两套 API 共用同一条管线、使用者零迁移成本，旧项目不重写一个钩子就能继续跑 → 代价是判定依赖 `length` 这个隐式契约：默认参数、剩余参数（`...args`）、解构都会扰动它，而且旧 API 那条"带 next 回调"的分支写起来更绕。说人话就是——它把"区分两套写法"这件本该显式声明的事，悄悄藏进了函数签名里，省了你一个配置项，但埋了个"别在守卫参数里用 `...args`"的隐性约束。

**权衡二：三种意图统一编码成 resolve / 带种类的 reject。** 选了"放行是 resolve、拒绝和重定向是带不同种类的 reject" → 换来上层只需一个 catch 就能拿到结构化的失败原因，且和顺序链天然契合（一个 reject 立刻短路）→ 代价是"重定向"这种本质正常的控制流也得借 reject 来表达，必须为它单设一种失败种类，否则会和真报错混在一起。这是把"控制流"和"错误"塞进同一个通道换来的简洁——好处是管线只有 resolve / reject 两种走向，坏处是第一次看到"重定向居然是 reject"的人会有点反直觉。

**权衡三：导航期提前拉懒加载 chunk，并原地替换记录。** 组件常常写成 `() => import('./Detail.vue')` 这种懒加载工厂。选了"在抽取组件守卫这一步、立刻调用工厂触发 chunk 请求，解析后把组件原地写回它所属的记录" → 换来导航走完时组件已经就绪、渲染零额外等待，而且首次解析后，后续导航直接命中那个已被替换的对象（整个生命周期只请求一次 chunk）→ 代价是导航管线和模块加载耦合了：加载失败得被翻译成可读错误，而且记录在导航期间会被改动。一个直观的画面：原本记录里放的是一张"提货单"，导航一开始我们就去把货取来，直接把提货单换成真货——下次再来，看到的就是真货本身。这个机制还有个副作用好处：到了全局 `beforeResolve` 那一段，所有组件保证都已解析完毕，不会再有 `() => Promise` 残留。

**权衡四：组合式守卫和组件生命周期绑死。** `onBeforeRouteLeave` / `onBeforeRouteUpdate` 让你在任意组件（不限于路由组件）里注册守卫。选了"通过 inject 拿到当前所属的匹配记录，把守卫的注册 / 注销绑到组件的挂载、卸载、keep-alive 激活 / 停用" → 换来不限位置、任意组件都能挂守卫，且随组件存活自动清理、不会内存泄漏 → 代价是得专门处理 keep-alive 的边界：同一个组件实例可能被缓存复用到不同路由（没卸载），所以重新激活时不能想当然地还认旧记录，必须重新核对"我现在到底属于哪条记录"。换句话说，这个设计把守卫的存活权交给了组件，省了手动注销，但为 keep-alive 这个复用场景多打了一份补丁。

这四条权衡合起来，回答了本章开头那个问题：异步、可取消、可重定向、多时机、双 API 这五件互相打架的事，是怎么被一套统一设计兜住的——靠的就是"统一成 Promise + 顺序链短路 + 失败语义化"这三板斧。

## 小结

导航守卫管线的核心，可以浓缩成一句话：**把每个守卫适配成一个返回 Promise 的函数，用一条 reduce 串起来的顺序链跑它们，守卫的放行 / 拒绝 / 重定向三种意图，分别对应这条链上 Promise 的 resolve 和带不同种类的 reject。** 切三组、形参判 API、顺序链短路，都是为这套统一模型服务的零件。

值得再强调的是，本章交付的是**零件**：切分函数、适配器、顺序链。真正把这些零件按完整顺序拼起来、并在每一段之间插上"取消检查"的，是更上层的导航主循环——那是后面的事。

如果导航成功放行了，紧接着有个用户体验上的小细节要处理：新页面渲染后，滚动条该停在哪？是回到顶部，还是恢复你上次离开这个页面时的位置？这就是紧邻下一章「滚动位置恢复」要解决的问题——它会把"滚动可见性"和"导航生命周期"绑在一起，而不是和数据到达的时刻绑在一起。