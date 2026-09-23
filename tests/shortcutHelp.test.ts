/**
 * 快捷键面板的纯逻辑：spec 数组 → 分组表 → 搜索过滤。
 *
 * 面板吃的是注册用的那份 spec（不是另抄的说明表），所以这几条断言同时也是
 * "面板不会说谎"的底线：没有 description 的注册项不能出现、键位必须和
 * matchSpec 真正的判定口径一致（mac 上字面 control 显示成 ⌘ 就是说谎）。
 *
 * 最后一段不测函数，直接扫 src/App.tsx：hintSuffix 查不到 key 时返回空串，
 * 表现是"tooltip 少了一句键位"——不报错、不红屏、肉眼也难发现，只能源码级断言。
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeShortcuts,
  filterShortcutDocs,
  formatShortcut,
  shortcutHints,
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

describe("shortcutHints：tooltip 的键位来源", () => {
  const specs: ShortcutSpec[] = [
    spec({ key: "r", meta: true, description: "刷新当前目录", group: "通用" }),
    spec({ key: "Delete", description: "移到回收站", group: "删除" }),
    spec({ key: "Backspace", meta: true, description: "移到回收站", group: "删除" }),
    spec({ key: "l", meta: true }), // 内部开关：不该进表
    spec({ key: "h", meta: true, shift: true, description: "  显示/隐藏隐藏文件  " }),
  ];

  it("键位按当前平台渲染（Windows 上不再提示去按 ⌘）", () => {
    expect(shortcutHints(specs)["刷新当前目录"]).toBe("⌘ + R");
    setPlatform("Win32");
    expect(shortcutHints(specs)["刷新当前目录"]).toBe("Ctrl + R");
  });

  it("没有 description 的注册项不进表；空白两侧会被 trim", () => {
    const hints = shortcutHints(specs);
    expect("undefined" in hints).toBe(false);
    expect(Object.keys(hints).some((k) => k.includes("  "))).toBe(false);
    expect(hints["显示/隐藏隐藏文件"]).toBe("⌘ + ⇧ + H");
  });

  it("一个功能多个键位时取注册顺序第一条：tooltip 只放一个代表键，全量看面板", () => {
    // 面板（describeShortcuts）刻意保留两行，这里反过来要收敛成一行，
    // 否则 tooltip 会写成「复制 (⌘ + C 或 Ctrl + Insert)」这种没法看的东西。
    // 断言"取第一条"而不是"随便一条"：顺序换了要能在测试里看见。
    expect(shortcutHints(specs)["移到回收站"]).toBe("Delete");
    const swapped = [specs[2], specs[1], ...specs.slice(0, 1), ...specs.slice(3)];
    expect(shortcutHints(swapped)["移到回收站"]).toBe("⌘ + ⌫");
  });
});

describe("结构闸：App.tsx 里 hintSuffix 的 key 必须真实存在于注册表", () => {
  // hintSuffix 查不到时返回空串，界面"少了一句键位提示"不会报错也不会红——
  // 改 description 措辞的人会毫无察觉地把 19 处提示悄悄清空。只能靠源码级断言兜住。
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  it("注册表里能找到每一个被引用的 description", () => {
    const registered = new Set(
      [...appSource.matchAll(/description:\s*"([^"]+)"/g)].map((m) => m[1])
    );
    const referenced = [...appSource.matchAll(/hintSuffix\("([^"]*)"\)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(10); // 防止正则失配导致整条断言空转
    expect(referenced.filter((r) => !registered.has(r))).toEqual([]);
  });

  it("被引用的 description 在注册表里必须唯一，否则 tooltip 展示哪个键位是看运气", () => {
    // 注册表允许别名（⌘⌫ 和 Delete 都表示"移到回收站"，面板会各占一行），
    // 但那种 description 不能被 hintSuffix 引用：首条胜出等于随机。
    const counts = new Map<string, number>();
    for (const m of appSource.matchAll(/description:\s*"([^"]+)"/g)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    const referenced = [...new Set([...appSource.matchAll(/hintSuffix\("([^"]*)"\)/g)].map((m) => m[1]))];
    expect(referenced.filter((r) => (counts.get(r) ?? 0) > 1)).toEqual([]);
  });
});
