# 扩展激活与命令编排 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个 VSCode 扩展动辄几十条命令、五六个侧边栏视图、若干个共享服务。若不加约束：每条命令各自去 new 自己要用的服务、各自把「用完要回收的句柄」随手塞进某个数组、配置改了各想各的办法刷新——很快「谁创建了什么、谁负责清理什么」就全靠人脑记，停用时必然泄漏（浏览器没关、webview 没销毁）。我们需要一个统一的「开机接线」与「关机拔线」约定。

- **一句话核心思想**：在唯一的激活入口里把所有对象装配好、用普通函数参数注入下去，每个命令组只回吐一批「可销毁句柄」由入口统一登记进宿主——**组合根装配，统一销毁**。

- **设计动机（为什么需要它）**：这个机制是为了解决「对象图的构造与生命周期管理该集中还是分散」这个矛盾。集中构造换来「一眼看清整个扩展依赖了谁」的可读性与「停用时一处回收、绝不泄漏」的确定性；代价是激活入口成了一个无所不知的「装配函数」。它换来的能力是：新增一个子系统时，只要照着既定套路写一个「接收依赖、回吐句柄」的注册函数，就能自动接进统一的生命周期，不必动到其他子系统。
  - **承前（跨章去重信号）**：
    - 全局共享状态容器（已在第 1 章『全局共享状态容器』讲透）——本章只看它的新侧面：**组合根是那个把扩展上下文「种」进全局容器的唯一赋值点，也是停用时把它清空的唯一回收点**；不重讲容器本身的可变单例设计。
    - 侧边栏内容列表（已在第 5 章『侧边栏内容列表』讲透）——本章只看它的新侧面：**数据源实例在哪里被创建、怎样被绑定到视图、视图句柄又怎样回灌给数据源**；不重讲 provider 内部如何 fetch+cheerio 解析列表。
    - 扫码登录 / 收藏 / 详情页渲染 / 侧边栏伪装（均已在各自前置章讲透）——本章只看它们的**注册签名**：一个命令组声明它需要哪几个依赖，恰恰暴露了它运行时的数据依赖（例如登录命令组要拿全五个列表提供者，正是因为登录成功后要逐一刷新它们）。

- **关键权衡（本 Atlas 的核心）**：
  1. **集中装配（组合根）**：选择「只在激活入口里 new 对象、其余地方一律靠参数接收」→ 换来「整个对象图集中在一处可读、无散落的隐式构造」→ 代价是「激活入口成了一个知道所有子系统的胖函数，每加一个子系统都要回来改它」。
  2. **命令组只回吐句柄、不碰宿主上下文（依赖倒置）**：选择「每个注册函数不接收宿主上下文，只把自己注册得到的句柄装进数组返回，由总注册函数统一登记进宿主」→ 换来「注册函数与宿主解耦、可脱离宿主单独理解与测试、所有命令享同一套销毁契约」→ 代价是「多一道『收集→摊平→登记』的编排步骤，且『返回数组』这个约定略反直觉」。
  3. **双依赖通道**：选择「重要的大对象（服务、各列表提供者）走显式参数注入，而轻量的全局上下文/容器走全局单例直接取」→ 换来「不必把每个单例都长长地列进参数表，又保住了关键对象图的显式可读」→ 代价是「同一套代码里存在两种耦合风格（一半显式注入、一半隐式全局），新读者要分清哪些依赖该走哪条路」。
  4. **配置变更只重绘、不重取**：选择「纯外观类配置（图片显示模式/缩放）变更时只触发列表『重新渲染』而非『重新拉取』」→ 换来「一次纯视觉调整不消耗珍贵的登录 Cookie、不触发反爬限流」→ 代价是「每个列表提供者要多维护一条『只刷新视图、不联网』的代码路径」。

