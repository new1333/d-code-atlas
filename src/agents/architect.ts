/**
 * Architect agent (design §5.2). Produces the chapter outline DAG.
 *
 * ADR-0005 keeps the Source read-only, but the Architect writes its OWN output
 * `work/outline.json` directly (writing to work/ is explicitly allowed). This
 * is more reliable than asking a read-only agent to emit JSON via stdout — the
 * model writes structured files far more reliably than it emits JSON-only
 * messages. The orchestrator reads the file back after the call.
 *
 * Tools: Read/Glob/Grep + Write/Edit, cwd = run dir. It can write work/ but
 * must not write work/source/ — the prompt forbids it and we verify NFR-2
 * (source unchanged) in acceptance.
 */
import { runClaude, type RunClaudeOptions } from "../lib/run-claude.ts";
import { extractJson } from "../lib/extract.ts";

export interface OutlineChapter {
  slug: string;
  title: string;
  layer: "primitive" | "composite" | "system";
  dependsOn: string[];
  sourceFiles: string[];
  summary: string;
}

export interface Outline {
  repo: string;
  chapters: OutlineChapter[];
}

export interface ArchitectInput {
  cwd: string;
  /** Previous Critic feedback to incorporate (revision rounds). */
  feedback?: string;
  model?: string;
}

export interface ArchitectResult {
  cmd: string;
  durationMs: number;
  outline: Outline;
}

export async function runArchitect(input: ArchitectInput): Promise<ArchitectResult> {
  const userPrompt = [
    `Read \`work/repo-map.json\` and survey the source under \`work/source/\` to design the bottom-up chapter outline.`,
    ``,
    `**Deliverable**: use your Write tool to create \`work/outline.json\` containing the outline JSON (shape per your role instructions). The orchestrator reads that file. Do NOT modify anything under \`work/source/\`.`,
    ``,
    `After writing the file, reply with a one-line confirmation.`,
    input.feedback
      ? `\n## Previous Critic feedback (revise to address ALL of these)\n${input.feedback}`
      : "",
  ].join("\n");

  const opts: RunClaudeOptions = {
    role: "architect",
    userPrompt,
    cwd: input.cwd,
    readOnly: false, // may Write work/outline.json (its own output); never work/source/
    model: input.model,
    timeoutMs: 8 * 60 * 1000,
  };

  const r = await runClaude(opts);
  if (process.env.ATLAS_DEBUG) {
    console.error("[architect:DEBUG] result head:\n" + r.resultText.slice(0, 500));
  }
  // The architect may write outline.json (preferred) OR emit the outline as
  // markdown prose (this model often does). Try the file first, then parse
  // JSON from the message, then parse the markdown structure as a last resort.
  const { readJson, pathExists, artifactPaths } = await import("../lib/io.ts");
  const key = input.cwd.split(/[\\/]/).pop()!;
  let rawJson: unknown | null = null;
  const outFile = artifactPaths.outline(key);
  if (await pathExists(outFile)) {
    try {
      rawJson = await readJson<unknown>(outFile);
    } catch {
      /* file not valid JSON */
    }
  }
  if (rawJson === null) {
    try {
      const parsed = extractJson<unknown>(r.resultText);
      // only trust message-JSON if it actually looks like an outline
      // (has a chapters array); otherwise the model embedded some other object
      // and we should fall through to markdown parsing.
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).chapters)) {
        rawJson = parsed;
      }
    } catch {
      /* no JSON in message — try markdown parse below */
    }
  }
  let outline: Outline;
  if (rawJson !== null) {
    outline = normalizeOutline(rawJson);
  } else {
    // Last resort: the architect wrote a rich markdown outline. Parse its
    // structure (### headings + Layer annotations + per-chapter files) into
    // the chapter DAG. This embraces the model's natural output format.
    outline = parseMarkdownOutline(r.resultText);
    if (outline.chapters.length === 0) {
      throw new Error(
        `architect produced no outline.json, no JSON message, and no parseable markdown outline. message head: ${r.resultText.slice(0, 300)}`,
      );
    }
    console.warn(`[architect] parsed ${outline.chapters.length} chapters from markdown prose (no JSON emitted)`);
  }
  if (process.env.ATLAS_DEBUG) {
    console.error(`[architect:DEBUG] normalized ${outline.chapters.length} chapters`);
  }
  return { cmd: r.cmd, durationMs: r.durationMs, outline };
}

