/**
 * 归档模型层：类型之外的每一个纯函数都在这里钉住。
 *
 * 这一层最贵的错误不是崩，而是**和后端悄悄分叉**：`normalizeArchivePath` 与 Rust 的
 * `select::normalize` 差一个 '.' 段，勾选就永远匹配不上（tar 包里 `./a/b/` 满地都是）；
 * `singleRootName` 差一个"只有一个条目时不剥壳"，用户就会在目标目录里找不到东西。
 * 这些都没有报错，只有"点了没反应"。所以断言里成对写着两边的口径。
 */
import { describe, expect, it } from "vitest";

import {
  archiveBreadcrumbs,
  archiveSegments,
  buildArchiveTree,
  childrenAt,
  collectEntryPaths,
  compareByName,
  conflictMessage,
  defaultArchiveName,
  describeArchiveError,
  dirFirstThen,
  findNode,
  formatEta,
  formatSpeed,
  formatVolumeSize,
  fsBaseName,
  isJobRunning,
  joinArchivePath,
  joinFsPath,
  jobPercent,
  jobStatus,
  jobTitle,
  levelBoundsFor,
  normalizeArchivePath,
  parentArchivePath,
  parseVolumeSize,
  parseVolumeSizeStrict,
  packedSizeKnown,
  phaseLabel,
  searchEntries,
  singleRootName,
  stripLastExtension,
  VOLUME_PRESETS,
  type ArchiveEntry,
  type ArchiveProgress,
  type FormatOption,
} from "../src/utils/archiveModel";

function entry(path: string, over: Partial<ArchiveEntry> = {}): ArchiveEntry {
  const segs = path.split("/").filter(Boolean);
  const isDir = over.isDir ?? path.endsWith("/");
  return {
    index: 0,
    path: normalizeArchivePath(path),
    name: over.name ?? segs[segs.length - 1] ?? "",
    isDir,
    size: 0,
    packed: 0,
    modified: 0,
    method: "",
    encrypted: false,
    crc: 0,
    comment: "",
    symlinkTarget: "",
    ...over,
    // 归一化后的路径不带尾斜杠，isDir 才是唯一的判据
  };
}

function progress(over: Partial<ArchiveProgress> = {}): ArchiveProgress {
  return {
    jobId: "j1",
    kind: "extract",
    phase: "working",
    archive: "D:/a/movie.rar",
    dest: "D:/a/movie",
    entry: "",
    entriesDone: 0,
    entriesTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    percent: -1,
    speedBps: 0,
    message: "",
    ...over,
  };
}

describe("归档内路径归一化（与 Rust select::normalize 同口径）", () => {
  it("统一分隔符、去首尾斜杠、去 '.' 段", () => {
    expect(normalizeArchivePath("./a/b/")).toBe("a/b");
    expect(normalizeArchivePath("a\\b")).toBe("a/b");
    expect(normalizeArchivePath("/a/b")).toBe("a/b");
    expect(normalizeArchivePath("a/./b")).toBe("a/b");
    expect(normalizeArchivePath("a//b")).toBe("a/b");
    expect(normalizeArchivePath("")).toBe("");
    expect(normalizeArchivePath("/")).toBe("");
  });

  it("不吞掉 '..'：那是越界，交给后端 guard 拒，不是这里悄悄改写成别的路径", () => {
    expect(normalizeArchivePath("a/../b")).toBe("a/../b");
  });

  it("拆段 / 取父 / 拼接", () => {
    expect(archiveSegments("a/b/c.txt")).toEqual(["a", "b", "c.txt"]);
    expect(archiveSegments("")).toEqual([]);
    expect(parentArchivePath("a/b/c.txt")).toBe("a/b");
    expect(parentArchivePath("top.txt")).toBe("");
    expect(joinArchivePath("a", "b/c")).toBe("a/b/c");
    expect(joinArchivePath("", "b")).toBe("b");
    expect(joinArchivePath("a", "")).toBe("a");
  });

  it("面包屑第一项恒为归档根，path 是空串", () => {
    expect(archiveBreadcrumbs("")).toEqual([{ name: "根目录", path: "" }]);
    expect(archiveBreadcrumbs("a/b")).toEqual([
      { name: "根目录", path: "" },
      { name: "a", path: "a" },
      { name: "b", path: "a/b" },
    ]);
  });
});

