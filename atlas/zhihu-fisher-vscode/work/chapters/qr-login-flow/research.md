# 扫码登录全流程 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：知乎登录走的是加密接口，签名算法随时在变、逆向成本极高；如果让用户自己去浏览器复制 Cookie 又繁琐且容易漏关键项。使用者真正想要的是「扫码一下就自动登录好」，但程序根本算不出登录态。本章解决的就是「在算不出登录加密的前提下，如何拿到一份完整可用的登录凭据」。

- **一句话核心思想**：登录加密算不动，就让知乎自己的前端 JS 替我们跑完登录、替我们写好凭据 Cookie；扩展只做四件事——渲染登录页、截二维码、等页面跳转、收割域名 Cookie。这是「借力而非逆向」的总纲。

- **设计动机（为什么需要它）**：与其逆向登录签名，不如把真实浏览器当成一台「替我们算加密的算力」，让它跑知乎自己的登录页 JS，我们把结果（Cookie）偷出来即可。承前关系：本章复用前置章『防反爬浏览器引擎』（第3章）造好的那台浏览器单例与「能否创建浏览器」的前置校验，但登录特意在单例上**新开一个隔离上下文**（新侧面：用无痕上下文做登录态隔离，而非复用注入了已有 Cookie 的主爬虫页面）；关键安全项（签名 Cookie + 登录凭证）的校验与清洗复用前置章『Cookie 凭证的清洗与校验』（第2章）的成果（本章只看它作为「登录产物验收闸门」的新角色）；登录后刷新列表复用前置章『侧边栏内容列表』（第5章）的列表刷新能力，并再次校验浏览器可创建（呼应第5章「点不开详情的列表毫无意义」）。这三个承前点 Writer 务必做去重，不要把第 2/3/5 章已讲透的原理重演。

- **关键权衡**：
  1. **借力而非逆向**：选择「让知乎前端 JS 替我们算登录态与签名 Cookie」→ 换来「登录加密怎么变都不用追、扫码即得完整凭据」→ 代价是「必须真跑一台浏览器去渲染登录页，重资源、慢，且强依赖知乎前端页面的结构稳定」。这是全章总纲；登录成功后再导航一次到内容页、逼知乎 JS 把签名 Cookie 写进去，是这条权衡的二次落地。
  2. **复用单例 + 新开隔离上下文**：登录不另 launch 第二台浏览器，而是在共享单例上新开一个无痕上下文 → 换来「登录态判定干净、不污染主爬虫已注入的 Cookie，且不付第二台浏览器的资源代价」→ 代价是「该上下文要单独关闭、其内的防反爬伪装（UA、抹自动化痕迹）无法继承主流程的造页函数、得在本流程里重写一遍」。
  3. **截图像素而非读 canvas**：取二维码用「截屏裁剪像素矩形」而非「调 canvas 导出接口」→ 换来「绕开跨域图片污染 canvas 导致的安全异常」→ 代价是「拿到的是像素位图（非结构化数据）、依赖元素布局坐标、还须把二进制转 base64 才能塞进 webview 展示」。
  4. **轮询 URL 而非调登录接口**：判定登录成功用「每 2 秒读一次页面 URL，看是否离开了登录页」→ 换来「对登录加密完全免疫」→ 代价是「2 秒粒度的感知延迟、最长约 10 分钟的轮询窗口，以及异步多出口（成功/超时/面板关闭/重试）必须靠一组布尔状态标志 + 幂等清理函数来协调」。

- **最小心智模型（3～7 步）**：
  1. 先确认造得出浏览器（造不出就直接引导去配置，连登录页都打不开）。
  2. 在共享那台浏览器上另开一个隔离上下文（无痕），保证登录判定不被已有 Cookie 干扰。
  3. 隔离页导航到登录页，伪装 UA、抹掉自动化痕迹，等二维码画布出现。
  4. 截取二维码画布的像素矩形、转成 base64 推给 webview 展示。
  5. 每 2 秒读一次页面 URL，一旦离开登录页即认定扫码成功。
  6. 立刻再导航到内容页，让知乎前端 JS 把签名 Cookie 写进上下文。
  7. 只收割知乎域的 Cookie、校验签名 + 登录凭证齐全才落库，最后关掉隔离上下文并刷新列表。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一段几十行的独立脚本，演透「借真实浏览器渲染登录页 → 截二维码 → 轮询 URL → 收割域名 Cookie」这条主链，且每一行都要对应上面某条权衡（借力 / 截图绕污染 / 域名过滤）。核心是让读者直观看到「我们一行登录加密都不用碰，全靠浏览器替我们跑」。
  - 应故意省略：webview 的多状态 HTML、四个布尔标志的协调、重试/超时/错误兜底、命令注册与依赖注入、侧边栏刷新——这些都是工程脚手架，不演原理。
  - 演示载体建议：本章是 VSCode 扩展机制，但「借浏览器渲染登录页」本身是可独立跑的 puppeteer 行为，**不必真跑扩展**。建议写成一段独立 Node + puppeteer 脚本：本地起一个会「用 JS 写签名 Cookie + 画二维码 canvas + 扫码后跳转」的夹具页，脚本依次演示 ① 直接调 canvas 导出接口会因跨域图片抛安全异常、② 改用 page.screenshot({clip}) 能拿到二维码、③ 轮询 url 离开登录页即判成功、④ 按域名收割 Cookie。能 `node` 直接跑最好（非硬要求）；演的是「借力 + 截图绕污染 + 域名收割」三条权衡。

