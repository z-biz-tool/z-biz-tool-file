/**
 * 归档引擎的前端模型层：类型 + 纯函数。
 *
 * 下面的 interface 与 `src-tauri/src/archive/types.rs` 一一对应（那个文件的头注也这么写着），
 * 改字段要两边一起改。字段名是 camelCase，因为 Rust 侧统一挂了
 * `#[serde(rename_all = "camelCase")]`；唯一的例外是 `Overwrite`，它是 snake_case
 * 字面量（`"skip" | "overwrite" | "rename"`），照抄不要改。
 *
 * 这个文件**不 import Tauri**：所有函数都是纯的，好在 node 环境的 vitest 里直接测。
 */

// ============================================================================
// 类型
// ============================================================================

/** 某种格式支持哪些操作。不支持的直接不渲染，不做"灰掉一排按钮"。 */
export interface ArchiveCaps {
  list: boolean;
  extract: boolean;
  create: boolean;
  test: boolean;
  add: boolean;
  encryptRead: boolean;
  encryptWrite: boolean;
}

export interface ArchiveEntry {
  /** 归档内序号，稳定标识（zip 允许同名条目，路径不能当主键） */
  index: number;
  /** 归档内路径，已归一化：'/' 分隔、无首尾斜杠、无 '.' 段 */
  path: string;
  name: string;
  isDir: boolean;
  /** 未压缩大小；目录是子树汇总 */
  size: number;
  /** 压缩后大小；solid 归档（7z/rar）里单条目的这个值没有意义，为 0 */
  packed: number;
  /** Unix 秒；0 = 该格式不存时间 */
  modified: number;
  method: string;
  encrypted: boolean;
  crc: number;
  comment: string;
  symlinkTarget: string;
}

export interface ArchiveInfo {
  path: string;
  format: string;
  formatLabel: string;
  /** ZIP 容器的真身（docx / apk / jar…），不是容器时为 null */
  container: string | null;
  entryCount: number;
  totalSize: number;
  /** 压缩后总大小。**可能是 0，意思是"这个格式没报"**，见 `packedSizeKnown`。 */
  totalPacked: number;
  needsPassword: boolean;
  /** 连文件名都加密了，不给密码连列表都拿不到 */
  encryptedHeaders: boolean;
  solid: boolean;
  multipart: boolean;
  volumes: string[];
  comment: string;
  caps: ArchiveCaps;
  /** 条目数撞了后端上限被截断，界面必须说清楚"列表不完整" */
  truncated: boolean;
  entries: ArchiveEntry[];
}

/**
 * 这个归档到底有没有报"压缩后大小"。
 *
 * rar / cab / tar 三个后端在 `packed` 上填的是 0，含义是**格式没给**，不是"压到了 0 字节"：
 * UnRAR 的 Rust 绑定不透出官方结构里的 `PackSize`，cab/tar 的容器里也压根没存这个数。
 * 于是 `totalPacked` 跟着是 0，界面要是照实算比率就会显示"压缩率 0%"——
 * 而 7-Zip 打开同一个 RAR 显示的是 7.38 GB / 9.46 GiB。用户对着两个数，只会认为我们坏了。
 *
 * 0 必须和"真的没压缩"区分开，但单条目区分不了（Store 的包每条 packed == size，
 * 空文件也是 0），所以判据落在总量上：有内容却一个字节都没报，那就是没报。
 * solid 的 7z 每条也是 0（共享字典，单条没有意义），同样被这条规则挡住。
 */
export function packedSizeKnown(info: Pick<ArchiveInfo, "totalSize" | "totalPacked">): boolean {
  return info.totalSize > 0 && info.totalPacked > 0;
}

export type Overwrite = "skip" | "overwrite" | "rename";
export interface ExtractOptions {
  entries?: string[] | null;
  password?: string | null;
  overwrite: Overwrite;
  keepBroken: boolean;
  stripRoot: boolean;
  flatten: boolean;
  includeChildren: boolean;
}

export interface CreateOptions {
  format: string;
  level?: number | null;
  method?: string | null;
  password?: string | null;
  encryptHeader: boolean;
  solid: boolean;
  comment?: string | null;
  /** 分卷大小（字节），0/null = 不分卷 */
  volumeSize?: number | null;
  storeFullPath: boolean;
  excludePatterns: string[];
}

