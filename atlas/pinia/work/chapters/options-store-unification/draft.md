# Options Store：双作者语法统一于单一装配路径

你接手一个老项目，打开 stores 目录，发现购物车 store 是这样写的：

```js
defineStore('cart', {
  state: () => ({ items: 0 }),
  getters: { count: s => s.items },
  actions: { add() { this.items++ } },
})
```

隔壁的登录 store 又是这样写的：

```js
defineStore('auth', () => {
  const token = ref('')
  const isLoggedIn = computed(() => !!token.value)
  const login = (t) => { token.value = t }
  return { token, isLoggedIn, login }
})
```

前者像 Vuex，把 state / getters / actions 分三个字段声明，叫 **Options 式**；后者像 Vue 的组合式函数，函数体里 ref / computed / 函数随便混，叫 **Setup 式**。看到这两种风格并存，你心里多半会咯噔一下：**这两套写法，在插件、订阅、SSR、热更新里会不会行为不一样？** 比如我写个插件监听状态变化，会不会 Options 式监听得到、Setup 式监听不到？这是用 Pinia 的人最怕的事——同一段业务，换个写法行为就分叉。

本章要讲的就是 Pinia 怎么消灭这种担心。答案很省事：它**根本没给 Options 式单独写一套装配逻辑**，而是把 Options 式「翻译」成一个 Setup 式的 setup 函数，让两种作者语法走**同一条**内部装配流水线。

打个比方：两条不同的入口，递进来的稿子语言不一样，但门口有个翻译，把所有稿子都译成同一种中间语言，再交给同一个排版车间。排版车间（装配流水线）永远只面对一种语言，自然不会因为入口不同而排错版。

## 一、分叉只发生在一个地方

整个流程的分流点只有一个——`defineStore` 看你传进来的第二个参数是不是函数：

```
defineStore(id, setupOrOptions)
        │
        ├── 是函数？ → Setup 式 → 直接拿这个函数当 setup
        │
        └── 不是函数？ → Options 式 → 现场造一个 setup 函数出来
```

Setup 式没什么可说的，你写的函数**就是** setup，原样往后传。有意思的是 Options 式：它要把自己 `state / getters / actions` 这三个格子，**现场翻译**成一个 setup 函数返回的对象。翻译完之后，两种语法就再也没有分别了——后面全是同一条路。

## 二、翻译：三个格子拼成一个 setup 返回对象

Options 式的翻译工作做了一件很关键的事——它合成的 setup 函数，返回值长这样：

```
{ ...根状态[id] 的 toRefs,  ...actions,  ...每个 getter 包成的 computed }
```

也就是把三样东西拼成一个标准形状的返回对象，正好对上装配流水线认识的那几类东西（ref、computed、function）。我们逐个看：

- **state**：不是凭空 new 几个 ref，而是先确保根状态树上有 `根状态[id]` 这一项，再把它的每个字段变成**指向根状态**的 ref（`toRefs`）。说人话就是——Options 式的 state 字段，是「挂在唯一根状态树上的镜像」，不是独立的小 ref。
- **actions**：原样塞进返回对象，一个字都不改。
- **getters**：每个 getter 都被包进一层 `computed`。为什么？因为装配流水线是靠「这个返回值是 ref 吗？是 computed 吗？是函数吗？」来分类的。getter 不包成 computed，流水线就认不出它是 getter。

> 小提示：getter 包 computed 时，求值代码是 `getter.call(store, store)`——把整个 store 同时当 `this` 和第一个参数传进去。所以你在 getter 里既能写 `this.别的getter`，也能写 `state => state.别的getter`，两种写法都能引用别的 getter。这个细节点到为止，不展开。

翻译这一步做完，Options 式就拿到了一个和 Setup 式**长得一模一样**的 setup 返回对象。接下来它把这个 setup，连同一个小小的布尔标志，一起交给装配流水线。

## 三、回到同一条装配路径

