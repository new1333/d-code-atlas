# 可插拔传输层：请求中立与处理器竞争

> 本章属于 primitive 层。前置：无（全书地基章之一）。学完你能：用一句话讲清"为什么 yt-dlp 把发请求设计成引擎竞争，而不是写死一个 HTTP 客户端"。

## 1. 为什么需要它

yt-dlp 是一个抓视频的工具，而抓视频这件事从头到尾都在"发请求"——拉首页解析视频地址、下载数据分片、走 WebSocket 接直播流、必要时还得带上浏览器 TLS 指纹去过 Cloudflare。请求这件事是全书一切流程的底座，所以全书从这一章开始：底座搞清楚了，后面每一章（提取器、下载器、后处理器）才能假定"我只要发个请求就能拿到数据"。

想象一下，如果"发请求"和"具体用什么引擎发"被焊死在一起——比如调用方写一行 `urllib.urlopen(url)`，那么一旦碰到 `wss://` 直播流、或者站点要求 curl 的 TLS 指纹，整个调用方都得改：加 `if scheme == 'wss'` 分支、加 `if needs_impersonate` 分支、引擎没装就直接崩溃。每加一个引擎就改一堆调用点，每少一个引擎就崩一片功能。

调用方真正想说的是另一件事：我只想描述"要请求什么"——给一个 url、一组 headers、一个代理，至于这个请求最后用 urllib 还是 curl_cffi 发出去，是 ws 还是 http，调用方根本不关心。换句话说，**"发什么"和"用什么发"应该彻底分开**：分开之后，加引擎是纯增量（装了新引擎就自动能用）、删引擎是优雅降级（没装就换下一个能用的，而不是崩溃）。

## 2. 核心思想

让请求对象只懂"要什么"，让多个引擎各自亮出能力清单竞争，由一个调度器按偏好打分择优接管——把"发什么"和"用什么发"彻底解耦。

## 3. 心智模型

这条主线分四块：中立请求 / 引擎能力自报 / 调度器打分择优 / 异常分层降级。

### 3.1 请求是与传输无关的中立数据对象

调用方构造一个 Request 对象，它只有 url、headers、method、代理、扩展槽这几个核心字段，对"用哪个引擎发"一无所知。

> 类比一次：Request 像一张快递单——上面写"送什么、送到哪、要不要保价"，至于顺丰还是京东揽件，单子本身不挑。

扩展槽（extensions）是个关键设计：超时、cookie 容器、是否要伪装、旧 SSL 兼容……这些"可选能力"都塞进这个 dict，而不是变成 Request 的独立字段。扩展槽是请求对象给未来留的活口，第 3 章会专门讲"伪装"是怎么挂进来的，本章只把它当通用机制看。

### 3.2 引擎用类变量自报能力

每个传输引擎（Handler 子类）用三个类变量声明自己的能力边界：

- `_SUPPORTED_URL_SCHEMES`：能处理哪些协议（http/https/ftp / ws/wss）
- `_SUPPORTED_PROXY_SCHEMES`：支持哪些代理协议（http/socks4/socks5）
- `_SUPPORTED_FEATURES`：支持哪些特性开关（比如 all/no 代理特殊键）

这些是引擎的"招工简历"，调度器据此判断要不要把某个请求派给它。置 `None` 表示关闭该项检查。

### 3.3 调度器打分 + 自检 + 第一个通过的接管

每次 `director.send(request)` 的流程：

1. 对每个已装引擎，把所有已注册偏好函数的得分求和，作为该引擎的"偏好分"。
2. 按分从高到低排序引擎。
3. 从最高分开始，逐个让引擎做**能力自检**：url 协议、代理协议、特性、扩展槽，任一项不符就抛 `UnsupportedRequest` 并附原因。
4. 第一个通过自检的引擎**立刻接管**，真正发出请求并返回响应；后面的引擎不再尝试。
5. 全部失败 → 调度器抛 `NoSupportingHandlers`，消息里聚合每个引擎各自为什么拒绝。

