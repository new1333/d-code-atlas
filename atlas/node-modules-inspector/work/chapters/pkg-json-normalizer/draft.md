# package.json 字段规范化（author/repo/license/funding）

> 本章属于 primitive 层。前置：无。本章是全书地基章之一。
> 学完你能：用一句话讲清「为什么 package.json 这四个字段必须有一个集中的归一化关口」，以及这个关口做了哪几个产品级取舍。

## 1. 为什么需要它（设计动机）

上一章把「包占了多少字节」按文件类别分了桶，但前端要展示一个包，光知道体积还不够。它还得告诉用户四件事——这个包是谁写的、代码在哪、什么许可、怎么赞助。这四个信号全部来自 package.json 里那四个字段（`author`/`authors`、`repository`、`license`、`funding`）。

问题在于，这四个字段在 npm 三十年的演化里被规范允许过 N 种合法写法。一个 `author` 可以是字符串 `"Foo"`，可以是对象 `{ name: "Foo", email: "..." }`，可以是带尖括号、圆括号的复合串 `"Foo <foo@bar.com> (https://github.com/foo)"`，还可以同时填 `author` 和 `authors` 两份。`repository` 可以是 `"foo/bar"` 简写、可以是 `"git+https://..."`、可以是 `{ type, url, directory }`。`license` 老式写法是 `licenses: [{type:"MIT"},{type:"Apache-2.0"}]` 数组，新式是 `license: "MIT"` 单字符串。`funding` 既可以是字符串也可以是数组。

如果让前端各自兜底，头像组件猜一遍、链接组件猜一遍、徽章组件再猜一遍，那同一种「怪写法」在前端会被处理三遍，每处还都不一样。这层就是中间那个翻译器：把五花八门的输入压成稳定的几种输出形态，让前端只认一种结构。

## 2. 核心思想

把「识别形态」和「做裁决」拆成两步。先有一个**抽取阶段**把字符串、对象、数组都摊平到一个统一中间元组（`{ name?, email?, url? }` 三个可选字段，不掺任何平台信息）；再有一个**升级+裁决阶段**按固定优先级把 GitHub handle（能直接拼头像和链接的那种身份）叠上去、丢掉纯文本名、补上能用的链接。

换句话说：输入端只关心「我能不能切出 name/email/url」，输出端只关心「前端要的是哪种窄类型」，中间那个元组是不变的核心。

## 3. 心智模型

四个字段共用同一套三阶段管线：

```
多形态输入           中间元组                窄类型输出
(string/object/array) → { name?, email?, url? } → ParsedAuthor / ParsedRepository / ...

阶段 1：形态分流      阶段 2：抽取/清洗      阶段 3：升级 + 优先级裁决
  typeof               正则切尖括号          url/email → GitHub handle
  Array.isArray        去协议噪声            GitHub 一票否决纯文本
                       bugs.url 兜底         多 license 合 SPDX
                                             多 funding 全保留
```

四个字段都遵循这个骨架，但每个字段在「阶段 3」的裁决规则不同：

- **authors**：GitHub handle 一票否决纯文本；一个 handle 都没有时，从 `repository.org` 反推一个 inferred 作者
- **repository**：去协议噪声（`git+`、`ssh://`、`git@`、`.git`、`github:` 前缀）；`repository` 整个缺失时从 `bugs.url` 砍 `/issues` 兜底
- **license**：老式 `licenses[]` 数组合并成 `(A OR B)` SPDX 表达式，与新式单字符串走同一条 string 契约
- **funding**：每个条目都解析为 `{ url, type, name, avatar }`，多 funding 全保留（不合并）

关键不变量：**中间元组里永远只有 name/email/url**，不掺 GitHub handle / avatar 这种和具体平台绑定的信息——handle 和 avatar 是「升级阶段」才叠上去的。这种分层让抽取逻辑（切尖括号、切圆括号）可以独立复用；将来要支持 GitLab 也不必动抽取阶段。

## 4. 关键权衡

### 把「展示一致性」摆在「信息完整」前面

`normalizePkgAuthors` 做了四个字段里最硬的产品取舍：**只要任意一个作者条目能解析出 GitHub handle，就只返回 GitHub 条目，其它纯文本作者整体丢弃**。

- **选择**：GitHub handle 一票否决纯文本
- **换来**：头像永远可点、永远有图。前端只要走「GitHub 条目」分支，就一定能拼出头像和链接，不会出现「有的包有头像、有的包只有名字」的不整齐
- **代价**：冷门包（老 Cocos2D、学术界作者、不愿暴露 GitHub 的纯名字署名）的作者名会被静默丢掉，前端再也看不到

