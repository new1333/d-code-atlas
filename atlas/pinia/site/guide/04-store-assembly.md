# Store 装配：effectScope 托管的返回值分类与状态镜像

想象你用 setup 语法写了一个 store：

```ts
const useCart = defineStore('cart', () => {
  const items = ref([])
  const count = computed(() => items.value.length)
  function add(item) { items.value.push(item) }
  return { items, count, add }
})
```

你 `return` 出去的就是一个普通对象，三个属性谁也没贴标签。可 Pinia 不能就这么收下它：`items` 是状态，得能被序列化、得进 devtools；`count` 是派生值，要保持响应式但**不该**被当成状态存进数据库；`add` 是动作，得能被 `$onAction` 拦截。更要命的是，store 之间还会互相勾搭——购物车的动作里去拿用户信息，用户信息又回头来读购物车。如果非得等一个 store 彻底装配好才允许别人找到它，那就可能卡在「购物车等我装配完 → 我又等购物车装配完」的死循环里。

这一章讲的就是装配函数怎么把这两件事——**给无标签返回值分类**、**让 store 互相引用还不死循环**——一次性解决。

在开始之前，先记住三个老朋友，它们来自前面的章节，本章只是来「消费」它们：根作用域（挂载全部响应式效果的总作用域，第 1 章讲过它为什么是单例）、注册表（id→store 的缓存 Map，第 1 章建立、第 3 章用它做惰性缓存）、根状态树（挂在 Pinia 上的那一个状态对象，第 1 章埋下的种子）。第 3 章告诉我们：`defineStore` 不立即造 store，而是返回一个把创建推迟到首次调用的 `useStore` 闭包。本章要看的，正是那次「首次调用」背后、装配函数内部**究竟怎么把一个 setup 函数的返回值变成一个真正能用的 store 对象**。

## 一、装配长什么样：七步心智模型

装配函数是所有 store 唯一的出生地。不管是 setup 语法定义的 store，还是 options 语法定义的 store，最后都汇到这里。它干的事情可以拆成七步，自底向上看：

```
① 根状态树里先放一个空条目  ──▶  ② 把内置方法拼成「半成品壳」
        │                                   │
        │                                   ▼
        │                         ③ 把壳包成 reactive()
        │                                   │
        ▼                                   ▼
④ 把还没跑 setup 的半成品壳塞进注册表  ◀──（关键一步）
        │
        ▼
⑤ 在根作用域下开一个子 effectScope，同步跑 setup，拿到返回的扁平对象
        │
        ▼
⑥ 遍历返回值做三分类：ref/reactive 当 state（镜像进根状态树）、函数当 action、computed 留作 getter
        │
        ▼
⑦ 分类结果合并进 store、装上 $state 访问器、打开状态监听开关、返回 store
```

这七步里，第 ④⑤⑥ 步是灵魂。第 ④ 步「先把没完工的 store 登记进注册表」解决互引死循环；第 ⑤ 步「在子作用域里跑 setup」让整棵响应式树可被一次性回收；第 ⑥ 步「三分类 + 镜像」让全应用只有一棵可序列化的状态树。下面四节就是围绕这三步背后的四个权衡展开。

## 二、关键权衡一：先登记半成品，再跑 setup（防互引死循环）

这一条是整章最关键的设计。先看它换了什么、代价又是什么。

**做了什么选择**：在跑 setup **之前**，就把那个还什么都没有的半成品壳塞进注册表。换句话说，注册顺序是「先挂号，再体检」——挂号本上先写上你的名字（哪怕你还没开始检查），别人来查你的时候，至少能查到「你在册」。

**换来了什么**：store 之间可以放心地互相引用，不会陷入死循环。具体怎么断开的，看这个时序（假设先有人要购物车）：

```
调用 useCart()
  → 购物车壳 reactive 化
  → 注册表写入 'cart' → 半成品（此刻还没 items/count/add）   ★挂号
  → 跑购物车的 setup
       → setup 里调用 useUser()
            → 用户壳 reactive 化
            → 注册表写入 'user' → 半成品                        ★挂号
            → 跑用户的 setup
                 → setup 里调用 useCart()
                      → 注册表查 'cart' → 命中半成品！直接返回   ★循环在这里断开
                 → 用户 setup 跑完 → 三分类 → 用户装配完整
       → 购物车的 setup 拿到的是【完整】的用户
  → 购物车 setup 跑完 → 三分类 → 购物车装配完整
```

