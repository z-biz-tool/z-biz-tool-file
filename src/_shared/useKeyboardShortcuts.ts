import { useEffect } from "react";

export interface ShortcutSpec {
  /** 主键（如 "k"、"ArrowLeft"） */
  key: string;
  /** 主修饰键：mac 上 ⌘、其他平台 Ctrl */
  meta?: boolean;
  /** 字面 Ctrl 键（主要给 mac 上的 control 用；其他平台请按 meta） */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** 触发时的回调 */
  handler: (e: KeyboardEvent) => void;
  /** 是否允许在输入控件聚焦时触发，默认 false */
  allowInInput?: boolean;
  /** 阻止默认行为，默认 true */
  preventDefault?: boolean;
  /** 描述（用于快捷键面板） */
  description?: string;
}

/**
 * 判断当前焦点是否处于可输入控件内（input/textarea/contenteditable）
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * 判断一次 keydown 是否命中某个 spec。
 *
 * 导出仅为可单测：它是纯函数，而整条快捷键链路此前只能靠手按键盘验证。
 */
export function matchSpec(spec: ShortcutSpec, e: KeyboardEvent): boolean {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
  // meta 表示"主修饰键"：mac 上是 ⌘，其他平台是 Ctrl —— 与 formatShortcut 里
  // "⌘ / Ctrl" 的显示保持一致。此前这里直接比 e.metaKey，16 条 ⌘ 快捷键在
  // Windows/Linux 上永不触发，但界面上却告诉用户按 Ctrl。
  const modKey = isMac ? e.metaKey : e.ctrlKey;

  if (!!spec.meta !== modKey) return false;
  // ctrl 是字面 Ctrl 键（mac 上那个 control）。非 mac 平台它已经充当主修饰键，
  // 不能再单独要求一次，否则 ⌘ 类快捷键会在 Windows 上被这条判掉。
  if (isMac && !!spec.ctrl !== e.ctrlKey) return false;
  if (!!spec.shift !== e.shiftKey) return false;
  if (!!spec.alt !== e.altKey) return false;

  // 主键匹配（大小写不敏感 + 支持 " "、"Escape" 等）
  const wanted = spec.key.length === 1 ? spec.key.toLowerCase() : spec.key;
  const actual = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return wanted === actual;
}

/**
 * 全局快捷键 hook。
 * - 焦点在输入控件时默认不响应（可单独覆盖 allowInInput）
 * - 自动 preventDefault（可关闭）
 */
export function useKeyboardShortcuts(specs: ShortcutSpec[], enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const inEditable = isEditableTarget(e.target);
      for (const spec of specs) {
        if (!matchSpec(spec, e)) continue;
        if (inEditable && !spec.allowInInput) continue;
        if (spec.preventDefault !== false) e.preventDefault();
        spec.handler(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [specs, enabled]);
}

/**
 * 将快捷键规格渲染为可读的键位提示（如 "⌘ + Shift + L"）
 */
export function formatShortcut(spec: ShortcutSpec): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
  const parts: string[] = [];
  if (spec.meta || spec.ctrl) parts.push(isMac ? "⌘" : "Ctrl");
  if (spec.alt) parts.push(isMac ? "⌥" : "Alt");
  if (spec.shift) parts.push(isMac ? "⇧" : "Shift");
  let key = spec.key;
  if (key === " ") key = "Space";
  if (key === "ArrowLeft") key = "←";
  if (key === "ArrowRight") key = "→";
  if (key === "ArrowUp") key = "↑";
  if (key === "ArrowDown") key = "↓";
  if (key === "Escape") key = "Esc";
  if (key === "Enter") key = "⏎";
  if (key === "Backspace") key = "⌫";
  parts.push(key);
  return parts.join(" + ");
}