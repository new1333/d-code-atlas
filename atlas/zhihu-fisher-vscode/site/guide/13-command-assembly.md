---
title: 扩展激活与命令编排
---

# 第 13 章 扩展激活与命令编排

## 13.1 一个扩展的"开机仪式"

想象你刚装好一个摸鱼用的知乎扩展，按下 F5 启动它。这一瞬间，VSCode 会找到扩展里那个叫 `activate` 的函数，把一个叫做「扩展上下文」的东西塞给它，然后说："好了，你接管吧。"

这一个 `activate` 函数要在一瞬间完成所有事情：把全局共享容器初始化好、把已存的知乎登录 Cookie 加载进内存、把五个侧边栏列表（热榜、推荐、关注、搜索、收藏夹）逐个 new 出来、绑到对应的视图上、再把核心服务实例化。然后还要把六十多条命令——刷新热榜、给回答点赞、收藏一篇文章、扫码登录、切换夜间模式……——一条不漏地登记到 VSCode 那里，让命令面板能找到它们。

如果没个统一约定，每条命令自己 `new` 自己要用的服务、各自把"用完要回收的句柄"随手塞进某个数组、配置改了各想各的办法刷新——很快"谁创建了什么、谁负责清理什么"就全靠人脑记。停用扩展的时候，浏览器进程没关、webview 没销毁、内存泄漏就在所难免。

这套机制的核心想法用一句话说就是：**在唯一的激活入口里把所有对象装配好、用普通函数参数注入下去，每个命令组只回吐一批「可销毁句柄」由入口统一登记进宿主——组合根装配，统一销毁。** 说人话就是：开机时集中接线，关机时一把拔掉。

下面我们自底向上拆这套机制：先看一个最小的"命令组注册函数"长什么样，再看总注册函数怎么把十几个命令组摊平登记，然后看 `activate` 怎么把这些都串起来，最后看 `deactivate` 怎么统一回收。

## 13.2 最小独立单元：一个命令组注册函数

我们先看最小的零件——一个命令组是怎么注册的。你随手翻开热榜相关的命令组，会看到类似这样的形态：

```ts
export function registerHotCommands(
  sidebarHot: HotListDataProvider
): vscode.Disposable[] {
  const commands: vscode.Disposable[] = [];

  commands.push(
    vscode.commands.registerCommand('zhihu-fisher.hot.refresh', async () => {
      await sidebarHot.refresh();
    })
  );

  commands.push(
    vscode.commands.registerCommand('zhihu-fisher.hot.open', async (item) => {
      await sidebarHot.openArticle(item);
    })
  );

  return commands;
}
```

这个函数的形状非常克制，它做了三件事：

1. **接收它需要的依赖**（这里是热榜数据源）；
2. **逐个 `registerCommand` 并把得到的句柄 push 进一个本地数组**；
3. **`return` 这个数组**。

最关键的是它**没有接收宿主上下文**。它不知道、也不需要知道 VSCode 的扩展上下文长什么样。它只把自己注册得到的句柄装进数组交回去——"我注册了这些命令，这些命令的销毁句柄还给你，至于你怎么管它们，是你的事。"

这种"只回吐、不碰宿主"的形态让每个命令组都能脱离 VSCode 单独被理解：你可以把整个函数拷到一个测试脚本里，给它一个假的数据源，它就能跑、能被测，完全不需要伪造一个完整的扩展上下文。

> 一个签名细节值得记住：参数 `sidebarHot: HotListDataProvider` 不仅仅是"传个依赖"，它本身就是一份**依赖文档**——读到这个签名你就知道：热榜命令组运行时只需要热榜数据源，不需要别的。本章后面会看到，13 个命令组的签名形态各异，正是这种"签名即文档"的体现。

## 13.3 总注册函数：摊平 + 统一登记

单个命令组只是零件。真正把它们组织起来的是总注册函数 `registerAllCommands`。它的活儿很机械——把 13 个命令组各自回吐的句柄数组，摊平成一张总清单，然后逐条登记进宿主的 `context.subscriptions`。

