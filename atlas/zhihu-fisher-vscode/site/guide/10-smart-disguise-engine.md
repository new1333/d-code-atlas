---
title: 智能伪装引擎
---

# 智能伪装引擎

> 本章属于 composite 层。前置：全局共享状态容器。
> 学完你能：用一句话讲清「为什么标签页身份要冻结、内容要每次重画」——把伪装拆成两层、给两层不同的更新策略，是为了化解『稳定不闪』与『看着像在被编辑』这对矛盾。

## 1. 为什么需要它

想象一下：你正在 VSCode 里读一篇知乎回答，老板从你身后走过。你的本能动作是什么？`Cmd+Tab` 切走，或者点一下旁边的标签页。可是你点完才意识到：知乎 webview 的标签页上写着中文标题，图标是个橙色的「知」，比没切走还显眼。

用 VSCode 看知乎的人最怕的不是被知乎封，而是被路过的同事瞄到「咦你那个标签页怎么在刷知乎」。原生扩展一旦把知乎文章塞进 webview，标签条和内容区都是赤裸裸的中文，一秒露馅。

上一章把知乎越嵌越深，三级收藏夹树把「我创建的/我关注的 → 收藏夹 → 收藏项」直接挂进了侧边栏。可知乎在 VSCode 里嵌得越深，露馅的破绽就越多（侧边栏标题、webview 标签条、内容区，每一处都是暴露点）。本章就是把这种暴露关掉：**当我视线一离开这个标签页（切走、失焦），它就该瞬间变成一个正在被编辑的代码文件**——标题像代码文件名、图标像代码文件图标、内容像一屏高亮代码；等我切回来，它又秒变回知乎。

但这里有个天然的矛盾：变得要「稳」。标签页标题若每次失焦都重新随机，OS 会在标签条上不停重绘、反而更显眼；可假代码若永远一成不变，瞄第二眼就会发现是死的。把伪装拆成两层、给两层不同的更新策略，就是这个机制要给出的答案。

## 2. 核心思想

**身份（文件名/图标）一次性确定并冻结，内容（假代码）每次重画**——标签条上永远稳定不闪，叠层里却看着像在持续被编辑。

为什么是分两层而不是统一处理？因为伪装的两个观察面对「变化」的容忍度差几个数量级：标签条是 OS 层重绘，路过的人余光一扫就能感知到「跳了一下」；内容叠层藏在 webview 内部，只有主动凑过去看才会注意到。所以不变性要留给敏感的那层，鲜活性要留给宽容的那层。

## 3. 心智模型

整个引擎只用三张表就能装下：

| 表 | 形状 | 作用 |
|---|---|---|
| 身份缓存 | `Map<webviewId, { title, iconPath }>` | 每个打开的知乎 webview 一个标识，对应一个被冻结的「假文件名 + 假图标」 |
| 语言表 | 30 种语言 × (前缀/名/扩展名 三组词池 + 一组模板闭包数组) | 拼文件名取词、生成假代码取模板 |
| 轮转模板索引 | `Map<language, number>` | 模块级、跨所有 webview 共享，记录每种语言的骨架该取下一位了 |

触发的时序：

```
A. 失焦（panel.onDidChangeViewState active=false）
   → 按 webviewId 查身份缓存
       命中：原样返回
       未命中：从用户勾选的语言里随机抽一种 → 三组词池各随机取一个拼文件名 → 写回缓存（冻结）
   → 宿主把 panel.title / panel.iconPath 改成这个身份（OS 可见）
   → 若开启代码叠层：用同一个身份反查语言 → 调代码生成器产 100 行假代码 → 注入 webview（默认 display:none）
   → postMessage({ command: 'showDisguise' })

B. 获焦（active=true）
   → 恢复真标题（取自全局 Store 的 webviewMap）/ 真图标
   → postMessage({ command: 'hideDisguise' })
```

