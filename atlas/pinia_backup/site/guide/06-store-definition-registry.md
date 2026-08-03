# `defineStore`：懒注册与 store 注册表

## 你以为 defineStore 创建了 store？其实没有

写过 Pinia 的人大概都干过这件事——在一个文件里写：

```ts
export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)
  return { count }
})
```

然后心里默认「现在 counter store 已经建好了」。这个直觉是错的。

`defineStore` 干的事比你想的少得多：它只是把 `'counter'` 和那段 setup 函数收进一个闭包，再吐回一个叫 `useCounterStore` 的函数。`useCounterStore` 才是真正去拿 store 的入口。在有人第一次调它之前，counter store 在内存里根本不存在。

类比一下：`defineStore` 像在通讯录里给一个人预留一格名片位——格子已经标好名字，但名片是空的，要等谁来查这一格时才现填现用。

这条「定义 ≠ 实例化」的设计贯穿整个 Pinia，本章就围绕它转。

## 一次完整的调用会经历什么

来看你写 `useCounterStore()` 时到底发生了什么，拆成 6 步：

1. **模块加载期**：你写 `defineStore(id, setup)`，只把 id 和 setup 收进闭包，完。**没建任何 store**。
2. **第一次调用**：组件、路由守卫、单测里第一次写 `useStore()`，函数才真正开始干活。
3. **解析 pinia**：得先知道「往哪个注册表里查」。优先级是 显式参数 → 组件 `inject` 的全局符号 → 模块级全局变量 `activePinia`，三路兜底。
4. **查注册表**：拿到 pinia 后去问 `pinia._s`（一个 `Map<string, Store>`）——有没有 `'counter'`？有，直接跳到第 6 步。
5. **未命中才创建**：注册表里没有，才走真正的构建器；构建器做完一些骨架动作后**会立刻把半成品塞进注册表**，然后再继续装真正的 state/getter/action。
6. **从注册表里取**：返回前再走一次 `pinia._s.get(id)`，强制走表（不直接返回本地引用）。

说人话就是：`useStore` 不是「工厂函数」，它是「查表函数」。表里没有才动工厂，工厂动的同时立刻登记，免得来回创建、也免得循环依赖时炸栈。

这条流程里的第 5 步是整章最微妙的地方，值得单独演示。

## 关键演示：循环引用为何不死

先看问题。设想两个 store，A 用 B、B 又用 A：

```ts
const useA = defineStore('a', () => {
  const b = useB()
  return { fromB: () => b.msg }
})

const useB = defineStore('b', () => {
  const a = useA()
  return { fromA: () => a.msg }
})
```

如果「先跑完 setup 再注册」，调一次 `useA()` 就会爆栈：A 的 setup 调 B → B 的 setup 调 A → A 的 setup 又调 B → …… 无限递归。

Pinia 的解法是：**在跑 setup 之前，先把半成品 store 写进注册表**。这样对方再来查时，哪怕你这边还没装配完，也能拿到一个引用——引用本身是稳定的，等会儿属性填上之后对方读出来就是完整版。

下面这段 30 来行的脚本从零实现这套机制（不需要 Vue，纯 plain object 就能演透）：

```ts
// 注册表是核心：一块谁都能查的公共留言板
type Store = Record<string, any>
const pinia = { _s: new Map<string, Store>() }
let activePinia: typeof pinia | null = null
const setActivePinia = (p: typeof pinia | null) => { activePinia = p }

// defineStore 只把 id 和 setup 收进闭包，绝不创建 store
function defineStore(id: string, setup: () => Record<string, any>) {
  function useStore() {
    setActivePinia(pinia)              // 模拟 inject + activePinia 兜底
    if (!pinia._s.has(id)) {
      createSetupStore(id, setup, pinia)
    }
    return pinia._s.get(id)!           // 强制走表，不返回本地引用
  }
  return useStore
}

function createSetupStore(id: string, setup: () => Record<string, any>, p: typeof pinia) {
  const store: Store = { $id: id }     // 半成品：只有骨架属性
  p._s.set(id, store)                  // ★ 关键一行：先入表
  const returned = setup()             // 跑用户 setup（这里可能调对方的 useStore）
  Object.assign(store, returned)       // 把真正的 state/getter/action 装上
  return store
}
```

注意 `createSetupStore` 里那行 `p._s.set(id, store)` 出现的位置——它**先于** `setup()`。下面这段调用演透它的全部价值：

```ts
const useA = defineStore('a', () => {
  console.log('A 的 setup 跑了')
  const b = useB()                     // 这一刻 B 还没建好，但能拿到引用
  console.log('A setup 内 b.$id =', b.$id, ', b.msg =', b.msg)
  return { msg: 'I am A', fromB: () => b.msg }
})

const useB = defineStore('b', () => {
  console.log('B 的 setup 跑了')
  const a = useA()                     // 这里会命中——A 已在表里（虽然只是半成品）
  console.log('B setup 内 a.$id =', a.$id, ', a.msg =', a.msg)
  return { msg: 'I am B', fromA: () => a.msg }
})

const a = useA()
console.log('---')
console.log('A 装配完，再读 a.fromB() =', a.fromB())
```

跑一遍，输出大致是：

```
A 的 setup 跑了
B 的 setup 跑了
A setup 内 b.$id = b , b.msg = undefined       ← 拿到了引用，但属性还没填
B setup 内 a.$id = a , a.msg = undefined       ← 同样，引用有效但内容为空
---
A 装配完，再读 a.fromB() = I am B              ← 等真的求值时，B 已经完整
```

把 `createSetupStore` 里那行 `p._s.set(id, store)` 挪到 `Object.assign` 之后试试——你会立刻看到栈溢出。这一行位置的差异，就是 Pinia 整个注册表机制存在的全部理由。

