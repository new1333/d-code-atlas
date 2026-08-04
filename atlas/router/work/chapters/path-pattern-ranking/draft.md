# 路径模式编译与优先级评分

## 先说一个你一定踩过的坑

你在写后台系统的路由表，配了 `/users/:id` 用来展示某个用户，又配了 `/users/new` 用来新建用户。上线一切正常，直到有一天有人访问 `/users/new`——页面却打开了「用户详情」，并且一脸困惑地看着地址栏里那个 ID 为 `new` 的用户。

问题出在哪？`/users/new` 这个 URL 同时满足两条规则：它既精确等于 `/users/new`，也能被 `/users/:id` 吃下去（把 `new` 当成 `:id` 的值）。两条路由都说「我能处理它」，那到底听谁的？

很多早期路由库的答案是：**听你写的顺序**。谁先声明谁赢。于是你被迫记住一条隐形的规矩——「更具体的要写在前面」。一旦哪天手滑把 `/users/:id` 写到了 `/users/new` 前面，`new` 就被当成参数吞掉，而且这种 bug 极难排查，因为代码看起来一点错都没有。

这一章要讲的就是怎么把「谁更该赢」这件事，从「你写的顺序」里彻底摘出来，交还给模式本身。

### 一句话点透

> 给每条路由模式算一个「具体性分数」——越挑剔（能匹配的 URL 越少）的模式分数越高；匹配时按分数从高到低试，第一个命中的就是赢家。结果只看模式长什么样，跟你声明它们的先后顺序毫无关系。

打个比方：每条路由发一张「身份证」，上面写着「我有多挑剔」。`/users/new` 这种把路径写死的，挑剔到只认一个地址，分数最高；`/users/:id` 接受任意一段，挑剔程度次之；`/users/:rest(.*)*` 这种「后面什么都行」的，来者不拒，分数最低。真到了匹配的时候，从最挑剔的开始问，谁先举手谁负责。

这章是全书最早打基础的那几章之一，没有前置依赖。它产出的「分数」，后面会有一章专门讲怎么拿去排进一张有序的匹配表里——但那是后话。本章只回答两个问题：**这个分数从哪来**，以及**两个分数怎么比大小**。

---

## 第一步：把路径字符串拆成「段」和「词」

要给模式算分，得先把它拆成最小零件。但不是按字符拆，而是按 URL 的天然结构拆。

URL 是一层一层的：`/users/new` 有两「段」，段与段之间用 `/` 隔开；段里面还可能有更细的零件，比如 `/a-:b` 这一段里就混着「写死的 `a-`」和「参数 `:b`」。所以拆解的结果天然是个**二维结构**：外层是段，每段里面是一串「词」（token）。

干这件事的是一个字符级的状态机——它一个字符一个字符地读路径字符串，根据当前读到的字符和「我现在处于什么状态」决定下一步。状态就那么几个：正在读写死的静态串、正在读参数名、正在读参数后面的自定义正则、正则读完了看有没有修饰符。

遇到 `/` 就切段；遇到 `:` 就知道「接下来是参数」；遇到 `(` 就进入「自定义正则」模式，直到读到 `)`；`?`、`*`、`+` 这三个修饰符在「收尾」那一刻一次性解读清楚：

- `?` 表示可选（可以没有）
- `+` 表示可重复（可以有多个，用 `/` 连着写）
- `*` 表示既可选又可重复

而且有个硬规矩：**可重复的参数必须独占一整段**。你不能写 `/users/:ids+-profile`，因为「可重复」意味着它能吞掉好几段，跟别的词挤在一起就分不清边界了。

下面是这个词法器的最小实现（为讲清评分，刻意省略了转义分支等细节）：

