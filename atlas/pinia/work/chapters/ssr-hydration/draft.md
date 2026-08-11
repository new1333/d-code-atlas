# SSR 与状态水合：单一根状态的序列化契约

> 本章属于 system 层。前置：Store 装配、状态变更模型。
> 学完你能用一句话讲清：Pinia 的 SSR 契约为什么就是那一个根状态对象，以及客户端怎么把它按 key 拆还给每个 store。

## 1. 为什么需要它

上一章把 DevTools 当作一个插件，整套可观测层建立在「状态可被拍照与回放」这个前提上——timeline 记录每次变更、inspector 展开当前快照。SSR 把这个前提推到了极致：服务端拍下整份状态发往浏览器，客户端要把它原样回放出来。

读者撞上的烦恼很具体：服务端算好了购物车有 3 件商品、用户已登录、当前主题是暗色，HTML 里渲染的就是这些值；可浏览器拿到 HTML 后，客户端的 store 会按 setup 函数里写的默认值重新建一遍——count 又变回 0、用户变回未登录。界面闪一下、事件对不上、控制台报「水合不匹配」。

读者真正要解决的是把服务端算完的那份状态原封不动搬到客户端，让客户端的 store 拿到时就已经是那个值。这个搬移需要一份契约：一份服务端和客户端都认得的状态快照。

## 2. 核心思想

把「状态搬移」从「每个 store 各自想办法」降维成「一个根对象承载全部」——序列化它就等于序列化了所有 store，回填它就等于回填了所有 store。

这个根对象是个扁平映射：`{ storeId: stateObject }`。任何能做 JSON 的运行时都能搬它，不需要额外的序列化协议、不需要每个 store 写自己的 serialize/deserialize。

## 3. 心智模型

根状态对象长这样：

```
pinia.state.value = {
  cart: { count: 3, items: [] },
  user: { id: 7, name: 'ada' },
  prefs: { theme: 'dark' }
}
```

服务端跑完所有 store 后，这个对象里躺着每个 store 的最终状态。整套状态搬移分两步：

第一步「拍照」：把整个根对象 `JSON.stringify` 一下，塞进 HTML 的载荷发给浏览器。

第二步「回放」：浏览器拿到载荷后，先把它整体回填进同一个根对象；当页面首次用到某个 store 时，装配过程读出「这个 store 在根里已有的入站状态」，按需灌进 store 自己的状态容器。

第二步里两种语法分叉：

- **option store**：state 形状由 `state()` 选项声明，直接从根对象取——根里是什么，state 就是什么，天然已水合。
- **setup store**：state 是命令式 `ref()` 一个个建出来的，装配时遍历 setup 返回的每个 state 容器，把入站值逐 key 灌进去，再把容器注册回根对象保持双向同步。

## 4. 关键权衡

### 用一个根对象当契约，而不是给每个 store 单独的序列化协议

这个设计直接兑现装配章那次权衡——把所有 state 镜像进同一个根对象，换来「单一可序列化状态树」；本章就在这个根对象上把状态序列化发往客户端，省下一套额外的序列化协议。

服务端只要把那一个根对象 stringify、客户端只要把那一个根对象回填，跨网络的状态搬移就完成了。任何能跑 JSON 的运行时都能接：Nuxt 用它、Vue SSR 用它、自研框架也能用它。

换来这套跨框架的中立性，代价落在 setup store 上。option store 的 state 形状由 `state()` 选项声明，从根里直接取就行；setup store 的 state 是开发者在 setup 函数里命令式 `ref()` 一个个建出来的，装配时要做一段「按 key 灌值」的胶水：遍历 setup 返回的每个 state 容器，把入站值赋进去，再把容器注册回根对象保持双向同步。这段胶水是单一契约换来的必然成本。

化解的本质矛盾是「**框架中立 vs. 语法自由**」：状态契约想要稳定到任何运行时都能搬，store 的写法又想自由到能命令式声明任意响应式容器——两者不可能同时满足，除非承认「契约只有一个根对象，让 setup store 自己负责把根里的值灌进它建的容器」。读者一旦抓住这个骨架，在任何「把序列化值灌回运行时容器」的 SSR/hydrate 场景里都能认出同一组取舍。

