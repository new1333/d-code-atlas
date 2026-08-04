# URL 分段编码与查询串 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：路由器要不断把"路径段 / 路径参数 / 查询键值 / 哈希"拼成 URL，再从 URL 解析回来。若用一个"对任何位置都一视同仁"的通用编码函数处理，会产生两个麻烦：一是生成的 URL 会被浏览器地址栏按自己的规则再次编码/解码，造成"我拼出的串"和"地址栏显示的串"对不上、甚至来回抖动；二是查询串里"?key"（只有键、没有等号，表示一个开关型标志）与"压根不带这个键"是两种不同的 URL 形态，普通字符串值无法区分这两者。

- **一句话核心思想**：按 URL 所属段（路径 / 参数 / 查询键 / 查询值 / 哈希）分别决定"哪些字符要编码、哪些要保留"，并贴着浏览器的实际行为走，而不是套用一个对任何位置都一样的标准函数。

- **设计动机（为什么需要它）**：浏览器对 URL 标准的实现并不严格——它在做宽松编码时本就不编码一部分标点，且不同浏览器在哈希段对若干符号的处理还不一致。路由器若想保证"我生成的 URL 恰好等于浏览器地址栏会显示的 URL"，就必须放弃"一把通用编码函数走天下"的思路，改为按段细分字符集。查询部分则额外用两个不同的"空值"分别承载"?key（无等号）"与"完全省略"两种语义，把领域规则上提到类型层。本章是全书地基章之一（无前置依赖），后续的"路由位置与 URL 解析"和"新一代路由解析器"都会直接复用本章的编码与查询解析能力——本章把"URL 怎么安全地编/解"这件事一次讲透，后续章只看它们的新侧面（位置语义、匹配控制流），不再重演编码原理。

- **关键权衡**：
  1. **按 URL 段细分保留字符集（而非一刀切编码所有保留字符）** → 换来路径/查询/哈希各段都贴合浏览器实际行为、生成的 URL 可读且不被浏览器二次改写 → 代价是要维护一组分层编码函数与多条"先编码、再还原"的替换链，替换顺序敏感、不直观。
  2. **对齐浏览器实际行为而非严格遵循 URL 标准** → 换来"编码结果与地址栏一致、跨浏览器可预测" → 代价是牺牲了与严格标准工具的互操作可预期性，必须靠注释维护一张"各浏览器差异表"（如某浏览器在哈希段不编码若干符号）。
  3. **用一个宽松的平台编码函数作基底，再按段做"补编码 + 还原"修正** → 换来复用平台能力处理非 ASCII 字符、实现极短 → 代价是写法是"先全编码、再把不该编码的百分号串还原回来"，与直觉相反，容易漏改或改错顺序。
  4. **用两种不同的"空值"分别表达"?key（无等号标志）"与"完全省略"** → 换来用类型精确描述两种 URL 形态、序列化/解析双向无损 → 代价是查询的序列化与归一化逻辑因空值判断而分支增多，调用方必须理解两种空值的细微差别。

- **最小心智模型（3～7 步）**：
  1. 拿到一段要放进 URL 的文本，先判定它属于哪个段（路径 / 路径参数 / 查询键 / 查询值 / 哈希）。
  2. 用一个"宽松基底"对非 ASCII 与通用不安全字符做编码，得到起点串。
  3. 把"这个段里浏览器实际不编码、但基底不小心编码了的符号"还原回来（如方括号、竖线、花括号等）。
  4. 把"会破坏本段语法的符号"补编码：路径段补编码井号与问号；查询段补编码井号与 &、并把空格编成加号、把真实加号先编成百分号串以防混淆；路径参数段再补编码斜杠；查询键再补编码等号。
  5. 解码时统一用平台解码函数，失败则退回原文（容错，不抛异常）。
  6. 解析查询串：按 & 切段、先把加号还原成空格、按等号位置拆键值、无等号记为"标志型空值"、同名键累积成数组。
  7. 序列化查询对象："标志型空值"只输出键（无等号）、"省略型空值"完全跳过、有值则输出 `键=值`。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的 `segEncode(text, segment)`，体现"宽松基底 + 按段补编码/还原"二步法（用一个 `segment` 参数在 path/query/hash 间切换补编码集）；再加一个迷你的 `parse`/`stringify` 查询版，演示"标志型空值 → 输出 `?k`、省略型空值 → 跳过、加号 ↔ 空格"。
  - 应故意省略：五个独立导出函数的全部字符逐项表、非 ASCII 细节、数组值的完整处理、诊断码体系、各浏览器差异的逐字符考据、未来用无原型对象的改造计划。
  - **演示载体建议：首选 TS/JS。** 理由：编码本质就是"字符集分类 + 字符串替换"，TS/JS 能忠实演透且可直接 `bun run`/`node` 跑；本章原仓库语言就是 TS，不依赖任何语言特有语义（无所有权/借用、无元类等），TS/JS 是读者最易跑通的选择。明确写出：这段演示演的是权衡①（按段细分字符集）与权衡④（两种空值二分）。

