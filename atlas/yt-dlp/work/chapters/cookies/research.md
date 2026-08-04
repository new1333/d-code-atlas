# 统一 cookiejar：从浏览器密钥环解密登录态 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：很多站点（YouTube、B 站、会员制视频站）必须登录后才能拿到完整视频源；让用户去浏览器里手动导出 cookies.txt 既繁琐又容易过期。理想体验是「我在浏览器里已经登录了，下载工具直接复用这份登录态」。问题在于：登录态被浏览器加密锁在各自的私有存储里，格式还因浏览器和操作系统而异——这是一道「跨私有存储格式 + 跨 OS 加密方案」的还原难题。

- **一句话核心思想**：**来源异构、产物统一、按域注入**——无论登录态来自 Netscape 文件、Firefox 明文库、Safari 自有二进制格式，还是被 Chromium 各 OS 密钥环加密的密文库，最终都坍缩成同一套标准 Cookie 集合，再按请求的域名匹配注入。

- **设计动机（为什么需要它）**：为了让调用方（下载主流程）只认一个「cookie 容器」，而不必关心登录态的来源。换来的能力是「一处抽取、全网复用登录态」。其中与前置章的衔接关系是：**（已在第 1 章『可插拔传输层』讲透 Request/Response 是传输中立对象 + 多后端竞争，本章只看 cookie 这一横切关注点如何被统一装配、再注入到任意传输的请求里）**——本章产出的 cookie 容器正是挂在那个中立请求管线上的一个共享附件，原理侧重点完全不同，不会重复。

- **关键权衡（本 Atlas 的核心，4 条）**：
  1. **统一产物 + 来源分派入口** → 换来「主流程只对着一个 cookie 容器说话，不关心登录态来自文件还是浏览器」 → 代价是要为「浏览器 × 操作系统」维护一整张异构的提取/解密适配器矩阵（Firefox / Safari / Chromium-系，且 Chromium 还要再按 Linux/Mac/Windows 三套密钥方案）。
  2. **把数据库复制到临时目录再读** → 换来「浏览器正开着、数据库被锁也能读 cookie，用户无需关闭浏览器」 → 代价是每次要复制整个 SQLite 库的 I/O 开销，以及临时文件的生命周期管理。
  3. **解密常量靠逆向硬编码 + 多密钥/空口令兜底** → 换来「完全不依赖浏览器自身 API，纯文件层 + 系统密钥环 API 就能还原明文 cookie」 → 代价是这些常量（加密版本前缀、派生盐值、迭代次数、密钥前缀）随浏览器版本升级极易碎裂，需要持续跟进 schema/版本/前缀的变更并加版本号分支。
  4. **探测桌面环境再决定密钥环后端** → 换来「Linux 上自动适配 KDE/GNOME/纯文本三种密钥存储」 → 代价是探测逻辑依赖环境变量、很脆弱，且浏览器可用命令行参数强制指定密钥存储从而绕过探测（此时需用户手动告知用哪个密钥环）。

