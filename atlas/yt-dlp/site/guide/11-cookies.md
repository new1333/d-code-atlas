# 统一 cookiejar：从浏览器密钥环解密登录态

> 本章属于 composite 层。前置：可插拔传输层。
> 学完你能：用一句话讲清「为什么 cookie 容器要把来源各异、加密各异的登录态坍缩成同一套标准 Cookie，再按域名注入请求」——以及为此必须扛下的「浏览器×OS 适配矩阵」脆裂代价。

## 1. 为什么需要它

上一章把 `info_dict` 投影成文件名——把「拿到数据后怎么命名」这件事办了；可那份 `info_dict` 不是凭空掉下来的。本章就接着这个口子讲：很多站点（YouTube、B 站、各种会员制视频站）得先登录、拿到「我是谁」的凭证，才肯把完整视频源交出来。**登录态从哪来**就是这一章要回答的问题。

最朴素的办法是让用户去浏览器里手动导出一份 `cookies.txt` 喂给下载工具。这件事繁琐、容易过期，更糟的是用户根本不知道自己在干什么——他只觉得「我浏览器里登着呢，为什么这边还要我再登一次？」

理想体验一句话就能说清：「我在浏览器里已经登录了，下载工具直接复用这份登录态」。

问题是浏览器的登录态不是给你下载工具用的。它被加密锁在浏览器各自的私有存储里：Firefox 存在明文 SQLite 里还算厚道；Safari 用一套自有二进制格式 `Cookies.binarycookies`；Chromium 系（Chrome / Edge / Brave / ...）更狠——cookie 值在 SQLite 里是密文，主密钥又被锁进操作系统的密钥环（Linux KWallet / GNOME keyring、macOS keychain、Windows DPAPI）。

这是一道**跨私有存储格式 + 跨 OS 加密方案**的还原难题。本章产出的统一 cookie 容器，最终挂在第 1 章「可插拔传输层」那个中立的 `Request` 上当附件——它把 `Cookie:` 头按域名填好，由 urllib / requests / curl_cffi 任一后端发出去，传输层对此无感。

## 2. 核心思想

**来源异构、产物统一、按域注入。**

不管登录态来自 Netscape 文件、Firefox 明文、Safari 二进制、还是被 Chromium 各 OS 密钥环加密的密文——统统坍缩成同一套标准 Cookie 集合；之后任何 URL 来要 cookie，按域名后缀匹配出适用条目，拼成 `Cookie:` 头交出去。

## 3. 心智模型

整个机制拆成三段：**抽 → 装入统一容器 → 注入**。

抽这段最复杂，分四层路由：

```
来源描述（浏览器名 + profile + 容器 + 密钥环）
        │
        ▼
┌───────────────────────────┐
│  来源分派入口              │  按 browser_name 路由
└──────┬────────────────────┘
       │
   ┌───┼────┬─────────┐
   ▼   ▼    ▼         ▼
Firefox Safari Chromium-系（chrome/edge/brave/...）
明文   二进制  按 OS 选解密器（Linux/Mac/Windows）
       │       │
       │       ├─ 复制 SQLite 到临时目录（绕过浏览器锁）
       │       ├─ 读 meta.version（决定是否砍 32 字节哈希前缀）
       │       └─ 逐行解密：版本前缀分派 + 多密钥兜底
       ▼       ▼
   每条 cookie（明文 name/value/domain/path/expires/...）
        │
        ▼
┌───────────────────────────┐
│  YoutubeDLCookieJar        │  统一容器（继承自 MozillaCookieJar）
└───────────────────────────┘
        │
        ▼  （请求来时）
URL → 按 host 后缀匹配命中 cookie → 拼成 `Cookie: k=v; ...` 注入请求头
```

三条不变量贯穿全程：

1. **主流程只对着一个 cookie 容器说话**，不知道也无需知道登录态来自哪。
2. **来源解密失败不会中断整批**——某条 cookie 解不出明文就跳过、计入 `failed_cookies`。
3. **注入只看域名匹配**，不管来源；同一个 jar 既能装文件来源的 cookie，也能装浏览器来源的 cookie，还能用 `_merge_cookie_jars` 把两者合并。

## 4. 关键权衡

四条取舍撑起了整个设计。

### 统一产物换来主流程无感，代价是浏览器×OS 适配器矩阵

抽 cookie 的核心选择是：**所有来源最终都坍缩进同一个 `YoutubeDLCookieJar`**——而不是给文件、Firefox、Safari、Chromium 各开一种容器类型。

