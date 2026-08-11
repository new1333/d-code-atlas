# URL ↔ 状态双向绑定

> 本章属于 composite 层。前置：过滤器与搜索：声明式 schema + 字段 DSL。
> 学完你能：用一句话讲清"为什么 URL 和状态要双向锁死、双向必然震荡怎么破、什么变化该进历史什么变化只该静默替换"。

## 1. 为什么需要它

上一章把 rawPayload 按筛选条件逐级缩小成 main → excluded → available → filtered 四层 computed Payload，筛选条件改一下，整张图瞬时跟着变。但留了一个口子没补：**筛选条件本身存在哪里**？默认情况下它们存内存里，一刷新页面就全没了。如果你调好一组筛选、点开某个包，想把当前视图分享给同事，或者自己刷新一下、按一下后退键还希望看到一模一样的画面，单靠内存里的 reactive 对象做不到。

办法看起来很直接：把这些状态写进 URL。可一旦真这么做，立刻撞上一个矛盾——

状态来源必须**单一**才不会自相矛盾。如果"内存里的 reactive 对象"和"URL"是两份独立数据，刷新时以谁为准？用户改 URL 时怎么让内存跟上？用户在 UI 里勾选时怎么让 URL 跟上？只要有两份数据，就有自相矛盾的可能。

本章的设计立场是：**URL 是唯一真源**，内存对象只是它的一份易用副本。所有读写最终都收敛到 URL 上，刷新/分享/后退用的都是同一份 URL，矛盾自然消失。

## 2. 核心思想

把整个 UI 状态对象当成 `location.hash` 的"内存镜像"，用两条方向相反的监听把双方锁死，任意一边变了，另一边就跟上。

听起来简单，难的是"任意一边变了"——你立刻会陷入"我改了 A 通知 B、B 又改了通知 A"的无限回环。本章后面大半篇幅都在讲：怎么让两条监听互相"消音"，以及哪些变化该当作"翻新一页"记进浏览器历史、哪些只该原地静默替换。

## 3. 心智模型

先看那个内存状态对象长什么样。它是一个 plain reactive 容器，固定 8 个键：选中的节点规格、要安装的输入、维护者操作面板的一组开关（全选/排序/是否带 publint/是否只看最新）、维护者作者筛选、当前激活的 action。所有键都是字符串（数组压成 `+` 连接），刻意扁平化，这样 URL 才友好。

URL 这一侧，键名走 kebab-case（`selected-action`），内存里走 camelCase（`selectedAction`），两条小正则互镜像。数组写时用 `+` 连接，读时同时支持 `,` 和 `+`（URL 里 `+` 是空格的标准编码，又对人眼可读）。

启动期做三件事：从 `location.hash` 反序列化出状态对象（kebab 转 camel）；按 schema 拆开（数组切分、`'true'` 还原成布尔）写回筛选器集合；装上三条运行期监听。

运行期是三条监听在撑：

- **状态 → URL**：内存里任何字段变了，序列化进 hash。
- **URL → 状态**：浏览器前进/后退、外部链接跳进来，hash 变了，反序列化回写状态。
- **筛选器集合 → 状态对象**：用 200ms 防抖聚合，让连续勾选不会每次都打 URL。

还有一条小规则：**默认值不写进 URL**。值等于默认时序列化成 `undefined`，键直接缺席。这让 URL 短小、可读、对比友好。代价是默认值在配置里一改，旧链接的语义会跟着"漂"（链接没显式记原默认）。

## 4. 关键权衡

### 给每条同步边装"消音器"

这是整套机制的心脏。

**选择**：在自身触发的回写里包一层忽略器，让反方向监听在这一轮暂时"失忆"。
**换来**：状态→URL→状态、URL→状态→URL 不形成无限回环，同步只走一轮就停。
**代价**：开发调试时日志会断片。你在控制台打 query 的 watch 触发，但部分更新被静默吞掉了，看不到完整因果链；要复现 bug 时得手动模拟"忽略器"语义。

**本质矛盾**：双向监听要求"任一端变化都自动同步到对端"，可"自动同步到对端"这个动作本身就会触发对端的反向监听，从而再次同步回来。这是所有双向绑定的结构性宿命。消音器把"我主动写"和"我被同步写"两个事件区分开——前者要触发对端，后者要静默。任何双向绑定场景（前端表单 vs 数据模型、IDE 设置 vs 配置文件、文档编辑器 vs 撤销栈）都逃不开这个模式。

### 选中节点也走 URL

