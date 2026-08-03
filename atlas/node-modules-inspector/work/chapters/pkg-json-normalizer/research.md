# package.json 字段规范化（author/repo/license/funding） · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：上游喂进来的 `package.json` 里，作者/仓库/许可证/赞助这四个字段在 30 年里被各代规范允许过 N 种合法写法——字符串、对象、数组、带尖括号/圆括号的「人肉复合字符串」全都能在 npm 上找到实例。下游 UI（头像、链接、徽章）只想渲染一种结构。这层就是中间的「翻译器」：把五花八门的输入压成稳定的几种输出形态。
- **一句话核心思想**：**「多形态输入 → 中间元组 → 优先级合并出单一展示形态」**——先识别形态，再抽取关键字段，最后按固定优先级裁决。
- **设计动机（为什么需要它）**：上层（解析阶段把磁盘包变可读节点的那一步）需要拿到稳定的 `authors[] / repository / license / fundings[]` 来喂给前端。这四个字段是 UI 上「这个包是谁写的、代码在哪、什么许可、怎么赞助」的全部信号；只要其中一种形态没被覆盖，那一类包就会在前端展示成空白或乱码。所以必须有一个**集中的归一化关口**，而不是让前端各自兜底。
- **关键权衡（核心原料）**：
  1. **GitHub handle 一票否决纯文本作者**：选了「只要任意一个作者条目能解析出 GitHub handle，就只返回 GitHub 条目、丢弃其它纯文本作者」 → 换来了「头像永远可点、永远有图」的一致展示 → 代价是冷门包（纯文本署名、无 GitHub 关联）的作者名会被静默丢掉，前端再也看不到。
  2. **推断 > 显式不存在的字段**：选了「仓库字段缺失时，从 `bugs.url` 里砍掉 `/issues` 当仓库链接」「作者全是纯文本时，从仓库 org 反推一个 GitHub 作者」 → 换来了覆盖率最大化（很多老包只填了 bugs 没填 repo，仍能给个可点链接） → 代价是推断结果用一个 `inferred: true` 标志兜底，前端若想区分「真作者」与「猜的作者」必须读这个标志。
  3. **多许可证合并成 SPDX 表达式**：选了「老式 `licenses: [...]` 数组合并成 `(A OR B)`」 → 换来了和 SPDX 单字段同样的字符串契约 → 代价是下游必须把整个字符串当 opaque 处理，不能假设它一定是单个标识符。
  4. **协议噪声容差**：选了「逐个 replace 把 `git+`、`ssh://`、`git@`、`.git`、`github:` 全清掉，再保留 URL」 → 换来了能直接喂给 `<a href>` 的干净 https 链接 → 代价是正则链是顺序敏感的，新出现的协议写法（如 ssh 特殊变体）必须再插一条 replace，否则会漏。
- **最小心智模型（5 步）**：
  1. **形态分流**：用 `typeof` / `Array.isArray` 把字段切成 string / object / array 三条管道。
  2. **字符串拆解**：对人肉复合字符串（`Name <email> (url)`）按顺序抽 email、url、剩下的当 name；对仓库字符串做协议噪声清洗。
  3. **平台身份升级**：把 url/email 用专门正则升级成 GitHub handle（一个高维身份，能直接换头像）。
  4. **优先级裁决**：作者按 GitHub > 文本 > 仓库 org 推断逐级回退；多 license 合并为 SPDX 表达式；多 funding 全保留。
  5. **结构化输出**：吐出统一的 Parsed* 形态（每个字段都有自己的窄类型），上层只认这些类型。
- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个 30~40 行的迷你 normalizer，演透「多形态 → 中间元组 → 优先级合并」这三步。具体地：
    - 输入：`{ author: "Foo <foo@bar.com> (https://github.com/foo)", repository: "foo/bar", license: { type: "MIT" } }`
    - 拆 author 字符串：先把 `<...>` 切成 email、把 `(...)` 切成 url、剩下当 name；
    - 升级：用 `github.com/<user>` 正则把 url 升级为 handle；
    - 裁决：因为能拿到 handle，就只返回 `{type:'github', github:'foo'}`，丢掉 "Foo" 这个文本名。
  - **应故意省略**：avatars.antfu.dev 头像服务、opencollective 头像拼接、bugs 兜底分支、SPDX 嵌套表达式、directory 字段拼 `tree/HEAD/...`、`@antfu/utils` 的 toArray 工具、pkg-types 的类型来源。
  - **演示载体建议**：本仓库是 TS 项目，建议写成能在 `bun run`/`node` 下直接跑的脚本（非硬要求）。重点不是「能跑」，而是让读者一眼看到三阶段的转换：**raw input → tuple → final shape**。把裁决日志（"丢弃文本作者 Foo，因为找到了 handle foo"）打到 stderr，能强化对「权衡 1」的直觉。
- **正文不宜展开的细节**：
  - `avatars.antfu.dev` 第三方头像代理服务（这是个产品决策，不是原理）；
  - opencollective 的 `avatar.png` 拼接规则；
  - SPDX 表达式语法（`MIT OR Apache-2.0` 之类）；
  - 仓库 `directory` 字段被拼成 `tree/HEAD/<directory>` 的 URL 约定；
  - `pkg-types` 库提供的 `PackageJson` 类型来源；
  - 与上层 resolve 阶段的集成（mutate 进 `pkg.resolved`，那是另一章）。
- **推荐的一个执行轨迹例子**：
  - 输入：`{ author: "Foo Bar <foo@bar.com> (https://github.com/foo)", repository: "github:foo/bar.git", license: { type: "MIT" }, funding: "https://opencollective.com/foo" }`
  - 关键中间态：
    - author 串 → `{name:"Foo Bar", email:"foo@bar.com", url:"https://github.com/foo"}`
    - url 升级 → handle = `"foo"`
    - repo 串 → 去 `github:` 前缀、去 `.git`、补 https → `"https://github.com/foo/bar"`
    - license object → `license.type` = `"MIT"`
    - funding string → 包装为 `[{url:"..."}]` → 解析出 `opencollective/foo`
  - 输出：`{ authors: [{type:'github', github:'foo', avatar:'...'}] /* "Foo Bar" 文本名被丢弃 */, repository: {url:'https://github.com/foo/bar', repo:'foo/bar', org:'foo', repoName:'bar'}, license: 'MIT', fundings: [{type:'opencollective', name:'foo', entry:'opencollective@foo', ...}] }`

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **形态分流策略**：四个归一化函数全部以「`typeof` + `Array.isArray` 三态分流」开头，把 string / object / array 各送一条管道。这是「多形态输入」的核心应对手段。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:88-109 (license 形态分流) / :111-128 (funding) / :193-207 (authors) / :241-246 (repository)

- **「中间元组」是 RawAuthor/RawFunding**：抽取阶段产出的对象只有 `{name?, email?, url?}` 三个字段，不掺平台语义；平台语义（GitHub handle、avatar）在「升级」阶段才叠上去。这种分层让抽取逻辑可单独复用。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:130-134 (RawAuthor 定义) / :174-191 (升级函数 toParsedAuthor)

- **GitHub handle 优先于纯文本作者**（注释明文）：若任一作者条目能解析出 GitHub handle，则只返回 GitHub 条目，纯文本条目整体丢弃。这是「展示一致性 > 信息完整」的明确取舍。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:209-214 (含原始注释)

- **仓库 org 兜底推断作者**：当没有任何 GitHub handle 但能从 repository 字段切出 org 时，会把 org 当作 inferred 作者返回。`inferred: true` 标志让前端可区分「真作者 vs 猜测」。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:217-225

- **bugs.url 兜底仓库**：repository 字段缺失时，把 `bugs.url`（若是 github.com 开头）去掉 `/issues` 后缀当作仓库 URL。代价：假设 issues 入口等于仓库入口。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:266-270

- **多 license 合并 SPDX 表达式**：老式 `licenses: [{type:"A"},{type:"B"}]` 数组（npm 早期 legacy）会被合并成 `(A OR B)` 字符串，与单 license 走同一条 string 契约。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:101-108

- **协议噪声清洗链**：repository URL 经过一连串顺序敏感的 replace（去 `git+`、`ssh://`、`git://`、`git@github.com`、`.git` 后缀、`github:` 前缀）。新增协议变体必须再插一条 replace。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:247-261

