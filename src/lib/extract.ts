// lib/extract.ts：从 claude stdout 中提取产物内容的纯函数辅助。
// 对应 design §5（分析类 Agent 把产物以 fenced stdout 文本块返回，由 agent 层提取）。
//
// 角色 prompt（surveyor/architect/critic/reader）的「输出契约」约定：
//   最终回复 = 一段被 ```{lang} fence 包裹的文本块（fence 外无正文）。
//   - surveyor/architect/critic：```json fence，内含 JSON
//   - reader：```markdown fence，内含 research.md 全文
//
// 本模块负责从 stdout 里定位**第一个**目标 fence，提取 fence 内文本（不含 fence 行）。
// 全程纯函数、零 IO、零副作用，便于单测覆盖各种边界。
//
// 容错策略（design §15 错误处理与降级）：
//   - 找不到目标 fence → 返回 null（交上层 ok=false 处理，不抛）。
//   - JSON.parse 失败 → 返回 null。
//   - 退化兜底：extractJson 在没有 json fence 时，尝试把整个 stdout 当 JSON parse
//     （应对模型偶尔不加 fence 的情况；记 source="fallback" 以示区别）。

/**
 * 从 stdout 中提取**第一个**形如 ` ```{lang} ... ``` ` 的 fence **内**文本。
 *
 * 匹配规则（CommonMark 对齐）：
 *   - fence 起始行：3 个及以上反引号 + 可选空格 + 语言标记（语言标记大小写不敏感，
 *     如 `json`/`JSON`/`Json` 都认；允许同行尾随字符）。
 *   - fence 结束行：**仅由 ≥ 起始反引号数量的反引号构成的行**（可带首尾空格）。
 *     这条「结束 fence 反引号数 ≥ 起始」的规则是正确处理**嵌套代码块**的关键——
 *     例如 reader 的 research.md 用 ````markdown（4 反引号）外层包裹时，内部
 *     的 ```ts（3 反引号）代码块不会被误判为外层结束。
 *   - 返回内容**不含** fence 起始/结束行本身，trim 首尾空白。
 *
 * 多个同 lang 顶层 fence 时取**第一个**（角色 prompt 约定「最终回复只含一个 fence 块」）。
 *
 * 限制（CommonMark 同级嵌套本身是病态输入）：若外层与内层都用相同反引号数
 * （如都 3 个），内层结束行会满足「≥」条件而提前闭合——这是同级嵌套无法消除的
 * 歧义；解法是让外层用更多反引号（reader 的 user prompt 已要求 4 反引号外层）。
 *
 * @param stdout claude 的原始 stdout
 * @param lang   语言标记（如 `"json"`/`"markdown"`/`"ts"`），大小写不敏感匹配
 * @returns fence 内文本（已 trim）；找不到返回 `null`
 */
export function extractFence(stdout: string, lang: string): string | null {
  if (typeof stdout !== "string" || typeof lang !== "string" || lang === "") {
    return null;
  }

  // 转义 lang 用于正则（处理 `c++` 这类特殊字符；本工程实际只有字母）。
  const langEsc = lang.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // 1) 定位起始 fence 行：行首可选空白 + 3+ 反引号 + lang（大小写不敏感）+ 行内任意尾随。
  //    捕获反引号 run（组 1）以便后续按其长度约束结束 fence。
  const openRe = new RegExp(
    "^[ \\t]*(`{3,})" + langEsc + "[^\\n]*\\n",
    "im",
  );
  const openM = stdout.match(openRe);
  if (!openM) return null;

  const openBackticks = openM[1]; // 起始反引号 run（如 "```" 或 "````"）
  const openLen = openBackticks.length;
  // 起始 fence 行之后的内容起始位置（match[0] 含末尾换行）。
  const contentStart = (openM.index ?? 0) + openM[0].length;

  // 2) 从 contentStart 起向后找**第一个**满足「行内仅 ≥ openLen 个反引号（+可选空白）」
  //    的行作为结束 fence。即结束 fence 的反引号数 >= 起始数（CommonMark 规则）。
  const tail = stdout.slice(contentStart);
  // 构造结束行正则：行首可选空白 + (>=openLen 个反引号) + 行尾可选空白。
  //   反引号数下限用 `{openLen,}` 表达。
  const closeRe = new RegExp(
    "^[ \\t]*`{" + openLen + ",}[ \\t]*(?:\\r?\\n|$)",
    "m",
  );
  const closeM = tail.match(closeRe);
  if (!closeM) return null; // 无结束 fence → 不算合法 fence

  const contentEndInTail = closeM.index ?? 0;
  const inner = tail.slice(0, contentEndInTail);

  // trim 首尾空白（fence 内文档可能带前导换行）。
  return inner.replace(/^\s+|\s+$/g, "");
}

