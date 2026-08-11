# Store 装配：effectScope 托管的返回值分类与状态镜像

> 本章属于 composite 层。前置：「Pinia 实例：根状态、注册表与全局活跃上下文」「订阅原语：回调集合与作用域自动清理」「defineStore：惰性 useStore 闭包与注册表缓存」。
> 学完你能：讲清 Pinia 为什么要在跑 setup 之前先把半成品 store 塞进注册表，以及为什么 setup 里 `ref()` 出来的状态还要再写一份到根状态树。

## 1. 为什么需要它

上一章里，defineStore 给你返回一个 useStore 闭包：第一次调用时它才真正去创建 store，然后把结果塞进注册表缓存。可"创建 store"这四个字背后究竟发生了什么？一个用 setup 语法写的 store，本质上只是这样一个函数：

```ts
const useCart = defineStore('cart', () => {
  const items = ref([])
  const count = computed(() => items.value.length)
  function add(x) { items.value.push(x) }
  return { items, count, add }
})
```

返回值是一个扁平的、没有任何标签的对象。Pinia 拿到它时面对三个问题。

每个属性到底扮演什么角色？`items` 是状态，要能被序列化、要进 devtools；`count` 是派生值，要保持响应式但不必序列化；`add` 是动作，要能被 `$onAction` 拦截。可从语法上看它们长得都一样——ref、computed、function 都是普通对象或函数。Pinia 必须在运行时推断谁是哪一类，因为这三类东西的待遇完全不同。

状态散落在用户创建的 ref 里，但外部世界要一棵统一的树。SSR 要把整个应用的状态序列化成一个 JSON 对象塞进 HTML；devtools 要展开一棵状态树给开发者看；`store.$state` 要能整体读写。如果每个 store 的状态都散落在自己 setup 函数里 `ref()` 出来的局部变量里，这些事都没法做。需要一条规则把这些散落的 ref 收拢。

store 之间还会循环引用，而创建有时序。想象 store A 的动作里要用 store B，store B 的动作里又要用 store A。等 A 完全装配好才允许 B 找到 A，B 装配时 A 还没好；反过来也一样，鸡生蛋的僵局。

装配机制要同时回答这三件事：怎么分类、怎么收拢状态、怎么打破循环。

> 三条承上：第 1 章建立的三个支点（根作用域 `_e`、注册表 `_s`、根状态树 `state.value`）是本章装配流程的落脚点——本章只看装配如何**消费**它们。第 2 章的订阅原语（Set + add/remove）本章不重演，只在装配挂上 `$onAction`/`$subscribe` 时点名说"用了那套原语"。第 3 章的 useStore 闭包已交代"何时进装配"，本章看的就是进装配**之后**那段函数内部。

## 2. 核心思想

**先挂上号、再装内容。**

第一步只做最小的事：构造一个只含内置方法的空壳 store，把它塞进注册表。这时候 setup 还没跑，store 上没有任何用户定义的字段。第二步才真正去跑 setup、分类返回值、把状态镜像进根状态树。两步之间嵌套一个专属的 effectScope，让这个 store 全部的响应式 effect 都圈在一起、`$dispose` 时一并回收。

"身份在内容之前"这一拆，直接破解循环引用：A 还没跑 setup 时就已经在注册表里挂上号了，所以 A 的 setup 里实例化 B、B 又回头实例化 A 时，命中的是注册表里那个半成品 A，不会再触发一次 A 的装配。分类和镜像都是身份确立之后的子动作。

## 3. 心智模型

装配一个 store 的完整流程是七步。

1. **占位根状态**。如果根状态树里还没有这个 store 的条目，先放一个空对象占着。setup store 因为状态形状未知、只能先占位；option store 因形状已知走另一路直接写形状。
2. **造壳**。把 `$id`、`$patch`、`$reset`、`$subscribe`、`$onAction`、`$dispose` 这些内置方法拼成一个"半成品 store"对象。此刻它只有内置方法、还没有用户定义的 state/getter/action。
3. **包裹**。把这个半成品对象包成 `reactive()`，得到 store 的本体。从这一刻起 store 就是一个响应式对象。
4. **占位注册**。把还没跑 setup 的半成品 store 塞进注册表。这是"先挂上号"的字面落实。
5. **跑 setup**。在 Pinia 的根作用域下开一个子 effectScope，在这个子作用域里**同步**执行 setup 函数，拿到它返回的扁平对象。setup 里 `ref()`、`computed()` 创建的全部 effect 都自动归这个子作用域管。
6. **三分类**。遍历 setup 返回值的每个 key：
   - `isRef(prop) && !isComputed(prop)` 或 `isReactive(prop)` → 当 **state**：把这个 ref 额外登记进根状态树对应 id 下。
   - `typeof prop === 'function'` → 当 **action**：包一层拦截器后替换原函数（这层包裹是 `$onAction` 的支撑）。
   - 否则若是 `isComputed(prop)` → 留作 **getter**：原样保留，不进根状态树。
   
   computed 是"带 `.effect` 字段的 ref"，这个判别是分类 state 与 getter 的唯一依据。
