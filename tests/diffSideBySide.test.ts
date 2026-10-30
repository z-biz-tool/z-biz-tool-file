/**
 * 双栏对比的行对齐算法。
 *
 * 这是"双栏对比"能不能用的分水岭：算法错了，用户看到的就是两栏内容错位、
 * 删除行对着不相干的新增行 —— 比不做还糟。所以这里逐条钉住折叠规则。
 */
import { describe, expect, it } from "vitest";
import {
  buildSideBySide,
  sideBySideStats,
  pairChangeBlock,
  type DiffLine,
} from "../src/utils/diffSideBySide";

/** 造一条 context 行 */
const ctx = (oldNo: number, newNo: number, content: string): DiffLine => ({
  kind: "context",
  old_line: oldNo,
  new_line: newNo,
  content,
});
/** 造一条删除行 */
const rm = (oldNo: number, content: string): DiffLine => ({
  kind: "remove",
  old_line: oldNo,
  new_line: null,
  content,
});
/** 造一条新增行 */
const add = (newNo: number, content: string): DiffLine => ({
  kind: "add",
  old_line: null,
  new_line: newNo,
  content,
});

describe("buildSideBySide", () => {
  it("空输入返回空数组，不是 null", () => {
    expect(buildSideBySide([])).toEqual([]);
  });

  it("context 行左右成对，行号各自来自两侧", () => {
    const rows = buildSideBySide([ctx(1, 1, "a"), ctx(2, 2, "b")]);
    expect(rows.length).toBe(2);
    expect(rows[0].left).toMatchObject({ lineNo: 1, content: "a" });
    expect(rows[0].right).toMatchObject({ lineNo: 1, content: "a" });
    expect(rows[0].type).toBe("equal");
    expect(rows[1].left?.lineNo).toBe(2);
    expect(rows[1].right?.lineNo).toBe(2);
  });

  it("一个删除配一个新增时，两侧落在同一横排上", () => {
    const rows = buildSideBySide([ctx(1, 1, "a"), rm(2, "old"), add(2, "new"), ctx(3, 3, "b")]);
    expect(rows.length).toBe(3);
    expect(rows[1].type).toBe("changed");
    expect(rows[1].left).toMatchObject({ lineNo: 2, content: "old", kind: "remove" });
    expect(rows[1].right).toMatchObject({ lineNo: 2, content: "new", kind: "add" });
  });

  it("变更块里删除比新增多时，多出来的删除行右侧留空槽", () => {
    const rows = buildSideBySide([rm(1, "x"), rm(2, "y"), add(1, "z")]);
    expect(rows.length).toBe(2);
    expect(rows[0].left?.content).toBe("x");
    expect(rows[0].right?.content).toBe("z");
    // 第二行只有左侧有内容，右侧必须是 null（空槽），不能塞个不相干的内容
    expect(rows[1].left?.content).toBe("y");
    expect(rows[1].right).toBeNull();
  });

  it("变更块里新增比删除多时，多出来的新增行左侧留空槽", () => {
    const rows = buildSideBySide([rm(1, "x"), add(1, "z"), add(2, "w")]);
    expect(rows.length).toBe(2);
    expect(rows[1].left).toBeNull();
    expect(rows[1].right?.content).toBe("w");
  });

  it("连续的多个变更块不会互相串味", () => {
    const rows = buildSideBySide([
      ctx(1, 1, "a"),
      rm(2, "old1"),
      add(1, "new1"),
      ctx(3, 2, "b"),
      rm(4, "old2"),
      add(3, "new2"),
    ]);
    // 1 context + 1 变更 + 1 context + 1 变更
    expect(rows.length).toBe(4);
    expect(rows[1].left?.content).toBe("old1");
    expect(rows[1].right?.content).toBe("new1");
    expect(rows[3].left?.content).toBe("old2");
    expect(rows[3].right?.content).toBe("new2");
  });

  it("连续两行的删除各自对应各自的新增，不许交叉", () => {
    // 这是最容易写错的一种：old1/old2 与 new1/new2 必须按顺序对
    const rows = buildSideBySide([rm(1, "old1"), rm(2, "old2"), add(1, "new1"), add(2, "new2")]);
    expect(rows[0].left?.content).toBe("old1");
    expect(rows[0].right?.content).toBe("new1");
    expect(rows[1].left?.content).toBe("old2");
    expect(rows[1].right?.content).toBe("new2");
  });
});

describe("sideBySideStats", () => {
  it("空槽那一侧不计入行数", () => {
    const rows = buildSideBySide([rm(1, "x"), rm(2, "y"), add(1, "z")]);
    const stats = sideBySideStats(rows);
    expect(stats.leftLines).toBe(2);
    expect(stats.rightLines).toBe(1);
    expect(stats.changedRows).toBe(2);
    expect(stats.equalRows).toBe(0);
  });

  it("相同的行算 equal 段", () => {
    const stats = sideBySideStats(buildSideBySide([ctx(1, 1, "a"), ctx(2, 2, "b")]));
    expect(stats.equalRows).toBe(2);
    expect(stats.changedRows).toBe(0);
    expect(stats.leftLines).toBe(2);
    expect(stats.rightLines).toBe(2);
  });
});

describe("pairChangeBlock", () => {
  it("空块给出空结果", () => {
    expect(pairChangeBlock([], [])).toEqual([]);
  });

  it("配对按出现顺序，不按内容", () => {
    const rows = pairChangeBlock([rm(5, "a"), rm(6, "b")], [add(5, "x"), add(6, "y")]);
    expect(rows.map((r) => [r.left?.content, r.right?.content])).toEqual([
      ["a", "x"],
      ["b", "y"],
    ]);
  });
});
