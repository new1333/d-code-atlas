# 侧边栏伪装成假文件树 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用编辑器摸鱼看知乎时，侧边栏那一排「推荐 / 热榜 / 关注 / 搜索 / 收藏」视图赫然在目——老板从背后走过，光看侧边栏就知道你在摸鱼。详情页标签页能换皮，但侧边栏这整组视图该怎么一起藏起来？手动一个个隐藏既慢又会留痕迹。

- **一句话核心思想**：用一个布尔值翻转一个「上下文变量」，让编辑器自己根据静态声明的条件，把整组侧边栏视图原子地替换掉——真列表消失、假文件树顶上。

- **设计动机（为什么需要它）**：编辑器的视图可见性不是在代码里 `show/hide` 出来的，而是由静态清单里的条件表达式（`when`）决定的；运行时唯一能动的，是去改这些表达式所依赖的「上下文变量」。本章正是把前置章建立的伪装语言/图标配置，从「详情页内部换皮」扩展到「整个侧边栏整组替换」，让伪装跨出 WebView、波及编辑器的视图容器。（已在第 10 章『智能伪装引擎』讲透「按语言生成真实感文件名 / 假代码」的核心生成逻辑与「稳定不闪 vs 每次随机」的权衡，本章只看它的新侧面：如何借上下文变量驱动编辑器原生的声明式视图显隐，把伪装范围从单个标签页扩到整组侧边栏。）同时复用了 TreeDataProvider 这套数据源契约——（已在第 5 章『侧边栏内容列表』讲透「TreeDataProvider + 事件驱动刷新 + 状态化渲染」，本章只看它被反过来当作「一次性假面具 provider」的新用法：provider 始终在位，靠上下文变量控制它露不露脸）。

- **关键权衡（本 Atlas 的核心）**：
  1. **声明式 `when` 条件 + `setContext` 翻转** → 换来「无需手动逐个 show/hide 视图、切换是原子的、可见性规则本身就是配置文档」 → 代价是可见性逻辑被锁进静态清单，运行时不能动态增删视图类型，只能改上下文变量的值。
  2. **假文件树视图在初始化时就创建并常驻**（而不是按需创建 / 销毁）→ 换来「失焦瞬间切换无延迟、provider 数据已就绪」 → 代价是即使不伪装也占一份 provider 与视图内存，且必须额外处理「重启后上下文变量残留、假树还显示着」的清理（初始化时强制把变量置回假）。
  3. **假文件树的文件类型 / 图标直接复用详情页伪装那套配置** → 换来「详情页假代码与侧边栏假文件用的是同一套语言类型，整组伪装风格一致」 → 代价是假树 provider 与详情页伪装管理器形成隐式耦合（共享同一份「图标 → 语言 → 扩展名」的映射语义）。
  4. **「只要有详情页打开就伪装侧边栏、全部关闭才恢复」**（而不是「失焦才伪装、聚焦就恢复」）→ 换来「逻辑简单、不会随焦点来回闪烁」 → 代价是阅读期间侧边栏一直处于伪装态，用户想看真列表必须先关掉详情页，或主动点假文件触发还原。

- **最小心智模型（6 步）**：
  1. 扩展激活时，预先创建好「假文件树」视图（数据已生成、注册完毕），但此时上下文变量为假，所以它不可见。
  2. 静态视图清单里，真列表组绑定「变量为假时显示」，假文件树绑定「变量为真时显示」——两组条件互斥。
  3. 用户点开一个知乎详情页（或详情页触发界面伪装），侧边栏的联动钩子被调用。
  4. 钩子校验功能开关通过后，执行一条内置命令，把上下文变量翻为真。
  5. 编辑器据此重新求值所有视图的 `when` 条件：真列表组整体消失、假文件树整体浮现。
  6. 用户点假文件树里任意一项 → 触发还原命令 → 变量翻回假 → 真列表回归。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个最小扩展骨架——`package.json` 的 `views` 里放两个视图，一个 `when` 写 `!demo.disguised`、一个写 `demo.disguised`；`activate` 里先 `setContext('demo.disguised', false)`；注册一条命令把它翻成 `true`、再让假视图里的项点击后翻回 `false`。这段演示演的是权衡①「声明式 `when` + `setContext` 翻转整组」与权衡②「视图常驻、靠变量控制显隐」。
  - 应故意省略：假文件树的随机目录生成、图标 svg 映射表、与详情页伪装的联动钩子细节、配置变更监听、命令重复注册防护等工程脚手架。
  - 演示载体建议：本章主语言是 TS、机制依赖 VSCode 扩展宿主。建议演**机制骨架**：一个能 `F5` 真跑的最小扩展包（静态 `contributes.views` + `activate` 里一行 `setContext` + 一条翻转命令）即可演透「上下文变量驱动声明式视图显隐」这一灵魂；不必搬整套假树生成器，那是配菜。一句话原则：载体服务于「演透原理」，不是服务于「还原全部功能」。

