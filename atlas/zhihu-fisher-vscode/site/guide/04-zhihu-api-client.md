---
title: 知乎 JSON API 写操作客户端
---

# 知乎 JSON API 写操作客户端

> 本章属于 primitive 层。前置：Cookie 凭证的清洗与校验。
> 学完你能：用一句话讲清「为什么写动作要绕开那台浏览器直接重放 XHR，以及为什么请求构造彻底统一、成功判定却刻意分裂」。

## 1. 为什么需要它（设计动机）

上一章用一台被悄悄伪装过的真 Chrome，把「读」这条路打通了——知乎的内容靠 JS 渲染、靠反爬安检拦机器人，不开真浏览器几乎拿不到。但这台 Chrome 解决的是「读」的难题，留下了一个口子：那「赞同、收藏、关注、不感兴趣」这类**改变服务器状态**的动作，是不是也非得走同一条重路径？

想象一下用户在详情页点了「赞同」。如果走「开浏览器→等渲染→模拟点击」的爬页面路线：要起一台 Chrome、注入 Cookie、导航到回答页、找到按钮、模拟 click，前后几秒钟、还要烧一份 Cookie。但只要你打开浏览器的开发者工具看一眼网络面板就知道：知乎前端发这个动作时，本身就只是一次带 Cookie 的 POST，没什么神秘。用一台 Chrome 去发一个本就是一次 HTTP 的动作，是纯粹的开炮打蚊子。

写动作的尴尬在于它**天然没有需要渲染的内容**——它只是一次状态翻转。把它从「通过浏览器间接操作」降级回「直接重放前端的 API 调用」，就能换来极轻、极快、几乎不烧 Cookie。这就是这一章要解决的核心矛盾：**写动作被错误地塞进了读动作的重型管线，而它本可以只是一次请求**。

承前一句：发这次请求所需的 Cookie 字符串，前置章（第 2 章『Cookie 凭证的清洗与校验』）在写入时就已经清洗掉第三方统计项、校验过关键安全项、移除了会触发重定向的项；本章只把这个字符串原样塞进请求头，**不再重讲清洗/校验/探测那套**，只看它作为「请求头里的一员被发出去」这个新侧面。

## 2. 核心思想

**写操作不爬页面，而是把自己伪装成知乎前端，直接复刻它本该发出的那条 XHR。**

换个角度看：浏览器发一次写动作，本质上是「那行 fetch 代码 + 那台浏览器」的组合体。这一章做的事，就是把这两者**提纯**——只保留「那个请求」本身（含它需要的所有头与 Cookie），扔掉「那台浏览器」的全部开销。读动作没法这么提纯（必须靠渲染），写动作可以，这就是分界线。

## 3. 心智模型

整个客户端是一个**纯静态方法类、没有任何实例状态**：所有写操作都不需要 `new` 就能调，它隐式依赖全局共享的那份已清洗 Cookie。把它的运转拆成一条线：

1. **触发**：用户在某个界面（详情页 / 侧边栏 / 命令）点了一个写动作，例如「赞同这条回答」。
2. **翻译三要素**：对应的写方法把这个动作翻译成知乎 JSON API 的三件事——接口地址、HTTP 方法（POST 增 / DELETE 删）、请求体；同时附一个人可读的「操作名」（如 `"赞同回答"`）。
3. **进入统一出口**：三要素交给全类唯一的请求出口 `makeRequest`。
4. **取凭证**：出口从凭证管理器拿到已清洗好的 Cookie；若为空，弹错误提示并中断。
5. **拼头**：出口用请求头工厂产出一整套「假装我是浏览器发的 XHR」的头集，把 Cookie 与（如有请求体时的）内容类型塞进去。
6. **发请求**：发起一次 fetch；删除类请求通常没有响应体，直接判成功，其余解析 JSON。
7. **错误分流**：HTTP 层失败统一抛出；业务层再按各自契约决定「吞掉返 false」还是「上抛给界面」。

