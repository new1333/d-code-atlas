# 扩展激活与命令编排

> 本章属于 system 层。前置：侧边栏内容列表、详情页 HTML 渲染与双向消息、扫码登录全流程、收藏夹树形结构与本地缓存、侧边栏伪装成假文件树。
> 学完你能：用一句话讲清一个 VSCode 扩展该在哪里装配对象图、谁来管句柄销毁、为什么命令注册要写成「只回吐不登记」的形态。

## 1. 为什么需要它

上一章讲了用 `setContext` 翻转 context key、把整组知乎侧边栏整体替换成假文件树，换取失焦时的一体伪装。再往前数章，我们造出了五六个能各自独立运行的子系统：列表提供者、详情页 webview、扫码登录、收藏夹树、伪装引擎……每一个都自带状态、自带视图句柄、自带外部资源（浏览器、Cookie、订阅）。

但有一个口子一直没填：**谁来把这些子系统胶合成一个真正能跑的扩展？**

如果不加约束，每个命令就自己去 new 它要用的服务、各自把「用完要回收的句柄」随手塞进某个数组、配置改了各想各的办法刷新——很快「谁创建了什么、谁负责清理什么」就全靠人脑记。停用时必然泄漏：浏览器进程没关、webview 没销毁、命令还挂在宿主上。

我们需要一个统一的「开机接线」与「关机拔线」约定。

## 2. 核心思想

**在唯一的激活入口里把所有对象装配好，再用普通函数参数注入下去；每个命令组只回吐一批「可销毁句柄」，由入口统一登记进宿主**——组合根装配，统一销毁。

## 3. 心智模型

把 `activate` 函数当成一个装机车间。它从宿主那里领到一块叫做「扩展上下文」的板子，板上空空，只有一张空的「可销毁句柄清单」。然后车间按七步把板子装满：

1. 把上下文登记进全局共享容器（第 1 章那个可变单例），让所有子系统都能拿到它。
2. 启动伪装管理器（fire-and-forget，不阻塞激活）。
3. `new` 出核心服务实例，构造时顺带加载已存 Cookie。
4. 逐个 `new` 五个侧边栏数据源，每个都用视图 id 绑定到 TreeView，再把视图句柄回灌给该数据源——数据源后面要靠它刷新视图。
5. 监听配置变更，按外观类 vs 调试类分类响应。
6. 把这些大对象打包成一个「依赖对象」，调用总注册函数。
7. 总注册函数按命令组分发：每个命令组函数只收自己需要的那几个依赖，注册自己的命令，交回一批句柄；总注册函数把这些句柄摊平成一张总清单，统一登记进板子上那张清单。

停用时，宿主遍历板子上那张总清单，把每个句柄的 `dispose()` 调一遍——扩展完全不需要自己记账。

## 4. 关键权衡

### 集中装配换来一眼可读，代价是激活入口必然变胖

> 选择：只在激活入口里 new 对象，其他地方一律靠参数接收。
> 换来：整个对象图集中在一处可读，没有散落在各处的隐式构造。新读者打开 `activate` 函数，几分钟就能看清「这个扩展到底依赖了哪些子系统」。
> 代价：`activate` 入口成了一个知道所有子系统的胖函数。每加一个子系统都要回来改它，而且改动的位置往往就在那段最敏感的装配序列里——碰错一个顺序（比如还没 new 服务就先 new 依赖它的提供者）就会炸。

这条权衡化解的本质矛盾，是**「对象图的可见性」与「修改的局部性」之间的长期拉锯**。集中装配把所有接线收拢到一个函数，让全局依赖图变成一眼可读；代价是任何新增子系统都要侵入这个中枢函数。这是大型应用里反复出现的取舍骨架，你会在很多框架的「启动模块」「composition root」「bootstrap」里看到同一副形状：用一处集中换全局可读，用频繁修改换无隐式构造。

### 命令组只回吐句柄、不碰宿主上下文

> 选择：每个注册函数不接收宿主上下文，只把自己注册得到的句柄装进数组返回，由总注册函数统一登记进宿主。
> 换来：注册函数与宿主解耦——可以脱离宿主单独理解和测试；所有命令享受同一套销毁契约；命令组之间互不干扰。
> 代价：多一道「收集 → 摊平 → 登记」的编排步骤；「返回数组」这个约定略反直觉，新读者第一次看到会想「为什么不直接 push 进 context」。

写出来是这种形状：

```ts
// 命令组：只收依赖、回吐句柄，不碰 context
function registerHotCommands(sidebarHot): Disposable[] {
  const commands: Disposable[] = [];
  commands.push(vscode.commands.registerCommand(...));
  return commands;
}

// 总注册函数：分发依赖 → 收集句柄 → 摊平 → 统一登记
function registerAllCommands(context, deps) {
  const subscriptions = [
    ...registerHotCommands(deps.sidebarHot),
    ...registerMediaCommands(),
    ...registerCollectionCommands(deps.sidebarCollections),
    // ...十几个命令组
  ];
  subscriptions.forEach(c => context.subscriptions.push(c));
}
```