```ts
export function registerAllCommands(
  context: vscode.ExtensionContext,
  dependencies: CommandDependencies
): void {
  const subscriptions = [
    ...registerHotCommands(dependencies.sidebarHot),
    ...registerMediaCommands(),
    ...registerGeneralCommands(),
    ...registerSearchCommands(dependencies.sidebarSearch),
    ...registerBrowserCommands(),
    ...registerWebviewCommands(),
    ...registerWebviewNavigationCommands(),
    ...registerQRLoginCommands(
      dependencies.sidebarHot,
      dependencies.sidebarRecommend,
      dependencies.sidebarFollow,
      dependencies.sidebarSearch,
      dependencies.sidebarCollections
    ),
    ...registerCookieCommands(
      dependencies.zhihuService,
      dependencies.sidebarHot,
      dependencies.sidebarRecommend,
      dependencies.sidebarFollow,
      dependencies.sidebarSearch,
      dependencies.sidebarCollections
    ),
    ...registerCollectionCommands(dependencies.sidebarCollections),
    ...registerRecommendCommands(dependencies.sidebarRecommend),
    ...registerFollowCommands(dependencies.sidebarFollow),
    ...registerAboutCommands(),
  ];

  subscriptions.forEach((command) => {
    context.subscriptions.push(command);
  });
}
```

它做了两件**很轻但很有讲究**的事：

- **按需分发依赖**：13 个命令组的签名各不相同——`registerMediaCommands()` 零依赖、`registerHotCommands(sidebarHot)` 收一个、`registerQRLoginCommands(...)` 收五个、`registerCookieCommands(zhihuService, ...)` 收"服务加五个提供者"。哪个命令组要哪些依赖，全在调用现场一眼可见。
- **摊平后统一登记**：用展开运算符 `...` 把 13 个 `Disposable[]` 摊成一张扁平的总清单，再 `forEach` 推进 `context.subscriptions`。

摊平这一步看起来多余——为什么不直接 `context.subscriptions.push(...registerHotCommands(...))` 一行行写？分两步走的好处是先把所有句柄收集到一张清单，便于调试时 dump 出来核对总数，也便于将来插入"统一打日志""统一过滤"之类的横切逻辑。

### 13 个命令组的签名分类

13 个注册函数的参数形态本身就是一张依赖关系表：

| 形态 | 数量 | 代表 | 含义 |
| --- | --- | --- | --- |
| 零依赖 | 6 个 | 媒体、通用、关于、浏览器、webview、webview 导航 | 这些命令只动 webview 或全局态，不需要数据源 |
| 收单个列表提供者 | 5 个 | 热榜、搜索、收藏、推荐、关注 | 一对一关系：命令组 ↔ 数据源 |
| 收五个列表提供者 | 1 个 | 扫码登录 | 登录成功后要逐一刷新全部列表 |
| 收"服务 + 五个提供者" | 1 个 | Cookie 设置/清除 | 设/清 Cookie 后要联动刷新全部列表 |

最值得说的是后两个。**扫码登录命令组要拿全五个列表提供者，正是因为登录成功后要逐一刷新它们**——这个签名暴露了运行时的数据依赖。第 11 章已经把扫码登录的浏览器隔离、二维码截图、Cookie 提取讲透了，这里我们只看新侧面：**这个命令组为什么需要这么多依赖**。答案就是它成功后会触发"全局刷新"，所以装配时必须把这五个提供者都喂给它。

## 13.4 一段最小演示：从激活到销毁的完整骨架

光看代码片段你可能会觉得抽象——"摊平""统一登记"到底在做什么？我们用一段能跑的脚本演一遍。下面这段独立代码伪造一个迷你宿主，把上面两节的"分发 → 摊平 → 统一登记 → 统一销毁"演透。你可以用 `bun run mini-host.ts` 或 `node mini-host.ts` 直接跑：

