# 侧边栏伪装成假文件树

想象一下：你正在用编辑器看知乎，详情页的标签页已经能换皮了——标题变成 `auth.ts`、图标变成 TypeScript 文件，老板从背后走过瞄一眼标签栏，看不出端倪。可他再往左边一扫：侧边栏里赫然摆着「推荐 / 关注 / 热榜 / 搜索 / 收藏」五个知乎视图。整个伪装瞬间露馅。

标签页换皮治的是「一点」，侧边栏这整组视图是「一片」。手动一个个 hide 慢、还会留痕迹；而且只要有一个视图漏网，伪装照样崩。这一章要讲的就是：怎么用一个布尔值的翻转，让编辑器自己把这整组视图原子地换成另一组——真列表整组消失，假文件树整组顶上。

## 一句话核心思想

**让编辑器自己来换。** 你只做两件事：在静态清单里写好「这个视图什么条件下可见」，然后在运行时改一个布尔值。剩下的事——哪些视图该藏、哪些该显——编辑器自己根据条件求值，整组原子切换，你的代码里没有半行 `show()` / `hide()`。

把全局指针想象成一块谁都能看到的公共留言板：你的代码不直接动手藏视图，只是去留言板写一句「现在处于伪装态」，编辑器看到留言，自己把该藏的藏了、该显的显了。

## 自底向上：先看「视图可见性」到底是什么

很多人会觉得，视图的可见性是代码 `view.show()` 出来的。**在 VSCode 里恰好相反**：视图的可见性是**静态声明**出来的——你在 `package.json` 的 `contributes.views` 里写一行，再带一个 `when` 表达式，这一行就决定它什么时候可见。运行时你不能改这清单，你能改的，是 `when` 表达式里依赖的那些「上下文变量」。

所以「切换侧边栏」这件事，自底向上拆，就三层：

```
层 1：静态清单（package.json）
  ├── 真列表组：when = "!zhihu-fisher.sidebarDisguised"
  └── 假文件树：when =  "zhihu-fisher.sidebarDisguised"
       ↓ 依赖
层 2：上下文变量 zhihu-fisher.sidebarDisguised（一个布尔）
       ↓ 唯一改法
层 3：内置命令 setContext（运行时翻转变量）
```

整组替换的本质就是层 1 那两行 `when` 互斥——一个取反、一个不取反，绑同一个变量。变量一翻，两组同步翻转，原子。

### 层 3：唯一的运行时动作——`setContext`

整个伪装机制在运行时只做一件实质的事：执行一条内置命令 `setContext`，把那个布尔变量在 `true` / `false` 间翻一下。代码里没有任何「显示 A、隐藏 B」的指令。

```ts
// 进入伪装态：翻为 true
async showDisguiseViews() {
  await vscode.commands.executeCommand(
    "setContext",
    "zhihu-fisher.sidebarDisguised",
    true
  );
  this.isCurrentlyDisguised = true;
}

// 退出伪装态：翻回 false
async showNormalViews() {
  await vscode.commands.executeCommand(
    "setContext",
    "zhihu-fisher.sidebarDisguised",
    false
  );
  this.isCurrentlyDisguised = false;
}
```

就这。整个侧边栏管理器再复杂，所有花活都收口到这两个调用上。

### 层 1：静态清单写好互斥条件

```jsonc
{ "id": "zhihuHotList",  "name": "热榜", "when": "!zhihu-fisher.sidebarDisguised" },
// …推荐 / 关注 / 搜索 / 收藏 同为 !zhihu-fisher.sidebarDisguised …
{ "id": "fakeFileList",  "name": "文件", "when":  "zhihu-fisher.sidebarDisguised" }
```

读这两行的人，一眼就能看懂可见性规则——`when` 表达式本身就是配置文档。这是声明式最大的红利。

## 心智模型：六步完整时序

把六个角色串起来——扩展、静态清单、上下文变量、真列表 provider、假文件树 provider、详情页管理器——一次切换是这样走的：

```
1. 扩展激活
   → 创建假文件树视图（数据已生成、provider 已注册）
   → setContext(变量, false)   // 强制复位，防重启残留

2. 用户点开一个知乎详情页
   → 详情页管理器触发界面伪装（失焦换皮那一拍）
   → 同步调用侧边栏钩子 onWebViewDisguised()

3. 侧边栏钩子校验功能开关 sidebarDisguiseEnabled
   → 通过 → showDisguiseViews() → setContext(变量, true)

4. 编辑器重算所有视图的 when
   → 真列表组（!变量）整体求值为 false → 隐藏
   → 假文件树（变量）整体求值为 true  → 浮现

5. 假文件树 provider.refresh() 重生成随机目录

6. 用户点假文件树里任一文件
   → 触发还原命令 onFakeFileClick
   → showNormalViews() → setContext(变量, false)
   → 编辑器重算 when → 真列表组回归
```