- **最小心智模型（3～7 步）**：
  1. 宿主启动扩展，把「扩展上下文」（内含一张空的可销毁句柄清单）交给激活入口。
  2. 激活入口先把上下文登记进全局共享容器，让所有子系统都能拿到它。
  3. 激活入口逐个创建各侧边栏数据源，把每个绑定到对应视图，再把视图句柄回灌给该数据源。
  4. 激活入口创建核心服务实例（构造时顺带加载已存凭证）。
  5. 把这些大对象打包成一个「依赖对象」，调用总的注册函数。
  6. 总注册函数按命令组分发：每个命令组函数只收自己需要的那几个依赖，注册自己的命令，交回一批可销毁句柄。
  7. 总注册函数把所有命令组交回的句柄摊平成一张总清单，统一登记进宿主那张可销毁清单——停用时宿主自动逐一销毁，扩展无需自己记账。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的独立脚本，伪造一个「迷你宿主」——伪造的扩展上下文（带一个空数组当可销毁清单）+ 伪造的注册命令函数（返回一个带 `dispose` 的句柄）。然后写迷你 `activate`：创建两个假数据源 → 调用 `registerAll(假context, {a, b})` → `registerAll` 内部把 `registerA(a)` 与 `registerB()` 各自返回的句柄数组摊平、push 进清单。最后模拟 `deactivate`：遍历清单逐个 `dispose`，打印回收日志。**这段演示演的是权衡 2（命令组只回吐句柄、由总函数统一登记）+ 步骤 6/7（分发→摊平→统一销毁）**。
  - 应故意省略：真实 VSCode API、每条命令的真实业务、列表提供者内部、配置监听、伪装、扫码登录等一切旁路与集成。
  - **演示载体建议**：本章是 VSCode 扩展、机制依赖宿主时序，**建议写成一段独立 TS/JS 脚本（可 `bun run`/`node` 直接跑），用伪造的「迷你宿主」演透「激活→分发注册→摊平句柄→统一销毁」这条骨架**，不强求真跑扩展——因为重点是接线的形状，不是 VSCode 本身。

- **正文不宜展开的细节**：每条命令的具体业务逻辑（共数十条）；扫码登录的浏览器上下文/二维码截图/轮询全流程（属前置章）；收藏夹三级树与游标分页；详情页 HTML 渲染与 postMessage；伪装引擎与假文件树；`package.json` 里 65 条命令逐条列举——这些只需点到「它们各自被一个注册函数收敛」即可，不展开。

- **推荐的一个执行轨迹例子**：
  - 输入：用户启用扩展，宿主调用激活入口，传入扩展上下文（其可销毁清单为空）。
  - 关键中间态：① 全局容器拿到上下文；② 五个侧边栏数据源被实例化并各自绑定到视图、回灌视图句柄；③ 核心服务实例化并加载凭证；④ 总注册函数被调用，十三个命令组各自交回若干句柄，被摊平成一张总清单（约六十余条）；⑤ 该清单被逐一登记进扩展上下文。
  - 输出：所有命令可在命令面板/菜单中触发并正确路由；扩展停用时，宿主遍历清单把全部句柄一并回收——扩展无需自己记着「我创建了什么」。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **激活入口是唯一的组合根**：`activate(context)` 是全仓库唯一一处实例化子系统并接线的地方。它先 `Store.context = context` 把上下文种入全局容器，再 `new ZhihuService()`（构造函数内同步加载已存 Cookie），再逐个 new 五个列表提供者并绑定视图，最后把大对象打包传给总注册函数。源码位置: src/extension.ts:12-23, 100-107