通常 URL 只装筛选条件（哪些复选框勾了、搜了什么词）。本章选择把"我点了哪个包"也序列化进 URL——用包规格字符串 `name@version` 承载。

**选择**：让"选中哪个节点"和筛选条件一起进 URL。
**换来**：链接可以表达"打开这个工具，过滤出 MIT 包，并选中 lodash@4.17.21"——一个完整的视图快照。同事点开链接就能看到和你一模一样的画面。
**代价**：反向解析时要拿规格字符串去当前数据集里查节点。如果该包不在当前数据集中（版本漂移、卸载、跑的是另一个 monorepo），就查不到，链接"半失效"——不报错，但选中态变空。用户看到"链接像是有效，但没选中任何东西"，比直接报错更难诊断。

**本质矛盾**：状态的可分享性 vs 数据集是会变的。链接是"快照"，但被快照的"指针"指向一个会变化的目标。这是个无解矛盾，本章选择"宁可半失效也要可分享"。

### 导航语义二分：push 还是 replace

这是这套机制最容易被写错、也最精巧的一处。

**选择**：监听 `() => [query, query.selected]` 这个二元组，回调里对比新旧 selected——只有"选中项"变化才算"导航事件"，走 `router.push` 产生一条历史条目；其它变化（纯筛选/开关）走 `history.replaceState` 原地替换。
**换来**：浏览器后退键的语义符合直觉。用户点开一个包，按后退回到"还没点这个包"的视图（筛选条件仍在）；再后退才回到"还没勾 license:MIT"的视图。如果反过来把每次筛选都 push，后退键就会变成"逐个撤销复选框"，每按一次只撤一个勾，体验崩溃。
**代价**：开发者必须显式区分"哪种状态变化算导航"。实现上把"选中项"在监听列表里单列出来对比新旧，逻辑不复杂，但任何新增"算导航的状态字段"都得改这条 watch，是个隐式扩展点。

**本质矛盾**：URL 必须承载全部状态（保证分享/刷新一致）vs 浏览器历史栈要符合"后退一步 = 回到上一个动作"的人体直觉。两个目标对"什么算一步"的定义不同——URL 视角下任何状态变化都是"一步"，但人脑把"切换选中"视为一个动作、把"调一组筛选"视为另一个动作。push/replace 二分就是把这两个"步"切开。

### 筛选→URL 用防抖、URL→筛选立即

**选择**：筛选状态变化后等 200ms 才回写 URL；URL→筛选方向立即生效。
**换来**：用户连续勾选复选框、拖滑块、敲键盘搜索时，不会每次击键都触发 `history.replaceState`，避免性能浪费和地址栏抖动。
**代价**：URL 短暂滞后于内存状态，最多 200ms。在这 200ms 里复制链接，可能拿到旧 URL。

**本质矛盾**：交互层的高频变化 vs URL 写入有性能/视觉成本。防抖用"延迟聚合"换"低频写入"，是经典的去抖动模式。但放在双向同步里要小心：防抖只装在"筛选→URL"这条边，反向不装，否则用户按后退键后还要等 200ms 才看到画面变化，体验崩坏。

## 5. 最小原理演示

下面的演示只演两条核心原理：**消音器**和 **push/replace 二分**。其它细节（kebab/camel 转换、schema 驱动、防抖、规格反查节点）都故意省略，避免喧宾夺主。这段代码可以直接粘到浏览器 console 里跑：

```ts
// 内存状态：用 Proxy 让每次赋值都触发同步（Vue reactive 的最小等价）
const state = new Proxy({ selected: '', license: '' }, {
  set(t, k, v) { (t as any)[k] = v; if (!isInternal) syncToUrl(); return true },
})

// 模拟浏览器历史栈
const stack: string[] = []
let cursor = -1
function push(h: string)    { stack.splice(cursor + 1); stack.push(h); cursor++ }
function replace(h: string) { if (cursor === -1) push(h); else stack[cursor] = h }

// 消音器：本轮主动赋值时置 true，让反向监听跳过
let isInternal = false
let lastSelected = state.selected

// 状态 → URL
function syncToUrl() {
  const hash = `#selected=${state.selected}&license=${state.license}`
  if (state.selected !== lastSelected) push(hash)     // 选中变了 → 进新历史条目
  else                                  replace(hash) // 纯筛选变化 → 原地静默替换
  lastSelected = state.selected

  isInternal = true                                   // 主动写了 URL，本轮静默反向监听
  location.hash = hash
  setTimeout(() => { isInternal = false })
}