```ts
// mini-host.ts — 演示「激活 → 分发注册 → 摊平句柄 → 统一销毁」这条骨架
// 不依赖 vscode，重点是接线的形状。

// 1. 伪造的扩展上下文：内部就一个空数组当可销毁清单
class FakeExtensionContext {
  subscriptions: { dispose: () => void }[] = [];
}

// 2. 伪造的数据源（演 activate 里 new 出来的对象）
class FakeDataProvider {
  constructor(public readonly name: string) {}
}

// 3. 命令组 A：收 1 个数据源，回吐 2 个可销毁句柄
function registerHotCommands(hot: FakeDataProvider) {
  const commands: { dispose: () => void }[] = [];
  commands.push({ dispose: () => console.log('    - 销毁 hot.refresh') });
  commands.push({ dispose: () => console.log('    - 销毁 hot.open') });
  console.log(`  [registerHotCommands] 收到 ${hot.name}，注册 2 条命令`);
  return commands;
}

// 4. 命令组 B：零依赖，回吐 1 个句柄
function registerMediaCommands() {
  const commands: { dispose: () => void }[] = [];
  commands.push({ dispose: () => console.log('    - 销毁 media.toggle') });
  console.log('  [registerMediaCommands] 零依赖，注册 1 条命令');
  return commands;
}

// 5. 总注册函数：摊平所有命令组的句柄数组，统一登记进宿主
function registerAllCommands(
  ctx: FakeExtensionContext,
  deps: { hot: FakeDataProvider }
) {
  const all = [...registerHotCommands(deps.hot), ...registerMediaCommands()];
  all.forEach((c) => ctx.subscriptions.push(c));
  console.log(
    `  [registerAllCommands] 摊平后共 ${all.length} 条，已登记进 ctx.subscriptions`
  );
}

// 6. 激活入口：唯一装配点
function activate(ctx: FakeExtensionContext) {
  console.log('=== activate 开始 ===');
  const hot = new FakeDataProvider('HotList');
  registerAllCommands(ctx, { hot });
  console.log(
    `  [activate] ctx.subscriptions 当前长度: ${ctx.subscriptions.length}`
  );
  console.log('=== activate 完成 ===\n');
}

// 7. 停用入口：宿主遍历清单逐个销毁，扩展无需自己记账
function deactivate(ctx: FakeExtensionContext) {
  console.log('=== deactivate 开始 ===');
  console.log(
    `[deactivate] 宿主开始遍历 ${ctx.subscriptions.length} 条 subscriptions`
  );
  ctx.subscriptions.forEach((c, i) => {
    console.log(`  (${i + 1}) 调 dispose():`);
    c.dispose();
  });
  console.log('=== deactivate 完成 ===');
}

// 跑一遍
const ctx = new FakeExtensionContext();
activate(ctx);
deactivate(ctx);
```

执行轨迹长这样：

```
=== activate 开始 ===
  [registerHotCommands] 收到 HotList，注册 2 条命令
  [registerMediaCommands] 零依赖，注册 1 条命令
  [registerAllCommands] 摊平后共 3 条，已登记进 ctx.subscriptions
  [activate] ctx.subscriptions 当前长度: 3
=== activate 完成 ===

=== deactivate 开始 ===
[deactivate] 宿主开始遍历 3 条 subscriptions
  (1) 调 dispose():
    - 销毁 hot.refresh
  (2) 调 dispose():
    - 销毁 hot.open
  (3) 调 dispose():
    - 销毁 media.toggle
=== deactivate 完成 ===
```

注意几个细节：

- `activate` 里 new 的对象（`hot`）只往下游传，**不被全局保存**；
- 命令组返回的是数组，`registerAllCommands` 用 `...` 摊平；
- `deactivate` 不需要知道"我创建过哪些命令"，宿主自己遍历清单就完事了。

这就是这套机制最关键的形状。下一节我们看真实的 `activate` 在这个骨架基础上多做了哪些事。

## 13.5 组合根：activate 是唯一的装配点

把迷你演示对应回真实的 `activate`，多出来的细节一目了然：

```ts
export async function activate(context: vscode.ExtensionContext) {
  // 1. 把扩展上下文种入全局共享容器
  Store.context = context;

  // 2. 伪装管理器自启（fire-and-forget，不阻塞激活）
  SidebarDisguiseManager.getInstance().initialize(context).catch(/* ... */);

  // 3. 核心服务实例化（构造函数内同步加载已存 Cookie）
  const zhihuService = new ZhihuService();

  // 4. 五个列表提供者：new → createTreeView → setTreeView 回灌
  const sidebarHot = new HotListDataProvider();
  const hotView = vscode.window.createTreeView('zhihu-fisher.sidebarHot', {
    treeDataProvider: sidebarHot,
    showCollapseAll: false,
  });
  sidebarHot.setView(hotView);

  // （推荐/关注/搜索/收藏夹 同构，省略）

  // 5. 配置变更监听
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // 外观类配置 → 只重渲染不联网
      // debugMode → 提示重启
    })
  );

  // 6. 把大对象打包，调用总注册函数
  registerAllCommands(context, {
    zhihuService,
    sidebarHot,
    sidebarRecommend,
    sidebarFollow,
    sidebarSearch,
    sidebarCollections,
  });
}
```

