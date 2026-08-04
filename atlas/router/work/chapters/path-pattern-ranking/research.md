# 路径模式编译与优先级评分 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：多个路由模式常常同时能匹配同一个 URL——`/users/new` 既匹配 `/users/new` 也匹配 `/users/:id`。早期路由库靠「声明顺序」决定谁赢：用户必须记得「更具体的写在前面」，一旦把 `/users/:id` 写在 `/users/new` 之前，`new` 就被当成 `:id` 的值吞掉，路由进错误组件，且极难排查。顺序成了悬在用户头上的隐性正确性负担。

- **一句话核心思想**：把「谁更该匹配」从「用户写的顺序」搬到「模式本身有多具体」——编译每个模式时同步算出一份具体性分数，按分数从高到低匹配，让结果自明且与声明顺序无关。

- **设计动机（为什么需要它）**：声明顺序方案把语义正确性外包给了人的记忆；评分方案把「具体性」编码进模式编译产物本身，让带静态片段的模式天然高于带动态参数的模式，无需用户操心排序。换来的能力是：路由表可按任意顺序增删，匹配结果始终确定、可预测、可复述。本章是全书地基章之一（无前置依赖），它产出的「分数」是后续「路由匹配表」章的前置原料——那里会拿这份分数做二分插入维持一张有序表，运行期只剩一次正则命中。本章只讲「分数如何从模式派生、如何比较」，不涉及表的构建。

- **关键权衡**：
  1. **让分数结构是二维的（外层对应 URL 的段、内层对应段内的子片）→ 换来「先比段、再比段内」的层级化匹配语义，能正确区分 `/a/b` 与 `/a-:b` 这类一维分数无法分辨的模式 → 代价是比较器变复杂，要专门处理段数不等、末尾为负分等边界。**
  2. **所有分数都挂在一个公共乘数上、刻意取整 → 换来无浮点误差的精确比较 → 代价是那些「只作微调、不该影响主体排序」的项（是否严格、是否大小写敏感）只能取极小的值，并被注释硬性约束在「不足以撼动主排序」的量级之下。**
  3. **通配（匹配任意路径段）用负分，且该负分大到刻意抵消掉「带自定义正则」本应带来的加分 → 换来「通配永远垫底、无论如何都最不具体」的稳固语义 → 代价是分数可正可负，比较器必须特判「末尾是否为负」来定前后。**
  4. **（推断）用逐字符的手写状态机做词法分析、而非一个巨型正则 → 换来对转义、嵌套自定义正则边界、修饰符回看的精确控制 → 代价是状态分支较多、可读性下降。** 源码注释也点明这是添加路由时最慢的一步、但已足够快，故未加缓存。

- **最小心智模型（3～7 步）**：
  1. 把路径模式字符串逐字符喂给一个状态机，遇到 `/` 就切段；每一段产出一组词法单元（静态串 / 动态参数 / 带自定义正则的参数）。
  2. 编译：把每个单元翻译成正则片段，首尾加锚、段间补斜杠，拼成一条完整正则（含按顺序的捕获组），供运行期一次 `test` 命中。
  3. 同步算分：每个单元按「静态 > 带正则的参数 > 普通参数 > 可选 > 可重复 > 通配」的尺度打分，写入与段结构同形的二维分数。
  4. 注册时用一个字典序比较器对分数排序，把新路由插进一张「高分在前」的有序表。
  5. 匹配时从高到低依次 `test`，第一个命中的就是「最具体」的赢家。
  6. parse 从捕获组抽出参数（可重复的按斜杠拆成数组）；stringify 反向把参数拼回 URL。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个从零的「词法 → 编译正则 → 算二维分数 → 字典序比较」最小实现，演透「同一 URL 下，具体性分数如何消解歧义」。重点演两条权衡：① 二维分数的字典序比较（段级优先于段内）；② 通配负分让通配模式永远垫底。给一组对照路由（如 `/users/new` vs `/users/:id` vs `/users/:rest(.*)*`），打印各自的分数与最终命中顺序。
  - 应故意省略：转义状态分支、严格/大小写敏感/是否匹配到末尾三选项的正则边界差异、参数拼回时的斜杠去重、未启用的「分组」单元、以及把编译产物接到父子路由树上的装配代码。
  - 演示载体建议：**首选 TS/JS**。本章核心是纯算法与数据结构（状态机词法、整数分数计算、二维字典序比较），TS/JS 能忠实演透，配最小 `package.json` 即可用 `node`/`bun` 跑通；本 Atlas 产物本身是 JS 生态站点，TS/JS 演示对读者最友好。无需退回其它语言——原仓库就是 TS。

- **正文不宜展开的细节**：转义分支如何让静态段容纳字面量的特殊字符；自定义正则内嵌套括号的处理（源码留有 TODO、仅靠转义收尾括号支撑）；严格/末尾/大小写三选项如何微调正则锚与微调分数；拼回 URL 时多个可选参数缺失的斜杠去重；「分组」单元类型已定义但词法器不会产出；编译产物如何挂上父子与别名关系。

