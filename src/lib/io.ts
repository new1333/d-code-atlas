/**
 * Path conventions + atomic JSON IO + run-key derivation + source acquisition.
 * See design.md §3 (lib/io.ts), §4 Stage 1 (Acquire), §10 (read-only isolation).
 */
import { spawn } from "bun";
import { resolve, normalize } from "node:path";
import { cpSync, rmSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Paths — all normalized to OS-native absolute form (node:path) so that
// claude's sandbox reliably matches cwd against --add-dir entries.
// ---------------------------------------------------------------------------

/** Root of all runs. Lives at <repo>/atlas/. */
export const atlasRoot = (): string => {
  // import.meta.dir = .../src/lib ; strip the trailing src/lib
  const raw = import.meta.dir.replace(/[/\\]src[/\\]lib$/, "");
  return normalize(resolve(raw));
};

/** Directory for one run: atlas/{key}/. */
export const runDir = (key: string): string =>
  normalize(resolve(atlasRoot(), "atlas", key));

/** Workspace dir: atlas/{key}/work/. */
export const workDir = (key: string): string =>
  normalize(resolve(runDir(key), "work"));

/** Cloned source: atlas/{key}/work/source/ (null for local-path runs). */
export const sourceDir = (key: string): string =>
  normalize(resolve(workDir(key), "source"));

/** Site output: atlas/{key}/site/. */
export const siteDir = (key: string): string =>
  normalize(resolve(runDir(key), "site"));

/** Manifest: atlas/{key}/manifest.json (NOT under work/ — see design §8.3). */
export const manifestPath = (key: string): string =>
  normalize(resolve(runDir(key), "manifest.json"));

/** Shared artifact paths inside work/. */
export const artifactPaths = {
  repoMap: (key: string) => normalize(resolve(workDir(key), "repo-map.json")),
  outline: (key: string) => normalize(resolve(workDir(key), "outline.json")),
  chapter: (key: string, slug: string) =>
    normalize(resolve(workDir(key), "chapters", slug)),
  research: (key: string, slug: string) =>
    normalize(resolve(workDir(key), "chapters", slug, "research.md")),
  draft: (key: string, slug: string) =>
    normalize(resolve(workDir(key), "chapters", slug, "draft.md")),
  replicaDir: (key: string, slug: string) =>
    normalize(resolve(workDir(key), "chapters", slug, "replica")),
};

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

export async function ensureDir(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
}

/** Recursive remove, tolerant of missing path (node:fs based). */
export async function rmrf(path: string): Promise<void> {
  rmSync(path, { recursive: true, force: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return (await Bun.file(path).json()) as T;
}

/**
 * Atomic JSON write: write to {path}.tmp, fsync-less rename over target.
 * Prevents "half-written file" being mistaken for a complete artifact
 * (ADR-0002's reason for preferring manifest over file-existence).
 */
export async function writeJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  const text = JSON.stringify(data, null, 2);
  await Bun.write(tmp, text);
  // rename = atomic on same filesystem
  await Bun.$`mv -f ${tmp} ${path}`.quiet();
}

export async function readText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

export async function writeText(path: string, text: string): Promise<void> {
  await Bun.write(path, text);
}

// ---------------------------------------------------------------------------
// Run key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable run key from a Repository Source.
 *  - URL: take the repo segment (last path part, strip .git).
 *  - Local path: take basename.
 * Then slugify: lowercase, [a-z0-9-]+ only.
 *
 * Per CONTEXT.md "Run": same-named repos share/overwrite the same run dir
 * (intentional MVP trade-off — simplicity over collision avoidance).
 */
export function runKey(repoInput: string): string {
  let raw: string;
  if (/^https?:\/\//i.test(repoInput) || /^git@/i.test(repoInput)) {
    // URL: take last path segment, strip trailing .git
    const noGit = repoInput.replace(/\.git$/i, "").replace(/\/$/, "");
    const segs = noGit.split(/[\/:]/);
    raw = segs[segs.length - 1] || "repo";
  } else {
    // Local path: basename, no extension stripping (dirs have none usually)
    const clean = repoInput.replace(/[\\/]+$/, "");
    const segs = clean.split(/[\\/]/);
    raw = segs[segs.length - 1] || "repo";
  }
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "repo";
}

/** Detect whether a source input is a URL (clone) vs local path. */
export function isUrlSource(repoInput: string): boolean {
  return /^https?:\/\//i.test(repoInput) || /^git@/i.test(repoInput);
}

// ---------------------------------------------------------------------------
// Source acquisition (Stage 1, no agent — design §4)
// ---------------------------------------------------------------------------

export type AcquireResult =
  | { kind: "git-clone"; cmd: string; sourcePath: string }
  | {
      kind: "local";
      /** Where agents read from: the work/source copy (inside cwd). */
      sourcePath: string;
      /** The real local path on disk (for manifest + NFR-2 verification). */
      realPath: string;
      cmd: string;
    };

/**
 * Acquire source.
 *  - URL: `git clone --depth 1 <url> work/source`.
 *  - Local: copy the source tree into work/source.
 *
 * Why a copy for local sources (design said "in-place read"): claude's
 * headless sandbox hard-blocks access to anything outside the session cwd —
 * including --add-dir entries and symlinks/junctions (it resolves real paths).
 * Copying into work/source (inside cwd) makes local and URL paths uniform and
 * sidesteps the sandbox entirely. NFR-2 still holds: the *source directory* is
 * never written to — only read once for the copy.
 *
 * Returns the command string for manifest logging (AC-7).
 */
export async function acquireSource(
  key: string,
  repoInput: string,
): Promise<AcquireResult> {
  const dest = sourceDir(key);
  await ensureDir(workDir(key));
  // remove stale source (clone dir or copy) so re-runs are clean
  await rmrf(dest);

  if (isUrlSource(repoInput)) {
    const cmd = `git clone --depth 1 ${repoInput} ${dest}`;
    const proc = Bun.spawn(["git", "clone", "--depth", "1", repoInput, dest], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git clone failed (exit ${exitCode}): ${stderr}`);
    }
    return { kind: "git-clone", cmd, sourcePath: dest };
  }

  // local: resolve real absolute path, then copy into work/source
  const realPath = resolve(repoInput);
  if (!(await pathExists(realPath))) {
    throw new Error(`local source path does not exist: ${realPath}`);
  }
  const cmd = `copy ${realPath} -> ${dest}`;
  // node:fs.cpSync is cross-platform and reliable (Bun's shell cp crashed).
  cpSync(realPath, dest, { recursive: true });
  return { kind: "local", sourcePath: dest, realPath, cmd };
}
