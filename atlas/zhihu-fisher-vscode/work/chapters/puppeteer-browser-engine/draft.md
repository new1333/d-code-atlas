# 防反爬浏览器引擎

> 本章属于 primitive 层。前置：Cookie 凭证的清洗与校验、全局共享状态容器。
> 学完你能用一句话讲清：为什么对抗知乎反爬要从「补 HTTP 请求头」换成「伪装一台真 Chrome」，以及这么做换来了什么、代价是什么。

## 1. 为什么需要它

上一章把知乎 Cookie 里那些会拖累请求的破绽——第三方统计项、签名缺失、会被重定向到热榜的 BEC——都收拾干净了。但拿这份干净 Cookie 用纯 HTTP 去敲门，知乎照样把你挡在外面：返回 403，或者直接把你甩到一个无关的页面。

因为知乎的反爬不只看 Cookie。它至少还会查两件事：你的浏览器是不是被程序自动控制的，以及你拿到页面后有没有像人一样滚动——任何一条对不上，就判定你不是真人。更糟的是，知乎把核心内容交给 JS 渲染，HTTP 拿到的 HTML 经常只是一个空壳子，正文根本不在里面。

纯 HTTP 拼请求头本质上是在跟这种综合检测玩猫鼠：今天补一个 `Sec-Ch-Ua`，明天又冒出一个没听过的字段。补到什么时候是头？这个机制就是为了把这场猫鼠游戏彻底停下而生的。

## 2. 核心思想

**停止逐个补 HTTP 请求里漏掉的指纹，直接开一台被悄悄伪装过的真 Chrome 去敲门。**

一台真实运行的 Chrome 自带完整的 JS 引擎、真实的浏览器指纹、能渲染页面、能执行知乎的反爬脚本——这些都不用你再造。你只需要做一件事：抹掉「这台 Chrome 是被 puppeteer 自动控制的」这一处独有的破绽，再把干净的登录态塞进去，让它看起来像一台普通人正在用的 Chrome。

把「对抗」降级成「伪装」，是这一招的本质。

## 3. 心智模型

挂在前置章『全局共享状态容器』讲的那个模块级单例上的，是这一章的两个新字段：

- `browserInstance`：全扩展唯一一台 Chrome 实例（懒创建，第一次取的时候才启动）
- `pagesInstance`：一个 `Map<调用方键, page>`，把每个爬取页面登记到它的调用方名下（比如某个 webview 的 id，或 `search`/`follow` 这种功能名）

整台引擎的运转流程：

1. 调用方要爬内容前，先问一次**轻探针**：系统里有没有可用的浏览器可执行文件？这一步只查文件存不存在，**不真的启动**浏览器。
2. 探针通过后，取 `browserInstance`：字段为空才启动 Chrome（用户配的路径优先，否则用内置默认路径）；启动失败最多重试几次，每次先把残留实例关掉再重试。
3. 基于 `browserInstance` 新建一个页面，立刻做**三件伪装**：伪造一个主流 Chrome 的 User-Agent、注入清洗过的登录 Cookie、在每个新文档加载前抹掉 `navigator.webdriver` 这个自动化指纹。
4. 导航到目标知乎页，在页面自己的 JS 上下文里提数据，必要时模拟人类滚动触发懒加载。
5. 把这个页面以调用方给的键登记进 `pagesInstance`，后续同一个键直接复用。
6. 调用方（比如某个 webview）被关闭或切走时，按键关掉对应页面。
7. 定期清扫 `pagesInstance`：凡是没有对应调用方条目的页面，视为孤立，集中关掉。

一句话点透：浏览器本身是共享的单例，页面是按调用方登记的资源，伪装发生在页面出生的那一刻。

## 4. 关键权衡

### 开真 Chrome 换整体通过安检

选择开一台真实 Chrome 去执行 JS、带上完整浏览器指纹，换来的是「整体通过反爬安检、拿到 JS 渲染后的真实内容」——知乎那段检测脚本在真浏览器里跑过，自然得出「这是普通人在用的浏览器」的结论；页面里的懒加载内容由 Chrome 自己渲染，你直接拿到成品。

代价是**重资源**：启动一台 Chrome 比发一个 HTTP 请求慢得多、吃内存也多得多；以及**页面不会随调用方自动销毁**——HTTP 请求一结束连接就没了，但一个被打开的 Chrome 标签页会一直留在那儿，必须有人去关它。这条代价催生了下面的第四条权衡。

