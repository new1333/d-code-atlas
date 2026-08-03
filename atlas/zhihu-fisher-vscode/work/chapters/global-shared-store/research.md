# 全局共享状态容器 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个 VSCode 扩展同时跑着侧边栏列表、若干详情面板、一台反爬浏览器、若干被打开的浏览器页面、状态栏项——它们之间要互相找彼此（点开详情要知道点的是哪条、投票命令要知道改的是哪个面板、浏览器要知道为哪个面板服务）。如果靠构造函数逐层把实例传来传去，命令注册表会变成一个臃肿的依赖注入容器，每加一个子系统就要改一串构造签名。使用者（开发者）会被这种胶水代码淹没。

- **一句话核心思想**：**把扩展全生命周期的资源和数据都挂在一个模块级导出的可变单例对象上，谁需要谁 import**。

- **设计动机（为什么需要它）**：是为了解决「多个独立战线（命令处理、侧边栏 provider、详情面板）要共享同一份运行时实例与业务数据，但又不想引入正式依赖注入框架」这个矛盾；它换来的是任何模块 import 即可读写全局状态、零胶水代码。本章是全书地基章之一（无前置依赖），后续至少 6 章（防反爬浏览器引擎、侧边栏列表、详情爬取、详情渲染、智能伪装、命令编排）都把各自要用的实例/数据挂在这个容器上——但它们用的是容器的**某个具体字段**，而「**为什么用一个全局可变单例来当容器**」这一原理**只在本章讲透**，后续章节只看它的新侧面，Writer 不必重讲容器本身。

- **关键权衡（本 Atlas 的核心）**：
  1. **选模块级可变单例（而非把实例逐层传参/构造注入）→ 换来任何模块 import 即可读写全局状态、命令注册表只注入门面不注入实例 → 代价是隐式耦合**：消费者从函数签名看不出它依赖了谁、依赖了什么状态；而且全局可变意味着异步流程中状态随时可能被别处清空，每个消费者都得在取值后立刻防御「可能已不存在」。
  2. **选「把面板实例与浏览器页面实例都收进按同一 id 关联的映射表」（而非让面板自己持有页面）→ 换来「同一篇文章去重复用、按 id 直取实例」的便利 → 代价是两套生命周期没有同步保证**：面板关闭和浏览器页面关闭是两件事，没有任何机制保证同时发生，于是必须额外手写一个对账器去扫描「页面还在但面板已没了」的孤儿实例来防泄漏。
  3. **选集中一个收尾函数串行清理全部资源（而非每处各自 dispose）→ 换来停用时一个入口收尾、清理顺序可控（先关面板再关浏览器）→ 代价是清理函数本身变成一个易遗漏的清单**：新增一类资源就得记得补一行清空，且每段清理都要单独 try/catch，否则一类失败会拖垮其余清理。

- **最小心智模型（3～7 步）**：
  1. 扩展激活时，把宿主给的上下文写进全局容器的某个槽位（容器此刻从「全空」变成「有上下文」）。
  2. 侧边栏 provider、命令组只通过参数拿到彼此的引用，**不**拿到面板/浏览器实例——它们靠 import 全局容器去取。
  3. 用户打开一篇文章：算出一个唯一 id，先去容器的会话表里查；命中就激活既有面板返回，未命中才新建并塞进表。
  4. 后续动作（投票、评论、导航、刷新凭证）都凭同一个 id 去「会话表里取当前实例」再操作——取不到就提前返回。
  5. 凭证、各列表数据同理：一处清洗/写入，全局各处读到的都是最新值。
  6. 扩展停用时，收尾函数按「先关面板→清各表→关浏览器→清上下文」的顺序逐个清空容器所有槽位。
  7. 此外还要定期跑对账器：扫出「浏览器页面还在但面板已没了」的孤儿页面关掉。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达「全局可变单例容器」核心思想**的从零实现（约 40 行）。它要演透三件事——(a) A 模块往容器写、B 模块 import 后直接读到（零 DI）；(b) 用 id 查会话表命中即复用、未命中才新建；(c) 异步流程中容器项被删后，消费者必须防御性判空；外加 (d) 一个 `cleanup()` 逐个清空所有槽位、一个对账器扫孤儿。**每一行都要对应上面某条权衡**（写即「换来零 DI」、判空即「代价隐式耦合」、对账器即「代价生命周期不同步」）。
  - 应故意省略：真实的 VSCode Panel API、真实的 Puppeteer、完整业务字段（只留「会话表 + 浏览器占位」即可）、类型系统的完整泛型、错误重试、调试日志。
  - **演示载体建议（Writer 据此执行）**：本仓库主语言是 TypeScript（VSCode 扩展）。建议写成一段**能 `bun run`/`node`/`ts-node` 直接跑的独立 TS 脚本**——把宿主对象替换成普通 JS 对象（用一个 `{ extensionUri: "fake" }` 模拟上下文、一个带 `close()` 的普通对象模拟浏览器）即可，**不强求真跑扩展宿主**。理由：本章机制是纯语言层的「模块单例 + 映射表」，与 VSCode 运行时无关，独立脚本足以演透原理，且读者可亲手改「删掉某个判空」观察崩溃。

