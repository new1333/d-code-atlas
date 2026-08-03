# package.json 字段规范化：把三十年的「人肉写法」收成一份稳定结构

## 想象你是前端，要给每个 npm 包渲染一个头像

你拿到一个 `package.json`，想把作者头像、仓库链接、许可证徽章、赞助按钮画出来。看上去很简单的四件事——直到你打开真实的 npm 数据：

- 作者字段 `author` 有时是个字符串 `"Foo Bar"`，有时是个对象 `{ name, email, url }`，有时甚至是个复合字符串 `"Foo Bar <foo@bar.com> (https://github.com/foo)"`；
- 仓库字段 `repository` 有时是 `foo/bar` 这种裸简写，有时是 `git+ssh://git@github.com/foo/bar.git` 这种带一堆协议噪声的 URL；
- 许可证字段大部分时候是个字符串 `"MIT"`，但有些老包写的是 `licenses: [{ type: "MIT" }, { type: "Apache-2.0" }]` 这种数组；
- 赞助字段 `funding` 既可以是字符串、对象，也可以是数组。

「这个包是谁写的」这一个 UI 元素，背后面对的是 npm 三十年来在不同规范下被允许过的 N 种合法写法。前端要是每种都自己 `if` 一下，会写成噩梦。所以中间必须有一道**翻译关口**：把五花八门的输入压成稳定的几种输出形态，下游只认这几种。

本章讲的就是这道关口怎么设计。

## 一句话核心：多形态 → 中间元组 → 单一展示形态

整个归一化只做三件事，按顺序发生：

1. **形态分流**：用 `typeof` 和 `Array.isArray` 把字段切成 `string / object / array` 三条管道。第一眼看上去每种字段长得完全不一样，但归根到底就是这三种容器形状。
2. **抽中间元组**：从每条管道里抽出最朴素的事实，比如「这个作者叫什么名、邮箱是啥、主页是啥」。这时候**还不知道**他是不是 GitHub 用户——只是把原始信息切干净。
3. **升级 + 优先级裁决**：再把「平台身份」叠上去。一个 GitHub handle 可以直接换头像，是高维身份；纯文本名字只能渲染个字符串，是低维身份。最后按固定优先级裁决，吐出统一的窄类型给前端。

说人话就是：**先切菜，再调味，最后按菜谱装盘**。切菜和调味分开做，是为了让切菜那一步能复用——你换一种调味法，切菜逻辑不用改。

## 一个最小演示：30 行看透三阶段

下面这个迷你 normalizer 把上面的三阶段演透。重点不是「能跑」，是让读者一眼看到 raw input → tuple → final shape 这条转换链。

```ts
// ---- 阶段 1+2：复合字符串 → 中间元组（不掺平台语义）----
type Raw = { name?: string; email?: string; url?: string }

function parseAuthorStr(s: string): Raw {
  let rest = s
  let email: string | undefined
  let url: string | undefined
  // 顺序敏感：先抠 <email>，再抠 (url)，剩下的当 name
  // 为什么这个顺序？因为 email 不会含 ()，但 url 可能含 <>() 之外的各种字符
  const em = rest.match(/<([^>]+)>/)
  if (em) { email = em[1]!.trim(); rest = rest.replace(em[0], '') }
  const um = rest.match(/\(([^)]+)\)/)
  if (um) { url = um[1]!.trim(); rest = rest.replace(um[0], '') }
  return { name: rest.trim() || undefined, email, url }
}

// ---- 阶段 3a：升级——把 url/email 升级成 GitHub handle ----
const RE_GH_USER = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/?$/i
function toHandle(raw: Raw): string | undefined {
  if (raw.url) {
    const m = raw.url.match(RE_GH_USER)
    if (m) return m[1]
  }
  return undefined
}

// ---- 阶段 3b：裁决——优先级合并出单一展示形态 ----
type Final = { type: 'github'; github: string } | { type: 'text'; name?: string }

function normalizeAuthor(input: string | Raw | (string | Raw)[]): Final[] {
  const list = Array.isArray(input) ? input : [input]
  const tuples = list.map(x => typeof x === 'string' ? parseAuthorStr(x) : x)

  const githubs = tuples.map(toHandle).filter(Boolean) as string[]
  if (githubs.length) {
    // 权衡 1：只要能拿到 GitHub handle，纯文本作者整体丢弃
    console.error(`[drop] 文本作者 "${tuples.map(t => t.name).join(', ')}" 被丢弃，因为找到了 handle: ${githubs.join(', ')}`)
    return githubs.map(h => ({ type: 'github', github: h }))
  }
  return tuples.map(t => ({ type: 'text', name: t.name }))
}

// 跑一遍
normalizeAuthor("Foo Bar <foo@bar.com> (https://github.com/foo)")
// stderr: [drop] 文本作者 "Foo Bar" 被丢弃，因为找到了 handle: foo
// => [{ type: 'github', github: 'foo' }]
```

