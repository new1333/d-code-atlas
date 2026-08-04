# 统一 cookiejar：从浏览器密钥环解密登录态

你在浏览器里早就登录好了 YouTube，现在想让下载工具直接用这份登录态，而不是再开个网页去手动导出一份 cookies.txt。这听起来天经地义——「我都登进去了，你拿去用不就行？」麻烦在于：浏览器把你的登录态加密锁在它自己的私有存储里，而且每个浏览器存的格式不一样、每个操作系统加密的方式又不一样。这一章讲的，就是怎么把这些五花八门的「加密登录态」还原成一份干净的 cookie，再在发请求时按域名塞回去。

## 先认识「产物」：一个谁都对它说话的 cookie 罐子

要理解整条链路，最好先盯着终点看。不管登录态来自浏览器还是来自一个文本文件，最后都要落进同一个东西——一个统一的 cookie 容器。说人话就是：下载主流程只认这一个罐子，它根本不关心罐子里的 cookie 是谁放进去的、当初是加密的还是明文的。

打个比方，这个罐子像一块**公共留言板**：谁都往上面贴条子（放 cookie），发请求的时候再按「收件人」（也就是域名）把对得上号的条子取出来带走。罐子对外的契约很简单：

- 往里贴一条 cookie（`setCookie`）；
- 给一个 URL，吐出这条请求该带上哪些 cookie（`getCookieHeader(url)`）。

第二点尤其关键，它是「按域注入」的入口。容器内部会拿请求的 host 去跟每条 cookie 的 domain 做后缀匹配——比如 cookie 的 domain 是 `.youtube.com`，那请求 `www.youtube.com` 就命中——把命中的那些拼成一个 `Cookie:` 请求头交出去。

> 这一步和第 1 章「可插拔传输层」是衔接关系，那里讲的「中立请求管线 + 多后端竞争」不在这里重复。只需要知道：那个管线管的是「用什么引擎发请求」，而这个 cookie 罐子是挂在那条管线上的一件共享附件——任何一种传输后端发请求前，都可以来罐子里取一句 `Cookie:` 头贴上去。

## 来源五花八门，但都得喂进同一个罐子

罐子定了，剩下的问题就是「怎么往里喂」。登录态的来源大致两类：

- **文件来源**：用户给的 `cookies.txt`；
- **浏览器来源**：从已安装的浏览器里现抽。

浏览器来源这一支是重点。它有一个分派入口，按浏览器名把活儿派给不同的提取器：Firefox 走 Firefox 的、Safari 走 Safari 的，剩下那一大票 Chromium 系（Chrome / Edge / Brave / Opera / Vivaldi / Whale…）统一走 Chromium 的。这个「按名字路由到不同提取器」的设计，正是后面几条权衡的起点。

## Chromium 那一支最麻烦：先按操作系统选解密器

Firefox 的 cookie 表是明文的，直接读就行；Safari 用的是自家一套二进制格式，得逐字节手写解析器。真正棘手的是 Chromium 系——它的 cookie 是加密的，而且加密方式随操作系统变。

所以 Chromium 提取器内部做的第一件事，是看自己在哪个系统上跑，然后选一个对应的解密器：Linux 一个、Mac 一个、Windows 一个。三个解密器的差别，用一张表说清：

| 系统 | `v10` | `v11` | 其它前缀 |
|------|-------|-------|---------|
| Linux | AES-CBC，固定口令 `peanuts` 派生的钥匙 + 空口令兜底 | AES-CBC，钥匙来自系统密钥环 + 空口令兜底 | 未知，告警并跳过 |
| Mac | AES-CBC，钥匙来自系统 keychain | — | 当作明文「旧数据」直接读 |
| Windows | AES-GCM，主钥匙存在配置文件里、经 DPAPI 解一层 | — | 直接交 DPAPI 解 |

（顺带一提，Linux 和 Mac 派生钥匙都用 PBKDF2-SHA1、盐 `saltysalt`、16 字节，但 Linux 只迭代 1 次、Mac 迭代 1003 次——这种「同算法不同参数」的差异，本身就是逆向出来、随版本漂移的脆裂点之一。）

注意这张表里「钥匙从哪来」每个格子都不一样，这是最容易搞混的地方，下一节专门讲。

## 多把钥匙轮着试：版本前缀分派 + 候选钥匙兜底