/**
 * Parse the architect's markdown outline into the Outline schema.
 *
 * Recognized heading patterns (the model is consistent across runs):
 *   ### 第 N 章 · {title} —— `file.ts`（Layer {n}）
 *   ### {N}. {title} —— `file.ts` (Layer primitive/composite/system)
 *   ### 序章/终章 · {title} —— `file.ts`
 *
 * Each chapter's primary source file is named in the heading. Layer is taken
 * from the heading annotation or derived from the chapter's stated dependency
 * depth. dependsOn is derived from the explicit "Layer" grouping: chapters at
 * a higher layer depend on all chapters at lower layers that precede them in
 * reading order — a conservative, acyclic approximation that the topo sort
 * then finalizes.
 */
function parseMarkdownOutline(md: string): Outline {
  const lines = md.split(/\r?\n/);
  const rawChapters: {
    title: string;
    file: string | null;
    layerRaw: string | null;
    body: string[];
  }[] = [];
  let current: (typeof rawChapters)[number] | null = null;

  // heading patterns for a chapter
  const headingRe =
    /^#{2,4}\s+(?:第\s*\d+\s*章|[序终]章|chapter\s*\d+|\d+[.、])\s*[·•\-—:：]?\s*(.+)$/i;

  for (const line of lines) {
    if (headingRe.test(line)) {
      // push previous
      if (current) rawChapters.push(current);
      const headingText = line.replace(/^#{2,4}\s+/, "");
      const { title, file, layer } = splitHeading(headingText);
      current = { title: title.trim(), file, layerRaw: layer, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) rawChapters.push(current);

  // filter out non-chapter headings (toc, "章节大纲" etc.) by requiring a file
  // or substantive body
  const real = rawChapters.filter(
    (c) => c.file || c.body.join("").trim().length > 30,
  );

  const chapters: OutlineChapter[] = real.map((c, idx) => {
    const slug = slugify(c.title) || `chapter-${idx + 1}`;
    const layer = mapLayer(c.layerRaw);
    // collect any additional source files mentioned in the body (backticks)
    const files = new Set<string>();
    if (c.file) files.add(c.file);
    for (const bl of c.body) {
      const m = bl.match(/`([^`]+\.[a-z]{2,5})`/gi);
      if (m) for (const f of m) files.add(f.replace(/`/g, ""));
    }
    return {
      slug,
      title: c.title.replace(/[（(].*$/, "").trim(),
      layer,
      dependsOn: [], // derived below from layer + order
      sourceFiles: [...files].map(normalizeFilePath).filter((f) => f.length > 0),
      summary: firstSentence(c.body.join(" ")) || c.title,
    };
  });

  // derive dependsOn: a chapter depends on all chapters at a strictly lower
  // layer that appear earlier in reading order. Conservative + acyclic.
  const layerRank: Record<OutlineChapter["layer"], number> = {
    primitive: 0,
    composite: 1,
    system: 2,
  };
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]!;
    const myRank = layerRank[ch.layer];
    ch.dependsOn = chapters
      .slice(0, i)
      .filter((prev) => layerRank[prev.layer] < myRank)
      .map((prev) => prev.slug);
    // if a chapter has no lower-layer predecessors, depend on the immediately
    // preceding chapter (keeps a reading thread) — but only if one exists
    if (ch.dependsOn.length === 0 && i > 0) {
      ch.dependsOn = [chapters[i - 1]!.slug];
    }
  }

  return { repo: extractRepoName(md), chapters };
}

