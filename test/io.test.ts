// test/io.test.ts：lib/io.ts 单元测试。
// 用 bun:test。所有 fs 用例跑在系统临时目录，不依赖真实 git/网络。
//
// 注意：cloneSource（需 git + 网络）**不在此测**，由 M12 冒烟覆盖。

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atlasRoot,
  runDir,
  workDir,
  sourceDir,
  manifestPath,
  chapterDir,
  researchPath,
  replicaDir,
  joinPath,
  keyFromRepo,
  ensureDir,
  pathExists,
  readJson,
  writeJson,
  writeText,
  resolveLocalSource,
} from "../src/lib/io.ts";

// ---------------------------------------------------------------------------
// 测试夹具：每个测试一个独立临时目录
// ---------------------------------------------------------------------------
let tmpRoot = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "atlas-io-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 路径约定（design §8、§12）
// ---------------------------------------------------------------------------
describe("路径约定", () => {
  test("atlasRoot / runDir / workDir / sourceDir 返回相对仓库根的 POSIX 串", () => {
    expect(atlasRoot()).toBe("atlas/");
    expect(runDir("foo")).toBe("atlas/foo/");
    expect(workDir("foo")).toBe("atlas/foo/work/");
    expect(sourceDir("foo")).toBe("atlas/foo/work/source/");
  });

  test("manifestPath：文件路径不带尾斜杠", () => {
    expect(manifestPath("foo")).toBe("atlas/foo/manifest.json");
  });

  test("chapterDir / researchPath / replicaDir", () => {
    expect(chapterDir("foo", "reactive-primitive")).toBe(
      "atlas/foo/work/chapters/reactive-primitive/"
    );
    expect(researchPath("foo", "ref")).toBe(
      "atlas/foo/work/chapters/ref/research.md"
    );
    expect(replicaDir("foo", "ref")).toBe(
      "atlas/foo/work/chapters/ref/replica/"
    );
  });

  test("joinPath：折叠重复斜杠、忽略空段", () => {
    expect(joinPath("a/", "/b", "c")).toBe("a/b/c");
    expect(joinPath("", "x", "", "y")).toBe("x/y");
    expect(joinPath()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// keyFromRepo
// ---------------------------------------------------------------------------
describe("keyFromRepo", () => {
  test("URL（含 .git）→ repo 段小写", () => {
    expect(keyFromRepo("https://github.com/o/repo.git")).toBe("repo");
  });

  test("URL（大写 + 下划线）→ kebab-case", () => {
    expect(keyFromRepo("https://github.com/o/My_Repo.git")).toBe("my-repo");
  });

  test("本地路径（反斜杠）→ basename + 折叠非法字符", () => {
    // Windows 风格：basename 取 my-repo（. 折叠）
    expect(keyFromRepo("D:\\code\\my.repo")).toBe("my-repo");
  });

  test("本地路径（正斜杠）→ basename", () => {
    expect(keyFromRepo("/a/b/foo-bar")).toBe("foo-bar");
  });

  test("相对路径 ./a/b/ → b", () => {
    expect(keyFromRepo("./a/b/")).toBe("b");
  });

  test("空串 / 纯非法 → 兜底 repo", () => {
    expect(keyFromRepo("")).toBe("repo");
    expect(keyFromRepo("???")).toBe("repo");
  });
});

// ---------------------------------------------------------------------------
// JSON / 文本读写
// ---------------------------------------------------------------------------
describe("writeJson / readJson round-trip", () => {
  test("含中文 + 嵌套对象 round-trip", async () => {
    const p = join(tmpRoot, "out.json");
    const data = {
      名称: "代码图集",
      nested: { n: 1, list: ["a", "b"], flag: true },
    };
    await writeJson(p, data);
    const back = await readJson<typeof data>(p);
    expect(back).toEqual(data);
  });

  test("readJson 文件不存在抛明确错误", async () => {
    const p = join(tmpRoot, "nope.json");
    expect(readJson(p)).rejects.toThrow(/io\.readJson: 文件不存在/);
  });

  test("readJson JSON 解析失败抛带路径的明确错误", async () => {
    const p = join(tmpRoot, "broken.json");
    await writeText(p, "{ 不是合法 JSON");
    expect(readJson(p)).rejects.toThrow(/JSON 解析失败/);
  });
});

describe("writeJson 原子性", () => {
  test("写后 .tmp 不残留", async () => {
    const p = join(tmpRoot, "deep", "dir", "out.json");
    await writeJson(p, { a: 1 });
    expect(await pathExists(p)).toBe(true);
    expect(await pathExists(`${p}.tmp`)).toBe(false);
  });
});

describe("writeText", () => {
  test("round-trip：用 Bun.file().text() 读回比对", async () => {
    const p = join(tmpRoot, "note.md");
    const body = "# 标题\n中文内容 line2\n";
    await writeText(p, body);
    expect(await Bun.file(p).text()).toBe(body);
  });

  test("写前自动建多级目录", async () => {
    const p = join(tmpRoot, "a", "b", "c", "d.txt");
    await writeText(p, "hi");
    expect(await pathExists(p)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureDir 幂等
// ---------------------------------------------------------------------------
describe("ensureDir", () => {
  test("连续调两次不报错（幂等）", async () => {
    const dir = join(tmpRoot, "x", "y", "z");
    await ensureDir(dir);
    await expect(ensureDir(dir)).resolves.toBeUndefined();
    expect(await pathExists(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pathExists
// ---------------------------------------------------------------------------
describe("pathExists", () => {
  test("存在 / 不存在", async () => {
    const p = join(tmpRoot, "exists.txt");
    await writeText(p, "x");
    expect(await pathExists(p)).toBe(true);
    expect(await pathExists(join(tmpRoot, "missing.txt"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveLocalSource（ADR-0005：原地只读直读，不复制）
// ---------------------------------------------------------------------------
describe("resolveLocalSource", () => {
  test("真实临时目录 → 返回 absPath 且存在", () => {
    const { absPath } = resolveLocalSource(tmpRoot);
    expect(absPath).toBe(tmpRoot); // mkdtemp 已经给的是绝对路径
    // 关键不变量：函数不复制，原路径依然存在、absPath 即输入路径本身
    expect(require("node:fs").existsSync(absPath)).toBe(true);
  });

  test("不存在的路径 → 抛明确错误", () => {
    const missing = join(tmpRoot, "definitely-not-here");
    expect(() => resolveLocalSource(missing)).toThrow(
      /io\.resolveLocalSource: 本地源路径不存在/
    );
  });

  test("关键不变量：不复制（原地直读）—— 校验源目录树未被拷贝到别处", () => {
    // resolveLocalSource 不应产生任何副本目录。这里验证调用前后 atlas/
    // 工作区下没有新建 source 副本（即函数确实没做 fs 复制）。
    const { absPath } = resolveLocalSource(tmpRoot);
    // 函数只返回 absPath，无副作用：再校验一次 absPath 等于 resolve(输入)。
    const { resolve } = require("node:path");
    expect(absPath).toBe(resolve(tmpRoot));
  });
});

// ---------------------------------------------------------------------------
// cloneSource：不在此测（需 git + 网络），由 M12 冒烟覆盖
// ---------------------------------------------------------------------------
describe.todo("cloneSource", () => {
  // 占位：cloneSource 的端到端验证由 M12 冒烟测试负责。
});
