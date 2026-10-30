/**
 * diff 结果"应用到另一侧"的文案与方向映射。
 *
 * 这是一件会改写用户文件的事：确认框必须说清"从哪到哪、目标路径是哪个"。
 * 只写"确定要覆盖吗"等于没确认 —— 用户根本不知道被盖掉的是哪个文件。
 */
import { describe, expect, it } from "vitest";
import { describeApply, applyConfirmText } from "../src/utils/diffApply";

const LEFT = "/tmp/left/a.txt";
const RIGHT = "/tmp/right/a.txt";

describe("describeApply", () => {
  it("两侧没选全时不该有动作可做", () => {
    expect(describeApply("left_to_right", null, RIGHT)).toBeNull();
    expect(describeApply("left_to_right", LEFT, null)).toBeNull();
    expect(describeApply("swap", null, null)).toBeNull();
  });

  it("用左侧覆盖右侧：mode 方向对，且目标路径是右侧", () => {
    const d = describeApply("left_to_right", LEFT, RIGHT);
    expect(d?.mode).toBe("left_to_right");
    expect(d?.targetPaths).toEqual([RIGHT]);
    expect(d?.content).toContain(RIGHT);
    expect(d?.content).toContain(LEFT);
  });

  it("用右侧覆盖左侧：目标路径是左侧，别搞反", () => {
    const d = describeApply("right_to_left", LEFT, RIGHT);
    expect(d?.mode).toBe("right_to_left");
    expect(d?.targetPaths).toEqual([LEFT]);
    // 源是右、目标是左
    expect(d?.content).toContain(`源：${RIGHT}`);
    expect(d?.content).toContain(`目标（将被改写）：${LEFT}`);
  });

  it("互换：两个目标路径都要列出来", () => {
    const d = describeApply("swap", LEFT, RIGHT);
    expect(d?.mode).toBe("swap");
    expect(d?.targetPaths).toEqual([LEFT, RIGHT]);
    expect(d?.content).toContain(LEFT);
    expect(d?.content).toContain(RIGHT);
  });

  it("文案必须说明内容会被丢弃、且无法撤销", () => {
    const d = describeApply("left_to_right", LEFT, RIGHT);
    expect(d?.content).toContain("丢弃");
    expect(d?.content).toContain("无法撤销");
  });

  it("路径为空时文案里不许出现 undefined", () => {
    const d = describeApply("left_to_right", LEFT, RIGHT);
    expect(d?.content).not.toContain("undefined");
  });
});

describe("applyConfirmText", () => {
  it("去掉 markdown 记号，免得路径里的下划线被渲染成斜体", () => {
    const d = describeApply("left_to_right", "/tmp/my_file.txt", "/tmp/other_file.txt");
    expect(d).not.toBeNull();
    const text = applyConfirmText(d!);
    expect(text).not.toContain("**");
    expect(text).toContain("/tmp/my_file.txt");
  });
});