装配流水线（上一章已经把它的主干讲透了：开子作用域跑 setup、逐个分类返回值、state 镜像进根状态、最后整体包成 reactive）拿到这个 setup 后，对 Options 式和 Setup 式**一视同仁**——它根本不关心你是哪种语法写的。

唯一的区别，靠那个布尔标志来处理。这个标志的语义就是「state 的形状是不是已经静态声明好了」，它只在**三个局部点**上控制差异：

| 差异点 | Setup 式（形状未知） | Options 式（形状已知） |
|---|---|---|
| 要不要先放个空对象到根状态？ | 要（因为还不知道 state 长啥样） | 不要（state 早就写进根状态了） |
| 要不要把 setup 里的 ref 搬进根状态？ | 要（用户在 body 里 new 的 ref 得归位） | 不要（已经是根状态的镜像了） |
| 能不能合成 `$reset` 方法？ | 不能 | 能 |

除了这三处，整条装配流水线只有一份代码。插件怎么挂、订阅怎么接、最后怎么包成 reactive，两种语法走的是**同一套**。这就是「两种作者语法、一条内部装配路径」。

## 四、演示：两种语法、一条路径

下面这个脚本把翻译过程和统一路径缩到最小，专门演三件事：**翻译怎么发生、两种语法走同一条路、`$reset` 为什么只有一种有**。它可以直接 `node` 跑，输出就在每行注释里。

```js
// ===== 极简 mock：只够演透本章原理 =====
function ref(v) { return { __isRef: true, value: v } }
function isRef(x) { return x != null && x.__isRef === true }
function isComputed(x) { return x != null && x.__isComputed === true }
function computed(fn) {
  return { __isRef: true, __isComputed: true, get value() { return fn() }, set value(_){} }
}
// toRef：造一个"指向某对象某属性"的 ref-like，读写都桥接到宿主对象
function toRef(host, key) {
  return { __isRef: true, get value() { return host[key] }, set value(v) { host[key] = v } }
}
function toRefs(obj) { const out = {}; for (const k in obj) out[k] = toRef(obj, k); return out }
// reactive：读时自动解包 ref、写时若旧值是 ref 就走 .value（让 action 里的 this.x++ 落到根状态）
function reactive(target) {
  return new Proxy(target, {
    get(t, key, receiver) { const v = Reflect.get(t, key, receiver); return isRef(v) ? v.value : v },
    set(t, key, value, receiver) {
      const old = Reflect.get(t, key, receiver)
      if (isRef(old) && !isRef(value)) old.value = value; else Reflect.set(t, key, value, receiver)
      return true
    },
  })
}
function mapValues(obj, fn) { const out = {}; for (const k in obj) out[k] = fn(obj[k], k); return out }

// ===== 唯一装配路径（主干第 4 章已讲透，这里保留 reactive 收尾，好让 this.x++ 解包）=====
const root = {}        // 模拟唯一的根状态树 pinia.state.value
let subCount = 0       // 模拟 $patch 触发的订阅回调次数

function onePatch(targetState, newState) {
  for (const k in newState) targetState[k] = newState[k]   // 浅覆盖
  subCount++                                               // 一批改动收拢成单条订阅
}

function assemble(id, setup, opts) {
  const { stateShapeDeclared } = opts
  if (!stateShapeDeclared && !root[id]) root[id] = {}      // ① 只有 Setup 式需要先放个空对象
  const ret = setup()
  for (const k in ret) {
    const v = ret[k]
    if (isRef(v) && !isComputed(v))                        // ② 识别 state
      if (!stateShapeDeclared) root[id][k] = v             //    只有 Setup 式把 ref 搬进根状态
    // function 留作 action、computed 留作 getter，原样不动
  }
  ret.$reset = stateShapeDeclared                          // ③ 只有 Options 式能合成重置方法
    ? () => onePatch(root[id], opts.stateFactory())
    : () => { throw new Error('setup store 不支持 $reset') }
  return reactive(ret)                                     // ④ 整体包成 reactive
}

function ensureRootState(id, state) { if (!root[id]) root[id] = state ? state() : {}; return root[id] }

// ===== Options 式：现场翻译成一个 setup，再走同一条 assemble =====
function defineOptionsStore(id, { state, getters, actions }) {
  let store                                                // 先声明，getter 闭包稍后要用到
  store = assemble(id, () => ({
    ...toRefs(ensureRootState(id, state)),                 // state → 指向根状态的镜像 ref
    ...actions,                                            // action 原样
    ...mapValues(getters, g => computed(() => g.call(store, store))),  // getter → computed
  }), { stateShapeDeclared: true, stateFactory: state })
  return store
}

// ===== Setup 式：直接走同一条 assemble =====
function defineSetupStore(id, setup) { return assemble(id, setup, { stateShapeDeclared: false }) }

function defineStore(id, setupOrOptions) {
  return typeof setupOrOptions === 'function'
    ? defineSetupStore(id, setupOrOptions)
    : defineOptionsStore(id, setupOrOptions)
}
```

