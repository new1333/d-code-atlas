# 浏览器指纹伪装：作为扩展叠加的传输能力

## 改了 User-Agent，为什么还是被识破

你大概遇到过这种事：写了个脚本去抓某个站点，明明把 `User-Agent` 改成了 Chrome，结果人家照样给你弹验证码、甚至封 IP。你以为伪装好了，其实只换了个名牌。

问题在于：站点识别"你是不是真浏览器"，靠的远不止 User-Agent 这一行字。它在 TLS 握手的那一刻（ClientHello 里的密码套件顺序、扩展排列，俗称 JA3 指纹）、在 HTTP/2 帧的发送顺序里、在默认 header 的细微差别里，早就看出"这握手的姿势不对，不是真 Chrome，是脚本"。光改个 header 字符串，指纹对不上，等于穿着西装却配了双人字拖。

这就引出一个诉求：用户只想说一句"假装成 Chrome"，却完全不想关心底层到底用的是哪个网络库、那个库能不能真的改 TLS 指纹。本章讲的就是——怎么把"我要伪装"这句**意图**，变成系统里任何传输引擎都能读懂的东西，并让"能力最强的那一个"自动接管。

## 先认识"伪装目标"：一张留空就代表"都行"的四维规格

要描述"假装成谁"，至少得说清四件事：浏览器（client）、它的版本（version）、跑在什么系统上（os）、系统版本（os_version）。比如"Chrome 146 / macOS"。这四个维度组合起来，就是一个**伪装目标**。

它有个关键设计：**任何一个维度留空，就代表"这一维随便，都行"**。好比填一张表，名字写了 Chrome，版本那栏空着，意思就是"Chrome 的任意版本我都能接受"。这么一来，用户只填一个 `chrome`，系统就知道这是个宽泛要求。

宽泛要求怎么跟引擎实际支持的精确版本对上？靠一条"双向通配"的匹配规则——比较两个目标时，**每一维只要有一方留空就算通过，否则必须相等**：

```
用户的  chrome            引擎的 chrome-146 / macos   → 通过（用户那三维都空，全放行）
用户的  chrome-146        引擎的 chrome               → 也通过（这次轮到引擎那三维空）
用户的  chrome-146        引擎的 safari-18            → 不通过（client 对不上）
```

注意上下两个方向都成立——"宽泛的包含精确的"和"精确的落在宽泛里"是一回事。这就是为什么上层只丢一个 `chrome`，引擎就能在自己的支持清单里找出一个匹配的确切版本。这条匹配规则是后面一切的基础。

顺带一条小约束：你不能只写版本不写浏览器名（"版本 146"是给谁的版本？），所以目标在校验时会要求"设了 version 就必须有 client，设了 os_version 就必须有 os"，防止出现无意义的规格。

## 把意图塞进中立扩展槽（这块积木来自第 1 章）

意图有了，放哪？第 1 章已经搭好了一套骨架，本章**一行都不改它**，只复用其中一块积木：

> 请求对象身上挂着一个**对所有引擎一视同仁的可选扩展槽**（`request.extensions`）。谁想往里塞什么能力都行，不认识这个能力的引擎可以无视它。

第 1 章那套"多引擎竞争 + 路由器按偏好打分择优 + 不符者跳过"的骨架已经讲透，这里不重复。本章只做两件事：往这个扩展槽里**定义一种新的语义**（名叫 `impersonate`，值就是一个上面那种伪装目标），再往路由器里**注册一条新的偏好函数**。说人话就是——骨架不动，只挂一种新能力上去。

## 引擎自报"我能伪装成哪些"，模糊意图被具象化

光有意图不够，还得有引擎站出来认领。认领的方式沿用第 1 章"自报能力表"的同款做法：每个会伪装的引擎，把"我能伪装成哪些目标"列成一张**有序清单**。清单里每一项是一个精确目标（如 `chrome-146 / macos`），顺带挂一个底层原生对象（curl_cffi 里就是它的 `BrowserType` 枚举值）。