### 集合水合时先清空默认值，再灌入站值

setup store 里常会写 `items: ref(new Set())` 或 `tags: ref(new Map())` 这种集合默认值。水合这种集合时，pinia 的做法是先 `prop.clear()` 把默认值倒掉，再灌入站值，而不是把默认值与服务端值深度合并。

换来的是与 `$patch` 完全一致的合并语义：客户端拿到的就是服务端那份集合本身，不会因为开发者本地默认填了几个种子值就被混进网络传来的真值。代价是开发者在 setup 里给集合设的「默认种子」在客户端水合时会被直接丢弃——你只能从「服务端值是唯一真相」的角度理解集合的初始状态。

> 深合并工具本身在状态变更模型一章里已展开过，这里只引用它处理集合灌值的语义。

### 提供「应否水合」的标记 API，让 setup store 能声明「这个有状态对象不是真状态」

setup store 经常会返回一些「有状态但不是数据」的对象——最典型的是路由实例：它内部有大量字段，但根本不该被序列化发给客户端。如果默认所有 ref/reactive 都水合，这类对象就会被 stringify 进载荷，发到浏览器，既浪费带宽又会把不该暴露的内部句柄泄出去。

pinia 提供一对 API 解决这个：`skipHydrate(obj)` 给对象打一个不可枚举的 symbol 标记，`shouldHydrate(obj)` 反向判断。装配时遍历每个 state 容器，发现被标记的就跳过水合、也不注册回根。

换来的是把路由实例、第三方有状态对象安全放进 setup store 而不被序列化的能力。代价是「声明权」交给使用者——你得主动给这类非状态对象打标记，漏打就会触发序列化。本质矛盾是「**响应式容器表面同质**（都是 ref/reactive）**而水合需求异质**（有的是数据、有的是句柄）」：光看类型看不出谁是数据、谁是句柄，必须靠显式标记区分。

### option store 留一个可选的自定义水合钩子当逃生口

option store 因 state 形状已知、天然从根取值，绝大多数情况不需要任何特殊处理。但有一类边角：state 用了 `customRef`、`computed`，或用了「服务端值 ≠ 客户端值」的响应式（如 `useLocalStorage`）——这种情况下，光靠「从根取值」无法把入站状态对齐到这类特殊响应式上。

pinia 给 option store 留了 `options.hydrate(store.$state, initialState)` 钩子当逃生口，让开发者手动把入站值灌进特殊响应式。换来的是「特殊响应式在 option store 里也能精确对齐」，代价是这个钩子仅 option store 可用——setup store 因默认逐 key 灌值机制已覆盖大部分情况，特殊响应式需自行处理。

本质矛盾是「**默认水合路径普适** vs. **少数响应式需要特殊对齐**」：默认机制想保持简单，又得给边角情况留口子，逃生钩子就是这个口子。

## 5. 最小原理演示

下面的代码只用极简的 `{ value }` 模拟 ref、用普通对象模拟根状态，演透三件事：(a) 一个根对象就是全部契约；(b) 给定入站状态和 setup 函数返回的若干 state 容器，装配时按 key 把入站值灌进每个容器；(c) 被标记为「跳过水合」的对象不参与灌值。

