# 防反爬浏览器引擎 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：用普通 HTTP 请求去拿知乎内容，几乎必然被拦——知乎会查「你是不是被程序自动控制的浏览器」（自动化指纹）、查你是不是真人在用的登录态。一旦任何一个破绽被识破，就是 403 或被重定向到无关页面。使用者要的不是「会发请求」，而是「能像真人浏览器一样通过知乎的层层安检」。

- **一句话核心思想**：**与其和反爬玩猫鼠游戏，不如直接开一台被悄悄伪装过的真 Chrome 去敲门。**

- **设计动机（为什么需要它）**：知乎的反爬不只看单一信号，而是综合「浏览器自动化指纹 + 登录态完整性 + 行为是否像人」。纯 HTTP 拼请求头永远在追补漏掉的指纹；而真实 Chrome 自带完整 JS 引擎与浏览器指纹，只要再抹掉「自动控制」这一处破绽、塞进合法登录态、再模拟人手滚动，就能整体通过安检——这是把「对抗」降级成「伪装」的根本动机。
  - **承前复用①**：全局共享状态容器（已在第 1 章『全局共享状态容器』讲透：模块级可变单例充当扩展全生命周期共享内存）——本章只看它作为**浏览器宿主 + 页面注册表**的新侧面：浏览器实例和一个「页面键→页面」的映射都挂在那个共享单例上。
  - **承前复用②**：Cookie 清洗（已在第 2 章『Cookie 凭证的清洗与校验』讲透：去第三方统计项、校验签名与登录凭证、去 BEC 防重定向）——本章只看**清洗后的 Cookie 如何注入到真实浏览器页面**这个新侧面，清洗逻辑本身不重讲。

- **关键权衡（核心原料）**：
  1. **真实 Chrome vs 纯 HTTP 请求**：选开真浏览器执行 JS + 带完整浏览器指纹 → 换来「整体通过反爬安检、拿到 JS 渲染后的内容」 → 代价是**重资源**（启动慢、吃内存）和**页面不会随调用方自动销毁**带来的生命周期负担。
  2. **全局单例浏览器（全扩展唯一一台）**：所有页面共享同一台浏览器与同一份登录态上下文 → 换来「无需反复启动、Cookie 一次注入全局生效」 → 代价是**单点脆弱**（浏览器一崩所有页面全挂）与「Cookie 是浏览器级写入」带来的隐式全局副作用。
  3. **「轻探针」与「重启动」分离**：把「浏览器是否可用」做成一个**只看文件是否存在、不真正启动**的探针，与「真正启动浏览器」分成两个方法 → 换来 UI 流程能在**不触发重启动和交互弹窗**的前提下，提前判断并引导用户去配置浏览器 → 代价是「路径存在性 + 下载完整性」这套判断逻辑在探针与启动里**各写了一遍**（重复）。
  4. **页面与调用方解耦 + 显式清理**：浏览器页面不随 webview 自动销毁，而是按一个键登记进注册表 → 换来「页面可跨导航复用、灵活编排」 → 代价是**必须显式清理**，否则泄漏；为此用「调用方存活表」反向判定哪些页面已无主，集中清扫。

- **最小心智模型（3～7 步）**：
  1. 某功能要爬内容前，先用**轻探针**确认系统里有可用的浏览器（只查文件，不启动）。
  2. 探针通过后，取/建**单例浏览器**：若尚未启动则启动（自定义路径优先，否则用内置默认路径；启动失败最多重试若干次，每次先关掉残留实例再重试）。
  3. 基于这台浏览器**新建一个页面**，并立刻做三件伪装：伪造一个主流浏览器的 UA、注入「已去敏感项」的登录 Cookie、在每个新文档加载前抹掉「自动控制」指纹。
  4. 导航到目标知乎页，在**页面自己的 JS 上下文里**提数据（必要时模拟人类滚动触发懒加载）。
  5. 把页面按某个键**登记进注册表**，后续按键复用/激活。
  6. 调用方（如 webview）被关闭或切换时，**按键关闭**对应页面。
  7. 定期清扫**注册表里已无调用方对应的页面**，防泄漏。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**只表达「单例懒启动 + 三件伪装 + 注册表/清理」核心思想**的从零实现（几十行）。重点演透两条权衡——「真浏览器 + 抹指纹」如何过安检、以及「页面与调用方解耦 → 必须显式清理」的代价。每一行都要对应上述某个原理点。
  - 应故意省略：5 次重试的精确次数、win32 路径残缺检测、用户自定义路径的交互式弹窗、操作系统分支、配置读写、状态栏等工程化脚手架——这些是正文不宜展开的细节。
  - **演示载体建议（Writer 据此执行）**：本仓库主语言是 TS、机制是「控制真实浏览器」。建议写成一段能 `npx tsx`/`bun` 直接跑的脚本：用真实 puppeteer 起 headless 浏览器，导航到一个会检测 `navigator.webdriver` 的页面（或自写一个检查脚本），先**不抹指纹**演示被识破、再**抹掉指纹 + 注入伪造 UA**演示通过——用「对照实验」演透「伪装」这一核心思想；再用一个小 Map 演示「页面注册 → 调用方销毁 → 孤立页面清扫」的生命周期权衡。能跑最好，非硬要求；若环境装 puppeteer 困难，退化成「机制骨架 + 文字执行轨迹」亦可演透。