- **最小心智模型（3～7 步）**：
  1. 主流程说「我要登录态」，传入一个来源描述（浏览器名 + 可选 profile/容器/密钥环），或一个 cookie 文件路径。
  2. 顶层装配函数把「浏览器来源」和「文件来源」各自抽成一个 cookie 容器，再**合并**成一个统一容器返回。
  3. 「浏览器来源」走一个**分派入口**：按浏览器名路由到对应的提取器（Firefox / Safari / Chromium-系）。
  4. 每个 Chromium-系提取器内部再按**操作系统**选一个**解密器**（Linux / Mac / Windows 三套）。
  5. 提取器定位到浏览器的 cookie 存储文件，**复制到临时目录**打开（绕过浏览器锁），逐行读出每条 cookie 记录。
  6. 若记录是加密的（明文 value 为空且有密文），交给解密器：按**密文前 3 字节的版本前缀**选解密路径，必要时用**多个候选密钥/空口令兜底**尝试，解出明文。
  7. 所有 cookie 装进统一容器；之后任意请求 URL，容器按域名匹配出适用 cookie，拼成 `Cookie:` 请求头注入。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个几十行的小骨架，演透「来源异构 → 产物统一 → 按域注入」三件事。具体：(a) 一个统一的 `CookieJar` 类，提供 `setCookie` / `getCookieHeader(url, hostMatches)`；(b) 多个 `BrowserExtractor`（如 firefoxExtractor / chromeExtractor）各自实现 `extract()`，内部对一个**简化 mock 的 `decrypt(blob)`** 返回明文（不演真实密钥环）；(c) 一个 `loadCookies({browser, file})` 把多来源结果合并进同一个 jar；(d) 最后对某 URL 调 `getCookieHeader`，演示按 host 后缀匹配命中 cookie 的注入过程。**这段演示演的是权衡 1（统一产物+分派）+ 权衡 2 的「绕锁」可仅用注释带过**。
  - **应故意省略**：真实 OS 密钥环解密链（Windows 系统数据保护 API、macOS keychain 命令、Linux KWallet/secretstorage 的 D-Bus 调用）、Safari 自有二进制格式的字节级解析器、逆向得来的密码学常量（派生盐值、迭代次数、版本前缀）、宽泛 Set-Cookie 解析的字符级容错、Netscape 文件格式的 session cookie 互转细节。
  - **演示载体建议（Writer 据此执行）**：**首选 TS/JS**。理由：本章要教的原理是「来源异构→产物统一→按域注入」的**抽象骨架**与「版本前缀分派 + 多密钥兜底」的**容错思路**，这两者与具体 OS 原生 API 无关，TS/JS 完全能忠实演透，且对本 Atlas 的 JS 生态读者最友好（配最小 `package.json` 可 `node`/`bun run` 跑）。**只有「真实 OS 密钥环解密」这一面 TS/JS 讲不透**——它强依赖 Windows/macOS/Linux 的原生系统调用与 D-Bus，离了宿主运行时就不成立——所以这部分退回原仓库 Python 语言、在正文以「机制骨架 + 文字执行轨迹」呈现即可，演示骨架里用 mock 解密占位。一句话原则：**载体服务于演透原理；抽象骨架用 TS/JS，原生解密链留作文字讲解。**

- **正文不宜展开的细节**：Chromium 各浏览器在 Windows/macOS/Linux 上的目录路径差异表、Linux 桌面环境探测的各分支映射（KDE3/4/5/6、GNOME、XFCE…）、Netscape cookies.txt 的 7 列格式与 `#HttpOnly_` 前缀、宽泛 Set-Cookie 解析器的正则细节与控制字符守卫（Python 3.14+ 兼容）、容器（Firefox container）的 `originAttributes` 筛选、进度条/`only_once` 日志这些工程化脚手架。这些供抽查，不进原理主线。