```ts
type Token =
  | { type: 'Static'; value: string }
  | { type: 'Param'; value: string; regexp: string; optional: boolean; repeatable: boolean }

const VALID_PARAM_RE = /[a-zA-Z0-9_]/

function tokenizePath(path: string): Token[][] {
  if (path === '/') return [[{ type: 'Static', value: '' }]] // 根路径单独处理
  const segments: Token[][] = []
  let segment: Token[] = []
  let state: 'Static' | 'Param' | 'ParamRegExp' | 'ParamRegExpEnd' = 'Static'
  let buffer = ''   // 累积当前正在读的值
  let customRe = '' // 累积参数的自定义正则
  let i = 0

  const flush = (mod: string) => {
    // 把 buffer 里的东西落成一个 token；mod 是它身后的修饰符
    if (state === 'Static' && buffer) segment.push({ type: 'Static', value: buffer })
    else if (state !== 'Static' && buffer) segment.push({
      type: 'Param', value: buffer, regexp: customRe,
      repeatable: mod === '*' || mod === '+',
      optional: mod === '*' || mod === '?',
    })
    buffer = ''; customRe = ''
  }

  while (i < path.length) {
    const char = path[i++]
    switch (state) {
      case 'Static':
        if (char === '/') { flush(''); if (segment.length) { segments.push(segment); segment = [] } }
        else if (char === ':') { flush(''); state = 'Param' }
        else buffer += char
        break
      case 'Param':
        if (char === '(') state = 'ParamRegExp'      // 进自定义正则
        else if (VALID_PARAM_RE.test(char)) buffer += char
        else { flush(char); state = 'Static'; if (char !== '*' && char !== '?' && char !== '+') i-- }
        break                                  // ↑ 不是修饰符就「退一格」回去重读
      case 'ParamRegExp':
        if (char === ')') state = 'ParamRegExpEnd'; else customRe += char
        break
      case 'ParamRegExpEnd':
        flush(char); state = 'Static'; if (char !== '*' && char !== '?' && char !== '+') i--
        break
    }
  }
  flush('')
  if (segment.length) segments.push(segment)
  return segments
}
```

拿它跑一下本章开头的两条路由：

```
/users/new        →  [ [Static:users], [Static:new] ]
/users/:id        →  [ [Static:users], [Param:id] ]
/users/:rest(.*)* →  [ [Static:users], [Param:rest, regexp=".*", 可选, 可重复] ]
```

三条路由的第一段都是写死的 `users`，差别全在第二段——一个写死、一个参数、一个通配。这正是后面算分要区分的地方。

（顺带一提：源码里其实还定义了第三种 token 类型「分组」，但状态机里没有任何分支会产出它，属于给将来留的空位，当前用不到。）

---

## 第二步：每个词，同步算出一份「具体性分数」

拆成词之后，下一步是两件事一起做：把每个词翻译成正则片段、拼成一条完整正则（这是运行期真正用来匹配的），同时给每个词打一个分。我们这里聚焦打分。

打分有把统一的尺子，按「这东西有多挑剔」从高到低排：

| 模式片段 | 例子 | 单段得分 |
|---|---|---|
| 写死的静态串 | `/users` | **80** |
| 带自定义正则的参数 | `/:id(\d+)` | **70** |
| 普通参数 | `/:id` | **60** |
| 可选参数 | `/:id?` | **52** |
| 可重复参数 | `/:id+` | **40** |
| 可选且可重复 | `/:id*` | **32** |
| 通配 | `/:rest(.*)*` | **−8** |

这张表背后的算法很朴素：**每个词都从一个公共的基础分（40）起步**，然后按它是静态、参数、是否带正则、是否可选、是否可重复、是不是通配，分别往上加或往下扣。静态最值钱（+40），参数次之（+20），带自定义正则的参数因为约束更紧所以再 +10，可选和可重复都因为「更宽松」而扣分，通配则直接扣成负数。

注意一个反直觉但合理的点：**带自定义正则的参数（70）比普通参数（60）分更高**。因为 `/:id(\d+)` 明确说了「只接受数字」，比 `/:id` 来者都收要挑剔，自然更该优先。