当请求带着一个模糊目标过来时，引擎就在自己的清单里挨个比对，**返回第一个能匹配上的精确目标**——这一步叫"具象化"。它把用户嘴里的"Chrome"，翻译成了"我能真正执行的那个 Chrome 146 / macOS"。注意返回的是**引擎清单里的那项**（带着原生映射值），不是用户的输入，因为真正要喂给底层库的是前者。

这张清单是**有序的**，匹配时取第一个命中的——这个"顺序"后面会成为一个隐含的偏好规则。

这里有个精巧的分工：会伪装的引擎其实分两层抽象。**中间那层**（伪装能力基类）只负责"校验这个目标我支不支持"——不支持就抛异常让路由器跳到下一个引擎；但它**不把扩展从请求里拿走**。真正把扩展拿走（声明"这个我消费了"）的，是**最底层的具体引擎**。校验和消费被故意拆到了两层。为什么要这么拆，后面权衡里讲。

## 一条偏好函数，让"会伪装的"自动跑到第一

现在最关键的一步：系统里同时挂着好几个引擎——有能真改 TLS 指纹的（curl_cffi），也有只能普通发请求的（urllib、requests）。一个"我要伪装"的请求过来，怎么保证它**自然地**落到能伪装的那个引擎头上，而不是落到啥也伪装不了的 urllib？

答案不是硬编码"伪装请求一律走 curl_cffi"，而是**复用第 1 章的偏好排序**，只往里注入一条偏好函数。这条函数的逻辑极其简单：

```
如果 这个引擎是"会伪装的引擎"（用类型限定，普通引擎直接返回 0）
并且 (本请求带了伪装扩展) 或 (这个引擎构造时就设了默认伪装目标) —— 两者任一非空
那么 给它加 1000 分
否则 0 分
```

1000 分是个压倒性的大数，足以让会伪装的引擎在路由器的降序排序里稳稳排到第一，把普通引擎甩在后面。这条偏好函数是本章对第 1 章路由骨架做的**唯一注入**——骨架本身的"偏好求和、按分排序"逻辑一个字没动。

这里有个容易漏看的细节（对应上面那条"或"）：**不一定要请求显式带着伪装扩展**才会加分。如果一个引擎在构造时就自带了一个默认伪装目标（哪怕这个请求本身没说要伪装），它同样拿 1000 分、同样排到第一，然后用自己的默认目标去发。换句话说，"要不要伪装"既可以由单个请求临时喊出来，也可以由引擎默认值兜底，两条路都通向同一个加分逻辑。

## 原理演示：三种命运的请求

下面这段 TypeScript 把上面三件事——四维目标的双向通配、偏好路由的加分择优、模糊目标的具象化——从零演一遍（约 80 行，存成 `impersonate.ts`，用 `bun run impersonate.ts` 即可跑）。真实的 TLS 指纹改写是 curl_cffi 底层 BoringSSL 的事，演示里用一行 `console.log` 占位，只演"意图如何经偏好路由落到能力最强者"。

