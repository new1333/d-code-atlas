# 知乎 JSON API 写操作客户端 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在编辑器里对知乎内容做"赞同、收藏、关注、不感兴趣"这类**改变服务器状态**的动作时，若走"开浏览器→等渲染→模拟点击"的爬页面路线，每次都要启动一台真实 Chrome、烧一份 Cookie、等几秒——而知乎网页前端发这些动作时，本身就只是一次带 Cookie 的 JSON 请求。用重型渲染管线去发一个本就是一次 HTTP 的动作，是纯粹的浪费。

- **一句话核心思想**：**写操作不爬页面，而是把自己伪装成知乎前端，直接复刻它本该发出的那条 XHR**。

- **设计动机（为什么需要它）**：写动作天然没有"需要渲染的内容"，它只是一个状态翻转。把它从"通过浏览器间接操作"降级为"直接重放前端的 API 调用"，换来的是极轻、极快、不烧 Cookie。其中"承前"部分：发请求所需的凭证，是**前置章（第 2 章『Cookie 凭证的清洗与校验』）在写入时就已经清洗（去第三方统计项）、校验（签名 + 登录凭证）、去重定向项后存好的纯净字符串**——本章只把这个字符串原样塞进请求头，不再重复清洗/校验逻辑（已在第 2 章讲透，本章只看它"作为请求头一部分被发出"这个新侧面）。

- **关键权衡（本 Atlas 的核心）**：
  1. **选择"重放前端 XHR（伪造一整套浏览器请求头 + Cookie）"而非"用真实浏览器操作页面" → 换来写操作极轻量（一次 HTTP，无浏览器开销、几乎不烧 Cookie）→ 代价是必须手工伪造完整的浏览器指纹请求头（客户端提示头三件套、用户代理、来源页、同站标记等），任何一个头缺失或不一致都可能被反爬识别为非浏览器流量。** 这是全章灵魂权衡。
  2. **选择"把十几个写操作全部做成无状态的静态方法、共用同一个请求出口" → 换来所有操作的请求构造、凭证拼装、HTTP 层错误处理在一处统一 → 代价是这些方法隐式依赖全局共享的 Cookie（而非显式传参），且失去了按操作类型定制重试/限流策略的余地。**
  3. **选择"请求构造层彻底统一，但业务成功判定层刻意分裂"——收藏/不喜欢这类 UI 只需要"成败"二元信号的操作，内部把异常吞掉、只回布尔；而投票/关注这类 UI 需要拿到完整返回体（如最新投票态）的操作，则把异常原样上抛 → 换来每种操作按其界面语义选最省事的错误传播方式 → 代价是调用方必须记住每个方法的契约（有的返布尔、有的返对象、有的抛异常），不能无脑统一处理。** 这条划出了"该统一"与"该不统一"的分界线，是教学价值最高的一条。

- **最小心智模型（3～7 步）**：
  1. 用户在某个界面（详情页/侧边栏/命令）触发一个写动作，如"赞同这条回答"。
  2. 客户端里对应的写方法把这个动作翻译成知乎 JSON API 的三要素：接口地址、HTTP 方法（增/删）、请求体。
  3. 三要素连同一个人可读的"操作名"一起交给统一的请求出口。
  4. 出口先从凭证管理器拿到前置章已清洗好的 Cookie；若为空，弹错误提示并中断。
  5. 出口用请求头工厂拼出一整套"假装我是浏览器发的 XHR"的请求头，把 Cookie 与内容类型塞进去。
  6. 发起一次请求；删除类请求通常没有响应体，直接判成功，其余解析 JSON。
  7. HTTP 层失败统一抛出；业务层再按各自契约决定"吞掉返 false"还是"上抛给界面"。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个**小到只表达"重放前端 XHR + 统一出口"**的从零实现（几十行）。核心三件套——(a) 一个请求头工厂，产出一套伪造的浏览器指纹头并按需挂内容类型；(b) 一个统一请求出口，负责取凭证→拼头→发请求→删除特判/其余解析 JSON→HTTP 失败抛出；(c) 两个示例写操作（一个走"吞异常返布尔"、一个走"原样抛出"），演透权衡 3 的分裂。**每一段都要对应上面某条权衡**：头工厂 ↔ 权衡 1，统一出口 ↔ 权衡 2，两个操作的错误处理差异 ↔ 权衡 3。
  - 应故意省略：十几个端点的完整罗列、收藏夹多级树、详情页集成、编辑器弹窗（用控制台打印代替即可）、凭证清洗逻辑（那是前置章）、类型边角与魔法数字对照表。
  - **演示载体建议**：本仓库主语言是 TypeScript，且本章机制**不依赖 VSCode 宿主**（它只是发 HTTP），建议写成一段能被 `node`/`bun` 直接跑的独立脚本：用本地一个 mock server 接收请求、打印收到的全部请求头，让读者**亲眼看到"伪造的头集长什么样、Cookie 是怎么被塞进去的"**——比真连知乎更安全且更聚焦原理。无需启动扩展宿主。

