# 浏览器指纹伪装：作为扩展叠加的传输能力

> 本章属于 composite 层。前置：可插拔传输层：请求中立与处理器竞争。
> 学完你能：用一句话讲清——"我要伪装成浏览器"这句意图，是怎么不动路由骨架、只往请求里塞一个扩展槽字段、再用一条偏好函数让会伪装的引擎自动胜出的。

## 1. 为什么需要它（设计动机）

上一章讲了「约定胜配置」的插件注册机制，把"丢一个文件即可注册新提取器/后处理器/请求处理器"这件事办成了。但它解决的是「类怎么被发现」，没有回答另一个问题：当用户对同一个传输引擎说"假装成 Chrome"时，这句意图应该放在哪里、由谁来响应？本章就接着这条线讲。

不过本章真正依赖的地基是第 1 章「可插拔传输层」——它当时把"发什么请求"与"用哪个引擎发"解耦了，但故意没说"附加能力"该怎么挂。本章就沿着那条缝接着讲：怎么把"浏览器伪装"这种**附加能力**叠加到那套已经搭好的骨架上。

具体场景是这样的。很多站点识别"是不是真浏览器"，看的根本不是 User-Agent 字符串——TLS 握手时 ClientHello 里的 cipher/extension 顺序（JA3 指纹）、HTTP/2 帧序与设置帧、甚至 Accept-Language 等默认 header 的细微差异，都会出卖你。光改 UA 字符串没用，指纹一对不上就直接验证码或封 IP。

更要命的是，"能真改 TLS 指纹"的网络库屈指可数（curl_cffi 算一个，它底层用 BoringSSL 重放真实浏览器的 ClientHello），大部分库（urllib、requests）连 TLS 指纹是什么都改不了，顶多改改 header。

那矛盾就来了：

- "我要不要伪装"是**上层每个请求都可能表达的意图**；
- "能不能真伪装"取决于**底层引擎碰巧用了哪个库**。

如果让上层直接挑引擎，意图和实现就绑死了。于是设计者借用了第 1 章那两块已经搭好的积木——**请求对象的中立扩展槽**（让意图有地方放，且对所有引擎中立）和**路由器的偏好排序**（让"谁能伪装"在路由层自动胜出，而不是硬编码）。本章要讲的就是：怎么往这套骨架上挂一种全新能力，而骨架本身一行都不用动。

## 2. 核心思想

把"我要伪装成 Chrome"这句**意图**塞进请求对象的一个**可选扩展字段**，再用**一条偏好函数**给"会伪装"的引擎疯狂加分，让路由器在排序时自然挑中它——意图与具体引擎彻底解耦，能真改 TLS 的引擎走真指纹，不能的至少能改 header，二者读的是同一份意图。

## 3. 心智模型

整条链路长这样（编号方便后面对应到代码）：

1. 调用方在请求的扩展槽里塞一个**伪装目标**——可以只说"Chrome"，其余维度留空（留空即通配任意）。
2. 路由器对每个已注册引擎跑**全部偏好函数求和**排序。"伪装偏好函数"给"既会伪装、本请求又要伪装"的引擎加 1000 分，把它顶到第一。
3. 路由器按排序逐个校验引擎：伪装能力基类检查"这个目标是否落在我支持的目标集合内"（靠**双向模糊匹配**），不支持就抛"不支持"异常，跳到下一个引擎。
4. 被选中的引擎把用户的模糊目标**具象化**为它实际支持的确切目标（如 `Chrome 146 / macOS`），并从扩展槽里**取走**该字段（声明已消费）。
5. 该引擎整理 header：移除所有"值等于程序默认 header"的条目，把 header 控制权让给底层库按目标浏览器生成全套匹配 header。
6. 引擎把确切目标透传给底层网络库，底层重放真实浏览器的 TLS/HTTP 指纹。
7. 把"实际用了哪个目标"**写回响应对象的扩展槽**，供上层和重试逻辑知晓。

