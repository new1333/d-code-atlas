---
title: 全局共享状态容器
---

# 全局共享状态容器

想象你在写一个 VSCode 扩展：左侧侧边栏显示知乎热榜，用户点一条，弹出一个详情面板；面板背后还跑着一台真实 Chrome，专门对付反爬。这时候投票命令得知道「票投给哪个面板」，评论加载得知道「拉的是哪篇文章的评论」，浏览器得知道「我服务的页面是哪个」。一句话——一堆互不相识的模块，得能找到彼此。

最朴素的解法是把构造函数当成快递员，把面板、浏览器、凭证一层层往下传。但你马上会被淹没：每加一个子系统就要改一串构造签名，命令注册表会膨胀成一个臃肿的依赖注入容器。

本章要讲的是另一个极端——**把扩展全生命周期的资源和数据都挂在一个模块级导出的可变对象上，谁需要谁 `import`**。

## 一、最底层的那块：模块级可变单例

如果你写过 Node，应该熟悉这个事实：CommonJS/ESM 模块只会被加载一次。所以一个 `export const Store = { ... }` 的对象，全工程任何地方 `import` 拿到的都是**同一个引用**。一处写，处处可见。

这就够了。我们不需要什么花哨的依赖注入框架。给读者一个类比：**全局单例对象就像办公室里的一块公共留言板**——谁有事就贴一张，谁要查就去翻，你不用记每个人坐在哪、也不用找快递员，认得那块板子就行。

最小骨架长这样：

```ts
// store.ts —— 整个章节的地基就这一行
export const Store = {
  context: null as null | { extensionUri: string },     // 宿主给的上下文槽位
  webviewMap: new Map<string, { id: string; reveal(): void; close(): void }>(),
  browserInstance: null as null | { close(): Promise<void> },
  pagesInstance: new Map<string, { isClosed: boolean; close(): void }>(),
  cookie: "",
}
```

注意所有字段都允许 `null` 或为空——这是因为「扩展还没被宿主激活」时容器是全空的。激活那一刻，容器从「全空」变成「有上下文」，后续所有要用 `extensionUri` 的地方都从这里取。

说人话就是：**容器是个永远在那儿的盒子，里面装的东西随时间变化，谁需要谁来翻。**

## 二、零依赖注入的跨模块通信

接下来看「A 模块写、B 模块读」这件事在容器里有多自然。

```ts
// activate.ts —— 扩展激活时，宿主把上下文递进来
import { Store } from "./store"

export function activate(context: { extensionUri: string }) {
  Store.context = context          // 这是全书唯一一处给 context 槽位赋值的地方
  // ...注册命令、起侧边栏
}
```

```ts
// openWebview.ts —— 用户点开一篇文章
import { Store } from "./store"

let seq = 0

export function openWebview(articleId: string, sort: string) {
  // 用「文章 id + 排序类型」组合成会话 key
  const webviewId = `${articleId}#${sort}`

  // 关键：先查会话表，命中就激活既有面板，未命中才新建
  const existing = Store.webviewMap.get(webviewId)
  if (existing) {
    existing.reveal()
    return existing
  }

  // 这里要用非空断言：依赖「activate 已先执行」这一隐式契约
  const resourceRoot = Store.context!.extensionUri

  const panel = {
    id: webviewId,
    reveal: () => console.log(`[panel] reveal ${webviewId}`),
    close:  () => console.log(`[panel] close ${webviewId}`),
  }
  Store.webviewMap.set(webviewId, panel)
  // 顺便为这个面板开一个浏览器页面，同一个 key 关联
  Store.pagesInstance.set(webviewId, { isClosed: false, close() {} })
  return panel
}
```

注意上面这段代码没有任何参数注入。`openWebview` 不知道、也不需要知道浏览器实例由谁创建、面板被谁管理——它只认那个 `Store`。**这就是「零胶水通信」的字面意思**：模块之间不靠函数签名打招呼，靠的是大家共同认得那块留言板。

命令注册表因此变得很瘦。它只往命令回调里注入「我是给哪个 webviewId 用的」这种轻量标识，**不**注入面板实例、**不**注入浏览器——它们都靠容器按 id 取。

## 三、异步流程里的防御性判空

到目前为止一切美好。但容器是全局可变的，这就带来一个直接后果：**你刚读到的状态，下一行 await 完可能就没了。**

```ts
// vote.ts —— 异步命令处理
import { Store } from "./store"

