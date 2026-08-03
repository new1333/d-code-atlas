# 插件系统：context 注入的 store 增强

假设你在做一个项目，发现每个 store 都要做同样几件事：打印一下变更日志、把状态存进 localStorage、检查一下当前用户有没有权限调这个 action。如果每次写新 store 都得把这些逻辑抄一遍，你会疯；如果你想统一改一下日志格式，又得满项目翻一遍。更尴尬的是，连 Pinia 自己的开发者工具（DevTools）本质也是「想挂到每一个 store 上」的能力——总不能把它的代码硬塞进每个 store 的定义里吧。

所以你需要一个**统一的扩展点**：写一次，自动作用到所有 store 上，而且能拿到每个 store 的全部上下文。这就是插件系统。

## 插件到底是个什么东西

说人话：插件就是流水线上每个 store 都要经过的一个**通用加工工位**。不管你用什么语法写的 store，装配到最后一道工序时，都得在这些工位前停下来，让它们给你加装点东西——可以是新的状态、新的计算属性、新的方法。

代码上它就是一个函数，签名为「收一个 context，返回一组扩展属性（或什么都不返回）」：

```ts
type PiniaPlugin = (context: {
  store    // 当前正在被增强的这个 store
  app      // 当前 Vue 应用
  pinia    // pinia 实例本身
  options  // 定义这个 store 时用的选项（含 actions）
}) => Partial<扩展属性> | void
```

返回的那组扩展属性会被**就地合并**进 store——说白了就是 `Object.assign(store, 插件返回的对象)`。合并完之后，`store.xxx` 就能直接访问到插件注入的东西。所以插件能做的事和 store 自己定义的 state/getter/action 是平起平坐的：它注入的 ref 会成为 store 的状态，注入的函数会成为 store 的方法。

这里藏着第一条权衡，先说一半：插件注入的东西，享受的是和 store「原配」状态**完全一样**的响应式待遇。这个待遇从哪来？下一节揭晓。

## 注册：在 app 挂载之前就能登记

插件写好了怎么告诉 Pinia？调用 `pinia.use(plugin)`。但这里有个时机问题：很多人是在 `app.use(pinia)` **之前**就 `pinia.use(...)` 注册插件的（甚至 Pinia 自己就是这么干的，下面会讲）。可那时候 app 还没挂载，store 也还没装配，插件该往哪儿放？

Pinia 的做法是用**两个地方**接住插件，像一个还没开门的餐厅——客人先在候餐区（`toBeInstalled` 暂存队列）排着，门一开集体进大堂（`_p` 已安装表），之后来的直接进大堂：

```ts
use(plugin) {
  if (!this._a) {          // app 还没挂载（_a 还是 null）
    toBeInstalled.push(plugin)   // 先在候餐区排着
  } else {
    _p.push(plugin)              // 已挂载，直接进大堂
  }
  return this
},
```

等到 `install(app)`（也就是 `app.use(pinia)`）真正执行的那一刻，把候餐区整体 flush 进大堂：

```ts
install(app) {
  setActivePinia(pinia)
  pinia._a = app
  app.provide(piniaSymbol, pinia)
  // ...
  toBeInstalled.forEach(p => _p.push(p))  // 候餐区 → 大堂
  toBeInstalled = []                       // 清空候餐区
}
```

这里有个特别能说明设计意图的细节：`createPinia()` 在结尾会自己 `pinia.use(devtoolsPlugin)`，把整套开发者工具当成一个普通插件预装上。换句话说，**框架自己的系统级能力也是走这条插件通道的**——插件系统不是「给用户开的口子」，而是 Pinia 对内对外统一使用的唯一扩展点。这也是为什么注册时机必须允许「挂载之前就能登记」：框架自己得在 `install` 之前就把 devtools 插件塞进候餐区。

> 这条权衡可以这么复述：**用一个「暂存队列 + 挂载时一次性灌入已安装表」来处理注册时机，换来插件注册函数可以在 app 正式挂载之前就自由调用（框架自己就靠这一点预装 devtools），代价是内部要同时维护两份数据，并在挂载那一刻做一次 flush。**

## 运行：每个 store 装配到末尾，在自己的作用域里跑一遍

插件注册进来之后，什么时候真正「作用」到 store 上？答案是：**每个 store 装配流程的最末尾**。