跑完这条用例，你立刻能看到「权衡 1」是怎么发生的：那条 stderr 日志就是丢弃现场。

## 权衡 1：GitHub handle 一票否决纯文本作者（核心权衡）

这是本章最重要的一个决定，原文代码里写得很直白：

> 如果任意一个作者条目能解析出 GitHub handle，就**只**返回 GitHub 条目，纯文本条目整体丢弃。

**做了什么选择**：作者条目里只要有一个能拿到 GitHub handle，其它纯文本条目（哪怕里面写了真实的姓名）全部丢掉。

**换来了什么**：前端头像永远可点、永远有图、永远是同一种结构。前端代码可以从「if 有头像 / else if 有名字 / else 啥也没有」简化成「直接渲染 `{type:'github'}`」，UI 一致性是质变级别的提升。

**代价**：冷门包（学术界、老 Cocos2D、个人随手发的包）的作者如果只填了纯文本名字、没填 GitHub 链接，他们的名字会被**静默丢掉**，前端再也看不到。代码里用 `inferred: true` 这种诚实标志兜底，区分「真作者」和「猜的作者」，但纯文本丢就是真丢了——没有任何标记。

**为什么是合理的**：从产品视角，展示一致性 > 信息保真。一个 UI 上「这个包是谁写的」如果一半有头像一半没头像，看起来就像坏掉了；而丢掉纯文本名字只影响那一小撮老包作者，且这些包通常也没人看。代码作者选择了「让 95% 的包看起来对」，而不是「让 100% 的包看起来参差」。

## 权衡 2：宁可推断也不留空（bugs.url 兜底仓库 + org 兜底作者）

**做了什么选择**：当 `repository` 字段缺失时，从 `bugs.url`（如果是 `https://github.com/` 开头）砍掉 `/issues` 后缀当作仓库链接；当所有作者都是纯文本（甚至连纯文本都没有）但能从 repository 字段切出 org 时，把 org 当作 inferred 作者返回。

**换来了什么**：覆盖率最大化。很多老包只填了 `bugs` 没填 `repository`，按字面意思应该没仓库链接，但归一化层推断出来一个能点的链接——用户能跳到 GitHub 看 issue。

**代价**：假设了「issues 入口 == 仓库入口」，绝大多数包成立，但极少数包（用 issue tracker 服务但代码托管在别处）会推断错。同时，inferred 的作者只是「猜的」，前端如果想区分「真作者」和「从 org 反推的作者」必须读 `inferred: true` 这个标志。

**这个设计的诚实之处**：所有推断结果都用 `inferred: true` 显式标记，不假装是真的。换句话说，归一化层不撒谎——它说「我推断的，你看着办」。

## 权衡 3：license 合并成 SPDX 字符串，funding 全部保留

同一个章里出现了两种相反的处理方式，这不是不一致，是两种字段的语义不同。

**license 的处理**：老式 `licenses: [{ type: "A" }, { type: "B" }]` 数组（npm 早期 legacy 字段）被合并成 `(A OR B)` 字符串，跟现代的单 `license: "MIT"` 走同一条 string 契约。

**为什么合并**：许可证在语义上是「这个包的法律状态」，一个包**只能有一个法律状态**（哪怕它是「A 或 B 任选其一」）。所以合并成一个 SPDX 表达式是符合语义的。

