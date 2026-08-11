# 插件系统：context 注入的 store 增强

> 本章属于 composite 层。前置：Store 装配、Pinia 实例。
> 学完你能：用一句话讲清"为什么插件被设计成『借用 store 自己的作用域跑增强、返回值就地合并进 store』"，以及它为此要付的两笔代价——纯对象告警、注册暂存队列。

## 1. 为什么需要它

上一章的结尾留了一个钩子：插件往 store 里塞的 ref，也会被 `storeToRefs` 一并提取出来。这话听起来像是顺带一提，其实它指向的是一个更深的设计——Pinia 把"给所有 store 加同一类能力"这件事，做成了一个统一的扩展点。这一章就讲这个扩展点本身。

什么样的能力会"想挂到每个 store 上"？最常见的几种：日志（每次 action 调用都打一条）、持久化（state 改了顺手写进 localStorage）、权限（按角色屏蔽某些 action）、测试桩（开发期把 action 替换成 spy）、可观测面板（开发者工具里能看到每个 store 的内部状态）。

这些需求有个共同点：它们**不是某一个 store 的事**，而是想对**每一个** store 都生效；又**不是应用启动逻辑的事**，因为它们要钻进 store 内部、能拿到 state、能拦住 action。这就是典型的横切关注点。

没有这个机制的话，作者只能两条路里挑：要么在每个 store 的 setup 里手抄一遍同样的代码（抄袭、易错、改一处要改十处），要么直接 fork 框架源码改一道（升级即噩梦）。更要命的是，**框架自己的开发者工具**也属于这类"想挂到每个 store 上"的能力——如果连框架自身都得为这个事开辟专门通道，那说明这个扩展点不是可有可无的便利，而是架构的承重墙。

## 2. 核心思想

把外部增强器**拉进**被增强对象的生命周期里执行——而不是让增强器站在外面、自己管自己注入的资源的生死。

这句话拆开来看：一个插件就是一个普通函数，它被叫来的时候会拿到 `{ store, app, pinia, options }` 这套上下文，干完活返回一组想给 store 加的属性，框架负责把这组属性**就地合并**进 store。关键不是"返回值被合并"——这没什么稀奇——而是这个函数**全程跑在 store 自己的作用域里**。所以它内部创建的 ref、computed、watch，全都自动落进 store 的 effectScope，跟着 store 一起生、一起灭，不用插件作者操半点心。

把"增强"做成"在宿主生命周期内执行的小函数"，是这套机制能同时满足"外来扩展"+"享受宿主全部待遇"两个矛盾需求的唯一办法。

## 3. 心智模型

涉及的数据结构只有三块：

- **`pinia._p`**：一个数组，装着所有**已安装**的插件。装配每个 store 时，会从头到尾遍历它。
- **`toBeInstalled`**：一个临时数组（藏在 `createPinia` 闭包里），装着"应用还没 install 就提前注册的"插件。
- **`store._customProperties`**：一个 `Set<string>`，只在 dev 或 devtools 构建里才会被挂上，记录哪些 key 是插件塞进来的"外来属性"。

整条时序链是这样的：

```
插件作者调 pinia.use(p)
        │
        ├─ 应用还没 install？─── 是 ──▶ toBeInstalled.push(p)      ◀── 预装阶段
        │                                                       │
        └─ 应用已经 install？─── 是 ──▶ _p.push(p)                 │
                                                                │
应用调 app.use(pinia)，触发 pinia.install(app)                  │
   1. 设活跃 pinia、provide、挂 $pinia 全局属性                  │
   2. toBeInstalled 整体灌进 _p（一次性 flush）─────────────────┘
   3. toBeInstalled 清空

某个 store 第一次被 useStore 触发装配（前置章讲过的七步流程）
   ...
   末尾：
   for (插件 ext in pinia._p) {
     在 store 自己的 effectScope 内调用 ext({ store, app, pinia, options })
     拿到它返回的 extensions
     把每个 key 登记进 store._customProperties（dev/devtools 下）
     检查 extensions 里有没有"裸纯对象"，有就告警
     assign(store, extensions) 就地合并
   }

store 被显式 $dispose
   → scope.stop()
   → 插件当初在 scope 里创建的 ref/computed 全部失效
```

两个细节先记一下，权衡里会展开：一是"裸纯对象"的告警发生在 `assign(store, extensions)` **之前**——一旦合并进 store，store 是个 reactive 代理，会把嵌套响应式值解包，那时再想区分"原本是 reactive"和"原本就是纯对象"已经不可能；二是 `_customProperties` 真正的服务对象是开发者工具（下一章会讲），`storeToRefs` 并不读它——`storeToRefs` 是凭"是不是 ref/reactive/带不带 effect"去挑数据的，跟登记表无关。

