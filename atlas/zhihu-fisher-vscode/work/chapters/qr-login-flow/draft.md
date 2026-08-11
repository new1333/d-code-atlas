# 扫码登录全流程

> 本章属于 system 层。前置：防反爬浏览器引擎、Cookie 凭证的清洗与校验、侧边栏内容列表。
> 学完你能用一句话讲清：为什么登录这件事必须「借力」知乎自己的前端 JS、不去逆向，以及这么做换来了什么、代价是什么。

## 1. 为什么需要它

上一章把「伪装」做到了极致，标签条、内容叠层都安排了双层策略。可伪装救不了一个根本问题：扩展里看到的知乎内容，前提是用户已经是登录态。Cookie 用着用着就过期，到期了就得重登，前面所有花活都依赖这个隐含前提。

可是登录这件事，比爬内容更难。

知乎登录走的是加密接口。每发一个登录请求，都要带一个动态签名，签名算法在它自家前端 JS 里被混淆得乱七八糟，而且随时在变。逆向？今天花了三天抠出来，下周它一升级就作废。让用户自己去浏览器 DevTools 里复制 Cookie？粘贴时漏一个关键项、多一个统计项，第 2 章那套清洗校验就得反复兜底——更别说 Cookie 还会过期。

这个机制要解决的，就是**在算不出登录加密的前提下，怎么拿到一份完整可用的登录凭据**。

## 2. 核心思想

把「破解登录加密」降级成「让知乎自己的前端 JS 替我们算一遍」。扩展一行加密代码都不写，只把结果偷出来。

落到操作上，扩展只做四件事：渲染登录页、截二维码、等页面跳转、收割域名 Cookie。整个流程里没有一处是「我们计算出来的」，加密、签名、Cookie 写入，全部由知乎自己的前端 JS 在真实浏览器里跑完后交到我们手上。

## 3. 心智模型

整个流程挂在第 3 章造好的那台浏览器单例上，复用它的「能否创建浏览器」前置校验（造不出就连登录页都打不开），但**登录特意在单例上新开一个隔离上下文**——这是与主爬虫流程的关键分野：主爬虫在主上下文开页并注入已有 Cookie；登录则要保证判定那一刻看到的状态是干净的。

七步走完一个登录：

1. **前置校验**：先问一次那台浏览器的可执行文件在不在，不在就弹错误引导去配置。这一步只查文件、不真启动。
2. **新开隔离上下文**：在共享单例上 `createBrowserContext()`，类似无痕模式，确保没有已有 Cookie 干扰登录判定。
3. **导航登录页 + 重新伪装**：隔离上下文里开页，伪造 UA、抹掉 `navigator.webdriver`。**这套伪装在本流程里重写一遍**，没有复用主流程的造页函数（后者要求已有 Cookie 且开在主上下文，与登录的隔离诉求冲突）。
4. **截二维码**：等二维码 canvas 出现，**截图像素矩形**（不读 canvas）、转 base64 推给 webview 展示。
5. **轮询 URL**：每 2 秒读一次 `page.url()`，一旦 URL 不再含 `signin` / `signup` 就认定扫码成功。
6. **触发签名 Cookie**：立刻再导航到内容页（热榜），让知乎前端 JS 在访问内容页时把签名 Cookie 写进上下文。签名是程序自己算不出的，必须靠这一步。
7. **域名收割 + 验收**：从隔离上下文里取所有 Cookie，只留知乎域的，校验 `__zse_ck`（请求签名）与 `z_c0`（登录凭证）都齐全才落库；最后关掉隔离上下文、刷新侧边栏。

不变量很朴素：**登录成功与否只看 URL 离开登录页；签名 Cookie 必须靠内容页 JS 写入**。整个流程里没有一处依赖自己算加密。

至于异步多出口（成功、超时、用户关面板、重试）的协调，放在一组布尔标志 + 一个幂等清理函数里——这部分属于工程脚手架，正文不展开。

## 4. 关键权衡

### 借力而非逆向——一行加密代码都不写