资源定位这件小事承上一笔带过：拼图标路径时要取扩展根 URI，这个 URI 是从全书第 1 章那个全局 Store 借来的——伪装管理器只读借一下 `Store.context.extensionUri`，不参与可变状态通信，也没往 Store 里塞自己的缓存。

## 4. 关键权衡

### 身份按页面缓存，换来标签条稳定不闪

选择「**身份按 webviewId 缓存、命中即原样复用**」→ 换来标签条上标题和图标稳定不闪，路过的人瞄第二眼还是同一个文件名，不会因为反复重绘而招眼 → 代价是同一个页面永远顶着同一个假文件名（不够「随机」），且要在导航到新文章或 webview 重建时**记得显式清缓存换身份**，否则点开下一篇回答时还顶着上一篇的文件名。

化解的本质矛盾是 **OS 视觉敏感 ↔ 真实感需要随机**：人眼对标签条的变化比对内容的变化敏感得多，所以把不变性留给视觉敏感层，把随机性留给人眼宽容的内容层。

### 骨架全局轮转、token 每次随机，换来结构可信

选择「**代码骨架按调用次数取模轮转、而非每行纯随机**」→ 换来结构天然像 `导入 → 类 → 方法` 的真实程序，绝不会出现五个连续右大括号、或 `import` 接 `import` 接 `import` 的鬼畜序列 → 代价是骨架其实是确定性的（两次渲染结构会重合），而且索引跨所有 webview 共享：同一语言被全扩展调用的总次数决定下一次取哪个模板，而非某个页面自己的渲染次数，多页面同时伪装时骨架序列会互相穿插。

化解的本质矛盾是 **可信结构需要顺序 ↔ 鲜活感需要随机**：把骨架的「序」交给一个取模递增的全局索引来保，把占位符的「乱」交给 Math.random 来保，两个职责分到两层。

### 预烤着色 span，换来像素级还原且零运行时依赖

选择「**不接真实语法高亮引擎、直接吐出编辑器自带的 TextMate token CSS 类名**」（`mtk1`～`mtk21`，关键字/变量/串/类型/注释各对应一类）→ 换来像素级还原真实编辑器观感、且 webview 端零运行时依赖（只需自带一份「类名 → 颜色」映射）→ 代价是每种语言都得手写一组模板闭包（整个生成器上千行重复代码），且生成的「代码」细看并不构成可运行程序。

化解的本质矛盾是 **真实高亮需要解析 ↔ webview 启动要快**：真高亮要在 webview 里跑一个 TextMate 引擎，慢且重；预烤 span 把这件事在生成期就做掉，运行时只剩纯字符串拼接。代价薄到不展开：主要是手写模板的体力活。

### 两层各自独立触发，换来轻量与重型伪装可分别开关

选择「**标题/图标层每次失焦恒触发、代码叠层按开关显式触发**」→ 换来标题层零延迟恒生效（失焦即伪装），叠层可由用户按需开关（性能敏感者关掉、追求隐蔽者打开）→ 代价是两层稳定性策略与默认值不一致，存在「标题已伪装但内容还是知乎」的半伪装中间态；而且同一个 `enableDisguise` 开关在不同读取点的默认值还漂移（伪装管理器内部读默认 `true`、宿主调用点读默认 `false`、HTML 渲染器又读默认 `true`），是后续排查时的认知陷阱。

化解的本质矛盾是 **轻量隐蔽 ↔ 重型隐蔽**：标题层是「廉价」的伪装，做了不吃亏；叠层是「昂贵」的伪装（100 行假代码注入 webview），要交给用户决定。把两个决策拆开是合理的，默认值的不一致是配置项演进过程中的遗留漂移。

## 5. 最小原理演示

下面这段独立脚本演透「身份冻结 + 内容重画」——它**不**演示 VSCode webview 真跑（那需要宿主环境），只演示三层缓存的更新策略，可以直接 `node`/`bun` 跑。

