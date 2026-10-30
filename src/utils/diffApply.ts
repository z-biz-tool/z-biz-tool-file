/**
 * diff 结果"应用到另一侧"的公共逻辑。
 *
 * DiffViewer（弹窗里的文件对比）与 DualPanelView（双栏对比）都要能"用一侧覆盖另一侧"，
 * 而这是一件会**改写用户文件**的事：确认框必须说清"从哪到哪、目标路径是哪个"，
 * 否则用户点的是"用左侧覆盖右侧"，实际被盖掉的可能是另一个目录里的同名文件。
 *
 * 所以这里把三件事收在一处，让两个入口没法各自漂移：
 * 1. 方向（谁流向谁）到后端 mode 的映射；
 * 2. 确认框文案（必须带目标路径）；
 * 3. 真正调用后端的 invoke。
 */

/** 与后端 `DiffApplyMode` 对应（serde rename_all = "snake_case"）。 */
export type DiffApplyMode = "left_to_right" | "right_to_left" | "swap";

/** 用户能点的三个动作。 */
export type DiffApplyAction = "left_to_right" | "right_to_left" | "swap";

/** 一个动作的展示信息：标题、按钮文案、以及"会改哪个文件"。 */
export interface DiffApplyDescriptor {
  mode: DiffApplyMode;
  /** 确认框标题 */
  title: string;
  /** 确认框正文（含源与目标路径） */
  content: string;
  /** 主按钮文案 */
  okText: string;
  /** 目标路径（swap 时是两侧） */
  targetPaths: string[];
}

/**
 * 算出某个动作的展示信息。
 *
 * `left` / `right` 是两个文件的绝对路径。任一为空都不能构造动作 ——
 * 那种情况下按钮根本不该出现（而不是点了以后才报错）。
 */
export function describeApply(
  action: DiffApplyAction,
  left: string | null,
  right: string | null
): DiffApplyDescriptor | null {
  if (!left || !right) return null;

  if (action === "left_to_right") {
    return {
      mode: "left_to_right",
      title: "用左侧覆盖右侧？",
      content:
        `左侧内容会**覆盖**右侧文件。\n` +
        `源：${left}\n` +
        `目标（将被改写）：${right}\n` +
        `目标当前内容会被丢弃，且无法撤销。`,
      okText: "覆盖右侧",
      targetPaths: [right],
    };
  }

  if (action === "right_to_left") {
    return {
      mode: "right_to_left",
      title: "用右侧覆盖左侧？",
      content:
        `右侧内容会**覆盖**左侧文件。\n` +
        `源：${right}\n` +
        `目标（将被改写）：${left}\n` +
        `目标当前内容会被丢弃，且无法撤销。`,
      okText: "覆盖左侧",
      targetPaths: [left],
    };
  }

  return {
    mode: "swap",
    title: "左右互换？",
    content:
      `两个文件的内容会**互换**。\n` +
      `左侧 ↔ 右侧\n` +
      `将被改写：\n· ${left}\n· ${right}\n` +
      `两边当前内容都会被替换，且无法撤销。`,
    okText: "互换",
    targetPaths: [left, right],
  };
}

/**
 * 确认框的正文渲染成普通文本（去掉 markdown 记号）。
 *
 * antd 的 confirm content 支持 ReactNode，但纯文本更不容易被误读成可点的链接，
 * 而且路径里有 `_` `*` 时不会变成斜体。
 */
export function applyConfirmText(desc: DiffApplyDescriptor): string {
  return desc.content.replace(/\*\*/g, "");
}