- **数据源 ↔ 视图的绑定与回灌**：每个列表提供者走「new → 用视图 id 创建 TreeView → `provider.setTreeView(treeView)`」三步，把视图句柄回灌给提供者（提供者后续要用它刷新/重新渲染）。五个视图 id 与 `package.json` 声明一一对应。源码位置: src/extension.ts:26-66
- **showCollapseAll 的差异化**：四个扁平列表（推荐/关注/热榜/搜索）`showCollapseAll: false`，唯有收藏夹（三级树）为 `true`——视图形态决定了折叠按钮是否出现。源码位置: src/extension.ts:27-65
- **总注册函数的依赖对象签名**：`registerAllCommands(context, dependencies)` 的 `dependencies` 是一个类型化对象，精确列出 6 个大对象（核心服务 + 五个列表提供者）。这是「对象图」的声明式快照。源码位置: src/core/commands/index.ts:27-37
- **统一生命周期登记**：总注册函数把 13 个注册函数各自返回的 `Disposable[]` 用展开运算符摊平成一张 `subscriptions` 总清单，再 `forEach` 逐个 `push` 进 `context.subscriptions`——所有命令因此共享同一套销毁契约，停用时由宿主自动回收。源码位置: src/core/commands/index.ts:41-60
- **注册函数的统一形态**：每个 `registerX(...)` 都遵循「建空数组 → 逐个 `registerCommand` 并 push → return 数组」。它们**不接收** context，只回吐句柄——与宿主解耦。源码位置: src/core/commands/hot.ts:8-19
- **依赖注入的三种签名形态（暴露运行时数据依赖）**：13 个注册函数按需收参——6 个零依赖（媒体/通用/关于/浏览器/webview/webview导航）、5 个收单个列表提供者（热榜/搜索/收藏/推荐/关注）、1 个收五个提供者（扫码登录，因登录后要刷全部列表）、1 个收「服务+五个提供者」（Cookie，因设/清 Cookie 后要联动刷新全部列表）。**签名本身就是依赖关系的文档**。源码位置: src/core/commands/index.ts:41-55
- **配置变更的两类响应**：`onDidChangeConfiguration` 监听 `zhihu-fisher.*`。外观类（`mediaDisplayMode`/`miniMediaScale`）变更 → 调五个提供者的 `refreshView()`（只重新触发渲染、**不联网**）；`debugMode` 变更 → 弹提示让用户重启扩展（并转发到 `restartExtension` 命令）。源码位置: src/extension.ts:69-98
- **停用入口的统一回收**：`deactivate()` 调静态 `ZhihuService.cleanup()`——关闭所有 webview、清空全局容器的各 map/list、关闭浏览器实例、清空上下文。注意命令句柄的回收其实由宿主遍历 `context.subscriptions` 自动完成，这里清的是「容器里残留的可变状态与外部进程」。源码位置: src/extension.ts:111-119；cleanup 实现: src/core/zhihu/index.ts:27-52
- **双依赖通道的确证**：大对象（服务/提供者）走显式参数注入；而轻量全局态走直接 import——例如媒体命令里直接 `import { Store }` 取 `Store.context.extensionUri`，不经参数。两种耦合风格并存于同一套命令代码。源码位置: src/core/commands/media.ts:2, 134
- **声明与实现的分离**：`package.json` 静态声明 65 条命令 + 6 个视图（5 真 + 1 假文件树），代码侧才把命令 id 绑到 handler、把视图 id 绑到提供者。视图带 `when: "!zhihu-fisher.sidebarDisguised"`（假文件树带正向条件）——这是侧边栏伪装章的 when 条件在此处的声明。`activationEvents` 为空数组（现代 VSCode 依 contributed 视图/命令隐式激活）。源码位置: package.json（contributes.views / commands / activationEvents）

## 关键调用链

激活时序（主线）：

```
activate(context)
 ├─ Store.context = context                         [种入全局容器]
 ├─ SidebarDisguiseManager.getInstance().initialize(context)   [伪装管理器自启，fire-and-forget]
 ├─ new ZhihuService()                              [构造时 CookieManager.loadCookie()]
 ├─ 5× { new XxxListDataProvider(); createTreeView(viewId, {treeDataProvider}); provider.setTreeView(view) }
 ├─ onDidChangeConfiguration("zhihu-fisher.*") → refreshView() / 提示重启
 └─ registerAllCommands(context, {zhihuService, sidebarHot, sidebarRecommend, sidebarFollow, sidebarSearch, sidebarCollections})
       ├─ 13× registerX(各自依赖) → 各返回 vscode.Disposable[]
       ├─ 展开摊平为 subscriptions[]
       └─ subscriptions.forEach(c => context.subscriptions.push(c))   [统一登记]

deactivate()
 └─ ZhihuService.cleanup()  [静态：关 webview → 清 Store 各 map/list → 关浏览器 → Store.context=null]
```

源码位置: src/extension.ts:12-108（activate）、src/extension.ts:111-119（deactivate）、src/core/commands/index.ts:27-61（registerAllCommands）