```ts
// 只列 2 种语言、每种语言 3 个模板闭包——30 种语言的千行重复无信息量，举 2 种代表即可
const LANGS = {
  ts: {
    prefixes: ['app-', 'core-', 'utils-'],
    names: ['config', 'parser', 'logger'],
    extensions: ['.ts', '.d.ts'],
    // 每个模板闭包：骨架固定（const/interface/class），占位（变量名/值）每次随机
    // 直接吐 mtkN class——预烤着色，webview 端零解析
    patterns: [
      () => `<span class="mtk5">const</span> <span class="mtk9">${pick(['x','y','z'])}</span> = <span class="mtk11">${pick(['42','"hi"','true'])}</span>;`,
      () => `<span class="mtk5">interface</span> <span class="mtk7">${pick(['Foo','Bar'])}</span> { name: <span class="mtk7">string</span>; }`,
      () => `<span class="mtk5">class</span> <span class="mtk7">${pick(['Mgr','Svc'])}</span> { id = <span class="mtk11">${pick(['1','2','3'])}</span>; }`,
    ],
  },
  py: {
    prefixes: ['data_', 'model_', 'view_'],
    names: ['loader', 'trainer', 'saver'],
    extensions: ['.py'],
    patterns: [
      () => `<span class="mtk9">${pick(['x','y'])}</span> = <span class="mtk11">${pick(['1','2'])}</span>`,
      () => `<span class="mtk5">def</span> <span class="mtk9">${pick(['run','go'])}</span>(self): <span class="mtk5">pass</span>`,
      () => `<span class="mtk5">class</span> <span class="mtk7">${pick(['A','B'])}</span>: <span class="mtk5">pass</span>`,
    ],
  },
};

const disguiseCache = new Map<string, { title: string; icon: string }>(); // 身份缓存：webviewId → 冻结身份
const patternIndex: Record<string, number> = {};                          // 轮转模板索引：language → 当前位置

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// 身份层：命中即复用、否则三池拼接并冻结
function getDisguise(webviewId: string, allowed: (keyof typeof LANGS)[]) {
  if (disguiseCache.has(webviewId)) return disguiseCache.get(webviewId)!; // 命中即返回，标签条稳定不闪
  const lang = pick(allowed);
  const info = LANGS[lang];
  const title = `${pick(info.prefixes)}${pick(info.names)}${pick(info.extensions)}`; // 三池拼一个新名字
  const disguise = { title, icon: `icon-${lang}.svg` };
  disguiseCache.set(webviewId, disguise);                                  // 冻结
  return disguise;
}

// 内容层：骨架全局轮转、占位每次随机
function nextLine(lang: keyof typeof LANGS): string {
  const patterns = LANGS[lang].patterns;
  const i = patternIndex[lang] ?? 0;
  patternIndex[lang] = (i + 1) % patterns.length;                          // 取模推进，骨架确定性轮转
  return patterns[i]();                                                     // 闭包内 Math.random 填占位
}

// 模拟失焦/获焦契约
type Panel = { id: string; title: string; icon: string; overlay: string[] };
function onBlur(panel: Panel, allowed: (keyof typeof LANGS)[]) {
  const d = getDisguise(panel.id, allowed);                                // 身份：缓存命中不闪
  const ext = d.title.slice(d.title.lastIndexOf('.'));
  const lang = (Object.keys(LANGS) as (keyof typeof LANGS)[]).find(k => LANGS[k].extensions.includes(ext))!;
  panel.title = d.title;
  panel.icon = d.icon;
  panel.overlay = Array.from({ length: 3 }, () => nextLine(lang));         // 内容：每次重画、骨架轮转
  console.log(`  标签=[${panel.title}]  叠层=${JSON.stringify(panel.overlay.map(l => l.replace(/<[^>]+>/g, '')))}`);
}
function onFocus(panel: Panel) { panel.title = '【知乎原文】'; panel.icon = 'zhihu.svg'; panel.overlay = []; }

// 演示：同一个 panel 连续失焦 3 次——标题三次完全相同，叠层骨架却每次推进
const panel: Panel = { id: 'wv-1', title: '【知乎原文】', icon: 'zhihu.svg', overlay: [] };
console.log('三次失焦，观察身份冻结 vs 内容重画：');
onBlur(panel, ['ts', 'py']);  // 首次：缓存未命中 → 随机抽 ts/py → 三池拼一个新文件名 → 冻结
onBlur(panel, ['ts', 'py']);  // 再次：缓存命中 → 标题原样；叠层骨架推进一格
onBlur(panel, ['ts', 'py']);  // 第三次：标题依旧不变；叠层骨架再推进一格
```