- **正文不宜展开的细节**：win32 下「版本目录存在但 chrome.exe 缺失 = 下载未完全」的精确路径裁剪逻辑；三种操作系统下的示例路径表；用户自定义路径不存在时的交互式错误弹窗与「安装默认 / 更改路径」按钮分支；`protocolTimeout: 240000` 与 `pipe: true` 等启动参数的逐项含义；`--disable-features=UseEcoQoSForBackgroundProcess` 这类平台特定调优。

- **推荐的一个执行轨迹例子**：用户在侧边栏点开一篇知乎回答 → ① 轻探针确认浏览器可创建（仅查文件） → ② 单例浏览器尚未启动，于是懒启动（自定义路径优先，失败重试） → ③ 新建页面，注入「伪造 UA + 去 BEC 的登录 Cookie + 抹掉 webdriver 指纹」 → ④ 导航到知乎页并在页面上下文里提结构化内容 → ⑤ 页面以该 webview 的键登记进注册表 → 用户切走该 webview → ⑥ 按键关闭对应页面，并清扫注册表里已无 webview 对应的孤立页面。输出：拿到真实渲染后的内容，且不留泄漏页面。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 全类为静态方法集合，无实例状态——所有可变状态都外置到全局共享单例上（浏览器实例字段、页面映射字段、webview 映射字段），本类只提供操作这些状态的行为。源码位置: src/core/zhihu/puppeteer/index.ts:16

- **单例浏览器的懒创建**：取浏览器实例时，若共享单例中的浏览器字段为空才创建，创建成功后写回单例；此后所有调用复用同一实例。源码位置: src/core/zhihu/puppeteer/index.ts:132-133,216,310

- **可执行路径回退链**：优先用户配置的自定义 Chrome 路径；为空则回落到 puppeteer 内置下载的默认浏览器路径。源码位置: src/core/zhihu/puppeteer/index.ts:137-141

- **5 次重试启动 + 残留清理**：启动失败时先尝试关闭可能已半启动的浏览器实例、再把单例字段置空，然后等待 5 秒重试，最多 5 次；全部失败才抛错。源码位置: src/core/zhihu/puppeteer/index.ts:189-255

- **headless/有头由调试配置切换**：调试模式开启时有头运行（便于观察）；否则 headless 运行，并用 `--window-size` 指定视口、`--window-position=-10000,-10000` 把窗口移到屏幕外作为兜底（防止非 headless 时干扰用户）。源码位置: src/core/zhihu/puppeteer/index.ts:195-213

- **防反爬三件套（页面级伪装，在新建页面时一次性配置）**：① 伪造主流 Chrome 的 User-Agent；② 取登录 Cookie、去掉 BEC 后注入页面；③ 在每个新文档加载前把 `navigator.webdriver` 重定义为 `undefined`，抹掉自动化指纹。源码位置: src/core/zhihu/puppeteer/index.ts:432-453

- **Cookie 是浏览器级写入**：注入 Cookie 时调的是浏览器实例的 setCookie（而非页面级），意味着 Cookie 在整台单例浏览器内全局生效——这是「单例」换来的隐式全局副作用。源码位置: src/core/zhihu/puppeteer/index.ts:461-475

- **「轻探针」语义**：可创建性检查**只做文件存在性 + 下载完整性判断、不真正启动浏览器**，用于在 UI 流程中提前拦截并引导用户配置；它不触发重启动。源码位置: src/core/zhihu/puppeteer/index.ts:317-391

- **页面注册表**：页面以字符串键（webviewId 或 "search"/"follow"/"recommend"）登记进共享单例的页面映射；后续按键取/激活/关闭。源码位置: src/core/zhihu/puppeteer/index.ts:397-411

- **孤立页面清理**：遍历页面映射，凡「没有对应 webview 映射条目」的页面视为孤立，未关闭的关掉、已关闭的清引用，防止资源泄漏。源码位置: src/core/zhihu/puppeteer/index.ts:573-607

- **关闭页面的容错**：关页面前先查是否已关闭；捕获 "Target closed" / "No target with given id" 这类「页面其实已没了」的错误，静默清引用而非抛出。源码位置: src/core/zhihu/puppeteer/index.ts:525-555

## 关键调用链

创建并使用一个爬取页面（主流程）：
`canCreateBrowser()`（轻探针，仅查文件） → `getBrowserInstance()`（懒启动单例浏览器，含 5 次重试） → `browser.newPage()` → `setViewport/setUserAgent` → `CookieManager.getCookie()` + `CookieManager.removeBECFromCookie()` → `addCookiesToPage()`（浏览器级 setCookie） → `evaluateOnNewDocument(抹掉 webdriver)` → 调用方 `page.goto()` 后在页面上下文提数据 → `setPageInstance(key, page)` 登记进注册表。
源码位置: src/core/zhihu/puppeteer/index.ts:416-456