回顾一下 store 的装配（这套时序和「先占位注册再懒装配」第 4 章已展开，这里不重复）：store 在自己的子 effectScope 里跑 setup，把返回值分类成 state/getter/action，合并成一个 reactive 对象。装配走到最后一步，Pinia 会遍历已安装表 `_p`，把每个插件挨个跑一遍。

关键在于**在哪跑**：

```ts
pinia._p.forEach(extender => {
  const extensions = scope.run(() =>          // ← 注意这个 scope
    extender({ store, app: pinia._a, pinia, options: optionsForPlugin })
  )
  // ...（devtools 登记自定义属性 / dev 纯对象告警）
  assign(store, extensions)
})
```

这个 `scope` 不是随便一个作用域，而是**这个 store 自己装配时开的那个子 effectScope**——和跑 setup、和存 state 的，是同一个。

为什么非得是它？这就引出了本章的灵魂。

## 灵魂权衡：作用域托管 ↔ 禁止裸纯对象

store 的 effectScope 像一本**自动登记册**：凡是写进 `scope.run(...)` 里创建的响应式数据（ref、computed、reactive），都会被这本册子记下来。store 被销毁时（`$dispose` → `scope.stop()`），册子一撕，上面记的所有响应式副作用一并回收。

把插件放进这个 scope 里跑，意味着**插件返回的响应式数据也会被记进这本册子**。于是发生了两件美好的事：

1. 插件注入的 ref/computed，响应式自动归这个 store 托管——你改它，依赖它的组件会更新；它和 store「原配」的状态没有半点区别。
2. store 一销毁，插件当初注入的响应式副作用也跟着一起死，不会留下幽灵。

这就是第一节卖的那个关子：插件注入的东西能享受完整响应式待遇，根因就是它跑在 store 自己的作用域里。

但这个选择是有代价的，而且是 plugin 作者必须知道的硬约束：**插件不能返回「裸的纯对象」**。

为什么？因为一旦这个裸纯对象被 `assign` 合并进 store，而 store 本身是个 `reactive()`，响应式系统会去解包它遇到的嵌套响应式值——到那时，一个「原本是 `reactive(...)` 的值」和一个「原本就是普通对象」在 store 里就长得一模一样、再也分不清了。而纯对象既不归作用域托管（scope 抓不到它），也不会被响应式系统跟踪。

后果是什么？你注入的这个属性**不具备响应性**：改它组件不会更新，`storeToRefs()` 也会把它忽略掉（storeToRefs 是凭 `isRef`/`isReactive` 判断要不要提取的，纯对象两条都不沾）。

所以 Pinia 在开发期会专门检查这件事——而且**刻意赶在 `assign` 合并之前**检查（注释写得很直白：合并后再查就来不及了，因为 reactive 会把值解包到无法区分）。检查逻辑是：凡是「typeof 是 object、又不是 ref、又不是 reactive、又没被 `markRaw` 标过」的值，就告警：

```ts
if (__DEV__) {
  for (const key in extensions) {
    const value = extensions[key]
    if (
      typeof value === 'object' &&
      !isRef(value) &&
      !isReactive(value) &&
      !value?.__v_skip          // markRaw 会给对象打上 __v_skip
    ) {
      diagnostics.PINIA_R1006({ key, id: store.$id })  // 告警
    }
  }
}
assign(store, extensions)
```

这条权衡可以这么复述：**让插件在 store 自己的作用域内执行，换来插件返回的响应式数据自动归该 store 托管、随 store 销毁一并回收、且能被响应式系统与定向提取正常处理；代价是插件不能返回裸纯对象——合并进 store 后响应式值会被解包、与纯对象再也无法区分，而纯对象既不归作用域托管、也会被 storeToRefs 忽略，所以作者必须显式用 `ref()`/`reactive()`/`shallowRef()`，或用 `markRaw()` 明确声明「我这就是个不需要响应式的静态对象」。**

换句话说，`markRaw()` 是你的逃生口：有些插件注入的东西天生就不该响应式（比如一个类实例、一个第三方对象），用 `markRaw()` 给它打上 `__v_skip`，既跳过告警，也明确告诉响应式系统「别管我」。

## 配套权衡：为什么要在装配时动态构造 options