- **正文不宜展开的细节**：五个导出函数的逐字符对照表；`[ ] | { } ^ \`` 这类"还原项"的标准背景考证；加号在 `application/x-www-form-urlencoded` 里的历史考据；用无原型对象替代普通对象字面量的未来改造计划；诊断码体系与 `__DEV__` 全局开关的来源。

- **推荐的一个执行轨迹例子**：
  - 输入：路径段文本 `a b?c#d`；查询值 `x+y z`；查询对象 `{ flag: 标志型空值, gone: 省略型空值, q: 'a&b' }`。
  - 路径段：宽松基底得 `a%20b?c#d` → 补编码 `?`、`#` → `a%20b%3Fc%23d`。
  - 查询值：真实 `+` 先编成百分号串得 `x%2By z` → 空格编成 `+` 得 `x%2By+z`。
  - 序列化查询对象 → `flag&q=a%26b`（flag 无等号、gone 被完全省略、`a&b` 里的 & 被补编码）。
  - 反向解析 `flag&q=a%26b` → `{ flag: 标志型空值, q: 'a&b' }`，与输入语义一致。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- **按 URL 段细分保留字符集**：不同段需要编码的字符不同——Path 编码 `␣ " < > # ? { }`；Query 编码 `␣ " < > # & =`；Hash 编码 `␣ " < > \``。源码位置: packages/router/src/encoding.ts:3-19
- **对齐浏览器而非严格标准**：注释明确指出浏览器在做宽松编码时不编码 `!'()*`（whatwg/url#369），故只留 ASCII 字母数字 + `-._~` 才"最安全"；且不同浏览器在哈希段对 `"<>{}` 处理不一致。源码位置: packages/router/src/encoding.ts:9-19
- **宽松基底函数**：用平台 `encodeURI` 作起点（不编码 URL 通用分隔符），再把"基底不小心编码、但浏览器实际保留"的 `|` `[` `]` 还原。`null/undefined` 输入直接得空串。源码位置: packages/router/src/encoding.ts:61-69
- **哈希段编码**：基底之上再把 `{` `}` `^` 还原（哈希段这些字符浏览器不编码）。源码位置: packages/router/src/encoding.ts:77-82
- **路径段编码**：基底之上补编码会破坏路径语法的 `#` 与 `?`。源码位置: packages/router/src/encoding.ts:121-123
- **路径参数段编码**：路径之上再补编码 `/`，防参数值穿越路径段边界。源码位置: packages/router/src/encoding.ts:134-136
- **查询值编码**：先把真实 `+` 编成 `%2B`、再把空格编成 `+`（与表单传统一致）、再补编码 `#` `&`，并还原 `` ` `` `{` `}` `^`。源码位置: packages/router/src/encoding.ts:91-104
- **查询键编码**：查询值之上再补编码 `=`，防键里的等号破坏 `键=值` 结构。源码位置: packages/router/src/encoding.ts:111-113
- **加号为何这样处理**：标准只在 `application/x-www-form-urlencoded` 提到 `+` 表示空格，多数浏览器在查询里保留 `+`；作者选择"对加号更宽容"——空格编成 `+`、真实加号额外编成 `%2B` 以便区分。源码位置: packages/router/src/encoding.ts:29-42
- **解码容错**：用 `decodeURIComponent`，失败时 catch、走诊断码 `VUE_ROUTER_R0080` 报告、返回原文而非抛异常。源码位置: packages/router/src/encoding.ts:148-158；诊断定义见 packages/router/src/diagnostics.ts:226-230
- **标志型空值的语义**：归一化后的查询值类型为 `string | null`，`null` 表示"参数存在但没有 `=`"（即 `?key`）。例：`?isNull&isEmpty=&other=other` → `{ isNull: null, isEmpty: '', other: 'other' }`。源码位置: packages/router/src/query.ts:5-18
- **省略型空值的语义**：定义查询时的原始值类型多了 `undefined`，`undefined` 表示"移除该值"。源码位置: packages/router/src/query.ts:19-24
- **解析查询串**：接受带或不带前导 `?`；空串或单独 `?` 直接返回空对象；按 `&` 切段、每段先把 `+` 还原成空格、按第一个 `=` 拆键值、无 `=` 则值为 `null`；同名键累积成数组。源码位置: packages/router/src/query.ts:56-84
- **序列化查询串**：不前置 `?`（对齐 `URLSearchParams`）；键用查询键编码；`null` 只输出键（无 `=`），`undefined` 完全省略；数组里的 `undefined` 被跳过、`null` 保留。源码位置: packages/router/src/query.ts:95-124
- **归一化查询**：把原始查询对象转成归一化形态——数字转字符串、删除值为 `undefined` 的键、数组里的 `undefined` 替换成 `null`。源码位置: packages/router/src/query.ts:134-152
- **`isArray` 即平台能力别名**：就是 `Array.isArray` 的类型化包装，供解析/序列化判断是否数组值。源码位置: packages/router/src/utils/index.ts:70-72

## 关键调用链
分层编码自底向上：
`encodeParam` → `encodePath` → `commonEncode` → 平台 `encodeURI`（+ 还原 `|[ ]`）
`encodeQueryKey` → `encodeQueryValue` → `commonEncode`
哈希：`encodeHash` → `commonEncode`
查询串往返：
`stringifyQuery` → `encodeQueryKey` / `encodeQueryValue`
`parseQuery` → `decode`（失败 → `diagnostics.VUE_ROUTER_R0080`）
`normalizeQuery` 独立完成 Raw→Normalized 转换，不触碰编码函数。
源码位置: packages/router/src/encoding.ts:61-136；packages/router/src/query.ts:56-152

## 源码摘录（带行号，全文累计 ≤ 30 行）

基底：宽松编码后把浏览器实际保留的 `|` `[` `]` 还原（演权衡①③）：
```ts
// encoding.ts:61-69
export function commonEncode(text: string | number | null | undefined): string {
  // 0 must become '0'
  return text == null
    ? ''
    : encodeURI('' + text)
        .replace(ENC_PIPE_RE, '|')
        .replace(ENC_BRACKET_OPEN_RE, '[')
        .replace(ENC_BRACKET_CLOSE_RE, ']')
}
```
路径段：基底之上补编码会破坏路径的 `#` `?`（演权衡①"按段补编码"）：
```ts
// encoding.ts:121-123
export function encodePath(text: string | number | null | undefined): string {
  return commonEncode(text).replace(HASH_RE, '%23').replace(IM_RE, '%3F')
}
```
路径参数段：路径之上再补编码 `/`，防穿越段边界：
```ts
// encoding.ts:134-136
export function encodeParam(text: string | number | null | undefined): string {
  return encodePath(text).replace(SLASH_RE, '%2F')
}
```
查询值段：真实 `+` 先编码、空格编成 `+`、再补编码 `#` `&`（演权衡①+加号处理）：
```ts
// encoding.ts:91-99（节选，后续另有还原项省略）
  return commonEncode(text)
    .replace(PLUS_RE, '%2B')
    .replace(ENC_SPACE_RE, '+')
    .replace(HASH_RE, '%23')
    .replace(AMPERSAND_RE, '%26')
```
序列化时两种空值的分流：`null` 只输出键（无 `=`），`undefined` 完全省略（演权衡④）：
```ts
// query.ts:100-106
    if (value == null) {
      // only null adds the value
      if (value !== undefined) {
        search += (search.length ? '&' : '') + key
      }
      continue
    }
```