- **推荐的一个执行轨迹例子**：输入 `--cookies-from-browser chrome`（Windows 上）→ 探测平台 = Windows → 选 Windows 解密器 → 定位到用户数据目录下的 Cookies 库 → 复制到临时目录打开（绕过浏览器锁）→ 读元数据版本号、读配置文件里的加密主密钥、用系统数据保护 API 解出 AES-GCM 主密钥 → 逐行：密文前 3 字节判定为版本 v10 → 切出 nonce 与认证 tag → AES-GCM 解密得明文 cookie → 装入统一容器 → 之后请求 `https://host/path` 时，容器按域名匹配命中该 cookie → 输出 `Cookie: name=value` 注入请求头。这条轨迹演的是「探测→定位→绕锁→解密→注入」的核心思想闭环，不是演全量调用。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **统一装配入口**：`load_cookies(cookie_file, browser_specification, ydl)` 是对外的总入口——同时接受「文件来源」和「浏览器来源」，各自产出 cookiejar 后用 `_merge_cookie_jars` 合并成**唯一**返回容器；任何异常都被包成 `CookieLoadError`（统一错误出口）。源码位置: yt_dlp/cookies.py:93-113
- **浏览器来源的分派器**：`extract_cookies_from_browser(browser_name, ...)` 按 browser_name 三分派——firefox → `_extract_firefox_cookies`、safari → `_extract_safari_cookies`、其余 Chromium 系（brave/chrome/chromium/edge/opera/vivaldi/whale）→ `_extract_chrome_cookies`；未知浏览器抛 `ValueError`。源码位置: yt_dlp/cookies.py:49-50, 116-124
- **统一产物**：所有提取器最终都把 cookie 塞进同一个 `YoutubeDLCookieJar`（继承自 `http.cookiejar.MozillaCookieJar`），由它统一负责文件读写与按 URL 注入。源码位置: yt_dlp/cookies.py:1276-1296
- **绕过浏览器锁**：`_open_database_copy` 把 SQLite 库**复制**到临时目录再 `sqlite3.connect`，原因写在注释里——浏览器正运行时数据库被占用、无法直接打开。源码位置: yt_dlp/cookies.py:1112-1117
- **加密判定与委托**：`_process_chrome_cookie` 用「明文 value 为空 且 存在 encrypted_value」判定该条 cookie 是加密的，加密则调 `decryptor.decrypt(encrypted_value)`；解出 None 则该条作废。源码位置: yt_dlp/cookies.py:372-393
- **按 OS 选解密器**：`get_cookie_decryptor` 按平台返回三种 `ChromeCookieDecryptor` 子类——Mac / Windows / Linux，各自实现自己的 `decrypt`。基类 docstring 完整记录了三套方案的差异（Linux=v10/v11 + keyring；Mac=v10 keychain 或明文；Windows=v10 AES-GCM 或系统数据保护 API）。源码位置: yt_dlp/cookies.py:396-422, 430-435
- **版本前缀分派**：三个解密器都先取 `encrypted_value[:3]` 作为版本前缀（如 `b'v10'`/`b'v11'`），剩余字节才是密文；不同前缀走不同解密路径，未知前缀告警并跳过。源码位置: yt_dlp/cookies.py:470-471, 509-510, 536-537
- **多密钥 / 空口令兜底**：Linux 解密器在初始化时同时算出「固定口令派生的密钥」与「空口令派生的密钥」两把；解密时把两把候选密钥都喂给 `_decrypt_aes_cbc_multi` 逐一尝试，以「能否 UTF-8 解码」作为命中判据——这是模拟 Chromium 自身在主密钥失败后回落到空口令的行为。源码位置: yt_dlp/cookies.py:441-442, 459-491, 1044-1054
- **密码学派生差异**：Linux 与 Mac 都用 PBKDF2-SHA1、盐 `b'saltysalt'`、16 字节密钥，但 Linux 迭代 1 次、Mac 迭代 1003 次；Windows 的 v10 主密钥则是 AES-GCM，主密钥本身存在配置文件 `os_crypt.encrypted_key` 里、经系统数据保护 API 解出。源码位置: yt_dlp/cookies.py:453-457, 502-506, 1013-1037
- **版本号分支（脆裂点）**：从 cookie 库的 `meta.version` 读取 Chromium 元数据版本；当 `meta_version >= 24` 时，解密后的明文要砍掉前 32 字节哈希前缀（App-Bound Encryption 后续变更），三套解密器都据此传 `hash_prefix` 开关。源码位置: yt_dlp/cookies.py:326-331, 477, 486, 519, 559
- **Linux 密钥环探测**：`_choose_linux_keyring` 先用 `_get_linux_desktop_environment`（读 XDG_CURRENT_DESKTOP / DESKTOP_SESSION 等环境变量）判断桌面环境，再映射到 KWallet / GNOME keyring / 纯文本三类密钥环；用户也可手动 `--keyring` 强制指定以覆盖自动探测。源码位置: yt_dlp/cookies.py:775-871, 975-992
- **三种密钥环取密钥路径各异**：KWallet 走 `dbus-send` 查网络钱包名 + `kwallet-query` 读密码；GNOME 走 `secretstorage`（D-Bus）遍历 collection 找 `XXX Safe Storage`；纯文本则表示浏览器把 cookie 存成不需密钥环的格式、返回 None。源码位置: yt_dlp/cookies.py:874-972
- **Windows 密钥环**：`_get_windows_v10_key` 读 `Local State` JSON 的 `os_crypt.encrypted_key`，base64 解码后校验 `DPAPI` 前缀，再调 `_decrypt_windows_dpapi`（ctypes 调 `crypt32.CryptUnprotectData`）解出 AES-GCM 主密钥。源码位置: yt_dlp/cookies.py:1013-1105
- **macOS 密钥环**：`_get_mac_keyring_password` 调系统 `security find-generic-password -w` 按 account/service 取出浏览器 Safe Storage 口令。源码位置: yt_dlp/cookies.py:995-1010
- **Firefox 走明文、但要处理容器与 schema**：Firefox 的 `moz_cookies` 表是明文、无需解密；但支持按容器筛选（`originAttributes LIKE '%userContextId=N'`），且 FF142+（schema 16 起）expiry 改用毫秒、需 `/1000`；同时设了 `MAX_SUPPORTED_DB_SCHEMA_VERSION = 17` 的版本上限告警。源码位置: yt_dlp/cookies.py:127-200
- **Safari 是自有二进制格式**：`Cookies.binarycookies` 不是 SQLite，故手写 `DataParser`（read_bytes/expect_bytes/read_uint/read_double/read_cstring/skip_to）逐字节解析 header('cook' 签名 + 各 page 大小) → page → record 四层结构；记录里 domain/name/path/value 各自带 offset、要跳位读取。源码位置: yt_dlp/cookies.py:568-737
- **宽泛 Set-Cookie 解析器**：`LenientSimpleCookie` 继承 `http.cookies.SimpleCookie`，放宽合法 key/value 字符集、加 `bad` fallback 组吞掉畸形值，并加控制字符守卫以兼容 Python 3.14+ Morsel 抛错的新行为——目标是不让站点下发的畸形 Set-Cookie 直接中断解析。源码位置: yt_dlp/cookies.py:1165-1273
- **session cookie 的格式互转**：Netscape 格式里 expires 为空串或 0 都表 session cookie，但标准库 `MozillaCookieJar` 只认空串；故加载后手动把 `expires==0` 的转成 `discard=True`，保存时反向把 None expires 设成 0。源码位置: yt_dlp/cookies.py:1345-1348, 1390-1403
- **按 URL 注入的取巧**：`get_cookie_header(url)` 构造一个 `urllib.request.Request(normalize_url(sanitize_url(url)))` 当载体，调标准库 `add_cookie_header` 让 cookiejar 按域名匹配填好 header，再把 `Cookie` 头取出来——即「借标准库的匹配逻辑、只用它的输出」。源码位置: yt_dlp/cookies.py:1405-1416
- **多 profile 取最新**：`_find_files` 遍历目录找 `Cookies`，`_newest` 按 `st_mtime` 取最近修改的那个 profile——多 profile 用户取最常用的那个。源码位置: yt_dlp/cookies.py:1125-1138