第 4 步只校验 Cookie 是否非空——**不在这里再验 `__zse_ck` / `z_c0` 是否齐全**。这件事前置章在写入阶段已经做完，本章不重复。这是一个容易被 outline summary 误导的点：summary 字面说「Cookie 校验统一收敛到请求出口」，但源码事实是出口只查空，完整性校验在凭证管理器写入阶段。

## 4. 关键权衡

### 4.1 重放 XHR 换极轻量，代价是手工伪造一整套浏览器指纹

**选择**：写动作不操作真实浏览器，而是直接 `fetch` 知乎的 JSON API，并手工伪造一整套「假装我是浏览器发的 XHR」的请求头（Sec-Ch-Ua 三件套、User-Agent、Origin、Referer、Sec-Fetch-* 系列、X-Requested-With），把已清洗的 Cookie 塞进 Cookie 头。

**换来**：写操作变成一次普通 HTTP，没有浏览器启动开销、没有页面渲染等待、几乎不烧 Cookie。一个动作从「几秒+一份 Cookie」降级成「几十毫秒+一次复用」。

**代价**：这一整套头必须**手工对齐**真浏览器的画像，任何一个头缺失、或与浏览器画像不一致，都可能被反爬识别为「非浏览器流量」直接拒掉。这是一份持续维护负担——浏览器版本一升级、客户端提示头一改，这里就得跟。

**本质矛盾**：写动作要**看起来像浏览器**，但**不需要真的是浏览器**。这个权衡化解的，是「伪装完整度」与「运行时轻量」之间的对立——它把伪装的代价全部前置到「写代码时拼头」，换来运行时的零浏览器开销。一条只讲「选择→换来」而把代价一笔带过的描述会失真：这里的代价是真实的、且是这一选择的主要负担。

### 4.2 全部写方法共用同一个出口，换请求层一处统一，代价是失去按类型定制的余地

**选择**：十几个写方法全部做成无状态静态方法，从 `voteAnswer` / `favoriteItem` / `followQuestion` 到 `createCollection`，没有例外地共用同一个 `makeRequest` 出口。每个方法只负责把动作翻译成「URL + 方法 + 体 + 操作名」三件套加一个名字，剩下的全交给出口。

**换来**：请求构造、凭证拼装、HTTP 层错误处理在一处收敛。今天发现 Sec-Ch-Ua 该换版本了，改一个函数全 chapter 生效；今天发现某个新端点要用 PATCH，出口加一个分支就行。

**代价**：这些方法**隐式依赖全局 Cookie**（从全局槽里读，而不是显式传参），单测时要么先污染全局、要么没法隔离；并且失去了「按操作类型定制重试 / 限流策略」的余地——比如某个写动作特别容易被反爬盯上，你想给它单独加退避重试，会发现没有干净的挂载点，因为它和大家共用同一个出口。

**本质矛盾**：所有写动作**在传输层本质相同**（都是 XHR），但在**反爬阈值上可能不同**。这个权衡押的就是「它们的阈值一致」——赌赢了换来极致简洁，赌输了就只能给单个方法开后门。

### 4.3 请求构造彻底统一，但成功判定刻意分裂

**选择**：请求构造层彻底统一（全部走 `makeRequest`），但**业务成功判定层刻意分成三类契约**：

- **吞异常返布尔类**（收藏 / 不感兴趣）：内部 `try/catch` 把异常吞掉，只回 `true/false`。
- **原样返回对象、异常上抛类**（投票 / 关注 / 评论点赞）：原样返回响应体里的 JSON 对象，HTTP 层或解析层出错时异常直接上抛给调用方。
- **结构体类**（创建 / 删除收藏夹）：返回 `{ success, error?, collection? }`，异常被转写成 `{ success: false }`。

**换来**：每种操作都能按它**界面语义**选最省事的错误传播方式。收藏按钮只需要变个图标，给它一个布尔就够了；投票按钮要立刻刷新成「已赞 + 新票数」，必须拿到完整对象；创建收藏夹的对话框既要表达成败、又要带回新建夹的 id，于是用结构体包一层。