- **正文不宜展开的细节**：webview 模板的转义与六态 HTML 拼接（加载中/等待/二维码展示/成功/超时/错误）；四个布尔标志（已清理/已关闭/重试中/已成功）的具体协调；重试（关面板重开命令）、超时（约 10 分钟）、Esc 关闭等交互分支；HTML 转义细节；登录成功后、刷新列表前为何又校验一次浏览器可创建（对齐手动设置 Cookie 的逻辑）。

- **推荐的一个执行轨迹例子**：输入「用户点扫码登录」→ 中间态「建隔离上下文 → 导航登录页 → 二维码画布出现 → 截图回传 webview → 用户用 App 扫 → 页面 URL 由登录页跳到首页 → 再导航到内容页触发签名 Cookie」→ 输出「校验通过后，知乎域 Cookie（含签名 + 登录凭证）落库，隔离上下文关闭，侧边栏列表自动刷新」。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 登录流程的开篇是前置校验：先问「能否创建浏览器」，不能就直接弹错误并引导配置，连登录页都不打开。源码位置: src/core/commands/qr-login.ts:52-62
- 复用第3章单例浏览器，但登录在其上**新建隔离上下文**：先 `getBrowserInstance()` 拿共享单例，再 `createBrowserContext()` + `context.newPage()`，注释明言「类似于无痕模式，确保没有已有 cookie 干扰」。源码位置: src/core/commands/qr-login.ts:116-120
- 防反爬伪装（伪造 UA + 抹掉 navigator.webdriver）在本文件内**重新实现一遍**，没有调主流程的造页函数——因为后者要求已有 Cookie 且开在主上下文，与登录的隔离诉求冲突。源码位置: src/core/commands/qr-login.ts:123-132（对照 src/core/zhihu/puppeteer/index.ts:430-453）
- 二维码用**截图 + clip 取像素**：先在页面上下文里读二维码画布的 `getBoundingClientRect()` 拿到像素矩形，再用 `page.screenshot({clip})` 截该区域；注释明言此举「避免 canvas 跨域图片导致的 SecurityError (Tainted canvases)」。源码位置: src/core/commands/qr-login.ts:209-241
- 截图返回值兼容 Buffer 与 base64 string 两种形态（puppeteer 版本/配置差异），用 `typeof` 判定后统一转 `data:image/png;base64,...` 塞进 webview。源码位置: src/core/commands/qr-login.ts:256-262
- 登录成功判定 = **URL 离开登录页**：轮询里读 `page.url()`，当 URL 既不含 `signin`、又不含 `zhihu.com/signup` 时认定扫码成功（登录后知乎会跳首页）。源码位置: src/core/commands/qr-login.ts:304-316
- 登录成功后**再导航到内容页（热榜）触发签名 Cookie**：注释「导航到热榜页面，触发知乎 JS 设置 __zse_ck 等签名 cookie」——签名 Cookie 是知乎前端 JS 在访问内容页时计算写入的，程序自己算不出。源码位置: src/core/commands/qr-login.ts:327-332
- 关键 Cookie **验收闸门**：必须同时含 `__zse_ck`（请求签名）与 `z_c0`（登录凭证），缺任一即报错不保存；这与第2章的 Cookie 完整性校验互为对证（第2章加载时若发现缺这两项会提示「扫码登录曾有 bug 致缺失，现已修复」）。源码位置: src/core/commands/qr-login.ts:348-364（对照 src/core/zhihu/cookie/index.ts:42-65, 177-180）
- **双层 Cookie 清洗**：浏览器上下文层按域名过滤（只留 `.zhihu.com` / `www.zhihu.com`），拼成字符串后交第2章的 `saveCookieString`，后者再按 key 前缀过滤第三方统计项（百度统计、GA 等）。源码位置: src/core/commands/qr-login.ts:334-346（对照 src/core/zhihu/cookie/index.ts:118-129, 211-266）
- 登录成功、刷新列表前**再次校验浏览器可创建**，与手动设置 Cookie 的逻辑对齐——「点不开详情的列表毫无意义」（呼应第5章核心权衡）。源码位置: src/core/commands/qr-login.ts:370-380
- **幂等清理 + 多出口协调**：`cleanupPage` 由模块级 `isCleanedUp` 标志守护，可被面板关闭、轮询回调、重试等多处安全重复调用；另用 `isDisposed` / `isLoginSuccess` / `isProcessingRetry` 协调异步多出口。源码位置: src/core/commands/qr-login.ts:78-86, 145-152, 449-466
- webview 用**多态 HTML 替换**驱动状态切换（加载中→等待→二维码展示→成功/超时/错误），仅「等待中」态用 `postMessage(updateStatus)` 增量推送计时，避免整页重刷丢二维码图。源码位置: src/core/commands/qr-login.ts:276-277, 283-430, 471-691