这条权衡化解的本质矛盾是：**反爬检测的完备性** 与 **请求构造的可控性** 之间的对立——你越想自己控制请求的每一个字节，就越难伪装到位；你伪装得越像，就越不能自己控制每一个请求。

### 全扩展共享一台浏览器换一次启动和全局登录态

所有爬取页面共用同一台 Chrome、同一份登录上下文。换来的是「浏览器只启动一次、Cookie 只注入一次就全局生效」，没有任何重复启动或重复注入的开销。

代价有两条。第一是**单点脆弱**：这台 Chrome 一旦崩了，挂在上面的所有页面同时全挂，没有局部重试的余地。第二是**隐式全局副作用**：注入 Cookie 时调的是浏览器级 `setCookie` 而不是页面级 `page.setCookie`，意味着一处注入在整台浏览器的所有页面里同时生效——一个页面改了登录态，其它页面立刻就跟着改了，调用方之间互不可见。

这条权衡化解的本质矛盾是：**复用资源的效率** 与 **状态隔离的纯洁性** 之间的对立——共享一台浏览器必然共享它的所有状态。

### 轻探针与重启动分离换 UI 流程提前拦截

把「浏览器是否可用」做成一个**只查文件是否存在、不真正启动**的探针，与「真正启动浏览器」分成两个独立方法。换来的是 UI 流程（用户点了扫码登录、点了搜索）能在**不触发重启动也不弹任何交互窗口**的前提下，提前判断浏览器可用性、把用户引导去配置好再继续。

代价是**判断逻辑写了两遍**：「用户配的自定义路径为空时怎么走、版本目录存在但可执行文件缺失意味着什么」这一套路径校验，在探针和启动里各实现了一次——这是个真实的重复，源码里能看到两份几乎一样的判断。

这条权衡化解的本质矛盾是：**UI 的轻量探测需求** 与 **启动的真实成本** 之间的对立——你不能为了问一句「能用吗」就真启动一次。

### 页面与调用方解耦换灵活复用

爬取页面不与调用方（webview、命令）的生命周期绑定，而是按一个键登记进注册表、独立存在。换来的是「一个页面可以跨多次导航复用、也可以由一个调用方编排多个页面」，编排逻辑非常灵活。

代价是**必须显式清理**。Chrome 不会因为调用方关了就自动关掉对应页面；你不关，它就一直占着内存、占着 Chrome 的标签页额度。所以引擎需要一套反向判定：定期拿注册表里的键去对调用方映射——凡是没有对应调用方条目的页面，一律视为孤立，关掉。容错也跟着来：关之前先查它是不是已经被关了，捕获「Target closed」这种「其实已经没了」的错误，静默清引用而不抛出。

这条权衡化解的本质矛盾是：**资源复用的灵活性** 与 **生命周期管理的确定性** 之间的对立——你把生命周期从调用方手里拿走，就得自己负责到底。

## 5. 最小原理演示

下面这段几十行的脚本演透两件事：一是「真浏览器 + 抹指纹」如何通过一个会查 `navigator.webdriver` 的检测点；二是「页面注册 → 调用方销毁 → 孤立页面清扫」的生命周期骨架。所有工程化脚手架（重试次数、路径裁剪、平台分支、配置读写）都故意省略。