选择「**让知乎前端 JS 替我们算登录态与签名 Cookie，扩展只渲染页面、截屏、读 URL、收 Cookie**」→ 换来「登录加密怎么变都不用追、扫码即得完整凭据」→ 代价是「**必须真跑一台浏览器去渲染登录页**——纯 HTTP 拼请求头在这里完全失效，慢、重，且**强依赖知乎前端页面结构稳定**：`.Qrcode-qrcode` 这个 class 名一旦被改名、登录页 URL 一旦换路径，整个流程都得跟着改」。

这条权衡还有一个**二次落地**：登录成功后，扩展会**主动再导航一次到内容页**，逼知乎前端 JS 在访问内容页的瞬间把签名 Cookie 写进上下文。为什么需要这一步？因为扫码那一刻只拿到登录态主凭证，知乎的请求签名项是前端 JS 在你访问内容时**临时算、临时写**的，程序自己算不出——所以必须借这次二次导航「蹭」到签名 Cookie。这一步是从「扫码登录拿到的 Cookie 缺签名项」那个历史 bug 倒推回来的，如今作为「借力」总纲的延续环节存在。

化解的本质矛盾是 **登录加密的对抗性** 与 **扩展维护成本** 之间的对立——你越想自己解加密，就越是把整个扩展绑死在知乎某一个版本的算法上；你越把算加密这件事交还给知乎自己的 JS，扩展就越轻、越耐久。

### 复用单例 + 新开隔离上下文

选择「**登录不另 launch 第二台浏览器，而是在共享单例上新开一个无痕上下文**」→ 换来「登录态判定干净：隔离上下文里没有主爬虫已注入的 Cookie，扫码前后看到的状态变化是可信的；同时也省下第二台浏览器的启动开销与内存」→ 代价是「**这个上下文必须由本流程单独关闭**（不关就一直占着），**而且其内的防反爬伪装（伪造 UA、抹 webdriver）无法继承主流程的造页函数**——因为后者默认开在主上下文、且要求页面已注入登录 Cookie，恰好与登录这两条诉求冲突，所以伪装代码在本流程里**重写了一遍**」。

化解的本质矛盾是 **资源复用的效率** 与 **登录态判定的纯洁性** 之间的对立——共享一台浏览器省资源，但共享主上下文就会污染判定，于是把隔离粒度从「浏览器级」下沉到「上下文级」：复用浏览器、隔离上下文，两边都要。

### 截图像素而非读 canvas

选择「**用 `page.screenshot({ clip })` 截二维码画布的像素矩形**，而非调 `canvas.toDataURL()`」→ 换来「**绕开跨域图片污染 canvas 导致的 SecurityError**：知乎二维码 canvas 里如果含有跨域图片资源（图标、Logo 等），调 `toDataURL` 会抛 Tainted Canvas 异常，截图像素则完全无感」→ 代价是「**拿到的是裸像素位图、不是结构化数据**，要展示还得转 base64 塞进 webview；**而且依赖元素的布局坐标**——必须先在页面上下文里读 `getBoundingClientRect()` 拿到像素矩形，元素被布局推走或被 transform 缩放都会让截图错位」。

化解的本质矛盾是 **通用像素采集** 与 **结构化数据采集** 之间的对立——读 canvas API 是「结构化优先」的做法，但跨域安全策略把它堵死了；截图是「像素优先」的做法，永远可用但丢失了「这就是个二维码」的语义。这里是被环境逼着选了后者。

### 轮询 URL 而非调登录接口

选择「**每 2 秒读一次 `page.url()`，看是否离开了登录页**来判定登录成功」→ 换来「**对登录加密完全免疫**：不需要懂任何登录接口的入参出参，只要观察『页面被知乎自己跳转走了』这个可见副作用即可」→ 代价是「**2 秒粒度的感知延迟**、最长约 10 分钟的轮询窗口，并且**异步多出口（成功 / 超时 / 用户关面板 / 重试）必须靠一组布尔状态标志 + 一个幂等清理函数来协调**——`isCleanedUp` / `isDisposed` / `isLoginSuccess` / `isProcessingRetry` 这套标志就是为了在多出口下保证『清理只发生一次、登录成功只处理一次』」。

