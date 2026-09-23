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

  it("其余键一概不吃（不能让方向键之外的输入被吞掉）", () => {
    for (const k of ["ArrowUp", "ArrowDown", "a", " ", "Tab", "F1", "Backspace"]) {
      expect(key(k)).toBeNull();
    }
  });
});

describe("选中项的移动", () => {
  it("从右端越界停在原地，不循环回第一行", () => {
    expect(nextSelectedIndex(2, 3, "next")).toBe(2);
    expect(nextSelectedIndex(0, 3, "prev")).toBe(0);
  });

  it("还没有选中时，往右落在第一个、往左落在最后一个", () => {
    expect(nextSelectedIndex(-1, 3, "next")).toBe(0);
    expect(nextSelectedIndex(-1, 3, "prev")).toBe(2);
  });

  it("空列表不给下标（调用方据此什么都不做）", () => {
    expect(nextSelectedIndex(-1, 0, "next")).toBe(-1);
    expect(nextSelectedIndex(0, 0, "prev")).toBe(-1);
  });
});
