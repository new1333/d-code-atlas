# $patch 与深度合并：批量变更的统一入口

## 一、为什么 store 需要一个「批量更新」入口

设想你在写一个购物车 store，用户点「全选并结算」时，你要同时改 `selected`、`checkedOut`、`checkoutAt` 三个字段。最朴素的写法是：

```ts
store.selected = true
store.checkedOut = true
store.checkoutAt = Date.now()
```

但 Pinia 内部对 state 的写入是有人盯着的——订阅者靠 watch 拿到变更通知。**直改三次，watch 会触发三次**：你的 `$subscribe` 回调被调用三遍、devtools 时间线上出现三条 mutation 记录、绑定到这些字段的组件也可能连续重渲染三次。

更要命的是，有些更新根本不止三个字段，可能是一整个嵌套子树的局部更新（比如只想改 `user.profile.address.city`，其它字段都保留）。如果没有一个统一入口，你得自己写「找到目标对象 → 部分覆盖 → 注意别破坏引用」的合并逻辑——每个团队、每个项目重写一遍，bug 也就复制 N 份。

`$patch` 就是来解决这两件事的：

1. **把窗口内的多次赋值，对外只通知一次。**
2. **同时支持两种写法**——函数式（自由度高，能 push/splice）和对象式（声明式，可序列化、可深合并）。

依赖关系上，它建立在上一章讲的订阅系统（`addSubscription` 注册回调、`triggerSubscriptions` 触发回调）之上。

## 二、核心思想：先静音，再一次性通知

把 patch 窗口想成「开会时手机静音」：

- 进会议室前，先把手机调成静音（关掉监听开关）。
- 会议期间别人发你十条消息，你都没收到提示，但消息本身都正常到达（state 的值都改了）。
- 会议一结束，你打开手机，**只看到一条「有 10 条未读」的汇总通知**（手动触发一次订阅）。
- 半分钟后你恢复实时推送（异步监听在下一个 microtask 恢复）。

`$patch` 干的就是这件事。它用两个模块级开关控制监听状态：`isListening`（异步监听）和 `isSyncListening`（同步监听）。一进 patch 立刻都关掉，函数/对象两条路径任选其一改完 state 后，**手动**调一次订阅触发，再把监听开关打开。

最小可跑演示（依赖 `vue` 包，能 `bun run` / `node` 跑）：

```ts
import { reactive, watch, nextTick } from 'vue'

const state = reactive({ a: 0, b: 0, c: 0 })
let listening = true            // 异步监听开关
let syncListening = true        // 同步监听开关
const subs = new Set<(m: string) => void>()
subs.add(m => console.log('订阅收到：', m))

// 模拟 Pinia 的 watcher：listening=false 时不通知订阅者
watch(state, () => {
  if (listening) subs.forEach(cb => cb('async watch 触发'))
}, { deep: true })

function patch(mutator: (s: typeof state) => void) {
  listening = syncListening = false      // 1. 进会议室，手机静音
  mutator(state)                         // 2. 开会：用户在回调里随便改
  syncListening = true                   // 3. 同步监听立即恢复
  subs.forEach(cb => cb('patch 一次'))   // 4. 手动发一条汇总通知
  const myId = Symbol()                  // 5. 给自己发一张「恢复令牌」
  nextTick().then(() => { listening = true })  // 6. 半分钟后恢复实时推送
}

patch(s => { s.a = 1; s.b = 2; s.c = 3 })
// 控制台只输出一行：「订阅收到：patch 一次」
// 三次赋值的 watch 因 listening=false 全程静默，被合并成一次通知
```

把第 1 步去掉（不关监听），你会看到三行 `async watch 触发`——这就是 patch 没存在时的世界。

## 三、两条路径：函数式 vs 对象式

`$patch` 接收一个参数，类型决定走哪条路。

**函数式**——把当前 store 的 state 喂给你的回调，你爱怎么改怎么改：

```ts
store.$patch((state) => {
  state.list.push(item)         // 能用 push
  state.count++                  // 能直接自增
  state.tags.delete('foo')       // 能调集合方法
})
```

**对象式**——传一个 partial 对象，Pinia 内部调 `mergeReactiveObjects` 递归合并：

```ts
store.$patch({
  profile: { name: 'A' },        // 只改 name，其它字段保留
  count: 1,
})
```

两条路最终都生成一个 mutation 描述符（标 `patchFunction` 还是 `patchObject`），交给订阅系统。差别只在「怎么改 state」：函数式完全交给用户；对象式由框架替你做合并。

## 四、关键权衡 1：暂停监听换批量合并，代价是「丢一次事件」

这是整章最重要的一个权衡，值得展开。

**做了什么选择**：在 patch 窗口里把 `isListening` 和 `isSyncListening` 都置 false，结束后**手动**调 `triggerSubscriptions` 发一次通知。

