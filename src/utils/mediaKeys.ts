/**
 * 媒体库（照片馆/视频馆/音乐馆）的键盘动作映射。
 *
 * 主列表早就吃全局快捷键（Enter 打开选中项、⌘⌫ 移到回收站），画廊里之前只能靠鼠标：
 * 单击选中之后按回车什么都不发生，而按 Delete 会被浏览器当成"后退"语义的键位吞掉。
 * 映射抽成纯函数是因为渲染要 DOM、进不了 node 测试，而"哪个键算哪个动作"是能被断言的口径。
 */

export type MediaKeyAction = "open" | "delete" | "prev" | "next" | "clear" | null;

export interface MediaKeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export function mediaKeyAction(e: MediaKeyLike): MediaKeyAction {
  // ⌘/Ctrl + Enter 与单独 Enter 同义（与主列表的"打开选中项"一致）
  if (e.key === "Enter") return "open";
  // 单独 Backspace 不抢：那是用户在输入框里删字符的键
  if (e.key === "Backspace") return e.metaKey || e.ctrlKey ? "delete" : null;
  if (e.key === "Delete" || e.key === "Del") return "delete";
  if (e.key === "ArrowLeft") return "prev";
  if (e.key === "ArrowRight") return "next";
  if (e.key === "Escape") return "clear";
  return null;
}

/**
 * 网格里的上下方向需要知道一行几列，而"几列"取决于运行时宽度
 * —— 猜一个步长的话，方向键会跳出莫名其妙的位移，比没有更难解释。
 * 所以这里只给确定的 ±1，越界保持原地（不循环：循环会让"往右走"绕回第一行，
 * 用户以为自己按错了键）。
 */
export function nextSelectedIndex(current: number, total: number, action: "prev" | "next"): number {
  if (total <= 0) return -1;
  if (current < 0) return action === "next" ? 0 : total - 1;
  const step = action === "next" ? 1 : -1;
  return Math.min(total - 1, Math.max(0, current + step));
}