现在用两种语法各写一个等价的购物车，跑一遍：

```js
// Options 式：靠 this 取字段
const cart = defineStore('cart', {
  state: () => ({ items: 0 }),
  getters: { count: s => s.items },
  actions: { add() { this.items++ } },
})

// Setup 式：靠闭包取 ref（功能完全等价）
const cart2 = defineStore('cart2', () => {
  const items = ref(0)
  const count = computed(() => items.value)
  const add = () => { items.value++ }
  return { items, count, add }
})

console.log(cart.items, cart.count, cart2.items, cart2.count)   // 0 0 0 0
cart.add(); cart2.add()
console.log(cart.items, cart.count, cart2.items, cart2.count)   // 1 1 1 1
cart.$reset()                                                   // Options 式：重置成功
console.log(cart.items)                                         // 0
try { cart2.$reset() } catch (e) { console.log(e.message) }     // setup store 不支持 $reset
console.log('订阅次数', subCount)                                 // 订阅次数 1
```

把执行轨迹走一遍，就能看见「一条路径」是怎么运作的：

```
defineStore('cart', { state, getters, actions })        ← 不是函数，走 Options 分支
  └─ ensureRootState：root.cart = { items: 0 }          ← state 先落进唯一的根状态树
  └─ 翻译出 setup，返回 { items:<镜像ref>, add:<fn>, count:<computed> }
  └─ assemble：识别 items 为 state（已在根状态，跳过搬运）、count 为 getter
  └─ 合成 $reset（因为形状已知）→ 整体包 reactive → 返回 store

cart.add()                                              ← this.items++ 经 reactive 自动解包，落到 root.cart
cart.$reset()                                           ← 重求 state() 得 {items:0} → 一次 patch 浅覆盖 → subCount=1

defineStore('cart2', setup)                             ← 是函数，走 Setup 分支
  └─ assemble：先放空对象 root.cart2={} → 跑 setup → 把 items 这个 ref 搬进 root.cart2
  └─ $reset = 抛错的函数（形状未知，没法合成）
```

两种语法在「改 state、读 getter」上**行为完全一致**，唯一的差别就是最后一行——`$reset` 有没有。这个差别不是 bug，而是统一路径要付出的代价，下面专门讲。

## 五、关键权衡

### 权衡一：state 落点统一，代价是必须静态声明

**选择**：Options 式的 state 不做成几个独立的小 ref，而是做成「根状态树某一项的 toRefs 镜像」。
**换来**：两种语法装配完之后，**state 存的位置完全一样**——都在那棵唯一的根状态树上。于是插件、订阅、SSR 序列化，全都不用区分「这个 store 是哪种语法写的」，对两种语法行为天然一致。
**代价**：Options 式的 state 形状必须**在写 store 时就声明死**（先于 setup 跑、写进根状态），没法像 Setup 式那样在函数体里命令式地、看条件地 new 出 ref。换句话说，Options 式拿简洁换了灵活。