export interface MethodOption {
  id: string;
  label: string;
  description: string;
  maxLevel: number;
  defaultLevel: number;
}

export interface FormatOption {
  id: string;
  label: string;
  extension: string;
  description: string;
  maxLevel: number;
  defaultLevel: number;
  supportsPassword: boolean;
  supportsSolid: boolean;
  supportsVolumes: boolean;
  supportsComment: boolean;
  /** 第一项是默认算法 */
  methods: MethodOption[];
}

export interface ArchiveStats {
  entriesDone: number;
  bytesDone: number;
  skipped: number;
  errors: string[];
  elapsedMs: number;
}

export interface ProbeResult {
  isArchive: boolean;
  format: string;
  formatLabel: string;
  container: string | null;
  caps: ArchiveCaps;
  unsupportedReason: string | null;
  /** 分卷中的第几卷（1 起） */
  volumeIndex: number | null;
  /** 非首卷不能直接解，要提示用户去找第一卷 */
  isSecondaryVolume: boolean;
  extractDirName: string;
}

export interface ConflictReport {
  total: number;
  paths: string[];
  /** 目标目录本身已存在。"解压到 xxx" 时几乎总是如此，措辞要跟着变 */
  destExists: boolean;
}

export type JobKind = "extract" | "create" | "test";
export type JobPhase = "scanning" | "working" | "finishing" | "done" | "cancelled" | "error";

export interface ArchiveProgress {
  jobId: string;
  kind: JobKind;
  phase: JobPhase;
  archive: string;
  dest: string;
  /** 当前正在处理的条目名 */
  entry: string;
  entriesDone: number;
  entriesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** 0..100；两个总量都未知时为 -1（渲染成不定进度条） */
  percent: number;
  speedBps: number;
  message: string;
}

/** 后端 `ArchiveError` 的 serde 表示（`tag = "kind"`） */
export interface ArchiveErrorPayload {
  kind: "needPassword" | "badPassword" | "failed";
  message: string;
  encryptedHeaders?: boolean;
}

export interface ArchiveFailure {
  message: string;
  needPassword: boolean;
  badPassword: boolean;
  encryptedHeaders: boolean;
}

// ============================================================================
// 归档内路径
// ============================================================================

/**
 * 与 Rust 侧 `archive/select.rs::normalize` 严格同口径：统一分隔符、去首尾 '/'、去 '.' 段。
 *
 * 前端必须自己算一遍而不是直接用后端给的 `entry.path`：勾选、面包屑、建树都要拆路径，
 * 而 tar 包里 `./a/b/` 这种写法非常常见，两边口径不一致就会出现"勾了却匹配不上"。
 */
export function normalizeArchivePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0 && s !== ".")
    .join("/");
}

export function archiveSegments(p: string): string[] {
  const n = normalizeArchivePath(p);
  return n.length === 0 ? [] : n.split("/");
}

/** 顶层条目的父路径是 ""（空串代表归档根） */
export function parentArchivePath(p: string): string {
  const segs = archiveSegments(p);
  segs.pop();
  return segs.join("/");
}

export function joinArchivePath(dir: string, name: string): string {
  const d = normalizeArchivePath(dir);
  const n = normalizeArchivePath(name);
  if (d.length === 0) return n;
  if (n.length === 0) return d;
  return `${d}/${n}`;
}

export interface ArchiveCrumb {
  name: string;
  path: string;
}

/** 面包屑。第一项恒为归档根，path 是 ""。 */
export function archiveBreadcrumbs(p: string): ArchiveCrumb[] {
  const segs = archiveSegments(p);
  const out: ArchiveCrumb[] = [{ name: "根目录", path: "" }];
  let acc = "";
  for (const s of segs) {
    acc = acc.length === 0 ? s : `${acc}/${s}`;
    out.push({ name: s, path: acc });
  }
  return out;
}

// ============================================================================
// 树
// ============================================================================

