// 快速操作（脚本系统最简版）
// 存储在 localStorage，用户可增删改
// 执行时用 Rust 端 run_shell_command，{path} 占位符替换为选中文件路径

export interface QuickAction {
  id: string;
  name: string;
  /** 命令模板（如 "open -R {path}" 或 "chmod"） */
  program: string;
  /** 参数模板（支持 {path} 占位符） */
  args: string[];
  /** 内置标记：不可删（只可禁用） */
  builtin?: boolean;
  /** 是否启用（不启用就不在右键菜单显示） */
  enabled?: boolean;
  /** 危险标记：执行前需二次确认 */
  dangerous?: boolean;
}

const STORAGE_KEY = "z-tool-quick-actions";

/** 内置默认 quick actions */
export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    id: "builtin-reveal",
    name: "在 Finder 中显示",
    program: "open",
    args: ["-R", "{path}"],
    builtin: true,
    enabled: true,
  },
  {
    id: "builtin-chmod-readonly",
    name: "设为只读 (chmod 444)",
    program: "chmod",
    args: ["444", "{path}"],
    builtin: true,
    enabled: true,
    dangerous: true,
  },
  {
    id: "builtin-chmod-writable",
    name: "设为可写 (chmod 644)",
    program: "chmod",
    args: ["644", "{path}"],
    builtin: true,
    enabled: true,
  },
  {
    id: "builtin-touch-mtime",
    name: "更新修改时间为现在 (touch -m)",
    program: "touch",
    args: ["-m", "{path}"],
    builtin: true,
    enabled: true,
  },
  {
    id: "builtin-cp-clipboard",
    name: "复制路径到剪贴板 (pbcopy)",
    program: "bash",
    args: ["-c", `echo -n "{path}" | pbcopy`],
    builtin: true,
    enabled: true,
  },
  {
    id: "builtin-md5",
    name: "计算 MD5 (md5 -q)",
    program: "md5",
    args: ["-q", "{path}"],
    builtin: true,
    enabled: true,
  },
];

export function loadQuickActions(): QuickAction[] {
  if (typeof window === "undefined") return DEFAULT_QUICK_ACTIONS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_QUICK_ACTIONS;
    const user = JSON.parse(raw) as QuickAction[];
    // 合并：内置（默认）+ 用户自定义
    const builtin = DEFAULT_QUICK_ACTIONS;
    return [...builtin, ...user.filter((u) => !builtin.find((b) => b.id === u.id))];
  } catch {
    return DEFAULT_QUICK_ACTIONS;
  }
}

export function saveUserQuickActions(actions: QuickAction[]): void {
  if (typeof window === "undefined") return;
  try {
    const userOnly = actions.filter((a) => !a.builtin);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userOnly));
  } catch {
    /* ignore */
  }
}