- **正文不宜展开的细节**：「图标文件名 → 语言 → 扩展名」三段映射表（30+ 语言条目，纯数据查表）；假文件树的具体目录骨架（src/components/utils/services… 纯模板）；`safeRegisterCommand` 的重复注册兜底；tooltip 文案、打赏入口项等运营向内容。

- **推荐的一个执行轨迹例子**：输入——用户已开启侧边栏伪装开关，点开一个知乎详情页。中间态——联动钩子触发 → 开关校验通过 → 执行 `setContext(变量, true)` → 编辑器重算 `when` → 5 个知乎视图整组隐藏、假文件树浮现并刷新出一棵随机目录。输出——老板看到的侧边栏是一棵「src/components/auth.ts、utils/handler.js…」的项目文件树；用户点其中任一文件 → 变量翻回 `false` → 知乎列表回归。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **视图可见性是声明式的，不是命令式的**：同一视图容器下注册了 6 个视图——5 个知乎列表（推荐/关注/热榜/搜索/收藏）的可见条件是 `!zhihu-fisher.sidebarDisguised`，假文件树的条件是 `zhihu-fisher.sidebarDisguised`。两组互斥，一个变量一翻，整组原子切换。源码位置: package.json:367-412

- **运行时只能改「上下文变量」，改不了视图清单**：切换可见性的唯一手段是内置命令 `setContext`，把 `zhihu-fisher.sidebarDisguised` 在 `true/false` 间翻转。代码里没有任何「显示 A、隐藏 B」的指令，全是改变量、让编辑器自己去求值 `when`。源码位置: src/core/utils/sidebar-disguise-manager.ts:82-103（翻 true）、108-125（翻 false）

- **假视图「先注册、常驻、靠变量显隐」**：`initialize` 阶段就 `createTreeView("fakeFileList", …)` 把假文件树视图创建好并挂在容器里，数据 provider 也即时生成；它是否被看见只取决于上下文变量。这是权衡②的来源。源码位置: src/core/utils/sidebar-disguise-manager.ts:37-42

- **重启残留清理**：初始化结尾强制 `setContext(..., false)`，原因是上下文变量在某些场景会被编辑器持久化到上次会话，不强制复位会出现「重启后假树还显示着」的错乱。源码位置: src/core/utils/sidebar-disguise-manager.ts:64-70

- **逃生口设计——点假文件 = 解除伪装**：假文件树里每一个文件项的 `command` 都指向 `onFakeFileClick`，它的实现就是调 `showNormalViews()`（把变量翻回 false）。伪装是给旁人看的，用户自己随时一键还原。源码位置: src/core/utils/sidebar-disguise-manager.ts:197-207、src/core/utils/file-list-provider.ts:690-703

- **与详情页伪装的联动是「钩子式」的**：侧边栏管理器暴露三个语义钩子 `onWebViewCreated / onWebViewDisguised / onWebViewClosed`，由详情页管理器在合适时机调用，侧边栏自己不主动监听焦点。源码位置: src/core/utils/sidebar-disguise-manager.ts:243-302

- **联动时机**：详情页管理器在「创建详情页」时调 `onWebViewCreated`；在「触发详情页界面伪装」（即失焦换皮那一拍，且详情页伪装开关已开）时同步调 `onWebViewDisguised`；在关闭时调 `onWebViewClosed`。源码位置: src/core/zhihu/webview/index.ts:224-230、140-152、3139-3140