这里有几个细节值得停下来想一想。

**第一步为什么是 `Store.context = context`？** 因为全局共享容器（第 1 章讲透的"模块级可变单例对象"）的 `context` 字段，全仓库只有这一处赋值点。从这里往后，所有子系统都可以通过 `Store.context.extensionUri` 等字段拿到当前扩展上下文，不必再走参数注入。这就是第 1 章那个"全局可变状态"在新章节里的新侧面——**它是组合根种进去的，组合根也是唯一回收它的人**（停用时 `Store.context = null`）。

**为什么 `new ZhihuService()` 不传任何参数？** 因为它内部直接从 `Store.context.globalState` 读取已存的 Cookie，构造函数同步把它们加载进内存。它能这么干，是因为前一步刚把 `context` 种进了 `Store`——这就是"双依赖通道"的隐式那一半：轻量全局态走 `Store` 直接取。

**为什么列表提供者要 `setView` 回灌？** 因为创建 `TreeView` 需要 `treeDataProvider`（提供者），但提供者后续要刷新视图又需要视图句柄——这是一对循环依赖。VSCode 没有"创建时同时拿到对方"的 API，所以拆成三步：先 new 提供者、用提供者创建视图、再把视图塞回给提供者。第 5 章已经把侧边栏列表的"fetch + cheerio 解析 + 状态化渲染"讲透了，这里我们只看新侧面：**数据源实例在哪里被创建、怎样被绑定到视图、视图句柄又怎样回灌给数据源**。

**`showCollapseAll` 为什么有的视图是 `false`、有的是 `true`？** 四个扁平列表（推荐/关注/热榜/搜索）`showCollapseAll: false`，唯有收藏夹（三级树）为 `true`。这是因为收藏夹是"我创建的/我关注的 → 收藏夹 → 收藏项"三级结构（第 9 章详述），需要折叠按钮；其他都是扁平列表，给了也没用。视图形态决定了折叠按钮是否出现——一个非常朴素但容易写错的小细节。

## 13.6 关闭通路：deactivate 只清"残羹冷炙"

`deactivate` 看起来短得让人意外：

```ts
export function deactivate() {
  ZhihuService.cleanup();
}
```

它只调了一个静态方法 `cleanup`。这是为什么呢？**因为命令句柄的回收其实由宿主自己干完了**——VSCode 在停用扩展时会自动遍历 `context.subscriptions`，对每个句柄调 `dispose`。所以 `deactivate` 不需要再管"我注册过哪些命令"。

那 `ZhihuService.cleanup()` 干的是什么？它清的是宿主管不到的东西：

- 关闭所有打开的 webview；
- 清空全局容器里的 `webviewManager`、各列表数据缓存；
- 关闭浏览器实例（Puppeteer 拉起的 Chrome 进程）；
- 把 `Store.context` 置为 `null`。

说人话就是：**宿主负责回收"句柄"，扩展负责回收"外部进程和容器内的可变状态"**。两者各管一摊，没有重叠也没有遗漏。这种分工的代价是：开发者必须很清楚"什么该挂到 subscriptions、什么该自己 cleanup"，弄错了就会泄漏。

## 13.7 关键权衡

这套"开机接线、关机拔线"的机制不是凭空设计成这样的——背后有四条非常具体的权衡。

### 13.7.1 集中装配（组合根）——本章核心权衡

**选择**：把"new 对象"这件事严格限定在 `activate` 这一个入口里，其余地方（命令 handler、列表提供者、webview）一律靠参数接收依赖。

**换来**：整个对象图集中在一处可读——打开 `activate` 你就知道这个扩展依赖了哪些子系统、它们之间什么关系。没有任何"散落在角落的隐式构造"——你不会在某个命令 handler 里突然看到 `new ZhihuService()`，那会创造出一个绕过统一生命周期的孤儿对象。停用时，因为这个限制，所有需要回收的对象都在 `activate` 视线内，回收路径必然经过 `deactivate`。

**代价**：`activate` 成了一个"无所不知"的胖函数——它知道核心服务、知道五个列表提供者、知道伪装管理器、知道配置监听。每加一个子系统，都得回来改这个函数。这就像一本装配手册——清晰但永远在长。