- **正文不宜展开的细节**：
  - 十几个 API 端点 URL 模板的逐一对照（投票/收藏/关注/不喜欢各自的路径差异）——这是查表内容，不是原理。
  - "内容类型"在知乎不同接口里有两套编码：数字（文章=2、问题=1、想法=15）与字符串（answer/article/pin）并存，调用方需自行对齐——提一句即可，不必铺开对照表。
  - 用户代理里具体的浏览器版本号——会随时间过时。
  - 创建/删除收藏夹返回的是结构体 {success, ...} 而非纯布尔，与其余方法不同——属历史契约差异，点到即止。

- **推荐的一个执行轨迹例子**：输入——用户在详情页点"赞同回答 X" → 客户端把它翻译成"向知乎投票接口发一个 POST、请求体标记为赞同" → 统一出口拿到已清洗 Cookie、拼好整套浏览器指纹头并塞入 Cookie → 发出请求，返回带最新投票态的 JSON → 该写方法**不吞异常、原样返回**这个对象，供详情页刷新投票按钮状态。输出——回答的投票态翻转。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- 整个客户端是一个**纯静态方法类、无实例状态**，所有写操作都不需实例化即可调用，隐式依赖全局 Store 里那份已清洗的 Cookie。源码位置: src/core/zhihu/api/index.ts:16
- 请求头工厂集中产出"伪装成浏览器同源 XHR"的完整头集：客户端提示头三件套（Sec-Ch-Ua / Sec-Ch-Ua-Mobile / Sec-Ch-Ua-Platform）、User-Agent、Origin、Referer、Sec-Fetch-* 系列、X-Requested-With，并按需追加 Content-Type。源码位置: src/core/zhihu/api/index.ts:20-51
- 唯一的请求出口承担四件事：取 Cookie（空则弹错并抛异常）→ 拼头 → 发请求 → 删除类特判成功 / 其余解析 JSON；HTTP 非 2xx 统一抛出。源码位置: src/core/zhihu/api/index.ts:56-99
- Cookie 直接取自前置章凭证管理器（返回 Store 里那份字符串），**本章不再做任何清洗或关键项校验**——清洗（去第三方统计）、校验（__zse_ck + z_c0）、去 BEC 全在第 2 章写入时完成。源码位置: src/core/zhihu/api/index.ts:62 与 src/core/zhihu/cookie/index.ts:132-134,177-180,211-266
- ⚠️ 边界事实（与 outline summary 字面"Cookie 校验统一收敛到请求出口"有出入）：请求出口**只校验 Cookie 是否非空**，并未在此处校验 __zse_ck / z_c0 是否齐全；真正的完整性校验发生在凭证管理器的 loadCookie/setCookie 阶段。源码位置: src/core/zhihu/api/index.ts:62-70 对照 src/core/zhihu/cookie/index.ts:41-65,177-180
- **业务成功判定策略不统一**，分三类契约：(a) 收藏/不喜欢类——内部 try/catch 吞异常、返回布尔；(b) 投票/关注/评论点赞/想法点赞类——原样返回对象、异常上抛；(c) 创建/删除收藏夹类——返回 {success, error?, collection?} 结构体、异常转为 {success:false}。源码位置: src/core/zhihu/api/index.ts:137-140,242-245（a 类）；:364-367,449-452（b 类）；:308-311,334-337（c 类）
- 删除类请求的容错：DELETE 通常无响应体，命中 response.ok 即直接返回 {success:true}，不尝试解析 JSON。源码位置: src/core/zhihu/api/index.ts:81-85
- "点赞/取消点赞"用 HTTP 方法翻转来表达（true→POST，false→DELETE），而非两个独立方法。源码位置: src/core/zhihu/api/index.ts:411,491
- 内容类型存在两套编码并存：推荐反馈类用数字字面量 1|2|15，收藏类用字符串 "answer"|"article"|"pin"。源码位置: src/core/zhihu/api/index.ts:109 与 :196,227,258
- 写操作客户端被三层复用：详情页（投票/关注/评论点赞/收藏）、侧边栏列表（不喜欢/收藏）、命令层（收藏夹增删）。说明它是一个跨界面共享的写操作底座。源码位置（调用方）: src/core/zhihu/webview/index.ts:3546,4194,3693,3225；src/core/zhihu/sidebar/recommend.ts:495,599；src/core/commands/collection.ts:300,477,596；src/core/utils/collection-picker.ts:59