四个关键位置：**意图**（请求扩展槽）→ **路由胜出**（偏好加分）→ **校验 + 具象化**（能力基类 + 叶子类）→ **真改指纹**（底层库）。

## 4. 关键权衡（本章重头戏）

### 能力走扩展槽、路由走偏好函数

伪装没有做成"某个引擎的专属参数"（比如 `curl_cffi_handler.impersonate=chrome`），而是编码成**请求对象的一个可选扩展字段**——`request.extensions['impersonate']`。任何引擎都看得见这个字段，但只有声明了"会伪装"的引擎才会响应它。

"会伪装"靠什么胜出？靠一条在模块加载时注册到路由器的**偏好函数**：装饰器 `@register_preference(ImpersonateRequestHandler)` 把它绑定到伪装能力基类上——它只对继承该基类的引擎生效（其它引擎返回 0），当本请求要走伪装时给 +1000 分。1000 这个数字大到足以压过其它所有偏好项，让会伪装的引擎在 `sorted(handlers, key=偏好求和, reverse=True)` 中稳稳排第一。

→ 换来：**意图与具体引擎彻底解耦**。能真改 TLS 的 curl_cffi 走真指纹；不能的 urllib/requests 至少能改 header；上层 CLI 和提取器只写一份意图，路由层负责择优。
→ 代价：请求对象多了一层"扩展协商"——每个引擎都要在 `_check_extensions` 里检查这个字段；还需要一步"把用户给的宽泛目标翻译成引擎实际支持的确切目标"的解析。

化解的**本质矛盾**：上层意图的**普遍性**（每个请求都可能要伪装）vs. 底层能力的**有限性**（只有少数库能真改 TLS）。把意图抽到中立扩展槽、把能力差异交给路由择优——这是"插件化能力"问题的通解骨架。

### 模糊目标 + 自报支持表，双向通配换宽容输入

伪装目标是一个四维值对象：`(client, version, os, os_version)`，每一维都可空，**缺省即通配**。匹配规则是**双向**的：判断 `A 匹配 B` 时，每一维"任一方为 None 即通过，否则必须相等"。

所以用户只给一个 `chrome`（其它三维全空），就能匹配到引擎声明支持的 `chrome-146:macos-14`；反过来引擎也可以声明"我支持 `chrome`（全空版本）"来兜底任意 Chrome 版本。

引擎支持哪些目标，靠**沿用了第 1 章的"自报能力表"模式**——类属性 `_SUPPORTED_IMPERSONATE_TARGET_MAP: dict[ImpersonateTarget, 原生对象]`，和 `_SUPPORTED_URL_SCHEMES` 是同一种手段。请求来了，引擎在自己的支持表 keys 里逐个问"用户的目标 in 这个支持目标吗"，命中第一个就拿来用。

→ 换来：上层只需给一个**模糊意图**（"Chrome"），各引擎的版本/平台差异被吸收，CLI 不必为每个引擎写专门的版本清单。
→ 代价：匹配语义是**隐式约定**——`target_a in target_b` 这个 Python 运算符被重载成"双向通配匹配"，理解成本不低；当多个引擎都支持 Chrome 时，靠"支持表是有序 dict、列表顺序即偏好"来决定谁胜，这条规则没有类型系统保障。

化解的**本质矛盾**：上层表达的**简洁性**（用户只想说"Chrome"）vs. 底层能力的**精确性**（引擎必须知道到底要重放哪个确切版本的指纹）。模糊匹配是"宽输入 + 精执行"问题的通解。

### 中间抽象类只校验、叶子类才消费

伪装能力分**两层抽象**：

- 上层 `ImpersonateRequestHandler`（通用基类）负责**校验**——它的 `_check_extensions` 检测到 `extensions['impersonate']` 时，调 `_check_impersonate_target` 看这个目标是不是落在我支持的目标集合内，不支持就抛 `UnsupportedRequest`；但**它不 pop 掉这个 key**。
- 真正声明"已消费"的是最底层的具体引擎（`CurlCFFIRH`）——它的 `_check_extensions` 才执行 `extensions.pop('impersonate', None)`。