换来的是主流程只对一个接口说话：`jar.get_cookie_header(url)`，根本不关心登录态怎么来的。下载器、提取器、传输层，谁都不必为 cookie 的来源分叉逻辑。

代价是适配器矩阵爆炸：行是浏览器（Firefox / Safari / Chromium 系若干），列是 OS（Linux / Mac / Windows），其中 Chromium 这一格还要再拆三套解密器。任何新浏览器上线、任何一次浏览器升级改了存储位置或加密方案，都得回这张表里改对应单元。**本质矛盾**是「主流程要单一来源的 cookie」与「真实世界登录态分布在 N 个加密私有存储里」之间的鸿沟——用一张适配器矩阵把它架起来，是这类「统一抽象 + 多后端」问题（第 1 章的可插拔传输就是同构的）的通解骨架。

### 复制数据库换「无需关浏览器」，代价是 I/O 与临时文件管理

读 cookie 数据库时 Chromium/Firefox 都有一个反直觉的选择：**先把 SQLite 文件 `shutil.copy` 到临时目录，再 `sqlite3.connect` 那份副本**。

原因写在源码注释里：浏览器正运行时会锁住 cookie 数据库，直接 `connect` 会失败。两种解法——要求用户关掉浏览器，或者复制一份再读。本设计选了后者。

换来的是「用户无需关闭浏览器」——这件事看起来小，对体验却是实打实的减负（用户压根不该被牵扯进工具的实现细节）。

代价是每次提取要复制整个 SQLite 库的 I/O 开销，外加临时文件的生命周期管理（创建、用完清理、跨进程竞争）。**对立的两头**是浏览器对 cookie 库的独占访问与下载工具要随时读——拿副本绕锁是处理这类「第三方独占资源」的常见招法，用空间换并发自由度。

### 文件层逆向常量换「零浏览器 API 依赖」，代价是版本脆裂

最硬核的选择：**不调用浏览器的任何 API**——不用 Chrome DevTools Protocol、不用 Firefox Remote Debugging、不用任何「问浏览器要 cookie」的官方途径。所有 cookie 都从**原始文件 + 操作系统密钥环 API** 直接解出来。

这意味着大量逆向得来的常量被硬编码进代码：Chromium os_crypt 写在密文前 3 字节的版本标签 `v10` / `v11`、PBKDF2 派生密钥用的盐 `b'saltysalt'`、Linux 上迭代 1 次 vs Mac 上迭代 1003 次、Windows 上 AES-GCM 主密钥存在 `Local State` 的 `os_crypt.encrypted_key` 字段、`meta.version >= 24` 时解出明文要砍掉前 32 字节哈希前缀……

换来的是「完全不依赖浏览器自身 API，纯文件层 + 系统密钥环 API 就能还原明文 cookie」——这条换来的东西非常硬：浏览器不需要开、不需要装、不需要兼容某个调试端口，整套提取在任何静默环境下都能跑。

代价是这些常量随浏览器版本升级极易碎裂。Chromium 元数据 `meta.version >= 24` 要砍哈希前缀、Firefox schema 16 起 expiry 改毫秒要 `/1000`、`MAX_SUPPORTED_DB_SCHEMA_VERSION = 17` 的版本上限告警——这些不是修一次就完的 bug，而是**持续打补丁的承诺**，每升一个大版本维护者都得回来对这张表。**矛盾的两头**是不依赖浏览器进程与浏览器持续变更存储格式——把变更追踪的负担从运行时挪到维护期，是所有直接读第三方私有格式的工具都会撞上的代价。

### 多密钥 + 空口令兜底换「用户无需配置密钥环」，代价是命中靠启发式

Linux 上 Chromium 的 cookie 主密钥来自桌面环境的密钥环（KWallet / GNOME keyring / 纯文本三选一）。解密时一个反直觉的设计是：**初始化时同时派生两把候选密钥**——一把来自固定口令 `peanuts`，一把来自空口令——然后把两把都喂进 `_decrypt_aes_cbc_multi` 逐一尝试，以「能否 UTF-8 解码」作为命中判据。

换来的能力是用户无需告知「我用的是哪个密钥环」：就算 Chromium 主密钥解不出来，回落到空口令派生密钥常常也能解开大部分 cookie（很多发行版的 Chromium 在没设密钥环密码时就是用空口令加密的）。配合「探测桌面环境决定密钥环后端」，整个 Linux 提取链对用户完全透明。

