/**
 * Surveyor agent (design §5.1). Read-only. Surveys the source tree and returns
 * a repo-map JSON object via stdout; the orchestrator writes it to
 * work/repo-map.json (ADR-0005: read-only agents can't write their own output).
 *
 * The source is always exposed at `work/source/` relative to the agent's cwd
 * (URL → git clone there; local → directory junction there). So the agent
 * reads `work/source` uniformly — no --add-dir, no sandbox complications.
 */
import { runClaude, type RunClaudeOptions } from "../lib/run-claude.ts";
import { withJsonRetry } from "../lib/retry.ts";

export interface RepoMap {
  root: string;
  sourceKind: "git-clone" | "local";
  languages: string[];
  frameworks: string[];
  entrypoints: string[];
  manifests: string[];
  packages: { name: string; path: string }[];
  tree: { path: string; type: "dir" | "file"; role?: string }[];
  docs: string[];
}

export interface SurveyorInput {
  /** Run dir = atlas/{key} — agent's cwd. */
  cwd: string;
  sourceKind: "git-clone" | "local";
  model?: string;
}

export interface SurveyorResult {
  cmd: string;
  durationMs: number;
  repoMap: RepoMap;
}

/**
 * Normalize whatever the agent returned into our strict RepoMap schema.
 * The LLM emits highly variable shapes across runs (top-level vs nested under
 * `repo`/`structure`, flat arrays vs nested trees, language names vs
 * extensions, `files` vs `tree`). Rather than fight the model, we coerce
 * defensively by searching known locations — this keeps the engine robust to
 * prompt drift.
 */
function normalizeRepoMap(raw: unknown, sourceKind: "git-clone" | "local"): RepoMap {
  if (!raw || typeof raw !== "object") {
    throw new Error("surveyor returned non-object repo-map");
  }
  const obj = raw as Record<string, any>;
  const repo = (obj.repo && typeof obj.repo === "object") ? obj.repo : {};
  const structure = (obj.structure && typeof obj.structure === "object") ? obj.structure : {};

  // --- languages: search several locations, map names → extensions
  const langCandidates: string[] = [
    ...(Array.isArray(obj.languages) ? obj.languages : []),
    ...(Array.isArray(repo.languages) ? repo.languages : []),
    ...(Array.isArray(repo.primaryLanguage) ? repo.primaryLanguage : []),
    ...(typeof repo.language === "string" ? [repo.language] : []),
    ...(typeof repo.primaryLanguage === "string" ? [repo.primaryLanguage] : []),
  ];
  const languages = uniqueStrings(
    langCandidates.map(langToExt).filter((x: string) => x.length > 0),
  );

  // --- entrypoints
  const entrypoints = uniqueStrings([
    ...(Array.isArray(obj.entrypoints) ? obj.entrypoints : []),
    ...(Array.isArray(repo.entryPoints) ? repo.entryPoints : []),
    ...(Array.isArray(repo.entrypoints) ? repo.entrypoints : []),
    ...(Array.isArray(structure.entryPoints) ? structure.entryPoints : []),
    ...(typeof repo.main === "string" ? [repo.main] : []),
    ...(typeof repo.module === "string" ? [repo.module] : []),
    ...(typeof repo.entry === "string" ? [repo.entry] : []),
  ]);

  // --- manifests
  const manifests = uniqueStrings([
    ...(Array.isArray(obj.manifests) ? obj.manifests : []),
    ...(Array.isArray(repo.manifests) ? repo.manifests : []),
    ...(typeof repo.manifest === "string" ? [repo.manifest] : []),
  ]);

  // --- tree: try flat array, nested tree, or files[] lists in many locations;
  // if all fail, recursively harvest any object that has a `path`/`name` field.
  let tree: RepoMap["tree"] = [];
  const treeSources = [obj.tree, repo.tree, structure.tree];
  for (const t of treeSources) {
    if (Array.isArray(t)) {
      tree = t.map(normalizeTreeEntry).filter(Boolean) as RepoMap["tree"];
      break;
    }
    if (t && typeof t === "object") {
      tree = normalizeNestedTree(t);
      if (tree.length > 0) break;
    }
  }
  // fallback: files[] arrays (each entry { path, ... })
  if (tree.length === 0) {
    const filesSources = [obj.files, repo.files, structure.files, obj.sourceFiles];
    for (const f of filesSources) {
      if (Array.isArray(f)) {
        tree = f.map(normalizeTreeEntry).filter(Boolean) as RepoMap["tree"];
        if (tree.length > 0) break;
      }
    }
  }
  // last resort: recursively walk the whole object for anything with a path.
  if (tree.length === 0) {
    tree = harvestPaths(raw);
  }

  // --- docs
  const docs = uniqueStrings(Array.isArray(obj.docs) ? obj.docs : []);

  // --- languages fallback: if agent gave none, derive from tree file exts
  let langsFinal = languages;
  if (langsFinal.length === 0 && tree.length > 0) {
    const exts = new Set<string>();
    for (const e of tree) {
      const m = e.path.match(/\.([a-z0-9]+)$/i);
      if (m) exts.add(m[1]!.toLowerCase());
    }
    langsFinal = [...exts];
  }

  return {
    root: typeof obj.root === "string" && obj.root ? obj.root : "work/source",
    sourceKind,
    languages: langsFinal,
    frameworks: Array.isArray(obj.frameworks) ? obj.frameworks : [],
    entrypoints,
    manifests,
    packages: Array.isArray(obj.packages) ? obj.packages : [],
    tree,
    docs,
  };
}

