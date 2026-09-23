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
  | { kind: "none"; reason: OpenReject };

/**
 * 一次只打开一项：多选时不去逐个 `open`（一次 Enter 弹出 50 个外部应用窗口，
 * 是那种会把人吓到去强制退出的事故），而是明确告诉用户为什么没反应。
 */
export function resolveOpen(entries: OpenableEntry[]): OpenAction {
  if (entries.length === 0) return { kind: "none", reason: "empty" };
  if (entries.length > 1) return { kind: "none", reason: "multi" };
  const [entry] = entries;
  return entry.is_dir
    ? { kind: "navigate", path: entry.path }
    : { kind: "open-app", path: entry.path };
}

/** 重命名同样要求恰好一项；目录也要能改名（此前只能改文件） */
export function resolveRenameTarget(entries: OpenableEntry[]): OpenableEntry | null {
  return entries.length === 1 ? entries[0] : null;
}

/** 拒绝原因说人话的地方 —— 静默无反应是最糟的反馈 */
export function openRejectText(reason: OpenReject): string {
  return reason === "multi" ? "一次只能打开一项，请只选中一个" : "请先选中要打开的项目";
}
