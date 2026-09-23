/**
 * 快捷键面板的纯逻辑：spec 数组 → 分组表 → 搜索过滤。
 *
 * 面板吃的是注册用的那份 spec（不是另抄的说明表），所以这几条断言同时也是
 * "面板不会说谎"的底线：没有 description 的注册项不能出现、键位必须和
 * matchSpec 真正的判定口径一致（mac 上字面 control 显示成 ⌘ 就是说谎）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeShortcuts,
  filterShortcutDocs,
  formatShortcut,
  type ShortcutSpec,
} from "../src/_shared/useKeyboardShortcuts";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setPlatform(platform: string) {
  Object.defineProperty(globalThis, "navigator", {
    value: { platform },
    configurable: true,
    writable: true,
  });
}

const noop = () => {};

/** 只带面板需要的字段的伪 spec */
function spec(bits: Partial<ShortcutSpec> & { key: string }): ShortcutSpec {
  return { handler: noop, ...bits };
}

beforeEach(() => setPlatform("MacIntel"));
afterEach(() => {
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});

describe("formatShortcut 的字面 control", () => {
  it("mac 上 ctrl 显示成 ⌃，不是 ⌘", () => {
    // matchSpec 在 mac 上要求的是 e.ctrlKey，显示成 ⌘ 会让用户去按一个永不触发的键
    expect(formatShortcut(spec({ key: "l", ctrl: true }))).toBe("⌃ + L");
    expect(formatShortcut(spec({ key: "l", ctrl: true, shift: true }))).toBe("⌃ + ⇧ + L");
  });

  it("meta 仍然按主修饰键渲染", () => {
    expect(formatShortcut(spec({ key: "k", meta: true }))).toBe("⌘ + K");
    setPlatform("Win32");
    expect(formatShortcut(spec({ key: "k", meta: true }))).toBe("Ctrl + K");
  });
});

describe("describeShortcuts", () => {
  const specs: ShortcutSpec[] = [
    spec({ key: "b", meta: true, description: "折叠/展开侧栏", group: "视图" }),
    spec({ key: "ArrowLeft", alt: true, description: "后退", group: "导航" }),
    spec({ key: "l", meta: true }), // 没有 description：内部开关，不进面板
    spec({ key: "F1", description: "查看快捷键面板" }), // 没写 group：落到"通用"
    spec({ key: "Delete", description: "移到回收站", group: "删除" }),
    spec({ key: "Backspace", meta: true, description: "移到回收站", group: "删除" }),
  ];

  it("按 group 聚合并保留注册顺序", () => {
    expect(describeShortcuts(specs).map((g) => g.group)).toEqual(["视图", "导航", "通用", "删除"]);
  });

  it("没有 description 的注册项不会出现，同组多条各自保留", () => {
    const groups = describeShortcuts(specs);
    expect(groups.flatMap((g) => g.items.map((i) => i.label))).toEqual([
      "折叠/展开侧栏",
      "后退",
      "查看快捷键面板",
      "移到回收站",
      "移到回收站",
    ]);
    // 同一个功能的两条键位（Delete / ⌘⌫）是不同行，不能合并成一条
    const del = groups.find((g) => g.group === "删除")!;
    expect(del.items.map((i) => i.keys)).toEqual(["Delete", "⌘ + ⌫"]);
  });

  it("键位是已经按当前平台渲染好的", () => {
    const item = describeShortcuts(specs)[0].items[0];
    expect(item.keys).toBe("⌘ + B");
    setPlatform("Win32");
    expect(describeShortcuts(specs)[0].items[0].keys).toBe("Ctrl + B");
  });

  it("空白 description / group 等同没写", () => {
    const groups = describeShortcuts([
      spec({ key: "x", description: "   ", group: "  " }),
      spec({ key: "y", description: "真的", group: "   " }),
    ]);
    expect(groups).toEqual([
      { group: "通用", items: [{ keys: "Y", label: "真的", group: "通用" }] },
    ]);
  });
});

describe("filterShortcutDocs", () => {
  const groups = describeShortcuts([
    spec({ key: "t", meta: true, description: "新建标签页", group: "标签页" }),
    spec({ key: "ArrowLeft", alt: true, description: "后退", group: "导航" }),
    spec({ key: "1", meta: true, description: "表格视图", group: "视图" }),
  ]);

  it("空查询原样返回全部分组", () => {
    expect(filterShortcutDocs(groups, "").map((g) => g.group)).toEqual(["标签页", "导航", "视图"]);
    expect(filterShortcutDocs(groups, "   ").map((g) => g.group)).toHaveLength(3);
  });

  it("按功能名搜", () => {
    const hit = filterShortcutDocs(groups, "标签");
    expect(hit).toHaveLength(1);
    expect(hit[0].group).toBe("标签页");
    expect(hit[0].items[0].label).toBe("新建标签页");
  });

  it("按键位搜，大小写不敏感", () => {
    expect(filterShortcutDocs(groups, "⌥").map((g) => g.items[0].label)).toEqual(["后退"]);
    expect(filterShortcutDocs(groups, "⌘ + 1").map((g) => g.items[0].label)).toEqual(["表格视图"]);
    expect(filterShortcutDocs(groups, "T").map((g) => g.items[0].label)).toEqual(["新建标签页"]);
  });

  it("搜不到时返回空列表，而不是留着空分组标题", () => {
    expect(filterShortcutDocs(groups, "不存在的功能")).toEqual([]);
    // 分组里只剩命中那一条
    expect(filterShortcutDocs(groups, "视图")[0].items).toHaveLength(1);
  });
});