一条加密 cookie 长这样：最前 3 个字节是版本标签（`v10` 或 `v11`），剩下的才是密文。解密器拿到一条记录，先把前 3 字节切出来看是哪个版本，再走对应的解密路子；不认识的版本就告警跳过，不会因为一条坏数据拖垮整批。

真正绕的是「钥匙从哪来」。这里要特别小心一个常见误解：**不是所有 v10 钥匙都来自系统密钥环**。以 Linux 为例（三个解密器里它最能说明问题）：

- Linux 的 **v10 钥匙**，是拿 Chromium 硬编码的一个固定口令 `peanuts`，做一次 PBKDF2 派生出来的。这把钥匙跟系统密钥环一点关系都没有——`peanuts` 就是个写死在 Chromium 代码里的常量，逆向出来的。
- Linux 的 **v11 钥匙**，才真的去问系统密钥环（KWallet / GNOME keyring）要浏览器的 Safe Storage 口令，再派生。而且这把钥匙是**懒求值**的——只有真碰到 v11 的 cookie 才去跑那趟 D-Bus 查询；没有 v11 cookie，就压根不查，省一次开销。

（对比一下就不难发现，「v10 用密钥环、v11 用密钥环」这种一刀切的说法是错的：Mac 上的 v10 钥匙反而是从 keychain 来的；Windows 的 v10 钥匙存在一个叫 `Local State` 的配置文件里、还得先用系统 DPAPI 解一层。所以得分系统看，不能混为一谈。）

那「多把钥匙轮着试」又是怎么回事？Linux 解密器初始化时其实准备了两把候选钥匙：一把是从 `peanuts` 派生的「正经 v10 钥匙」，另一把是从**空口令**派生的「空钥匙」。解密时它不赌哪把对，而是把两把都喂给一个「挨个试」的函数：第一把先解，解完看结果能不能当成合法文本读出来——能读，就算命中；读不出来，换下一把再试。

这里有个关键点必须分清：**那把空钥匙并不是 v10 主钥匙**。它是 yt-dlp 仿照 Chromium 自己一个 bugfix（解密器注释里引用的那个 `[1]` 提交）额外加的一道兜底——当正经钥匙因为某些原因解不开时，再退一步试试空口令，模拟 Chromium「主钥匙失败就回落到空口令」的行为。命中判据是「能不能当合法文本读」这个启发式，注释也坦白说这跟 Chromium 官方判定不完全一致，理论上存在钥匙错了但恰好解出合法文本的极小概率误判。但它换来的是一件很值钱的事：**完全不需要调浏览器自己的 API，纯文件层 + 系统密钥环就能把明文 cookie 还原出来**。

## 绕开浏览器锁：把数据库复制一份再读

Chromium 的 cookie 存在 SQLite 数据库里。问题来了：浏览器正开着的时候，这个数据库文件是被占用的，直接 `sqlite3.connect` 打开会失败。yt-dlp 的办法很直接——把整个数据库文件复制到临时目录，去打开那个副本。注释里写得很明白：「数据库正在被浏览器用时打不开」。这是个明确的用户体验取舍：宁可多花一次文件复制的 I/O，也不让用户为了下个视频去关浏览器。

## 串起来：抽出来、合并、按域注入

把上面这些件拼起来，主装配链是这样的：

```
load_cookies(文件, 浏览器)
   ├─ 文件来源 → 解析 → 喂进 jar A
   └─ 浏览器来源
        └─ extract_cookies_from_browser(浏览器名)
             ├─ firefox → 读明文表 → setCookie
             ├─ safari  → 逐字节解析二进制 → setCookie
             └─ chromium → 复制库绕锁 → 按 OS 选解密器
                          → 逐行：前缀分派 + 多钥匙兜底 → 明文 → setCookie
   → 把多个 jar 合并成一个统一 jar 返回
```

之后任何请求 URL，容器就按域名后缀匹配，吐出该带的 `Cookie:` 头。一条典型执行轨迹（Windows 上跑 `--cookies-from-browser chrome`）：选 Windows 解密器 → 定位到 Cookies 库 → 复制到临时目录打开绕锁 → 从 `Local State` 读主密钥、用 DPAPI 解出 AES-GCM 主密钥 → 逐行：前 3 字节是 `v10` → 切出 nonce 和认证 tag → AES-GCM 解出明文 → 装进罐子 → 之后请求 `https://www.youtube.com/...` 时按域名命中 → 输出 `Cookie: SID=...; LOGIN_INFO=...`。

## 一个最小骨架：演透「来源异构 → 产物统一 → 按域注入」