跑完你会看到——三次失焦的标签标题**完全相同**（缓存命中、不闪），但每次产出的 3 行叠层**骨架按取模推进、token 重新随机**（鲜活）。这一行行为差异，就是全章的灵魂。

## 6. 执行轨迹

拿一个具体输入走一遍：用户首次切走某知乎回答的 webview，配置里只勾选了 `ts` 和 `py` 两种语言，且开启了代码叠层。

```
1. onDidChangeViewState(active=false) 触发
2. getDisguiseOrDefault('wv-1')：缓存未命中
3. 语言池过滤 → ['ts','py']
4. 随机抽中 'ts'
5. ts 三池各随机取一个：前缀池抽 'app-'、名池抽 'utils'、扩展池抽 '.ts'
6. 拼成 'app-utils.ts'，图标 'icon-ts.svg'，写回缓存（冻结）
7. panel.title = 'app-utils.ts'；panel.iconPath = icon-ts.svg
8. （开启叠层）generateDisguiseCodeInterface('wv-1')
9.   复用同一个缓存身份 'app-utils.ts' → 扩展名 '.ts' → 反查得 language='ts'
10.  CodeGenerator.generateCode('ts', 100)
11.  patternIndex['ts'] 当前 = 3 → 取第 4 个 ts 模板（class...）→ 占位随机填
12.  patternIndex['ts'] 推进到 4 → 取第 5 个 → … 循环 100 次（索引跨过若干轮回到原位）
13. 拼成 100 行带 mtkN span 的 HTML，包进外层 display:none 的容器
14. HTML 渲染器注入 webview 文档；postMessage({ command: 'showDisguise' })
```

输出：标签条上写「app-utils.ts」+ ts 图标；webview 里叠了一层 100 行、结构像 ts 定义文件的高亮代码。

**再次失焦**：

```
2'. getDisguiseOrDefault('wv-1')：缓存命中 → 直接返回 'app-utils.ts'
3'. panel.title / panel.iconPath 原样赋值——OS 标签条不会重绘、不闪
8'. 代码叠层却重新生成：patternIndex['ts'] 当前 = 7（上次推进到 7）→ 取第 8 个 → 占位重随
12'. 100 行骨架相对上次向前推进了 100 格（取模回到 7），token 重新随机
```

输出：标签条上的「app-utils.ts」纹丝不动；叠层里却看着像这个文件还在被持续编辑。

两次失焦的对照——身份冻结、内容重画——是这条权衡链在运行时落到地面的样子。

## 7. 教学简化说明

本章演示故意省略了：30 种语言各自的模板数组（千行重复，举 2 种代表即可）；HTML 实体编码细节（`&#40;` 之类）；行号 DOM 的动态计算；CSS 类名 `mtk1`~`mtk21` 到具体颜色的映射；侧边栏联动伪装（属于紧邻的「侧边栏伪装成假文件树」章）；配置勾选 UI；手动切换伪装命令的防抖锁。

## 8. 小结

伪装引擎的诀窍不在「伪装」本身，而在「把伪装拆成两层、给两层不同的稳定性」——身份冻结、内容重画，是这条权衡链的全部。但伪装再巧妙，也救不了 Cookie 用着用着就失效的那一刻：登录页带加密、纯 HTTP 走不通，得换一台真实浏览器去把登录页跑通——这正是下一章「扫码登录全流程」要解决的问题。