**代价**：调用方**必须记住每个方法的契约**——有的返布尔、有的返对象、有的返结构体、有的还会抛异常。你不能无脑 `if (await result)` 地统一处理，得翻一次源码或注释。

**本质矛盾**：这是这一章最有教学价值的一条，它划出了「该统一」与「该不统一」的分界线——**传输层同质，所以构造统一；语义层异质，所以判定分裂**。把它说成「全部统一」是错的（语义层根本不齐），把它说成「全部按需各写」也是错的（传输层根本同质）。这条权衡化解的是「接口一致性」与「调用方语义多样性」之间的对立，它的可迁移骨架是：**找到系统中哪一层是同质的、哪一层是异质的，然后只在同质层统一**——这是评估任何「要不要抽公共方法」决策时的通用判断框架。

## 5. 最小原理演示

下面这段脚本演透三件套：一个请求头工厂、一个统一出口、两个错误处理刻意不同的写方法。它不连真知乎，靠一个本地 mock 端点把收到的请求头打印出来，让伪装这件事变得**肉眼可见**。

```ts
// 最小原理演示：写操作客户端三件套
// 跑法：把这段贴进一个 .ts 文件，bun run 或 npx tsx 执行即可。

// 假装是前置章「Cookie 清洗与校验」已写入全局槽的纯净 Cookie 字符串：
// 那时已经剔除第三方统计项、确认关键安全项存在、移除了会触发重定向的 BEC。
let cookieSlot = "z_c0=AAA; __zse_ck=BBB";

// 假装是 VSCode 的错误弹窗
const showError = (msg: string) => console.error(`[UI] ${msg}`);

// 知乎 JSON API 前缀
const API = "https://www.zhihu.com/api/v1";

// 请求头工厂：拼出一整套「假装我是浏览器发的 XHR」的头集，按需挂内容类型
// 这一段演透 §4.1：所有伪装集中在一处，调用方拿到的就是一份"已伪造好"的头
function browserLikeHeaders(cookie: string, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {
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
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/122.0.6261.95 ...",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

// 唯一的请求出口：取 Cookie（空则弹错并抛）→ 拼头 → 发请求 → 删除特判 / 其余解析 JSON
// 这一段演透 §4.2：所有写方法都从这一处发出，凭证拼装与 HTTP 错误处理集中收敛
type ReqOpts = { method: "GET" | "POST" | "DELETE"; body?: string; contentType?: string };
async function makeRequest(url: string, opts: ReqOpts, opName: string) {
  const cookie = cookieSlot;
  if (!cookie) {
    showError(`需要设置知乎Cookie才能使用${opName}功能`);
    throw new Error(`没有设置Cookie，无法${opName}`);
  }
  // 真仓库这里走 fetch；演示里换成 mock 函数，方便看到「实际发出去的头」
  const resp = await mockFetch(url, {
    method: opts.method,
    headers: browserLikeHeaders(cookie, opts.contentType),
    body: opts.body,
  });
  if (!resp.ok) throw new Error(`${opName}HTTP错误: ${resp.status}`);
  // 删除类请求通常没有响应体，命中 2xx 即直接判成功，不尝试解析 JSON
  if (opts.method === "DELETE") return { success: true };
  return await resp.json();
}

// 投票：UI 要拿返回体里的最新投票态 → 原样返回对象，异常原样上抛
// 这一段演透 §4.3 的「上抛」契约
async function voteAnswer(answerId: string, up: boolean) {
  // 用 HTTP 方法翻转表达「赞 / 取消赞」，而不是拆成两个方法
  const method = up ? "POST" : "DELETE";
  return makeRequest(`${API}/answers/${answerId}/voters`, { method }, "赞同回答");
}

// 收藏：UI 只需成败二元信号 → 内部吞异常，只回布尔
// 这一段演透 §4.3 的「吞掉」契约——同一个出口，到业务层走相反的分流
async function favoriteItem(contentId: string, contentType: string) {
  try {
    await makeRequest(
      `${API}/favitems?content_id=${contentId}&content_type=${contentType}`,
      { method: "POST" },
      "收藏",
    );
    return true;
  } catch {
    return false;
  }
}

// --- 下面是演示用的 mock：把"伪装好的头"打印出来，让伪装肉眼可见 ---
async function mockFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
  console.log(`\n→ ${init.method} ${url}`);
  console.log("  headers:", init.headers);
  return {
    ok: true,
    status: 200,
    async json() {
      return { voting: 1, voteupCount: 42 };  // 假装是知乎返回的最新投票态
    },
  };
}

// 跑一下：亲眼看一次「投票」和一次「收藏」分别发出什么
await voteAnswer("123456", true);
await favoriteItem("answer-123456", "answer");
```