```ts
// impersonate.ts — 演示「能力走扩展 + 偏好路由 + 模糊目标具象化」

// 1. 伪装目标：四维，留空 = 通配；双向匹配
class ImpersonateTarget {
  constructor(
    readonly client: string | null = null, readonly version: string | null = null,
    readonly os: string | null = null, readonly osVersion: string | null = null,
  ) {}
  contains(o: ImpersonateTarget): boolean {
    const ok = (a: string | null, b: string | null) => a === null || b === null || a === b
    return ok(this.client, o.client) && ok(this.version, o.version)
        && ok(this.os, o.os) && ok(this.osVersion, o.osVersion)
  }
  toString() {
    const left = [this.client, this.version].filter(Boolean).join('-')
    const right = [this.os, this.osVersion].filter(Boolean).join('-')
    return right ? `${left}:${right}` : left
  }
}

// 2. 请求：意图放进中立扩展槽
interface Extensions { impersonate?: ImpersonateTarget }
class Request { constructor(readonly url: string, readonly extensions: Extensions = {}) {} }
class Response { constructor(readonly url: string, readonly extensions: Extensions = {}) {} }
class Unsupported extends Error {}

// 3. 引擎基类：校验时拒绝「没被消费掉」的扩展
abstract class Handler {
  abstract name: string
  canImpersonate = false
  defaultImpersonate: ImpersonateTarget | null = null
  supportedTargets(): ImpersonateTarget[] { return [] }
  checkExtensions(ext: Extensions): Extensions { return { ...ext } }     // 默认一个都不消费
  validate(req: Request) {
    const leftover = this.checkExtensions({ ...req.extensions })
    if (Object.keys(leftover).length)
      throw new Unsupported(`${this.name}: 未消费的扩展 ${Object.keys(leftover)}`)
  }
  abstract send(req: Request): Response
}

// 4. 伪装能力中间基类：只校验，不消费（消费留给叶子）
abstract class ImpersonateHandler extends Handler {
  canImpersonate = true
  resolveTarget(t?: ImpersonateTarget | null): ImpersonateTarget | null {
    if (!t) return null
    for (const s of this.supportedTargets()) if (s.contains(t)) return s   // 表有序，首个命中即偏好
    return null
  }
  checkExtensions(ext: Extensions): Extensions {
    const leftover = { ...ext }
    if (leftover.impersonate && this.resolveTarget(leftover.impersonate) == null)
      throw new Unsupported(`${this.name}: 不支持的目标 ${leftover.impersonate}`)
    return leftover        // 只校验，没有 delete —— 关键
  }
}

// 5. 叶子 A：curl_cffi，真改 TLS 指纹
class CurlCffiHandler extends ImpersonateHandler {
  name = 'curl_cffi'
  defaultImpersonate = new ImpersonateTarget('chrome', '146', 'macos')     // 构造时即默认伪装
  supportedTargets() {
    return [
      new ImpersonateTarget('chrome', '146', 'macos'),
      new ImpersonateTarget('safari', '18', 'macos'),
    ]
  }
  checkExtensions(ext: Extensions): Extensions {
    const leftover = super.checkExtensions(ext)   // 先让中间基类校验
    delete leftover.impersonate                    // 叶子才真正消费（pop）
    return leftover
  }
  send(req: Request) {
    const t = this.resolveTarget(req.extensions.impersonate ?? this.defaultImpersonate)!
    console.log(`  [curl_cffi] TLS 指纹 ← ${t}`)
    return new Response(req.url, { impersonate: t })   // 把实际用的目标写回响应
  }
}

// 6. 叶子 B：urllib，普通引擎，根本不认识伪装扩展
class UrllibHandler extends Handler {
  name = 'urllib'
  checkExtensions(ext: Extensions): Extensions {
    const leftover = { ...ext }
    delete leftover.cookiejar; delete leftover.timeout   // 它只认这两个
    return leftover        // impersonate 留着 → 基类 validate 判「未消费」而拒绝
  }
  send(req: Request) { console.log('  [urllib] 普通发送（无伪装）'); return new Response(req.url) }
}

// 7. 路由器：偏好求和排序择优（骨架来自第 1 章）
type Pref = (h: Handler, req: Request) => number
class Director {
  handlers: Handler[] = []
  prefs: Pref[] = []
  add(h: Handler) { this.handlers.push(h) }
  // 本章对骨架的唯一注入：一条伪装偏好
  static impersonatePref: Pref = (h, req) =>
    !h.canImpersonate ? 0                                              // 只对伪装引擎生效（等价 isinstance 限定）
      : (req.extensions.impersonate || h.defaultImpersonate) ? 1000    // 请求带扩展 或 引擎默认 —— 任一非空
      : 0
  send(req: Request): Response {
    const score = (h: Handler) => this.prefs.reduce((s, p) => s + p(h, req), 0)
    const order = [...this.handlers].sort((a, b) => score(b) - score(a))
    const errors: string[] = []
    for (const h of order) {
      try { h.validate(req) } catch (e) { errors.push((e as Error).message); continue }
      return h.send(req)
    }
    throw new Error(`NoSupportingHandlers: ${errors.join(' | ')}`)
  }
}

// 跑三个用例
const d = new Director(); d.prefs.push(Director.impersonatePref)
d.add(new CurlCffiHandler()); d.add(new UrllibHandler())

console.log('用例1：请求带模糊目标 chrome')
d.send(new Request('https://site', { impersonate: new ImpersonateTarget('chrome') }))

console.log('用例2：请求带谁都不支持的目标 ie')
try { d.send(new Request('https://site', { impersonate: new ImpersonateTarget('ie') })) }
catch (e) { console.log('  ' + (e as Error).message) }

console.log('用例3：请求不带扩展，靠引擎默认伪装目标')
d.send(new Request('https://site'))
```