## 4. 关键权衡

这一节是真正"学原理"的部分。看着只是"遍历跑一遍插件然后合并"，背后藏着四个非显然的取舍。

### 让插件跑在 store 自己的作用域里

插件被叫来干活时，框架特意把它**包在 `scope.run(() => extender(context))` 里**执行——这个 `scope` 就是 store 自己装配时开的那个子 effectScope（前置章讲过它）。

选择这么做，换来的是：插件返回的 ref、computed、内部起的 watch，统统被这个 store 的 effectScope 捕获，**自动跟着 store 走**——store 被 `$dispose`（scope.stop()）的时候，这些响应式副作用一并释放，插件作者一行清理代码都不用写。这是一个非常省心的能力：写插件就像写 store 内部的 setup，响应式资源的生死由框架兜底。

代价是：插件**不能返回"裸的纯对象"**。一旦你返回一个 `{ theme: 'dark' }`，它会被合并进 store、被 reactive 代理包裹，可它本身没有响应式源——既不归作用域托管、被 storeToRefs 忽略，又会在开发期触发一条专门的告警。换句话说，插件作者必须**显式表态**：要么 `ref()/reactive()/shallowRef()` 包成响应式状态、享受作用域托管；要么 `markRaw()` 显式声明"我知道它不响应式、我故意的"。没有第三条路。

这条权衡化解的本质矛盾是：**响应式资源要随某个生命周期集体回收**（这是 Vue 响应式模型对"防泄漏"的硬要求）vs. **增强器天然是外部代码、本不该被嵌进宿主的生命周期**（否则就要插件作者自己管 effect）。把插件拉进 store 作用域跑，是同时满足两边的最小解——既回收、又不用作者操心。

### 用暂存队列处理注册时机

`pinia.use(plugin)` 注册插件时，会先看一眼"应用有没有 install 这个 Pinia"——没有的话，插件进暂存队列 `toBeInstalled`；有的话，直接 push 进 `_p`。等到 `install(app)` 真正被调用那一刻，把暂存队列整体灌进 `_p`、清空队列，此后再注册的就直接进 `_p`。

选择"两份数据 + 一次性 flush"，换来的是：插件**在任何时候**都能注册——哪怕应用还没正式挂载 Pinia。这条自由非常关键，**框架自己就靠它**：`createPinia()` 末尾会立刻 `pinia.use(devtoolsPlugin)` 把整套开发者工具当插件预装上，而此刻应用的 `app.use(pinia)` 还没发生。换句话说，框架自举用的就是这条暂存路径——如果非得等 install 才能注册插件，开发者工具这套系统级能力根本没法以"普通插件"的身份落地。

代价是内部要同时维护两个数组，并在 install 那一刻做一次 flush。这件事听上去简单，但它隐含一个时序契约：**install 之前注册的插件**和**install 之后注册的插件**最后都会进 `_p`，但二者经过的路径不同——这是一个边界情形，任何修改注册逻辑的人都要小心保持这个契约。

这条权衡化解的本质矛盾是：**插件作者需要在任意时刻都能注册**（否则像 devtools 这种系统级预装就做不到）vs. **一个 Pinia 实例的"开始工作"有明确时刻**（install 那一刻才设活跃 pinia、才 provide）。暂存队列就是这两个不对齐的时间轴之间的缓冲。

### 给插件构造一份动态 options + 收集 setup store 的 action

插件拿到的 context 里有个 `options` 字段，描述"这个 store 当初是怎么定义的"。但框架传给插件的不是原封不动的作者选项，而是 `assign({ actions: {} }, options)`——一份**动态构造**的浅拷贝，且装配过程中会逐个把 setup store 的 action 填进 `options.actions[key]`。

选择动态构造，换来的是：插件看到的 `options.actions` **形状永远稳定**——无论这个 store 是 option 语法还是 setup 语法、无论它有没有 action、无论它定义时 actions 字段是不是 undefined，插件都能放心地 `for (const name in ctx.options.actions)` 遍历，绝不会撞上"undefined 没法遍历"。这一点对插件作者尤其重要：他们写一次插件，要跑在所有写法的 store 上。

代价是装配路径里要多一次浅合并、多一次逐属性的 action 收集。setup 语法的 store，action 是装配跑 setup 之后才存在的——所以必须在分类返回值那一步顺手把它们收集进 `optionsForPlugin.actions`，注释里直说"list actions so they can be used in plugins"。