代价有二：一是命中靠**启发式**——「能 UTF-8 解码」并不严格等价于「密钥正确」，理论上存在密钥错误但恰好解出合法 UTF-8 的极小概率误判；二是「探测桌面环境」读 `XDG_CURRENT_DESKTOP` / `DESKTOP_SESSION` 等环境变量，本身脆弱——用户可用 `--keyring` 参数强制覆盖探测，但这就要求用户知道自己在用什么密钥环，又把成本退回给了用户。**底层对立**是「自动适配」与「Linux 桌面生态碎片化」——多候选 + 启发式兜底是处理碎片化生态的通用招法。

## 5. 最小原理演示

下面这段 TS 演示**只演透三件事**：来源分派（统一产物 + 路由）、版本前缀 + 多密钥兜底（解密思路抽象）、按域注入（核心思想最后一公里）。**真实 OS 密钥环解密**（DPAPI / keychain / secretstorage / KWallet D-Bus）强依赖原生系统调用，TS 讲不透，留作 §6 文字执行轨迹；这里用 mock 占位。

```ts
type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
};

type BrowserName = 'firefox' | 'safari' | 'chrome' | 'edge' | 'brave';

// 统一产物：所有来源最终都进同一个 jar
class CookieJar {
  private cookies: Cookie[] = [];
  setCookie(c: Cookie) { this.cookies.push(c); }

  // 按域注入：host 后缀匹配命中的 cookie 拼成请求头
  getCookieHeader(url: { host: string; path: string }): string {
    return this.cookies
      .filter(
        (c) =>
          url.host.endsWith(c.domain.replace(/^\./, '')) &&
          url.path.startsWith(c.path),
      )
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
}

// 来源分派入口：按浏览器名路由到对应提取器
function extractFromBrowser(name: BrowserName): CookieJar {
  if (name === 'firefox') return extractFirefox();
  if (name === 'safari') return extractSafari();
  return extractChromiumBased(name); // chrome / edge / brave 共用同一条提取链
}

// Chromium 系：按 OS 选解密器，逐行解密后装入统一 jar
function extractChromiumBased(name: BrowserName): CookieJar {
  const jar = new CookieJar();
  const decryptor = pickDecryptor(process.platform); // linux / darwin / win32
  for (const row of mockChromiumEncryptedRows(name)) {
    if (row.value) { jar.setCookie(row); continue; }   // 少数明文条目直接装
    const plain = decryptor.decrypt(row.encrypted_value!);
    if (plain === null) continue;                      // 解不出就跳过，不中断整批
    jar.setCookie({ ...row, value: plain });
  }
  return jar;
}

interface Decryptor { decrypt(blob: Buffer): string | null }

// Linux 解密器：版本前缀分派 + 多密钥兜底
class LinuxChromiumDecryptor implements Decryptor {
  private v10Key = pbkdf2('peanuts', 'saltysalt', 1, 16);
  private emptyKey = pbkdf2('', 'saltysalt', 1, 16);

  decrypt(blob: Buffer): string | null {
    const version = blob.subarray(0, 3).toString('ascii');
    const ciphertext = blob.subarray(3);
    if (version !== 'v10') return null;                // 未知版本前缀直接放弃
    for (const key of [this.v10Key, this.emptyKey]) {  // 两把候选密钥逐一尝试
      const plain = aesCbcDecrypt(ciphertext, key);
      try { return plain.toString('utf8'); }           // 能 UTF-8 解码即视为命中
      catch { /* 这把不对，换下一把 */ }
    }
    return null;
  }
}

function pickDecryptor(platform: string): Decryptor { /* 省略 Mac/Win 分派 */ }

// 顶层装配：多来源合并进同一个 jar
function loadCookies(spec: { file?: string; browser?: BrowserName }): CookieJar {
  const jars: CookieJar[] = [];
  if (spec.file) jars.push(extractFromNetscapeFile(spec.file));
  if (spec.browser) jars.push(extractFromBrowser(spec.browser));
  return mergeJars(jars);                               // 合并成唯一返回容器
}

// 演示按域注入：用户在浏览器里登过 youtube
const jar = loadCookies({ browser: 'chrome' });
const header = jar.getCookieHeader({ host: 'www.youtube.com', path: '/watch' });
// → "SID=...; LOGIN_INFO=...; VISITOR_INFO=..." 交给中立 Request 当 Cookie 头
```