还有两个不那么显眼、但同样体现设计意图的细节，一起说了。

**第一个，传给插件的 `options` 是临时拼出来的。** 注意插件拿到的 context 里有个 `options`，它不是 defineStore 时原样透传的选项，而是装配时现构造的：`assign({ actions: {} }, options)`。

为什么要这么干？因为 store 有两种写法。Option store 的 actions 明明白白写在选项里；但 setup store 的 action 是 setup 函数返回的 function，**在装配跑完之前根本不存在**。如果原样把 options 传给插件，setup store 的插件会拿到一个 `actions` 为 undefined 的东西，写插件的人就得自己判空。Pinia 的处理是：先保证 `actions` 这个字段永远存在（空对象也行），然后在分类 setup 返回值时，把每个 function 都顺手收集进 `optionsForPlugin.actions[key]`。

> 这条权衡：**在装配时动态构造一份 options 上下文、并把 setup 语法 store 的 action 逐一收集进去，换来插件经由上下文能看到任意写法的 store 的全部 action（且 `options.actions` 形状稳定、永不为 undefined）；代价是装配路径要多一次浅合并、多一次逐属性收集。**

**第二个，插件注入的每个键会被登记进一个「自定义属性集合」`_customProperties`。** 它的真正消费者**只有 DevTools**——在面板里区分「这是插件注入的外来属性」和 store 自身的状态/getter，从而在展示与编辑时区别对待。

这里有个特别容易记错的点（连 Pinia 自己的早期文档都含糊过）：`storeToRefs()` **并不读** `_customProperties`。storeToRefs 完全是凭属性「是不是响应式」来决定要不要提取的——插件返回的纯对象之所以被忽略，是因为它不响应式，**不是**因为它没被登记。所以这个集合只服务 DevTools 这一个消费者。而且它只在 dev 或 devtools 构建下才存在，纯生产构建里它根本不会被创建。

> 这条权衡：**把插件注入的每个键登记进 `_customProperties`，换来 DevTools 能区分外来属性与 store 自身状态/getter 从而区别对待；代价是多维护一个集合与一次登记动作（且仅 dev/devtools 构建才付这个代价，生产构建里整段逻辑被 tree-shake 掉）。**

## 把它跑起来：一个迷你骨架

下面是从零写的迷你骨架，**不是 Pinia 源码**，只为演透上面三条灵魂：① 暂存队列与挂载时 flush；② 作用域托管（销毁后插件注入的响应式自动失效）；③ 裸纯对象告警。它是一段能直接 `node`/`bun` 跑的脚本。