化解的本质矛盾是 **登录成功的判定精度** 与 **加密协议的不可知性** 之间的对立——你想精确知道「登录态在毫秒级被写入」，就必须解码加密响应；你越退到外层观察副作用（URL 跳没跳），精度越低，但越不依赖加密协议。

> 这条权衡其实是上一条「借力而非逆向」在「判定成功」环节的再次落地：既然算不出加密，就既不自己发登录请求、也不读登录响应，只看知乎自己跳没跳走。读者认出这个共同骨架即可，不必当成两条独立的原理。

### 验收闸门复用第 2 章的清洗校验

读到这里读者可能会问：拿到的 Cookie 直接保存不就行？为什么还要校验？因为扫码成功只意味着「登录态主凭证拿到了」，签名项要靠二次导航写入，写入是否成功、有没有漏，不能假设。所以扩展在落库前设了一道**验收闸门**：必须同时含 `__zse_ck` 与 `z_c0` 才保存，缺一即报错。这是第 2 章那套「清洗 + 校验」原理在登录流程里的**新角色**——之前它管「用户粘进来的脏 Cookie」，现在它管「登录产物是否合格」，是同一套工具在不同环节的复用，原理不再展开。

至于双层清洗（浏览器上下文层按域名过滤、字符串层再按第三方黑名单过滤），同样复用第 2 章的成果——本章只补一句：登录流程在「域名过滤」这一层多走了一步，从浏览器拿到全量 Cookie 后**先按 `.zhihu.com` / `www.zhihu.com` 域名摘出来**，再交给第 2 章的清洗函数做字符串层处理。

## 5. 最小原理演示

下面这段独立 Node 脚本演透三件事：① 借力——一行加密都不写、让浏览器自己跑；② 截图绕污染——直接用 `page.screenshot({ clip })`；③ 域名收割——只摘知乎域 Cookie。所有工程脚手架（webview 多态 HTML、四个布尔标志的协调、重试 / 超时 / Esc 关闭、命令注册）都故意省略。

```ts
import puppeteer from 'puppeteer'

// 演示：借真实浏览器渲染登录页 → 截二维码 → 轮询 URL → 收割域名 Cookie
// 扩展一行登录加密都不写，知乎前端 JS 替我们跑完整套登录态计算

async function loginViaQRCode() {
  const browser = await puppeteer.launch({ headless: false })

  // 在共享单例上新开一个无痕上下文：登录判定不被已有 Cookie 干扰
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()

  // 抹掉自动化痕迹：本流程内独立实现一遍，不调主流程的造页函数
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })
  await page.setUserAgent('Mozilla/5.0 ... 真实 Chrome UA')

  // 借力：登录加密由知乎前端 JS 自己跑，扩展只负责导航
  await page.goto('https://www.zhihu.com/signin')
  await page.waitForSelector('.Qrcode-qrcode')

  // 截图像素而非读 canvas：跨域图片会污染 canvas，调 toDataURL 会抛 SecurityError
  const clip = await page.evaluate(() => {
    const rect = document.querySelector('.Qrcode-qrcode')!.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  const png: Buffer = await page.screenshot({ clip, type: 'png' })
  const qrCodeDataUrl = `data:image/png;base64,${png.toString('base64')}`
  // 这个 dataUrl 塞进 webview <img src> 即展示，用户拿知乎 App 扫

  // 轮询 URL 而非调登录接口：对加密完全免疫，只看知乎自己跳没跳走
  while (true) {
    await new Promise(r => setTimeout(r, 2000))
    const url = page.url()
    if (!url.includes('signin') && !url.includes('signup')) break
  }

  // 二次借力：导航到内容页，逼知乎前端 JS 把 __zse_ck 签名 Cookie 写进上下文
  await page.goto('https://www.zhihu.com/hot', { waitUntil: 'networkidle2' })

  // 域名收割：只摘知乎域 Cookie（字符串层清洗属于第 2 章，此处不演示）
  const all = await ctx.cookies()
  const zhihuCookies = all.filter(c => c.domain === '.zhihu.com' || c.domain === 'www.zhihu.com')
  const keys = new Set(zhihuCookies.map(c => c.name))
  // 验收闸门：签名 + 登录凭证齐全才落库
  if (!keys.has('__zse_ck') || !keys.has('z_c0')) throw new Error('登录态不完整')

  await ctx.close()   // 隔离上下文必须由本流程单独关闭
  return zhihuCookies
}
```