跑出来的轨迹：

```
用例1：请求带模糊目标 chrome
  [curl_cffi] TLS 指纹 ← chrome-146:macos
用例2：请求带谁都不支持的目标 ie
  NoSupportingHandlers: curl_cffi: 不支持的目标 ie | urllib: 未消费的扩展 impersonate
用例3：请求不带扩展，靠引擎默认伪装目标
  [curl_cffi] TLS 指纹 ← chrome-146:macos
```

三个用例正好覆盖三条命运：**用例 1** 是主路径——curl_cffi 拿 1000 分排第一，校验通过，把模糊的 chrome 具象化成 chrome-146/macOS 再发；**用例 3** 演示那条"或"分支——请求啥都没带，但 curl_cffi 构造时设了默认目标，照样拿 1000 分、照样走它，用默认目标发；**用例 2** 最值得细看，下一节专门讲它。

## 真正改指纹的那一下，与一个容易误解的"降级"

在叶子引擎 `send` 里，具象化后的精确目标会被映射成底层库认识的 native 对象，透传给 `curl_cffi`，底层用 BoringSSL 把真实浏览器的 TLS ClientHello / JA3 和 HTTP/2 帧指纹**原样重放**出去。这才是"真改 TLS"的落点——它只发生在有能力改 TLS 的具体引擎内部，上层完全看不到。

发出去之前还有一步:一旦确定本请求要走伪装，引擎会先把"值等于程序默认 header"的那些条目移除，把 header 的控制权**让给底层库**，让它按目标浏览器生成一整套匹配的 header。因为真正的浏览器指纹要求 TLS 层和应用层 header 必须一致才像，要是程序自造的默认 header 还杵在那儿，反而会露馅。发完之后，"实际用了哪个目标"会被写回响应对象的扩展槽，方便上层和重试逻辑知道这次到底用了什么指纹。

现在回到用例 2——那个谁都不支持的 `ie` 目标。这里有个**特别容易讲错的点**：它并不会"悄悄降级成 urllib 的无伪装发送"。

为什么？因为伪装扩展是一个**硬契约**。引擎要么声明消费它（像 curl_cffi 那样把它 pop 走），要么就得拒绝整个请求。具体到这条链路：

```
curl_cffi：校验时发现 ie 不在自己支持的目标里 → 抛「不支持」→ 路由器跳过
urllib   ：根本不认识 impersonate 扩展，不会 pop 它 → 扩展槽里有残留 → 抛「未消费的扩展」→ 路由器跳过
所有引擎都跳过 → 路由器抛 NoSupportingHandlers → 请求失败
```

所以第 1 章那套机制所谓的"优雅"，**仅仅是指路由器会逐个尝试、不被单个引擎的拒绝卡死**；它**并不意味着**"没人能伪装时就偷偷退化成普通请求"。对伪装这种硬扩展而言，一旦没有任何引擎能消费它，请求就是直接失败——这反而是一种诚实：与其发一个指纹对不上的请求被站点识破，不如一开始就告诉用户"你要的目标我伪装不了"。演示里普通引擎（`UrllibHandler.checkExtensions`）遇到带 `impersonate` 扩展的请求时，会因为这个扩展没被消费而判不支持并跳过，正是为了忠实反映这条契约。

## 关键权衡

本章机制集中，集中在"怎么把一种新能力干净地挂到已有骨架上"，因此展开这 4 条核心权衡。