背后的本质矛盾是**展示一致性 vs. 信息保真**：要 UI 整齐就得牺牲少数派的真实数据，要保真就得让前端处理「有的有图、有的没图」的多态。这层选了前者，并用一个 `inferred: true` 标志诚实标注哪些是反推出来的——给「想区分真作者 vs 猜的作者」的下游留个钩子。

### 宁可推断也不要空白

`repository` 字段缺失时，把 `bugs.url`（如果是 github.com 开头）砍掉 `/issues` 后缀当仓库链接。作者全是纯文本、没有任何 GitHub 关联时，从 `repository.org` 反推一个 GitHub 作者填上。

- **选择**：跨字段推断（bugs → repo、repo.org → author）
- **换来**：覆盖率最大化。很多老包只填了 bugs 没填 repo，或者只填了 repo 没填 author，仍能给前端一个能点的链接和一张能显示的头像
- **代价**：推断结果不一定是事实。`bugs.url` 不一定等于仓库入口（有些项目的 issues 托管在第三方），`repository.org` 也不一定是作者本人（可能是组织）。`inferred: true` 标志是给这个代价兜底的诚实标记

这里的本质矛盾是**覆盖率 vs. 准确率**：宁可给出一个「大概是对的」结果，也不要空白；但又要让下游知道这是猜的、不要把它当事实。所有推断分支都配上 `inferred` 这种「诚实标志」，是这个矛盾的通解骨架——在任何「宁可猜也不要空」的系统里（推荐系统冷启动、地址补全、姓名切分）都能认出来。

### 协议噪声用一连串小 replace，不用一招吃天下

repository URL 的清洗链是顺序敏感的 5+ 个 `replace`：先去 `github:` 前缀、去 `git@github.com:` 前缀；识别裸 `foo/bar` 补成完整 https URL；再去 `git+`、去 `.git` 后缀、把 `git://` 和 `ssh://` 改成 `https://`、把 `git@github.com` 改成 `github.com`。

- **选择**：一长串顺序敏感的小正则 replace，而不是一招吃天下的大正则
- **换来**：每条规则独立可读、能加注释；新协议写法只要插一条 replace 就能扩展
- **代价**：规则之间有顺序依赖（先去 `github:` 前缀、才能用裸简写正则识别；先去 `.git` 后缀、保留的 protocol 才能用），新增 replace 时必须想清楚插在链中哪个位置；漏掉一种协议变体就只能再加一条 replace，没办法一次性兜底

本质矛盾是**可读性 vs. 表达力**：把多条规则叠在一起 readable，但牺牲了「一个正则包打天下」的简洁。这种取舍在所有「协议/格式清洗」场景都会遇到——电话号国际化的多步归一、邮箱大小写/别名归一，都是同一副骨架。

## 5. 最小原理演示

下面这段演示只演透「多形态输入 → 中间元组 → 优先级合并」这三步，省略 funding 类型细分、SPDX 嵌套表达式、bugs 兜底等旁路：

```ts
// 中间元组：只有 name/email/url，不掺平台信息
type RawAuthor = { name?: string; email?: string; url?: string }

// 升级后的窄类型：要么是 GitHub 身份、要么是纯文本
type ParsedAuthor =
  | { type: 'github'; github: string; inferred?: boolean }
  | { type: 'text'; name: string; url?: string; email?: string }

// 阶段 1+2：从字符串里抽出 name/email/url（写法与源码不同，演同一思想）
function parseAuthor(s: string): RawAuthor {
  const email = s.match(/<([^>]+)>/)?.[1]?.trim()
  const url = s.match(/\(([^)]+)\)/)?.[1]?.trim()
  const name = s.replace(/<[^>]+>/, '').replace(/\([^)]+\)/, '').trim() || undefined
  return { name, email, url }
}

// 阶段 3a：尝试把中间元组升级成 GitHub handle
function toHandle(raw: RawAuthor): string | undefined {
  if (raw.url) {
    const m = raw.url.match(/^github\.com\/([\w.-]+)\/?$/i)
    if (m) return m[1]
  }
  return undefined
}

// 阶段 3b：GitHub handle 一票否决纯文本
function normalizeAuthors(raws: RawAuthor[], orgFromRepo?: string): ParsedAuthor[] {
  const parsed = raws.map(toParsed).filter(Boolean) as ParsedAuthor[]
  const gh = parsed.filter(p => p.type === 'github')
  if (gh.length) {
    // 丢掉所有文本名，只留 GitHub 条目（演示「展示一致性 > 信息完整」）
    const dropped = parsed.filter(p => p.type === 'text')
    if (dropped.length)
      console.error(`[normalize] 丢弃文本作者 ${dropped.map(d => `'${d.name}'`).join(', ')}，因为找到了 handle`)
    return gh
  }
  if (orgFromRepo)
    return [{ type: 'github', github: orgFromRepo, inferred: true }]  // org 反推
  return parsed

  function toParsed(raw: RawAuthor): ParsedAuthor | undefined {
    const handle = toHandle(raw)
    if (handle) return { type: 'github', github: handle }
    if (!raw.name) return undefined
    return { type: 'text', name: raw.name, url: raw.url, email: raw.email }
  }
}

// 演一个具体输入
const input = {
  author: 'Foo Bar <foo@bar.com> (https://github.com/foo)',
  repository: 'foo/bar',
}
const raw = parseAuthor(input.author)
console.log(normalizeAuthors([raw], 'foo'))
// stderr: [normalize] 丢弃文本作者 'Foo Bar'，因为找到了 handle
// stdout: [{ type: 'github', github: 'foo' }]
```

