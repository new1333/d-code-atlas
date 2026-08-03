# 扫码登录全流程

想象一下你正打算用某个知乎辅助扩展，结果弹出来一句「请先登录」。如果是网页，你大概会下意识地掏出手机扫个码，三秒搞定。但这个扩展背后没有知乎的账号密码接口、也写不出知乎那种一天变三次的登录加密签名——它凭什么能让你「扫一下就登录好」？

这一章要回答的就是这个问题：**在算不出登录加密的前提下，怎么拿到一份完整可用的登录凭据**。

## 一、核心思想：借力，而不是逆向

知乎登录用的接口是加密的，签名算法变过好几次，逆向成本极高，而且逆向出来的版本可能下周就失效。硬刚这条路不划算。

换个角度想：知乎自己的前端 JS 一定能算出正确的登录态——否则它自己的网页都没法登录。那只要我们把这台「能跑通知乎前端」的真实浏览器当成一台**替我们算加密的算力**，让它老老实实跑完整个登录页，等它跑完之后，**把结果（Cookie）偷出来**就行。

说人话就是：**登录加密算不动，就让知乎自己的 JS 替我们跑；扩展只管四件事——渲染登录页、截二维码、等页面跳转、收割域名 Cookie**。

跟前置章的关系先理一下，免得重复：

- 第 3 章已经造好了一台真实 Chrome 单例（带 UA 伪造、抹 `navigator.webdriver` 等防反爬伪装），本章**复用这台单例**，不另开第二台；
- 第 2 章已经写好了 Cookie 的清洗（去第三方统计项）和校验（必须含 `__zse_ck` 签名 + `z_c0` 登录凭证）流程，本章**只在最后调用它**当「登录产物验收闸门」；
- 第 5 章已经写好了侧边栏列表刷新能力，本章**登录成功后调一下它的 `refresh()`**。

本章真正新增的，是**怎么把扫码这件事在浏览器里走通、并把凭据干净地收回来**。

## 二、心智模型：七步走完整条链

把流程拆开来看，每一步都对应着上面某个权衡：

1. **先确认造得出浏览器**——造不出就直接弹错误、引导去配置，连登录页都不打开。
2. **在共享那台浏览器上另开一个隔离上下文**（类似无痕模式），保证登录判定不被已有 Cookie 干扰。
3. **隔离页导航到登录页**，重新伪造 UA、抹掉自动化痕迹，等二维码画布出现。
4. **截取二维码画布的像素矩形**、转成 base64 推给 webview 展示给用户扫。
5. **每 2 秒读一次页面 URL**，一旦离开登录页就认定扫码成功。
6. **立刻再导航到内容页（热榜）**，让知乎前端 JS 把签名 Cookie 写进上下文。
7. **只收割知乎域的 Cookie**、校验签名 + 登录凭证齐全才落库，最后关掉隔离上下文并刷新列表。

这条链上每一步都不是随便写的。下面四节就一个一个讲清楚——为什么是这样做、换来什么、又付了什么代价。

## 三、权衡一：借力而非逆向（全章总纲）

**选择**：让知乎前端 JS 替我们算登录态与签名 Cookie，而不是自己去逆向签名算法。

**换来**：登录加密怎么变都不用追——只要知乎自己的网页还能登录，我们的扩展就还能登录。扫码即得完整凭据，不用写一行加密代码。

**代价**：必须真跑一台浏览器去渲染登录页，**重资源、慢**（启动一台 Chrome 比一次 HTTP 请求重得多），且**强依赖知乎前端页面的结构稳定**——比如 `.Qrcode-qrcode` 这个画布的 class 名一旦改了，二维码就截不到了。

这条权衡还有个**二次落地**：登录刚成功那一刻，凭据其实还没齐。签名 Cookie（`__zse_ck`）是知乎前端 JS 在**访问内容页时**才算出来写进 Cookie 的，光在登录页拿不到。所以扫码成功后，扩展**故意再导航一次到 `https://www.zhihu.com/hot`**，逼知乎 JS 把签名 Cookie 自己写进去，然后才进入下一步。这一步看起来多余，其实是「借力」思路的延续：签名算不出，那就让知乎自己访问内容页时算。

> 顺带一提：第 2 章加载 Cookie 时若发现缺 `__zse_ck` / `z_c0`，会提示「之前扫码登录流程有 bug，导致部分 Cookie 缺失，现已修复」——说的就是历史上曾经漏掉过这一步导航。

## 四、权衡二：复用单例，但新开一个隔离上下文

**选择**：登录不另 launch 第二台浏览器，而是在第 3 章那台共享单例上，**新开一个隔离的 BrowserContext**（类似无痕模式）。