// URL → 状态（浏览器前进/后退、外部链接）
window.addEventListener('hashchange', () => {
  if (isInternal) return                              // 消音器命中，本轮跳过
  const params = new URLSearchParams(location.hash.slice(1))
  isInternal = true                                   // 反向赋值同样要静默，避免再触发 syncToUrl
  state.selected = params.get('selected') ?? ''
  state.license  = params.get('license')  ?? ''
  setTimeout(() => { isInternal = false })
})
```

不到 30 行落了两条原理：

- **消音器**：`isInternal` 标志位。任何主动写——不管是状态写 URL、还是 URL 反向写状态——都先置 true，本轮反向监听跳过；下个 tick 复位。
- **push/replace 二分**：对比 `state.selected` 的旧值，变了 push，没变 replace。

你可以手动跑这两个场景验证：

```ts
// 场景 A：用户勾选 license=MIT，紧接着点节点
state.license = 'MIT'                  // → replace（selected 没变）
state.selected = 'lodash@4.17.21'      // → push（selected 变了）

// 场景 B：模拟浏览器后退到上一条历史
location.hash = '#selected=&license=MIT'
// hashchange 触发 → 反序列化回写 state.selected = '' → 消音器防止再次 syncToUrl
// 视图回到"还没点这个包"，但 license=MIT 仍在
```

## 6. 执行轨迹

把上面的演示代入真实场景。

**输入 1**：用户在筛选面板里勾选 `license:MIT`。

1. 内存筛选器对象更新（`filters.license = ['MIT']`）。
2. 200ms 防抖定时器启动——这一刻 URL 还没变。
3. 200ms 到，`filtersToQuery` 把 filters 序列化进 `query`（数组用 `+` 连接、默认值省略成 `undefined`）。
4. `query` 那条 watch 触发，对比新旧 selected——相等，走 `history.replaceState`。
5. URL 静默替换为 `#license=MIT`，地址栏变化但不产生新历史条目。

**输入 2**：用户紧接着点击某个包节点。

1. 包的规格字符串 `lodash@4.17.21` 被赋给 `query.selected`。
2. watch 触发，对比新旧 selected——不等，走 `router.push`。
3. 浏览器历史栈多一条：`#selected=lodash@4.17.21&license=MIT`。

**输出**：用户按浏览器后退键。

hash 变回 `#license=MIT`（上一条历史）。hashchange 触发反向 watch，在 `ignoreUpdates` 里反序列化回写 `query.selected = ''`。因为包了忽略器，本轮回写不会触发"query→hash"那条 watch 再写一次 URL，回环被切断。视图回到"还没点这个包"的状态，但 license=MIT 筛选仍在。

再按一次后退：hash 变回最初始的空状态，license=MIT 也撤掉。整套语义符合"后退一步 = 回到上一个动作"——切换选中算一步，调一组筛选算另一步。

## 7. 教学简化说明

本章演示故意省略了这些：

- **kebab/camel 案式互转**：两条小正则，字符层细节，与双向同步原理无关。
- **schema 驱动的字段迭代**：真实代码用一份 `FILTERS_SCHEMA` 元数据驱动序列化（按字段类型分 split / `=== 'true'` / 原值），新增筛选维度时 URL 序列化是自动的。演示里写死字段，省掉这层。
- **200ms 防抖**：真实代码用 `debouncedWatch` 把"筛选→URL"那条边防抖；演示里去掉防抖以突出主线（消音器 + push/replace）。
- **规格字符串反查节点对象**：选中态从 URL 反序列化回来后，要去主载荷 Map 里查 `name@version` 对应的节点对象——这是消费侧逻辑，与绑定机制本身无关。

另外，设置类偏好（侧栏折叠、配色、徽章开关）**故意不走 URL**，而走 `localStorage`——那是"个人长期偏好通道"，与"可分享视图"正交，本章不展开。

## 8. 小结

把 URL 当唯一真源、把内存状态当它的一份易用副本——"状态存在哪"这个看似工程的小决定，做成了"刷新/分享/后退"三种用户行为都收敛到同一处的设计选择。这一章把"状态搬到 URL"做完整了：双向监听 + 消音器让同步只走一轮不回环，push/replace 二分让后退键符合人体直觉。

下一章换到完全不同的方向：当状态要跨进程同步（前端 ↔ 后端 node 服务）时，怎么把同一份 handler 函数适配到 websocket / 静态 dump / MCP 三种传输上。