### 权衡二：复用分类逻辑，代价是 getter 多一层闭包

**选择**：把每个 getter 包成 computed、actions 原样保留，再把它们和 state 镜像拼成一个 setup 返回对象。
**换来**：**完全复用**装配流水线的返回值分类逻辑——流水线本来就会逐个判断「这是 ref 吗？computed 吗？函数吗？」，翻译层只要把东西变成它认识的形状，剩下的不用操心。这就是「翻译换统一」能成立的技术基础。
**代价**：Options 式的 getter 每次求值都要多走一层 computed 闭包：先设当前活跃的 Pinia、再从注册表把 store 实例取出来、再调原始 getter。这层包装是为了让 getter 里能跨 store 引用（`this.别的store`），但确实多了一层间接。

### 权衡三（核心代价）：`$reset` 的有无，正是统一路径的必然代价

**选择**：只给 Options 式合成 `$reset`，Setup 式不给。
**换来/根因**：这背后是个绕不开的前提——Options 式的 state 是一个**无参工厂函数 `state()`**，框架随时能重新调一次、拿到一份确定的初始值，于是能合成出「重求初始值 → 经一次 patch 写回」的重置逻辑（顺带复用了上一章讲的 `$patch` 批处理，整批改动只发一条订阅）。
**代价**：Setup 式的 state 是在 setup 闭包里**命令式创建**的 ref（`const items = ref(0)`），框架根本拿不到那个「初始值工厂」，不知道该怎么把它们重建回初始状态。所以 Setup 式的 `$reset` 在开发环境直接抛错、生产环境是空操作。

这就是本章最想说的一点：**同一条装配路径，没法对两种 state 来源一视同仁。** 你想要两种语法行为一致（插件、订阅、SSR 全都一致），就得接受「重置这种依赖 state 来源的能力，只能给其中一种」。`$reset` 的有无，不是漏做了，而是「统一」这个选择的必然账单。

> 顺带一个边角：Options 式的 `$reset` 用的是**浅覆盖**——只把 `state()` 返回的顶层 key 盖回去，不删多余 key、不深合并嵌套对象。日常用够，但嵌套结构复杂的 state 要留意。

### 权衡四：一个布尔标志穿透装配，代价是变成隐藏分支

**选择**：用一个布尔标志（语义就是「state 形状是否已知」）一路传进装配流水线，只在上面表格里的三处局部点控制差异。
**换来**：装配主干只有**一份**代码，差异点高度集中、好排查。要理解两种语法的全部不同，盯住这三处就够，不用并行读两套逻辑。
**代价**：这个布尔在通读装配代码时是个「隐藏分支」——你看到一段分类逻辑里夹着个 `if (!stateShapeDeclared)`，光看局部不一定知道它对应的是 Options 还是 Setup、又在哪几处起作用。这种差异点只能靠注释或上下文点明，没有别的办法让它自己显形。

## 小结

Options 式能存在，不是因为 Pinia 想支持两套内部实现，而是因为它写了个**翻译层**：把 `state/getters/actions` 三个格子现场拼成一个 setup 返回对象，然后两种语法共用同一条装配流水线。所以你用哪种语法写 store，插件、订阅、SSR、热更新拿到的都是同一种东西，行为天然一致。

这条统一路径唯一的账单，是 `$reset` 只属于 Options 式——因为只有它的 state 是个能反复求值的工厂，Setup 式的命令式 ref 框架没法重建。记住这一点，你就能预判「哪些能力两种语法都有、哪些只有一种」。

下一章我们会顺着「两种语法最终都汇成同一个 reactive store」这一点往下走：正因为 store 是个混了 state ref、computed getter 和 action 函数的 reactive 对象，想从里面**只把响应式部分提取出来**（`storeToRefs`）时，不能直接用 Vue 的 `toRefs`——它分不清 getter 和 action。下一章就讲 Pinia 怎么做这种定向提取。