```ts
import puppeteer from 'puppeteer'

// 全扩展唯一一台 Chrome：懒创建
let browser: puppeteer.Browser | null = null

async function getBrowser(): Promise<puppeteer.Browser> {
  if (browser) return browser
  browser = await puppeteer.launch({ headless: true })
  return browser
}

// 页面注册表：调用方键 → 页面
const pages = new Map<string, puppeteer.Page>()
// 还活着的调用方键
const activeCallers = new Set<string>()

async function createPage(key: string): Promise<puppeteer.Page> {
  const b = await getBrowser()
  const page = await b.newPage()

  // 伪造主流 Chrome 的 UA，对得上 Cookie 的来源
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/122.0.0.0 Safari/537.36'
  )

  // 每个新文档加载前抹掉 webdriver 指纹
  // 这是 puppeteer 控制下的 Chrome 独有的破绽
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  // 注入清洗过的登录态（前一章 Cookie 清洗的产物）
  // 浏览器级 setCookie：一处注入，全浏览器生效
  await page.setCookie({
    name: 'z_c0',
    value: 'mock-login-token',
    domain: '.zhihu.com',
  })

  pages.set(key, page)
  activeCallers.add(key)
  return page
}

// 反向判定：注册表里凡是没有活跃调用方的页面，都是孤立
function cleanupOrphaned(): void {
  for (const [key, page] of pages) {
    if (activeCallers.has(key)) continue
    if (!page.isClosed()) page.close().catch(() => {})
    pages.delete(key)
  }
}

function callerDestroyed(key: string): void {
  activeCallers.delete(key)
}

// 对照实验：同样的请求，只切换是否抹掉 webdriver，看输出差异
async function probe(mask: boolean) {
  const b = await getBrowser()
  const page = await b.newPage()

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/122.0.0.0 Safari/537.36'
  )
  if (mask) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
  }

  await page.goto('https://www.zhihu.com/')
  const detected = await page.evaluate(() => navigator.webdriver)
  console.log(mask ? '已抹指纹:' : '未抹指纹:', 'navigator.webdriver =', detected)
  await page.close()
}

;(async () => {
  await probe(false)
  await probe(true)

  await createPage('webview-1')
  console.log('清扫前注册表大小:', pages.size)
  callerDestroyed('webview-1')
  cleanupOrphaned()
  console.log('清扫后注册表大小:', pages.size)

  await browser!.close()
})()
```

跑出来的对照就是核心思想的佐证：未抹指纹时 `navigator.webdriver` 是 `true`，知乎一眼识破；抹掉之后是 `undefined`，和一台普通人手动开的 Chrome 没有差别。剩下那段注册表与 `cleanupOrphaned` 的骨架，演的是第四条权衡——页面脱离调用方独立存在，于是必须有人显式收尾。

## 6. 执行轨迹

用户在侧边栏点开一篇知乎回答，引擎的实际走读：

1. **轻探针**：`canCreateBrowser()` 检查 Chrome 可执行文件是否在位（仅查文件，不启动），失败就提前把用户引去配置，不进入后续流程。
2. **懒启动单例**：`browserInstance` 字段为空，于是启动 Chrome（用户配的自定义路径优先，否则用内置默认路径），写回单例。后续所有调用复用这一台。
3. **新建页面 + 三件伪装**：基于这台浏览器开一个新 page，依次设主流 Chrome 的 UA、注入前一章清洗过的登录 Cookie、注册 `evaluateOnNewDocument` 抹掉 `navigator.webdriver`。
4. **导航 + 提数据**：`page.goto()` 到目标回答页，在页面自己的 JS 上下文里跑 `page.evaluate(...)` 提结构化字段（作者、正文、点赞状态）；必要时先 `mouse.wheel` 模拟人类滚动，把懒加载的回答挤出来。
5. **登记注册**：把这个 page 以该 webview 的 id 登记进 `pagesInstance`，后续同一个 webview 再点别的回答，直接复用这个 page 换 URL。
6. **调用方销毁 → 反向清扫**：用户关掉这个 webview，对应条目从 `webviewMap` 移除；下一次清扫遍历 `pagesInstance`，发现这个页面在 `webviewMap` 里已经查不到，判定为孤立，关掉、清引用。

最终输出：拿到真实渲染后的回答内容，且没有泄漏的 Chrome 标签页残留在后台。

## 7. 教学简化说明

本章演示故意省略了：5 次启动重试的精确次数与重试间隔；win32 下「版本目录存在但 chrome.exe 缺失意味着下载未完成」的精确路径裁剪；三种操作系统的默认路径表；用户自定义路径不存在时的交互式错误弹窗与按钮分支；`protocolTimeout`、`pipe: true` 等启动参数的逐项含义；`--disable-features=...` 这类平台特定调优；以及「无头模式下仍把窗口位置移到屏幕外」的兜底逻辑。它们是工程化的必要细节，但不是原理主线。

## 8. 小结

这一章真正改的不是技术栈，而是问题本身的层次：从「我能不能补齐这套请求头」换成「我能不能伪装得像一台真的浏览器」。后面所有重资源、单点脆弱、必须显式清理的麻烦，都是这个层次切换带来的副作用。

但本章只解决了「读」这一侧。投票、收藏、关注、不喜欢这类「写」操作，居然不沿用这台已经伪装好的 Chrome，反而另起一套走知乎官方 JSON API 的客户端——下一章就讲为什么。