```ts
const M = 10 // 公共乘数，所有分数都是它的倍数
const SCORE = {
  Segment: 4 * M,            // 40  每个词的基础分
  Static: 4 * M,             // 40  静态加成
  Dynamic: 2 * M,            // 20  参数加成
  BonusCustomRegExp: 1 * M,  // 10  带自定义正则的参数再加
  BonusWildcard: -4 * M - 1 * M, // -50 通配，刻意大得能抵消正则加成
  BonusRepeatable: -2 * M,   // -20 可重复扣分
  BonusOptional: -0.8 * M,   // -8  可选扣分
}

function computeScore(segments: Token[][]): number[][] {
  const score: number[][] = []
  for (const segment of segments) {
    const segScore: number[] = []
    for (const token of segment) {
      let s = SCORE.Segment // 起步分
      if (token.type === 'Static') {
        s += SCORE.Static
      } else {
        const re = token.regexp || '[^/]+?' // 没给正则就用默认的「非斜杠串」
        if (re !== '[^/]+?') s += SCORE.BonusCustomRegExp
        s += SCORE.Dynamic
        if (token.optional) s += SCORE.BonusOptional
        if (token.repeatable) s += SCORE.BonusRepeatable
        if (re === '.*') s += SCORE.BonusWildcard // 只有恰好是 .* 才算通配
      }
      segScore.push(s)
    }
    score.push(segScore)
  }
  return score
}
```

这里要特别盯一眼通配那一行。`/:rest(.*)*` 的正则是 `.*`，它不等于默认的 `[^/]+?`，所以会先被加上正则加成 `+10`；紧接着因为它满足 `re === '.*'`，又被加上 `BonusWildcard = −50`。这个 −50 不是随手定的，它被刻意写成「−4 个乘数，再减掉一个正则加成」——也就是说，它**先把刚才那个 +10 原封不动扣回去，再额外扣 40**。算下来这一段是 `40 + 20 + 10 − 8 − 20 − 50 = −8`，变成负数。这个负分是整个设计里最狠的一手，我们在权衡部分再展开它的意义。

于是三条路由的分数是：

```
/users/new        →  [ [80], [80] ]
/users/:id        →  [ [80], [60] ]
/users/:rest(.*)* →  [ [80], [−8] ]
```

分数是二维的，外层对应段、内层对应段内的词——和拆出来的 token 结构一模一样。这不是巧合，下一节会看到这个「同形」为什么重要。

---

## 第三步：二维分数怎么比——像查字典一样

有了分数，下一步是比大小。但比的不是单个数字，而是二维数组。怎么比？**像查字典比单词那样**：从左到右，一段一段比，第一段就分出胜负就停；第一段打平，再看第二段；段里面也是一个数一个数地比。第一个出现差异的地方，就决定了谁排前面。

这就是字典序。对二维分数来说，是「先比外层段，段内再比内层的数」。而因为是降序（高分在前），每一步算的是 `后者的分数 − 前者的分数`。

```ts
function compareScoreArray(a: number[], b: number[]): number {
  let i = 0
  while (i < a.length && i < b.length) {
    const diff = b[i] - a[i] // 降序：差为正说明 b 更高、该排前
    if (diff) return diff
    i++
  }
  // 段内词数不等时的特判（见下文）
  if (a.length < b.length)
    return a.length === 1 && a[0] === SCORE.Static + SCORE.Segment ? -1 : 1
  else if (a.length > b.length)
    return b.length === 1 && b[0] === SCORE.Static + SCORE.Segment ? 1 : -1
  return 0
}

function isLastNegative(score: number[][]): boolean {
  const last = score[score.length - 1]
  return score.length > 0 && last[last.length - 1] < 0
}

function comparePathParserScore(a: number[][], b: number[][]): number {
  let i = 0
  while (i < a.length && i < b.length) {
    const comp = compareScoreArray(a[i], b[i]) // 逐段比
    if (comp) return comp
    i++
  }
  // 段数刚好差 1、且某一方末段是负分（通配）：要特判
  if (Math.abs(b.length - a.length) === 1) {
    if (isLastNegative(a)) return 1
    if (isLastNegative(b)) return -1
  }
  return b.length - a.length
}
```

拿三条路由的两两比较验证一下字典序：

- `/users/new` vs `/users/:id`：第一段都是 `[80]`，打平；第二段 `[80]` vs `[60]`，`60 − 80 = −20 < 0`，所以 `new` 排前。✓
- `/users/:id` vs `/users/:rest(.*)*`：第二段 `[60]` vs `[−8]`，`−8 − 60 < 0`，所以 `:id` 排前。✓
- 最终顺序：`new` → `:id` → `:rest(.*)*`，通配稳稳垫底。✓

