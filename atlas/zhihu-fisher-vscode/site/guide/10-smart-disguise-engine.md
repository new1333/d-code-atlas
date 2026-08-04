---
title: 智能伪装引擎
---

# 智能伪装引擎：身份冻结，内容重画

想象一下：你正在 VSCode 里偷偷刷知乎，老板从身后走过。你下意识切到旁边的代码标签——可那个该死的知乎标签还亮着中文标题，图标还是知乎 logo。一秒露馅。

更要命的是，这种「露馅」往往不是因为你忘了伪装，而是因为伪装机制本身设计得不对——比如每次切走都换一个新假名字，结果 OS 任务栏在那一瞬间猛闪两下，反而比不伪装更招眼。

这一章讲的就是怎么解开这个矛盾：让伪装既「稳」（不闪、不变、不引人注意），又「活」（瞄一眼就觉得「他还在敲代码」，不是死的截图）。

## 一句话点透：伪装是两层，给两层不同的更新策略

伪装不是一件事，是两件事叠在一起：

- **身份层**：标签页的标题和图标。这一层所有人都瞄得到（OS 任务栏、标签条、窗口标题）。它要**稳**——同一个页面切来切去，标题永远不变。
- **内容层**：webview 里叠的那层假代码。这一层只有主动切回来盯着看的人才看得清。它要**活**——每次失焦都重画一屏，看着就像还在被持续编辑。

整章的灵魂就是这一对**反方向**的更新策略：身份层缓存命中即冻结，内容层每次重画。下面自底向上把这两层拼出来。

## 底层零件一：语言表——三池正交，拼出可信文件名

先看身份层最底下那块——一张「语言表」。

每种语言对应三组小词池：前缀池（`app-`、`utils-`、`api-`）、名池（`user`、`config`、`handler`）、扩展名池（`.ts`、`.tsx`）。每个池子各随机抽一个，拼起来就是一个像模像样的文件名：`app-utils.ts`、`api-handler.tsx`。

为什么是三个正交的池子、而不是一个大池子直接抽？因为分开抽能指数级放大组合空间——三个各 10 项的池子能拼出 1000 种文件名，而单池要存 1000 项。更关键的是扩展名池单独成池后，可以**直接当反查 key 用**：拿到文件名最后一段，就能反推这是哪种语言，进而决定贴什么图标、生成什么语言的代码。这一点内容层会用到。

图标则是另一张静态映射：`ts → typescript.svg`、`py → python.svg`，指向扩展打包目录下的一组内置 svg。拼图标路径时，需要知道「扩展的根目录在哪」——这里复用了第 1 章那个全局共享 Store 里挂着的 `extensionUri`，但只读一眼、不参与可变状态通信（Store 本身的单例设计第 1 章已讲透，本章不重复）。

## 底层零件二：身份缓存——同一个 webview 永远顶着同一张脸

光有词池还不够。如果每次失焦都现拼一个新名字，会发生灾难：用户连续切走三次，标签页标题变了三次，OS 任务栏重绘了三次——这种闪烁本身就比知乎中文标题更显眼。

所以得加一张缓存：**键是 webview 唯一标识，值是首次拼出来的那个身份**。

可以把它想成自助餐厅发你的桌号牌——第一次进门时给你一张写着「7 号桌」，你这一整餐都是 7 号桌；下次来才换。频繁换号反而让人怀疑你在干什么。

```ts
const disguiseCache = new Map<string, { title: string; iconPath: string }>();

function getRandomDisguise(webviewId: string) {
  if (disguiseCache.has(webviewId)) {
    return disguiseCache.get(webviewId)!; // 命中即原样复用，绝不重新随机
  }
  const lang = pickFrom(enabledLanguages);
  const prefix = pickFrom(langTable[lang].prefixes);
  const name = pickFrom(langTable[lang].names);
  const ext = pickFrom(langTable[lang].extensions);
  const disguise = { title: `${prefix}${name}${ext}`, iconPath: iconMap[lang] };
  disguiseCache.set(webviewId, disguise); // 冻结身份
  return disguise;
}
```

命中即冻结，这就是身份层的全部秘诀。导航到新文章或 webview 重建时，宿主会显式调一句「清掉这个 id 的缓存」，身份才会换一次——除此之外这个 webview 永远顶着同一张脸。

身份层这就完事了。一句话：**webview 标识 → 缓存 → 文件名/图标，三步走，命中即冻结**。