下面这段 TS 把本章要教的抽象骨架演出来：统一的罐子、按浏览器名分派、版本前缀分派 + 多候选钥匙挨个试、最后按域名注入。真实 OS 密钥环解密链（Windows 的 DPAPI、Mac 的 keychain、Linux 的 KWallet/secretstorage）依赖原生系统调用，TS 讲不透，所以这里用一个 mock 的 `decrypt` 占位——它演的是**控制流结构**（换把钥匙结果会变、第一把解不出就试下一把），不是真实密码学。

```ts
// cookiejar.ts —— 演透「来源异构 → 产物统一 → 按域注入」+「前缀分派 + 多钥匙兜底」的骨架
// 跑法：bun run cookiejar.ts  （bun 原生懂 TS；node 可用 npx tsx cookiejar.ts）

interface Cookie {
  name: string
  value: string
  domain: string          // 如 ".youtube.com"
  encrypted?: Buffer      // 仅 chromium 系才有：v10/v11 密文
}

// 1) 统一产物：一个谁都对它说话的 cookie 罐子
class CookieJar {
  private cookies: Cookie[] = []
  setCookie(c: Cookie) { this.cookies.push(c) }

  // 按域名后缀匹配，吐出该带的 Cookie 头
  getCookieHeader(url: string): string | null {
    const host = new URL(url).hostname
    const hit = this.cookies.filter(c => hostMatches(host, c.domain))
    return hit.length ? hit.map(c => `${c.name}=${c.value}`).join('; ') : null
  }
}
const hostMatches = (host: string, domain: string) =>
  host === domain.replace(/^\./, '') || host.endsWith(domain)

// 2) 解密骨架：版本前缀分派 + 多候选钥匙挨个试 + 「能否当合法文本读」当命中判据
function decryptCookie(blob: Buffer, candidateKeys: Buffer[]): string | null {
  const prefix = blob.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10') return null             // 未知前缀：跳过（真实代码里 Mac/Win 的「旧数据」另有处理）
  const cipher = blob.subarray(3)
  for (const key of candidateKeys) {
    const plain = mockAesDecrypt(cipher, key)   // 真实链路：Linux/Mac = AES-CBC，Windows = AES-GCM
    if (looksLikeText(plain)) return plain      // 命中判据：解出来能当合法文本读
  }
  return null                                   // 两把都试失败 → 这条作废，不拖垮整批
}
// 占位：真实实现里是 AES-CBC / AES-GCM + UTF-8 严格校验；这里只为演示「换把钥匙结果会变」
const mockAesDecrypt = (cipher: Buffer, key: Buffer) =>
  Buffer.from(cipher.map((b, i) => b ^ key[i % key.length]))
const looksLikeText = (b: Buffer) =>
  ![...b].some(byte => byte < 0x20 && byte !== 0x09)   // 简化：不含控制字符就算「像文本」

// 3) 两个来源各异的提取器
function firefoxExtractor(): Cookie[] {
  // Firefox：明文表，无需解密
  return [{ name: 'SID', value: 'ff-plain', domain: '.youtube.com' }]
}
function chromeExtractor(): Cookie[] {
  const v10Key   = Buffer.from('peanuts')        // 对应 Linux derive_key(b'peanuts')：固定口令派生
  const emptyKey = Buffer.from('empty-pw')       // 对应 derive_key(b'')：空口令派生（真实仍是 16 字节，此处简化）
  const blob = Buffer.concat([Buffer.from('v10'), Buffer.from('login-secret')])  // mock 一条 v10 密文
  return [{
    name: 'LOGIN_INFO',
    value: decryptCookie(blob, [v10Key, emptyKey])!,   // 正经钥匙先试，空口令兜底
    domain: '.youtube.com',
  }]
}

// 4) 装配入口：文件 + 浏览器，合并进同一个罐子
function loadCookies(opts: { file?: Cookie[]; browser?: 'firefox' | 'chrome' }): CookieJar {
  const jar = new CookieJar()
  opts.file?.forEach(c => jar.setCookie(c))
  if (opts.browser === 'firefox') firefoxExtractor().forEach(c => jar.setCookie(c))
  if (opts.browser === 'chrome')  chromeExtractor().forEach(c => jar.setCookie(c))
  return jar
}

// 5) 演示按域注入
const jar = loadCookies({ browser: 'chrome' })
console.log(jar.getCookieHeader('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
// → "LOGIN_INFO=..."   （host www.youtube.com 命中 domain .youtube.com）
console.log(jar.getCookieHeader('https://example.org/'))
// → null               （域名不匹配，不带 cookie）
```

