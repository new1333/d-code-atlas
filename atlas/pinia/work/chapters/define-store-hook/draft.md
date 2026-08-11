# defineStore：惰性 useStore 闭包与注册表缓存

> 本章属于 composite 层。前置：Pinia 实例：根状态、注册表与全局活跃上下文。
> 学完你能：用一句话讲清「为什么 `defineStore` 返回的是一个函数、而不是一个 store 实例」，以及这个形状换来什么、付出什么。

## 1. 为什么需要它：定义阶段不该有副作用

上一章讲了订阅——store 装配之后挂上去的一类能力。但回到 store 本身，还有一个更根本的问题没回答：**「定义一个 store」这个动作到底发生了什么**？为什么 `defineStore(...)` 返回的是一个叫 `useStore` 的函数，而不是直接给你一个 store 实例？

要体会这个形状不是天然成立的，假设换一种设计——让 `defineStore` 直接返回实例：

```ts
// 假想：定义即实例化
const counterStore = defineStore('counter', { state: () => ({ count: 0 }) })
```

这样写下去，几件糟心事会立刻浮上来。

一是 `import` 即实例化。只要有任何一处 import 了定义这个 store 的模块（哪怕只是为类型），模块顶层就在跑 `defineStore`、`state()` 就在被求值、整个 store 就已经被造出来挂在内存里。打包器没法把「没被用到的 store」剔除——从它的视角看，模块加载确实有副作用。

二是同一段代码无法在多个 Pinia 容器下各取其实例。一个 Vue 应用可能挂多个 Pinia（测试场景、微前端、SSR 多请求复用同一份代码）。定义时就实例化，这个实例归哪个容器？注册到哪份 `_s` 注册表？回答不了。

三是 store 之间互相引用会撞初始化顺序。A 在模块顶层就实例化，可它要在 setup 里用 B；如果 B 的模块还没被加载，A 就拿不到 B。循环引用时更无解。

Pinia 的对策是反直觉的一招：**定义时一个实例都不造，只把 id 和选项记下来；真正的实例化推迟到首次「调用」**。所以 `defineStore` 返回的不是一个 store，而是一个**调用入口**——一个挂着 `$id` 的函数，等你来 `useStore()` 才真正动手。

「定义零副作用」换来的是 tree-shake 能力、按需实例化、多容器隔离与解耦的初始化顺序。代价是 API 形状从「定义即拿实例」变成「定义后再调一次」，但这个代价比上面三件糟心事小得多。

## 2. 核心思想

把「定义一个 store」做成「定义一个可组合 hook」——**store 即 hook**。

定义阶段只是一次闭包：把 `id`、归一化后的 `options`、以及一个 `isSetupStore` 布尔（标记作者用的是 setup 语法还是 option 语法）封进一个名叫 `useStore` 的函数里，把这个函数还给你。仅此而已，没有任何东西被创建。

实例化阶段发生在你**调用**这个函数时：解析出当前该用哪个 Pinia 容器，把它推为全局活跃，查它的注册表，没有就装配一份塞进去，有就直接取出来还你。

这一分工正好衔接第 1 章铺好的舞台：容器、`_s` 注册表、活跃指针那三件基础设施已经在「Pinia 实例」一章讲透，本章只是把它们组织成一个「返回函数而非实例」的入口形状——把那三件东西串成一次完整的「定义 → 调用 → 取实例」流程。

## 3. 心智模型

入口函数身上挂着的东西，分两阶段看。

闭包数据：`id`（store 唯一名）、`options`（归一化后的选项）、`isSetupStore`（语法分流标记），以及一个外部可读的 `$id` 字段（供 mapHelpers 不调用入口就能拿到 id）。运行时依赖则全靠第 1 章给过的三件：Pinia 容器的 `_s` 注册表、模块级 `activePinia`、注入键 `piniaSymbol`。

一次完整调用走七步：

1. **定义**：`defineStore(id, setupOrOptions)` 立刻返回一个 `useStore` 函数。注册表无变化、模块加载无副作用。
2. **首次调用入口**：`useStore(pinia?)` 拿到一个可选的显式容器参数，准备按优先级解析。
3. **解析容器**：测试旁路 → 显式传参 → 有注入上下文则注入 → 否则 null。
4. **推为活跃**：把解析到的容器 `setActivePinia(pinia)`，让随后装配链路里的 getter / action 都能取到正确的它。
5. **查注册表**：`pinia._s.has(id)` 命中就直接跳到第 7 步。
6. **创建并占位注册**：未命中就调装配函数（按 `isSetupStore` 分派到 setup 或 option 两条装配路径——那是下一章的主题）。装配函数会先把半成品塞进注册表再跑 setup，让 store 间能互相引用不死循环。
7. **取出返回**：`pinia._s.get(id)`——无论刚才命中还是新装配，最终都从注册表取出。

再次调用同一个入口时，从第 2 步起重复，但第 5 步必然命中，于是同一个 `useStore()` 反复调用拿到的是**同一个实例**。

不变量很短：**同一个 Pinia 容器 + 同一个 id = 同一个实例**。换容器、换实例；同容器、同 id、永远同实例。

