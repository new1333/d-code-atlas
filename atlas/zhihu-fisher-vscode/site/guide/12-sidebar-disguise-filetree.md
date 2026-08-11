---
title: 侧边栏伪装成假文件树
---

# 侧边栏伪装成假文件树

> 本章属于 system 层。前置：智能伪装引擎、侧边栏内容列表。
> 学完你能：用一句话讲清「为什么侧边栏整组替换是靠改一个上下文变量、而不是靠 show/hide——以及这种声明式做法换来什么、付出什么」。

## 1. 为什么需要它

上一章把知乎登录走通了：扫码、轮询、抓 Cookie、存盘，进得了门。可身份问题刚解决，紧接着是另一种尴尬：你真的开始用了，编辑器左边那一栏赫然挂着五个知乎视图——推荐、关注、热榜、搜索、收藏。第 10 章「智能伪装引擎」给详情页标签页换皮换得很漂亮：WebView 一失焦，标题、图标、假代码全到位。可老板从背后走过，他不一定看你的标签页，他先瞟左边那一栏——五个写着「推荐」「热榜」的视图整整齐齐排在那里，比什么代码都响亮。

详情页换皮是单个标签页的事：失焦时换皮、聚焦时还原。侧边栏不是这么个东西：它是一**组**视图，要藏得整组一起藏。手动一个个 hide 既慢又会留空隙，而且编辑器扩展也没给你「侧边栏里某个视图 hide」这么直接的 API。需要的是一个办法，能让整组视图原子地消失、同时让另一组（一棵假文件树）原子地顶上来——并且这一切要在 WebView 失焦的那一瞬间发生，不能让用户察觉任何延迟或闪烁。

## 2. 核心思想

把「该不该伪装」这个布尔值，做成一个**编辑器级的上下文变量**；让所有视图的可见性，都用静态清单里的 `when` 条件去引用这个变量。运行时唯一要做的事，就是把变量翻一下——剩下的事，编辑器自己算。

## 3. 心智模型

可以把侧边栏想成一个带开关的展柜：每个视图都摆在自己的位置上，但能不能被看见，不取决于谁去拉它、推它，而取决于它贴的那张「条件贴纸」和展柜总开关的状态对不对得上。

贴纸长这样（来自静态视图清单 `package.json`）：

```jsonc
// 5 个知乎视图——条件都是「未伪装」
{ "id": "zhihuHotList", "when": "!zhihu-fisher.sidebarDisguised" }
// 推荐 / 关注 / 搜索 / 收藏 …同样的条件

// 假文件树——条件是「已伪装」
{ "id": "fakeFileList", "when": "zhihu-fisher.sidebarDisguised" }
```

`zhihu-fisher.sidebarDisguised` 是一个布尔型上下文变量。两组视图的 `when` 条件正好互斥——变量为 `false` 时，前 5 个为真、第 6 个为假；翻成 `true`，前 5 个整体消失、第 6 个整体浮现。

运行时切换可见性的**唯一**实质动作，是一条内置命令：

```ts
await vscode.commands.executeCommand("setContext", "zhihu-fisher.sidebarDisguised", true);
```

代码里没有「隐藏视图 A、显示视图 B」这种指令。代码只改变量。变量一变，编辑器自己重新求值所有视图的 `when`，自动算出谁该露、谁该藏。

还有一个关键点：假文件树视图不是「失焦那一刻才创建」的——它在扩展激活时就被 `createTreeView` 创建好、provider 也即时生成好一棵随机文件树挂上去。它从一开始就「在那儿」，只是平时被 `when` 条件挡着看不见。等变量一翻，它立刻可见，没有「创建视图、拉数据」这一段延迟。

这个常驻设计带来一个副作用：上下文变量在某些场景会被编辑器持久化到上次会话，结果用户重启编辑器，假树还挂着。所以初始化结尾必须强制 `setContext(..., false)`——开机先把变量拍回假，确保干净起步。

## 4. 关键权衡

### 整组替换靠改变量、不靠 show/hide

代码里**没有**一处主动调用 `hide(zhihuHotList)`、`show(fakeFileList)`。要切换可见性，唯一手段就是 `setContext` 翻变量。这是把命令式的「显示控制」让渡出去，换成声明式的「规则表达」。

换来三件事：第一，切换是原子的——编辑器把 5+1 个视图当一个事务一起求值，绝不会出现「真列表已经消失、假树还没浮现」这种中间态被用户看见。第二，可见性规则本身就是配置文档：打开 `package.json`，谁在什么条件下显示一目了然，不需要去翻代码追调用链。第三，扩展之间天然不打架——别的扩展也可以声明自己的视图绑同一个变量，互不干扰。

代价：可见性逻辑被锁进静态清单。你想在运行时**新增**一个视图类型、或者**动态决定**某个视图该绑哪个条件，都做不到——`when` 表达式在 `package.json` 里写死了，运行时只能改它依赖的变量值、改不了它本身。本质矛盾是「想运行时灵活地控制可见性」与「想可见性规则简单、声明式、原子可推」的冲突，这里彻底倒向了后者。

