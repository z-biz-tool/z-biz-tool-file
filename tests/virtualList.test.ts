import { describe, expect, it } from "vitest";
import {
  chunkRows,
  computeWindow,
  createLru,
  scrollIndexIntoView,
  selectRange,
  toKeySet,
} from "../src/utils/virtualList";

/**
 * 文件网格/列表虚拟化的纯计算部分。
 * 一个上万条目的目录过去会把每一行都建出来，现在只建这一屏 —— 窗口算错就是白屏，
 * 所以这几条断言盯的是"任何一条数据都必须在某个滚动位置被渲染出来"。
 */
describe("computeWindow 窗口计算", () => {
  const base = { itemCount: 10_000, columns: 5, rowHeight: 152, viewportHeight: 800 };

  it("顶部只渲染可视行 + 缓冲，且总量远小于条目数", () => {
    const win = computeWindow({ ...base, scrollTop: 0 });
    expect(win.firstRow).toBe(0);
    expect(win.totalRows).toBe(2000);
    expect(win.lastRow - win.firstRow).toBeLessThan(30);
    expect(win.lastIndex - win.firstIndex).toBeLessThan(150);
    expect(win.padBottom).toBe((win.totalRows - win.lastRow) * base.rowHeight);
  });

  it("滚到中间时窗口跟着走，padTop 撑住滚动条不跳", () => {
    const win = computeWindow({ ...base, scrollTop: 150_000 });
    expect(win.firstRow).toBeGreaterThan(900);
    expect(win.padTop).toBe(win.firstRow * base.rowHeight);
    expect(win.padTop + (win.lastRow - win.firstRow) * base.rowHeight + win.padBottom).toBe(
      win.totalRows * base.rowHeight,
    );
  });

  it("滚到底部窗口贴尾，不越界", () => {
    const win = computeWindow({ ...base, scrollTop: 2_000_000 });
    expect(win.lastRow).toBe(win.totalRows);
    expect(win.lastIndex).toBe(base.itemCount);
    expect(win.padBottom).toBe(0);
  });

  it("空目录不渲染任何东西", () => {
    const win = computeWindow({ ...base, itemCount: 0, scrollTop: 0 });
    expect(win).toMatchObject({ firstRow: 0, lastRow: 0, padTop: 0, padBottom: 0 });
  });

  it("每一行都能被某个 scrollTop 覆盖到（不留渲染空洞）", () => {
    const rows = new Set<number>();
    for (let top = 0; top < 10_000 * base.rowHeight; top += base.rowHeight) {
      const win = computeWindow({ ...base, scrollTop: top });
      for (let r = win.firstRow; r < win.lastRow; r++) rows.add(r);
    }
    expect(rows.size).toBe(2000);
  });

  it("列数/行高异常值退化到安全值，不除零", () => {
    expect(computeWindow({ ...base, columns: 0, rowHeight: 0 }).lastRow).toBeGreaterThan(0);
  });
});

describe("scrollIndexIntoView 键盘导航跟随", () => {
  const req = {
    itemCount: 1000,
    columns: 4,
    rowHeight: 152,
    scrollTop: 0,
    viewportHeight: 608,
    currentScrollTop: 1520,
  };

  // 4 列 × 152px 行高、608px 视口：滚动到 1520 时可见的是第 10~13 行
  it("选中项在视口上方时把它拉回顶部", () => {
    expect(scrollIndexIntoView(2, req)).toBe(0);
  });

  it("选中项在视口下方时滚到露出最后一行", () => {
    // index 60 落在第 15 行：bottom 2432 - 视口 608
    expect(scrollIndexIntoView(60, req)).toBe(15 * 152 + 152 - 608);
  });

  it("已在视口内就不动", () => {
    // index 41 在第 10 行，正好是当前视口的第一行
    expect(scrollIndexIntoView(41, req)).toBe(1520);
  });

  it("找不到目标（index < 0）保持原位", () => {
    expect(scrollIndexIntoView(-1, req)).toBe(1520);
  });
});

describe("chunkRows / 选择集", () => {
  it("按列数切行，末行允许不满", () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("toKeySet 把 React.Key 归一成字符串集合", () => {
    const set = toKeySet(["/a", 7, "/b"]);
    expect(set.has("/a")).toBe(true);
    expect(set.has("7")).toBe(true);
    expect(set.size).toBe(3);
  });

  it("selectRange 正向、反向、anchor 失踪三种情况都有确定结果", () => {
    const paths = ["/1", "/2", "/3", "/4"];
    expect(selectRange(paths, "/1", "/3")).toEqual(["/1", "/2", "/3"]);
    expect(selectRange(paths, "/4", "/2")).toEqual(["/2", "/3", "/4"]);
    expect(selectRange(paths, "/gone", "/3")).toEqual(["/3"]);
  });
});

describe("createLru 缩略图缓存封顶", () => {
  it("命中后把条目挪回队尾，淘汰的是最久未用的", () => {
    const lru = createLru<string>(2);
    lru.set("a", "1");
    lru.set("b", "2");
    expect(lru.get("a")).toBe("1");
    lru.set("c", "3");
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe("1");
    expect(lru.get("c")).toBe("3");
  });

  it("容量是硬上限：塞 1000 张也只留 cap 张", () => {
    const lru = createLru<string>(320);
    for (let i = 0; i < 1000; i++) lru.set(`p${i}`, "x".repeat(4096));
    expect(lru.size).toBe(320);
  });
});