### 3.4 异常分层

- `UnsupportedRequest`：能力不匹配，不是错误，是降级信号。调度器收集后跳过。
- `TransportError / HTTPError`：引擎运行期的网络/HTTP 错误，共同祖先是 `RequestError`，原样透传给调用方。
- 其它非 `RequestError` 的异常：视为引擎自身 bug，记入 unexpected_errors 后继续尝试下一个引擎，不立即崩。

## 4. 关键权衡

### 能力自检换可插拔与优雅降级

调度器允许每个引擎在真正发请求之前先做一次"我能接这个请求吗"的自检（验协议、代理、扩展），不支持就主动让位。

**换来**：换引擎、加引擎都是纯增量——curl_cffi 没装？自动落到 urllib。websocket 引擎没装？ws 请求会清楚告诉你"没引擎支持 ws 协议"，而不是在调用深处崩一个 ImportError。整条链路对"哪个引擎装了/没装"完全免疫。

**代价**：每个引擎必须诚实、完整地自报能力，否则就是双向灾难——少报（其实支持 ws 却只报了 http）会被永远跳过、能力闲置；多报（其实不支持 socks5 却报了）会硬接后运行时炸。这条权衡把"诚实"做成了引擎作者不可推卸的契约义务。

**本质矛盾**：可扩展性 vs 能力诚实。要让插件式引擎能任意装/卸，引擎就必须把自己的能力边界主动写出来，调度器无法从外部推断一个引擎能干什么。

### 偏好函数求和换路由规则可独立叠加

引擎优先级不是写死的"urllib > requests > curl_cffi"清单，而是一组可被外部独立注册的偏好函数 `(handler, request) → int`，调度器把所有函数的得分**求和**作为引擎最终分。

**换来**：每条路由规则都可以独立注册、互不感知。第 3 章会看到：当请求要伪装时，伪装偏好函数给支持伪装的 curl_cffi 加 1000 分胜出；用户开启"prefer-legacy-http-handler"兼容选项时，另一条偏好函数给 Urllib 加 500 分。两条偏好彼此独立叠加，谁也不知道对方存在。

**代价**：最终排序是"多条偏好之和"，没有单一真相来源。某个引擎为什么排在第三？要把所有偏好函数的得分都加一遍才能解释，所以调度器在 verbose 模式下专门打印每个引擎的得分明细。

**本质矛盾**：可组合性 vs 直觉可预测性。要允许任意规则叠加，就不能维持一个清晰的优先级表；要清晰的优先级，就不能让外部独立注入规则。yt-dlp 选择了前者。

### 可选能力塞进扩展槽换请求核心字段稳定

超时、cookie 容器、旧 SSL 兼容、伪装目标……这些可选能力**不是** Request 的独立字段，而是统一塞进 `extensions` 这个 dict。

**换来**：Request 的核心字段（url/headers/method/proxies）锁死不再变。后续要加新能力（比如第 3 章的"伪装"），只要约定一个新扩展 key，引擎在自检时认领它就行，调用方不用改 Request 构造函数签名，老代码完全零侵入。

**代价**：多一层"扩展认领"协商。引擎自检时必须把自己支持的扩展一个个 pop 掉，**凡是剩下的扩展都被视为"该引擎不支持"——请求被这个引擎跳过**。这一条让"扩展"和"能力探测"牢牢绑死：扩展没被认领 = 引擎能力不够 = 降级到下一个引擎。

**本质矛盾**：开放扩展 vs 强类型契约。把可选能力放进 dict 才能无限扩展，但 dict 没有类型签名，只能靠"认领即支持"的运行时约定来支撑。

### 聚合拒绝原因换诊断友好

调度器不把"所有引擎都不行"当成一句简单报错丢出去。它把每个引擎各自因为什么拒绝、各自出了什么意外异常，分别收集到 unsupported_errors 和 unexpected_errors 两个列表，最后聚合进 `NoSupportingHandlers` 的错误消息。