## 关键调用链

主装配链：
`load_cookies(cookie_file, browser_spec, ydl)` → `_parse_browser_specification` → `extract_cookies_from_browser` →（分派）`_extract_{firefox|safari|chrome}_cookies` → 各自 `YoutubeDLCookieJar().set_cookie(...)` → `_merge_cookie_jars` → 返回统一 jar。源码位置: yt_dlp/cookies.py:93-124, 1141-1148

Chromium 解密链（核心）：
`_extract_chrome_cookies` → `_open_database_copy`（复制绕锁）→ `cursor.execute(SELECT ... encrypted_value ...)` → 读 `meta.version` → `get_cookie_decryptor`（按 OS 选解密器）→ 逐行 `_process_chrome_cookie` →（加密则）`Linux/Mac/WindowsChromeCookieDecryptor.decrypt` →（版本前缀分派）`_decrypt_aes_cbc_multi` / `_decrypt_aes_gcm` / `_decrypt_windows_dpapi` → 明文 value → `jar.set_cookie`。源码位置: yt_dlp/cookies.py:294-360, 372-393, 459-565

密钥来源链（OS 各异）：
- Linux：`_get_linux_keyring_password` → `_choose_linux_keyring`（探测桌面环境）→ `_get_kwallet_password`(dbus-send + kwallet-query) / `_get_gnome_keyring_password`(secretstorage) / None(纯文本)。源码位置: yt_dlp/cookies.py:775-992
- Windows：`_get_windows_v10_key`（Local State JSON → base64 → DPAPI 前缀校验 → `_decrypt_windows_dpapi`）。源码位置: yt_dlp/cookies.py:1013-1037, 1073-1105
- Mac：`_get_mac_keyring_password`（security find-generic-password）。源码位置: yt_dlp/cookies.py:995-1010

请求注入链：
某 URL → `YoutubeDLCookieJar.get_cookie_header(url)` → `urllib.request.Request` 载体 → `self.add_cookie_header(req)` → `req.get_header('Cookie')` →（由 networking 层塞进中立 Request）。源码位置: yt_dlp/cookies.py:1405-1416