**换来**：

- **登录态判定干净**——隔离上下文里一开始没有任何 Cookie，导航到登录页时不会因为主流程已注入的旧 Cookie 而被「自动登录」或被旧登录态干扰判定；
- **不污染主爬虫流程**——登录写在隔离上下文里的 Cookie，不会泄漏到主上下文里影响后续爬取；
- **不付第二台浏览器的资源代价**——浏览器进程还是只有一个。

**代价**：

- 这个隔离上下文要**单独关闭**，不然会泄漏成孤儿；
- 隔离上下文里的页面**没法继承主流程的造页函数**——主流程的造页函数是「先注入已有 Cookie 再开页」的，跟登录的隔离诉求直接冲突。所以**防反爬伪装（伪造 UA、抹 `navigator.webdriver`）得在本流程里重新实现一遍**，不能直接复用第 3 章那套。

这个分野很关键：**主爬虫流程是「带着已有 Cookie 在主上下文里开页」，登录流程是「在隔离上下文里从零开页」**。两者刻意不同，是本章与第 3 章最大的区别。

## 五、权衡三：截图像素，而不是读 canvas

二维码在登录页上是个 `<canvas>` 元素。第一反应是直接调 canvas 的 `toDataURL()` 把图导出来——简单、直接、结构化。

**选择**：用 `page.screenshot({ clip })` 截二维码画布那一块的**像素矩形**，而不是调 canvas 的导出接口。

**换来**：绕开「**tainted canvas（污染画布）**」导致的安全异常。

什么是污染画布？浏览器有个安全规则：如果一个 canvas 里画过**跨域图片**（比如知乎的二维码画布里混入了来自 CDN 的跨域 logo 或背景），这个 canvas 就被「污染」了。之后任何尝试读它内容的行为——包括 `toDataURL()`、`getImageData()`——都会直接抛 `SecurityError`。这是浏览器同源策略的硬性规定，扩展绕不过去。

**代价**：

- 拿到的是**像素位图（PNG Buffer）**，不是结构化数据；
- **依赖元素的布局坐标**——要先在页面上下文里读 `canvas.getBoundingClientRect()` 拿到像素矩形的位置和尺寸，再把这块矩形作为 `clip` 传给 `screenshot`；
- 截出来的二进制**还得转 base64**（前面可能加个 `data:image/png;base64,` 前缀）才能塞进 webview 的 `<img src>` 展示。

具体做法分两步走：

```
在页面里 evaluate: canvas.getBoundingClientRect() → {x, y, width, height}
                                              ↓
page.screenshot({ clip: 上面那个矩形, type: "png" })  → PNG Buffer / base64 string
                                              ↓
                              统一拼成 data URL → 塞进 webview
```

> 顺带一提：`page.screenshot` 的返回值在不同 puppeteer 版本里**既可能是 Buffer 也可能是 base64 string**，所以拿到后要用 `typeof` 判一下，统一成 data URL。这是版本兼容的小细节，不是原理重点。

## 六、权衡四：轮询 URL，而不是调登录接口

判定「用户扫完码登录成功了」这件事，最直接的做法似乎是去调知乎的「检查登录态」接口。但那又回到了逆向加密的老路。

**选择**：每 2 秒读一次 `page.url()`，**只要 URL 离开了登录页就认定扫码成功**。

具体判定是：URL 既不含 `signin`、又不含 `zhihu.com/signup`——因为登录成功后知乎会自动跳到首页，URL 就从 `/signin` 变成了 `/`。

**换来**：**对登录加密完全免疫**——不管知乎的登录态校验接口怎么加密，URL 跳不跳是浏览器公开行为，永远 observable。

**代价**：

- **2 秒粒度的感知延迟**——扫码到感知之间最多差 2 秒；
- **最长有约 10 分钟的轮询窗口**（超时保护），期间一直占着一个 setInterval；
- **异步多出口必须靠一组布尔状态标志 + 幂等清理函数来协调**。这些出口包括：用户扫成功了、用户超时没扫、用户中途关了 webview 面板、用户点了重试——任何一种情况发生，都得把轮询停掉、把上下文关掉、把标志置位，**而且得保证不管哪个出口先触发，清理动作都只执行一次**。

> 这个协调的具体细节（`isCleanedUp` / `isDisposed` / `isLoginSuccess` / `isProcessingRetry` 四个标志怎么互相配合）属于工程脚手架，不展开。原理上要记住的只有一句：**异步多出口场景下，幂等清理比业务逻辑还重要**。

## 七、最小演示：把上面四条权衡演一遍