export async function vote(webviewId: string, up: boolean) {
  const item = Store.webviewMap.get(webviewId)
  if (!item) return                  // 判空 1：取到就要查

  await fetch("/api/vote", { method: "POST" })   // 假装是个网络请求

  // 判空 2：await 期间，这个 id 可能已被别处删了
  if (!Store.webviewMap.has(webviewId)) {
    console.log(`[vote] ${webviewId} 已经不在容器里，放弃`)
    return
  }

  console.log(`[vote] ${up ? "赞" : "踩"} → ${item.id}`)
}
```

两处判空不是多虑，而是全局可变状态的必然要求。**这就是「换来零 DI」要付的代价：函数签名骗你**——光看 `vote(webviewId, up)` 你以为它只依赖参数，其实它暗戳戳依赖了 `Store.webviewMap` 这一全局状态，且这个状态在异步流程中随时可能被别的代码路径修改。

把整段串起来跑一次：

```ts
import { Store } from "./store"
import { activate } from "./activate"
import { openWebview } from "./openWebview"
import { vote } from "./vote"

activate({ extensionUri: "fake-uri" })

const a1 = openWebview("article-A", "hot")     // 新建面板
const a2 = openWebview("article-A", "hot")     // 命中复用
console.log(a1 === a2)                          // true

vote("article-A#hot", true)                    // 触发一次异步投票

// 模拟用户在 vote 的 await 期间关掉面板
setTimeout(() => Store.webviewMap.delete("article-A#hot"), 20)

setTimeout(() => vote("article-A#hot", false), 60)
// 输出：[vote] article-A#hot 已经不在容器里，放弃
```

如果你把第二处判空删掉，第二次 vote 会拿到一个仍然有值的 `item`，但实际面板已经关了，操作会指向一个幽灵对象。这就是为什么我说判空不是多虑。

## 四、两套生命周期没同步——孤儿对账器

你也许注意到了：上面打开文章时，`webviewMap` 和 `pagesInstance` 是**同 key 双写**的。这带来一个便利——同一篇文章可以按 id 直接复用，不用重新建页面。

但代价随之而来：**面板关闭和浏览器页面关闭是两件事，没有任何机制保证同时发生。** 用户关掉面板时，我们只删了 `webviewMap` 里的条目，对应的浏览器页面会留在 `pagesInstance` 里——成了孤儿。

补救办法是写一个对账器，定期扫一遍：

```ts
// reconcile.ts
import { Store } from "./store"

export function reconcileOrphanedPages() {
  const orphanedKeys: string[] = []
  for (const [key, page] of Store.pagesInstance.entries()) {
    if (!Store.webviewMap.has(key)) {              // 页面还在，但对应面板已没了
      if (!page.isClosed) orphanedKeys.push(key)
      else Store.pagesInstance.delete(key)         // 已关的顺手删引用
    }
  }
  for (const key of orphanedKeys) {
    Store.pagesInstance.get(key)?.close()
    Store.pagesInstance.delete(key)
    console.log(`[reconcile] 关掉孤儿页面 ${key}`)
  }
  return orphanedKeys.length
}
```

这个对账器说白了就是为了擦「两套生命周期不同步」的屁股。它本身是个事后补丁——你从代码注释里能看出「防止资源泄漏」这个动机会迟到，但不会缺席。

## 五、统一收尾：把所有清理串成一个清单

最后是停用时的清理。最自然的写法是各处各自 `dispose`，但那样顺序不可控——浏览器先关了，面板还在试着用浏览器取数据，就崩了。

所以本章选择**集中一个收尾函数串行清理全部资源**：

```ts
// cleanup.ts
import { Store } from "./store"