## 源码摘录（带行号，全文累计 ≤ 30 行）

来源分派入口（演权衡 1「统一产物 + 来源分派」）：
```python
def extract_cookies_from_browser(browser_name, profile=None, logger=YDLLogger(), *, keyring=None, container=None):
    if browser_name == 'firefox':
        return _extract_firefox_cookies(profile, container, logger)
    elif browser_name == 'safari':
        return _extract_safari_cookies(profile, logger)
    elif browser_name in CHROMIUM_BASED_BROWSERS:
        return _extract_chrome_cookies(browser_name, profile, keyring, logger)
    else:
        raise ValueError(f'unknown browser: {browser_name}')
```
源码位置: yt_dlp/cookies.py:116-124

加密判定 + 委托解密器（演「加密与否 → 委托 OS 解密器」）：
```python
    is_encrypted = not value and encrypted_value

    if is_encrypted:
        value = decryptor.decrypt(encrypted_value)
        if value is None:
            return is_encrypted, None
```
源码位置: yt_dlp/cookies.py:377-382

Linux 解密器：版本前缀分派 + 多密钥/空口令兜底 + meta_version 控制 hash 前缀（演权衡 3、4 与版本脆裂点）：
```python
        version = encrypted_value[:3]
        ciphertext = encrypted_value[3:]

        if version == b'v10':
            self._cookie_counts['v10'] += 1
            return _decrypt_aes_cbc_multi(
                ciphertext, (self._v10_key, self._empty_key), self._logger,
                hash_prefix=self._meta_version >= 24)
```
源码位置: yt_dlp/cookies.py:470-477

数据库复制绕锁（演权衡 2）：
```python
def _open_database_copy(database_path, tmpdir):
    # cannot open sqlite databases if they are already in use (e.g. by the browser)
    database_copy_path = os.path.join(tmpdir, 'temporary.sqlite')
    shutil.copy(database_path, database_copy_path)
    conn = sqlite3.connect(database_copy_path)
    return conn.cursor()
```
源码位置: yt_dlp/cookies.py:1112-1117

## 易混淆 / 边界 / 推断

- **事实**：「v10/v11」是 Chromium os_crypt 写在密文最前 3 字节的版本标签，**不是** Firefox/Safari 的概念；Firefox cookie 是明文、Safari 是自有二进制格式，二者均无此标签。
- **事实**：三个解密器都返回明文或 None；None 表示该条解密失败、会被 `_extract_chrome_cookies` 计入 `failed_cookies` 并跳过，**不会**中断整批提取。
- **事实**：Linux v11 密钥用 `@functools.cached_property` 懒求值（`_v11_key`），只有真正遇到 v11 cookie 才去问 keyring——避免无 v11 cookie 时白跑一次 D-Bus。源码位置: yt_dlp/cookies.py:448-451
- **事实**：`_decrypt_aes_cbc_multi` 把「能否 `.decode()` 成 UTF-8」当作密钥命中判据——这是个**启发式**（注释也承认与 Chromium 官方判定不完全一致），理论上存在密钥错误但恰好解出合法 UTF-8 的极小概率误判。
- **推断**：把数据库复制到临时目录、而非请求用户关闭浏览器，是明确的**用户体验优先**取舍（`_open_database_copy` 注释 + Windows 上 `PermissionError errno 13` 单独给出 issue 链接并强制退出的处理，佐证开发者预期「浏览器可能正开着」）。
- **推断**：`meta_version >= 24` 砍 32 字节哈希前缀、Firefox schema 16 的毫秒 expiry、`MAX_SUPPORTED_DB_SCHEMA_VERSION` 上限告警，三者共同印证了「逆向常量随版本碎裂、必须持续打补丁」这一代价——文件里大量 chromium/firefox commit 链接作为溯源佐证。
- **未理解/未深挖**：Windows DPAPI 调用的 `CryptUnprotectData` 在某些受保护账户（如 App-Bound Encryption v2）下会失败的完整边界条件，代码仅给 issue 链接、未在注释展开；Safari 二进制格式中各 `unknown record field`（被 skip 的字节）的确切语义，代码靠 dtformats 文档逆向、注释标注「out of date」。