## 关键调用链
界面动作（webview / 侧边栏 / 命令）→ 客户端写方法（构造 URL+方法+体，附操作名）→ 统一请求出口（取 Cookie → 请求头工厂拼头 → 发请求）→ 删除特判成功 / 其余 response.json() → HTTP 失败抛出 → 业务层按契约决定吞掉返 false 或上抛
源码位置: src/core/zhihu/api/index.ts:56-99（出口主干），各写方法 :107-509

## 源码摘录（带行号，全文累计 ≤ 30 行）
请求头工厂——伪造的浏览器同源 XHR 头集（支撑权衡 1）：
```ts
// src/core/zhihu/api/index.ts:24-48
const headers: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  Cookie: cookie,
  Origin: "https://www.zhihu.com",
  Referer: "https://www.zhihu.com/",
  "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...Chrome/122.0.6261.95...",
  "X-Requested-With": "XMLHttpRequest",
};
if (contentType) { headers["Content-Type"] = contentType; }
```
统一出口——取 Cookie + 删除特判（支撑权衡 2 与边界点）：
```ts
// src/core/zhihu/api/index.ts:62-89
const cookie = CookieManager.getCookie();
if (!cookie) {
  vscode.window.showErrorMessage(`需要设置知乎Cookie才能使用${operationName}功能`);
  throw new Error(`没有设置Cookie，无法${operationName}`);
}
const response = await fetch(url, {
  method: options.method,
  headers: this.getCommonHeaders(cookie, options.contentType),
  body: options.body,
});
if (response.ok) {
  if (options.method === "DELETE") { return { success: true }; }  // 无响应体，直接判成功
  const result = await response.json();
  return result;
} else {
  throw new Error(`${operationName}HTTP错误: ${response.status}`);
}
```

## 易混淆 / 边界 / 推断
- **事实**：outline summary 称"Cookie 校验统一收敛到一个请求出口"，但源码事实是出口仅校验 Cookie 非空；__zse_ck/z_c0 完整性校验在凭证管理器（前置章）的写入阶段。Writer 若照 summary 字面写会出错，应以本事实为准。
- **事实**：业务成功判定分三类契约（吞异常返布尔 / 原样抛 / 返结构体），并不统一——这是与"请求构造层统一"并存的刻意分裂。
- **推断（标注为推断）**：投票/关注类原样抛异常、返回完整对象，是因为详情页 UI 需依据返回体刷新投票态/关注态；收藏/不喜欢类只需成败信号，故吞异常返布尔以简化界面分支。依据是两类操作的调用语义与返回字段差异，源码无显式注释。
- **推断（标注为推断）**：本章伪造头里的用户代理/客户端提示头版本（Chrome 122）与第 3 章"防反爬浏览器引擎"所用的真实 Chrome 指纹同款，推测是为了让"走 JSON API 的写操作"与"走页面渲染的读操作"在服务端呈现**同一幅浏览器画像**，避免同一会话内指纹跳变。本章未显式声明这一关联，仅基于两章同版本号推断。
- **推断（标注为推断）**：选用宿主环境自带的全局 fetch 而非引入 HTTP 库，是为零依赖、贴合扩展轻量化。
- **未理解**：收藏操作的 POST 把 content_id/content_type 放在 URL 查询串（src/core/zhihu/api/index.ts:230），而创建收藏夹的 POST 用 JSON 请求体（:293）；源码无注释，推测是知乎不同端点的历史设计差异，无法从本仓库确认。