→ 换来：可有多层抽象叠加（通用传输基类 → 伪装能力基类 → 具体引擎），每层各司其职。新引擎（比如未来某个用 rustls 改指纹的库）只继承最后两层即可获得伪装能力，不必重写校验。
→ 代价：这是一条**隐式契约**——"基类校验、叶子消费"。中间层若忘记遵守（比如某天有人写了个新的中间基类只校验不消费），会出现"基类声明支持某扩展、实际却没人取走"的悬空——扩展字段会沿着请求一路传到底层网络库，引发难以定位的 bug。

化解的**本质矛盾**：抽象层级的**可组合性**（希望多层基类各管一摊）vs. 副作用的**单一归属**（一个扩展字段最终必须被一个明确的层级"消费掉"，否则会泄漏）。校验与消费的分离是"层次化副作用管理"问题的通解。

### 主动让位默认 header，换指纹一致性

一旦确认本请求要走伪装，引擎会先做一件看似反直觉的事：**遍历请求 header，移除所有"值等于程序默认 header"的条目**。

为什么？因为"看起来像真浏览器"需要 TLS 层指纹 + 应用层 header **全套一致**。如果程序自造了一个默认 UA 字符串塞进去，底层库按 Chrome 146 生成的真实 header 就被覆盖了——指纹就露馅了。所以引擎主动让位，把 header 控制权完全交给底层库。

→ 换来：真正的浏览器指纹不会被程序自造的默认 header 破坏。
→ 代价：header 清理逻辑依赖一个**全局默认 header 表**（`std_headers`）作为隐式基准——源码里已明确标注为 TODO：不应依赖 `std_headers`。这是个技术债，未来重构时要换成显式的"让位规则"。

化解的**本质矛盾**：库的**默认行为**（自动塞默认 header）vs. 能力对环境的**完全接管**（伪装要求底层库独占 header）。主动清理是"默认值与显式意图冲突时如何让位"问题的通解——核心是：**当某个能力要独占某个通道，它必须先清理掉系统默认值**。

## 5. 最小原理演示

下面这段 TS 演示**只演透三件事**——双向通配匹配、引擎自报支持表、路由器持偏好函数加分使能力强的引擎胜出。不演示真实 TLS 指纹改写、不演示 cookie/代理/重试——那些是真实工程的事，演示只追求把原理演透。