**换来了什么**：多次赋值对外只触发一次订阅。无论你在 mutator 里改了 3 个字段还是 30 个字段、是同步循环还是嵌套对象，订阅者的回调都只跑一遍。对 devtools 时间线、对 `$subscribe` 监听、对组件渲染，这都是巨大的降噪。

**代价是什么**：两个监听开关的恢复时机不对称。看演示里的顺序：

```ts
syncListening = true                              // 同步监听：立刻恢复
subs.forEach(cb => cb('patch 一次'))              // 手动触发订阅
nextTick().then(() => { listening = true })       // 异步监听：下一个 microtask 才恢复
```

同步监听在「手动触发订阅」**之前**就打开了。这意味着：如果你的订阅回调里又改了一次 state，**同步 watcher 会立刻响应**（已经恢复了），但**异步 watcher 不会**（要等 nextTick）。

这就留下一个窗口：从「patch 同步阶段结束」到「下一个 microtask」之间，若有人直改 state（不通过 `$patch`），异步订阅会丢一次事件。说人话就是：

> patch 之后不要立刻 `store.x = 1` 直改，要么继续包在 `$patch` 里，要么 `await nextTick()` 之后再改。

**嵌套 patch 的恢复权之争**。如果 mutator 里又调了 `$patch`（嵌套），外层和内层都会排一个 `nextTick(恢复 isListening)`。Pinia 用一个 `Symbol` token 解决「谁能恢复」：每次进 patch 生成新 Symbol 写到模块级 `activeListener`，nextTick 回调里只有 token 匹配的那一个才真把监听打开，外层的恢复回调被静默丢弃。**只有最内层、最后一次 patch 拥有恢复权**——这避免了嵌套场景下监听被过早恢复。

这个权衡不是缺陷，而是有意为之：Pinia 选择「同步语义可预测、异步语义更省事」，代价就是用户得知道这个 nextTick 窗口的存在。绝大多数场景里 `$subscribe` 回调不会再去直改 state，所以这个代价几乎不可见；但写工具库或测试断言时必须意识到。

## 五、对象路径怎么合并：按类型分流

对象路径走 `mergeReactiveObjects`，策略一句话能说完：**按 key 遍历 partial，普通对象就递归合并，其它类型一律整值替换**。但「其它类型」具体是哪些，决定了你能不能正确预测行为。

最小演示（手写一遍合并逻辑，演清「按类型分流」）：

```ts
import { isRef, isReactive, reactive } from 'vue'

// isPlainObject 的判定：toString 看到 [object Object] 才算，且不能带 toJSON
function isPlainObject(o: unknown): boolean {
  return Object.prototype.toString.call(o) === '[object Object]'
    && (o as any)?.toJSON === undefined
}

function mergeReactiveObjects(target: any, patchToApply: any): any {
  if (target instanceof Map && patchToApply instanceof Map) {
    patchToApply.forEach((value, key) => target.set(key, value))   // Map：按 key 覆盖值
    return target
  }
  if (target instanceof Set && patchToApply instanceof Set) {
    patchToApply.forEach(value => target.add(value))               // Set：批量 add
    return target
  }
  for (const key in patchToApply) {
    if (!Object.hasOwn(patchToApply, key)) continue
    const subPatch = patchToApply[key]
    const targetValue = target[key]
    if (isPlainObject(targetValue) && isPlainObject(subPatch)
        && Object.hasOwn(target, key)
        && !isRef(subPatch) && !isReactive(subPatch)) {
      target[key] = mergeReactiveObjects(targetValue, subPatch)    // 都是普通对象 → 递归
    } else {
      target[key] = subPatch                                       // 其它 → 整值替换
    }
  }
  return target
}

const state = reactive({
  profile: { name: 'B', age: 20 },     // 普通对象子树
  tags: new Set<string>(),              // Set
  counts: new Map<string, number>(),    // Map
  list: [1, 2, 3],                      // 数组
  born: new Date(2020, 0, 1),           // Date
})

mergeReactiveObjects(state, {
  profile: { name: 'A' },               // → 只改 name，age 保留
  tags: new Set(['x']),                 // → add('x')
  counts: new Map([['k', 1]]),          // → set('k', 1)
  list: [9],                            // → 整个数组被替换成 [9]
  born: new Date(2026, 0, 1),           // → 整个 Date 被替换
})
// 结果：
// state.profile = { name: 'A', age: 20 }   ← 深合并
// state.tags    = Set(['x'])
// state.counts  = Map { 'k' => 1 }
// state.list    = [9]                       ← 整值替换，不是 push
// state.born    = Date(2026, 0, 1)          ← 整值替换
```

## 六、关键权衡 2：递归合并 vs 浅赋值，代价是「类型决定写法」