export interface ArchiveNode {
  name: string;
  /** 归档内路径，目录不带尾斜杠 */
  path: string;
  isDir: boolean;
  size: number;
  packed: number;
  modified: number;
  method: string;
  encrypted: boolean;
  comment: string;
  symlinkTarget: string;
  children: ArchiveNode[];
  /**
   * 合成出来的目录（zip 里常常只有 `a/b.txt` 而没有 `a/` 这条目录条目）没有对应条目，
   * 此时为 undefined。渲染时不要拿它当"这一行可以勾选解压"的依据——
   * 勾选用的始终是 `path`，后端按前缀匹配。
   */
  entry?: ArchiveEntry;
}

function makeDir(name: string, path: string): ArchiveNode {
  return {
    name,
    path,
    isDir: true,
    size: 0,
    packed: 0,
    modified: 0,
    method: "",
    encrypted: false,
    comment: "",
    symlinkTarget: "",
    children: [],
  };
}

/**
 * 把扁平条目表建成树。
 *
 * 目录大小：后端 `rollup_dir_sizes` 已经给**真实存在的目录条目**填好了子树汇总，
 * 直接用；合成目录没有条目，只能在这里自己加一遍。判据是 `entry` 在不在，
 * 不是"size 是不是 0"——空目录的真实汇总值也是 0。
 */