7. **收尾**。把分类好的 setupStore 合并进 store、给 store 装 `$state` 访问器（读走根状态树、写路由回 `$patch`）、在该 store 的子作用域里逐个跑插件、最后才把状态监听开关打开。

七步里最关键的是第 4 步占位注册和第 6 步三分类——前者破循环、后者做分类与镜像，其余都是配套。

## 4. 关键权衡

### 用半成品占位换取 store 互引不死循环

**选择**：在跑 setup 之前，先把只包含内置方法的半成品 store 塞进注册表。
**换来**：store 之间任意互相引用都不会陷入死循环。A 的 setup 里实例化 B 时，A 已经在注册表里；B 回头再实例化 A 命中的是注册表里的半成品 A，注册表命中就直接返回，不会再触发一次 A 的装配。
**代价**：装配期间的 store 是个半成品——只有内置方法、还没填用户的 state/getter/action。所以装配顺序被钉死成"必须先注册、后跑 setup"。如果 A 的 setup 在同步执行阶段就去访问 B 的某个用户字段，而 B 此刻还没装配到那一步，A 拿到的就是 `undefined`。

这条权衡化解的是"互相依赖"与"创建有时序"之间的对立。任何有循环依赖的系统都得把身份先于内容登记：JS 模块系统靠"模块记录对象先于求值存在"、二叉树互链靠"先 new 节点再连指针"、依赖注入容器靠"先注册再解析"。Pinia 用的就是这同一招骨架，读者抓住这条本质，在 service locator、插件系统、ORM 关系映射里都能认出来。

### 把每个 state ref 镜像进单一根状态树

**选择**：setup 返回的每个 state ref，都额外写一份引用进挂在 Pinia 上的根状态树（`pinia.state.value[id][key] = prop`）。
**换来**：整个应用只有一棵可序列化的状态树。SSR 把这棵树序列化进 HTML、客户端整体回填；devtools 展开这棵树给开发者看；`store.$state` 直接读这棵树对应的子树。所有"外部观察者"都只盯一个地方，不必去各处收集。
**代价**：状态多了一份登记。SSR 水合时还要做双向同步——入站的初始状态要先灌进用户创建的 ref，ref 又被登记进根树，逻辑比"状态就长在 store 上"更绕。option store 因为状态形状已知、由它自己把形状写进根状态再 `toRefs` 取出，跳过了这条镜像路径；setup store 因为状态是命令式 `ref()` 出来的、形状运行时才知道，只能事后镜像。

背后是"状态由用户命令式创建（自然散落）"与"外部需要一棵统一可序列化视图"之间的对立。数据库的物化视图、操作系统的 `/proc` 文件系统、监控里的指标聚合都是同一类解：从分散源头投影出统一视图，代价是同步开销。

### 用子 effectScope 圈住整个 store 的全部响应式

**选择**：在 Pinia 的根作用域下给每个 store 开一个专属子 effectScope，setup 函数在这个子作用域里同步跑。
**换来**：store 的全部 ref、computed、watcher 都归这个子作用域管，`store.$dispose()` 一行 `scope.stop()` 就把所有响应式 effect 干净回收。
**代价**：setup 必须在子作用域里**同步**执行才能被托管，所以装配流程要把 setup 包在"根作用域 → 新子作用域 → setup()"的嵌套里同步跑完。如果用户在 setup 里搞了异步创建响应式（罕见），那些 effect 就漏到子作用域之外、`$dispose` 回收不掉。第 1 章建立的"根作用域承载全部 effect"在这里兑现——子作用域开在根作用域下，根作用域 `stop` 时所有子作用域一并 `stop`，给整个应用一个终极兜底。