生命周期清理链：
调用方销毁/切换 → `closePage(key)`（按键关页面 + 容错） → `cleanupOrphanedPages()`（以 webviewMap 反向判定，清扫无主页面）。
源码位置: src/core/zhihu/puppeteer/index.ts:525-555,573-607

被谁调用（连接关系）：
- 详情页爬取、直答、收藏项爬取：调 `createPage()` 后 `setPageInstance(webviewId, page)` 登记，并在导航/切换时 `closePage` + `cleanupOrphanedPages`。源码位置: src/core/zhihu/webview/index.ts:448-449,2003-2011；src/core/zhihu/sidebar/collections.ts:1344,1417
- 列表/搜索/扫码登录等「需先确认浏览器可用」的流程：调 `canCreateBrowser()` 做前置门槛。源码位置: src/core/commands/cookie.ts:37；src/core/commands/search.ts:64；src/core/commands/qr-login.ts:52；src/core/zhihu/sidebar/collections.ts:676
- 扩展停用统一清理：关浏览器实例 + 清空页面映射。源码位置: src/core/zhihu/index.ts:44-50

## 源码摘录（带行号，全文累计 ≤ 30 行）

启动配置（演「重试循环内的真浏览器启动 + headless 切换 + 长超时」权衡）：
```ts
Store.browserInstance = await Puppeteer.launch({
  executablePath: executablePath,
  headless: headlessMode,
  args: puppeteerArgs,
  pipe: true,
  protocolTimeout: 240000, // 设置协议超时时间为240秒 / 4分钟
});
await new Promise((resolve) => setTimeout(resolve, 1000)); // 等待1秒钟
```
源码位置: src/core/zhihu/puppeteer/index.ts:216-223

防反爬三件套（演「真实浏览器如何被整体伪装」核心思想）：
```ts
await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/122.0.6261.95 ...");
const cookie = CookieManager.getCookie();
if (cookie) {
  const cleanedCookie = CookieManager.removeBECFromCookie(cookie); // 去BEC避免重定向到热榜
  await PuppeteerManager.addCookiesToPage(cleanedCookie);
}
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
```
源码位置: src/core/zhihu/puppeteer/index.ts:433-453（精简摘录）

孤立页面清理（演「页面与调用方解耦 → 显式清理」权衡）：
```ts
for (const [key, page] of Store.pagesInstance.entries()) {
  if (!Store.webviewMap.has(key)) {           // 无对应调用方 = 孤立
    if (!page.isClosed()) { orphanedKeys.push(key); }
    else { Store.pagesInstance.delete(key); }  // 已关闭则清引用
  }
}
```
源码位置: src/core/zhihu/puppeteer/index.ts:578-589（精简摘录）

## 易混淆 / 边界 / 推断

- 事实：`canCreateBrowser` 与 `getBrowserInstance` 中「win32 下 chrome.exe 缺失 → 判断版本目录是否存在以区分『未下载』vs『下载未完全』」的逻辑**几乎完全重复**（两处各自实现了一遍），印证了权衡③「轻探针与重启动分离」带来的重复代价。源码位置: src/core/zhihu/puppeteer/index.ts:143-180 与 336-378。

- 事实：无头模式下仍 push `--window-position=-10000,-10000`，注释为「兜底隐藏可能的窗口」——说明 headless 在某些环境下可能仍会短暂闪现窗口，需额外兜底。源码位置: src/core/zhihu/puppeteer/index.ts:209-211。

- 推断（标注为推断）：`addCookiesToPage` 用浏览器级 `setCookie` 而非页面级 `page.setCookie`，可能是为了让登录态在所有页面间共享（呼应单例设计），但副作用是不同页面的 Cookie 会互相影响——这点源码无注释，属推断。

- 推断（标注为推断）：`createPage` 中没有 Cookie 时**直接抛错**（"没有找到Cookie，需要设置Cookie"），说明本引擎假定「必须先有合法登录态才能爬」——这与第 2 章 Cookie 校验的严苛性一致，属设计契约而非偶然。源码位置: src/core/zhihu/puppeteer/index.ts:443-446。

- 事实：`createPage` 先调 `canCreateBrowser` 再调 `getBrowserInstance`，二者都会做存在性判断——`canCreateBrowser` 失败会抛错并阻止后续启动，是「轻探针前置门槛」的体现。源码位置: src/core/zhihu/puppeteer/index.ts:417-424。

- 未理解：`simulateHumanScroll` 先 `scrollTo` 到底、再用 `mouse.wheel` 正负交替滚动，注释带 `@todo` 提到可改用 `scrollIntoView`——这套具体滚动节奏为何能「骗过」知乎的懒加载/行为检测，源码无进一步说明，无法从代码确证其有效性，仅供正文作为「模拟人类行为」的现象引用，不宜深挖原理。