- **Bare repo 简写识别**：形如 `foo/bar` 的裸字符串被识别为 GitHub 简写并补全为 `https://github.com/foo/bar`。判定靠正则 `/^[a-z0-9][-.\w]*\/[a-z0-9][-.\w]*$/i`。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:252-253

- **头像走第三方代理**：GitHub 头像统一拼成 `https://avatars.antfu.dev/gh/<handle>`，opencollective 走 `https://opencollective.com/<name>/avatar.png`。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:10-12 / :72-73

- **funding 类型识别**：用三个正则按 sponsors → profile-like → opencollective 顺序匹配，命中即定 type；都不中则用「去协议头 + 去尾斜杠」的 hostname 当 name，type 退化为 `'link'`。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:41-68

- **author 复合串解析顺序**：固定按「先 `<email>` 再 `(url)` 再剩 name」的顺序切。先 email 是因为 email 不会含 `()`，url 可能含字符——这个顺序避免了误吞。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:150-172

- **authors 与 author 合并**：用 `@antfu/utils` 的 `toArray` 把 `authors` 与 `author` 都摊平到一个数组里处理；这意味着同时填了两个字段的包，作者会被合并（且仍受 GitHub 优先规则约束）。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:194-198

- **多 funding 全保留**：和 license 的「合并成单字符串」不同，funding 数组所有条目都被保留并各自解析（不合并）。语义不同：license 是「法律状态」（必须一个），funding 是「赞助渠道」（可以多个并列）。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:124-127

## 关键调用链

四个函数相互无依赖（平级），但 `normalizePkgAuthors` 在「纯文本回退」路径里**反向调用** `normalizePkgRepository` 取 org：

```
normalizePkgAuthors(json)
   └─ (无 GitHub handle 时) → normalizePkgRepository(json).org  ← 跨函数回退
normalizePkgRepository(json)
   └─ (无 repository 时) → bugs.url  ← 字段间兜底
parseFunding(funding)
   └─ extractGitHubHandle 风格的「正则升级」(实际是内联实现)
parseAuthor(str)
   └─ 正则切 <email> / (url) / name → RawAuthor → toParsedAuthor → 升级 GitHub handle
```

上层入口（在另一章里）的调用关系（仅供定位，不在本章节正文展开）：
```
resolvePackage(pkg) →
  const json = JSON.parse(package.json)
  pkg.resolved = {
    authors:    normalizePkgAuthors(json),
    repository: normalizePkgRepository(json),
    license:    normalizePkgLicense(json),
    fundings:   normalizePkgFundings(json),
    ...其它字段
  }
```
源码位置: packages/node-modules-tools/src/resolve.ts:67-70（调用点，非本章 sourceFile）

## 源码摘录（带行号，全文累计 ≤ 30 行）

平台身份抽取正则组（5 行）——这是「升级阶段」的全部武器：
```ts
// packages/node-modules-tools/src/utils/package-json.ts:4-8
const RE_GITHUB_SPONSORS = /^(?:https?:\/\/)?(?:www\.)?github\.com\/sponsors\/([\w.-]+)/i
const RE_GITHUB_USER_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/?$/i
const RE_GITHUB_PROFILE_LIKE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)/i
const RE_GITHUB_NOREPLY = /^(?:\d+\+)?([\w.-]+)@users\.noreply\.github\.com$/i
const RE_OPENCOLLECTIVE = /^(?:https?:\/\/)?(?:www\.)?opencollective\.com\/([\w.-]+)/i
```

author 复合串解析（10 行，已压缩空行）——演透「先 email 后 url」的顺序敏感：
```ts
// packages/node-modules-tools/src/utils/package-json.ts:150-172（已压缩）
const RE_AUTHOR_EMAIL = /<([^>]+)>/
const RE_AUTHOR_URL = /\(([^)]+)\)/
export function parseAuthor(author: string): RawAuthor {
  let rest = author
  let email: string | undefined
  let url: string | undefined
  const emailMatch = rest.match(RE_AUTHOR_EMAIL)
  if (emailMatch) { email = emailMatch[1]!.trim() || undefined; rest = rest.replace(emailMatch[0], '') }
  const urlMatch = rest.match(RE_AUTHOR_URL)
  if (urlMatch) { url = urlMatch[1]!.trim() || undefined; rest = rest.replace(urlMatch[0], '') }
  const name = rest.trim() || undefined
  return { name, email, url }
}
```