下面的脚本独立可跑，演透「借真实浏览器渲染登录页 → 截二维码（绕污染 canvas）→ 轮询 URL → 收割域名 Cookie」这条主链。**真实扩展里复用第 3 章那台 Chrome 单例**，这里为了能独立运行，自己 `launch` 一台；其它四步的逻辑跟扩展里完全一致。

```ts
import puppeteer from "puppeteer";

// ① 起浏览器（真实实现复用第 3 章单例；此处为可独立运行而 launch 一台）
const browser = await puppeteer.launch({ headless: false });

// ② 在单例上新开一个隔离上下文（类似无痕模式），保证登录判定不被已有 Cookie 干扰
const context = await browser.createBrowserContext();
const page = await context.newPage();

// ③ 隔离上下文没法继承第 3 章造页函数里的伪装，本流程自己重做一遍
await page.setUserAgent("Mozilla/5.0 ... 知乎能认出来的正常 UA ...");
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

// ④ 借力：导航到登录页，让知乎自己的 JS 把二维码画到 canvas 上
await page.goto("https://www.zhihu.com/signin", { waitUntil: "networkidle2" });
await page.waitForSelector(".Qrcode-qrcode");

// ⑤ 截图像素，而不是读 canvas —— 绕开 tainted canvas 的 SecurityError
//    （直接调 canvas.toDataURL() 在跨域图片污染时会抛异常）
const clip = await page.evaluate(() => {
  const rect = document.querySelector(".Qrcode-qrcode")!.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});
const qrPng = await page.screenshot({ clip, type: "png" });
const qrDataUrl = `data:image/png;base64,${Buffer.from(qrPng).toString("base64")}`;
// 推给 webview 展示，等用户掏出手机扫
console.log("二维码已就绪，长度:", qrDataUrl.length);

// ⑥ 轮询 URL，而不是调登录接口 —— 对加密完全免疫
await new Promise<void>((resolve) => {
  const timer = setInterval(async () => {
    const url = page.url();
    if (!url.includes("signin") && !url.includes("zhihu.com/signup")) {
      clearInterval(timer);
      resolve();
    }
  }, 2000);
});

// ⑦ 借力的二次落地：再导航到内容页，让知乎 JS 自己把签名 Cookie (__zse_ck) 写进去
await page.goto("https://www.zhihu.com/hot", { waitUntil: "networkidle2", timeout: 30000 });

// ⑧ 按域名过滤收割 Cookie（双层清洗的第一层：浏览器上下文层按域）
const allCookies = await context.cookies();
const zhihuCookies = allCookies.filter(
  (c) => c.domain === ".zhihu.com" || c.domain === "www.zhihu.com"
);
const keys = zhihuCookies.map((c) => c.name);

// ⑨ 验收闸门：签名 + 登录凭证缺一不可
if (!keys.includes("__zse_ck") || !keys.includes("z_c0")) {
  throw new Error("登录凭据不完整，拒绝落库");
}
// 后面交给第 2 章的 saveCookieString 做第二层清洗（按 key 前缀去第三方统计项）后落库

// ⑩ 收尾：关掉隔离上下文，刷新侧边栏列表（第 5 章能力）
await context.close();
await browser.close();
```

把上面十步对照前面的四条权衡看一遍：

| 步骤 | 体现的权衡 |
|------|------------|
| ④ ⑦ | **借力而非逆向**——让知乎 JS 替我们画二维码、写签名 Cookie |
| ② | **复用单例 + 新开隔离上下文**——登录判定干净、不污染主流程 |
| ⑤ | **截图像素而非读 canvas**——绕开 tainted canvas |
| ⑥ | **轮询 URL 而非调接口**——对登录加密完全免疫 |
| ⑧⑨ | 借力之后的**收割与验收**——按域名过滤 + 关键项校验 |

## 八、收尾

本章在「**算不出登录加密**」这个硬约束下，给出了一个不硬刚、转而借力的解法：把真实浏览器当成替我们算加密的算力，让它跑知乎自己的登录页 JS，扩展只做渲染、截图、等跳转、收割这几件事。

四条权衡里，**借力而非逆向是总纲**，另外三条（隔离上下文、截图绕污染、轮询 URL）都是这条总纲在不同环节的具体落地。把它们记成一组，比单独背其中任何一条都更接近这一章的设计本质。

到这里，扩展已经能拿到一份完整可用的登录凭据，下一步要解决的是另一件让人头疼的事：**侧边栏默认长成「知乎热榜」一眼假的样子**，怎么把它伪装成 VS Code 自己的文件树、降低被一眼发现的概率。这就是紧邻下一章「侧边栏伪装成假文件树」要讲的事。