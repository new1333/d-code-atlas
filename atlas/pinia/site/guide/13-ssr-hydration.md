# SSR 与状态水合：单一根状态的序列化契约

## 一份状态，要原样穿过网络

想象你在做服务端渲染。服务端拿一个已经登录的用户的购物车——里面 `count` 是 3——把整个页面渲染成 HTML 发给浏览器。浏览器收到 HTML,画面上明明白白写着「购物车:3 件」。接着 Vue 在浏览器里「激活」这份 HTML:它要重新跑一遍你的 store,把响应式状态接上,让按钮、事件重新生效。

问题就出在这一步。客户端重新跑 store 的时候,`count` 又从默认值 0 开始算。于是你看到画面闪了一下:3 → 0 → 再变回 3。这就是传说中的「水合不匹配」(hydration mismatch)——界面会闪、事件可能错位、开发模式下还会报一串警告。

你真正想搞明白的是:服务端那份状态,怎么原样、完整地搬到客户端,让两边每个 store 的每个字段都一模一样,一个 bit 都不差?

## 把所有状态钉在一块公共留言板上

pinia 的答案出奇地朴素:**所有 store 的状态,全都汇聚进同一个根对象**。这个根对象就是一块谁都能看到的公共留言板——每个 store 把自己当下的 state 钉在上面。服务端离开之前,给整块留言板拍张照(序列化);客户端开机第一件事,是把这张照片原样贴回一块新的留言板(回填)。状态就这么穿过网络了。

说人话:序列化这一个根对象、再回填这一个根对象,就是搬移状态的**全部契约**。不需要每个 store 各自搞一套序列化协议,不需要任何额外的握手。

这一步其实是在兑现前面埋下的伏笔。第 4 章讲装配时,已经把每个 store 的 state 一路镜像进了这一个根对象(镜像那一步是装配阶段的取舍,本章不重讲)。正因为当初把状态都收进了这一处,现在跨网络搬移才只需要搬这一个对象——那个「单一可序列化状态树」的承诺,到这一章才真正兑现。

## 这一个根对象,长什么样

它就是一个扁平的映射表:`{ storeId: 该store的state }`。

```
pinia.state.value = {
  cart:  { count: 3, items: [], tags: ['vip'] },
  user:  { id: 7,  name: 'Ada' },
  theme: { dark: true },
}
```

每个 store 在这张表里占一格,格子里装的是它完整的 state。它是平的、是普通对象、可以 `JSON.stringify`——这三点凑齐,它就能穿过任何能读 JSON 的运行时。

## 两段式搬移:拍照,再贴回去

搬移分两端,pinia 在中间只露出那一个根对象:

```
[服务端]                              [客户端]
各 store 装配                          框架把 JSON 整个回填
   ↓                                     进同一个根对象
state 镜像进 root                    root = { cart:{...}, user:{...} }
   ↓                                     ↓
JSON.stringify(root)  ──网络──>     parse
   ↓                                     ↓
一段 JSON                            首次 useStore('cart')
塞进 HTML 由框架发出                   触发装配,读出入站状态
```

这里有个分工要分清:pinia 自己**只暴露** `pinia.state.value` 这一个可序列化的根;真正把 JSON 塞进 HTML、客户端再从 HTML 里抠出来回填的动作,是 Vue SSR / Nuxt 这类框架干的活。pinia 不碰 stringify、不碰 parse,它只保证「我这一块根对象随时可序列化、可回填」。

## 装配的第一眼:有没有入站状态?

客户端把根对象回填好之后,并不会主动去动各个 store。store 是惰性的——直到某段代码第一次调用 `useStore('cart')`,装配才发生。

装配函数开头第一件事,就是去根对象里捞自己的那一格:

```ts
const initialState = pinia.state.value['cart']
```

这一行,就是判断「我现在是不是在水合场景」的唯一依据:

- `initialState` 是空的(不存在)→ 这是首次纯客户端启动,没有入站状态,按默认值走。
- `initialState` 有内容 → 有入站状态,需要水合。

捞到入站状态之后,往下怎么灌,option store 和 setup store 走两条不同的岔路。

## 岔路一:option store,天生就水合好了

option store 的 state 长什么样,你在 `state()` 里已经声明死了。装配时它直接从根对象里把自己的那一格取出来用:`toRefs(root['cart'])`。根里是什么,它的 state 就是什么——入站值天然已经在里面了,不需要逐个字段去灌。

换句话说,option store 的 state 因为「形状已知」,水合这一步几乎是免费的。

但免费归免费,有一种情况它搞不定:你在 state 里用了 customRef、computed,或者 `useLocalStorage` 这种「服务端的值和客户端的值本来就不一样」的东西。这时候入站的平值没法自动对齐。于是 pinia 给 option store 留了一个逃生口——一个可选的 `hydrate` 钩子:

```ts
defineStore('cart', {
  state: () => ({ token: useLocalStorage('token', '') }),
  hydrate($state, initialState) {
    // 手动把入站值塞进这个特殊响应式容器
    $state.token.value = initialState.token
  },
})
```