这就是二维分数「镜像 URL 层级」的价值：比较的先后顺序，天然就是「先看前面那段谁更具体，前面打平才轮到后面」。一个一维的单一总分是做不到这一点的——它没法表达「段级优先于段内」。

比较器里还有两处特判，是为了处理「段数对不齐」的边界：

1. **段内词数不等**：比如 `/login`（一段，一个静态词）和 `/login-:x`（一段，静态词 + 参数词）这种前缀咬合的关系。规矩是——如果短的那一方整段就只有一个纯静态词（得分正好是 `Static + Segment = 80`），它排前面；否则长的那一方排前面。这保证了 `/login` 这种「干净写死」的能赢过带参数的变体。
2. **段数差一且末尾为负**：当两条路由的段数恰好差一段，而某一方最后那段是负分（也就是通配），要单独判一下先后。这是给 `/:rest(.*)*` 这类「尾巴上挂个通配」的模式留的后门，免得通配的不正常负分把比较结果带偏。

---

## 把它跑起来：注册即排序，匹配取最高

把上面三个函数加上下面这段主程序，就是一个能跑的最小路由评分器。我们注册本章开头那三条路由（故意打乱顺序，证明与声明顺序无关），算分、排序，再模拟匹配三个不同的 URL：

```ts
// 顺带拼一个最小正则，演示「按分数从高到低试，第一个命中即赢家」
function buildRegex(segments: Token[][]): RegExp {
  let p = '^'
  for (const seg of segments) {
    p += '/'
    for (const t of seg) {
      if (t.type === 'Static') p += t.value
      else p += `(${t.regexp || '[^/]+?'})` // 演示简化：可重复通配按吞掉后续处理
    }
  }
  return new RegExp(p + '/?$')
}

function rank(patterns: string[]) {
  const list = patterns.map(p => ({ pattern: p, segs: tokenizePath(p) }))
  list.forEach(x => (x as any).score = computeScore(x.segs))
  list.forEach(x => (x as any).re = buildRegex(x.segs))
  return list.sort((a, b) => comparePathParserScore((a as any).score, (b as any).score))
}

function match(ranked: ReturnType<typeof rank>, url: string) {
  for (const r of ranked) if ((r as any).re.test(url)) return r.pattern // 第一个命中 = 最高分赢家
  return null
}

// 故意打乱声明顺序
const ranked = rank(['/users/:rest(.*)*', '/users/:id', '/users/new'])

console.log('排序结果（高分在前）:')
for (const r of ranked) console.log('  ', (r as any).score.map((s: number[]) => s.join(',')).join(' | '), '←', r.pattern)

console.log('\n匹配结果:')
for (const url of ['/users/new', '/users/42', '/users/a/b/c'])
  console.log(`  ${url}  →  ${match(ranked, url)}`)
```

跑出来的结果：

```
排序结果（高分在前）:
   80 | 80    ← /users/new
   80 | 60    ← /users/:id
   80 | -8    ← /users/:rest(.*)*

匹配结果:
  /users/new    →  /users/new
  /users/42     →  /users/:id
  /users/a/b/c  →  /users/:rest(.*)*
```

无论你把三条路由按什么顺序塞进去，排序结果永远是 `new` 在最前、`:id` 居中、通配垫底。于是访问 `/users/new` 时，最先试的就是精确的 `/users/new`，一击即中——开头的那个 bug，到这里彻底不存在了。这就是「与声明顺序无关」的具体含义：**正确性不再依赖人的记忆，而是从模式本身长出来**。

配一个最小 `package.json` 就能用 `bun demo.ts` 或 `npx tsx demo.ts` 跑通：

```json
{ "name": "path-ranking-demo", "private": true, "type": "module",
  "scripts": { "demo": "tsx demo.ts" }, "devDependencies": { "tsx": "^4" } }
```

注册期和运行期的分工，可以用一句话流程图收一下：