配套最小 `package.json`：

```json
{ "name": "cookiejar-demo", "private": true, "type": "module" }
```

这段骨架演的是权衡 1（统一产物 + 分派）和「前缀分派 + 多钥匙兜底」的控制流；权衡 2 的「复制绕锁」用注释带过，因为它只是个文件操作，没有值得演的结构。

## 关键权衡

理解了机制，回头看这几条设计到底换来了什么、又付了什么代价。

**1. 统一产物 + 来源分派入口**
- **选择**：所有来源都落进同一个 `YoutubeDLCookieJar`，再用一个按浏览器名路由的分派入口。
- **换来**：主流程只对着一个 cookie 容器说话，根本不需要知道登录态来自文件还是哪个浏览器；后续的注入逻辑（按域匹配）也只需要写一套。
- **代价**：得为「浏览器 × 操作系统」维护一整张异构适配器矩阵——Firefox 明文表、Safari 自有二进制、Chromium 还要再按 Linux/Mac/Windows 三套密钥方案。每加一个浏览器或换一个 OS，都要新写或改动一条提取/解密路径。

**2. 把数据库复制到临时目录再读**
- **选择**：不请求用户关闭浏览器，而是把整个 SQLite 库复制到临时目录后打开副本。
- **换来**：浏览器正开着、数据库被锁也能读 cookie，用户体感「无感」——下个视频不必先关浏览器。
- **代价**：每次提取都要复制整个库的 I/O 开销，外加临时文件的生命周期管理（用完得清理）。源码里 Windows 上碰到 `PermissionError errno 13` 还会单独给 issue 链接并退出，说明开发者把「浏览器可能正开着」当常态，连报错路径都为它设计。

**3. 解密常量靠逆向硬编码 + 多钥匙/空口令兜底**
- **选择**：完全绕开浏览器自己的 API，纯文件层 + 系统密钥环 API 还原明文 cookie；解密需要的常量（版本前缀 `v10`/`v11`、派生盐 `saltysalt`、迭代次数、那个固定口令 `peanuts`）全是逆向 Chromium 源码硬编码进来的；解密时还多备一把空口令钥匙挨个试。
- **换来**：不依赖浏览器进程、不依赖任何浏览器扩展或官方导出接口，跨机器可移植；只要文件和系统密钥环在，就能解。
- **代价**：这些常量随浏览器版本升级极易碎裂——元数据版本号到 24 就得砍掉解密结果前 32 字节的哈希前缀（App-Bound Encryption 的后续变更）、Firefox schema 16 起 expiry 改毫秒要 `/1000`、还设了 schema 版本上限告警。源码里散落的大量 chromium/firefox commit 链接，正是持续打补丁的痕迹——浏览器一升级，这些路径随时可能失效。

**4. 探测桌面环境再决定密钥环后端（Linux）**
- **选择**：Linux 上先读 `XDG_CURRENT_DESKTOP` / `DESKTOP_SESSION` 等环境变量判断桌面环境（KDE / GNOME / 纯文本），再映射到 KWallet / GNOME keyring / 无密钥环三条取密钥路径；也允许用户用 `--keyring` 手动覆盖。
- **换来**：Linux 上自动适配三种主流密钥存储，多数用户不用管密钥环是什么。
- **代价**：探测逻辑强依赖环境变量，很脆弱——用户处在非典型桌面、远程会话、或自定义 XDG 设置下，很容易探测错；而且浏览器本身支持用命令行参数强制指定密钥存储、从而绕过环境变量，一旦如此，yt-dlp 的自动探测就会扑空，只能靠用户手动告知用哪个密钥环。

## 小结

一句话收束本章：**来源异构、产物统一、按域注入**。Firefox 的明文、Safari 的二进制、Chromium 在三个 OS 上各自的加密方案，最后都坍缩成同一个 cookie 罐子；罐子再按请求的域名，把对得上号的 cookie 拼成 `Cookie:` 头注入。其中最容易踩的坑，是别把「v10 钥匙」一律当成「来自密钥环」——Linux 上 v10 用的是硬编码的 `peanuts`，密钥环口令只喂给 v11。

下一章会看到 YoutubeDL 编排器怎么把这个 cookie 罐子当作一项横切关注点，挂到贯穿提取→下载→后处理的主管线上去。