```ts
// 伪装目标：四维 + 通配，任一字段 undefined 即"任意"
class ImpersonateTarget {
  constructor(
    readonly client?: string,
    readonly version?: string,
    readonly os?: string,
    readonly os_version?: string,
  ) {}

  // 双向通配匹配：每一维"任一方为空即通过，否则必须相等"
  // 用户给 {client:'chrome'} 能命中引擎支持的 {client:'chrome',version:'146',os:'macos'}
  contains(other: ImpersonateTarget): boolean {
    const dims: (keyof ImpersonateTarget)[] = ['client', 'version', 'os', 'os_version']
    return dims.every(d => {
      const a = this[d], b = other[d]
      return a === undefined || b === undefined || a === b
    })
  }
}

interface Request  { url: string; extensions: Record<string, unknown> }
interface Response { status: number; extensions: Record<string, unknown> }

// 引擎接口：自报支持表 + 校验 + 发送
interface Handler {
  name: string
  canImpersonate: boolean
  supportedTargets: ImpersonateTarget[]
  validate(req: Request): void
  send(req: Request): Response
}

// 普通引擎：不会改 TLS 指纹，只能改 header
class UrllibHandler implements Handler {
  name = 'urllib'
  canImpersonate = false
  supportedTargets = []
  validate() {}
  send(req: Request): Response {
    console.log(`  [urllib] 只改 header 发送 ${req.url}`)
    return { status: 200, extensions: {} }
  }
}

// 伪装能力基类：负责"校验"目标是否落在我支持集合内
abstract class ImpersonateHandler implements Handler {
  abstract name: string
  abstract supportedTargets: ImpersonateTarget[]
  get canImpersonate() { return true }

  // 把用户的模糊目标具象化成我支持表里第一个命中的确切目标
  protected resolve(target: ImpersonateTarget): ImpersonateTarget {
    const hit = this.supportedTargets.find(t => t.contains(target))
    if (!hit) throw new Error('unsupported')
    return hit
  }

  validate(req: Request): void {
    const target = req.extensions['impersonate'] as ImpersonateTarget | undefined
    if (target) this.resolve(target)   // 不命中就抛，会被路由捕获后跳到下一个引擎
  }

  // 叶子类才"消费"扩展槽：把 impersonate 取走、具象化后透传给底层
  protected consume(req: Request): ImpersonateTarget {
    const target = req.extensions['impersonate'] as ImpersonateTarget
    const resolved = this.resolve(target)
    delete req.extensions['impersonate']   // 声明已消费
    return resolved
  }

  abstract send(req: Request): Response
}

// 真叶子引擎：curl_cffi 替身——能真改 TLS 指纹
class CurlCffiHandler extends ImpersonateHandler {
  name = 'curl_cffi'
  supportedTargets = [
    new ImpersonateTarget('chrome', '146', 'macos', '14'),
    new ImpersonateTarget('chrome', '132', 'windows', '11'),
    new ImpersonateTarget('safari', '18', 'macos', '15'),
  ]

  send(req: Request): Response {
    const resolved = this.consume(req)
    // 真改 TLS 是 curl_cffi/BoringSSL 的事，演示里只占位
    console.log(`  [curl_cffi] TLS 指纹 ← ${resolved.client}-${resolved.version} on ${resolved.os}`)
    return { status: 200, extensions: { impersonate: resolved } }   // 写回响应
  }
}

// 路由器：偏好函数求和 → 排序 → 逐个校验 → 第一个通过者胜出
type PrefFn = (h: Handler, req: Request) => number
class Director {
  private prefs: PrefFn[] = []
  constructor(readonly handlers: Handler[]) {}
  registerPreference(fn: PrefFn) { this.prefs.push(fn) }

  route(req: Request): Response {
    const scored = this.handlers
      .map(h => ({ h, score: this.prefs.reduce((s, f) => s + f(h, req), 0) }))
      .sort((a, b) => b.score - a.score)

    for (const { h } of scored) {
      try {
        h.validate(req)
        console.log(`路由选中: ${h.name}`)
        return h.send(req)
      } catch { /* 不支持就跳到下一个引擎 */ }
    }
    throw new Error('no handler')
  }
}

// 本章对路由骨架注入的唯一一条新偏好函数：
// 只对会伪装的引擎生效；本请求要走伪装时 +1000，否则 0
function impersonatePreference(h: Handler, req: Request): number {
  if (!h.canImpersonate) return 0
  return req.extensions['impersonate'] ? 1000 : 0
}

// —— 跑一遍 ——
const director = new Director([new UrllibHandler(), new CurlCffiHandler()])
director.registerPreference(impersonatePreference)

const req: Request = {
  url: 'https://protected-site.example/api',
  extensions: { impersonate: new ImpersonateTarget('chrome') },   // 用户只说"chrome"
}
director.route(req)
```

输出：

```
路由选中: curl_cffi
  [curl_cffi] TLS 指纹 ← chrome-146 on macos
```

`urllib` 引擎虽然在 handler 列表里，但因为 `canImpersonate=false`，偏好函数给它 0 分；`curl_cffi` 拿到 +1000 直接胜出，校验时把自己支持表里第一个含 `chrome` 的目标找出来（具象化为 `chrome-146:macos-14`），把扩展槽里的字段消费掉，再把真实指纹交给底层库重放——这就是"意图经偏好路由落到能力最强者"的全过程。

