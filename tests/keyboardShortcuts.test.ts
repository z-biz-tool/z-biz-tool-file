/**
 * matchSpec 单测：快捷键的"命中判定"是纯函数，此前只能靠手按键盘验证。
 *
 * 回归用例是 Windows/Linux 上 Ctrl 系快捷键整体失效那一条 —— 界面文案写着 Ctrl，
 * 匹配逻辑却硬比 metaKey，两边互相矛盾且只有 mac 能按出来。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatShortcut, matchSpec, type ShortcutSpec } from "../src/_shared/useKeyboardShortcuts";

type Bits = {
  key?: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setPlatform(platform: string) {
  Object.defineProperty(globalThis, "navigator", {
    value: { platform },
    configurable: true,
    writable: true,
  });
}

/** 构造一个只带判定所需字段的伪 KeyboardEvent（node 环境下没有真实的构造器） */
function event(bits: Bits) {
  return {
    key: bits.key ?? "a",
    metaKey: !!bits.meta,
    ctrlKey: !!bits.ctrl,
    shiftKey: !!bits.shift,
    altKey: !!bits.alt,
  } as unknown as KeyboardEvent;
}

const cmdA: ShortcutSpec = { key: "a", meta: true, handler: () => {} };

describe("matchSpec：meta 表示主修饰键", () => {
  beforeEach(() => setPlatform("MacIntel"));
  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
  });

  it("mac 上 ⌘ 命中，Ctrl 不命中", () => {
    expect(matchSpec(cmdA, event({ meta: true }))).toBe(true);
    expect(matchSpec(cmdA, event({ ctrl: true }))).toBe(false);
  });

  it("Windows/Linux 上 Ctrl 命中（修复前这里是 false，⌘ 系快捷键整体失效）", () => {
    setPlatform("Win32");
    expect(matchSpec(cmdA, event({ ctrl: true }))).toBe(true);
    setPlatform("Linux x86_64");
    expect(matchSpec(cmdA, event({ ctrl: true }))).toBe(true);
  });

  it("非 mac 平台按 Ctrl 不会因 ctrl 字段被二次要求而落空", () => {
    setPlatform("Win32");
    const spec: ShortcutSpec = { key: "s", meta: true, shift: true, handler: () => {} };
    expect(matchSpec(spec, event({ key: "S", ctrl: true, shift: true }))).toBe(true);
  });

  it("mac 上 ctrl 字段仍是字面 control 键", () => {
    const spec: ShortcutSpec = { key: "l", ctrl: true, handler: () => {} };
    expect(matchSpec(spec, event({ key: "l", ctrl: true }))).toBe(true);
    expect(matchSpec(spec, event({ key: "l", meta: true }))).toBe(false);
  });
});

describe("matchSpec：修饰键必须精确匹配", () => {
  beforeEach(() => setPlatform("MacIntel"));
  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
  });

  it("多按一个 Shift 就不该命中", () => {
    expect(matchSpec(cmdA, event({ meta: true, shift: true }))).toBe(false);
  });

  it("不带修饰键的 Enter 在按下 ⌘ 时不命中", () => {
    const enter: ShortcutSpec = { key: "Enter", handler: () => {} };
    expect(matchSpec(enter, event({ key: "Enter" }))).toBe(true);
    expect(matchSpec(enter, event({ key: "Enter", meta: true }))).toBe(false);
  });

  it("⌥ 系导航键要求 alt", () => {
    const back: ShortcutSpec = { key: "ArrowLeft", alt: true, handler: () => {} };
    expect(matchSpec(back, event({ key: "ArrowLeft", alt: true }))).toBe(true);
    expect(matchSpec(back, event({ key: "ArrowLeft" }))).toBe(false);
  });

  it("主键大小写不敏感，但功能键名不能被小写误伤", () => {
    expect(matchSpec(cmdA, event({ key: "A", meta: true }))).toBe(true);
    const bs: ShortcutSpec = { key: "Backspace", meta: true, handler: () => {} };
    expect(matchSpec(bs, event({ key: "a", meta: true }))).toBe(false);
    expect(matchSpec(cmdA, event({ key: "Backspace", meta: true }))).toBe(false);
  });
});

describe("formatShortcut 与 matchSpec 口径一致", () => {
  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
  });

  it("提示写 Ctrl 的平台，实际就要求按下 Ctrl", () => {
    setPlatform("Win32");
    expect(formatShortcut(cmdA)).toBe("Ctrl + A");
    expect(matchSpec(cmdA, event({ ctrl: true }))).toBe(true);
    expect(matchSpec(cmdA, event({ meta: true }))).toBe(false);
  });

  it("mac 上同一份 spec 显示为 ⌘", () => {
    setPlatform("MacIntel");
    expect(formatShortcut(cmdA)).toBe("⌘ + A");
  });
});

describe("matchSpec：撤销/重做这类同键不同 Shift 的组合必须互斥", () => {
  beforeEach(() => setPlatform("MacIntel"));
  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
  });

  // 命中即 return：⌘Z 排在前面，一旦 shift 判定放松一点，⌘⇧Z 就会去执行撤销，
  // 重做永远点不着 —— 而界面上两个按钮都各有自己的禁用态，看不出问题。
  const undo: ShortcutSpec = { key: "z", meta: true, handler: () => {} };
  const redo: ShortcutSpec = { key: "z", meta: true, shift: true, handler: () => {} };

  it("⌘Z 只命中撤销，⌘⇧Z 只命中重做", () => {
    expect(matchSpec(undo, event({ key: "z", meta: true }))).toBe(true);
    expect(matchSpec(undo, event({ key: "Z", meta: true, shift: true }))).toBe(false);
    expect(matchSpec(redo, event({ key: "Z", meta: true, shift: true }))).toBe(true);
    expect(matchSpec(redo, event({ key: "z", meta: true }))).toBe(false);
  });

  it("Windows 上走 Ctrl 也一样互斥", () => {
    setPlatform("Win32");
    expect(matchSpec(undo, event({ key: "z", ctrl: true }))).toBe(true);
    expect(matchSpec(undo, event({ key: "Z", ctrl: true, shift: true }))).toBe(false);
    expect(matchSpec(redo, event({ key: "Z", ctrl: true, shift: true }))).toBe(true);
  });
});