- **推荐的一个执行轨迹例子**：
  - 输入：注册 `/users/:id` 与 `/users/new`（任意顺序）。
  - 词法：`/users/:id` → 两段，第二段是「动态参数 id」；`/users/new` → 两段，第二段是「静态 new」。
  - 算分：两模式第一段都是「静态 users」（同分）；第二段——`:id` 得动态分、`new` 得静态分，静态 > 动态。
  - 比较：第一段同分，看第二段，静态高于动态 → `/users/new` 排前。
  - 匹配 `/users/new`：先测 `/users/new` 的正则 → 命中 → 赢家。即便 `/users/:id` 先注册也不受影响——这就是「与声明顺序无关」。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 词法器把路径切成二维结构：外层数组 = 段（按 `/` 切），段内 = 一组词法单元。这一二维结构是后续「二维分数」的同形基础。源码位置: packages/router/src/matcher/pathTokenizer.ts:46,65
- 三种单元类型：静态、参数、分组；但「分组」类型虽已定义，词法器里没有任何分支会产出它——属于预留未实现。源码位置: packages/router/src/matcher/pathTokenizer.ts:1-5,28-33
- 五状态字符级状态机：静态、参数、参数正则、参数正则收尾、转义下一字符。逐字符推进，靠 `buffer`（累积值）与 `customRe`（自定义正则缓冲）两个累加器交接。源码位置: packages/router/src/matcher/pathTokenizer.ts:7-13,63-82
- 修饰符语义在「消费缓冲」时一次性解读：`*` = 可选且可重复、`?` = 仅可选、`+` = 仅可重复；且可重复参数必须独占一个段（否则报错）。源码位置: packages/router/src/matcher/pathTokenizer.ts:97-107
- 自定义正则的边界靠「遇 `)` 即结束」判定，但若 `)` 前一个字符是 `\`（被转义）则保留并继续累积——这是对嵌套正则的有限支持，源码以 TODO 标注其语义未定。源码位置: packages/router/src/matcher/pathTokenizer.ts:157-171
- 默认参数模式是 `[^/]+?`（非贪婪、不吃斜杠）；带自定义正则的参数会先 `new RegExp` 校验合法性再使用。源码位置: packages/router/src/matcher/pathParserRanker.ts:93,169-180
- 评分体系：所有分数都是一个公共乘数（10）的倍数，刻意取整以避免浮点比较误差；其中「严格」「大小写敏感」两个微调项被注释硬性约束在「不足 0.1 个乘数」的量级，确保它们只做末位微调、不撼动主体排序。源码位置: packages/router/src/matcher/pathParserRanker.ts:103-117
- 实际具体性排序（按默认非敏感选项、每段基础分 40 计）：根 `/`(90) > 纯静态(80) > 带正则参数(70) > 普通参数(60) > 可选参数(52) > 可重复参数(40) > 可选且可重复(32) > 通配(−8)。注意：带自定义正则的参数(70) 比普通参数(60) 更具体。源码位置: packages/router/src/matcher/pathParserRanker.ts:148-200
- 通配是唯一能让分数变负的单元：其负分大到刻意抵消「带自定义正则」本应加的分（注释原文「we remove the bonus added by the custom regexp」），从而保证通配无论如何都最不具体。源码位置: packages/router/src/matcher/pathParserRanker.ts:111,200
- 分数是二维 `Array<number[]>`：外层每项对应一个段、内层是该段各单元的得分——结构镜像 URL 的段/子片层级。源码位置: packages/router/src/matcher/pathParserRanker.ts:136,209
- 比较是字典序：先逐段比（外层），段内再逐单元比（内层），`b[i]-a[i]` 即降序（高分在前），首个非零差即定序。源码位置: packages/router/src/matcher/pathParserRanker.ts:305-310,341-350
- 段数不等时的特判：若较短一方只含一个「静态单元」（如纯 `/login`），则短的排前；否则长的排前——用于裁决 `/a` 与 `/a-:b` 这类前缀关系。源码位置: packages/router/src/matcher/pathParserRanker.ts:317-325
- 外层段数差 1 时，若某方末尾单元得分为负（即通配/splat），需特判其先后；这是为尾部 `/:rest(.*)*` 这类 splat 设计。源码位置: packages/router/src/matcher/pathParserRanker.ts:351-357,366-375
- parse 从正则捕获组抽参数：可重复参数按 `/` 拆成数组、可选参数缺失为空串；stringify 反向遍历段拼回 URL，并处理可选参数缺失时的斜杠去重。源码位置: packages/router/src/matcher/pathParserRanker.ts:227-285
- 装配层把「词法 + 编译」串到路由记录上：一次 `tokensToParser(tokenizePath(record.path), options)` 即产出含正则/分数/参数键/双向函数的完整匹配器，再挂上父子与别名关系；DEV 下检测同名参数并告警。源码位置: packages/router/src/matcher/pathMatcher.ts:21-31
- 别名不与实体混入父的 children：用 `!aliasOf === !aliasOf` 双方同为/同不为别名才挂载，因 children 顺序在「添加路由」时用于传 originalRecord。源码位置: packages/router/src/matcher/pathMatcher.ts:41-47

## 关键调用链

注册期（编译）：
createRouteRecordMatcher(record, parent, options)
  → tokenizePath(record.path)                       // 字符级状态机 → 二维 Token[][]
  → tokensToParser(segments, options)               // 编译出 { re, score, keys, parse, stringify }
  → 挂载 record/parent/children/alias              // 装配成 RouteRecordMatcher

排序期（消费 score）：
comparePathParserScore(a, b)
  → 逐段 compareScoreArray(a.score[i], b.score[i])  // 字典序：段级优先，段内逐单元
  → 长度不等时按「末尾是否为负 / 是否单静态段」特判

运行期（匹配）：
按 score 降序遍历匹配器表 → matcher.re.test(path) 命中 → matcher.parse(path) 抽 params

源码位置: packages/router/src/matcher/pathMatcher.ts:21 / pathParserRanker.ts:129,305,337 / pathTokenizer.ts:46

## 源码摘录（带行号，全文累计 ≤ 30 行）

用途：演「具体性评分体系」如何把『静态>正则>动态>可选>可重复>通配』编码成可比的整数，以及通配负分如何抵消正则加分（服务钩子权衡 2、3）。

```ts
// packages/router/src/matcher/pathParserRanker.ts:103-117
const enum PathScore {
  _multiplier = 10,
  Root = 9 * _multiplier, // just /
  Segment = 4 * _multiplier, // /a-segment
  SubSegment = 3 * _multiplier, // /multiple-:things-in-one-:segment
  Static = 4 * _multiplier, // /static
  Dynamic = 2 * _multiplier, // /:someId
  BonusCustomRegExp = 1 * _multiplier, // /:someId(\\d+)
  BonusWildcard = -4 * _multiplier - BonusCustomRegExp, // /:namedWildcard(.*) we remove the bonus added by the custom regexp
  BonusRepeatable = -2 * _multiplier, // /:w+ or /:w*
  BonusOptional = -0.8 * _multiplier, // /:w? or /:w*
  // these two have to be under 0.1 so a strict /:page is still lower than /:a-:b
  BonusStrict = 0.07 * _multiplier,
  BonusCaseSensitive = 0.025 * _multiplier,
}
```

用途：演状态机如何把修饰符字符一次性解读成参数语义、并用「必须独占一段」的硬约束保护可重复参数（服务钩子权衡 4、心智模型步骤 1）。

```ts
// packages/router/src/matcher/pathTokenizer.ts:96-107
      if (segment.length > 1 && (char === '*' || char === '+'))
        crash(
          `A repeatable param (${buffer}) must be alone in its segment. eg: '/:ids+.`
        )
      segment.push({
        type: TokenType.Param,
        value: buffer,
        regexp: customRe,
        repeatable: char === '*' || char === '+',
        optional: char === '*' || char === '?',
      })