这条权衡化解的本质矛盾是：**setup 语法的 action 只有装配时才存在**（它是 setup 函数返回值里的几个 function，没法静态分析）vs. **插件需要在装配时就能看到完整的 action 清单**（要包 action、要拦截调用）。把"收集 action"嵌进装配路径，是补上这个时序差的唯一办法。

### 把插件注入的每个键登记进一个集合

`store._customProperties` 这个 `Set<string>` 记录"哪些 key 是插件塞进来的"。每次插件返回 extensions 后，框架会把它的每个 key 加进这个集合。

选择登记，换来的是：**开发者工具能区分"外来属性"与 store 自身的状态/getter/action**——展示时可以打标签、编辑时可以区别对待。这条权衡**主要服务 devtools**（下一章会看到 devtools 怎么消费它）。代价是多维护一个集合、多一次登记动作——但这条代价薄到可以一句话带过：插件注入的 key 数量本来就少，登记开销可以忽略。

需要特别澄清一点（这一点 research 里专门做了修正）：**`storeToRefs` 并不读 `_customProperties`**——它是凭响应式特征（isRef/isReactive/带不带 effect）来挑数据的。所以"插件塞的 ref 会被 storeToRefs 提取"这件事的真正根因是"它确实是 ref"，而不是"它被登记进了某个表"。

这条权衡化解的本质矛盾是：**任何带插件系统的成熟框架都要回答"这个属性是谁的"**（作者归属问题）——devtools 要展示就得知道是不是插件塞的；而响应式系统本身并不在乎归属。把"归属"记一张单独的表、只在 devtools 路径上读它，是把这个"展示需求"和"运行时零开销"分开的标准做法。

## 5. 最小原理演示

把上面这套思路落成一段能跑的代码。我们只演最灵魂的两条权衡——**作用域托管 + 裸对象告警**、**注册时机暂存**——其他细节（HMR、devtools 内部、SSR）故意全部省掉。

```ts
import { effectScope, ref, isRef } from 'vue'

// 一个迷你 Pinia：只演「注册时机 + 作用域托管 + 就地合并 + 裸对象告警」
function createMiniPinia() {
  const rootScope = effectScope(true)   // 根作用域，前置章讲过的那块公共地基
  const _p = []                          // 已安装插件表
  let toBeInstalled = []                 // 应用未 install 前的暂存队列
  let _a = null                          // install 之后才非空

  return {
    use(plugin) {
      // install 之前注册的，先进暂存队列；install 之后注册的，直接进已安装表
      if (!_a) toBeInstalled.push(plugin)
      else _p.push(plugin)
      return this
    },

    install(app) {
      _a = app
      // flush：把暂存队列整体灌进 _p，清空队列，此后新注册直接进 _p
      toBeInstalled.forEach(p => _p.push(p))
      toBeInstalled = []
    },

    assemble(id, setup) {
      // 给这个 store 开一个自己的子作用域
      const scope = rootScope.run(() => effectScope())!
      const store = scope.run(() => {
        const base = setup()
        // 在 store 自己的作用域里逐个跑插件——
        // 插件返回的 ref/computed 会自动被这个 scope 捕获，跟着 store 生灭
        for (const ext of _p) {
          const exts = scope.run(() => ext({ store: base, pinia: this })) || {}
          for (const key in exts) {
            const value = exts[key]
            // 赋值前检查：一旦合并进 store（一个 reactive 代理），ref 与纯对象就分不清了
            if (value && typeof value === 'object' && !isRef(value)) {
              console.warn(`[mini-pinia] ${id}.${key} 不是 ref，不会响应式`)
            }
            base[key] = value
          }
        }
        return base
      })!
      return { store, scope }
    },
  }
}
```

用法：

```ts
const pinia = createMiniPinia()

// 模拟框架自举：在 app.install 之前就预装（真 Pinia 在 createPinia 末尾就 pinia.use(devtoolsPlugin)）
const devtoolsLike = ({ store }) => console.log(`[devtools-like] 新 store: ${store.$id}`)
pinia.use(devtoolsLike)           // 应用未 install → 入暂存队列

// 模拟应用挂载
pinia.install({})                 // flush：devtoolsLike 进 _p

// 用户写的插件：一个返回 ref，一个返回裸纯对象
const withCounter = () => ({ count: ref(0) })
const withConfig = () => ({ config: { theme: 'dark' } })
pinia.use(withCounter)            // install 后 → 直接进 _p
pinia.use(withConfig)

// 装配一个 store：插件在它的作用域内被逐一跑一遍
const { store, scope } = pinia.assemble('cart', () => ({
  $id: 'cart',
  items: ref([]),
}))

// 控制台输出：
//   [devtools-like] 新 store: cart
//   [mini-pinia] cart.config 不是 ref，不会响应式

console.log(store.count)          // 0    （是 ref，被作用域托管、能被 storeToRefs 提取）
console.log(store.config)         // { theme: 'dark' }（合并进 store，但不响应式、会被 storeToRefs 忽略）

// 销毁 store：scope.stop() 后，插件当初注入的 count 所关联的全部响应式副作用自动失效
scope.stop()
```