装配到末尾,如果有入站状态、是 option store、又定义了这个钩子,就调一下,把对齐的活交给你。

## 岔路二:setup store,逐 key 把入站值灌回去(本章核心)

setup store 麻烦一些。它的 state 不是声明出来的,是你在 setup 函数里命令式地一个个 `ref()` 创建的:

```ts
const useCart = defineStore('cart', () => {
  const count = ref(0)
  const items = ref([])
  return { count, items }
})
```

根对象事先不知道这个 store 有哪些 key、每个 key 是什么类型。所以装配时,它得遍历 setup 返回的每一个属性,逐个判断、逐个灌。

对每个属性,先看它是不是 state(是 ref 但不是 computed,或者是 reactive 对象)。是的话,进入水合——

- **是 ref**:直接 `prop.value = inbound[key]`,整体覆盖。简单值,照搬。
- **是 Set 或 Map**:先 `prop.clear()` 把你在 setup 里声明的默认值清空,再用深合并工具把入站值灌进去。(那个深合并工具 `mergeReactiveObjects` 第 5 章已经展开过它怎么处理 Map/Set,这里直接复用,不重讲。)
- **是别的 reactive 对象**:递归地把入站值赋进去。

最后还有一步很关键:把这个容器 `root['cart'][key] = prop` 注册回根对象。这样根和 store 始终是同一份引用,双向同步,后面谁改谁都看得见。

经过这一遍遍历,无论你在 setup 里怎么命令式地造 state,最后都老老实实按 key 落回到那一个根对象里——和服务端那份长得一模一样。

## 那些有状态、却不是真状态的对象

setup store 有时候会返回一个怪东西:它确实有内部状态,但你压根不想把它序列化发给浏览器。最典型的就是路由实例 `router`——它有 currentRoute 之类的内部数据,可它是框架对象,不是你的业务状态。

如果你什么都不做,装配会把它当成一个 reactive 对象,老老实实往里灌入站值、注册回根、然后跟着 root 一起被序列化发出去——把一个根本不该过网的对象发给了客户端。

所以 pinia 提供了一对标记 API:`skipHydrate(obj)` 给对象打一个不可见的隐藏标记,`shouldHydrate(obj)` 反过来检查这个标记。装配时遇到每个 state 属性,先问一句 `shouldHydrate(prop)`——被打过标记的,直接跳过,不灌、不注册、不序列化。

用法就是你主动给这类对象套一下:

```ts
const useApp = defineStore('app', () => {
  const router = skipHydrate(useRouter())
  const count = ref(0)
  return { router, count }
})
```

一个细节:`shouldHydrate` 对 `null` 和非对象一律返回「该水合」,只有「被打过标记的对象」才返回「不水合」。也就是说这个跳过标记只对对象生效——简单值该灌还是灌,不受影响。

## 关键权衡

这一章机制不算少,有四条权衡值得记住。

**一、用单一根对象当序列化契约,而不是给每个 store 单独设计一套协议。**

选择:所有 store 的 state 都收进那一个 `pinia.state.value`,服务端序列化它、客户端回填它,就完事。

换来:框架无关、零额外序列化代码。任何能读 JSON 的运行时(Nuxt、原生 Vue SSR、甚至你自己撸的)都能搬这套状态——它看到的始终就是同一个扁平对象。

代价:setup store 因为 state 是命令式一个个创建的,必须**逐 key** 把入站值灌回各个容器,多了一段「按 key 水合」的胶水代码。option store 没这个代价(形状已知),代价全压在 setup store 这一边。

**二、集合水合时先清空默认值再灌入站值,而不是把两者深合并。**

选择:遇到 Set/Map,先 `clear()` 把 setup 里声明的默认内容清掉,再灌入站值。

换来:和 `$patch` 完全一致的合并语义,而且绝不会把 store 里声明的默认集合内容错误地和服务端的值搅在一起。想象你的 tags 默认带一个 `'默认标签'`,服务端那边这个集合是空的——如果不 clear,合并完客户端会莫名其妙多出一个默认标签,和服务端对不上。

代价:你在 setup 里给集合设的那些默认值,在客户端水合时会被直接丢弃。客户端的集合内容完全以服务端为准。

**三、提供一对「应否水合」的标记 API,让 setup store 能声明「这个有状态对象不是真状态」。**

选择:用 `skipHydrate` 打标记、`shouldHydrate` 查标记,让路由实例这类对象能被显式排除在水合之外。

换来:你可以把第三方有状态对象安全地放进 setup store,而不会被序列化发往客户端——否则就是把不该过网的东西塞进了发给浏览器的 JSON。

代价:使用者得**主动**给这类非状态对象打标记。漏打了,它就会被当成普通 state 灌值、注册、序列化——错误是静默的,不会报错,你只会在客户端 payload 里发现一个本不该出现的巨大对象。

**四、option store 给一个可选的自定义水合钩子当逃生口。**

选择:option store 可以定义 `hydrate($state, initialState)`,在水合末尾被调用。

换来:customRef、computed、`useLocalStorage` 这类「服务端值 ≠ 客户端值」的特殊响应式,能被你手动对齐——入站的平值塞不进这些特殊容器,钩子给你一个动手的地方。