关键在倒数第三行：用户的 setup 回头要购物车时，购物车虽然还在跑自己的 setup（还是个半成品），但它**已经挂号在册**了，所以注册表能直接把它交出去，而不会傻乎乎地「重新创建一个购物车」——死循环就在这一刻断开。

**代价是什么**：装配期间的 store 处于半成品状态，谁先被装配、谁后被引用，时序被钉得很死。说人话就是：**先装配的那个 store（被别人回头引用的）在引用方的 setup 里是半成品**。在上面这个例子里，购物车先挂号，所以用户 setup 拿到的购物车是半成品——此时购物车的状态、动作都还没合并上去。如果你在用户的 setup **顶层**立刻去读 `cart.count`，会拿到 `undefined`。所以写跨 store 引用时，把对半成品的真正读写**放进 action 里**：action 是个闭包，等它真正被调用时，购物车早就装配完整了，这时读 `cart.count` 就能拿到正确值。而反过来，购物车 setup 拿到的用户是完整的——因为用户是「装配完整了才返回」给购物车的。

这个时序约束是「先挂号」这条路的必然代价，但它换来的是「store 可以任意互相引用而永不被死循环卡住」，这笔买卖很值。

## 三、关键权衡二：子 effectScope 托管全部响应式（一次性 dispose）

**做了什么选择**：跑 setup 时不是随便找个地方跑，而是严格套进三层嵌套——根作用域跑 → 新开一个子 effectScope → 在子作用域里跑 setup。

如果给每个 store 打个比方，子作用域就是发给它的一个**专属垃圾袋**：setup 里创建的所有 ref、computed、侦听器，统统丢进自己这个袋子。将来要销毁这个 store，一行 `$dispose` 就是把袋口一扎、整袋扔掉（`scope.stop()`），里面所有响应式效果一次性失效，不用你挨个去清理。

**换来了什么**：store 的销毁变得干净利落。第 1 章埋下的根作用域设计，在这里兑现——正因为 setup 是在「根作用域 → 子作用域」这条链上同步跑的，它产生的所有效果才会被正确归到这个 store 名下。组件卸载时、测试重置时，一个 store 能被完整回收，不留尾巴。

**代价是什么**：setup 必须**同步**执行才能被托管。设想一下，如果 setup 里 `await` 了一段异步代码，await 之后创建的 ref 就已经跑出了子作用域的管辖范围，垃圾袋扎不住它。所以装配流程要保证「开子作用域 → 跑 setup → 拿到返回值」这三步一口气同步完成，中间不能有任何让出执行权的间隙。这也是为什么 Pinia 的 setup 函数虽然在写法上像个 async composable，但状态部分必须是同步初始化的——异步只允许出现在 action 内部，不出现在 setup 顶层。

## 四、关键权衡三：返回值三分类 + 状态镜像（单一可序列化状态树）

setup 把一箱「没贴标签的零件」交回来，装配函数得当分拣员，靠**形状**把它们分进三个筐。

判别规则就三条，全是运行时看出来的：

```
遍历返回对象的每个属性 prop：
  ├─ 是 ref 但不是 computed，或是 reactive 对象  →  state
  ├─ 是函数                                     →  action
  └─ 是 computed（带 .effect 的 ref）            →  getter
```

这里有个妙处：computed 本身也是一种 ref，那怎么跟普通的 state ref 区分？答案是 computed 内部多带了一个 `.effect` 字段。判别式就是 `isRef(o) && o.effect`——是 ref、且身上挂着 `.effect`，那就是 computed（派生值）；是 ref、但没挂 `.effect`，那就是 state。这一招让分拣员不需要你给属性打任何标签，光靠形状就能分清。

**做了什么选择**：分拣出来的 state，不只在 store 上留着，还要**再抄一份登记进根状态树**——`pinia.state.value[id][key] = prop`。注意是「同一个 ref 被登记进根树」，不是复制一份值，所以 store 里改了，根树里也跟着变，它们是同一个东西的两个名字。

**换来了什么**：整个应用只有**一棵**可序列化的状态树。SSR 要把状态序列化发给客户端、devtools 要展开看你的状态、`$state` 要整体读写——所有这些「宏观操作」都只盯这一棵树，不用去各个 store 里到处收集。这就是「状态镜像」换来的最大好处：状态的真相只有一个出处。