describe("建树", () => {
  it("zip 里只有文件条目时，目录是合成出来的，大小自底向上汇总", () => {
    const tree = buildArchiveTree([
      entry("a/b.txt", { size: 100 }),
      entry("a/c.txt", { size: 50 }),
      entry("top.txt", { size: 7 }),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["a", "top.txt"]);
    const a = tree[0];
    expect(a.entry).toBeUndefined(); // 合成目录没有对应条目
    expect(a.size).toBe(150);
    expect(a.children.map((n) => n.name)).toEqual(["b.txt", "c.txt"]);
  });

  it("真实目录条目用后端给的汇总值，不在前端再加一遍（否则翻倍）", () => {
    const tree = buildArchiveTree([
      entry("a/", { isDir: true, size: 999 }), // mod.rs::rollup_dir_sizes 已经算过
      entry("a/b.txt", { size: 100 }),
    ]);
    expect(tree[0].entry).toBeDefined();
    expect(tree[0].size).toBe(999);
  });

  it("空目录的真实汇总值是 0，也不能被合成逻辑当成'还没算'去覆盖", () => {
    const tree = buildArchiveTree([entry("empty/", { isDir: true, size: 0 })]);
    expect(tree[0].entry).toBeDefined();
    expect(tree[0].size).toBe(0);
    expect(tree[0].children).toEqual([]);
  });

  it("先见文件后来目录条目：补全元信息，但保留已经挂上去的 children", () => {
    const tree = buildArchiveTree([
      entry("a/b.txt", { size: 10 }),
      entry("a/", { isDir: true, size: 10, modified: 1700000000, method: "Store" }),
    ]);
    const a = tree[0];
    expect(a.children.map((n) => n.name)).toEqual(["b.txt"]);
    expect(a.modified).toBe(1700000000);
    expect(a.method).toBe("Store");
    expect(a.entry).toBeDefined();
  });

  it("childrenAt / findNode 走的是名字逐层下钻", () => {
    const tree = buildArchiveTree([entry("a/b/c.txt", { size: 1 })]);
    expect(childrenAt(tree, "").map((n) => n.name)).toEqual(["a"]);
    expect(childrenAt(tree, "a").map((n) => n.name)).toEqual(["b"]);
    expect(childrenAt(tree, "a/b").map((n) => n.name)).toEqual(["c.txt"]);
    expect(childrenAt(tree, "不存在")).toEqual([]);
    expect(findNode(tree, "a/b/c.txt")?.isDir).toBe(false);
    expect(findNode(tree, "a/zzz")).toBeUndefined();
  });

  it("collectEntryPaths 跳过合成目录：那条路径后端没有，传过去只会白匹配", () => {
    const tree = buildArchiveTree([entry("a/b.txt", { size: 1 })]);
    expect(collectEntryPaths(tree[0])).toEqual(["a/b.txt"]);
  });
});

describe("排序", () => {
  it("目录优先，同层里 第2集 排在 第10集 前面（默认字典序会反过来）", () => {
    const tree = buildArchiveTree([
      entry("z.txt"),
      entry("第10集.txt"),
      entry("第2集.txt"),
      entry("dir/", { isDir: true }),
    ]);
    const names = dirFirstThen(childrenAt(tree, ""), compareByName).map((n) => n.name);
    expect(names[0]).toBe("dir");
    expect(names.indexOf("第2集.txt")).toBeLessThan(names.indexOf("第10集.txt"));
  });

  it("不改动入参数组", () => {
    const nodes = buildArchiveTree([entry("b.txt"), entry("a/", { isDir: true })]);
    const before = nodes.map((n) => n.name);
    dirFirstThen(nodes, compareByName);
    expect(nodes.map((n) => n.name)).toEqual(before);
  });
});

describe("剥壳判定（与 Rust select::single_root 同口径）", () => {
  it("所有条目第一段相同且多于一条时返回它", () => {
    expect(singleRootName([entry("top/a.txt"), entry("top/b/c.txt")])).toBe("top");
  });

  it("多个顶层 / 只有一个条目 → null", () => {
    expect(singleRootName([entry("a.txt"), entry("top/b.txt")])).toBeNull();
    // 只有一条时剥壳会让用户在目标目录里找不到东西，宁可留着
    expect(singleRootName([entry("only.txt")])).toBeNull();
    expect(singleRootName([])).toBeNull();
  });
});

describe("搜索", () => {
  it("按整条路径不区分大小写匹配，空查询返回空（不是全部）", () => {
    const entries = [entry("Docs/ReadMe.TXT"), entry("src/a.ts")];
    expect(searchEntries(entries, "readme").map((e) => e.path)).toEqual(["Docs/ReadMe.TXT"]);
    expect(searchEntries(entries, "SRC/").map((e) => e.path)).toEqual(["src/a.ts"]);
    expect(searchEntries(entries, "   ")).toEqual([]);
    expect(searchEntries(entries, "")).toEqual([]);
  });
});

describe("宿主机路径拼接", () => {
  it("统一成正斜杠，且盘符根不会被拼成 C://x", () => {
    expect(joinFsPath("D:\\work", "out")).toBe("D:/work/out");
    expect(joinFsPath("D:/work/", "/out")).toBe("D:/work/out");
    expect(joinFsPath("C:/", "x")).toBe("C:/x");
    expect(joinFsPath("", "x")).toBe("x");
    expect(joinFsPath("D:/work", "")).toBe("D:/work");
  });

  it("取文件名 / 去最后一个扩展名", () => {
    expect(fsBaseName("D:/a/movie.tar.gz")).toBe("movie.tar.gz");
    expect(fsBaseName("D:/a/dir/")).toBe("dir");
    expect(stripLastExtension("movie.tar.gz")).toBe("movie.tar");
    expect(stripLastExtension("movie")).toBe("movie");
    // 前导点的隐藏文件没有扩展名可去，".gitignore" 不能变成空串
    expect(stripLastExtension(".gitignore")).toBe(".gitignore");
  });
});

describe("新建压缩的默认名", () => {
  it("文件去掉最后一个扩展名，目录保留原名", () => {
    expect(defaultArchiveName([{ name: "D:/a/movie.mkv", isDir: false }], ".zip")).toBe("movie.zip");
    expect(defaultArchiveName([{ name: "photos", isDir: true }], ".7z")).toBe("photos.7z");
    expect(defaultArchiveName([{ name: "a.tar.gz", isDir: false }], "zip")).toBe("a.tar.zip");
  });

  it("多个源以第一个为准，一个都没有时给个能用的名字", () => {
    expect(
      defaultArchiveName(
        [
          { name: "one.txt", isDir: false },
          { name: "two.txt", isDir: false },
        ],
        ".zip",
      ),
    ).toBe("one.zip");
    expect(defaultArchiveName([], ".zip")).toBe("新建压缩包.zip");
  });
});

describe("分卷大小", () => {
  it("空 / 0 / 纯空白都算不分卷，不是错误", () => {
    expect(parseVolumeSizeStrict("")).toEqual({ ok: true, bytes: null });
    expect(parseVolumeSizeStrict("   ")).toEqual({ ok: true, bytes: null });
    expect(parseVolumeSizeStrict("0")).toEqual({ ok: true, bytes: null });
    expect(parseVolumeSize("")).toBeNull();
  });

  it("认单位、认小数、认纯字节", () => {
    expect(parseVolumeSize("700M")).toBe(700 * 1024 * 1024);
    expect(parseVolumeSize("1.5 gb")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseVolumeSize("1440K")).toBe(1440 * 1024);
    expect(parseVolumeSize("4G")).toBe(4 * 1024 ** 3);
    expect(parseVolumeSize("650")).toBe(650);
  });

  it("认不出来要说清哪里不对，而不是静默变成分卷大小 0", () => {
    expect(parseVolumeSizeStrict("abc").ok).toBe(false);
    expect(parseVolumeSizeStrict("700X")).toEqual({
      ok: false,
      error: '未知的大小单位 "x"，可用 K/M/G/T',
    });
    expect(parseVolumeSizeStrict("-5").ok).toBe(false);
    // 静默降级会让用户以为设了分卷、结果拿到一个 7 GB 的整包
    expect(parseVolumeSize("abc")).toBeNull();
  });

  it("预设里的每一个值都能被解析器吃下", () => {
    for (const p of VOLUME_PRESETS) {
      const r = parseVolumeSizeStrict(p.value);
      expect(r.ok, p.label).toBe(true);
    }
  });

  it("回显", () => {
    expect(formatVolumeSize(0)).toBe("不分卷");
    expect(formatVolumeSize(700 * 1024 * 1024)).toBe("700 MB");
    expect(formatVolumeSize(1536)).toBe("1.5 KB");
    expect(formatVolumeSize(512)).toBe("512 B");
  });
});

describe("压缩后大小到底有没有报出来", () => {
  // 这条规则的存在理由是真实世界的一个 RAR5：8638 条目、未压缩 9.46 GiB，
  // 7-Zip 报压缩后 7.38 GB（78%），而 UnRAR 的 Rust 绑定不透出 PackSize，
  // 后端只能填 0。0 被当成真值算比率就是"压缩率 0%"，两个数摆一起用户只会认为这边坏了。
  it("rar / cab / tar 的 0 是「没报」，不是「压到零」", () => {
    expect(packedSizeKnown({ totalSize: 10_152_865_107, totalPacked: 0 })).toBe(false);
  });

  it("有压缩后大小就照实算", () => {
    expect(packedSizeKnown({ totalSize: 1000, totalPacked: 780 })).toBe(true);
  });

  it("Store（完全不压缩）也要算「报了」—— packed == size，不是 0", () => {
    expect(packedSizeKnown({ totalSize: 1000, totalPacked: 1000 })).toBe(true);
  });

  it("空包没有比率可言：0/0 是 NaN，显示成「NaN%」比不显示更糟", () => {
    expect(packedSizeKnown({ totalSize: 0, totalPacked: 0 })).toBe(false);
  });
});

describe("等级上限挂在算法上，不是格式上", () => {
  const fmt: FormatOption = {
    id: "zip",
    label: "ZIP",
    extension: ".zip",
    description: "",
    maxLevel: 9,
    defaultLevel: 6,
    supportsPassword: true,
    supportsSolid: false,
    supportsVolumes: true,
    supportsComment: true,
    methods: [
      { id: "deflate", label: "Deflate", description: "", maxLevel: 9, defaultLevel: 6 },
      { id: "zstd", label: "Zstandard", description: "", maxLevel: 22, defaultLevel: 3 },
      { id: "store", label: "仅存储", description: "", maxLevel: 0, defaultLevel: 0 },
    ],
  };

  it("选了算法就用算法的上限", () => {
    expect(levelBoundsFor(fmt, "zstd")).toEqual({ max: 22, def: 3 });
    expect(levelBoundsFor(fmt, "store")).toEqual({ max: 0, def: 0 });
  });

  it("没选算法 / 选了不存在的算法 → 退回格式默认", () => {
    expect(levelBoundsFor(fmt, null)).toEqual({ max: 9, def: 6 });
    expect(levelBoundsFor(fmt, "不存在的")).toEqual({ max: 9, def: 6 });
  });
});

describe("错误归一化", () => {
  it("ArchiveError 是对象（serde tag = kind）", () => {
    expect(describeArchiveError({ kind: "needPassword", message: "要密码" })).toEqual({
      message: "要密码",
      needPassword: true,
      badPassword: false,
      encryptedHeaders: false,
    });
    expect(
      describeArchiveError({ kind: "needPassword", message: "要密码", encryptedHeaders: true }),
    ).toMatchObject({ needPassword: true, encryptedHeaders: true });
    expect(describeArchiveError({ kind: "badPassword", message: "密码错" })).toMatchObject({
      badPassword: true,
      needPassword: false,
    });
    expect(describeArchiveError({ kind: "failed", message: "磁盘满了" })).toEqual({
      message: "磁盘满了",
      needPassword: false,
      badPassword: false,
      encryptedHeaders: false,
    });
  });

  it("probe 这类命令给的是字符串", () => {
    expect(describeArchiveError("不是压缩包").message).toBe("不是压缩包");
    expect(describeArchiveError("").message).toBe("未知错误");
  });

  it("其余形状不许变成 [object Object] 或 undefined", () => {
    expect(describeArchiveError(new Error("炸了")).message).toBe("炸了");
    expect(describeArchiveError(new Error("")).message).toBe("未知错误");
    expect(describeArchiveError(undefined).message).toBe("未知错误");
    expect(describeArchiveError(null).message).toBe("未知错误");
    expect(describeArchiveError({}).message).toBe("未知错误");
    expect(describeArchiveError(42).message).toBe("42");
  });
});

describe("重名探测的措辞", () => {
  it("目标目录本来就存在时，说的是里面几个文件重名，不是'会被覆盖'", () => {
    expect(
      conflictMessage({ total: 2, paths: ["a/x.txt", "a/y.txt"], destExists: true }, "D:/a/movie"),
    ).toBe("目录 D:/a/movie 已存在，其中 2 个文件重名（x.txt、y.txt）");
    expect(
      conflictMessage({ total: 0, paths: [], destExists: true }, "D:/a/movie"),
    ).toBe("目录 D:/a/movie 已存在，其中没有重名文件。");
  });

  it("目录不存在时才是'会被覆盖'，且超过三条只列前三条", () => {
    expect(conflictMessage({ total: 1, paths: ["x.txt"], destExists: false }, "out")).toBe(
      "1 个文件会被覆盖（x.txt）",
    );
    const many = conflictMessage(
      { total: 5, paths: ["a/1", "a/2", "a/3", "a/4", "a/5"], destExists: false },
      "out",
    );
    expect(many).toBe("5 个文件会被覆盖（1、2、3 …）");
  });
});

describe("进度与任务状态", () => {
  it("两个总量都未知时 percent 是 -1，渲染成不定进度条而不是 0%", () => {
    expect(jobPercent(progress({ percent: -1 }))).toBeNull();
    expect(jobPercent(progress({ percent: 42.7 }))).toBe(42.7);
    expect(jobPercent(progress({ percent: 180 }))).toBe(100);
    expect(jobPercent(progress({ percent: -9 }))).toBeNull();
  });

  it("跑完/取消/失败才算结束", () => {
    expect(isJobRunning(progress({ phase: "scanning" }))).toBe(true);
    expect(isJobRunning(progress({ phase: "working" }))).toBe(true);
    expect(isJobRunning(progress({ phase: "finishing" }))).toBe(true);
    expect(isJobRunning(progress({ phase: "done" }))).toBe(false);
    expect(isJobRunning(progress({ phase: "cancelled" }))).toBe(false);
    expect(isJobRunning(progress({ phase: "error" }))).toBe(false);
  });

  it("antd Progress 的 status", () => {
    expect(jobStatus(progress({ phase: "error" }))).toBe("exception");
    expect(jobStatus(progress({ phase: "done" }))).toBe("success");
    expect(jobStatus(progress({ phase: "cancelled" }))).toBe("normal");
    expect(jobStatus(progress({ phase: "working" }))).toBe("active");
  });

  it("标题取文件名，但不截断压缩侧那句'等 N 项'", () => {
    expect(jobTitle(progress())).toBe("解压 movie.rar");
    expect(jobTitle(progress({ kind: "create", archive: "a.zip 等 3 项" }))).toBe("压缩 a.zip 等 3 项");
    expect(jobTitle(progress({ archive: "" }))).toBe("解压");
  });

  it("阶段文案", () => {
    expect(phaseLabel("scanning")).toBe("正在扫描");
    expect(phaseLabel("done")).toBe("完成");
  });

  it("速度为 0 不显示，免得挂一句 0 B/s 让人以为卡死", () => {
    expect(formatSpeed(0)).toBe("");
    expect(formatSpeed(1024 * 1024)).toBe("1.0 MB/s");
  });

  it("剩余时间：总量未知或速度为 0 时什么都不说", () => {
    expect(formatEta(progress({ bytesTotal: 0, bytesDone: 0, speedBps: 0 }))).toBe("");
    expect(formatEta(progress({ bytesTotal: 100, bytesDone: 100, speedBps: 10 }))).toBe("");
    expect(formatEta(progress({ bytesTotal: 100, bytesDone: 70, speedBps: 10 }))).toBe("剩余 3 秒");
    expect(formatEta(progress({ bytesTotal: 1000, bytesDone: 0, speedBps: 10 }))).toBe(
      "剩余 2 分钟",
    );
    expect(formatEta(progress({ bytesTotal: 72000, bytesDone: 0, speedBps: 10 }))).toBe(
      "剩余 2.0 小时",
    );
  });
});