- **正文不宜展开的细节**：`ContentStore` 类型里收藏夹那套两级分页 + 刷新状态字段（属于「收藏夹树形缓存」章的业务面，本章只当它是容器里的一条数据）；侧边栏伪装、状态栏映射的具体用法（各有专章）；面板失焦触发的伪装联动时序（属「智能伪装引擎」章）；`WebViewItem` 内部的批次加载配置（属详情爬取章）。

- **推荐的一个执行轨迹例子**：
  - 输入：扩展被宿主激活，宿主传入上下文对象。
  - 关键中间态：上下文写进容器槽位 → 用户打开文章 A，会话表 `{ A → panelA }` → 用户再点 A，命中复用（激活既有面板）→ 投票命令凭 id 从会话表取到 panelA 直接操作（未接收任何实例参数）→ 用户关掉 A 的面板，会话表删 A → 对账器发现 A 对应的浏览器页面仍在，关掉它。
  - 输出：停用时 `cleanup()` 把会话表/各列表/浏览器/上下文槽位**逐个**清空回全空态。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 容器是一个**模块级 `export const` 可变单例对象**：直接导出对象字面量，所有字段初值为 `null`/空 `Map`/空数组。任何文件 `import` 到的是同一个引用，写一处全局可见。源码位置: src/core/stores.ts:5-51
- 容器的字段可分两类：(1) **资源/实例映射**——扩展上下文、详情面板映射表、浏览器实例、浏览器页面映射表、状态栏映射表；(2) **业务列表数据**——热榜/推荐/关注/搜索四组「列表 + 加载中标志」、收藏夹的列表 + 两套分页 + 刷新状态、以及一个凭证字符串。源码位置: src/core/types/index.ts:5-87
- 「激活时把上下文写进容器」是全书唯一一处给上下文槽位赋值的地方——后续所有要 `extensionUri` 的地方都从这里取，并用非空断言假设它已被写入。源码位置: src/extension.ts:15
- 「去重复用」靠会话表查 id：打开内容前先算唯一 id，命中既有项就 `reveal()` 激活并直接返回，不重复建面板。源码位置: src/core/zhihu/webview/index.ts:72-77
- 「零 DI 通信」的实证：扩展激活时只把 6 个侧边栏 provider 注入命令注册表，**没有**注入任何面板实例或浏览器实例——它们全靠 import 容器、按 id 取实例。源码位置: src/extension.ts:100-107
- 凭证槽位被多处写入（清洗后、校验后、登录成功后、清空时），一处理全局生效；侧边栏列表也会在拿到清洗后的凭证时回写容器。源码位置: src/core/zhihu/cookie/index.ts:21-125、src/core/zhihu/sidebar/hot.ts:159
- 容器被全工程 24 个文件引用，光「从会话表按 id 取实例」这一动作就出现在 webview 模块数十次（投票、评论、导航、滚动、AI 直答、刷新凭证等命令处理的第一行几乎都是它）。源码位置: src/core/zhihu/webview/index.ts（get 调用遍布全文）、html.ts、components/comments.ts、components/related-questions.ts

## 关键调用链

激活与写入：
`activate(context)` → `Store.context = context` → 各 provider/命令组经容器取实例

打开内容（去重复用）：
`openWebview(item)` → `generateUniqueWebViewId(...)` → `webviewMap.get(id)` 命中？→ 命中 `reveal()` 返回 / 未命中 `createWebviewPanel` → `webviewMap.set(id, item)`
源码位置: src/core/zhihu/webview/index.ts:62-77、197

任意命令处理（零 DI）：
命令回调 → `webviewMap.get(webviewId)` → 判空防御 → 操作实例

停用收尾（统一清理）：
`deactivate()` → `ZhihuService.cleanup()` → `closeAllWebviews()` → 逐个 `.clear()`/置 `null`（会话表→各列表→状态栏→浏览器→页面表→上下文）
源码位置: src/extension.ts:111-118、src/core/zhihu/index.ts:27-52