这条权衡化解的本质矛盾，是**「测试/复用的纯洁性」与「集成步骤的简洁性」之间的拉锯**。把宿主上下文挡在注册函数外面，换来的是单元测试可以脱离 VSCode 跑、命令组可以独立推理；代价是总注册函数必须做那道摊平。这是依赖倒置原则在宿主型插件里的标准骨架：把「知道宿主」的范围压到最小（只压在组合根里），让其余代码活在「不知道宿主」的纯净世界。

### 双依赖通道：显式注入大对象，全局单例取轻量上下文

> 选择：重要的大对象（服务、各列表提供者）走显式参数注入；轻量的全局上下文/容器走全局单例直接 import。
> 换来：不必把每个单例都长长地列进参数表，又保住了关键对象图的显式可读。
> 代价：同一套代码里存在两种耦合风格——一半显式注入、一半隐式全局。新读者要分清「这个依赖该走哪条路」，而答案是看作者当时怎么判的，没有强制约束。

具体到代码：媒体命令组里直接 `import { Store }` 然后 `Store.context.extensionUri`，不经参数；但列表提供者却老老实实从参数表里拿。两种风格并存于同一份代码。

这条权衡化解的本质矛盾，是**「显式依赖的严格性」与「工程现实的人体工效」之间的拉锯**。完全显式注入会让参数表爆炸（每个命令组都要列十几个参数），完全全局又会丢失「这个命令到底依赖什么」的可读性。作者按「重量」分级——重对象必须显式、轻对象可以隐式。骨架是「按依赖重量走不同通道」。

### 配置变更只重绘、不重取

> 选择：纯外观类配置（图片显示模式/缩放）变更时，只触发列表的「重新渲染」，而不是「重新拉取」。
> 换来：一次纯视觉调整不消耗珍贵的登录 Cookie、不触发知乎的反爬限流。
> 代价：每个列表提供者要多维护一条「只刷新视图、不联网」的代码路径——`refreshView()` 与 `refresh()` 是两个不同的方法。

这条权衡化解的本质矛盾，是**「配置响应的即时性」与「反爬配额的稀缺性」之间的拉锯**。外观配置变更是高频低损操作（用户来回切图片模式很常见），如果每次都重新联网，不仅慢，更会把好不容易登录拿到的 Cookie 烧成 403。代价只是多写一个方法——这笔交易非常划算。骨架是「按资源稀缺性给配置变更分类响应」。

## 5. 最小原理演示

下面的脚本不依赖真实 VSCode，伪造一个迷你宿主，演示「激活 → 分发注册 → 摊平句柄 → 统一销毁」这条骨架。重点看句柄如何从命令组流回宿主那张清单。

```ts
// 可销毁句柄：宿主停用扩展时只需逐个调 dispose
type Disposable = { dispose: () => void };

// 迷你宿主扩展上下文：持有一张可销毁句柄清单
type ExtensionContext = { subscriptions: Disposable[] };

// 假数据源（演 activate 里 new 出来的大对象）
class HotListProvider {}
class CollectionListProvider {}

// 命令组：只收数据源、回吐句柄，不碰 context
function registerHotCommands(hot: HotListProvider): Disposable[] {
  // hot 在真实代码里会用于注册「刷新热榜」「打开详情」等命令
  const cmds: Disposable[] = [];
  cmds.push({ dispose: () => console.log("  dispose: hot.refresh") });
  cmds.push({ dispose: () => console.log("  dispose: hot.openDetail") });
  return cmds;
}

// 零依赖命令组：签名暴露「我不需要任何数据源」
function registerMediaCommands(): Disposable[] {
  return [{ dispose: () => console.log("  dispose: media.toggleMode") }];
}

// 收单个数据源的命令组
function registerCollectionCommands(collections: CollectionListProvider): Disposable[] {
  // collections 真实代码里用于注册「打开收藏项」等命令
  return [{ dispose: () => console.log("  dispose: collection.open") }];
}

// 总注册函数：分发依赖 → 收集句柄 → 摊平 → 统一登记进宿主
function registerAllCommands(
  context: ExtensionContext,
  deps: { hot: HotListProvider; collections: CollectionListProvider }
) {
  const subscriptions: Disposable[] = [
    ...registerHotCommands(deps.hot),
    ...registerMediaCommands(),
    ...registerCollectionCommands(deps.collections),
  ];
  subscriptions.forEach(c => context.subscriptions.push(c));
  console.log(`  registerAllCommands: 共登记 ${subscriptions.length} 个句柄`);
}

// 组合根：唯一入口装配对象图，参数表把「谁需要谁」写在明面上
function activate(context: ExtensionContext) {
  console.log("activate: 开始装配");
  const hot = new HotListProvider();
  const collections = new CollectionListProvider();
  registerAllCommands(context, { hot, collections });
}

// 停用入口：宿主遍历清单逐个销毁，扩展不用自己记账
function deactivate(context: ExtensionContext) {
  console.log("deactivate: 宿主遍历清单");
  context.subscriptions.forEach(c => c.dispose());
  context.subscriptions = [];
}

// 演一遍
const ctx: ExtensionContext = { subscriptions: [] };
activate(ctx);
console.log("--- 用户卸载扩展 ---");
deactivate(ctx);
```