## 内容层：叠一层「像在持续被编辑」的假代码

身份层把 OS 任务栏稳住了。但 webview 内容还是赤裸裸的知乎文章——只要有人凑过来看你屏幕，照样露馅。所以还得在 webview 内部叠一层假代码。

这里的难点不是「生成代码」，而是「生成得像」。一段随便拼的随机字符串，5 秒就被看穿；但一段 `import → interface → class → method` 这样骨架齐全的代码，瞄一眼会下意识觉得「哦他在写 TS」。

### 零件三：全局轮转的模板索引

代码生成的最底层是一个**模块级**的轮转索引。每种语言对应一组「模板闭包」数组（一种语言可能二三十个模板），调一次取下一个、取到末尾回到开头：

```ts
const patternIndexes = new Map<string, number>(); // 模块级、跨所有 webview 共享

function getNextPattern<T>(fileType: string, patterns: T[]): T {
  if (!patternIndexes.has(fileType)) patternIndexes.set(fileType, 0);
  const i = patternIndexes.get(fileType)!;
  const pattern = patterns[i];
  patternIndexes.set(fileType, (i + 1) % patterns.length); // 取模推进
  return pattern;
}
```

为什么要轮转、不让每个 token 都纯随机？因为纯随机会拼出鬼畜序列：五个连续右大括号、`import` 接 `import` 再接 `import`、`return return return`——这种东西一眼假。

轮转则保证骨架按一种可信顺序推进：`import` 出过几次后自然轮到 `class`，`class` 走完轮到 `method`——结构天然像真实程序。

说人话就是：骨架走「正步」，token 走「乱步」。正步保证结构可信，乱步保证细节新鲜。

注意一个细节：这个索引是**全局共享**的，不按 webview 隔离。也就是说，A 页面调一次和 B 页面调一次，对 TS 这个语言的索引推进是连贯的。这会导致多页面同时伪装时骨架序列互相穿插——但内容层只有「主动切回来盯着看」才看得清，实际没人察觉。这是一个被刻意接受的副作用。

### 零件四：模板闭包——骨架固定、占位随机、预烤着色

每个模板是一个零参闭包，返回一行 HTML。骨架是写死的（比如 `const ___ = ___;`），只有空白处随机填：

