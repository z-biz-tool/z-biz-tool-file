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
  /** 面板里的分组标题；不写就落到"通用" */
  group?: string;
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
  // meta 是"主修饰键"（mac ⌘ / 其他平台 Ctrl），ctrl 是字面 control 键 —— 在 mac 上
  // 显示成 ⌘ 会让面板直接说谎：按 ⌘ 根本不会触发（matchSpec 要的是 e.ctrlKey）。
  if (spec.meta) parts.push(isMac ? "⌘" : "Ctrl");
  else if (spec.ctrl) parts.push(isMac ? "⌃" : "Ctrl");
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
  // 单个字母显示成大写：工具栏的 tooltip 一直写的是 "刷新 (⌘+R)"，
  // 面板里再冒出 "⌘ + r" 就成了同一个应用两套写法（matchSpec 本来就不分大小写）
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join(" + ");
}

export interface ShortcutDocItem {
  /** 已经按当前平台渲染好的键位，如 "⌘ + ⇧ + N" */
  keys: string;
  label: string;
  group: string;
}

export interface ShortcutDocGroup {
  group: string;
  items: ShortcutDocItem[];
}

const UNGROUPED = "通用";

/**
 * 把注册用的 spec 数组渲染成面板要的形状。
 *
 * 面板必须吃**同一份** spec 数组，而不是另抄一份说明表：快捷键一旦改了键位、
 * 删了某条，手写的表就会开始教用户按一个不存在的组合键。没有 description 的
 * 注册项（比如某些内部开关）不进面板 —— 面板只回答"按这个键会发生什么"。
 */
export function describeShortcuts(specs: ShortcutSpec[]): ShortcutDocGroup[] {
  const byGroup = new Map<string, ShortcutDocItem[]>();
  for (const spec of specs) {
    const label = spec.description?.trim();
    if (!label) continue;
    const group = spec.group?.trim() || UNGROUPED;
    const item: ShortcutDocItem = { keys: formatShortcut(spec), label, group };
    const bucket = byGroup.get(group);
    if (bucket) bucket.push(item);
    else byGroup.set(group, [item]);
  }
  // Map 保留注册顺序，面板的分组顺序因此和代码里读到的顺序一致
  return [...byGroup.entries()].map(([group, items]) => ({ group, items }));
}

/**
 * 把注册表倒排成"描述 → 键位提示"，给 tooltip、右键菜单这类地方现取。
 *
 * 写死 `刷新 (⌘+R)` 有两个错：Windows/Linux 用户在按一个不存在的键（matchSpec
 * 早就改成"主修饰键"了，Windows 上其实是 Ctrl+R），以及快捷键一改 tooltip 就悄悄说谎。
 * 没写 description 的注册项不进表；同名描述以第一条注册的为准。
 */
export function shortcutHints(specs: ShortcutSpec[]): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const spec of specs) {
    const desc = spec.description?.trim();
    if (!desc || hints[desc]) continue;
    hints[desc] = formatShortcut(spec);
  }
  return hints;
}

/** 按功能名或键位过滤；空查询返回原样（含空组会被丢掉，面板不该显示一个空标题） */
export function filterShortcutDocs(
  groups: ShortcutDocGroup[],
  query: string
): ShortcutDocGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups.filter((g) => g.items.length > 0);
  return groups
    .map((g) => ({
      group: g.group,
      items: g.items.filter(
        (i) => i.label.toLowerCase().includes(q) || i.keys.toLowerCase().includes(q)
      ),
    }))
    .filter((g) => g.items.length > 0);
}