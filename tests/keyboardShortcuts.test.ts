/**
 * matchSpec 单测：快捷键的"命中判定"是纯函数，此前只能靠手按键盘验证。
 *
 * 回归用例是 Windows/Linux 上 Ctrl 系快捷键整体失效那一条 —— 界面文案写着 Ctrl，
 * 匹配逻辑却硬比 metaKey，两边互相矛盾且只有 mac 能按出来。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatShortcut,
  isActivationKeyOnControl,
  blocksGlobalShortcut,
  matchSpec,
  type ShortcutSpec,
} from "../src/_shared/useKeyboardShortcuts";

type Bits = {
  key?: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  prevented?: boolean;
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
    // 组件（React 的 root 容器监听）比 window 先跑；它 preventDefault 之后
    // 原生事件上这个标记就是 true —— 全局这层要看它让路
    defaultPrevented: !!bits.prevented,
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

/**
 * isActivationKeyOnControl：光标停在按钮上按 Enter 时，全局快捷键必须让路。
 *
 * 回归用例是"聚焦标签页关闭按钮按 Enter"：快捷键无条件 preventDefault 把按钮自己的
 * 激活行为取消掉了，标签没关掉反倒跑了"打开选中项"。
 * 这里的 node 只测纯判定；"preventDefault 真会吃掉按钮激活、让路后标签真能关掉"
 * 属于浏览器行为，只能在实盘页面验（见 doc 里记的 dev-server 通道）。
 */
describe("isActivationKeyOnControl：Enter/Space 归聚焦的控件，不归全局快捷键", () => {
  /**
   * 真实 DOM 里 closest 挂在 Element.prototype 上（不是实例自有属性），签名
   * (selector) => Element | null，选择器不命中返回 null。node 环境没有 DOM，
   * 所以按同一形状造：class 方法=原型方法，matches 声明这个节点"是"哪几种选择器。
   */
  class FakeNode {
    closestCalls: string[] = [];
    matches: string[];
    constructor(matches: string[]) {
      this.matches = matches;
    }
    closest(selector: string) {
      this.closestCalls.push(selector);
      const hit = selector
        .split(",")
        .map((s) => s.trim())
        .some((s) => this.matches.includes(s));
      return hit ? (this as unknown as Element) : null;
    }
  }

  const asTarget = (n: unknown) => n as unknown as EventTarget;

  it("原生 button 上的 Enter 与 Space 让路，字母键不让", () => {
    const btn = new FakeNode(["button"]);
    expect(isActivationKeyOnControl(asTarget(btn), event({ key: "Enter" }))).toBe(true);
    expect(isActivationKeyOnControl(asTarget(btn), event({ key: " " }))).toBe(true);
    // 字母/功能键不是"点这个控件"的按键，拦下来就等于把快捷键全废了
    expect(isActivationKeyOnControl(asTarget(btn), event({ key: "t" }))).toBe(false);
    expect(isActivationKeyOnControl(asTarget(btn), event({ key: "Delete" }))).toBe(false);
    // 字母键在查 DOM 之前就该判掉：一次 keydown 都要 closest 一遍是没必要的开销
    expect(btn.closestCalls).toHaveLength(2);
  });

  it("Shift 不算修饰（Shift+Enter 仍会激活按钮），但 ⌘/Ctrl/Alt 一按就是另一回事", () => {
    const btn = new FakeNode(["button"]);
    expect(isActivationKeyOnControl(asTarget(btn), event({ key: "Enter", shift: true }))).toBe(true);
    // ⌘T / ⌥← 这类组合浏览器不当成点击：光标落在按钮上时它们照样是全局快捷键，
    // 一旦这里连修饰键一起放过，整个快捷键系统在按钮聚焦时集体失灵。
    expect(isActivationKeyOnControl(asTarget(btn), event({ key: "Enter", meta: true }))).toBe(false);
    expect(isActivationKeyOnControl(asTarget(btn), event({ key: "Enter", ctrl: true }))).toBe(false);
    expect(isActivationKeyOnControl(asTarget(btn), event({ key: "Enter", alt: true }))).toBe(false);
  });

  it("选择器覆盖原生 button / 带 href 的链接 / 自制 role=button，但不含裸 a 与 role=tab", () => {
    const link = new FakeNode(["a[href]"]);
    expect(isActivationKeyOnControl(asTarget(link), event({ key: "Enter" }))).toBe(true);
    // 面包屑那三个自制控件走的是 role=button
    const crumb = new FakeNode(["[role='button']"]);
    expect(isActivationKeyOnControl(asTarget(crumb), event({ key: "Enter" }))).toBe(true);
    // 没有 href 的 a 拿不到焦点也不会被激活；tab 由 rc-tabs 自己管方向键
    const plain = new FakeNode(["a", "[role='tab']"]);
    expect(isActivationKeyOnControl(asTarget(plain), event({ key: "Enter" }))).toBe(false);
    const selector = link.closestCalls[0];
    for (const token of ["button", "a[href]", "[role='button']"]) {
      expect(selector.split(",").map((s) => s.trim())).toContain(token);
    }
  });

  it("target 没有 closest（window/document 这类）时既不抛也不让路", () => {
    // node 环境没有 Element 全局，代码里若写 target instanceof Element 会直接 ReferenceError；
    // 真浏览器里事件也可能以 window 为 target（程序化 dispatch）。
    expect(isActivationKeyOnControl(null, event({ key: "Enter" }))).toBe(false);
    expect(isActivationKeyOnControl({ tagName: "WINDOW" } as unknown as EventTarget, event({ key: "Enter" }))).toBe(false);
  });
});

/**
 * blocksGlobalShortcut：组件已经处理掉的那一下按键，全局快捷键不再重复做。
 *
 * 媒体库（照片馆）那圈容器自己处理 Enter / ⌘⌫ / ←→，而 React 的监听挂在 root 容器上、
 * 比 window 先跑 —— 不让路的话一次 ⌘⌫ 会同时弹"画廊选中的那一张"和"主列表选中项"两个确认框。
 */
describe("blocksGlobalShortcut：已被组件处理的按键要让路", () => {
  const plain = { closest: () => null } as unknown as EventTarget;

  it("preventDefault 过的按键不再跑第二遍", () => {
    expect(blocksGlobalShortcut(plain, event({ key: "Backspace", meta: true, prevented: true }))).toBe(true);
    expect(blocksGlobalShortcut(plain, event({ key: "Enter", prevented: true }))).toBe(true);
    // 没被处理过的才照常走全局
    expect(blocksGlobalShortcut(plain, event({ key: "Backspace", meta: true }))).toBe(false);
    expect(blocksGlobalShortcut(plain, event({ key: "k", meta: true }))).toBe(false);
  });

  it("未被处理但仍属于聚焦控件的 Enter，仍旧按老规则让路", () => {
    const btn = { closest: (sel: string) => (sel.includes("button") ? ({} as Element) : null) } as unknown as EventTarget;
    expect(blocksGlobalShortcut(btn, event({ key: "Enter" }))).toBe(true);
    expect(blocksGlobalShortcut(btn, event({ key: "Delete" }))).toBe(false);
  });
});