function splitHeading(h: string): {
  title: string;
  file: string | null;
  layer: string | null;
} {
  // file in backticks
  const fileMatch = h.match(/`([^`]+)`/);
  const file = fileMatch ? fileMatch[1]! : null;
  // layer annotation: "Layer 0/1/2/3" or "Layer primitive/composite/system" or "L0"
  const layerMatch = h.match(/L(?:ayer)?\s*([0-3]|primitive|composite|system)/i);
  let layer: string | null = null;
  if (layerMatch) {
    const v = layerMatch[1]!.toLowerCase();
    layer = ["primitive", "composite", "system", "system"][parseInt(v)] ?? v;
    if (isNaN(parseInt(v))) layer = v;
  }
  // title = text before the file/layer annotations
  let title = h;
  if (fileMatch) title = h.slice(0, h.indexOf(fileMatch[0]!));
  title = title.replace(/[—\-–:：].*$/, "").replace(/[（(].*$/, "").trim();
  return { title: title || h, file, layer };
}

function mapLayer(raw: string | null): OutlineChapter["layer"] {
  if (!raw) return "composite";
  const r = raw.toLowerCase();
  if (r === "primitive" || r === "0") return "primitive";
  if (r === "system" || r === "2" || r === "3") return "system";
  return "composite";
}

function slugify(title: string): string {
  // prefer english words if present; else use pinyin-ish fallback (hash)
  const english = title.match(/[a-zA-Z][a-zA-Z0-9-]+/g);
  if (english && english.length > 0) {
    return english.join("-").toLowerCase().slice(0, 60);
  }
  // no english — produce a short stable slug from char codes
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  }
  return `chapter-${Math.abs(h).toString(36).slice(0, 6)}`;
}

function normalizeFilePath(f: string): string {
  // strip surrounding path noise; keep src/... form
  let s = f.replace(/^\.?\//, "").replace(/`/g, "").trim();
  // if it's just a bare filename like "signal.ts", prefix src/
  if (!s.includes("/")) s = `src/${s}`;
  return s;
}

function firstSentence(text: string): string {
  const clean = text.replace(/[*`#\->\n]/g, " ").replace(/\s+/g, " ").trim();
  const m = clean.match(/[^。.!！?？]+[。.!！?？]?/);
  return m ? m[0]!.trim().slice(0, 200) : clean.slice(0, 200);
}

function extractRepoName(md: string): string {
  const m = md.match(/(?:repo|仓库|代码库)[:：\s]+[`*]?([a-zA-Z0-9_.-]+)/i);
  return m ? m[1]! : "";
}

/** Coerce agent output into strict Outline shape (robust to drift). */
function normalizeOutline(raw: unknown): Outline {
  if (!raw || typeof raw !== "object") {
    throw new Error("architect returned non-object outline");
  }
  const obj = raw as Record<string, any>;
  // accept top-level chapters OR { outline: { chapters } }
  let chaptersRaw: any[] = Array.isArray(obj.chapters)
    ? obj.chapters
    : Array.isArray((obj as any).outline?.chapters)
      ? (obj as any).outline.chapters
      : [];
  const chapters: OutlineChapter[] = [];
  const knownSlugs = new Set<string>();
  for (const c of chaptersRaw) {
    if (!c || typeof c !== "object") continue;
    const slug = typeof c.slug === "string" ? c.slug : "";
    if (!slug) continue;
    const layer = ["primitive", "composite", "system"].includes(c.layer)
      ? c.layer
      : "composite";
    chapters.push({
      slug,
      title: typeof c.title === "string" ? c.title : slug,
      layer,
      dependsOn: Array.isArray(c.dependsOn) ? c.dependsOn.filter((d: any) => typeof d === "string") : [],
      sourceFiles: Array.isArray(c.sourceFiles) ? c.sourceFiles.filter((f: any) => typeof f === "string") : [],
      summary: typeof c.summary === "string" ? c.summary : "",
    });
    knownSlugs.add(slug);
  }
  // drop dangling dependsOn refs (robustness; Critic will also flag)
  for (const c of chapters) {
    c.dependsOn = c.dependsOn.filter((d) => knownSlugs.has(d) && d !== c.slug);
  }
  return { repo: typeof obj.repo === "string" ? obj.repo : "", chapters };
}