### 失焦那一刻，假树得立刻在位

假文件树视图在 `activate` 阶段就被创建好、provider 数据也即时生成好；它一直在内存里挂着，只是平时被 `when` 挡着看不见。

换来的是失焦瞬间的零延迟。用户点开一个知乎详情页，WebView 一失焦、钩子一触发、`setContext` 一翻，假树立刻可见，不用在「失焦 → 触发」这一拍之后再补一段「创建视图、拉数据、渲染」的延迟。详情页伪装那一段本身就在跟时间赛跑（要在用户察觉前把标签页换皮），侧边栏必须与之同步立刻顶上，否则「标签页换了、侧边栏半秒后才跟上」就露馅了。

代价有两块。一块是即使不伪装，假树这份 provider 与视图资源也一直占着，不过这种内存占用微不足道。另一块更实在：上下文变量会被编辑器持久化，重启后可能残留「假树还显示着」的错乱状态，所以初始化结尾必须强制把变量拍回 `false`。本质矛盾是「想按需创建、省内存」与「想失焦瞬间无延迟」的冲突，这里选了后者，再用一个「开机复位」的小补丁把残留副作用兜住。

### 一处语言映射，服务两处伪装

假文件树里出现的扩展名（`.ts`、`.js`、`.go`…）不是凭空来的——它直接读用户在设置里选的 `selectedDisguiseTypes`（详情页伪装那套配置），先「图标 → 语言」、再「语言 → 扩展名」，最后用这些扩展名随机拼出假文件名。同一张映射表，详情页假代码用、侧边栏假文件树也用。

换来的是整组伪装风格一致：老板看到的不是「标签页在演 TypeScript、侧边栏在演 Python」这种穿帮画面——上下伪装说的是同一种「项目语言」。用户配置一次，两处生效。

代价是假树 provider 与详情页伪装管理器形成隐式耦合——共享同一份「图标 → 语言 → 扩展名」的映射语义。哪天有人改了详情页伪装的语言映射表、却忘了假树也读它，假树就会跟着出问题。本质矛盾是「想各子系统独立演进」与「想整组伪装风格统一」的冲突，这里牺牲一点隔离性，换来视觉上的浑然一体。

### 不靠焦点、靠「有没有详情页开着」

「什么时候才恢复真列表？」这个问题的答案不是「WebView 聚焦时」，而是「所有详情页都关掉时」。判定逻辑直接看 `webviewMap.size > 0`——只要还有任何一个详情页开着，侧边栏就一直保持伪装态。

换来两件事。一是逻辑简单，不需要监听焦点事件、不需要在「聚焦/失焦」之间维护状态机。二是不会闪烁——侧边栏整组切换比单个标签页换皮「重」得多（要重算 `when`、要重建视图 DOM），如果按焦点来回切，用户在两个详情页之间点来点去，侧边栏会跟着反复闪，这种闪烁本身比摸鱼还显眼。源码注释里明确记了从「按焦点判断」到「按存在判断」的演变。

代价是阅读期间侧边栏一直处于伪装态，用户想看真列表必须先关掉所有详情页、或者主动去点假文件树里任意一项（这是下面要讲的「逃生口」）。换句话说，侧边栏的伪装态比单个标签页更「粘」——标签页失焦就还原，侧边栏只要详情页还开着就不还原。本质矛盾是「想精确反映『现在到底该不该伪装』」与「想避免高频切换的闪烁」的冲突，这里选了「降到最稳的低频切换」，代价是牺牲一些「精确还原」的及时性。

## 5. 最小原理演示

下面的最小扩展骨架只演透两件事：静态清单里两组互斥的 `when` 条件，加上运行时一条 `setContext` 翻变量。能 `F5` 真跑、能看见两组视图整体替换——这就是侧边栏伪装的全部灵魂。

先看 `package.json`，它声明了两个视图，绑同一个上下文变量、条件互斥：

```jsonc
{
  "name": "demo-sidebar-disguise",
  "engines": { "vscode": "^1.80.0" },
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "demo-sidebar", "title": "Demo", "icon": "icon.svg" }
      ]
    },
    "views": {
      "demo-sidebar": [
        { "id": "realList",     "name": "真列表", "when": "!demo.disguised" },
        { "id": "fakeFileList", "name": "文件",   "when":  "demo.disguised" }
      ]
    },
    "commands": [
      { "command": "demo.disguise", "title": "伪装" },
      { "command": "demo.restore",  "title": "还原" }
    ]
  }
}
```

再看 `extension.ts`。`activate` 里干三件事：把变量先拍回 `false`（开机复位）、注册一条「翻为 true」的命令、注册一条「翻为 false」的命令。注意假文件树视图也在这时候创建好，数据 provider 即时挂上，常驻但平时不可见：