第 4 步是整段机制最关键的一拍：**你写的是「变量变了」，编辑器听成「视图组要换了」**。两组视图因为 `when` 互斥，永远不可能同时出现，所以切换是原子的——不会出现真列表刚消失、假文件树还没浮现的尴尬空窗。

## 假文件树 provider：常驻、靠变量控制显隐

前置章『侧边栏内容列表』已经讲透 TreeDataProvider 这套契约（`getTreeData` / `onDidChangeTreeData` / 状态化渲染）——本章不重复。这里只看它被反过来用的新侧面：**真列表 provider 永远在拉数据，假文件树 provider 也永远在位，两组同时活着，靠上下文变量决定谁露脸**。

```ts
initialize() {
  // 1. 一上来就把假视图创建好，挂在容器里
  vscode.window.createTreeView("fakeFileList", {
    treeDataProvider: this.fakeFileProvider,
    showCollapseAll: true,
  });

  // 2. 数据也即时生成一份
  this.fakeFileProvider.refresh();

  // 3. 强制把变量置回 false——防重启残留
  vscode.commands.executeCommand(
    "setContext", "zhihu-fisher.sidebarDisguised", false
  );
}
```

注意第 3 步那个看起来「多余」的复位。上下文变量在某些场景会被编辑器持久化到上次会话——你不强制清，用户重启编辑器后会看到一棵莫名其妙的假文件树杵在那儿，真列表全没了。这是「常驻 + 静态可见性」这一选择必然带来的清理负担。

## 与详情页伪装的联动：钩子式

侧边栏自己不主动监听焦点、不主动查 webview 状态。它只暴露三个语义钩子，由详情页管理器在合适的时机调：

```ts
class SidebarDisguiseManager {
  // 详情页一创建就调
  onWebViewCreated()    { /* 校验开关、准备进入伪装态 */ }

  // 详情页失焦换皮那一拍同步调
  onWebViewDisguised()  { /* 真正 setContext(true) */ }

  // 详情页关闭时调
  onWebViewClosed()     { /* 没有详情页了就 setContext(false) */ }
}
```

说人话就是：**侧边栏是被动的，详情页推什么事件它响应什么**。这种钩子式联动让两个管理器解耦——侧边栏不需要 import 详情页类型，详情页也不需要知道侧边栏怎么实现，双方只约定三个方法名。

### 「存在即伪装」 vs 「失焦才伪装」

这里有个有意的简化：是否恢复真列表，看的是「还有没有详情页开着」，而不是「详情页是否正被聚焦」。

```
判定时机      策略                          代价
按焦点判断 → 聚焦恢复 / 失焦伪装          侧边栏随焦点来回闪烁
按存在判断 → 有详情页就伪装 / 全关才恢复  阅读期间侧边栏一直处于伪装态
```

源码注释里写得明白：侧边栏视图整组切换比单个标签页换皮「重」（要重算 when、重建视图 DOM），按焦点来回切会明显闪烁；而详情页内的假代码刷新在前置章已用「按 webview 缓存」缓解。两者策略不同，根源是切换成本不同——**轻的切换可以频繁触发，重的切换要节流到状态变化点**。这是「按存在判断」这一选择的真正动机。

## 关键权衡

机制说完了，回头看「为什么这么设计」。这一章机制集中，四条权衡都值得展开。

### 权衡 1：声明式 `when` + `setContext` 翻转

**选择**：不去命令式地 show/hide 每个视图，而是用静态 `when` 条件 + 改一个上下文变量。

**换来**：
- 切换是原子的——两组视图因为 `when` 互斥，永远不可能同时出现，也不会出现空窗；
- 配置即文档——读 `when` 表达式一眼就懂可见性规则；
- 代码极简——整个切换逻辑就两行 `setContext` 调用。

**代价**：可见性逻辑被锁进**静态清单**。运行时不能动态增删视图类型（你想新增一个伪装视图，必须改 `package.json` 重发版），只能改上下文变量的值。换句话说，**「能换什么」是发版时定死的，「现在显示哪个」才是运行时的自由度**。

### 权衡 2：假文件树视图在初始化时就创建并常驻

**选择**：`initialize` 阶段就 `createTreeView`，provider 数据也即时生成，**而不是**按需创建/销毁。

