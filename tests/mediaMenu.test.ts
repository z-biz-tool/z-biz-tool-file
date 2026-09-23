/**
 * 画廊右键菜单门禁：出现的每一项都必须点得动，且作用于"被右键的那一项"。
 *
 * 起因（实测）：照片馆/视频馆/音乐馆的菜单三项 打开 / 在 Finder 中显示 / 删除 只有
 * label 没有 onClick —— 整份菜单是一个 useMemo(() => …, []) 的共享对象，压根不知道
 * 右键的是哪一项。点卡片能触发 open_with_default_app（正对照），点这三项 invoke 数为 0。
 */
import { describe, expect, it, vi } from "vitest";
import { buildMediaMenu, type MediaActions } from "../src/utils/mediaMenu";
import type { MediaItem } from "../src/utils/mediaType";

const item = (name: string): MediaItem => ({
  path: `/data/${name}`,
  name,
  type: "image",
});

const all: MediaActions = {
  onOpen: vi.fn(),
  onReveal: vi.fn(),
  onDelete: vi.fn(),
};

interface Entry {
  key: string;
  label: string;
  danger?: boolean;
  onClick: () => void;
}

/** 取出可点项（丢掉分隔线），并断言每一项都真的挂了函数 */
function clickable(items: ReturnType<typeof buildMediaMenu>): Entry[] {
  const out = items.filter((i) => i && "key" in (i as object)) as unknown as Entry[];
  for (const i of out) expect(typeof i.onClick, i.key).toBe("function");
  return out;
}

describe("buildMediaMenu", () => {
  it("三项动作的顺序、文案与分隔线", () => {
    const items = buildMediaMenu(item("a.jpg"), all);
    expect(items.map((i) => ("key" in i ? i.key : i.type))).toEqual([
      "open",
      "reveal",
      "divider",
      "delete",
    ]);
    expect(clickable(items).map((i) => i.label)).toEqual(["打开", "在 Finder 中显示", "删除"]);
  });

  // 危险操作要看着就不一样：删除项走 danger（红字）
  it("删除是危险项", () => {
    const del = clickable(buildMediaMenu(item("a.jpg"), all)).find((i) => i.key === "delete");
    expect(del).toMatchObject({ danger: true });
  });

  // 这一条才是"按项"的证据：两个不同文件各建一份菜单，点各自的"打开"必须拿到
  // 各自的路径 —— 共享菜单对象时这里必然拿到同一个（或 undefined）。
  it("每一项的动作只作用于被右键的那一项", () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    const a = buildMediaMenu(item("a.jpg"), { onOpen, onDelete });
    const b = buildMediaMenu(item("b.jpg"), { onOpen, onDelete });
    for (const [menu, name] of [
      [a, "a.jpg"],
      [b, "b.jpg"],
    ] as const) {
      const items = clickable(menu);
      items.find((i) => i.key === "open")!.onClick!();
      expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ name }));
      items.find((i) => i.key === "delete")!.onClick!();
      expect(onDelete).toHaveBeenLastCalledWith(expect.objectContaining({ name }));
    }
  });

  it("在 Finder 中显示走 onReveal", () => {
    const onReveal = vi.fn();
    const items = clickable(buildMediaMenu(item("v.mp4"), { onReveal }));
    expect(items.map((i) => i.key)).toEqual(["reveal"]);
    items[0].onClick!();
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ path: "/data/v.mp4" }));
  });

  // 没接动作的项根本不出现（构造上就杜绝"有 label 没行为"），动作全空则是空菜单
  it("没有处理器的动作不进菜单", () => {
    expect(clickable(buildMediaMenu(item("a.jpg"), { onOpen: vi.fn() })).map((i) => i.key)).toEqual([
      "open",
    ]);
    expect(buildMediaMenu(item("a.jpg"), {})).toEqual([]);
  });

  // 只接删除时也要出项，而且顶上不能挂一条没有东西可分的分隔线
  it("只有 onDelete 时：删除单独成菜单，不带分隔线", () => {
    const items = buildMediaMenu(item("a.jpg"), { onDelete: vi.fn() });
    expect(items.map((i) => ("key" in i ? i.key : i.type))).toEqual(["delete"]);
  });
});