/** Map language names / extensions to short lowercase extension form. */
function langToExt(l: any): string {
  if (typeof l !== "string") return "";
  const s = l.toLowerCase().replace(/^\./, "");
  const map: Record<string, string> = {
    typescript: "ts",
    javascript: "js",
    tsx: "tsx",
    jsx: "jsx",
    python: "py",
    go: "go",
    rust: "rs",
    java: "java",
    json: "json",
    markdown: "md",
    html: "html",
    css: "css",
    scss: "scss",
    vue: "vue",
    svelte: "svelte",
  };
  return map[s] ?? s;
}

function uniqueStrings(arr: string[]): string[] {
  return [...new Set(arr.filter((x) => typeof x === "string" && x.length > 0))];
}

function normalizeTreeEntry(e: any): RepoMap["tree"][number] | null {
  if (!e || typeof e !== "object") return null;
  const path = e.path ?? (e.name ? e.name : null);
  if (typeof path !== "string") return null;
  const type = e.type === "dir" || e.type === "directory" ? "dir" : "file";
  const role = typeof e.role === "string" ? e.role : undefined;
  return { path, type, ...(role ? { role } : {}) };
}

/**
 * Recursively walk an arbitrary object and harvest anything that looks like a
 * file/dir entry (has a string `path` or `name`). Last-resort normalizer for
 * wildly-shaped agent output.
 */
function harvestPaths(node: any): RepoMap["tree"] {
  const out: RepoMap["tree"] = [];
  const visit = (n: any) => {
    if (!n) return;
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (typeof n === "object") {
      const entry = normalizeTreeEntry(n);
      if (entry) out.push(entry);
      for (const v of Object.values(n)) visit(v);
    }
  };
  visit(node);
  // dedupe by path
  const seen = new Set<string>();
  return out.filter((e) => {
    if (seen.has(e.path)) return false;
    seen.add(e.path);
    return true;
  });
}

/** Flatten a nested tree { name, type, children: [...] } into a path list. */
function normalizeNestedTree(node: any, prefix = ""): RepoMap["tree"] {
  if (!node || typeof node !== "object") return [];
  const out: RepoMap["tree"] = [];
  const isDir = node.type === "dir" || node.type === "directory" || Array.isArray(node.children);
  const name = typeof node.name === "string" ? node.name : "";
  // emit self only if it has a meaningful name (skip root ".")
  if (name && name !== ".") {
    const path = prefix ? `${prefix}/${name}` : name;
    out.push({ path, type: isDir ? "dir" : "file" });
    if (Array.isArray(node.children)) {
      for (const c of node.children) {
        out.push(...normalizeNestedTree(c, path));
      }
    }
  } else if (Array.isArray(node.children)) {
    // root node: emit children with no prefix
    for (const c of node.children) {
      out.push(...normalizeNestedTree(c, prefix));
    }
  }
  return out;
}

export async function runSurveyor(input: SurveyorInput): Promise<SurveyorResult> {
  // The source always lives at work/source relative to cwd.
  const sourceRel = "work/source";
  const userPrompt = [
    `Survey the repository at \`${sourceRel}/\` (relative to your working directory) and return the repo-map JSON.`,
    ``,
    `Echo these values verbatim in your output:`,
    `- "root": "${sourceRel}"`,
    `- "sourceKind": "${input.sourceKind}"`,
    ``,
    `Use your read-only tools (Glob, Read, Grep) to inspect the tree under ${sourceRel}.`,
    `Return ONLY the JSON object described in your role instructions — no prose, no markdown fences.`,
  ].join("\n");

  const opts: RunClaudeOptions = {
    role: "surveyor",
    userPrompt,
    cwd: input.cwd,
    readOnly: true,
    model: input.model,
    timeoutMs: 5 * 60 * 1000,
  };

  const { value: raw, cmd, durationMs } = await withJsonRetry({
    label: "surveyor",
    maxAttempts: 2,
    run: async (feedback) => {
      const o = feedback
        ? { ...opts, userPrompt: `${userPrompt}\n\n${feedback}` }
        : opts;
      const r = await runClaude(o);
      return { resultText: r.resultText, cmd: r.cmd, durationMs: r.durationMs };
    },
  });
  const repoMap = normalizeRepoMap(raw, input.sourceKind);
  return { cmd, durationMs, repoMap };
}