**换来**：用户看到的是"Urllib 不支持 ws 协议 | Websockets 不支持 cookie 扩展"——一眼就能看清是哪个引擎的哪个能力不够，知道接下来该装什么、改什么。比起一句"无可用引擎"，这是天差地别的可调试性。

**代价**：每次请求至少要触发一次自检（哪怕最后只用第一个引擎），是固定开销。更微妙的是，引擎运行期抛出的非 `RequestError` 异常会被吞掉、收集后继续重试下一个——这能避免某个引擎的 bug 把整条链路打挂，但也意味着引擎自身的真实 bug 可能被掩盖在"跳到下一个引擎"的沉默里。

**本质矛盾**：诊断信息 vs 性能 + bug 可见性。要给出完整拒绝原因，就要让每个引擎都跑一次自检；要把引擎 bug 和"能力不够"分开处理，就要在意外异常时吞掉重试，但这又可能掩盖 bug。

## 5. 最小原理演示

下面用一段 TS/JS 演透这条主线：中立请求、引擎自报能力、扩展认领、偏好打分、自检降级聚合。**每一行对应上面某条原理**，不演示原理的实现细节（完整代理校验、真网络 IO、深拷贝）一律省略。

```ts
// 不支持信号：能力不匹配时抛出，调度器据此降级到下一个引擎
class Unsupported extends Error {}

// 中立请求：只描述"要什么"，扩展槽承载可选能力
class Request {
  url: string
  scheme: string
  extensions: Record<string, unknown>
  constructor(url: string, opts: { extensions?: Record<string, unknown> } = {}) {
    this.url = url
    this.scheme = url.split(':')[0]
    this.extensions = opts.extensions ?? {}
  }
}

// 引擎基类：用类变量自报能力（schemes），自检时未认领的扩展视为不支持
abstract class Handler {
  abstract name: string
  abstract schemes: Set<string>
  abstract send(r: Request): string

  validate(r: Request) {
    if (!this.schemes.has(r.scheme))
      throw new Unsupported(`${this.name}: 不支持协议 ${r.scheme}`)
    const leftover = this._claimExtensions(r.extensions)
    if (Object.keys(leftover).length > 0)
      throw new Unsupported(`${this.name}: 不支持扩展 ${Object.keys(leftover).join(',')}`)
  }
  // 子类 override 时 pop 掉自己认领的扩展；基类默认一个都不认领
  protected _claimExtensions(e: Record<string, unknown>): Record<string, unknown> {
    return { ...e }
  }
}

// Urllib 引擎：接 http/https/ftp，不认领任何扩展（教学简化）
class Urllib extends Handler {
  name = 'Urllib'
  schemes = new Set(['http', 'https', 'ftp'])
  send(r: Request) { return `[urllib] GET ${r.url}` }
}

// Websockets 引擎：接 ws/wss，认领 cookies 扩展
class Websockets extends Handler {
  name = 'Websockets'
  schemes = new Set(['ws', 'wss'])
  protected _claimExtensions(e: Record<string, unknown>) {
    const rest = { ...e }
    delete rest.cookies  // 引擎声明：我认识 cookies
    return rest
  }
  send(r: Request) { return `[ws] connect ${r.url}` }
}

// 调度器：偏好打分排序 → 逐个自检 → 第一个通过的接管；拒绝原因全部收集
class Director {
  constructor(
    private handlers: Handler[],
    private prefs: ((h: Handler, r: Request) => number)[] = [],
  ) {}
  private score(h: Handler, r: Request) {
    return this.prefs.reduce((s, p) => s + p(h, r), 0)
  }
  send(r: Request): string {
    const ranked = [...this.handlers].sort((a, b) => this.score(b, r) - this.score(a, r))
    const reasons: string[] = []
    for (const h of ranked) {
      try {
        h.validate(r)
      } catch (e) {
        if (e instanceof Unsupported) { reasons.push((e as Error).message); continue }
        throw e  // 非不支持类异常（引擎 bug）：透传，不吞
      }
      return h.send(r)
    }
    throw new Error(`无可用引擎：${reasons.join(' | ')}`)
  }
}

// 偏好函数示例：要伪装时给支持伪装的引擎加分（这里 CurlCffi 没注册，得 0 分）
const preferImpersonate = (h: Handler, r: Request) =>
  r.extensions.impersonate && h.name === 'CurlCffi' ? 1000 : 0

const d = new Director([new Urllib(), new Websockets()], [preferImpersonate])

console.log(d.send(new Request('https://x')))    // [urllib] GET https://x
console.log(d.send(new Request('wss://live/x'))) // [ws] connect wss://live/x
console.log(d.send(new Request('gopher://x')))
// 抛: 无可用引擎：Urllib: 不支持协议 gopher | Websockets: 不支持协议 gopher
```