跑一遍的体感是：扩展全程没碰任何加密，登录态却完整地落到了自己的 Cookie 仓库里。这就是「借力」四个字在代码里的样子。

## 6. 执行轨迹

拿一个具体输入走一遍：用户首次点「扫码登录」命令。

```
1.  前置校验 canCreateBrowser() → 通过
2.  getBrowserInstance() 取共享单例 → createBrowserContext() 拿到隔离 ctx
3.  ctx.newPage() → 导航 https://www.zhihu.com/signin → waitForSelector('.Qrcode-qrcode')
    页面状态：登录页画好，二维码 canvas 已渲染
4.  page.evaluate(getBoundingClientRect) → { x: 612, y: 240, width: 180, height: 180 }
5.  page.screenshot({ clip }) → 拿到 180×180 的 PNG Buffer
6.  Buffer.toString('base64') → 拼成 data:image/png;base64,iVBORw0...
7.  panel.webview.html = 二维码展示页（含上面这个 dataUrl）
    用户视角：看到二维码
8.  用户打开知乎 App → 扫码 → 点确认
9.  知乎前端 JS 自己完成登录、自己把页面跳到 https://www.zhihu.com/
    扩展此时仍在 setInterval(2s) 轮询 page.url()
10. 第 N 次轮询：url = 'https://www.zhihu.com/' —— 不含 signin / signup → 判定登录成功
11. 立刻 page.goto('https://www.zhihu.com/hot', { waitUntil: 'networkidle2' })
    这一刻知乎前端 JS 在访问内容页时把 __zse_ck 签名 Cookie 写进 ctx
12. ctx.cookies() → 拿到约 30 条全量 Cookie
13. 按 domain 过滤 → 只剩约 12 条知乎域 Cookie
14. Set.has('__zse_ck') && Set.has('z_c0') → 验收通过
15. CookieManager.saveCookieString()（第 2 章的清洗 + 落库）
16. 再问一次 canCreateBrowser() —— 与手动设置 Cookie 的逻辑对齐：
    登录虽拿到了 Cookie，但若浏览器的执行文件此刻不可用，列表刷出来也点不开
    （第 5 章「点不开详情的列表毫无意义」的延伸）
17. cleanupPage() 关掉隔离上下文；各 sidebar.refresh() 刷新侧边栏（第 5 章）
```

中间态的关键点：第 8–10 步是「**等知乎自己跳走**」，扩展没有发任何请求，只是每 2 秒瞄一眼 URL；第 11 步是「**逼知乎 JS 把签名 Cookie 写进来**」，这一步发生得非常隐蔽，却是登录流程能不能用的真正分水岭——少了它，第 14 步的验收闸门会直接报「缺 `__zse_ck`」。

## 7. 教学简化说明

本章演示故意省略了：webview 多态 HTML 的拼接（加载中 / 等待 / 二维码展示 / 成功 / 超时 / 错误六态）、四个布尔标志（`isCleanedUp` / `isDisposed` / `isLoginSuccess` / `isProcessingRetry`）的具体协调、重试（关面板重开命令）、超时（约 10 分钟）、Esc 关闭等交互分支、HTML 实体转义细节、命令注册与依赖注入。这些是工程脚手架，不是原理。

## 8. 小结

整套登录流程的灵魂就四个字：**借力，不逆向**。把加密、签名、Cookie 写入全部交还给知乎自己的前端 JS，扩展只做最简单的四件事——渲染、截图、轮询、收割。这一章把前面所有章节首次串到一条端到端的用户操作上：前置章造的浏览器单例、Cookie 清洗校验、侧边栏刷新，在这里第一次合在一起跑通。可登录办成之后，侧边栏开始承载真实知乎内容，知乎一旦在 VSCode 里露脸，失焦那一刻还是会被瞄见——下一章就把侧边栏这层也伪装起来。