**代价是什么**：每个状态 ref 在分类时要多走一道「登记进根树」的手续；而且在 SSR 水合时，方向得反过来——入站的状态要先灌进用户创建的 ref，而这个 ref 又已经被登记进根树了，双向同步的逻辑会更绕。不过对绝大多数前端场景（没有 SSR），你只会感受到「单一状态树」的清爽，感觉不到这道代价。

## 五、关键权衡四：整个 store 包成 reactive()（对象式人体工学）

**做了什么选择**：装配出来的不是一个普通对象，而是把整个 store 包成 `reactive()`。

这个决定换来的是「对象式」的好手感，就像给 store 套了一个**自动售货机外壳**：

- `store.count` 直接读到值——reactive 会自动把里面的 ref 解包，你不用写 `store.count.value`；
- `store.count = x` 直接赋值——它会自动改到底层的 ref；
- `store.add(item)` 直接调用——动作就是个普通方法。

如果 store 不是 reactive，你得天天写 `store.count.value`、`store.items.value`，那体验就回到 Vuex 之前了。reactive 这层壳把这层啰嗦全包了。

**代价是什么**：state、getter、action 三类东西被揉进了**同一个** reactive 对象里，从外面看长得一模一样，很难分辨谁是状态、谁是派生、谁是动作。正是这个代价，逼出了后面的 `storeToRefs`——它得专门写一套定向提取逻辑，才能把 state 和 getter 单独拎出来（又不把 action 错包成 ref）。另外，reactive 代理会干扰属性的枚举，导致装配末尾还得往 `toRaw(store)`（剥掉代理的原始对象）上再合并一次返回值，给后续的定向提取留一个「没被代理包裹」的干净视图。这一层 reactive 壳的好处很实在，但它引出的连锁麻烦也不少。

> 顺带一提，装配时往 store 上挂的 `$onAction`、`$subscribe`，内部用的是第 2 章那套订阅原语（最小的「回调集合 + 增删」）。原语本身第 2 章已讲透，这里它们只是在装配期被「挂上去」，本章不重演。

## 六、最小原理演示

下面这段脚本把上面四条权衡的核心——「先挂号防死循环」+「三分类 + 状态镜像」+「子作用域托管」——演透。它不追求工程完整（省略了 `$patch`、订阅、热更新、SSR 水合等后续章节的内容），只演原理。装好 `vue` 后可以用 `node` 直接跑：