**换来**：失焦瞬间切换无延迟——用户失焦那一刻，假视图早已就绪，编辑器只需让它「浮出」，不需要建实例、生成数据。整个伪装感是「无缝」的。

**代价**：即使你从不启用伪装，假文件树 provider 与视图也占一份内存；更麻烦的是**重启残留**——上下文变量可能被持久化，初始化时必须强制 `setContext(..., false)` 复位，否则会出现「重启后假树还显示着」的错乱。常驻换无缝，但常驻也意味着状态要自己管。

### 权衡 3：假文件树的文件类型 / 图标直接复用详情页伪装那套配置

**选择**：用户在设置里选的 `selectedDisguiseTypes`（存的是图标文件名，比如 `file_type_js.svg`），假文件树 provider 直接读出来用——先经「图标 → 语言」映射，再经「语言 → 扩展名」映射，最后用这些扩展名随机生成文件。

```ts
const selectedIconFiles = config.get<string[]>("selectedDisguiseTypes", []);
selectedIconFiles.forEach((iconFile) => {
  const languageType = ICON_TO_LANGUAGE_MAP[iconFile];
  if (languageType) languageTypes.push(languageType);
});
// 再用 languageTypes → 扩展名 → 随机生成假文件
```

**换来**：详情页假代码与侧边栏假文件用的是**同一套语言类型**，整组伪装风格一致。详情页换皮成 `auth.ts`，侧边栏假文件也主要是 `.ts` `.js`，老板看到的是一个「前后端一致的 TypeScript 项目」，而不是「详情页是 TS、侧边栏是 Python」的缝合怪。

**代价**：假树 provider 与详情页伪装管理器形成**隐式耦合**——双方共享同一份「图标 → 语言 → 扩展名」的映射语义，但没有任何类型层面的契约保证。改一边的映射表，另一边的假文件就跟着变，编译器不会提醒你。这是「同一份配置喂两边」必然带来的隐式约束。

### 权衡 4：「存在即伪装、全部关闭才恢复」

**选择**：判定是否恢复真列表看 `webviewMap.size > 0`，而不是看焦点。

**换来**：逻辑简单——一个布尔变量只在「首个详情页创建」和「最后一个详情页关闭」这两个边界翻转，不会随焦点抖动；用户阅读期间侧边栏稳定处于伪装态，不闪烁。

**代价**：阅读期间用户想看真列表，必须先关掉详情页，或主动点假文件触发还原（逃生口）。换句话说，**伪装优先于便利**——这是摸鱼工具该有的取舍，但确实牺牲了「想看一眼收藏夹」这种轻操作的可及性。

## 原理演示：一个能跑的最小扩展

按演示载体建议——VSCode 扩展这种依赖宿主的机制，演**机制骨架**就够。下面这段是一个能 `F5` 真跑的最小扩展包：静态 `contributes.views` 写两组互斥视图、`activate` 里一行 `setContext`、一条翻转命令、再加一个假 provider。演的就是权衡 1 和权衡 2 的灵魂。

### `package.json`（节选）

```jsonc
{
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "demo-sidebar", "title": "Demo", "icon": "icon.svg" }]
    },
    "views": {
      "demo-sidebar": [
        { "id": "realList",   "name": "真列表", "when": "!demo.disguised" },
        { "id": "fakeFileList","name": "假文件", "when":  "demo.disguised" }
      ]
    },
    "commands": [
      { "command": "demo.toggleDisguise", "title": "Toggle Disguise" }
    ],
    "menus": {
      "view/title": [{
        "command": "demo.toggleDisguise",
        "when": "view == realList || view == fakeFileList",
        "group": "navigation"
      }]
    }
  }
}
```

注意 `views` 里两个视图的 `when`：一个 `!demo.disguised`、一个 `demo.disguised`——同一变量、互斥条件，这就是「整组原子替换」的全部秘密。

### `extension.ts`（机制骨架）

