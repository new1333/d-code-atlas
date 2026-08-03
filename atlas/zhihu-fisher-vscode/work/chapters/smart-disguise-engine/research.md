# 智能伪装引擎 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用 VSCode 看知乎的人最怕的不是被知乎封，而是被路过的同事/老板瞄到「咦你那个标签页怎么在刷知乎」。原生扩展一旦把知乎文章塞进 webview，标签页标题和内容都是赤裸裸的中文——一秒露馅。这里的诉求是：当我视线一离开这个标签页（切走、失焦），它就该瞬间变成一个「正在被编辑的代码文件」，标题像代码文件名、图标像代码文件图标、内容像一屏高亮代码；等我切回来，它又秒变回知乎。而且变得要「稳」，不能每次切走都换一个名字闪来闪去，反而更招眼。

- **一句话核心思想**：**身份（文件名/图标）一次性确定并冻结，内容（假代码）每次重画**——标签条上永远稳定不闪，叠层里却看着像在持续被编辑。

- **设计动机（为什么需要它）**：这个机制要解决的矛盾是「稳定」与「鲜活」天生打架——标签页标题若每次失焦都重新随机，会在 OS 层不停重绘、反而更显眼；可假代码若永远一成不变，瞄第二眼就发现是死的。于是把伪装拆成两层、给两层不同的更新策略。**承前**：它复用了全书第 1 章『全局共享状态容器』建立的那个模块级单例 Store——但本章只看它的新侧面：**作为只读的「扩展资源定位器」被一个纯静态工具类借用**（拼图标路径时取扩展根 URI），它不参与可变状态通信，也没新增缓存职责（伪装缓存是工具类自带的另一张 Map，不进 Store）。（已在第 1 章『全局共享状态容器』讲透模块级单例本身，本章只看它被静态工具类只读借用的这一面。）

- **关键权衡（核心原料）**：
  1. **身份缓存 ↔ 内容重生成**：做了「标签页身份按页面缓存、命中即原样复用」的选择 → 换来标签条上标题/图标稳定不闪、不招眼 → 代价是同一个页面永远顶着同一个假文件名（不够「随机」），且要在导航到新文章时记得显式清缓存换身份。
  2. **全局轮转模板索引 ↔ 仅 token 随机**：做了「代码骨架按调用次数取模轮转、而非每行纯随机」的选择 → 换来结构可信（不会出现五个连续右大括号、或 import 接 import 的鬼畜序列），骨架天然像 `导入→类→方法` 的真实程序 → 代价是骨架其实是确定性的、两次渲染结构会重合（但因为内容叠层只有主动看才见、且 token 每次随机，这点不致命）。
  3. **预烤着色 span ↔ 手写海量模板**：做了「不接真实语法高亮引擎、直接吐出编辑器自带的语法着色 CSS 类名」的选择 → 换来像素级还原真实编辑器观感、且 webview 零运行时依赖（只需自带类名→颜色映射）→ 代价是每种语言都得手写一组模板闭包（整个生成器上千行重复代码），且生成的「代码」细看并不构成可运行程序。
  4. **两层各自独立触发 ↔ 半伪装中间态**：做了「标题/图标层每次失焦恒触发、代码叠层按开关显式触发」的选择 → 换来标题层零延迟恒生效、叠层可由用户按需开关 → 代价是两层稳定性策略与默认值不一致，存在「标题已伪装但内容还是知乎」的中间态，且同一个开关在不同读取点默认值不同（一处默认开、多处默认关），是后续排查时的认知陷阱。

- **最小心智模型（3～7 步）**：
  1. 宿主为每个打开的知乎 webview 分配唯一标识。
  2. 用户切走（面板失焦）→ 宿主触发「视图状态变化」事件。
  3. 伪装管理器按标识查缓存：命中直接复用既有文件名+图标；未命中则从「语言表」里按用户勾选过滤、随机抽一种语言，再从该语言的三组词池（前缀/名/扩展名）各随机取一个拼成文件名，图标指向该语言对应的内置图标，结果写回缓存。
  4. 宿主把标签页标题与图标改成这个身份（发生在宿主层，OS 可见）。
  5. 若开启了「代码叠层」开关 → 管理器用**同一个缓存身份**反查出语言，调用代码生成器产出 100 行假代码。
  6. 代码生成器按该语言的模板序列**全局轮转**取下一行骨架，骨架里的占位符（变量名/值/字符串）随机填充，每段包上原生着色类名，拼成一段形似该语言真实文件的 HTML。
  7. 管理器把这段 HTML 注入 webview（默认隐藏），发一条「显示」消息让前端亮出来；用户切回（获焦）时反向操作——恢复真标题/真图标、发「隐藏」消息。