## 易混淆 / 边界 / 推断
- **事实**：同一字符在不同段命运不同。`{` `}` `^` `` ` `` 在路径段（`encodePath`）是**编码**的（基底编码后未还原），但在哈希段和查询值段被**还原**为明文；`|` `[` `]` 则在所有段都被还原。源码位置: packages/router/src/encoding.ts:61-104, 121-123
- **事实**：`+` 的处理是查询段独有的特殊逻辑——空格在查询里编成 `+`（而非 `%20`），这是与表单/旧系统兼容的历史选择；路径/哈希段无此处理（空格走基底的 `%20`）。源码位置: packages/router/src/encoding.ts:91-104 vs 121-123
- **事实**：当前查询对象用普通对象字面量 `{}`，代码注释留有 TODO："在下一个 major 版本用 `Object.create(null)`"。这意味着当前实现存在原型链边界（如键名为 `__proto__`、`constructor` 时的潜在风险），属已知待改进项。源码位置: packages/router/src/query.ts:57, 137
- **推断**：作者选择 `null` 表示"无等号标志"、`undefined` 表示"移除"，是因为这两种"缺失"语义不同且都需要一个值来承载——两个不同的语义必须映射到两个不同的空值；这也是为什么归一化后只保留 `null`（`undefined` 在归一化时被删除）。标注为推断。
- **推断**：encoding.ts:20-21 那段被注释掉的 `EXTRA_RESERVED_RE`/`encodeReservedReplacer`，是一套"额外编码 `!'()*` 以更贴近严格标准"的更安全方案，但当前被禁用——推断为作者优先选择了"对齐浏览器、URL 更可读"而非"严格安全"。标注为推断。
- **未理解**：encoding.ts 注释提到"某些浏览器把 `\` 转成 `/`"，故 `\` 应编码——但当前各编码函数未见对 `\` 的显式 `replace`，推断它是由基底 `encodeURI` 自动编码（`encodeURI` 会把 `\` 编成 `%5C`），故无需额外处理；若确如此则属隐式依赖基底的行为，未在代码中显式体现。标注为未完全核实。