- **「存在即伪装」的简化判定**：是否恢复真列表，看的是「还有没有详情页开着」（`Store.webviewMap.size > 0`），而不是「详情页是否正被聚焦」。全部关闭才还原。源码注释明确记录了从「按焦点判断」简化为「按存在判断」的取舍。源码位置: src/core/utils/sidebar-disguise-manager.ts:294-311

- **假文件树复用详情页伪装的语言配置**：用户在设置里选的 `selectedDisguiseTypes`（存的是图标文件名，如 `file_type_js.svg`）被假树 provider 读出，先经「图标 → 语言」映射，再经「语言 → 扩展名」映射，最后用这些扩展名随机生成文件。映射表与详情页伪装同源（文件头注释自述「从 disguise-manager 导入」）。源码位置: src/core/utils/file-list-provider.ts:9-42、57-98、354-398

- **未选则随机**：若用户没配置语言类型，从一批常见语言里随机选 4–7 种，保证每次刷新树都不一样、看起来像不同项目。源码位置: src/core/utils/file-list-provider.ts:378-398

- **假树结构 = 固定骨架 + 概率可选目录 + 随机配置文件**：顶层固定有 src（含 components/utils/services/hooks/…）、tests、docs、public、config、scripts；再按概率追加 database/i18n/vendor/e2e 等可选目录；最后随机挑 3–5 个常见配置文件（package.json、Dockerfile…）。源码位置: src/core/utils/file-list-provider.ts:157-280、507-615

- **图标三级回退**：假文件图标先用扩展资源目录下的真实 svg（`resources/fake/*.svg`），取不到回退到编辑器内置主题图标（如 `file-typescript`），再取不到用通用 `file` 图标。源码位置: src/core/utils/file-list-provider.ts:708-863

- **功能开关与依赖关系**：侧边栏伪装有独立开关 `sidebarDisguiseEnabled`，且**依赖详情页伪装**——启用侧边栏伪装的命令会先校验详情页伪装（`enableDisguise`）是否已开，否则拒绝并提示。源码位置: src/core/commands/general.ts:132-159、package.json:955-959

- **单例**：`SidebarDisguiseManager` 是模块级单例，详情页管理器、命令注册、扩展入口都通过 `getInstance()` 拿同一个实例来调用钩子。源码位置: src/core/utils/sidebar-disguise-manager.ts:9-23、src/extension.ts:18

## 关键调用链

激活与切换核心链：
`extension.activate()` → `SidebarDisguiseManager.initialize()` → 创建假视图 + 注册命令 + `setContext(变量, false)` →（待命）
源码位置: src/extension.ts:18、src/core/utils/sidebar-disguise-manager.ts:28-77

失焦联动链（核心权衡①③的舞台）：
`详情页.onDidChangeViewState`（失焦/切换触发详情页伪装）→ `SidebarDisguiseManager.onWebViewDisguised()` → 开关校验 → `showDisguiseViews()` → `setContext(变量, true)` → 编辑器重算 `when` → 知乎视图组隐藏、`fakeFileList` 浮现 → `fakeFileProvider.refresh()` 重生成随机树
源码位置: src/core/zhihu/webview/index.ts:140-152 → src/core/utils/sidebar-disguise-manager.ts:268-289、82-103 → src/core/utils/file-list-provider.ts:149-152

还原链（逃生口）：
用户点假文件 → 文件项 `command: onFakeFileClick` → `showNormalViews()` → `setContext(变量, false)` → 编辑器重算 `when` → 知乎视图组回归
源码位置: src/core/utils/file-list-provider.ts:690-703 → src/core/utils/sidebar-disguise-manager.ts:197-207、108-125

## 源码摘录（带行号，全文累计 ≤ 30 行）

翻转上下文变量（切换的唯一实质动作）——`showDisguiseViews` 核心：
```ts
// src/core/utils/sidebar-disguise-manager.ts:88-93
await vscode.commands.executeCommand(
  "setContext",
  "zhihu-fisher.sidebarDisguised",
  true
);
this.isCurrentlyDisguised = true;
```