## 4. 关键权衡

### 返回一个调用入口函数，而不是实例本身

**选择**：`defineStore` 不返回 store 对象，而返回一个仅持有 `$id` 与闭包数据的 `useStore` 函数。

**换来**：定义阶段彻底零副作用——不创建实例、不注册到任何全局、不跑任何 setup。这份纯声明性直接换来 tree-shake 能力（定义函数上方挂着 `#__NO_SIDE_EFFECTS__` 注解，明告打包器「未使用的 store 可以安全剔除」）、按需实例化（从未被调用的 store 永远不存在）、解耦的初始化顺序（A 引用 B 不会触发 B 的立即创建）。

**代价**：每次调用入口都要做一次「解析容器 + 查注册表」。这是一笔小而确定的运行时开销，并且让 `useStore` 在「读起来像实例」这件事上不如直接给对象直观——开发者必须记得「定义后再调一次」。

**化解的本质矛盾**：这是「定义阶段的纯声明性」与「使用阶段必须拿到一个真实实例」之间的对立。把这两个阶段用一道函数边界隔开（定义归定义、实例化归调用），两边都能成立：定义可以纯到让打包器放心剔除，实例化也能在调用时拿到完整可用的对象。

### 把容器解析塞进每次调用，而不是定义时绑定

**选择**：入口内部按优先级解析当前该用哪个 Pinia——测试旁路 > 显式传参 > 注入 > 全局活跃兜底，并且把解析到的容器 `setActivePinia` 推为活跃。

**换来**：同一个 `useStore` 入口在不同 app、不同 Pinia 容器下能取到**不同实例**。多容器场景（一个应用挂多个 Pinia、测试隔离、SSR 多请求复用代码）就靠这条。也让 SSR 与测试可以通过「先 `setActivePinia`、再调 `useStore`」在不传参的情况下控制该用哪个容器。

**代价**：入口必须在「有活跃上下文」时调用。组件 setup 内天然有注入上下文、没问题；可一旦在组件外（普通工具函数、模块加载阶段）裸调，dev 下会直接抛错（提示「是否在 `app.use(pinia)` 之前就用了 store」），prod 下不会抛但会拿到错误实例。这是「按调用解析」的固有副作用——它把责任交还给调用方。

**相对第 1 章的新侧面**：第 1 章给的 `getActivePinia` 走的是「注入优先、全局兜底」，既不接受参数、也不把结果推为活跃。本章入口在此之上多了两步：**多了「显式传参优先」**（让调用方可以临时指定容器）、**多了「解析后推为活跃」**（让随后装配链路里的 getter/action 都能取到正确的它）。这两步正是「按调用选容器」落到代码上的具体动作。

**化解的本质矛盾**：这是「同一份 store 代码要在不同容器下复用」与「调用时必须能定位到当前正确的容器」之间的对立。把容器选择推迟到调用瞬间、并交由调用方介入（显式传参或注入），就让一份代码能自然适配多容器。这是 React hook、Vue composable 都在用的同一种通解骨架：**身份不绑在定义上，而绑在调用上下文上**。读者一旦抓住这条，在任何「同名复用、按上下文区分实例」的场景里都能认出来。

### 在定义阶段就分流两种作者语法

**选择**：定义时凭 `typeof setup === 'function'` 一次性判定作者用的是 setup 语法还是 option 语法，把结果存进 `isSetupStore` 布尔，并把选项归一为单一形状。

**换来**：一个 `useStore` 入口同时服务两种作者语法。无论写 `defineStore('counter', () => { ... })` 还是 `defineStore('counter', { state, getters, actions })`，对外都是同一个入口、同一条「调用 → 解析 → 装配 → 取出」的主流程，调用方完全无感。

**代价**：实例化时要分派到两条不同的装配路径（setup store 跑 setup 函数、option store 拼装 state/getters/actions）。这两条路径的内部差异是下一章的主题，本章只需知道「入口按 `isSetupStore` 一眼分流」。

**化解的本质矛盾**：这是「API 表达力要丰富（多种作者语法）」与「运行时实现要单一（一条主流程）」之间的对立。在定义阶段就用一个布尔把语法差异折平、归一为单一形状，让运行时主流程可以保持线性。这是处理「同一件事的多种写法」时的常用骨架：**差异折在最外层、内核只跑一条路**。

## 5. 最小原理演示

下面这段脚本演透核心思想：定义时一个实例都不造，调用时才解析容器、查注册表、装配、缓存。装配函数的内部（effectScope、返回值分类、状态镜像）是下一章的事，这里用一个返回普通对象的桩代替。

