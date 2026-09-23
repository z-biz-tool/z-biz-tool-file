/**
 * 把 App 里那份快捷键注册表下发给子组件，让所有键位提示共用一个来源。
 *
 * 子组件（Omnibar / TabsBar / FileContentPreview…）各自写死 "后退 (⌥+←)" 有两个问题：
 * 注册表改了它不知道，以及在 Windows/Linux 上 ⌥ 系提示指向的键位与实际判定不符
 * （matchSpec 的主修饰键在非 mac 是 Ctrl）。没有 Provider 时 hint() 退化成空串，
 * 也就是"少一句提示"，不会撒谎说一个不存在的键。
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { shortcutHints, type ShortcutSpec } from "./useKeyboardShortcuts";

type HintMap = Record<string, string>;

const EMPTY_HINTS: HintMap = {};
const ShortcutHintsContext = createContext<HintMap>(EMPTY_HINTS);

/** 纯函数形态：单测和 App 顶层都用它，避免两处各写一遍取值逻辑 */
export function hintSuffixOf(hints: HintMap, description: string): string {
  const keys = hints[description];
  return keys ? ` (${keys})` : "";
}

export function ShortcutHintsProvider({
  specs,
  children,
}: {
  specs: ShortcutSpec[];
  children: ReactNode;
}) {
  const hints = useMemo(() => shortcutHints(specs), [specs]);
  return <ShortcutHintsContext.Provider value={hints}>{children}</ShortcutHintsContext.Provider>;
}

/** 返回 `(description) => " (⌥ + ←)"`，可直接拼进 tooltip / 菜单文案 */
export function useShortcutHint(): (description: string) => string {
  const hints = useContext(ShortcutHintsContext);
  return useCallback((description: string) => hintSuffixOf(hints, description), [hints]);
}