export function buildArchiveTree(entries: ArchiveEntry[]): ArchiveNode[] {
  const root: ArchiveNode[] = [];
  const byPath = new Map<string, ArchiveNode>();

  for (const e of entries) {
    const segs = archiveSegments(e.path);
    if (segs.length === 0) continue;

    let siblings = root;
    let acc = "";
    let node: ArchiveNode | undefined;
    for (let i = 0; i < segs.length; i += 1) {
      acc = acc.length === 0 ? segs[i] : `${acc}/${segs[i]}`;
      const last = i === segs.length - 1;
      const existing = byPath.get(acc);
      if (existing) {
        node = existing;
        // 先见到 `a/b.txt` 合成了目录 `a`，后又来了真正的 `a/` 条目：
        // 用真条目补全元信息，但**保留已经挂上去的 children**
        if (last && node.entry === undefined) {
          node.entry = e;
          node.isDir = e.isDir;
          node.method = e.method;
          node.modified = e.modified;
          node.encrypted = e.encrypted;
          node.comment = e.comment;
          node.symlinkTarget = e.symlinkTarget;
          node.packed = e.packed;
          node.size = e.isDir ? e.size : node.size;
        }
      } else {
        node = last && !e.isDir
          ? {
              name: segs[i],
              path: acc,
              isDir: false,
              size: e.size,
              packed: e.packed,
              modified: e.modified,
              method: e.method,
              encrypted: e.encrypted,
              comment: e.comment,
              symlinkTarget: e.symlinkTarget,
              children: [],
              entry: e,
            }
          : (() => {
              const d = makeDir(segs[i], acc);
              if (last) {
                d.entry = e;
                d.size = e.size;
                d.packed = e.packed;
                d.modified = e.modified;
                d.encrypted = e.encrypted;
                d.comment = e.comment;
                d.symlinkTarget = e.symlinkTarget;
              }
              return d;
            })();
        byPath.set(acc, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
  }

  // 合成目录的大小自底向上补。真实目录条目已经有后端的汇总值，跳过。
  const rollup = (nodes: ArchiveNode[]): number => {
    let sum = 0;
    for (const n of nodes) {
      if (n.isDir) {
        const childSum = rollup(n.children);
        if (n.entry === undefined) n.size = childSum;
        sum += n.size;
      } else {
        sum += n.size;
      }
    }
    return sum;
  };
  rollup(root);
  return root;
}

/** 取某个目录下的直接子节点。dirPath 为 "" 时返回顶层。 */
export function childrenAt(nodes: ArchiveNode[], dirPath: string): ArchiveNode[] {
  const segs = archiveSegments(dirPath);
  let cur = nodes;
  for (const s of segs) {
    const next = cur.find((n) => n.isDir && n.name === s);
    if (!next) return [];
    cur = next.children;
  }
  return cur;
}

export function findNode(nodes: ArchiveNode[], path: string): ArchiveNode | undefined {
  const segs = archiveSegments(path);
  let cur = nodes;
  let found: ArchiveNode | undefined;
  for (const s of segs) {
    found = cur.find((n) => n.name === s);
    if (!found) return undefined;
    cur = found.children;
  }
  return found;
}

/** 子树里所有**真实条目**的归档内路径（合成目录不算，后端没有那条路径）。 */
export function collectEntryPaths(node: ArchiveNode): string[] {
  const out: string[] = [];
  const walk = (n: ArchiveNode) => {
    if (n.entry) out.push(n.path);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

/** 目录优先，其次按给定比较器。归档里成千上万行时这个次序决定了"能不能一眼看到文件夹"。 */
export function dirFirstThen(
  nodes: ArchiveNode[],
  cmp: (a: ArchiveNode, b: ArchiveNode) => number,
): ArchiveNode[] {
  return [...nodes].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return cmp(a, b);
  });
}

/**
 * 按名字比。参数只要求 `name`，因为归档浏览器里参与排序的是"表格行"而不是树节点：
 * 浏览模式的行来自 `ArchiveNode`，搜索模式的行来自扁平的 `ArchiveEntry`，
 * 两者都有 `name`，但结构不同——收窄到 `ArchiveNode` 会逼着搜索模式先造一棵假树。
 *
 * `numeric: true` 让 `第2集` 排在 `第10集` 前面（默认字典序会反过来），
 * `zh-Hans-CN` + `sensitivity: "base"` 让中文名按拼音走、大小写和重音不参与排序。
 */
export function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

/**
 * 归档只有一个顶层目录时返回它的名字，否则 null。与 Rust 侧 `select::single_root` 同口径：
 * 只有一个条目时**不**剥壳——剥了用户会在目标目录里找不到东西。
 */
export function singleRootName(entries: ArchiveEntry[]): string | null {
  let root: string | null = null;
  let count = 0;
  for (const e of entries) {
    const segs = archiveSegments(e.path);
    if (segs.length === 0) continue;
    count += 1;
    if (root === null) root = segs[0];
    else if (root !== segs[0]) return null;
  }
  return count < 2 ? null : root;
}

/** 在归档内按整条路径模糊查找，返回扁平结果（搜索模式下不建树，几千条命中也要能看） */
export function searchEntries(entries: ArchiveEntry[], query: string): ArchiveEntry[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  return entries.filter((e) => e.path.toLowerCase().includes(q));
}

// ============================================================================
// 文件系统路径（宿主机侧，不是归档内）
// ============================================================================

/**
 * 拼宿主机路径。统一用 '/'：Windows 的 API 全接受正斜杠，而仓库里已有的
 * `utils/parentDir.ts` 也是这个口径，混用两种分隔符会让"是不是同一个目录"的判断失效。
 */
export function joinFsPath(dir: string, name: string): string {
  const d = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const n = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (d.length === 0) return n;
  if (n.length === 0) return d;
  // "C:/" 这种根不能再补一层斜杠，否则变成 "C://x"
  return d.endsWith("/") ? `${d}${n}` : `${d}/${n}`;
}

export function fsBaseName(p: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = n.lastIndexOf("/");
  return i < 0 ? n : n.slice(i + 1);
}

/** 去掉最后一个扩展名。`movie.tar.gz` → `movie.tar`，和后端 stem_for_extract 的口径一致。 */
export function stripLastExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

// ============================================================================
// 新建压缩
// ============================================================================

export interface NamedSource {
  name: string;
  isDir: boolean;
}

/**
 * "新建压缩"对话框里的默认目标文件名。
 *
 * 文件去掉最后一个扩展名（`movie.mkv` → `movie.zip`，7-Zip 也是这么提议的），
 * 目录直接用目录名（`photos` → `photos.zip`）。多个源时以第一个为准——
 * 用户右键 20 个文件压缩，指望的是"给我个合理的名字"，不是一句"等 20 项"。
 */
export function defaultArchiveName(sources: NamedSource[], extension: string): string {
  const ext = extension.startsWith(".") ? extension : `.${extension}`;
  const first = sources[0];
  if (!first) return `新建压缩包${ext}`;
  const stem = first.isDir ? fsBaseName(first.name) : stripLastExtension(fsBaseName(first.name));
  return `${stem.length > 0 ? stem : "新建压缩包"}${ext}`;
}

const SIZE_UNITS: Array<[string, number]> = [
  ["b", 1],
  ["k", 1024],
  ["kb", 1024],
  ["m", 1024 ** 2],
  ["mb", 1024 ** 2],
  ["g", 1024 ** 3],
  ["gb", 1024 ** 3],
  ["t", 1024 ** 4],
  ["tb", 1024 ** 4],
];

/**
 * 把 "700M" / "1.5 gb" / "650" 解析成字节数。null = 不分卷。
 *
 * 认 "0"、空串和纯空白为"不分卷"，而不是报错：分卷那一栏是可选的，
 * 用户清空输入框应该等于取消分卷，不该看到一行红字。
 * 认不出来（"abc"、"-5"）也返回 null，由调用方决定要不要提示——
 * 但 `parseVolumeSizeStrict` 会区分"没填"和"填错了"。
 */
export function parseVolumeSize(input: string): number | null {
  const r = parseVolumeSizeStrict(input);
  return r.ok ? r.bytes : null;
}

export type VolumeSizeParse =
  | { ok: true; bytes: number | null }
  | { ok: false; error: string };

export function parseVolumeSizeStrict(input: string): VolumeSizeParse {
  const t = input.trim().toLowerCase();
  if (t.length === 0) return { ok: true, bytes: null };

  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(t);
  if (!m) return { ok: false, error: `看不懂的分卷大小: ${input}` };
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num < 0) return { ok: false, error: `分卷大小不能是负数: ${input}` };
  if (num === 0) return { ok: true, bytes: null };

  const unit = m[2];
  if (unit.length === 0) return { ok: true, bytes: Math.round(num) };
  const found = SIZE_UNITS.find(([u]) => u === unit);
  if (!found) return { ok: false, error: `未知的大小单位 "${m[2]}"，可用 K/M/G/T` };
  return { ok: true, bytes: Math.round(num * found[1]) };
}

/** 常用分卷预设。CD 那一档留着是因为老资源包还在按它切。 */
export const VOLUME_PRESETS: Array<{ label: string; value: string }> = [
  { label: "不分卷", value: "" },
  { label: "1.44 MB（软盘）", value: "1440K" },
  { label: "700 MB（CD）", value: "700M" },
  { label: "4 GB（FAT32 上限）", value: "4G" },
  { label: "4.7 GB（DVD）", value: "4700M" },
];

export function formatVolumeSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "不分卷";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let f = bytes;
  let i = 0;
  while (f >= 1024 && i < units.length - 1) {
    f /= 1024;
    i += 1;
  }
  const text = i === 0 ? `${bytes}` : f.toFixed(f >= 100 ? 0 : 1);
  return `${text} ${units[i]}`;
}

/**
 * 选了格式之后能填什么。等级上限挂在**算法**上而不是格式上：
 * 同一个 zip 里 deflate 到 9、zstd 到 22、store 根本没有等级。
 */
export function levelBoundsFor(fmt: FormatOption, methodId: string | null): {
  max: number;
  def: number;
} {
  const m = fmt.methods.find((x) => x.id === methodId);
  if (m) return { max: m.maxLevel, def: m.defaultLevel };
  return { max: fmt.maxLevel, def: fmt.defaultLevel };
}

// ============================================================================
// 错误与进度
// ============================================================================

/**
 * 把 invoke 的 rejection 归一化。
 *
 * Tauri 2 会把 `Result<_, ArchiveError>` 里的 ArchiveError **按 serde 序列化后**丢过来，
 * 所以拿到的是一个对象而不是字符串；但 `archive_probe` 这类返回 `Result<_, String>`
 * 的命令给的又是字符串。两种都要认，否则用户看到的错误是 "[object Object]"。
 */
export function describeArchiveError(e: unknown): ArchiveFailure {
  const fail = (message: string): ArchiveFailure => ({
    message,
    needPassword: false,
    badPassword: false,
    encryptedHeaders: false,
  });
  if (typeof e === "string") return fail(e.length > 0 ? e : "未知错误");
  if (e && typeof e === "object") {
    const p = e as Partial<ArchiveErrorPayload>;
    const message = typeof p.message === "string" && p.message.length > 0 ? p.message : "未知错误";
    if (p.kind === "needPassword") {
      return { message, needPassword: true, badPassword: false, encryptedHeaders: !!p.encryptedHeaders };
    }
    if (p.kind === "badPassword") return { message, needPassword: false, badPassword: true, encryptedHeaders: false };
    return fail(message);
  }
  if (e instanceof Error) return fail(e.message.length > 0 ? e.message : "未知错误");
  // null / undefined 会变成字面量 "undefined" 弹给用户，那不如说"未知错误"
  if (e === null || e === undefined) return fail("未知错误");
  return fail(String(e));
}

const PHASE_LABEL: Record<JobPhase, string> = {
  scanning: "正在扫描",
  working: "进行中",
  finishing: "收尾",
  done: "完成",
  cancelled: "已取消",
  error: "失败",
};

const KIND_LABEL: Record<JobKind, string> = {
  extract: "解压",
  create: "压缩",
  test: "校验",
};

export function phaseLabel(phase: JobPhase): string {
  return PHASE_LABEL[phase] ?? phase;
}

export function kindLabel(kind: JobKind): string {
  return KIND_LABEL[kind] ?? kind;
}

export function isJobRunning(p: ArchiveProgress): boolean {
  return p.phase !== "done" && p.phase !== "cancelled" && p.phase !== "error";
}

/** antd Progress 要的百分比；返回 null 表示"不知道"，渲染成不定进度条。 */
export function jobPercent(p: ArchiveProgress): number | null {
  if (!Number.isFinite(p.percent) || p.percent < 0) return null;
  return Math.max(0, Math.min(100, p.percent));
}

export function jobStatus(p: ArchiveProgress): "active" | "success" | "exception" | "normal" {
  if (p.phase === "error") return "exception";
  if (p.phase === "done") return "success";
  if (p.phase === "cancelled") return "normal";
  return "active";
}

/** 进度条标题。archive 字段在压缩多源时已经是 "xxx 等 N 项" 了，直接取文件名会丢信息。 */
export function jobTitle(p: ArchiveProgress): string {
  const what = p.archive.length > 0 ? fsBaseName(p.archive) : "";
  return what.length > 0 ? `${kindLabel(p.kind)} ${what}` : kindLabel(p.kind);
}

/**
 * 重名探测的措辞。
 *
 * `destExists` 为真时目标目录本来就在（"解压到 xxx" 几乎总是这样），
 * 这时候说"目标已存在，会被覆盖"是吓唬人——真正要说的是里面有几个文件重名。
 */
export function conflictMessage(r: ConflictReport, destName: string): string {
  if (r.total === 0) {
    return r.destExists ? `目录 ${destName} 已存在，其中没有重名文件。` : `将新建 ${destName}。`;
  }
  const head = r.paths.slice(0, 3).map((p) => fsBaseName(p)).join("、");
  const more = r.total > 3 ? " …" : "";
  return r.destExists
    ? `目录 ${destName} 已存在，其中 ${r.total} 个文件重名（${head}${more}）`
    : `${r.total} 个文件会被覆盖（${head}${more}）`;
}

/** 速度。0 就不显示，免得进度条上挂一句 "0 B/s" 让人以为卡死了。 */
export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  return `${formatVolumeSize(bps)}/s`;
}

/** 剩余时间。总量未知或速度为 0 时返回空串——显示 "∞" 或 "计算中" 都只是噪音。 */
export function formatEta(p: ArchiveProgress): string {
  if (p.bytesTotal <= p.bytesDone || p.speedBps <= 0) return "";
  const secs = (p.bytesTotal - p.bytesDone) / p.speedBps;
  if (!Number.isFinite(secs)) return "";
  if (secs < 60) return `剩余 ${Math.max(1, Math.round(secs))} 秒`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `剩余 ${mins} 分钟`;
  return `剩余 ${(mins / 60).toFixed(1)} 小时`;
}