孤儿对账（生命周期不同步的补救）：
`cleanupOrphanedPages()` → 遍历页面表 → 凡 `webviewMap.has(key)` 为 false 的视为孤儿 → 关闭并删引用
源码位置: src/core/zhihu/puppeteer/index.ts:573-590

## 源码摘录（带行号，全文累计 ≤ 30 行）

容器本体（资源映射 + 业务数据骨架，已折叠重复的同构列表）：
```ts
// src/core/stores.ts:5-51
export const Store: ContentStore = {
  context: null,                                 // 扩展上下文槽位：激活前为 null
  webviewMap: new Map<string, WebViewItem>(),    // 详情面板会话表
  browserInstance: null,                         // 反爬浏览器实例槽位
  pagesInstance: new Map<string, Puppeteer.Page>(), // 浏览器页面会话表
  statusBarMap: new Map<string, vscode.StatusBarItem>(),
  Zhihu: {
    hot: { list: [], isLoading: false },         // recommend/follow/search 同构
    search: { list: [], isLoading: false, currentQuery: "" },
    collections: { /* 两套分页 + 刷新状态 */ userInfo: null },
    cookie: "",                                  // 凭证：一处写入，全局可读
  },
};
```

集中收尾清单（停用时逐个清空，每段独立 try/catch 容错）：
```ts
// src/core/zhihu/index.ts:27-52（节选）
static async cleanup() {
  await WebviewManager.closeAllWebviews();
  Store.webviewMap.clear();
  Store.Zhihu.hot.list = []; Store.Zhihu.search.list = [];  // 各列表同理
  Store.statusBarMap.clear();
  await Store.browserInstance?.close();
  Store.browserInstance = null;
  Store.pagesInstance.clear();
  Store.context = null;
}
```

去重复用 + 上下文非空断言（隐式契约：运行时假设 activate 已写入）：
```ts
// src/core/zhihu/webview/index.ts:72-77, 90-92
const existingView = Store.webviewMap.get(webviewId);
if (existingView) { existingView.webviewPanel.reveal(); return; }
// ...
localResourceRoots: [vscode.Uri.joinPath(Store.context!.extensionUri, "resources")],
```

孤儿页面対账器（面板与页面两套生命周期不同步的补救）：
```ts
// src/core/zhihu/puppeteer/index.ts:578-588
for (const [key, page] of Store.pagesInstance.entries()) {
  if (!Store.webviewMap.has(key)) {        // 页面还在，但对应面板已没了
    if (!page.isClosed()) orphanedKeys.push(key);
    else Store.pagesInstance.delete(key);  // 已关的顺手删引用
  }
}
```

## 易混淆 / 边界 / 推断

- 事实：容器对象的字段大多声明为 nullable（`context | null`、`browserInstance | null`），但消费方普遍用非空断言 `!` 或 `?.` 取值——这说明类型系统承认「可能为空」，而运行时靠「activate 已先执行」这一隐式时序契约保证非空。源码位置: src/core/zhihu/webview/index.ts:91
- 事实：异步命令处理中反复出现「取实例后立刻判 `has(id)`/判空再继续」的防御（如多处 `if (!webviewItem.isLoading || !Store.webviewMap.has(webviewId)) return`）——这是全局可变状态带来的直接后果：异步等待期间，该 id 可能已被别处删除。源码位置: src/core/zhihu/webview/index.ts:334、441、1662
- 推断（标注为推断）：作者选择「模块级 const 单例 + 全程可变」而非「一个带 getter/setter 的服务类」，动机应是追求零胶水、让任何工具函数都能直读写——代价（隐式耦合、清理清单、孤儿对账）在后续工程扩张中逐渐显形，从 `cleanupOrphanedPages` 的注释「防止资源泄漏」可反推这是事后补的防护，而非一开始的设计。
- 推断（标注为推断）：会话表按「内容 id + 来源类型 + 排序类型」组合生成唯一 key，目的是让「同一问题不同排序」「同一文章从不同列表打开」各自独立成面板——这是把「面板身份」显式编码进 key，而非依赖面板对象本身。
- 未理解：`retainContextWhenHidden: true`（面板隐藏时保留状态）与「面板可被随时 delete」之间的关系——隐藏 ≠ 关闭，但容器侧只关心是否在表里，具体哪些场景触发 delete（用户手动关 vs 程序关）需结合详情章进一步确认。