```ts
const tsPatterns = [
  () => `<span class="mtk5">const</span>&nbsp;<span class="mtk9">${randomVariableName()}</span>&nbsp;=&nbsp;<span class="mtk11">${randomValue()}</span>;`,
  () => `<span class="mtk5">interface</span>&nbsp;<span class="mtk9">${randomTypeName()}</span>&nbsp;{`,
  // ... 几十个
];
```

这里有一个非常聪明的选择：**不接真实语法高亮引擎**，而是直接吐 VSCode 编辑器自己用的那组 token CSS 类名（`mtk1`～`mtk21`）。webview 自带一份「类名 → 颜色」的 CSS 映射，就能像素级还原编辑器观感——读者眼睛收到的颜色信号，跟真在看一个 `.ts` 文件一模一样。

代价当然有：每种语言都得手写一组闭包（三十种语言就是上千行重复代码），而且生成的「代码」细看并不构成可运行程序。但这是一个被精心算计过的代价——只要骗过「瞄一眼」就赢，没人会在摸鱼现场逐行 debug 一段假代码。

### 内容层复用身份层缓存保证一致

代码生成时，怎么知道该生成哪种语言？这里内容层和身份层交汇了：

```ts
function generateDisguiseCodeInterface(webviewId: string): string {
  const disguise = getRandomDisguise(webviewId); // 复用同一缓存身份
  const ext = disguise.title.slice(disguise.title.lastIndexOf('.'));
  const lang = getLanguageFromExtension(ext);     // 扩展名反查语言
  const lines = generateCode(lang, 100);           // 100 行假代码
  return buildCodeInterfaceHTML(lines);
}
```

这一步非常关键：**内容层不能自己再随机抽语言**，必须用身份层的缓存身份反查。否则就会出现「标签写着 `app-utils.ts`、内容是 Python 代码」的穿帮——这种不一致比纯知乎内容还显眼。

## 把两层串起来：失焦/获焦的时序

身份层和内容层各自独立触发，宿主在面板的 `onDidChangeViewState` 事件里把它们串起来。下面这条时序就是整个引擎运行时真正在做的事：

```
失焦 (active=false):
  1. 调 getRandomDisguise(id) → 拿到（或新建）缓存身份
  2. 写 panel.title / panel.iconPath            ← OS 层立刻可见
  3. 若代码叠层开关开了:
       generateDisguiseCodeInterface(id) → 注入 HTML
       postMessage({ command: 'showDisguise' }) ← 前端把叠层 display 改 block

获焦 (active=true):
  1. 恢复真标题（取自 Store.webviewMap）/ 真图标
  2. postMessage({ command: 'hideDisguise' })    ← 前端把叠层藏起来
```

注意第 2 步和第 3 步是**两套独立的开关**：标题层在失焦分支几乎无条件触发（内部开关默认开），代码叠层显式受外部开关二次约束（默认值在不同读取点甚至不一致）。这意味着存在「半伪装」中间态——标题已经变成 `app-utils.ts` 了，但内容层没叠，还看得见知乎。这个中间态是后续排查时的认知陷阱，下面会展开。

## 最小演示：演透「身份冻结 + 内容重画」

下面这段脚本可以丢进 `node` 或 `bun` 直接跑。它用一张只有 2 种语言的语言表、一张按 id 的身份缓存、一个全局轮转索引，模拟同一个 webview 连续失焦 3 次的行为：

```ts
// disguise-demo.ts —— 直接 bun run disguise-demo.ts
type Disguise = { title: string; icon: string };

// 零件一：语言表（三池正交）
const langTable = {
  ts: { prefixes: ['app-', 'api-'], names: ['utils', 'handler'], extensions: ['.ts'] },
  py: { prefixes: ['lib_', 'core_'], names: ['parser', 'worker'], extensions: ['.py'] },
};
const iconMap: Record<string, string> = { ts: 'typescript.svg', py: 'python.svg' };

// 零件二：身份缓存（命中即冻结）
const disguiseCache = new Map<string, Disguise>();

// 零件三：全局轮转模板索引
const patternIndexes: Record<string, number> = {};
const patterns: Record<string, Array<() => string>> = {
  ts: [
    () => `const ${randVar()} = ${randVal()};`,
    () => `interface ${randType()} { /* ... */ }`,
    () => `export function ${randFn()}() { return ${randVal()}; }`,
  ],
  py: [
    () => `def ${randFn()}(self): return ${randVal()}`,
    () => `class ${randType()}: pass`,
    () => `from ${randMod()} import ${randFn()}`,
  ],
};
function nextPattern(lang: string): string {
  if (!(lang in patternIndexes)) patternIndexes[lang] = 0;
  const i = patternIndexes[lang];
  const p = patterns[lang][i];
  patternIndexes[lang] = (i + 1) % patterns[lang].length;
  return p();
}

// 随机 token 池
function pick<T>(xs: T[]): T { return xs[Math.floor(Math.random() * xs.length)]; }
function randVar()  { return pick(['x', 'data', 'ctx', 'res']); }
function randVal()  { return pick(['42', '"hi"', 'null', 'true']); }
function randType() { return pick(['User', 'Config', 'Handler']); }
function randFn()   { return pick(['fetch', 'parse', 'run']); }
function randMod()  { return pick(['os', 'json', 'sys']); }

// 拼身份（缓存命中即冻结）
function getDisguise(id: string, enabled: string[]): Disguise {
  if (disguiseCache.has(id)) return disguiseCache.get(id)!;
  const lang = pick(enabled) as 'ts' | 'py';
  const t = langTable[lang];
  const d = { title: `${pick(t.prefixes)}${pick(t.names)}${pick(t.extensions)}`, icon: iconMap[lang] };
  disguiseCache.set(id, d);
  return d;
}

// 模拟一个面板：标签 + 内部叠层
function makePanel(id: string) {
  return { id, title: '知乎文章标题', icon: 'zhihu.svg', overlay: '' };
}

// 失焦：写身份 + 重画叠层（每次 5 行假代码）
function onBlur(panel: ReturnType<typeof makePanel>, enabled: string[]) {
  const d = getDisguise(panel.id, enabled);
  panel.title = d.title;
  panel.icon = d.icon;
  const ext = d.title.slice(d.title.lastIndexOf('.'));
  const lang = ext === '.ts' ? 'ts' : 'py';
  panel.overlay = Array.from({ length: 5 }, () => nextPattern(lang)).join('\n');
}

// 跑：同一个面板连续失焦 3 次
const panel = makePanel('wv-1');
for (let i = 1; i <= 3; i++) {
  onBlur(panel, ['ts', 'py']);
  console.log(`--- 第 ${i} 次失焦 ---`);
  console.log(`标题/图标: ${panel.title}  | ${panel.icon}`);
  console.log(`叠层:\n${panel.overlay}\n`);
}
```

跑完你会看到：**标签标题三次完全相同**（`api-handler.ts` 之类的某个固定值），因为缓存命中、不再重抽；可叠层代码每次都不一样——骨架按 `pattern 0 → 1 → 2 → 0 → 1 ...` 推进、token 重新随机。

这一行行为差异就是全章灵魂：**身份冻结保稳定，内容重画保鲜活**。

## 关键权衡

这一章机制密集，下面这四条权衡每一条都对应一个具体的设计抉择。

### 权衡一：身份缓存 ↔ 内容重生成

**做了什么**：身份层按 webview 缓存、命中即冻结；内容层每次重新生成。

**换来什么**：标签条上标题/图标稳定不闪——OS 不需要重绘任务栏，旁边走过的人完全感知不到「这个标签在变」；同时叠层代码每次都不一样，主动凑过来看的人会觉得「他还在敲」。

**代价是什么**：同一个页面永远顶着同一个假文件名（不够「随机」、不够刺激），且要在导航到新文章时记得显式清缓存——如果忘了清，第 N 篇文章还顶着第一篇的伪装身份，反而成了规律。

### 权衡二：全局轮转模板索引 ↔ 纯 token 随机

**做了什么**：代码骨架按调用次数取模轮转，闭包内部只对占位符随机填充。

**换来什么**：结构可信——骨架天然像 `import → interface → method` 的真实程序，不会出现五个连续右大括号或 `import import import` 的鬼畜序列。

**代价是什么**：骨架其实是确定性的，A 页面和 B 页面如果同时伪装、调用次数穿插，骨架序列会重合。但因为内容叠层只有「主动切回来盯着看」才可见、且 token 每次都重新随机，这点不致命——是个被精心算过的可接受代价。

### 权衡三：预烤着色 span ↔ 接真实语法高亮引擎

**做了什么**：不接 TextMate、不接 Shiki、不接任何真实语法高亮引擎，而是直接吐编辑器自带的 `mtk1`～`mtk21` 这组 CSS 类名。

**换来什么**：像素级还原编辑器观感（读者眼睛收到的颜色信号和真在看一个 `.ts` 文件完全一致），且 webview 零运行时依赖——只需自带一份「类名 → 颜色」的 CSS 映射。

**代价是什么**：每种语言都得手写一组模板闭包，三十种语言就是上千行高度重复的代码；而且生成的「代码」细看并不构成可运行程序。但摸鱼现场没人逐行 debug 假代码，这个代价物超所值。

### 权衡四：两层各自独立触发 ↔ 半伪装中间态

**做了什么**：标题层在失焦分支几乎无条件触发（内部开关默认开），代码叠层显式受外部开关二次约束（默认值在多个读取点甚至不一致——某处默认开、某处默认关）。

**换来什么**：标题层零延迟恒生效，哪怕用户没开代码叠层，至少标签条先稳住；代码叠层作为「重头戏」由用户显式打开，避免一上来就给新用户塞一段莫名其妙的高亮代码。

**代价是什么**：两层稳定性策略与默认值不一致，存在「标题已伪装但内容还是知乎」的半伪装中间态；同一个开关在不同读取点默认值不同，是后续排查时的认知陷阱——你以为是开关没开，其实是读到的那处默认值本身就是关。

## 小结

这一章的核心是**把伪装拆成两层，给两层不同的更新策略**：身份层（标题/图标）缓存命中即冻结，换来 OS 层稳定不闪；内容层（假代码）每次重画，换来「持续被编辑」的鲜活感。底层用了三种零件——三池正交的语言表、按 webview 的身份缓存、全局轮转的模板索引——加一种巧妙的复用：内容层不自己抽语言，而是从身份层的缓存里反查扩展名，保证「标题是 ts、内容也是 ts」的一致性。

紧邻的下一章会讲「扫码登录全流程」——一个看似和伪装无关、但同样依赖「真实浏览器渲染」来绕过知乎登录加密的子系统。