```ts
import * as vscode from "vscode";

// 最小 provider：返回一棵固定的假文件树
class FakeFileProvider implements vscode.TreeDataProvider<string> {
  private files = ["src/auth.ts", "src/handler.js", "tests/main.test.ts"];
  private folders = ["src", "tests"];

  getTreeItem(name: string): vscode.TreeItem {
    const item = new vscode.TreeItem(name);
    item.collapsibleState = name.includes(".")
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed;
    // 每个假文件的 command 都指向还原——点假文件即解除伪装
    if (name.includes(".")) {
      item.command = { command: "demo.restore", title: "打开文件", arguments: [name] };
    }
    return item;
  }

  getChildren(element?: string): string[] {
    if (!element) return this.folders;
    return this.files.filter((f) => f.startsWith(element + "/"));
  }
}

export function activate(context: vscode.ExtensionContext) {
  // 开机复位：把变量拍回 false，防止重启残留
  vscode.commands.executeCommand("setContext", "demo.disguised", false);

  // 假视图先创建好、常驻——平时被 when 挡着不可见
  vscode.window.createTreeView("fakeFileList", {
    treeDataProvider: new FakeFileProvider(),
  });

  // 翻为 true：编辑器自动重算 when，真列表整组消失、假树浮现
  context.subscriptions.push(
    vscode.commands.registerCommand("demo.disguise", () => {
      vscode.commands.executeCommand("setContext", "demo.disguised", true);
    })
  );

  // 翻回 false：编辑器自动重算 when，真列表回归——点假文件也走这条
  context.subscriptions.push(
    vscode.commands.registerCommand("demo.restore", () => {
      vscode.commands.executeCommand("setContext", "demo.disguised", false);
    })
  );
}
```

跑起来：`F5` 启动一个扩展开发宿主 → 侧边栏只看见「真列表」 → 命令面板执行「伪装」 → 「真列表」整体消失、「文件」浮现 → 点 `src/auth.ts` → 「文件」消失、「真列表」回归。整个过程没有任何 `show/hide` 指令，全是改变量、让编辑器自己算——这就是侧边栏伪装的核心。

## 6. 执行轨迹

输入：用户已开启侧边栏伪装开关（且详情页伪装开关也已开，否则侧边栏伪装会被拒绝启用），并点开了一个知乎详情页。

- 详情页管理器在「触发详情页界面伪装」（即失焦换皮那一拍）时，同步调侧边栏伪装管理器的钩子 `onWebViewDisguised`。
- 钩子先校验侧边栏伪装的功能开关——没开就到此为止，什么也不动。
- 开关通过，执行 `showDisguiseViews()`：里面就一条实质命令——`setContext("zhihu-fisher.sidebarDisguised", true)`。
- 编辑器收到这个 `setContext`，把所有视图的 `when` 条件重算一遍：5 个知乎视图的 `!zhihu-fisher.sidebarDisguised` 全部变 false、整体消失；`fakeFileList` 的 `zhihu-fisher.sidebarDisguised` 变 true、浮现。
- 假文件树 provider 触发 `refresh()`，重新生成一棵随机目录（`src/components/auth.ts`、`utils/handler.js`…）。
- 输出：老板看到的侧边栏是一棵项目文件树——五个写着「推荐」「热榜」的视图一个都不见了。
- 用户点假树里任意一个文件 → 文件项的 `command` 指向 `onFakeFileClick` → 它的实现就是 `showNormalViews()` → `setContext("zhihu-fisher.sidebarDisguised", false)` → 编辑器再次重算 `when` → 知乎五个视图回归、假树隐去。

最后一拍的语义要强调：还原**不是**「WebView 聚焦时自动还原」，而是「用户主动点假文件」或「所有详情页都关掉」。这就是权衡④讲的「存在即伪装」——只要还有一个详情页开着，侧边栏就保持伪装态。

## 7. 教学简化说明

上面的演示故意省略了这些工程细节：假文件树的随机目录骨架（固定 `src/tests/docs` + 概率可选 `database/i18n/vendor` 等）、图标 svg 三级回退表（资源 svg → 内置主题图标 → 通用 `file`）、与详情页伪装联动的三个钩子（`onWebViewCreated / onWebViewDisguised / onWebViewClosed`）的具体调用时机、配置变更监听、命令重复注册防护、`safeRegisterCommand` 的兜底逻辑。这些都不影响「上下文变量驱动声明式视图显隐」这条主线。

## 8. 小结

真列表与假文件树不是被代码拽来拽去的物品，而是同一份静态清单里两组互斥条件——代码只翻变量、规则自己出结果。这种声明式做法换来原子切换与「规则即文档」，代价是可见性逻辑被锁死在静态清单里。侧边栏伪装只是被装配进编辑器的一个子系统，下一章看 `activate` 顶层怎么把它和登录、列表、详情页、命令一起拼起来。
