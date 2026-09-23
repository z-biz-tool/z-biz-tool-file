/**
 * 媒体库的键盘口径。
 *
 * 画廊之前只认鼠标：选中一张之后按 Enter 什么都不发生，而主列表早就吃
 * Enter（打开选中项）与 ⌘⌫（移到回收站）。"哪个键算哪个动作"是能当纯函数断言的部分，
 * 渲染部分（焦点容器、preventDefault）在 node 环境里进不去，另有一轮 dev 页实测兜着。
 */
import { describe, expect, it } from "vitest";
import { mediaKeyAction, nextSelectedIndex } from "../src/utils/mediaKeys";

const key = (k: string, mod: Partial<{ metaKey: boolean; ctrlKey: boolean }> = {}) =>
  mediaKeyAction({ key: k, ...mod });

describe("按键 → 动作", () => {
  it("Enter 打开，⌘/Ctrl+Enter 同义", () => {
    expect(key("Enter")).toBe("open");
    expect(key("Enter", { metaKey: true })).toBe("open");
    expect(key("Enter", { ctrlKey: true })).toBe("open");
  });

  it("删除：Delete 直接算，Backspace 要带修饰键", () => {
    expect(key("Delete")).toBe("delete");
    expect(key("Del")).toBe("delete");
    expect(key("Backspace", { metaKey: true })).toBe("delete");
    expect(key("Backspace", { ctrlKey: true })).toBe("delete");
    // 单独 Backspace 不许抢：那可能是用户在输入框里删字符
    expect(key("Backspace")).toBeNull();
  });

  it("←/→ 移动选中，Esc 清选中", () => {
    expect(key("ArrowLeft")).toBe("prev");
    expect(key("ArrowRight")).toBe("next");
    expect(key("Escape")).toBe("clear");
  });

  it("↑/↓ 也算方向键，按列走（不是 ±1）", () => {
    expect(key("ArrowUp")).toBe("up");
    expect(key("ArrowDown")).toBe("down");
  });

  it("其余键一概不吃（不能让方向键之外的输入被吞掉）", () => {
    for (const k of ["a", " ", "Tab", "F1", "Backspace"]) {
      expect(key(k)).toBeNull();
    }
  });
});

describe("选中项的移动", () => {
  it("从右端越界停在原地，不循环回第一行", () => {
    expect(nextSelectedIndex(2, 3, "next")).toBe(2);
    expect(nextSelectedIndex(0, 3, "prev")).toBe(0);
    // 上下也一样：到顶/到底不循环
    expect(nextSelectedIndex(0, 9, "up", 3)).toBe(0);
    expect(nextSelectedIndex(8, 9, "down", 3)).toBe(8);
  });

  it("还没有选中时，往右落在第一个、往左落在最后一个；上下也按列首尾处理", () => {
    expect(nextSelectedIndex(-1, 3, "next")).toBe(0);
    expect(nextSelectedIndex(-1, 3, "prev")).toBe(2);
    expect(nextSelectedIndex(-1, 9, "down", 3)).toBe(0);
    expect(nextSelectedIndex(-1, 9, "up", 3)).toBe(8);
  });

  it("空列表不给下标（调用方据此什么都不做）", () => {
    expect(nextSelectedIndex(-1, 0, "next")).toBe(-1);
    expect(nextSelectedIndex(0, 0, "prev")).toBe(-1);
    expect(nextSelectedIndex(0, 0, "down", 3)).toBe(-1);
  });

  it("↑/↓ 按列数跳，列数从运行时算进来", () => {
    // 9 张照片排成 3 列：第 0 项按 ↓ 落到第 3、第 6
    expect(nextSelectedIndex(0, 9, "down", 3)).toBe(3);
    expect(nextSelectedIndex(0, 9, "down", 3) === 3 ? 3 + 3 : -1).toBe(6);
    expect(nextSelectedIndex(0, 9, "up", 3)).toBe(0); // 已经在最顶行
    expect(nextSelectedIndex(4, 9, "up", 3)).toBe(1);
    // 列数为 1 时退化为 ±1（音频/列表视图）
    expect(nextSelectedIndex(0, 5, "down", 1)).toBe(1);
    expect(nextSelectedIndex(3, 5, "up", 1)).toBe(2);
    // 没传 columns 时按 1 处理（兼容性）
    expect(nextSelectedIndex(0, 5, "down")).toBe(1);
  });

  it("↑/↓ 越界后还能继续用（不能因为越界就锁住 selectedIndex）", () => {
    // 6 张照片 3 列：第 4 项按 ↓ 应到第 7，越界后变 5
    expect(nextSelectedIndex(4, 6, "down", 3)).toBe(5);
    // 从第 5 再按 ↓ 仍是 5（到底了）
    expect(nextSelectedIndex(5, 6, "down", 3)).toBe(5);
  });
});