化解的是"资源随生命周期集体回收"与"不能被组件卸载误伤"之间的对立——store 不在组件树里、生命周期独立于组件。React 的 `useEffect` cleanup、Node 的 `EventEmitter.removeAllListeners`、任何带"批量资源 + 单一释放点"的系统都用同一招：给资源一个独立池子，dispose 就是关池子。

### 整个 store 包成 reactive 换对象式人体工学

**选择**：把整张 store（内置方法 + 三分类后的 setupStore）包成一个 `reactive()` 对象。
**换来**：`store.count` 直接拿到解包后的值（不用 `.value`）、`store.count = x` 直接可写、`store.add(...)` 直接可调。这是 Pinia 用起来像在操作普通对象的根源。
**代价**：state、getter、action 三类异质东西混进同一个 reactive 对象，从外面很难区分谁是谁——这正是后面 `storeToRefs` 必须重写一套定向提取（凭 `.effect` 识别 computed、凭 `isRef` 识别 state、跳过函数）的原因。reactive 还会干扰属性枚举，导致装配末尾还得往 `toRaw(store)` 上再合并一次 setupStore，给定向提取工具留一份"未被代理包裹"的视图。

背后是"接口对人体工学的追求"与"内部异质性需要区分"之间的对立。Vue 自己的 `reactive()` 假设对象里的属性都是同质状态；Pinia 把异质东西塞进同一个 reactive，就必然要在 reactive 之外另建识别机制。这是"统一外观 vs 内部异质"的通解。

## 5. 最小原理演示

下面这段脚本只演两件事：**占位注册防死循环**和**返回值三分类 + 状态镜像**。它不是能跑的完整 Pinia，省略了 `$patch`/`$subscribe` 真实实现、插件、热更新、SSR 水合——这些在各自章节展开。直接 `node`（或 `bun`）跑可以看见"A 与 B 互引不死循环"的输出。

```ts
import { effectScope, ref, reactive, isRef, isReactive } from 'vue'

// 极简 Pinia 骨架：根状态树 + 注册表 + 根作用域
const pinia = {
  state: ref({}),                  // 单一根状态树：所有 store 的 state 都镜像到这里
  _s: new Map(),                   // 注册表：id -> store
  _e: effectScope(true),           // 根作用域（detached）：所有 store 的子作用域都挂在它下面
}

// 装配函数：核心是「占位注册 + 子作用域跑 setup + 三分类 + 镜像」
function createSetupStore(id, setup) {
  // 占位根状态：根树里还没这个 id，先放个空对象
  if (!pinia.state.value[id]) pinia.state.value[id] = {}

  // 造壳：此刻壳里只有 $id（真实 Pinia 还塞了 $patch/$subscribe 等内置方法）
  const store = reactive({ $id: id })

  // 占位注册：发生在跑 setup 之前，是破循环的关键
  pinia._s.set(id, store)

  // 在根作用域下开一个子 effectScope，同步跑 setup
  const scope = effectScope()
  const setupStore = pinia._e.run(() => scope.run(setup))!

  // 三分类：遍历 setup 返回值的每个 key
  for (const key in setupStore) {
    const prop = setupStore[key]
    if ((isRef(prop) && !prop.effect) || isReactive(prop)) {
      // state：把它登记进单一根状态树（这是「镜像」的字面落实）
      pinia.state.value[id][key] = prop
    } else if (typeof prop === 'function') {
      // action：真实代码这里会用 action(prop, key) 包一层 $onAction 拦截器；演示直放
    } else if (prop.effect) {
      // getter：computed 原样保留，不进根状态树
    }
  }

  // 把 setupStore 合并进 store（reactive 会自动解包 ref）
  Object.assign(store, setupStore)
  store._scope = scope
  return store
}

// useStore：注册表命中就直接返回，否则进装配
function defineStore(id, setup) {
  return function useStore() {
    if (pinia._s.has(id)) return pinia._s.get(id)
    return createSetupStore(id, setup)
  }
}

// 演示：A 和 B 互相在 setup 里实例化对方
const useA = defineStore('A', () => {
  console.log('[A setup] 开始')
  const b = useB()                    // A 的 setup 里实例化 B——B 被同步完整装配
  const x = ref(1)
  console.log('[A setup] b.y（B 已装配完毕）=', b.y)
  return { x, getB: () => b.y }
})
const useB = defineStore('B', () => {
  console.log('[B setup] 开始')
  const a = useA()                    // 命中注册表里的半成品 A——不会再触发一次 A 的装配
  const y = ref(2)
  console.log('[B setup] a.x（A 还是半成品）=', a.x)  // undefined：A 还没合并 setupStore
  return { y, getA: () => a.x }       // 但 a 是同一引用，等 A 装配完就能拿到
})

const a = useA()
console.log('---装配完毕---')
console.log('a.x =', a.x, '| 根状态树里的同一份 =', pinia.state.value.A.x.value)
console.log('a.getB() =', a.getB(), '（A 装配完后能完整引用 B）')
const b = useB()
console.log('b.getA() =', b.getA(), '（B 装配时 a.x 是 undefined，但运行时调用早已填完）')
```