```ts
import * as vscode from "vscode";

// —— 假文件树 provider：常驻、靠变量控制显隐 ——
class FakeFileProvider implements vscode.TreeDataProvider<string> {
  private readonly fakeFiles = [
    "src/auth.ts",
    "src/utils/handler.ts",
    "src/services/user.ts",
    "tests/auth.test.ts",
    "package.json",
  ];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  getTreeItem(name: string): vscode.TreeItem {
    const item = new vscode.TreeItem(name);
    item.command = {
      command: "demo.onFakeFileClick",
      title: "打开文件",
      arguments: [name],
    };
    return item;
  }
  getChildren(): string[] { return this.fakeFiles; }
}

export function activate(context: vscode.ExtensionContext) {
  // 1. 一上来就创建假视图 + 注册 provider（常驻）
  const provider = new FakeFileProvider();
  vscode.window.createTreeView("fakeFileList", { treeDataProvider: provider });

  // 2. 强制复位——防重启残留
  vscode.commands.executeCommand("setContext", "demo.disguised", false);

  // 3. 翻转命令：唯一改可见性的入口
  const toggle = vscode.commands.registerCommand(
    "demo.toggleDisguise",
    async () => {
      const now = context.globalState.get<boolean>("demo.disguised", false);
      const next = !now;
      context.globalState.update("demo.disguised", next);
      await vscode.commands.executeCommand("setContext", "demo.disguised", next);
      vscode.window.showInformationMessage(
        next ? "已切换到假文件树" : "已切回真列表"
      );
    }
  );

  // 4. 逃生口：点假文件即还原
  const onFakeClick = vscode.commands.registerCommand(
    "demo.onFakeFileClick",
    async () => {
      context.globalState.update("demo.disguised", false);
      await vscode.commands.executeCommand("setContext", "demo.disguised", false);
      vscode.window.showInformationMessage("已切回真列表");
    }
  );

  context.subscriptions.push(toggle, onFakeClick);
}
```

### 文字执行轨迹

跑起来后，按这个顺序操作，观察侧边栏：

```
1. F5 启动扩展开发主机
   → activate 执行
   → createTreeView(fakeFileList) 注册假视图（但 demo.disguised=false，不可见）
   → setContext(demo.disguised, false) 强制复位
   → 侧边栏只看到「真列表」视图

2. 点视图标题栏的 Toggle Disguise 按钮
   → toggle 命令执行
   → setContext(demo.disguised, true)
   → 编辑器重算 when：
       真列表 (!demo.disguised)  → false → 整组消失
       假文件 (demo.disguised)   → true  → 整组浮现
   → 侧边栏瞬间从「真列表」变成「src/auth.ts / src/utils/…」

3. 点假文件树里任一文件（比如 src/auth.ts）
   → onFakeFileClick 命令执行
   → setContext(demo.disguised, false)
   → 编辑器重算 when：
       真列表 → true → 回归
       假文件 → false → 消失
   → 侧边栏瞬间切回「真列表」
```

第 2 步和第 3 步是关键——你**看不到**真列表逐个消失、假文件树逐个浮现的过程。它们是**整组**同时切换的，因为编辑器对同一 `when` 表达式覆盖的所有视图一次性求值。这就是「原子切换」的字面意义。

## 故意省略的工程脚手架

为了把原理讲透，演示只保留了灵魂骨架。真仓库里还有这些配菜，原理上不重要、就没塞进来：

- **假文件树的随机目录生成**：固定骨架（src/components/utils/services/hooks…、tests、docs、public…）+ 概率可选目录（database/i18n/vendor/e2e…）+ 随机配置文件（package.json、Dockerfile…）——纯模板数据。
- **「图标 → 语言 → 扩展名」三段映射表**：30+ 语言条目，纯查表。
- **图标三级回退**：先用扩展资源目录下的真实 svg、取不到回退到内置主题图标（如 `file-typescript`）、再取不到用通用 `file` 图标。
- **未选则随机**：用户没配语言类型时，从一批常见语言里随机选 4–7 种，保证每次刷新树都不一样、看起来像不同项目。
- **联动钩子的细节实现**：`onWebViewCreated / onWebViewDisguised / onWebViewClosed` 在详情页管理器里的调用点。
- **配置变更监听、命令重复注册兜底、tooltip 文案、打赏入口项**等运营向内容。

## 章末小结

这一章要带走的不多，就两件事：

1. **声明式可见性 + 改上下文变量**是 VSCode 里做「整组视图替换」的正解——你只改一个布尔值，让编辑器自己去求值 `when`，整组原子切换，代码极简。
2. **常驻 + 复用配置**换来无缝与风格一致，但代价是状态要自己管（重启残留清理）、隐式耦合要自己扛（共享映射语义）、便利要让位伪装（存在即伪装）。

把「单个标签页换皮」和「整组侧边栏替换」合起来看：前者治一点、后者治一片，两者通过钩子式联动协同——失焦换皮那一拍同步触发侧边栏整组替换。摸鱼工具的隐蔽性，就在这种「点片面协同」里拼出来。

下一章『扩展激活与命令编排』会把这些散落的子系统——Store、侧边栏 provider、详情页管理器、伪装管理器——胶合到 `extension.activate` 这一个入口里，并集中声明全部命令与视图清单。这一章里出现的 `initialize`、钩子注册、命令挂载，会在那一章里被串成完整的装配流水线。