不过，光「半成品先入表」还不够。半成品被对方拿走之后，对方 setup 内可能要写 getter、要立即读对方的属性——而对方此刻是空的。所以配套还有一句：**getter 求值时再从注册表懒取**，不要在闭包里把半成品引用写死。

```ts
// option store 的每个 getter 内部都类似这样写
const store = pinia._s.get(id)!        // 每次求值懒取，避免捕获半成品
return getters[name].call(store, store)
```

getter 第一次被读时，store 早就装配完了，这时取出来的是完整版。

## 关键权衡

看完演示你大概有感觉了——这套机制的每一步都像在为某个具体的坑兜底。下面把 4 个最值得记的坑和它的解法摊开讲。

### 权衡 1：懒实例化 + Map 缓存 + 无副作用标注

**做了**：`defineStore` 不立刻创建 store；返回的 `useStore` 第一次被调才创建，创建后塞进 `pinia._s` 这个 Map；`defineStore` 整个函数还被标注 `#__NO_SIDE_EFFECTS__`，告诉打包器「调用 defineStore 本身无副作用，没人用的 store 可以删掉」。

**换来了**：
- 项目里写了 50 个 store、某个页面只用其中 3 个——另外 47 个的代码可以被打包器整段剔除；
- 同一个 pinia 内，无论调多少次 `useCounterStore()`，拿到的永远是同一个对象，单例由 Map 缓存保证。

**代价**：
- 第一次调用必然要付完整的初始化成本——跑 effectScope、分类 setup 返回值、装 getter/action、跑插件。这是一次「可见的卡顿」，按需加载的路由第一次进会有体感；
- HMR 必须专门设计「已注册的 store 怎么热替换」（用 `'__hot:' + id` 临时造一个新 store、再调旧 store 的 `_hotUpdate` 替换内容），因为单例缓存意味着不能简单重建。

### 权衡 2：跑 setup 之前先把半成品 store 写进注册表

这条上面的演示已经讲透了大半，这里收一下。

**做了**：`createSetupStore` 在跑用户 setup **之前**，先 `pinia._s.set($id, store)`，此刻 store 只有 `$id`、`$patch`、`$onAction`、`$subscribe`、`$dispose` 这些骨架属性，state/getter/action 都还没装。

**换来了**：A 引用 B、B 引用 A 这种循环引用不死递归——A 调 B 时 B 已在表里（哪怕还不完整），引用本身是稳定的，等会儿对方属性填上之后读出来就是完整版。

**代价**：
- setup 函数体内拿到的「对方 store」是个不完整对象，**不能立即读对方的属性**（读到的是 `undefined`），能做的只是「持有这个引用，等会儿再用」；
- 所以 getter 必须延迟到首次求值时再从注册表懒取（如演示后那段代码所示），不能闭包捕获半成品引用写死。这两条互为表里——少了「先入表」会爆栈，少了「懒取」会读到空属性。

### 权衡 3：模块级全局 activePinia 兜底

**做了**：除了组件树内的 `inject(piniaSymbol)`，Pinia 还在模块顶层维护一个 `let activePinia` 全局变量。每次组件里调 `useStore` 都会顺手 `setActivePinia(当前pinia)` 把它写成最新值。这样「组件外」的代码（路由守卫、API 拦截器、Web Worker、单测）即便没法 inject，也能通过 `getActivePinia()` 拿到一个 pinia。

**换来了**：setup 外用 store 的极致便利。你写 `router.beforeEach(() => useAuthStore().checkLogin())` 不需要传 pinia，写单测 `useStore()` 也不需要绑定组件上下文。

**代价**：
- SSR 是个大坑。Node 进程里所有请求共享同一个模块级 `activePinia`，如果不在每个请求入口显式 `setActivePinia(new pinia)`，A 用户的请求会读到 B 用户的状态——教科书级的跨请求状态污染；
- dev 模式下 `getActivePinia()` 在「既无 inject 又无 activePinia」时会抛诊断码 `PINIA_R1004`，提示「useStore 是 composable、应该在 setup 顶部调或显式传 pinia」——专门拦「我以为能 inject、其实没在 setup 里」这种常见误用。

### 权衡 4：测试模式后门 + 三路兜底

**做了**：useStore 解析 pinia 时优先级是 **测试模式 + 全局活跃实例带 `_testing` 标记 → 强制忽略显式参数**；否则按 **显式参数 → 组件内 `inject(piniaSymbol)` → 全局 `activePinia`** 三路兜底。

**换来了**：三种使用姿势都自然——
- 组件里隐式：什么都不传，靠 inject；
- 外部显式：`useStore(specificPinia)`，多 pinia 场景或库代码里用；
- 测试桩强制覆盖：`createTestingPinia()` 设的 `_testing: true` 实例自动接管所有 useStore 调用，单测里再不用每处都传 pinia。

**代价**：优先级链路隐晦。新人第一次看「为什么不传 pinia 也能跑」会一头雾水——「我什么都没传，它怎么知道用哪个 pinia？」答案得追到模块级全局变量 + Vue 的 inject 上下文 + 构建期 `__TEST__` 短路三处才能拼全。这是为了便利付的认知税。

## 一句话收尾

`defineStore` 这层做的不多，但每一步都卡在刀刃上：定义时不建、调用时才建、建之前先入表、入表后立刻装配。这套组合拳换来的是「未用即删、已用即单例、循环引用不死、组件内外都能用」四件事同时成立。

下两章会拆「装配」这一步：先讲 setup store 构建器怎么把 setup 返回值分类成 state/getter/action，再讲 options store 适配器怎么把声明式选项翻译成 setup——你会发现它们都共用本章这套注册表机制。