## 源码摘录（带行号，全文累计 ≤ 30 行）

组合根：把装配好的大对象打包成依赖对象，调用总注册函数（演权衡 1「集中装配」）：

```ts
// src/extension.ts:100-107
  registerAllCommands(context, {
    zhihuService,
    sidebarHot,
    sidebarRecommend,
    sidebarFollow,
    sidebarSearch,
    sidebarCollections,
  });
```

总注册函数：13 个注册函数各自回吐 `Disposable[]`，摊平成一张总清单后统一登记进宿主（演权衡 2「命令组只回吐句柄、不碰 context」+ 步骤 6/7）：

```ts
// src/core/commands/index.ts:41-60
  const subscriptions = [
    ...registerHotCommands(sidebarHot),
    ...registerMediaCommands(),
    ...registerGeneralCommands(),
    ...registerSearchCommands(sidebarSearch),
    ...registerBrowserCommands(),
    ...registerWebviewCommands(),
    ...registerWebviewNavigationCommands(),
    ...registerQRLoginCommands(sidebarHot, sidebarRecommend, sidebarFollow, sidebarSearch, sidebarCollections),
    ...registerCookieCommands(zhihuService, sidebarHot, sidebarRecommend, sidebarFollow, sidebarSearch, sidebarCollections),
    ...registerCollectionCommands(sidebarCollections),
    ...registerRecommendCommands(sidebarRecommend),
    ...registerFollowCommands(sidebarFollow),
    ...registerAboutCommands()
  ];

  // 将所有命令添加到订阅中
  subscriptions.forEach(command => {
    context.subscriptions.push(command);
  });
```

单个注册函数的规范形态（演「签名即依赖文档」：收什么、回什么）：

```ts
// src/core/commands/hot.ts:8-9
export function registerHotCommands(sidebarHot: sidebarHotListDataProvider): vscode.Disposable[] {
  const commands: vscode.Disposable[] = [];
```

## 易混淆 / 边界 / 推断

- **事实**：伪装管理器的初始化是 `activate` 里唯一的「fire-and-forget」调用——`SidebarDisguiseManager.getInstance().initialize(context).catch(...)`，不 await，不阻塞激活。源码位置: src/extension.ts:18-20
- **事实（集中模式的例外）**：绝大多数命令经 `registerAllCommands` 统一登记；但 `SidebarDisguiseManager` 在自己的 `initialize()` 里**自行注册**了若干命令（grep 显示该文件有 3 处 `registerCommand`），绕过了总注册函数。这是「组合根集中装配」原则的一个现实破口，说明伪装子系统选择了「自带命令、自管生命周期」的半自治设计。源码位置: src/core/utils/sidebar-disguise-manager.ts（3 处 registerCommand）
- **事实**：`restartExtension` 命令在 `about.ts` 注册（不在 general.ts），其实现是转发到 VSCode 内置的 `workbench.action.restartExtensionHost`；`extension.ts` 与 `qr-login.ts`、`browser.ts` 都只是调用方。源码位置: src/core/commands/about.ts:112-135
- **事实**：`refreshView()`（只重渲染）与 `refresh()`（重新联网拉取）是两个不同方法，配置变更特意选前者以省 Cookie；这与列表提供者章的「列表故意用轻量 fetch」一脉相承。源码位置: src/extension.ts:78-82
- **推断（标注为推断）**：把依赖收敛成一个类型化 `dependencies` 对象、而非长参数列表，应该是为了在新增子系统时只改对象类型而不破坏既有调用顺序——但仓库内仅此一处使用，无法证实是否为刻意设计。
- **推断（标注为推断）**：`deactivate` 只清「容器可变状态 + 外部进程」，不清命令句柄，推断是因为作者信任宿主会自动遍历 `context.subscriptions` 回收——这与权衡 2「统一销毁契约」一致。
- **未理解**：`activationEvents` 为空数组时 VSCode 的确切激活时机（是否完全依赖 contributed 视图/命令的隐式激活、与 `onStartupFinished` 的关系）未在源码层面证实，仅按现代 VSCode 惯例推断。