```
注册期：路径字符串 → 状态机切段切词 → 每个词同步(拼正则 + 算分) → 得到 [正则, 二维分数, 参数键]
        → 按分数字典序插入一张「高分在前」的有序表

运行期：URL → 沿有序表从高到低依次 test 正则 → 第一个命中 = 最具体的赢家 → 从捕获组抽出参数
```

注意注册期才做这些重活（拆词、算分、排序）；到了运行期，每次匹配只剩「挨个 test 正则」这一下，第一个命中就收工。

---

## 关键权衡

上面这些设计不是随便堆出来的，每一处都对应着一个「做了 X 选择 → 换来了 Y → 代价是 Z」。这一章机制比较集中，挑四条最核心的展开。

**① 分数做成二维的（外层段、内层段内的词），而不是压成一个总分。**
换来的是「段级优先、段内其次」的层级化比较语义——能正确分辨 `/a/b` 和 `/a-:b` 这种「段数和段内结构都不同」的模式，一维总分根本区分不了它们，因为两个不同结构可能凑巧加出同一个数。代价是比较器不能简单地比两个数字，得写字典序，还得专门处理段数不等、末尾为负这些边界（就是第三节的两个特判）。这是一个典型的「用比较器的复杂度，换比较语义的精确」。

**② 所有分数都挂在一个公共乘数（10）上、刻意取整。**
换来的是**永远没有浮点比较误差**——两个分数相减要么是 0、要么是整数（或干净的小数），不会出现 `0.1 + 0.2 !== 0.3` 那种折磨人的事，比较结果绝对确定。代价是那些「只想做末位微调、绝不该影响主体排序」的项（比如是否严格模式、是否大小写敏感），只能取极小的值（`0.07 × 10`、`0.025 × 10`），并且要靠注释把它们硬性约束在「不到 0.1 个乘数」的量级之下，免得哪天有人改大了，让一个大小写敏感的 `/login` 反超了 `/users-:id` 这种本该更具体的模式。

**③ 通配（`.*`）用负分，而且这个负分大到刻意抵消掉「带自定义正则」本应带来的加分。**
这是整个评分体系最精巧的一手。通配 `.*` 本质上是个带自定义正则（`.* ≠ 默认的 [^/]+?`）又可重复又可选的参数，按常规它该得正分；但设计者把它的通配加成定成 `−50`，恰好等于「先扣掉那个不该有的 +10 正则加成，再额外扣 40」。换来的是一条铁律：**通配无论怎么搭配，分数永远是负的，永远垫底**——「来者不拒」的模式永远不该赢过任何更具体的模式，这是符合直觉的。代价是分数从此可正可负，比较器不得不专门加一个「末尾是否为负」的特判（第三节的第二处特判），来正确摆放这些负分模式的位置。

**④ 用逐字符的手写状态机做词法分析，而不是写一个巨型正则一把梭。**
换来的是对细节的精确控制：怎么处理转义字符、自定义正则里的嵌套括号边界在哪、修饰符（`?*+`）出现时要不要「退一格」回去重读——这些用一个大正则很难表达清楚，用状态机则每个分支都明明白白。代价是状态分支多、代码可读性下降，新人读起来要跟着状态跳。源码注释也坦白：这是「添加路由时最慢的一步」，但实测已经足够快，所以连缓存都没加——可见选状态机不是为了快，是为了**控制力**。

---

## 小结

这一章回答了两个问题：路径模式的具体性分数怎么来（拆成段和词、每个词按挑剔程度打分），以及两个分数怎么比（二维字典序，段级优先）。把这两件事做到位之后，「多条路由都能匹配同一个 URL 时谁赢」就不再依赖你写它们的顺序，而是从模式本身自然涌现——`/users/new` 永远赢 `/users/:id`，通配永远垫底，结果确定、可预测、可复述。

这份「分数」是后续工作的原料：后面讲匹配表的那一章会拿它做二分插入，维护一张有序表，让运行期匹配只剩一次正则命中。不过在那之前，紧邻的下一章会先转向另一个同样基础的问题——当一次导航走不通（被守卫拦下、被更新的导航顶掉、或者根本是重复请求），怎么把这些「失败」精确分类，而不是笼统地抛一个错误。那是另一块地基。