跑出来的输出大致是：

```
[A setup] 开始
[B setup] 开始
[B setup] a.x（A 还是半成品）= undefined
[A setup] b.y（B 已装配完毕）= 2
---装配完毕---
a.x = 1 | 根状态树里的同一份 = 1
a.getB() = 2
b.getA() = 1
```

读这段输出要抓两件事。一是 B 装配时 `a.x` 还是 `undefined`——半成品 A 当时只有内置方法、用户字段没填。二是 `b.getA()` 运行时调用却拿到 `1`——闭包里的 `a` 指向同一个 store 对象，等 A 装配完毕、`x` 也合并进去了，调用就拿到了。**同步 setup**让这种"装配到一半就有别的 store 来访问"依然安全，前提是访问发生在被访问字段填完之后。

## 6. 执行轨迹

把心智模型套到一个具体输入上走一遍。

输入：

```ts
const useCart = defineStore('cart', () => {
  const items = ref([])
  const count = computed(() => items.value.length)
  function add(x) { items.value.push(x) }
  return { items, count, add }
})
useCart()
```

首次调 `useCart()` 时注册表里没有 'cart'，进入装配。下面是各阶段的内部状态。

**占位根状态后**：`pinia.state.value = { cart: {} }`。

**造壳 + 包 reactive 后**：`store` 是个 reactive 对象，内容只有 `{ $id: 'cart' }`。

**占位注册后**：`pinia._s = Map { 'cart' => store }`。此刻 store 上没有任何用户字段。

**子作用域同步跑 setup 后**：拿到 `setupStore = { items: ref([]), count: ComputedRef, add: function }`。

**三分类遍历**：

| key | prop 类型 | 判别结果 | 归类 | 副作用 |
|---|---|---|---|---|
| `items` | ref（无 `.effect`） | `isRef && !isComputed` | state | `pinia.state.value.cart.items = prop` |
| `count` | ref（带 `.effect`） | `isComputed` | getter | 无（原样保留） |
| `add` | function | `typeof === 'function'` | action | 包一层拦截器 |

**合并进 store 后**：`store.items` 经 reactive 自动解包，访问它得到 `[]`（不是 `ref([])`）；`store.count` 读到 computed 的当前值（首次访问时算一次）；`store.add` 走的是拦截器版本。同时 `pinia.state.value.cart.items` 与 setup 里创建的那个 ref 是**同一个对象**，改任一处都同步——这就是镜像的字面含义。

**最终输出**：一个 reactive 化的 store 对象，状态既可经 `store.items` 直接访问（解包后），也唯一存在于根状态树里。注册表里 'cart' 已被占用，下次 `useCart()` 直接命中缓存（那部分是第 3 章的事）。

## 7. 教学简化说明

本章演示故意省略了：`$patch`/`$subscribe`/`$onAction` 的真实实现（订阅原语已讲、`$patch` 双形态在下一章展开）；option store 的 state→`toRefs` / getters→`computed` 拼装路径（在 options-store-unification 章展开）；热更新 `_hotUpdate` 全套；devtools 隐藏属性与诊断告警；插件 `_p` 遍历与返回值诊断；SSR 水合 `shouldHydrate`/`skipHydrate`。真实装配远比演示复杂，但骨架就是上面那七步。

## 8. 小结

装配的本质是给"setup 函数返回的扁平对象"补上两类缺失：一是分类（谁是 state、谁是 getter、谁是 action），二是身份（在注册表里挂上号、把状态镜像进根状态树）。补第一类靠运行时判别 ref/computed/function；补第二类靠"先挂上号、再装内容"的两步走，这一步同时顺手化解了 store 互引的循环僵局。store 就这么成了。

可这 store 上挂着的 `$patch` 还没真正出场——下一章讲它怎么把"直接改 state"和"对象式深合并"两条路统一收成一次订阅事件。