```ts
// 第 1 章给过的三件基础设施（这里最小化模拟）
type Pinia = { _s: Map<string, any> }
let activePinia: Pinia | undefined  // 模块级活跃容器指针

// 装配函数：内部细节下一章再讲，这里只演「装配会自己写注册表」
function assemble(id: string, setup: () => Record<string, any>, pinia: Pinia) {
  const store = setup()
  pinia._s.set(id, store)            // 先把自己塞进注册表，再跑 setup 的深意属下一章
  return store
}

// 本章主角：defineStore 返回的是「入口函数」而非实例
function defineStore(id: string, setup: () => Record<string, any>) {
  function useStore(pinia?: Pinia) {
    // 按调用解析容器：显式传参优先，模块级活跃指针兜底
    const resolved = pinia || activePinia
    if (resolved) activePinia = resolved     // 解析后推为活跃，让后续装配链路取得到
    const container = resolved!

    if (!container._s.has(id)) {
      assemble(id, setup, container)         // 未命中才装配
    }
    return container._s.get(id)              // 最终统一从注册表取
  }

  useStore.$id = id                          // 入口函数也是数据载体
  return useStore                            // 返回函数，不是实例
}

// 定义阶段不应创建实例：注册表此刻必须为空
const pinia: Pinia = { _s: new Map() }
activePinia = pinia
const useCount = defineStore('count', () => ({ n: 0, inc() {} }))
console.assert(pinia._s.size === 0, '定义不应创建实例')

// 首次调用才装配，并写入当前容器
const s1 = useCount()
console.assert(s1 !== undefined && pinia._s.size === 1, '首次调用应写入注册表')

// 缓存：再次调用拿到同一个实例
const s2 = useCount()
console.assert(s1 === s2, '同容器同 id 应复用实例')

// 换容器即换实例：同一入口可服务多个 Pinia
const otherPinia: Pinia = { _s: new Map() }
const s3 = useCount(otherPinia)
console.assert(s3 !== s1 && otherPinia._s.size === 1, '换容器应取到不同实例')
```

每一行都对应上面某条原理：`defineStore` 闭包但不创建、`useStore` 按调用解析并推为活跃、`_s.has(id)` 守门、`_s.get(id)` 取出、入口挂着 `$id` 作为数据载体。装配函数的内部故意留成黑盒，那是下一章的主角。

## 6. 执行轨迹

拿一个具体输入走一遍。先定义：

```ts
const useCount = defineStore('count', () => ({ n: ref(0), inc() {} }))
```

此刻调用栈返回。**没有任何 store 被创建**——`useCount` 只是一个挂着 `$id = 'count'` 的函数，闭包里封着 `'count'`、归一化后的选项、`isSetupStore = true`。`pinia._s` 注册表里没有 `'count'` 这一项。

然后第一次调用：

```ts
const s1 = useCount()
```

入口开始干活。先看有没有注入上下文。假设这次调用发生在某个组件的 setup 内，注入系统把 `app` 上的那个 Pinia 容器递了进来；调用方没传显式参数，所以走注入分支。`setActivePinia(pinia)` 把它推为全局活跃。接着 `pinia._s.has('count')` 返回 `false`，分派到 setup 装配路径：装配函数内部先把半成品塞进 `_s.set('count', ...)`、再跑 setup、再补全各种能力（具体是下一章）。装配返回后，`pinia._s.get('count')` 取出完整的 store，赋给 `s1`。此刻 `pinia._s.size` 从 0 变成 1。

再调一次：

```ts
const s2 = useCount()
```

容器解析照旧（这次可能已经没有注入上下文，但全局活跃指针还指着刚才那个 Pinia，兜底分支仍然解析到同一个容器）。`_s.has('count')` 这次返回 `true`，装配分支整个跳过，直接 `_s.get('count')` 取出。于是 `s1 === s2`，**同一个实例**。

换一个容器调用：

```ts
const s3 = useCount(otherPinia)
```

显式传参命中第一优先级，跳过注入、跳过活跃兜底。`setActivePinia(otherPinia)` 把活跃指针推到新容器上。`otherPinia._s.has('count')` 为 `false`，装配路径再跑一次，往 `otherPinia._s` 里写入一份新实例。`s3 !== s1`，但 `s3` 与 `s1` 共享同一份 `useCount` 闭包（同样的 `$id`、同样的 `options`）。

这就是「定义一次、按调用取实例」的全部走读。

## 7. 教学简化说明

本章演示故意省略了一批东西。装配函数的内部（effectScope 托管、ref/reactive/computed/function 的返回值分类、state 镜像进根 ref、先占位注册再跑 setup 的深意）留给下一章展开；HMR 临时实例分支、dev 下把实例缓存到组件实例供 devtools、测试模式的 `__TEST__` 旁路、完整泛型与重载、`StoreGeneric` 在类型层面的角色，这些都属于旁路或纯类型层，与「定义阶段返回函数而非实例」这条主线无关。本章只保留「入口闭包 + 按调用解析容器 + 注册表缓存」这一条主线，让原理演透。

## 8. 小结

Pinia 用「定义返回函数、调用才实例化」这个反直觉的形状把 store 做成了 hook。它换来定义的零副作用、按需实例化、多容器隔离与解耦的初始化顺序，代价是每次调用都要做一次「解析容器 + 查注册表」、且调用方须保证入口在有活跃上下文时被调用。入口内部那套「先占位注册再跑 setup」的装配细节，正是下一章要拆开看的内容。