每个块对应一个原理点：`CookieJar` 是统一产物；`extractFromBrowser` 是来源分派入口；`LinuxChromiumDecryptor.decrypt` 实现版本前缀分派 + 多密钥兜底；`getCookieHeader` 落实按域注入。**绕锁、OS 密钥环调用、Safari 二进制解析**全用 mock / 省略号带过——它们是工程细节，不是原理。

## 6. 执行轨迹

拿一个具体输入走一遍：用户在 Windows 上跑 `--cookies-from-browser chrome`，要下载一个登录后才能看的 YouTube 视频。

1. **顶层装配**：`load_cookies(cookie_file=None, browser_specification=('chrome',))` 进入 `extract_cookies_from_browser('chrome', ...)`。
2. **来源分派**：`chrome` ∈ `CHROMIUM_BASED_BROWSERS` → 进入 `_extract_chrome_cookies`。
3. **定位存储**：按 Windows 约定找到 `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Network\Cookies`。
4. **绕锁**：`_open_database_copy` 把这个 SQLite 库 `shutil.copy` 到临时目录，对副本 `sqlite3.connect`——浏览器此刻可能正开着、原始库被锁，但副本不受影响。
5. **取主密钥**：读同目录 `Local State` JSON 里的 `os_crypt.encrypted_key`，base64 解码、校验 `DPAPI` 前缀，调 Windows DPAPI `CryptUnprotectData` 解出 AES-GCM 主密钥（32 字节）。
6. **按 OS 选解密器**：`get_cookie_decryptor('win32', ...)` 返回 `WindowsChromeCookieDecryptor`，持上一步的主密钥；同时读 `meta.version` 决定后续是否砍 32 字节哈希前缀。
7. **逐行解密 cookie 表**：`SELECT host_key, name, path, encrypted_value, expires_utc, ... FROM cookies` —— 对每行：
   - 加密判定：明文 `value` 为空且 `encrypted_value` 非空 → 是加密的。
   - 取 `encrypted_value[:3]` = `b'v10'` → 进入 AES-GCM 路径。
   - 切出 nonce（前 12 字节）与认证 tag（末 16 字节），用主密钥解出明文。
   - 检查 `meta.version >= 24`：若是，砍掉明文前 32 字节哈希前缀。
   - 解出明文 `value`（如 `SID=xxxxxxxx`）→ `jar.set_cookie(...)`。
8. **装入统一容器**：所有解出的 cookie 进同一个 `YoutubeDLCookieJar`。
9. **请求注入**：下载流程要请求 `https://www.youtube.com/watch?v=xxxx` → `jar.get_cookie_header(url)` 内部构造一个 urllib `Request` 载体、调 `add_cookie_header` 让标准库按域名匹配填好头、取出 `Cookie` 头（如 `SID=...; LOGIN_INFO=...; VISITOR_INFO=...`）→ 这串头被第 1 章那个中立的 `Request` 对象收下，由具体传输后端发出去。

闭环是「探测 → 定位 → 绕锁 → 解密 → 装入 → 注入」，每一步都对应核心思想里的一环。

## 7. 教学简化说明

本章演示故意省略了：真实 OS 密钥环解密链（Windows DPAPI 的 `CryptUnprotectData`、macOS keychain 的 `security find-generic-password`、Linux 上 KWallet 的 `dbus-send` + `kwallet-query` 和 GNOME 的 `secretstorage` D-Bus 调用）、Safari `Cookies.binarycookies` 的字节级四层解析器（header / page / record）、PBKDF2 / AES-CBC / AES-GCM 的密码学实现、Netscape `cookies.txt` 7 列格式与 `#HttpOnly_` 前缀、宽泛 Set-Cookie 解析器的字符级容错、Firefox `originAttributes` 容器筛选与 schema 16 毫秒 expiry 的兼容分支、多 profile 取最新 `st_mtime` 的细节。这些是工程脚手架，不是原理。

## 8. 小结

用户只看到「我在浏览器里登过」，主流程只看到一个统一容器——背后那张浏览器×OS 适配器矩阵和那一堆随版本脆裂的逆向常量，就是这个简洁对外接口要持续付的代价。下一章会看到，这个容器被 `YoutubeDL` 编排器收编，和 urlopen 门面、进度钩子、归档去重等横切关注点一起，由编排器塞进每一个发出的请求。