GitHub handle 优先 + 仓库 org 兜底（11 行）——本章最核心的取舍，原注释保留：
```ts
// packages/node-modules-tools/src/utils/package-json.ts:209-226
// GitHub handle takes precedence over all text-typed authors. If any explicit
// author resolved to a github handle, return only those — text-only entries
// alongside are dropped.
const githubEntries = parsed.filter(a => a.type === 'github')
if (githubEntries.length)
  return githubEntries

// No explicit github handle — fall back to inferring a single maintainer from
// the repository org if available. This drops any text-only authors too.
const org = normalizePkgRepository(json)?.org
if (org) {
  return [{ type: 'github', github: org, avatar: githubAvatar(org), inferred: true }]
}
```

bugs.url 兜底仓库（4 行）：
```ts
// packages/node-modules-tools/src/utils/package-json.ts:266-270
if (!url) {
  const bugsUrl = typeof json.bugs === 'string' ? json.bugs : json.bugs?.url
  if (bugsUrl && bugsUrl.startsWith('https://github.com/'))
    url = bugsUrl.replace(/\/issues$/, '')
}
```

## 易混淆 / 边界 / 推断

- **事实**：`ParsedAuthor` 是个判别联合（`type: 'github'` 与 `type: 'text'` 互斥），不允许既是 GitHub 又是文本——这是「GitHub 一票否决」在类型层面的体现。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:136-148

- **事实**：`extractGitHubHandle` 优先尝试 `url`，失败才尝试 `email`；email 走的是 GitHub 的 `@users.noreply.github.com` 隐私邮箱格式，带可选的 `<id>+` 前缀。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:14-26

- **事实**：`RE_GITHUB_USER_URL` 末尾要求 `/?$`（即用户 URL 后只能跟可选斜杠然后结束），而 `RE_GITHUB_PROFILE_LIKE` 不要求结尾——后者在前者匹配失败时兜底，能匹配 `github.com/foo/anything`。funding 解析里只用 PROFILE_LIKE，因此 `github.com/foo/bar` 也会被当成 handle=`foo`（推断：可能是为了在仓库 URL 误填到 funding 时仍能取到 org）。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:5-6 / :52-57

- **事实**：`parseFunding` 的 `entry` 字段拼成 `${type}@${name}` 形式，疑似作为去重 key 使用（未在 sourceFiles 内见到 entry 的消费方）。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:75

- **推断**：`normalizePkgAuthors` 故意把「org 推断」放在「保留纯文本作者」之前——这意味着「宁可丢真实姓名也要给个 GitHub 头像」。从产品视角看是合理的选择（前端展示一致性 > 信息保真），但对老 Cocos2D / 学术界包作者不友好。代码里 `inferred: true` 是这个决策的诚实标记。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:217-231

- **推断**：license 的「`licenses[]` 数组」分支处理的是 npm 早期规范允许的旧字段（现在标准是单个 `license` 字符串）。新包不该再用，但归一化必须兼容存量。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:101-108

- **推断**：repository 字段串清洗链没有用单一强大正则而是连用 5+ 个 `replace`，可能是为了让每条规则独立可读、可加注释；代价是顺序敏感（先去前缀再去后缀，先后缀去 `.git` 时还能保留 protocol）。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:247-261

- **未理解**：`RE_GITHUB_PROFILE_LIKE` 与 `RE_GITHUB_USER_URL` 几乎重复（仅结尾锚点不同）；在 `extractGitHubHandle` 里只用 USER_URL，在 `parseFunding` 里两者都尝试但 PROFILE_LIKE 是兜底。这种「按使用点分别挑正则」的设计是否有意优化（避免 over-capture），还是历史遗留，无法仅从源码确认。
  源码位置: packages/node-modules-tools/src/utils/package-json.ts:5-6 / :14-26 / :47-58