跑起来输出：

```
activate: 开始装配
  registerAllCommands: 共登记 4 个句柄
--- 用户卸载扩展 ---
deactivate: 宿主遍历清单
  dispose: hot.refresh
  dispose: hot.openDetail
  dispose: media.toggleMode
  dispose: collection.open
```

四件事值得看清楚：

- 三个命令组函数**没有一个**接收 context——它们与宿主完全解耦。
- 总注册函数把三个命令组回吐的句柄数组摊平成一张清单（共 4 条），再 push 进宿主的 `subscriptions`。
- 装配只在 `activate` 这一处发生，参数表把「谁需要谁」写在了明面上。
- 停用时扩展自己不记账，宿主遍历清单即可。

## 6. 执行轨迹

具体输入：用户在 VSCode 里安装并启用扩展。宿主调用 `activate`，传入一个 `subscriptions` 为空的 `context`。

中间态走读：

1. **种入全局容器**：`Store.context = context`——从这一刻起，任何子系统的代码都能 import 到这个 Store，取到 context。
2. **服务实例化**：`new ZhihuService()` 内部立刻调 `CookieManager.loadCookie()`，把磁盘上已存的 Cookie 读进内存。这一步是同步的，因为后面列表提供者要凭它发请求。
3. **五个列表提供者被 new 出并绑视图**：每条都走「`new XxxListDataProvider()` → `createTreeView(viewId, { treeDataProvider })` → `provider.setTreeView(tree)`」。`setTreeView` 把视图句柄**回灌**给数据源——后面刷新列表的入口在数据源，但实际改 UI 要靠这个视图对象。四个扁平列表（推荐/关注/热榜/搜索）`showCollapseAll: false`，唯有收藏夹（三级树）为 `true`——视图形态决定折叠按钮是否出现。
4. **配置监听挂上**：`onDidChangeConfiguration("zhihu-fisher.*")` 监听所有配置变更。外观类（`mediaDisplayMode` / `miniMediaScale`）调五个 `refreshView()`；`debugMode` 弹重启提示。
5. **打包依赖对象**：`activate` 把刚 new 出的服务和五个提供者塞进一个对象，传给 `registerAllCommands(context, deps)`。
6. **总注册函数分发**：13 个命令组被调用，每个交回若干句柄。其中收五个提供者的命令组只有两个：扫码登录（因为登录成功后要逐一刷新所有列表）和 Cookie 命令组（因为设/清 Cookie 后要联动刷新全部列表）。**签名暴露了运行时数据依赖**——光看参数表就知道这个命令组会把哪些列表搅动一遍。
7. **摊平 + 统一登记**：约六十余条句柄被摊平成一张总清单，逐个 push 进 `context.subscriptions`。

输出：所有命令在命令面板/菜单中可触发并正确路由；扩展停用时，宿主遍历 `context.subscriptions` 把全部句柄一并回收。扩展的 `deactivate` 只额外清理「宿主管不到的东西」——webview 实例、浏览器进程、容器里的可变 map。

## 7. 教学简化说明

本章演示故意省略：

- 真实 VSCode API、每条命令的真实业务逻辑（共 65 条）；
- 伪装管理器的「自带命令、自管生命周期」破口——它在自己的 `initialize()` 里自行 `registerCommand`，绕过总注册函数，是组合根集中装配原则的一个现实例外；
- `package.json` 静态声明（65 条命令 + 6 个视图，5 真 + 1 假文件树）与代码侧绑定的对应关系；
- 全局共享容器内部的可变单例设计（第 1 章）；
- 各列表提供者内部的 fetch+cheerio、扫码登录全流程、收藏夹三级树（均属前置章）。

## 8. 小结

全书十几章一路从「可变单例容器」造到「假文件树伪装」，每一章都是能独立运行的小机器。本章没造新机器——只是把这些机器拼成一台真正扩展的那道总装工序：一处装配、参数注入、摊平销毁。新加子系统时，照着「收依赖、回句柄」的套路写一个注册函数就能接入，不动其他代码。这正是宿主型扩展该有的样子：所有 new 都集中在组合根，所有 dispose 都交给宿主。