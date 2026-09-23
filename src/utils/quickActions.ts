// 快速操作（脚本系统最简版）
// 存储在 localStorage，用户可增删改
// 内置项走 Rust 那边已有的具名命令（path_guard 会校验路径），
// 用户自定义项才走 run_shell_command（那边只放行白名单里的绝对路径程序）。

export interface QuickAction {
  id: string;
  name: string;
  /** shell 形式的程序（绝对路径，且必须在后端白名单里）；内置项不用这个字段 */
  program: string;
  /** shell 形式的参数模板（支持 {path} 占位符） */
  args: string[];
  /** 具名命令形式：invoke(command, commandArgs)，值里可以用 {path} 模板 */
  command?: string;
  commandArgs?: Record<string, string | number>;
  /** 只把目标路径写进剪贴板，不起任何进程 */
  copyPath?: boolean;
  /** 内置标记：不可删（只可禁用） */
  builtin?: boolean;
  /** 是否启用（不启用就不在右键菜单显示） */
  enabled?: boolean;
  /** 危险标记：执行前需二次确认 */
  dangerous?: boolean;
}

const STORAGE_KEY = "z-tool-quick-actions";

/**
 * 内置默认 quick actions。
 *
 * 这一批原先全是 shell 形式，program 写的是 "open"、"chmod"、"md5" 这种裸名字，
 * 而 run_shell_command 的白名单只收 /usr/bin/open、/usr/bin/pbcopy 这类绝对路径
 * —— 于是每个内置项都会被后端一句"程序未在白名单内"打回，点了必然失败。
 * Rust 侧本来就有 path_guard 校验过的具名命令干同样的事，所以改成走命令；
 * 只有"更新修改时间"确实没有对应后端能力，直接摘掉（它以前也从没成功过）。
 */
export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    id: "builtin-reveal",
    name: "在 Finder 中显示",
    program: "",
    args: [],
    command: "reveal_in_finder",
    commandArgs: { path: "{path}" },
    builtin: true,
    enabled: true,
  },
  {
    id: "builtin-chmod-readonly",
    name: "设为只读 (444)",
    program: "",
    args: [],
    command: "set_file_permissions",
    // mode 传的是权限位本身，不是"八进制写法当十进制"的那个数字：0o444 === 292
    commandArgs: { path: "{path}", mode: 0o444 },
    builtin: true,
    enabled: true,
    dangerous: true,
  },
  {
    id: "builtin-chmod-writable",
    name: "设为可写 (644)",
    program: "",
    args: [],
    command: "set_file_permissions",
    commandArgs: { path: "{path}", mode: 0o644 },
    builtin: true,
    enabled: true,
  },
  {
    id: "builtin-cp-clipboard",
    name: "复制路径到剪贴板",
    program: "",
    args: [],
    copyPath: true,
    builtin: true,
    enabled: true,
  },
  {
    id: "builtin-md5",
    name: "计算 MD5",
    program: "",
    args: [],
    command: "calculate_file_hash",
    commandArgs: { path: "{path}", algorithm: "md5" },
    builtin: true,
    enabled: true,
  },
];

export type ResolvedCall =
  | { kind: "command"; command: string; args: Record<string, string | number> }
  | { kind: "shell"; program: string; args: string[] }
  | { kind: "clipboard"; text: string };

const fill = (template: string, path: string) => template.split("{path}").join(path);

/**
 * 一个动作到底该发什么。单独做成纯函数是为了能在 node 里直接断言 ——
 * 尤其 mode 那格：填 444 会把文件设成 0o674，那是看不见的权限错乱。
 */
export function resolveActionCall(action: QuickAction, path: string): ResolvedCall {
  if (action.copyPath) return { kind: "clipboard", text: path };
  if (action.command) {
    const args: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(action.commandArgs ?? {})) {
      args[key] = typeof value === "number" ? value : fill(value, path);
    }
    return { kind: "command", command: action.command, args };
  }
  return { kind: "shell", program: action.program, args: action.args.map((a) => fill(a, path)) };
}

/** 结果讲成人话：具名命令的返回值形状各不相同 */
export function actionResultText(call: ResolvedCall, result: unknown): string {
  if (call.kind === "clipboard") return "路径已复制到剪贴板";
  if (typeof result === "string" && result.trim()) return result.trim();
  if (call.kind === "command" && call.command === "set_file_permissions") {
    const mode = (call.args as { mode?: number }).mode ?? 0;
    return `权限已设为 ${mode.toString(8)}`;
  }
  return "执行完成";
}

/**
 * 管理列表里那一行该显示什么。内置项现在是具名命令，program 是空的，
 * 不给出这句就只剩一片空白（看起来像"动作坏了"）。
 */
export function actionSummary(a: QuickAction): { head: string; detail: string } {
  if (a.copyPath) return { head: "剪贴板", detail: "把目标路径写入剪贴板" };
  if (a.command) {
    const args = Object.entries(a.commandArgs ?? {}).map(([k, v]) => `${k}=${v}`);
    return { head: a.command, detail: args.join(" ") };
  }
  return { head: a.program, detail: a.args.join(" ") };
}

export function loadQuickActions(): QuickAction[] {
  if (typeof window === "undefined") return DEFAULT_QUICK_ACTIONS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_QUICK_ACTIONS;
    const user = JSON.parse(raw) as QuickAction[];
    // 合并：内置（默认）+ 用户自定义；带着 builtin 标记却已经不在默认表里的
    // （比如被摘掉的 touch -m）不能从 localStorage 里复活
    const builtin = DEFAULT_QUICK_ACTIONS;
    return [...builtin, ...user.filter((u) => !isStaleBuiltin(u) && !builtin.some((b) => b.id === u.id))];
  } catch {
    return DEFAULT_QUICK_ACTIONS;
  }
}

/**
 * 老版本把 shell 形式的内置项写进了用户的 localStorage。
 * 那些条目在后端白名单下永远跑不通，读回来时要能认出来：
 * builtin 标记以本地默认表为准，被摘掉的（touch -m）不再回显。
 */
export function isStaleBuiltin(a: QuickAction): boolean {
  if (!a.builtin) return false;
  return !DEFAULT_QUICK_ACTIONS.some((d) => d.id === a.id);
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