## 关键调用链
registerQRLoginCommands("zhihu-fisher.loginViaQRCode") → handleQRLogin
handleQRLogin:
  PuppeteerManager.canCreateBrowser()                 // 前置校验（复用第3章）
  → PuppeteerManager.getBrowserInstance()             // 复用第3章单例
  → browser.createBrowserContext() + context.newPage()// 隔离上下文（本章新侧面）
  → page.goto(zhihu/signin) + waitForSelector(.Qrcode-qrcode)
  → page.evaluate(getBoundingClientRect) → page.screenshot({clip})  // 绕 tainted canvas
  → panel.webview.html = 二维码 base64
  → setInterval(2s) 轮询 page.url():
       离开 signin? → page.goto(zhihu/hot)            // 触发签名 Cookie
       → context.cookies() 过滤知乎域 → 校验 __zse_ck + z_c0
       → CookieManager.saveCookieString()             // 复用第2章清洗+落库
       → 各 sidebar.refresh()/reset()                 // 复用第5章
       → cleanupPage(context, page)
源码位置: src/core/commands/qr-login.ts:44-442

## 源码摘录（带行号，全文累计 ≤ 30 行）
截图绕过 tainted canvas（本章招牌权衡③）：
```ts
    // 使用 page.screenshot() + clip 截取 canvas 元素的像素区域，
    // 避免 canvas 跨域图片导致的 SecurityError (Tainted canvases)
    const qrCodeClip = await page.evaluate(() => {
      const canvas = document.querySelector(".Qrcode-qrcode") as HTMLCanvasElement | null;
      ...
      const rect = canvas.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    ...
    const qrCodeScreenshot = await page.screenshot({ clip: qrCodeClip, type: "png" });
```
源码位置: src/core/commands/qr-login.ts:209-241

借力 JS 写签名 Cookie + 域名过滤 + 验收闸门（权衡①②）：
```ts
          // 导航到热榜页面，触发知乎 JS 设置 __zse_ck 等签名 cookie
          await page.goto("https://www.zhihu.com/hot", {
            waitUntil: "networkidle2",
            timeout: 30000,
          });
          // 从 context 获取所有 cookie，只保留知乎域名
          const allCookies = context ? await context.cookies() : [];
          const zhihuCookies = allCookies.filter(
            (c) => c.domain === ".zhihu.com" || c.domain === "www.zhihu.com"
          );
          ...
          const hasZseCk = cookieKeys.includes("__zse_ck");
          const hasZC0 = cookieKeys.includes("z_c0");
```
源码位置: src/core/commands/qr-login.ts:327-350

## 易混淆 / 边界 / 推断
- 事实：登录用 `browser.createBrowserContext()` 新建隔离上下文；而主爬虫流程用 `browser.newPage()` 在主上下文开页并注入已有 Cookie。两者刻意不同，是本章与第3章的关键分野。源码位置: src/core/commands/qr-login.ts:119-120 vs src/core/zhihu/puppeteer/index.ts:416-427
- 事实：登录流程里的 UA + 抹 webdriver 伪装是本文件内重复实现，未复用第3章造页函数（后者会要求已有 Cookie 且开在主上下文）。
- 推断（标注为推断）：「登录后再导航到内容页触发签名 Cookie」这一步，疑似为修复「扫码登录拿到的 Cookie 缺签名项」的 bug 而后加——佐证是第2章加载 Cookie 时的提示语「之前扫码登录流程有bug，导致部分Cookie缺失，现已修复」。源码位置: src/core/zhihu/cookie/index.ts:54
- 事实：Cookie 清洗是双层的——浏览器上下文层按域名、字符串层按 key 前缀，两层先后作用。
- 推断（标注为推断）：登录判定用 `setInterval(2s)` 轮询 URL 而非 `page.waitForNavigation()`，可能是为了在「已登录/超时/面板关闭」等多出口下统一停表，并顺便推计时消息；但源码未注释说明原因。
- 事实：二维码 `waitForSelector` 超时后会进入一段「等待」态并 return，不再继续轮询——若二维码延迟出现，用户只能走重试，源码未说明是否为已知体验缺陷。源码位置: src/core/commands/qr-login.ts:186-200
- 未理解：`createBrowserContext` 在不同 puppeteer 版本里是否稳定可用、隔离上下文与主上下文是否真的完全 Cookie 隔离（源码依赖此假设但未做断言），需结合运行环境验证。