**取舍点**：作者选择"胖激活函数 + 简单依赖关系"而不是"瘦激活函数 + 各处自构造"，本质上是把"复杂度从横向扁平分布换成了纵向集中分布"。横向分布看起来优雅，但停用时的清理是个噩梦（每个子系统都得自己记着回收）；集中分布虽然激活函数胖，但停用路径必然收敛，回收确定性高得多。对一个长期运行的扩展来说，回收确定性比"激活函数好不好看"重要太多。

### 13.7.2 命令组只回吐句柄、不碰宿主上下文

**选择**：每个 `registerX` 函数**不接收** `context` 参数，只把自己注册得到的句柄装进数组返回，由 `registerAllCommands` 统一摊平后 push 进 `context.subscriptions`。

**换来**：注册函数与宿主解耦——你可以把任何一个命令组拷到测试脚本里，给它假依赖就能跑；所有命令组共享同一套销毁契约（"我交回 Disposable[]"）；将来如果换宿主（比如想做一个非 VSCode 的版本），命令组一行都不用改。

**代价**：多一道"收集 → 摊平 → 登记"的编排步骤，而且"返回数组由上层统一登记"这个约定略反直觉——新人第一次看可能会问"为什么不直接 push 进 context.subscriptions？"。摊平这个动作本身也有点机械。

**取舍点**：这就是经典的依赖倒置——"高层策略（生命周期管理）不依赖低层细节（具体命令），低层细节也不依赖高层策略（不知道 context 长什么样）"。代价是多一层间接，换来的是两边都能独立演化。本章 13.4 的迷你演示演的就是这条权衡——`registerHotCommands` 不知道 `FakeExtensionContext` 长什么样，照样能跑、能被销毁。

### 13.7.3 双依赖通道：显式注入与全局单例并存

**选择**：重要的大对象（核心服务、各列表提供者）走显式参数注入（`registerAllCommands(context, { zhihuService, sidebarHot, ... })`）；轻量的全局上下文/容器走全局单例直接取（命令 handler 里 `import { Store }` 然后用 `Store.context.extensionUri`）。

**换来**：不必把每个单例都长长地列进参数表（六个对象已经够长，再加几个就难看了），又保住了关键对象图的显式可读——读到 `registerQRLoginCommands(hot, recommend, follow, search, collections)` 你立刻知道登录后要刷这五个列表。

**代价**：同一套代码里存在两种耦合风格——一半显式注入、一半隐式全局。新读者要花点时间分清"哪些依赖该走参数、哪些依赖该走 Store"。如果开发者不小心，把一个本该走参数的重要对象塞进了 Store，就会丢失显式可读性。

**取舍点**：这是对工程实用主义的妥协。完全显式注入会让参数表爆炸；完全隐式全局会让对象图不可见。作者选了"大的显式、小的隐式"这条折中路。说人话就是——**重要的事写在签名里，琐碎的事走全局**。

### 13.7.4 配置变更只重绘、不重取

**选择**：用户改了纯外观类配置（图片显示模式、媒体缩放比例）时，监听器调五个提供者的 `refreshView()`——只重新触发视图渲染，**不联网**。而真正"刷新数据"的 `refresh()` 方法是另一个独立的方法。

**换来**：一次纯视觉调整不消耗珍贵的登录 Cookie、不触发知乎反爬限流。改个图片显示模式就重新拉一遍列表，既浪费 Cookie 又增加被风控的概率。

**代价**：每个列表提供者要维护两条代码路径——"只刷视图"和"重新联网"——多了一份维护负担，也容易写错（开发者要分清什么时候调哪个）。

**取舍点**：这个权衡和第 5 章"列表故意用轻量 fetch（而非 Puppeteer）"是一脉相承的——**Cookie 和反爬配额是稀缺资源，能用本地动作解决的事绝不再去碰网络**。`refreshView()` vs `refresh()` 的拆分就是这条原则在配置变更场景下的具体落地。

## 13.8 例外与边界：伪装管理器的"半自治"

讲到这里，你可能已经发现了一个"破坏规则"的地方。前面我们说"所有命令都通过 `registerAllCommands` 统一登记"，但仔细看 `activate` 的第二步：

```ts
SidebarDisguiseManager.getInstance().initialize(context).catch(/* ... */);
```

这是整个 `activate` 里**唯一一个 fire-and-forget 调用**——不 `await`，不阻塞激活。这个伪装管理器（第 12 章详述）走的是另一条路：