**代价**：下游拿到的字符串必须当 opaque 处理，不能假设它一定是单个 SPDX 标识符——可能是 `"MIT"`，也可能是 `"(MIT OR Apache-2.0)"`。前端展示徽章时不能拿它去查颜色映射表（如果查表只能查到第一个 token）。

**funding 的处理完全相反**：`funding` 字段如果是数组，所有条目都被保留并各自解析，不合并。

**为什么不合并**：funding 在语义上是「赞助渠道」，一个包**可以同时有多个并列渠道**（GitHub Sponsors + OpenCollective + Patreon），合并反而会丢信息。

**说人话**：合不合并取决于「这字段在语义上是不是单值」。license 是单值（一个法律状态），所以合并；funding 是多值（多个渠道），所以全保留。这种「按字段语义决定合并策略」的设计很值得抄——别为了「统一」就一刀切。

## 权衡 4：协议噪声容差靠一连串 replace

repository URL 经过的清洗是这样的（顺序敏感）：

```
github:foo/bar          → foo/bar              (去 github: 前缀)
git@github.com:foo/bar  → foo/bar              (去 ssh user@host: 前缀)
foo/bar                 → https://github.com/foo/bar  (bare 简写识别)
git+https://...         → https://...          (去 git+ 前缀)
https://....git         → https://...          (去 .git 后缀)
git://...               → https://...          (git 协议换 https)
ssh://...               → https://...          (ssh 协议换 https)
```

**做了什么选择**：用一连串顺序敏感的 `replace` 清洗协议噪声，而不是写一个超级正则一次性匹掉所有情况。

**换来了什么**：每条规则独立可读、可加注释，规则之间不互相干扰。最终输出的就是一个能直接喂给 `<a href>` 的干净 `https://` 链接。

**代价**：正则链是顺序敏感的——先去前缀再去后缀。如果你将来要支持一种新的协议写法（比如某种 ssh 变体），必须**再插一条 replace**，不能光靠现有规则覆盖。新插的位置也要小心：插错位置可能跟已有规则打架。

**为什么这么选**：单一强大正则的可读性是噩梦（你试试写一个能同时匹 `git+ssh://git@github.com:foo/bar.git` 的正则），而且很难加注释解释每段在干嘛。replace 链虽然啰嗦，但每行都能用一句中文解释，调试时也能逐条注释掉看哪步出问题。

## 心智模型回顾：5 步走完整套归一化

把上面四个权衡串起来，整个归一化的执行轨迹是这样的：

```
[1] 形态分流          typeof + Array.isArray → 三条管道
       ↓
[2] 字符串拆解        复合串 "Name <email> (url)" → 抽出三段
                    （顺序：先 email 再 url，避免误吞）
       ↓
[3] 平台身份升级      url/email 用正则升级成 GitHub handle
                    （高维身份，能直接换头像）
       ↓
[4] 优先级裁决        作者：GitHub > 文本 > 仓库 org 推断
                    许可证：合并成 SPDX 单字符串
                    赞助：全保留，不合并
                    仓库：用 bugs.url 兜底
       ↓
[5] 结构化输出        吐出统一的 Parsed* 窄类型
                    （前端只认这些类型，不认原始 json）
```

输入是一个混乱的 `package.json`，输出是一份「字段确定、类型确定、可渲染」的结构。整套机制说白了就为了一个目标：**让下游永远不用 `if (typeof ...)`**。

## 这层为什么必须独立成一章

很容易有人会问：这四个字段不就是几个 if 吗，为什么不写在渲染组件里就好？

因为这种归一化逻辑有一个特性：**它跟 UI 无关，但跟数据强相关**。同一个 `package.json`，不管是渲染成网页头像、还是塞进 CLI 表格、还是发给 LLM 当上下文，都需要这份归一化后的稳定结构。如果把它写在 Vue 组件里，CLI 拿不到；写在 CLI 里，网页拿不到。所以必须有一层**纯函数的、跟传输/渲染都无关的归一化关口**，谁需要谁来调。

这层一旦写好，前端组件就再也不用关心「这个作者字段是字符串还是对象」——它只要调 `normalizePkgAuthors(json)`，拿到的永远是 `ParsedAuthor[]`。这是「翻译关口」存在的全部意义：**把混乱封在过去，把秩序递给未来**。