跑一遍：

- `https://x`：Urllib 偏好分 0、Websockets 偏好分 0，排序后 Urllib 先到，自检通过 → 返回 `[urllib] GET https://x`。
- `wss://live/x`：Urllib 自检 `wss` 不在 schemes，让位；Websockets 自检通过 → 返回 `[ws] connect wss://live/x`。
- `gopher://x`：两个引擎自检全失败 → 抛"无可用引擎"，附上每个引擎的拒绝原因。

## 6. 执行轨迹

跟踪一次真实路径，看每个引擎的内部状态怎么变。

**初始**：已装 `[Urllib(schemes={http,https,ftp})、Websockets(schemes={ws,wss})]`，偏好函数 `preferImpersonate`（本次请求不带 impersonate 扩展，不命中）。

**请求 A** `wss://live/x`：

1. 进入 `Director.send`。算偏好分：Urllib=0、Websockets=0。排序后 Urllib 在前（同分时维持原序）。
2. 取 Urllib，调 `validate(request)`：
   - 查 scheme：`wss` 不在 `{http,https,ftp}` → 抛 `Unsupported("Urllib: 不支持协议 wss")`。
   - Director 把这条原因 push 进 reasons 列表，continue 到下一个引擎。
3. 取 Websockets，调 `validate(request)`：
   - 查 scheme：`wss` 在 `{ws,wss}` ✓
   - 扩展槽为空，认领后无残留 ✓
4. 自检通过 → 调 `Websockets.send(request)` → **输出** `[ws] connect wss://live/x`。Urllib 的 send 没被调用。

**请求 B** `gopher://x`：

1. 偏好分都为 0，Urllib 先到。
2. `Urllib.validate`：`gopher` 不在 schemes → Unsupported，reasons 记一笔。
3. `Websockets.validate`：`gopher` 不在 schemes → Unsupported，reasons 再记一笔。
4. 循环结束仍无引擎通过 → **抛** `Error: 无可用引擎：Urllib: 不支持协议 gopher | Websockets: 不支持协议 gopher`。

注意请求 B 抛出来的消息：它不是泛泛的"失败"，而是把每个引擎的拒绝原因拼起来——用户看到这条消息就知道"协议两个引擎都不认"，下一步要么换 url，要么装支持 gopher 的引擎。

## 7. 教学简化说明

本章演示故意省略了：完整代理协议校验（`all`/`no` 特殊键）、真实 SSL/网络 IO、headers 大小写保留、深拷贝、urllib 向后兼容垫片（`.code`/`.getcode()`/`.info()`）、`@register_rh` 注册装饰器与类名 `RH` 后缀的发现机制。最后这一项是下一章的主题，本章只把它当"四个引擎已经装进了调度器"的既成事实使用。

## 8. 小结

把"发什么请求"和"用什么引擎发"拆开，让请求只描述意图、引擎各自亮能力清单竞争、调度器按偏好打分择优——这是全书一切网络抓取的底座。代价是引擎必须诚实自报能力、引擎排序没有单一真相、扩展槽多一层认领协商、意外 bug 可能被吞。下一章会看到，这些"已装引擎"是怎么靠一个类名后缀约定和容错导入被自动发现的，那套发现机制本身才是 yt-dlp 一切插件式扩展的真正起点。
