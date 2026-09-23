/**
 * 文件/目录名合法性校验。
 *
 * 之前 handleCreate 是"拿到名字就 invoke，后端报错再 message.error"。两个坏处：
 *   1) 用户敲 "a/b" 会变成 "currentPath/a/b"，后端默默把它当目录创建，
 *      文件名错乱但界面看起来"成功了"。
 *   2) 错误是后端透出来的"无效路径"，用户不知道是名字里有 / 还是盘符卷的问题。
 *
 * 把校验前移，违规即时报"这个名字不能用，因为 X"——后端只负责落盘。
 */
export type FileNameRule =
  | "empty"
  | "whitespace"
  | "slash"
  | "backslash"
  | "nul"
  | "dot"
  | "dotdot"
  | "trailing-space"
  | "trailing-dot"
  | "control";

export interface FileNameIssue {
  rule: FileNameRule;
  /** 给用户看的中文描述 */
  message: string;
}

/**
 * 校验结果：null = 通过；非 null = 第一条违规项。
 *
 * 这里返回第一条违规就够了 —— UI 用 message.error 一次性讲明白，下一条
 * 留给下次敲字（校验函数 onChange 也会再跑）。
 */
export function validateFileName(name: string): FileNameIssue | null {
  // trim 前先判空，否则 trim 后看起来非空但全是空白
  if (!name) return { rule: "empty", message: "名字不能为空" };
  if (/^\s*$/.test(name)) return { rule: "whitespace", message: "名字不能只有空白字符" };
  // 控制字符（含 \0 / \r / \n / \t 之外的一切 <=0x1f）一律拒
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return { rule: "control", message: "名字里不能包含控制字符" };
  if (name.includes("/")) return { rule: "slash", message: "名字里不能包含 \"/\"，需要建子目录请用「新建文件夹」" };
  if (name.includes("\\")) return { rule: "backslash", message: "名字里不能包含 \"\\\"，需要建子目录请用「新建文件夹」" };
  if (name === ".") return { rule: "dot", message: "名字不能是 \".\"" };
  if (name === "..") return { rule: "dotdot", message: "名字不能是 \"..\"" };
  // macOS 把 "a " / "a." 当成 "a"——后端会真的建出来一个空文件/目录，
  // 但 UI 上看着名字不一样，搜索/选择都指不到。前端先拒，免得用户走丢。
  if (/\s$/.test(name)) return { rule: "trailing-space", message: "名字末尾不能有空格" };
  if (/\.$/.test(name)) return { rule: "trailing-dot", message: "名字末尾不能有 \".\"" };
  return null;
}

/** 用于在 onChange 时实时清理输入：把非法字符替换成 ''。不能用的规则保留拒绝（empty/dot/dotdot）。 */
export function sanitizeFileNameInput(name: string): string {
  return name
    // 控制字符：直接吞掉（用户大概率敲不出来，但粘路径时容易带上）
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[\\/]/g, "")
    .replace(/\.+$/g, ""); // 末尾的 . 是 macOS 静默剥离的元凶
}

/**
 * 提交时最终兜底：trim + 校验。
 * 返回 {ok: true, name} 或 {ok: false, issue}。
 */
export function checkFileNameForCreate(raw: string):
  | { ok: true; name: string }
  | { ok: false; issue: FileNameIssue } {
  // 顺序很关键：先看 raw 是不是真空字符串，再看 trim 后是不是全空白，
  // 最后校验 trim 后的串。否则"   "会先撞 empty，"a " 之类合法但带尾空格的
  // 串也能拿到带空格的 trimmed 触发 trailing-space（这条本意是拒 macOS 的
  // "a " 这种隐性名字，trim 后就剩 "a" 反而通过了——正好符合预期）。
  if (!raw) return { ok: false, issue: { rule: "empty", message: "名字不能为空" } };
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, issue: { rule: "whitespace", message: "名字不能只有空白字符" } };
  }
  const issue = validateFileName(trimmed);
  if (issue) return { ok: false, issue };
  return { ok: true, name: trimmed };
}