跑下来你会看到三件事：第一，`devtoolsLike` 在 install 之前就注册了，但因为躺在暂存队列里，**真正干活**是在 flush 之后、第一个 store 装配时——暂存队列的缓冲作用肉眼可见。第二，`count` 是 ref，合并进 store 后照常响应式，能被 storeToRefs 挑走。第三，`config` 是裸纯对象，合并进 store 但触发了告警——而且因为它**不是** ref/reactive，storeToRefs 会直接忽略它（这正回应了上一章结尾埋的钩子）。

## 6. 执行轨迹

把上面那段代码用一个具体输入走一遍。假设用户注册了一个返回 `{ count: ref(0), config: { theme: 'dark' } }` 的插件：

**第 0 步·注册入队**：用户在 `pinia.install` 之后调 `pinia.use(userPlugin)`，因为此刻 `_a` 已经被 install 设过，插件直接 push 进 `_p`，没有走暂存队列。

**第 1 步·装配到末尾**：某个 store（id 为 `cart`）首次被 `useStore` 触发装配。装配函数走完前面七步（开子作用域、跑 setup、分类返回值、把返回值挂到 store 上）后，来到末尾的插件循环。

**第 2 步·在 store 作用域内调用插件**：框架把 `userPlugin` 包在 `scope.run(() => userPlugin({ store, app, pinia, options }))` 里执行。插件函数返回 `{ count: ref(0), config: { theme: 'dark' } }`——此刻这两个值还是它**原始**的样子（一个 ref 对象、一个普通对象），尚未被合并进 store。

**第 3 步·登记 + 检查**：dev/devtools 构建下，把 `count` 和 `config` 两个 key 加进 `store._customProperties`；紧接着在 dev 下遍历 extensions 做裸对象检查——`count` 是 ref，跳过；`config` 是 object 且不是 ref/reactive、没标 `__v_skip`，触发 PINIA_R1006 告警。

**第 4 步·就地合并**：`assign(store, extensions)` 把 `count` 和 `config` 挂到 store 上。从这一刻起，`store.count` 是个被解包过的值（在 reactive 代理外读到的是 ref 的 `.value`，在代理内自动解包），`store.config` 是个普通对象。

**第 5 步·后续使用**：调用方 `storeToRefs(store)` 时，遍历原始对象——`count` 是 ref，挑出来；`config` 既不是 ref 也不是 reactive、也不带 effect，自然漏掉。所以解构出来的 `count` 是响应式的、能跟着 store 变，而 `config` 压根不会出现在解构结果里。

**第 6 步·销毁回收**：组件或测试调用 `store.$dispose()`，背后是 `scope.stop()`。`userPlugin` 当初在 scope 内创建的那个 `ref(0)` 所关联的所有响应式副作用（watch、computed 依赖），一并释放。插件作者一行清理代码都没写——这正是"借用宿主作用域"换来的省心。

## 7. 教学简化说明

本章演示故意省略了这些：HMR 与插件运行顺序的交互、开发者工具内部如何消费 `_customProperties`、SSR 水合路径与插件的关系、`$patch` 的双形态、完整泛型、告警文案的具体格式、devtools 构建下内部属性被重定义为不可枚举的细节。这些都不影响理解插件系统的核心原理——它们要么是其他章的主角（devtools、HMR、SSR），要么是工程完善度，不属于"为什么这么设计"的层面。

## 8. 小结

插件系统是 Pinia 把"想挂到每个 store 上"这类横切关注点统一收口的承重墙——连框架自己的开发者工具都靠它落地。它做的核心动作只有一个：把外部增强器**拉进 store 自己的作用域里**跑一遍、把返回值**就地合并**进 store。这一拉一合，换来了注入的响应式数据自动归 store 托管、随 store 一并回收，也付出了纯对象告警、暂存队列这两笔代价。

下一章会暂时离开"装配"这条主线，去看一个**纯适配**性质的薄层——mapHelpers：它本身不在装配时做事，只是把组合式 store 按需懒适配到 Options API 的语法。