/**
 * 提取 JSON 的来源标记（便于诊断 / 测试断言）。
 *   - "fence"：从 ```json fence 提取后 parse 成功
 *   - "fallback"：没有 fence，整个 stdout 当 JSON parse 成功（兜底）
 *   - "none"：提取失败
 */
export type JsonSource = "fence" | "fallback" | "none";

/**
 * 提取结果的扩展形态（带来源标记，便于诊断与测试）。
 */
export interface ExtractJsonResult<T> {
  /** 解析后的值；失败时为 null。 */
  value: T | null;
  /** 提取来源（fence / fallback / none）。 */
  source: JsonSource;
}

/**
 * 从 stdout 提取 JSON 对象并 parse。
 *
 * 流程：
 *   1. 先 `extractFence(stdout, "json")`；命中则 parse，成功 → source="fence"。
 *   2. 未命中 fence 时，退化把**整个 stdout trim 后当 JSON parse**（兜底，
 *      应对模型偶尔不加 fence）；成功 → source="fallback"。
 *   3. 都失败 → value=null、source="none"。
 *
 * parse 失败一律返回 null（不抛），交上层 ok=false 处理（design §15 不抛原则）。
 *
 * @param stdout claude 的原始 stdout
 * @returns 简单版：`T | null`（仅返回值）
 */
export function extractJson<T = unknown>(stdout: string): T | null {
  return extractJsonDetailed<T>(stdout).value;
}

/**
 * extractJson 的详细版：额外返回来源标记（fence/fallback/none）。
 * 便于测试断言「走了哪条路径」与日志诊断。
 */
export function extractJsonDetailed<T = unknown>(stdout: string): ExtractJsonResult<T> {
  if (typeof stdout !== "string") {
    return { value: null, source: "none" };
  }

  // 1) 优先从 ```json fence 提取。
  const fenced = extractFence(stdout, "json");
  if (fenced !== null) {
    try {
      return { value: JSON.parse(fenced) as T, source: "fence" };
    } catch {
      // fence 内非合法 JSON：落入 fallback 再试整串。
    }
  }

  // 2) 兜底：整个 stdout trim 后当 JSON parse。
  const trimmedAll = stdout.trim();
  if (trimmedAll !== "") {
    try {
      return { value: JSON.parse(trimmedAll) as T, source: "fallback" };
    } catch {
      // 整串也 parse 不了 → none。
    }
  }

  return { value: null, source: "none" };
}

/**
 * Critic 的评审结论（critic-outline / critic-chapter 输出契约）。
 * verdict ∈ approve/reject；fixes 为字符串数组（approve 时为空）。
 */
export interface CriticVerdict {
  /** 评审判定：approve（4 条标准全过）/ reject（任一不过）。 */
  verdict: "approve" | "reject";
  /** 修改点列表：approve 时为空数组；reject 时为具体可执行的修改点。 */
  fixes: string[];
}

/**
 * 从 stdout 提取 Critic 的 `{verdict, fixes}` 结论并校验。
 *
 * 校验规则（critic-*.md §4 字段约束）：
 *   - verdict 必须是 `"approve"` 或 `"reject"`（小写）；否则返回 null。
 *   - fixes 必须是数组且元素均为字符串；否则返回 null。
 *
 * 解析失败（无 JSON / 非法 JSON）返回 null，交上层 ok=false。
 *
 * @param stdout claude 的原始 stdout（critic 角色回复）
 * @returns 校验通过的 `{verdict, fixes}`；失败返回 null
 */
export function extractCriticVerdict(stdout: string): CriticVerdict | null {
  const parsed = extractJson<unknown>(stdout);
  if (parsed === null || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  const fixes = obj.fixes;

  // verdict 枚举校验。
  if (verdict !== "approve" && verdict !== "reject") return null;

  // fixes 类型校验：必须是数组，且元素全是字符串。
  if (!Array.isArray(fixes)) return null;
  for (const f of fixes) {
    if (typeof f !== "string") return null;
  }

  return { verdict, fixes: fixes as string[] };
}