**做了什么选择**：partial 路径用「按 key 递归合并」而不是 `Object.assign` 一把覆盖。

**换来了什么**：嵌套普通对象能局部 patch。`{ profile: { name: 'A' } }` 只动 name，profile 下的 age、avatar、address 等所有字段都原样保留。这对状态树深的 store（用户信息、配置、表单）几乎是刚需——不可能每次改一个城市就重传整个 profile。

**代价是什么**：用户必须记住「**数组用函数路径、对象用 partial 路径**」这条潜规则。看上面演示最后一组：你传 `list: [9]`，结果整个 list 被替换成 `[9]`，**不是 push 进去**。因为数组虽然 `typeof` 看是 object，但 `Object.prototype.toString.call([])` 返回 `[object Array]`，不满足 `isPlainObject`，所以走「整值替换」分支。Date 同理（带 toJSON）、Map/Set 实例同理、甚至你自己定义了 toJSON 的类实例也同理。

所以社区文档反复强调：

```ts
// ❌ 想给数组追加，写对象路径会被整体替换
store.$patch({ list: [newItem] })

// ✅ 用函数路径才能 push
store.$patch(s => s.list.push(newItem))
```

**为什么 isPlainObject 还要排除 ref/reactive**。如果你在 partial 里塞了一个 `ref(1)` 或 `reactive({...})`，merge 时会走整值替换，**而不是**把这个 ref 解包后塞进 state。这是为了保护 setup store 里用户手动包好的响应式容器——你 setup 里 `return { count: ref(0) }`，那 count 就是个 ref；别人 `$patch({ count: 5 })` 应该是「把 count 这个位置替换成 5」，而不是「解包合并」。Pinia 选择保留响应式包装的边界，代价是 partial 里塞 ref 的语义对新手不够直觉。

## 七、关键权衡 3：Map 按 key 覆盖、Set 只能 add

**做了什么选择**：Map 走 `target.set(key, value)`、Set 走 `target.add(value)`，**不**对集合元素做递归合并。

**换来了什么**：keyed collection 的「增量更新」语义能工作。你有一个 `Map<string, User>`，partial 里传一个 `Map([['u1', { name: 'A' }]])`，结果是 u1 这个 key 的整个 User 被新值覆盖——而不是「u1 的 name 字段被覆盖、其它字段保留」。这跟普通对象的递归合并行为不同，但对 Map 来说更合理：Map 的 value 通常是一个完整业务对象（一个用户、一个商品），整体覆盖比字段级 merge 更可预测。

**代价是什么**：

1. **Map 不是真递归 merge**。如果你期望 `Map([['u1', { name: 'A' }]])` 只改 u1 的 name 而保留它的 age——对不起，整个 u1 被替换成 `{ name: 'A' }`。要做到字段级合并，你得在 mutator 里自己取出来改：
   ```ts
   store.$patch(s => {
     const u = s.users.get('u1')!
     u.name = 'A'
   })
   ```
2. **Set 只能 add 不能 delete**。`$patch({ tags: new Set(['x']) })` 永远只会**加**元素，不会因为 partial 里没某个元素就把它从原 Set 删掉。要删元素走 mutator：
   ```ts
   store.$patch(s => s.tags.delete('y'))
   ```

这两个限制不是疏忽，是 Pinia 对「集合的语义」做的明确选择：**集合当成整体来覆盖/追加，不参与字段级合并**。一旦你理解了这一点，partial 路径的行为就完全可预测了。

## 八、心智模型总结

把整章压缩成 7 步：

1. 调 `$patch`，参数是函数或对象，进入分流。
2. **立刻把两个监听开关都关掉**——异步监听 `isListening`、同步监听 `isSyncListening`，watcher 暂停响应。
3. 函数路径：把 store state 喂给 mutator，用户自由改。
4. 对象路径：`mergeReactiveObjects` 按 key 遍历——普通对象递归、Map 按 key 覆盖、Set 批量 add、其它（数组/Date/ref/reactive）整值替换。
5. 构造 mutation 描述符（标 `patchFunction` 或 `patchObject`）。
6. **手动触发一次** `triggerSubscriptions`，把描述符 + 新 state 发给所有订阅者。
7. **同步监听立即恢复**（在触发之前就开了）；**异步监听在下一个 microtask 由 token 校验后恢复**。

记住三句人话：

- patch 是「**开会静音、会后汇总**」。
- 对象路径下，「**对象深合并、集合整体来**」。
- patch 之后别立刻直改 state，要么继续 patch，要么 `await nextTick()`。

理解了这三句，你就掌握了 `$patch` 的全部主线设计；剩下的边界（devtools 事件收集、HMR/hydration 复用同一套暂停-恢复模式）都是这条主线的衍生应用。