```

## 易混淆 / 边界 / 推断

- 事实：分数比较是「段级字典序优先」——先比外层段，第一段同分才看第二段。这意味着 `/users/profile`（两段都静态）会赢 `/users/:id`（第二段动态），但前缀不同的模式在第一段就已分胜负。
- 事实：通配（`(.*)*` 形态）是唯一产生负分的单元，得 −8 分（段基础 40 + 动态 20 + 正则 10 − 可选 8 − 可重复 20 − 通配 50）。这也是 `isLastScoreNegative` 特判存在的根因。
- 事实：「分组」单元类型在类型层已定义（含递归的子单元数组），但词法器的状态机里没有任何分支会产出它——属预留能力，当前路径模式不支持分组。
- 易混淆：本章 summary 措辞「静态>动态>正则>通配」不够精确。按实际分数，**带自定义正则的参数(70) 高于 普通动态参数(60)**，正确排序见「概念要点」。Writer 行文时建议用「静态 > 带正则参数 > 普通参数 > 可选 > 可重复 > 通配」。
- 推断（标注为推断）：选择手写字符级状态机而非正则做词法，是为了精确处理转义、自定义正则的嵌套括号边界、以及修饰符的「回退一字符」回看；同时源码注释提到「添加路由最慢的就是这一步、但已足够快、故未加缓存」，可旁证性能并非采用状态机的主因、而是控制力。
- 推断：二维 score 结构与段/子片同形，是有意「让比较顺序镜像 URL 层级」——使「段更具体的优先」这一语义自然成立，而非偶然。
- 未理解：自定义正则内含嵌套括号（如 `:p(?:prefix_([^/]+)_suffix)`）目前仅靠「转义收尾 `)`」勉强支持，源码以 TODO 标注「是否值得正式支持嵌套正则」尚未定论；其行为边界未在本章三个文件内完全确定。