- **最小原理演示（替代旧「复刻范围」）**：
  - 应演示：一个 **30～40 行的独立脚本**，演透「身份冻结 + 内容重画」这条权衡。脚本里放：一张只含 2 种语言的「语言表」、一张按标识的「身份缓存」、一个模块级「轮转索引」、一个 `getDisguise(id)`（命中返回缓存、否则随机拼并缓存）、一个 `nextLine(lang)`（取模轮转骨架 + 随机填占位 + 包 span）、一个模拟的 `onBlur(id)/onFocus(id)`。然后对同一个 id 连调 3 次 `onBlur`：观察标签标题三次**完全相同**（缓存命中、不闪），而每次产出的代码行**骨架按轮转推进、token 重新随机**（鲜活）。这一行行为差异，就是全章灵魂。
  - 应故意省略：30 种语言的完整词池、HTML 实体编码细节、行号动态计算、CSS 颜色映射、侧边栏联动、配置 UI、防抖逻辑。
  - **演示载体建议**：本章主语言是 TS、机制是「VSCode 扩展 webview + 面板」，**真跑扩展需要宿主环境**，故建议写成**一段能 `node`/`bun` 直接跑的独立脚本**，用一个普通 JS 对象模拟「面板」（带 title/icon 字段 + 一个接收消息的假 webview），手动调用 `onBlur/onFocus` 来模拟失焦/获焦事件——演透两层缓存策略即可，不强求真在 VSCode 里跑。

- **正文不宜展开的细节**：30 种语言各自的模板数组（千行重复，举 1～2 种代表即可）；HTML 实体编码（`&#40;` 之类）；行号 DOM 与 `vscode-tokens-styles`/`disguise-*` 等 CSS 类的具体颜色；侧边栏联动伪装（属于紧邻的「侧边栏伪装成假文件树」章）；配置勾选 UI；手动切换伪装命令的防抖锁。

- **推荐的一个执行轨迹例子**：输入 = 某页面首次失焦、用户只勾选了 ts/py 两种语言、开启了代码叠层。中间态 = 缓存未命中 → 池过滤为 [ts, py] → 随机抽中 ts → 名池抽「utils」、前缀池抽「app-」、扩展抽「.ts」→ 文件名「app-utils.ts」、图标指向 ts 图标、写回缓存；轮转索引(ts) 当前=3 → 取第 4 个 ts 模板（形如 `interface IX { ... }`），占位随机填 → 产出一行带高亮的 HTML，循环 100 次（索引跨过若干轮回到原位）。输出 = 标签页标题变「app-utils.ts」+ ts 图标；webview 叠了一层 100 行、结构像 ts 定义文件的高亮代码。**再次失焦**：缓存命中 → 标题/图标原样不变（不闪）；代码叠层却重新生成（骨架因全局轮转而推进、token 重随）→ 看起来「这个文件还在被持续编辑」。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 伪装管理器是**纯静态工具类**（无实例化），所有状态（身份缓存、语言表、各类统计/配置方法）都挂在类上，本质是一个模块级单例命名空间。 源码位置: src/core/utils/disguise-manager.ts:8, 10, 174
- 文件名由**三组正交词池**（前缀 / 名 / 扩展名）各随机取一个拼接而成；图标由「语言 → 内置图标文件名」的映射定位到扩展打包资源目录下的对应 svg。 源码位置: src/core/utils/disguise-manager.ts:201-218
- 身份缓存**键为 webview 唯一标识**，命中即原样返回、不再随机；提供按标识清 / 全清 / 强制重生成三个入口，导航到新文章或 webview 重建时由宿主调用以换新身份。 源码位置: src/core/utils/disguise-manager.ts:183-185, 226, 236-255；调用点 src/core/zhihu/webview/index.ts:2000, 3124, 4043-4044
- 代码叠层**复用同一个缓存身份**，通过扩展名反查语言，保证「标题是 ts、内容也是 ts」的一致性（不会出现 ts 文件名配 Python 代码的穿帮）。 源码位置: src/core/utils/disguise-manager.ts:365-371, 384-394
- 代码生成的核心是**全局轮转模板索引**：每种语言对应一组「模板闭包」数组，按调用次数取模轮转选取；闭包内部只对占位符（变量名/值/字符串等）做随机填充。索引是模块级、**跨所有 webview 共享**（不按页面隔离）。 源码位置: src/core/utils/code-generator.ts:7, 30-42, 280-312
- 语法着色**不接真实高亮引擎**，而是直接吐出 VSCode TextMate token 的 CSS 类名（`mtk1`～`mtk21`，如关键字/变量/串/类型/注释各对应一类）；webview 只需自带「类名→颜色」映射即可像素级还原编辑器观感。 源码位置: src/core/utils/code-generator.ts:282（及全文各 `generateXxxLine`）；HTML 外壳 src/core/utils/disguise-manager.ts:403-421
- 触发契约在 webview 宿主层：面板**失焦**→把标题/图标改成伪装身份并发 `showDisguise` 消息；**获焦**→恢复真标题（取自全局 Store 的 webview 映射）/真图标并发 `hideDisguise`。标题层在失焦分支**无条件**调用伪装（受内部开关默认值约束），代码叠层显式受开关二次约束。 源码位置: src/core/zhihu/webview/index.ts:103-157（标题伪装 :132、叠层开关 :140-141）
- 资源定位**承前**复用全局 Store：拼图标路径时取 `Store.context.extensionUri` 作为扩展根，该 context 由全局 Store 在扩展激活时注入，本章工具类只读借用、不持有。 源码位置: src/core/utils/disguise-manager.ts:213-218, 293-298；Store 定义 src/core/stores.ts:5-7