这段演示里，"Foo Bar" 这个看起来很正常的作者名最后被丢了——但前端拿到了一个能拼头像的稳定 handle。这就是「展示一致性 > 信息完整」那条权衡在代码里的具体落地。

## 6. 执行轨迹

拿一个具体输入走一遍三阶段。

输入：

```ts
{
  author: 'Foo Bar <foo@bar.com> (https://github.com/foo)',
  repository: 'github:foo/bar.git',
  license: { type: 'MIT' },
  funding: 'https://opencollective.com/foo',
}
```

**阶段 1+2（形态分流 + 抽取）**：

`author` 字符串按顺序切：

- 先 `<([^>]+)>` 切出 `email = "foo@bar.com"`，剩下 `"Foo Bar  (https://github.com/foo)"`
- 再 `\(([^)]+)\)` 切出 `url = "https://github.com/foo"`，剩下 `"Foo Bar "`
- 剩下的 trim 当 `name = "Foo Bar"`
- 中间元组：`{ name: 'Foo Bar', email: 'foo@bar.com', url: 'https://github.com/foo' }`

`repository` 字符串走协议清洗链：

- `github:foo/bar.git` → 去 `github:` 前缀 → `foo/bar.git`
- 裸简写正则识别 → 补全为 `https://github.com/foo/bar.git`
- 去 `.git` 后缀 → `https://github.com/foo/bar`
- 从中切出 `org = "foo"`、`repoName = "bar"`

`license` 对象 → 取 `license.type = "MIT"`。

`funding` 字符串 → 包成 `[{ url: 'https://opencollective.com/foo' }]`。

**阶段 3（升级 + 裁决）**：

- `author`：用 `github.com/<user>` 正则升级 url → handle = `"foo"`。因为拿到了 handle，整个作者条目变成 `{ type: 'github', github: 'foo' }`，文本名 "Foo Bar" **被丢弃**
- `repository`：直接成 `{ url: 'https://github.com/foo/bar', org: 'foo', repoName: 'bar', repo: 'foo/bar' }`
- `license`：直接成 `"MIT"`
- `funding`：用 opencollective 正则匹配出 `name = "foo"`、`type = "opencollective"`，成 `[{ url, type, name, avatar }]`

**最终输出**：

```ts
{
  authors:    [{ type: 'github', github: 'foo' }],
  repository: { url: 'https://github.com/foo/bar', org: 'foo', repoName: 'bar' },
  license:    'MIT',
  fundings:   [{ type: 'opencollective', name: 'foo', /* ... */ }],
}
```

整条轨迹里最有意思的一步是 `author` 处理：输入里 "Foo Bar" 这个看起来很正常的作者名最后被丢了，因为系统能从 url 推出 GitHub handle `foo`，handle 比纯文本名「更值钱」。如果作者 url 不是 github.com，name 就会被保留为 `{ type: 'text', name: 'Foo Bar' }`。

## 7. 教学简化说明

上面的演示故意省略了：

- GitHub sponsors / GitHub noreply 邮箱 / opencollective 等平台正则组（每接一个平台多一条正则）
- 老式 `licenses[]` 数组合并 SPDX 表达式 `(A OR B)` 的分支
- 头像走第三方代理服务（avatars.antfu.dev / opencollective 的 avatar.png）这个产品决策
- `repository.directory` 字段拼成 `tree/HEAD/<directory>` 的 URL 约定
- `bugs.url` 兜底仓库链接的分支
- `funding.entry` 字段（`<type>@<name>` 格式，疑似用作去重 key）

这些都不影响「多形态 → 中间元组 → 优先级合并」的主线，是产品策略或边角补丁。

## 8. 小结

这一章做的是「翻译器」的活：把 package.json 三十年累积的多种合法写法压成前端能直接渲染的几种窄类型。技术本身平淡（四条正则、几个 replace），真正有意思的是产品视角的取舍——这层不假装能「忠实保留所有输入」，它明着选了「前端要什么」那一侧。

下一章会把这一层的输出（authors/repository/license/fundings）连同体积、模块类型一起，喂给一个统一的 `resolvePackage` 流水线，把磁盘上一个包变成前端能直接渲染的可读节点。