声明式互斥条件（整组替换的本质）——静态清单：
```jsonc
// package.json:383-411（节选对照）
{ "id": "zhihuHotList",      "name": "热榜", "when": "!zhihu-fisher.sidebarDisguised" },
// …推荐/关注/搜索/收藏 同为 !zhihu-fisher.sidebarDisguised …
{ "id": "fakeFileList",      "name": "文件", "when": "zhihu-fisher.sidebarDisguised" }
```

逃生口——点假文件即还原：
```ts
// src/core/utils/sidebar-disguise-manager.ts:197-206
this.safeRegisterCommand("zhihu-fisher.onFakeFileClick",
  async (filename: string) => {
    // 用户点击伪装文件时恢复正常侧边栏
    await this.showNormalViews();
    vscode.window.showInformationMessage("已切换回知乎列表", { modal: false });
  }),
```

假文件项的 command 绑定（每个假文件都指向还原命令）：
```ts
// src/core/utils/file-list-provider.ts:690-703（节选）
return {
  label: name, type: "file", extension: extension,
  iconPath: this.getFileIcon(name, extension),
  contextValue: "fakeFile",
  command: { command: "zhihu-fisher.onFakeFileClick", title: "打开文件", arguments: [name] },
};
```

复用详情页伪装的语言配置（图标文件名 → 语言）：
```ts
// src/core/utils/file-list-provider.ts:356-365
const selectedIconFiles = config.get<string[]>("selectedDisguiseTypes", []);
if (selectedIconFiles && selectedIconFiles.length > 0) {
  selectedIconFiles.forEach((iconFile) => {
    const languageType = ICON_TO_LANGUAGE_MAP[iconFile];
    if (languageType) { languageTypes.push(languageType); }
  });
}
```

## 易混淆 / 边界 / 推断

- **事实：配置默认值存在代码与清单不一致**。代码里读取时写的是 `config.get("sidebarDisguiseEnabled", true)`（fallback 为 true，源码位置: src/core/utils/sidebar-disguise-manager.ts:31-34），但 `package.json` 的 `configuration` 声明该字段 `default: false`（package.json:955-959）。以清单声明为准——新装用户默认**关闭**侧边栏伪装；代码里的 `true` 仅在配置项完全缺失时才生效，正常情况下不会命中。

- **事实：`initialize` 内有一处疑似 bug——配置变更监听里读取 `newState` 用的是闭包里旧的 `config` 引用**（在 `onDidChangeConfiguration` 回调中直接 `config.get(...)`，而非重新 `getConfiguration`）。由于 `Configuration` 对象在 VSCode 内部是会反映最新值的代理，多数情况下仍能拿到新值，但这是潜在的脆弱点。源码位置: src/core/utils/sidebar-disguise-manager.ts:52-62

- **事实：`onWebViewCreated` 与 `onWebViewDisguised` 内部都各自重新 `getConfiguration` 读了一次 `sidebarDisguiseEnabled`**，与实例字段 `isDisguiseEnabled` 形成双重判定（字段 + 实时配置）。推断：这是为了在配置刚被改、字段尚未同步时仍能拿到最新值，属于防御性冗余。源码位置: src/core/utils/sidebar-disguise-manager.ts:243-289

- **推断：选择「存在即伪装」而非「失焦才伪装」**，是因为侧边栏视图整组切换比单个标签页换皮「重」（要重算 when、重建视图 DOM），按焦点来回切换会明显闪烁；而标签页内的假代码刷新在前置章已用「按 webview 缓存」缓解。两者策略不同，根源是切换成本不同。源码位置: src/core/utils/sidebar-disguise-manager.ts:304-311（注释自述策略演变）

- **事实：假文件树里混入了两个「非伪装」功能项**——`zhihu-fisher.tips`（点击还原，command 指向 `onFakeFileClick`）和 `zhihu-fisher.buymecoffee`（打赏入口，command 指向 `buyMeCoffee`），挂在顶层 `zhihu-fisher` 文件夹下。即伪装态下仍保留了「还原提示」与「作者引流」两个出口。源码位置: src/core/utils/file-list-provider.ts:162-167、302-349

- **未理解**：`onWebViewDisguised` 在 `webview/index.ts` 中有两处调用点（146 行的失焦联动、3475 行的另一处），3474-3475 那一处未深入读取其触发上下文（疑为设置面板内手动切换详情页伪装时的同步触发），不影响本章主链理解，留给后续核对。