## 6. 执行轨迹

把"§5 跑一遍"那一段拆开看时序：

**输入**：请求 `url='https://protected-site.example/api'`，扩展槽 `impersonate = ImpersonateTarget(client='chrome')`（其余三维空）。系统里挂着两个引擎——urllib（普通，0 分）、curl_cffi（指纹引擎，待评分）。

1. **路由排序**：对每个引擎跑 `impersonatePreference` 求和：
   - urllib：`canImpersonate=false` → 0 分
   - curl_cffi：`canImpersonate=true` 且本请求有 `impersonate` 扩展 → +1000 分
   - 排序后：`[(curl_cffi, 1000), (urllib, 0)]`
2. **校验第一个**：curl_cffi 继承 `ImpersonateHandler.validate`，调 `resolve(chrome)`——在支持表里逐项 `contains` 匹配，命中 `chrome-146:macos-14`，校验通过。
3. **发送（消费扩展）**：curl_cffi.`send` 调 `consume`，把模糊的 `chrome` 具象化为 `chrome-146:macos-14`，并 `delete req.extensions['impersonate']`（声明已消费）。
4. **让位 header**：遍历请求 header，移除所有"值等于程序默认 header"的条目（演示里省略），把控制权让给底层库。
5. **透传底层**：把 `chrome-146:macos-14` 经 `_SUPPORTED_IMPERSONATE_TARGET_MAP` 映射成 curl_cffi 的原生 `BrowserType`，调 `session.request(impersonate=...)`——curl_cffi 底层用 BoringSSL 重放 Chrome 146 的真实 ClientHello/JA3 与 HTTP/2 帧序。
6. **写回响应**：`response.extensions['impersonate'] = chrome-146:macos-14`，让上层和重试逻辑知晓"实际用了哪个指纹发的"。

**输出**：HTTP 200 响应，扩展槽里回写了确切目标。整个过程上层只写了一句 `impersonate=chrome`，意图经偏好路由自动落到了唯一能真改 TLS 的引擎上。

## 7. 教学简化说明

本章演示故意省略了：

- **真实 TLS 指纹改写**：那是 curl_cffi 底层 BoringSSL 的事，演示只用 `console.log` 占位。
- **目标字符串解析正则**：CLI 的 `--impersonate chrome:windows-10` 这种字符串怎么解析成四维对象。
- **curl_cffi 版本兼容映射表**：不同 curl_cffi 版本支持的浏览器目标略有差异，多键排序键极其复杂（不可靠目标降权、移动端降权、tor<edge<firefox<safari<chrome 的引擎优先级、取最新版）。
- **`keep_header_casing` 等 secondary 扩展**：那些和伪装是平级的其它扩展槽字段。
- **编排器层接入**：`YoutubeDL._impersonate_target_available` 怎么遍历 handler 问"你支持吗"、`_parse_impersonate_targets` 怎么把 CLI 的布尔/字符串/列表统一解析——这些属于后续「YoutubeDL 编排器」的范围。
- **HTTP 错误处理、重试、cookie、代理**：与本章主线无关。

## 8. 小结

伪装这一种能力之所以能挂上去，靠的不是改路由骨架，而是路由骨架本来就预留了两条缝——**请求对象的中立扩展槽**让意图有地方放，**偏好函数注册**让能力差异自动胜出。第 1 章把"能力探测 + 偏好路由"那条骨架设计得足够中立，本章只需往里塞一个新字段、注册一条新偏好，整套伪装机制就长出来了——这是好抽象的标志：**它对未来的能力是开放的，不需要回头改自己**。

下一章会离开传输层，进入提取器——看那个贯穿全系统的胖字典 `info_dict` 是怎么作为数据总线把提取器、下载器、后处理器串起来的。