跑完你会看到：两次动作发出去的请求头**长得几乎一样**（同一套浏览器指纹），但调用方拿到的东西**完全不同**——一个拿到 `{ voting, voteupCount }` 对象，一个只拿到 `true`。这种「传输层一致、语义层分裂」的对比，正是 §4.3 那条权衡的肉眼证据。

## 6. 执行轨迹

拿 §4.3 里「投票」走一遍，看核心思想如何贯通：

- **输入**：用户在详情页点了「赞同回答 X」。
- **翻译三要素**：`voteAnswer("X", true)` 把它翻译成 `POST https://www.zhihu.com/api/v1/answers/X/voters`，没有请求体，附操作名 `"赞同回答"`。
- **进入出口**：`makeRequest` 被调，先从全局槽取出前置章已清洗好的 Cookie 字符串 `"z_c0=AAA; __zse_ck=BBB"`，非空，通过。
- **拼头**：`browserLikeHeaders` 产出 12 个键值对——`Cookie` 那一项就是上面这段字符串，其余 11 项是固定的浏览器指纹。
- **发请求**：`fetch` 实际发出一个 POST；服务端看到的是「一个 Chrome 122 在 www.zhihu.com 上从详情页发出的同源 XHR」，与真人前端发的请求画像一致。
- **判定**：返回 200 + JSON `{ voting: 1, voteupCount: 42 }`；非 DELETE，走 `response.json()` 解析。
- **错误分流**：因为这是「上抛」契约，`voteAnswer` 把对象原样返回给详情页。
- **输出**：详情页用返回体里的 `voting` 与 `voteupCount` 刷新按钮态——「赞同」按钮高亮、票数从 41 变 42。

换成「收藏」走同一条路：前 6 步完全一样，只在第 7 步走「吞异常返布尔」分支，详情页拿到 `true` 后只把星标图标点亮，不刷新任何计数。同一个出口、同一套伪装头，**只在最后一步按界面语义分流**——这就是 §4.3 的实际形状。

## 7. 教学简化说明

本章演示故意省略了：十几个端点 URL 模板的逐一对照（投票 / 收藏 / 关注 / 不感兴趣各自的路径差异是查表内容，不是原理）；内容类型在知乎不同接口里两套编码并存（推荐反馈类用数字 `1/2/15`、收藏夹类用字符串 `"answer"/"article"/"pin"`，调用方自行对齐）；创建/删除收藏夹返回结构体 `{ success, error?, collection? }` 的完整字段；详情页、侧边栏、命令层各自调用写方法的现场；VSCode 错误弹窗与配置读写的工程化包装。Cookie 的清洗逻辑（去第三方、校验关键项、移除 BEC）已在第 2 章讲透，本章不重讲。

## 8. 小结

写动作绕开浏览器直发 XHR，本质是把「那台浏览器」从一次写操作里**提纯**掉，只留下「那个请求」——读动作做不到（要靠渲染），写动作可以，这就是它俩的分界。构造层因为所有动作在传输层同质而彻底统一，判定层因为各调用方需要的成功信号形状不同而刻意分裂，这一收一放正落在「同质统一、异质分裂」这条实用切口上。

写操作客户端准备好之后，下一章『侧边栏内容列表』就要把它接进真实的 VSCode 视图：怎么把知乎列表搬进侧边栏、并在加载中 / 需登录 / 出错之间做状态化渲染。