- 它是单例模式（`getInstance()`）；
- 它的 `initialize(context)` 方法**自己接收 context**——和命令组的"不碰宿主"约定相反；
- 它在 `initialize` 内部**自己 `registerCommand`** 注册了若干命令，绕过了总注册函数。

这是"组合根集中装配"原则在现实中的一个破口。为什么要破这个例？因为伪装子系统想做一个"半自治"的设计——它自带命令、自管生命周期、自启后台监听（监听 webview 失焦事件触发伪装），不希望被主线流程拖累。

第 10、12 章已经把两套伪装机制（webview 失焦换标题、侧边栏整体替换成假文件树）讲透了。这里我们只看新侧面：**伪装子系统选择了"自带命令、自管生命周期"的半自治设计，是为了不拖累主激活路径**。`activate` 的"不 await"也呼应了这一点——伪装出问题了不该阻塞扩展激活。

这种"原则之外有例外"的诚实值得注意。一个真正可维护的系统不是"原则一律贯彻到底"，而是"原则被显式声明，例外也被显式标注"。伪装管理器是个例外，但它是个**被设计、被命名、被放在显眼位置**的例外——而不是某个角落里偷偷摸摸的"哦这里我也 register 了一下"。

## 13.9 一个完整的执行轨迹

你按下 F5 那一瞬间到底发生了什么？把全章串起来：

```
1. 宿主调用 activate(context)
   │  context.subscriptions = []  (空清单)
   │
   ├─ 2. Store.context = context
   │     → 全局容器从此可被所有子系统访问
   │
   ├─ 3. SidebarDisguiseManager.initialize(context)  (fire-and-forget)
   │     → 伪装子系统自启，自己注册命令、自己管生命周期
   │
   ├─ 4. new ZhihuService()
   │     → 构造函数同步从 globalState 加载 Cookie
   │
   ├─ 5. 5× { new XxxListDataProvider → createTreeView → setView }
   │     → 五个数据源实例化、绑定视图、视图句柄回灌
   │     → 收藏夹的 showCollapseAll: true（三级树），其余 false
   │
   ├─ 6. onDidChangeConfiguration 监听
   │     → 外观配置 → refreshView()（不联网）
   │     → debugMode → 提示重启
   │
   └─ 7. registerAllCommands(context, { zhihuService, ...5 providers })
         │
         ├─ 13× registerX(各自依赖) → 各返回 Disposable[]
         ├─ ...摊平为 subscriptions[]（约六十余条）
         └─ subscriptions.forEach(c => context.subscriptions.push(c))

8. 用户停用扩展 → 宿主调 deactivate()
   │
   ├─ 宿主遍历 context.subscriptions → 逐个 dispose()
   │  （约六十余条命令句柄被回收）
   │
   └─ ZhihuService.cleanup()
      ├─ 关闭所有 webview
      ├─ 清空 Store 各 map/list
      ├─ 关闭 Puppeteer 浏览器实例
      └─ Store.context = null
```

整个过程的关键特征：**激活时接线集中、停用时回收确定**。命令面板里那六十多条命令能被正确路由、扩展停用时不会有进程残留——靠的就是这一套"开机仪式"。

## 13.10 收束

这是全书最后一章。我们从最底层的全局容器（第 1 章）开始，一路经过 Cookie 清洗（第 2 章）、防反爬浏览器（第 3 章）、知乎 API 客户端（第 4 章）、侧边栏列表（第 5 章）、详情页爬取（第 6 章）、详情页渲染（第 7 章）、评论游标分页（第 8 章）、收藏夹树（第 9 章）、智能伪装引擎（第 10 章）、扫码登录（第 11 章）、侧边栏伪装（第 12 章）……最后所有这些零件，都在本章这个"开机仪式"里被装配到一起。

这一章没有引入任何新的"业务能力"——没有新的爬虫、没有新的伪装、没有新的 API 调用。它做的事情是**让前面 12 章的所有零件能在一个真实的 VSCode 扩展里协同工作、并且能在停用时干净地退出**。

这就是"组合根"的意义——它本身不实现任何功能，但它把所有功能的依赖关系、生命周期、销毁契约都集中在一处声明。读懂了 `activate` 和 `registerAllCommands`，你就读懂了这个扩展"凭什么能跑起来、凭什么能干净地关掉"。