**权衡 1：能力走扩展，路由走偏好（核心权衡）**
- **选择**：把"要伪装"编码成请求的一个可选扩展字段（而不是某个引擎的专属参数），再用一条偏好函数给"会伪装的引擎"加 1000 分。
- **换来**：意图和具体引擎彻底解耦。同一个"假装 Chrome"的意图，能真改 TLS 的引擎（curl_cffi）走真指纹；将来若出现只能改 header 的伪装引擎，它读的也是这同一份意图——上层完全不用为每个引擎写一套分支。
- **代价**：请求对象多了一层扩展协商；而且这 1000 分是个压倒性的"硬加分"，等于在通用排序里塞了一个隐性的"伪装优先"特权，新人若不知道这个魔法数字，会想不通为什么伪装引擎总能赢。更进一步的代价正是上一节那个反直觉点：伪装是硬契约，无人能消费就整体失败，**不会**降级成无伪装发送——"优雅降级"在这儿不成立。

**权衡 2：模糊目标 + 有序自报支持表，换来宽容的输入**
- **选择**：目标"缺省即通配"+ 双向模糊匹配；引擎把支持的目标列成一张**有序**表，具象化时取首个命中。
- **换来**：上层只需说"我要 Chrome"，引擎自己在表里找出一个匹配的确切版本（如 Chrome 146/macOS）。CLI 和提取器完全不用关心各引擎的版本/平台差异。
- **代价**：匹配语义是隐式约定（那个双向 `contains`），新人要花点功夫才看懂；更要命的是"多个引擎都支持 Chrome 时谁胜"这件事，靠的是**支持表的排列顺序**——这是一条藏在数据顺序里的偏好规则，从代码表层很难一眼看出来。

**权衡 3：中间抽象类只校验，叶子类才消费**
- **选择**：把伪装能力拆成两层抽象。中间那层负责"校验目标支不支持"（不支持就抛异常），但不把扩展取走；真正取走（声明消费）的是最底层的具体引擎。
- **换来**：可以多层抽象叠加（通用基类 → 伪装能力基类 → 具体引擎），每层各司其职；新引擎只要继承最后两层，就自动获得伪装能力，不用重写校验。
- **代价**：这是一条**隐式契约**——"中间层只校验、不消费"。中间层若忘记这条去 pop 了，或叶子层忘记 pop，就会出现"基类声明支持这个扩展、实际却没人消费"的悬空状态；这时请求会带着残留扩展被基类的检查判为不支持，错误现象还很迷惑。

**权衡 4：主动让位默认 header，换指纹一致**
- **选择**：确定要走伪装后，先把"值等于程序默认 header"的条目移除，把 header 控制权让给底层库按目标浏览器生成全套匹配 header。
- **换来**：真正的浏览器指纹（TLS 层 + 应用层 header 必须一致才像）不会被程序自造的默认 header 破坏，避免"TLS 像 Chrome、header 却露了程序的马脚"这种穿帮。
- **代价**：这套清理逻辑依赖一张**全局默认 header 表**作为隐式基准——哪天这张表的内容变了，这里的"相等就删"判断可能悄悄失效（源码里已把这处依赖标成待清理的技术债）。

## 小结

浏览器伪装这件事，难点不在"怎么改 TLS"（那是 curl_cffi / BoringSSL 的活），而在怎么把"我要伪装"这句**意图**，干净地接进一个已经有了多引擎竞争骨架的系统里。本章给出的答案是：复用第 1 章的中立扩展槽放意图，复用偏好排序让"会伪装的引擎"自动胜出，再用四维通配目标 + 有序支持表吸收各引擎的版本差异——骨架不动，只挂一种新能力。代价是扩展协商、隐式的匹配与排序规则、以及"伪装是硬契约、无人消费即失败"这条不那么直觉的行为。

至于一个请求从被提取器发起到拿到响应，中间还要经过哪些环节——下一章会拉开视野，看那个贯穿全系统的 `info_dict` 数据总线是怎么把"解析一个站点"压缩成几十行的。