## 关键调用链

```
失焦: panel.onDidChangeViewState(active=false)
   → getDisguiseOrDefault(webviewId)              // 受 isDisguiseEnabled(默认true) 约束
   → getRandomDisguise(webviewId)                  // 缓存命中? 否则随机拼文件名+图标并缓存
   → 写回 panel.title / panel.iconPath             // 宿主层、OS 可见
   → (若 enableDisguise) showDisguiseInterface → postMessage{command:'showDisguise'}

代码叠层渲染(注入 HTML 时):
   generateDisguiseCodeInterface(webviewId)
   → getRandomDisguise(webviewId)                  // 复用同一缓存身份
   → getLanguageFromExtension(扩展名) → language
   → CodeGenerator.generateCode(language, 100)
       → 100 × [ getNextPattern 轮选取模板闭包 → 闭包内 randomXxx 填占位 → 包 mtkN span ]
   → buildCodeInterfaceHTML(行号 + 代码, 外层默认 display:none)
   → 由 HTML 渲染器注入 webview 文档

获焦: panel.onDidChangeViewState(active=true)
   → 恢复真标题(Store.webviewMap 取文章标题) / 真图标(resources/icon.svg)
   → hideDisguiseInterface → postMessage{command:'hideDisguise'}
```
源码位置: src/core/zhihu/webview/index.ts:103-157；src/core/utils/disguise-mode.ts（注：实为 disguise-manager.ts）:181-230, 365-377；src/core/utils/code-generator.ts:12-25, 30-42；HTML 注入 src/core/zhihu/webview/html.ts:300-305

## 源码摘录（带行号，全文累计 ≤ 30 行）

身份缓存 + 随机身份生成（演权衡①「身份冻结」）：
```ts
// src/core/utils/disguise-manager.ts
private static disguiseCache = new Map<string, { title: string; iconPath: vscode.Uri }>(); // :174
public static getRandomDisguise(webviewId: string) {                 // :181
  if (this.disguiseCache.has(webviewId)) return this.disguiseCache.get(webviewId)!; // :183-185 命中即复用
  // ... 按 selectedDisguiseTypes 过滤语言池，回退到全部 ...
  const randomIconFile = finalTypes[Math.floor(Math.random() * finalTypes.length)]; // :201
  const randomName    = fileTypeInfo.names[Math.floor(Math.random() * fileTypeInfo.names.length)];      // :205
  const randomPrefix  = fileTypeInfo.prefixes[Math.floor(Math.random() * fileTypeInfo.prefixes.length)]; // :206
  const randomExtension = fileTypeInfo.extensions[Math.floor(Math.random() * fileTypeInfo.extensions.length)]; // :207
  const fileName = `${randomPrefix}${randomName}${randomExtension}`; // :210 三池拼接
  this.disguiseCache.set(webviewId, disguiseInfo);                   // :226 冻结身份
}
```