```ts
// ===== 迷你响应式：只够演示「作用域捕获 + 停止时清理」 =====
let activeScope: MiniScope | null = null

class MiniScope {
  effects = new Set<() => void>()
  active = true
  run<T>(fn: () => T): T | undefined {
    if (!this.active) return
    const prev = activeScope
    activeScope = this
    try { return fn() } finally { activeScope = prev }
  }
  stop() {
    this.active = false
    this.effects.forEach(fn => fn())   // 撕掉登记册：逐个清理
    this.effects.clear()
  }
}
// 把一个清理函数记进当前作用域（模拟 Vue 的 onScopeDispose）
function onScopeDispose(fn: () => void) {
  if (activeScope) activeScope.effects.add(fn)
}
// 迷你 ref：值 + 副作用订阅；订阅随当前作用域自动清理
function miniRef<T>(val: T) {
  const subs = new Set<() => void>()
  return {
    __isRef: true,
    get value() { return val },
    set value(v: T) { val = v; subs.forEach(fn => fn()) },
    subscribe(fn: () => void) {
      subs.add(fn)
      const off = () => subs.delete(fn)
      onScopeDispose(off)            // ← 关键：作用域停止时自动取消订阅
      return off
    },
  }
}

// ===== 迷你 Pinia：use/install（含暂存队列与 flush）+ 装配时在 store 作用域内跑插件 =====
function createMiniPinia() {
  const rootScope = new MiniScope()
  let toBeInstalled: any[] = []          // 候餐区
  const _p: any[] = []                    // 大堂
  const _s = new Map()

  const pinia = {
    _a: null as any, _e: rootScope, _p, _s,
    use(plugin: any) {
      if (!this._a) toBeInstalled.push(plugin)   // 没挂载 → 候餐区
      else _p.push(plugin)                       // 挂载了 → 大堂
      return this
    },
    install(app: any) {
      this._a = app
      toBeInstalled.forEach(p => _p.push(p))     // flush
      toBeInstalled = []
    },
    defineStore(id: string, setup: () => Record<string, any>) {
      return () => {
        if (_s.has(id)) return _s.get(id)
        const scope = new MiniScope()
        const store: any = { $id: id, $dispose() { scope.stop(); _s.delete(id) } }
        _s.set(id, store)                         // 先占位（第 4 章已展开）
        rootScope.run(() => scope.run(() => Object.assign(store, setup())))
        // —— 装配末尾：在 store 自己的 scope 内逐个跑插件 ——
        _p.forEach(extender => {
          const ext = scope.run(() =>
            extender({ store, app: this._a, pinia: this, options: { actions: {} } }))
          for (const k in ext) {                  // dev：裸纯对象告警
            const v = ext[k]
            if (v && typeof v === 'object' && !v.__isRef && !v.__isReactive && !v.__skip)
              console.warn(`[R1006] "${k}" 是裸对象，不响应式，storeToRefs 会忽略它`)
          }
          Object.assign(store, ext)               // 就地合并
        })
        return store
      }
    },
  }
  return pinia
}

// ===== 两个对照插件 =====
const logPlugin = ({ store }: any) => {           // 返回 ref —— 被作用域托管
  const count = miniRef(0)
  count.subscribe(() => console.log(`  [${store.$id}] 插件副作用感知到变化`))
  return { _logCount: count }
}
const configPlugin = () => ({ _config: { theme: 'dark' } })  // 返回裸对象 —— 触发告警

// ===== 执行轨迹 =====
const pinia = createMiniPinia()
pinia.use(logPlugin)                              // 挂载前注册 → 进候餐区
pinia.use(configPlugin)
console.log('挂载前 _p 长度 =', pinia._p.length, '（还在候餐区）')
pinia.install({})                                 // 挂载：flush
console.log('挂载后 _p 长度 =', pinia._p.length)

const useCounter = pinia.defineStore('counter', () => ({ n: miniRef(1) }))
const store: any = useCounter()

console.log('--- 改插件注入的 _logCount（应触发插件副作用）---')
store._logCount.value = 5

console.log('--- storeToRefs 视角（它凭「是否响应式」判断，不是查登记表）---')
console.log('_logCount 是 ref？', !!store._logCount.__isRef)   // true → 会被提取
console.log('_config   是 ref？', !!store._config.__isRef)     // false → 被忽略

console.log('--- 销毁 store ---')
store.$dispose()
console.log('--- 销毁后再改 _logCount ---')
store._logCount.value = 9                          // 作用域已停，订阅已清 → 无打印
console.log('（上面没有插件副作用 = 注入的响应式已随 store 一起回收）')
```

把这段跑起来，你会依次看到：挂载前 `_p` 长度为 0、挂载后变成 2；改 `_logCount` 触发插件副作用打印；`_config` 因是裸对象被告警、且 `__isRef` 为 false；销毁 store 后再改 `_logCount` 静悄悄——三条权衡全部被验证。

## 小结

插件系统的全部精髓可以压成一句话：**把一个「拿 context、返回扩展、就地合并」的增强函数，安排在「每个 store 装配的最末尾、store 自己的作用域内」运行。** 这个安排同时解决了两件事——让插件能作用到所有 store、且注入的东西自动享受 store 的响应式与生命周期。代价是插件作者要遵守「别返回裸纯对象」这条约束，并用 `markRaw` 为确实不需要响应式的值开逃生口。注册侧用「暂存队列 + 挂载时 flush」换来了「挂载之前就能注册」的自由，连框架自己的 DevTools 都借此预装——插件系统由此成为 Pinia 对内对外统一使用的唯一扩展点。

下一章我们会看到这套机制的一个直接受益者：mapHelpers 把组合式的 store 适配到 Options API（`mapState`/`mapActions`），它生成的 computed/methods 在被访问时才惰性取 store——这层适配之所以能成立，正因为 store 的 state/getter/action 三分结构是稳定的，而插件注入能力并不改变这层契约。