```ts
// 用极简 { value } 模拟 ref，演透「按 key 灌值」，不演响应式本身
type Box<T> = { value: T }
const box = <T>(v: T): Box<T> => ({ value: v })
const isBox = (v: any): v is Box<any> =>
  v && typeof v === 'object' && 'value' in v

// 跳过水合的标记：给对象挂一个不可枚举的 symbol
const SKIP = Symbol('skip')
function skipHydrate<T>(obj: T): T {
  Object.defineProperty(obj, SKIP, {})
  return obj
}
function shouldHydrate(obj: any) {
  return !obj || typeof obj !== 'object' || !(SKIP in obj)
}

// 一个根对象 = 全部 SSR 契约
type Root = Record<string, Record<string, any>>

// 服务端：跑完所有 store 后，把根对象序列化发往客户端
function serialize(root: Root): string {
  return JSON.stringify(root)
}

// 客户端：把载荷整体回填进根对象
function hydrateRoot(payload: string): Root {
  return JSON.parse(payload)
}

// setup store 装配：给定 id、setup 函数、根对象，按 key 把入站值灌进每个 state 容器
function assemble<SS extends Record<string, any>>(
  id: string,
  setup: () => SS,
  root: Root
): SS {
  // 读「根里已有的入站状态」——非空说明处于水合场景
  const incoming = root[id]
  // 占位：setup store 装配前先在根里挂个空对象，准备接住反向注册
  if (!incoming) root[id] = {}

  const store = setup()
  for (const key in store) {
    const prop = store[key]
    // 只处理 state 容器（演示里用 Box 模拟 ref），跳过 action/getter
    if (!isBox(prop)) continue

    if (incoming && shouldHydrate(prop.value)) {
      // 集合先清空再赋，换与 $patch 一致的覆盖语义，不与服务端值混
      if (prop.value instanceof Set || prop.value instanceof Map) {
        prop.value.clear()
      }
      prop.value = incoming[key]
    }
    // 反向注册：把容器写回根对象，保持根与 store 双向同步
    root[id][key] = prop.value
  }
  return store
}
```

这份演示只演核心思想，故意省略了真正的响应式、effectScope 托管、reactive 包装、option store 的自定义水合钩子、$patch 暂停监听、devtools。

## 6. 执行轨迹

拿一个具体输入走一遍。服务端定义一个购物车 store：

```ts
const useCart = defineStore('cart', () => {
  const count = box(0)
  const items = box([] as string[])
  return { count, items }
})
```

某个请求里 `count` 被改成 3。服务端渲染结束后，根对象变成：

```
root = { cart: { count: 3, items: [] } }
```

`serialize(root)` 把它转成 JSON 载荷塞进 HTML。浏览器拿到 HTML 后，先 `hydrateRoot(payload)` 把同一个根对象重建出来。

接着页面里某处首次调用 `useCart()`，触发装配：

1. `incoming = root['cart']`，读到 `{ count: 3, items: [] }`，非空，处于水合场景。
2. 跑 setup 函数，拿到 `{ count: box(0), items: box([]) }`——注意这里 count 的默认值是 0。
3. 遍历 store：
   - `count` 是 box，`shouldHydrate(0)` 返回 true，把 `box.value` 从 0 改成 3。
   - `items` 是 box，`shouldHydrate([])` 返回 true，集合先 clear（空数组无操作），赋值 `[]`。
4. 反向注册：`root['cart']['count'] = 3`、`root['cart']['items'] = []`。
5. store 返回时，`count` 读出来就是 3，与服务端渲染的 HTML 完全一致，无水合不匹配。

如果 setup 里多返回了一个路由实例（被 `skipHydrate` 标记过），第 3 步遍历到它时 `shouldHydrate` 返回 false，跳过灌值、也不注册回根——它就不会出现在序列化载荷里。

## 7. 教学简化说明

本章演示故意省略了：真正的 ref/reactive 实现、effectScope 托管、reactive 整体包装、option store 的自定义水合钩子分支、$patch 暂停监听批处理、devtools 时间线、真正的 HTML 载荷传输（这部分由 Vue SSR 或 Nuxt 完成）。这里只演透「一个根对象即契约 + 按 key 拆还」的核心思想。

## 8. 小结

SSR 的全部契约就是那一个根状态对象：序列化它、回填它，跨网络的状态搬移就完成了。setup store 因为 state 命令式创建，多了一段「逐 key 灌值」的胶水，并用 skipHydrate 标记路由实例这类非状态对象跳过水合；option store 因为 state 形状已知，天然从根取值，只给特殊响应式留了个可选钩子。这套契约的下一站是框架级集成——下一章会看 Nuxt 模块怎么把这套序列化与回填自动化：在 app:rendered 钩子里序列化 state 到 payload、在客户端从 payload 回填 state。