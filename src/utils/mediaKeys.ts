/**
 * 媒体库（照片馆/视频馆/音乐馆）的键盘动作映射。
 *
 * 主列表早就吃全局快捷键（Enter 打开选中项、⌘⌫ 移到回收站），画廊里之前只能靠鼠标：
 * 单击选中之后按回车什么都不发生，而按 Delete 会被浏览器当成"后退"语义的键位吞掉。
 * 映射抽成纯函数是因为渲染要 DOM、进不了 node 测试，而"哪个键算哪个动作"是能被断言的口径。
 */

export type MediaKeyAction = "open" | "delete" | "prev" | "next" | "up" | "down" | "clear" | null;

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
  if (e.key === "ArrowUp") return "up";
  if (e.key === "ArrowDown") return "down";
  if (e.key === "Escape") return "clear";
  return null;
}

/**
 * 网格里的上下方向需要知道一行几列，而"几列"取决于运行时宽度
 * —— 猜一个步长的话，方向键会跳出莫名其妙的位移，比没有更难解释。
 * `columns` 由 `MediaGallery` 用 ResizeObserver 实时算出来再喂进来：
 * `Math.max(1, floor((containerWidth - padding) / minColumnWidth))`。
 * 列数 < 1 视为单列（音频/列表视图），上/下退化为 ±1。
 * 越界保持原地（不循环：循环会让"往右走"绕回第一行，
 * 用户以为自己按错了键）。
 */
export function nextSelectedIndex(
  current: number,
  total: number,
  action: "prev" | "next" | "up" | "down",
  columns = 1,
): number {
  if (total <= 0) return -1;
  // 没选中时：next/right 落到第一项，prev/right 落到最后一项；up/down 也按列首尾处理
  if (current < 0) {
    if (action === "next" || action === "down") return 0;
    return total - 1;
  }
  void columns; // 仅对 up/down 生效，下面会用到
  switch (action) {
    case "next":
      return Math.min(total - 1, current + 1);
    case "prev":
      return Math.max(0, current - 1);
    case "down":
      // 列数为 0 或 1 时退化为 +1；多列时跳到下一行同列位置
      return Math.min(total - 1, current + Math.max(1, columns));
    case "up":
      return Math.max(0, current - Math.max(1, columns));
  }
}