export async function cleanup() {
  // 1. 先关所有面板（顺序很重要：面板可能还在用浏览器）
  for (const item of Store.webviewMap.values()) {
    try { item.close() } catch (e) { console.log("面板关闭失败", e) }
  }
  Store.webviewMap.clear()

  // 2. 关浏览器
  try { await Store.browserInstance?.close() } catch (e) { console.log("浏览器关闭失败", e) }
  Store.browserInstance = null

  // 3. 清其余槽位——每段独立 try/catch，一处失败不拖垮其余
  Store.pagesInstance.clear()
  Store.cookie = ""
  Store.context = null
}
```

注意每段清理单独 `try/catch`——如果面板关失败，浏览器还是得关，不能一个错把整个清理链拖崩。

## 六、关键权衡

到这里原理就讲完了。但「学原理」的真正价值在于看清楚每次选择换来什么、又付了什么。本章有三条值得记的权衡。

### 权衡一：选模块级可变单例（而非构造注入）

- **换来**：任何模块 `import` 即可读写全局状态，命令注册表只注入门面（provider 引用），不注入实例本身。新增子系统时不用改任何构造签名。
- **代价**：隐式耦合。从 `vote(webviewId, up)` 这个签名你看不出它依赖了谁、依赖了什么状态；而且全局可变意味着异步流程中状态随时可能被别处清空，每个消费者都得在取值后立刻防御「可能已不存在」（见第三节的两处判空）。

这条权衡是本章的灵魂。说白了——**省下的胶水代码，变成了散落在每个消费者里的防御代码**。账没消失，只是换了个地方付。

### 权衡二：选「面板与浏览器页面同 key 双写映射表」

- **换来**：「同一篇文章按 id 直取实例」的便利——重复打开直接 `reveal()`，不用重建；面板身份（文章 id + 排序 + 来源类型）显式编码进 key，不同排序各自独立成面板，语义清晰。
- **代价**：两套生命周期没有同步保证。面板关闭只是从 `webviewMap` 删一行，对应的浏览器页面没人管。必须额外写一个对账器（第四节）去扫「页面还在但面板已没了」的孤儿，否则会泄漏。

这条权衡揭示了一个普遍规律：**用一个 key 把两个生命周期绑在一起读写很方便，但只要它们的「死亡时机」不同，就得有对账机制兜底。**

### 权衡三：选集中一个收尾函数串行清理

- **换来**：停用时一个入口收尾、清理顺序可控（先关面板再关浏览器），逻辑可读、可调试。
- **代价**：清理函数本身变成一个易遗漏的清单。新增一类资源（比如以后加一个 WebSocket 连接池），就得记得在 `cleanup()` 里补一行；而且每段清理都要单独 `try/catch`，否则一类失败会拖垮其余清理。

这条权衡是「全局可变状态」这种设计的天然延伸——既然所有资源都挂在一个对象上，那收尾也理应集中处理。代价就是这个清单要靠纪律维护，没有类型系统能帮你检查「是不是所有槽位都清了」。

## 七、心智模型总结

把上面所有内容压成一条执行轨迹：

1. **激活**：宿主递上下文 → `Store.context = context`，容器从「全空」变成「有上下文」。
2. **去重复用**：打开文章算出 id → 查 `webviewMap` → 命中 `reveal()`，未命中才新建并写入。
3. **零 DI 通信**：命令回调凭 id 去容器取实例，**不**接收任何实例参数。
4. **异步防御**：取到立刻判空，await 后再判一次。
5. **一处写入全局生效**：凭证、各列表数据同理，一处清洗/写入，全局各处读到的都是最新值。
6. **停用收尾**：`cleanup()` 按「面板 → 各列表 → 浏览器 → 上下文」逐个清空回全空态。
7. **对账兜底**：定期跑对账器，关掉孤儿浏览器页面。

记住这条轨迹，你就记住了本章的全部原理。

---

本章是全书的地基。后续每一章——浏览器引擎、侧边栏列表、详情爬取、命令编排——都会把自己要用的实例或数据挂在这个容器的某个具体字段上。它们用的是**字段**，而「**为什么用一个全局可变单例来当容器**」这一原理，只在本章讲透。

下一章我们会走到容器里的另一个字段——`cookie` 字符串。知乎反爬严苛，Cookie 不是抓下来就能用：得先清洗掉第三方统计项，再校验关键的安全签名，去掉会被重定向的 BEC，还要用 DOM 登录墙探测反向判断它是否已失效。这就是「Cookie 凭证的清洗与校验」要做的事。