```js
// assembly-demo.js —— 用 node 直接跑：node assembly-demo.js
const { ref, reactive, computed, effectScope, isRef, isReactive, toRaw } = require('vue')

// ── 极简 Pinia 骨架：只留装配需要的三样 ──
function createMiniPinia() {
  return {
    state: ref({}),         // 根状态树（单一可序列化对象）
    _s: new Map(),          // 注册表：id → store
    _e: effectScope(true),  // 根作用域（detached，可一次性 stop）
    _scopes: new Map(),     // id → 该 store 的子作用域（$dispose 用）
  }
}

// computed 判别式：computed 是「带 .effect 的 ref」，这是三分类的唯一运行时依据
function isComputed(o) {
  return !!(isRef(o) && o.effect)
}

// ── 装配工厂：所有 store 的唯一出生地 ──
function createSetupStore(id, setup, pinia) {
  // ① 根状态树里先放一个空条目
  if (!pinia.state.value[id]) pinia.state.value[id] = {}

  // ②③ 把壳包成 reactive
  const store = reactive({ $id: id })

  // ★④ 先登记半成品进注册表（此刻 setup 还没跑！）
  pinia._s.set(id, store)
  console.log(`  [装配 ${id}] 半成品已挂号进注册表，准备跑 setup`)

  // ★⑤ 根作用域 → 子作用域，同步跑 setup（所有 ref/computed 都归这个子作用域管）
  let scope
  const setupStore = pinia._e.run(() => (scope = effectScope()).run(setup))
  pinia._scopes.set(id, scope)

  // ★⑥ 遍历返回值，三分类
  for (const key in setupStore) {
    const prop = setupStore[key]
    if ((isRef(prop) && !isComputed(prop)) || isReactive(prop)) {
      pinia.state.value[id][key] = prop          // state：镜像进根状态树
    } else if (typeof prop === 'function') {
      // action：真实现会在这里包一层拦截器（供 $onAction 用），本演示省略
    }
    // computed：getter，原样留，不进根状态树
  }

  // ⑦ 合并进 store（含 toRaw 再合并一次，给后续提取留干净视图）
  Object.assign(store, setupStore)
  Object.assign(toRaw(store), setupStore)
  return store
}

// defineStore：返回惰性 useStore 闭包（第 3 章已讲透，这里只复用机制）
function defineStore(id, setup) {
  return function useStore(pinia) {
    if (pinia._s.has(id)) return pinia._s.get(id)   // 命中缓存（含半成品！）
    return createSetupStore(id, setup, pinia)
  }
}

// ── 两个互相引用的 store ──
const pinia = createMiniPinia()

const useCart = defineStore('cart', () => {
  console.log('  [cart setup] 开始跑')
  const items = ref([])
  const count = computed(() => items.value.length)
  // 购物车引用用户 —— 此时用户还没装配，先去装配它
  const user = useUser(pinia)
  console.log(`  [cart setup] 拿到的 user 是【完整】的: user.name = ${user.name}`)
  function add(item) { items.value.push(item) }
  return { items, count, add }
})

const useUser = defineStore('user', () => {
  console.log('  [user setup] 开始跑')
  const name = ref('alice')
  // 用户回头引用购物车 —— 命中已挂号的半成品购物车！循环在这里断开
  const cart = useCart(pinia)
  console.log(`  [user setup] 拿到的 cart 是【半成品】: cart.count = ${cart.count}`)
  console.log(`  [user setup]               半成品 cart 上有 items 吗? ${'items' in cart}`)
  // 把对半成品的真正读写放进 action：等调用时购物车早已装配完整
  function echo() { return cart.count }
  return { name, echo }
})

console.log('=== 触发 useCart()，开始装配 ===')
const cart = useCart(pinia)
const user = pinia._s.get('user')
console.log('\n=== 装配完成，验证 ===')
console.log('cart.count         =', cart.count)        // 0
console.log('user.name          =', user.name)          // alice
cart.add('apple')
console.log("cart.add('apple') 后 cart.count =", cart.count)  // 1
console.log('user.echo()        =', user.echo())        // 1 —— action 调用时购物车已完整
```

## 七、跑出来的关键现象

把上面这段跑起来，你会看到几件值得记住的事：

1. **两个 store 互相引用，装配照常完成，没有死循环。** 这正是「先挂号」的功劳：购物车先挂号进注册表，用户回头找购物车时命中半成品、直接返回，环就在这里断开。

2. **被半成品引用的是「先装配」的购物车，而不是用户。** 用户 setup 顶层立刻读 `cart.count` 得到 `undefined`，查 `'items' in cart` 也是 `false`——因为此刻购物车还是个壳，状态和动作都还没合并上去。而购物车 setup 读到的 `user.name` 是 `'alice'`，是完整的——因为用户是「装配完整后才返回」给购物车的。所以跨 store 引用的安全写法是：把对别人的真正读写放进 action 里，等调用时对方早已装配完整。

3. **三分类后，根状态树里只有 state。** 镜像进根状态树的是 `items` 和 `name`；`count` 是 computed（getter），`add`/`echo` 是 action，它们都不进根状态树。全应用的可序列化状态，就集中在这一个对象里——这正是权衡三换来的「单一状态树」。

4. **action 里的引用能读到最新值。** `user.echo()` 调用时返回 `1`，因为它是闭包，真正执行时购物车早就装配完整、`cart.count` 已经是最新值。这呼应了现象 2：顶层读半成品会扑空，但放进 action 就安全。

## 小结

装配的本质，是在「setup 返回值没有类型标签」和「store 之间任意互引」这两个约束下，把一个函数的返回值改造成一个可分类、可序列化、可回收、可顺手调用的 store 对象。它靠四个设计扛住了这两条约束：**先挂号半成品**断开互引死循环（代价是半成品时序约束）；**子作用域托管**让整棵响应式树一次性可销毁（代价是 setup 必须同步）；**三分类 + 状态镜像**收束出单一可序列化状态树（代价是 SSR 水合的双向同步）；**整体 reactive 包裹**换得对象式好手感（代价是逼出 storeToRefs 等定向提取工具）。

装配完成后，store 就能被读写了。但状态到底「怎么改」才对、改的时候订阅又该怎么收到通知——这是下一章「状态变更模型：$patch 双形态与暂停监听批处理」要拆的事：你会发现连「直接改 state」也绕不开 `$patch` 那套暂停监听再统一触发的批处理。