代价:这个钩子仅 option store 可用。setup store 因为默认就是逐 key 灌值,已经覆盖了大部分情况;但如果你在 setup store 里也用了 customRef 这类东西,没有钩子可用,得自己在 setup 函数里处理对齐。

## 最小演示:一个根就是契约,按 key 拆还

下面这段几十行的脚本把核心演透:一个根对象 `{ id: state }` 就是全部契约;给定入站状态和一个命令式造 state 的 setup 函数,装配时按 key 灌值;被 `skipHydrate` 标记的对象不参与灌值。用极简的 `{ value }` 模拟响应式容器,不接 vue,能直接 `node ssr-hydration.mjs` 跑。

```ts
// ssr-hydration.mjs —— node ssr-hydration.mjs 即可运行

// 极简模拟一个响应式容器(真实实现是 vue 的 ref)
const ref = (v) => ({ value: v })
const isRefLike = (o) => o && typeof o === 'object' && 'value' in o

// 「跳过水合」标记:给对象打一个不可枚举的隐藏属性
const SKIP = Symbol('skip')
const skipHydrate = (obj) => (Object.defineProperty(obj, SKIP, {}), obj)
const shouldHydrate = (obj) =>
  !obj || typeof obj !== 'object' || !Object.hasOwn(obj, SKIP)

// 整个 SSR 的状态契约:就这一个根对象,{ storeId: state } 的扁平表
const rootState = {}

// ===== 服务端:跑完所有 store,序列化这一个根对象 =====
function serverSide() {
  rootState.cart = { count: 3, items: [], tags: ['vip'] }
  return JSON.stringify(rootState) // 这就是发给浏览器的全部货物
}

// ===== 客户端:回填根对象,再在首次装配时按 key 水合 =====
function clientSide(payload) {
  // 第 1 步:JSON 整个回填进同一个根对象
  Object.assign(rootState, JSON.parse(payload))

  // 第 2 步:首次用到购物车 store,读出它在根里已有的入站状态(拍个快照)
  const inbound = { ...rootState.cart }

  // 第 3 步:客户端也跑一遍 setup,命令式创建「带默认值」的全新容器
  const setupStore = {
    count: ref(0),                       // 默认 0
    items: ref(['本地默认项']),           // 默认值会怎样?见权衡二
    tags: new Set(['默认标签']),          // 命令式声明的集合,默认带一个标签
    router: skipHydrate({ path: '/' }),  // 路由实例:有状态但不是真状态
  }

  // 第 4 步:按 key 把入站值灌进每个容器 —— setup store 水合的核心
  for (const key in setupStore) {
    const prop = setupStore[key]
    if (!shouldHydrate(prop)) continue   // 被 skipHydrate 标记的,直接跳过

    if (isRefLike(prop)) {
      prop.value = inbound[key]          // 简单值:整体覆盖默认值
    } else if (prop instanceof Set || prop instanceof Map) {
      prop.clear()                       // 集合:先清空声明时的默认值
      inbound[key].forEach((v) => prop.add(v))  // 再逐个灌入站值
    }
    // 最后把这个容器注册回根状态,保持根与 store 双向同步
    rootState.cart[key] = prop
  }
  return setupStore
}

console.log('=== 服务端 ===')
const json = serverSide()
console.log('发往客户端的 JSON:', json)

console.log('=== 客户端水合后 ===')
const store = clientSide(json)
console.log('count  =', store.count.value)   // 3       ← 与服务端一致,无水合不匹配
console.log('items  =', store.items.value)   // []      ← 默认值 ['本地默认项'] 被丢弃
console.log('tags   =', [...store.tags])     // ['vip'] ← 默认标签被清掉,只剩入站值
console.log('router =', store.router.path)   // '/'     ← 未被入站值覆盖,保持客户端原样
```

跑出来的轨迹正好对应前面几条原理:`count` 被入站的 3 整体覆盖,和服务端一致;`items` 的默认值 `['本地默认项']` 被丢弃,变成入站的空数组;`tags` 这个集合先 clear 掉 `'默认标签'`,再灌入 `'vip'`;`router` 因为打了标记,从头到尾没被碰,保持客户端自己的 `{ path: '/' }`。

## 小结

一句话收束:pinia 的 SSR 不发明任何新的传输协议,它只做一件事——保证所有 store 的状态始终汇聚在那一个可序列化的根对象里。服务端拍照、客户端贴回去,然后装配时按 key 把入站值灌进各自的容器(option store 因形状已知而天然水合,setup store 逐 key 灌值,集合先清后灌,非状态对象用 skipHydrate 跳过)。状态就这么原样穿过了网络。

但 pinia 自己只负责把根对象暴露出来、把入站值按 key 灌好——真正把那段 JSON 塞进 HTML、客户端再自动回填的那套脚手架,是框架的事。紧邻的下一章「Nuxt 模块」就会讲 Nuxt 是怎么用运行时插件把这套拍照—回填自动化、再用构建期变换把接入样板抹平的。