全局轮转模板索引（演权衡②「骨架轮转、token 随机」）：
```ts
// src/core/utils/code-generator.ts
private static patternIndexes: Map<string, number> = new Map();      // :7 模块级、跨 webview 共享
private static getNextPattern<T>(fileType: string, patterns: T[]): T { // :30
  if (!this.patternIndexes.has(fileType)) this.patternIndexes.set(fileType, 0); // :31-32
  const currentIndex = this.patternIndexes.get(fileType)!;           // :35
  const pattern = patterns[currentIndex];                            // :36 取当前骨架
  this.patternIndexes.set(fileType, (currentIndex + 1) % patterns.length); // :39 取模推进
  return pattern;                                                    // :41
}
```

单个模板闭包：骨架固定、占位随机、直接吐着色 span（演权衡③「预烤着色」）：
```ts
// src/core/utils/code-generator.ts:282  (mtk5=关键字 mtk9=变量 mtk11=串 mtk1=普通)
() => `<span class="mtk5">const</span><span class="mtk1">&nbsp;</span><span class="mtk9">${CodeGenerator.randomVariableName()}</span><span class="mtk1">&nbsp;=&nbsp;</span><span class="mtk11">${CodeGenerator.randomValue()}</span><span class="mtk1">;</span>`,
```

代码叠层复用同一缓存身份反查语言（演「标题与内容语言一致」）：
```ts
// src/core/utils/disguise-manager.ts:365
public static generateDisguiseCodeInterface(webviewId: string): string {
  const disguiseInfo = this.getRandomDisguise(webviewId);   // 复用缓存身份，不再随机
  const extension = disguiseInfo.title.substring(disguiseInfo.title.lastIndexOf('.'));
  const language = this.getLanguageFromExtension(extension); // 扩展名 → 语言
  const codeLines = CodeGenerator.generateCode(language, 100);
  return this.buildCodeInterfaceHTML(codeLines);            // 行号 + 代码，外层 display:none
}
```

## 易混淆 / 边界 / 推断

- **事实**：同一个开关 `enableDisguise` 在不同读取点默认值不一致——伪装管理器内部的 `isDisguiseEnabled()` 读默认 **true**（src/core/utils/disguise-manager.ts:277），但宿主多个调用点读默认 **false**（src/core/zhihu/webview/index.ts:106, 3418），HTML 渲染器又读默认 **true**（src/core/zhihu/webview/html.ts:160）。后果：失焦分支里标题/图标伪装（走 `getDisguiseOrDefault`→`isDisguiseEnabled` 默认 true）与代码叠层显隐（走调用点默认 false）默认行为不同步。
- **事实**：失焦分支对标题/图标伪装是**无条件调用** `getDisguiseOrDefault`（src/core/zhihu/webview/index.ts:132），代码叠层 `showDisguiseInterface` 才被 `if (enableDisguise)` 二次约束（:140-141）。因此存在「标题已伪装、内容未叠」的半伪装中间态。
- **推断**：代码生成的轮转索引是**全局共享、非按页面隔离**的（src/core/utils/code-generator.ts:7, 39），因此「某语言下一次取哪个模板」取决于该语言此前在全扩展被调用的总次数，而非某个 webview 自身的渲染次数——这会让多页面同时伪装时的骨架序列互相穿插，但因内容叠层只在主动查看时可见，实际无人察觉。
- **推断**：源码中未见任何定时器自动刷新伪装身份；身份只在「导航到新文章 / webview 重建 / 手动重生成」时通过清缓存更换（src/core/zhihu/webview/index.ts:2000, 3124, 4043-4044）。故推断**无「长时间不动自动换身份」机制**。
- **未理解**：`enableDisguise` 默认值在多处不一致，究竟是刻意设计（标题层默认开、叠层默认关，引导用户先接受轻量伪装）还是配置项演进过程中的遗留漂移，源码与注释均无说明，留给 Architect/Critic 决断。