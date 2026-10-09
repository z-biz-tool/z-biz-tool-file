/**
 * "打开"和"重命名"这两个最基础的动作，该对哪一项生效。
 *
 * 抽成纯函数是因为这三处都曾各写一遍判断，并且写法不一致：
 * - 主表格/网格视图的双击只处理目录（`record.is_dir && navigateTo(...)`），
 *   双击文件**什么都不发生**；而双面板视图（DualPanelView）早就正确地
 *   "目录进入 / 文件交给默认应用"。同一个应用里两套行为，用户只会记住"这个软件有时点不动"。
 * - Enter 被重命名占用，且 `!selectedFile.is_dir` 让文件夹根本改不了名。
 */

export interface OpenableEntry {
  path: string;
  name: string;
  is_dir: boolean;
}

export type OpenReject = "empty" | "multi";

export type OpenAction =
  | { kind: "navigate"; path: string }
  | { kind: "open-app"; path: string }
  /** 压缩包进本应用的归档浏览器，而不是交给系统默认程序（那通常等于"用 7-Zip 打开"） */
  | { kind: "open-archive"; path: string }
  | { kind: "none"; reason: OpenReject };

/**
 * 名字最后一个 '.' 段（小写）。复合后缀靠它最后那一截命中：
 * `x.tar.gz` → `gz`、`x.zip.001` → `001`，不必穷举组合。
 */
export function lastExtension(name: string): string {
  const i = name.lastIndexOf(".");
  // i <= 0：没有点，或者点是首字符（".gitignore" 是文件名不是扩展名）
  if (i <= 0) return "";
  return name.slice(i + 1).toLowerCase();
}

/**
 * 一次只打开一项：多选时不去逐个 `open`（一次 Enter 弹出 50 个外部应用窗口，
 * 是那种会把人吓到去强制退出的事故），而是明确告诉用户为什么没反应。
 *
 * `archiveExts` 由调用方从后端 `archive_open_extensions` 取来传进来，不在这里写死一份：
 * 那张表是"引擎认得哪些容器"的产品决定，写在 Rust 的格式表旁边才不会两边分叉。
 * 它**必须**是显式参数而不是模块级默认值——默认值会让漏传的那条调用路径静默退化成
 * "压缩包一律交给系统"，而这正是本次要改掉的行为。
 */
export function resolveOpen(
  entries: OpenableEntry[],
  archiveExts: readonly string[],
): OpenAction {
  if (entries.length === 0) return { kind: "none", reason: "empty" };
  if (entries.length > 1) return { kind: "none", reason: "multi" };
  const [entry] = entries;
  if (entry.is_dir) return { kind: "navigate", path: entry.path };
  if (archiveExts.includes(lastExtension(entry.name))) {
    return { kind: "open-archive", path: entry.path };
  }
  return { kind: "open-app", path: entry.path };
}

/** 重命名同样要求恰好一项；目录也要能改名（此前只能改文件） */
export function resolveRenameTarget(entries: OpenableEntry[]): OpenableEntry | null {
  return entries.length === 1 ? entries[0] : null;
}

/** 拒绝原因说人话的地方 —— 静默无反应是最糟的反馈 */
export function openRejectText(reason: OpenReject): string {
  return reason === "multi" ? "一次只能打开一项，请只选中一个" : "请先选中要打开的项目";
}
