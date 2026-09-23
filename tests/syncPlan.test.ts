/**
 * 目录同步的计划与确认文案。
 *
 * 同步是全站唯一会覆盖别的文件的操作，而方向是一个随手可切的开关。
 * 确认框只写"确定要同步吗"等于没确认：要说清从哪到哪、几项、其中几项会被盖掉，
 * 而这些数字（尤其"会被盖掉的几项"）必须来自真的 modified 项，不能拿总数凑。
 */
import { describe, expect, it } from "vitest";
import { buildSyncPlan, pickSyncable, syncPlanSummary, type SyncDiffEntry } from "../src/utils/syncPlan";

const e = (name: string, status: SyncDiffEntry["status"]): SyncDiffEntry => ({ name, status });
const ENTRIES: SyncDiffEntry[] = [
  e("a.txt", "only_left"),
  e("b.txt", "only_right"),
  e("c.txt", "modified"),
  e("d.txt", "modified"),
];

describe("该方向上要同步哪些差异", () => {
  it("左到右 = 只在左侧的新增 + 两侧不同的修改", () => {
    expect(pickSyncable(ENTRIES, "left_to_right").map((x) => x.name)).toEqual(["a.txt", "c.txt", "d.txt"]);
  });

  it("右到左 = 镜像过来，不许把 only_left 也搬走", () => {
    expect(pickSyncable(ENTRIES, "right_to_left").map((x) => x.name)).toEqual(["b.txt", "c.txt", "d.txt"]);
  });

  it("完全没有可同步项时是空，而不是整张差异表", () => {
    expect(pickSyncable([e("b.txt", "only_right")], "left_to_right")).toEqual([]);
  });
});

describe("同步计划", () => {
  it("方向决定源与目标", () => {
    const lr = buildSyncPlan(ENTRIES, "left_to_right", "/L", "/R");
    expect([lr.sourceDir, lr.targetDir]).toEqual(["/L", "/R"]);
    const rl = buildSyncPlan(ENTRIES, "right_to_left", "/L", "/R");
    expect([rl.sourceDir, rl.targetDir]).toEqual(["/R", "/L"]);
  });

  it("覆盖项只数 modified，不许拿总数凑", () => {
    const plan = buildSyncPlan(ENTRIES, "left_to_right", "/L", "/R");
    expect(plan.total).toBe(3);
    expect(plan.overwriteNames).toEqual(["c.txt", "d.txt"]);
  });

  it("文案里方向、数量、覆盖清单都在", () => {
    const plan = buildSyncPlan(ENTRIES, "left_to_right", "/L", "/R");
    const text = syncPlanSummary(plan);
    expect(text).toContain("/L");
    expect(text).toContain("/R");
    expect(text).toContain("3 项");
    expect(text).toContain("2 项目标端已有不同内容，会被覆盖");
    expect(text).toContain("c.txt");
  });

  it("没有覆盖项时要明说不会覆盖已有文件", () => {
    const plan = buildSyncPlan([e("a.txt", "only_left")], "left_to_right", "/L", "/R");
    expect(syncPlanSummary(plan)).toContain("不会覆盖已有文件");
  });

  it("覆盖清单最多列 5 个，但数量要说全", () => {
    const many: SyncDiffEntry[] = Array.from({ length: 8 }, (_, i) => e(`f${i}.txt`, "modified"));
    const plan = buildSyncPlan(many, "left_to_right", "/L", "/R");
    const text = syncPlanSummary(plan);
    expect(text).toContain("8 项目标端已有不同内容");
    expect(text.match(/f\d\.txt/g)?.length).toBeLessThanOrEqual(6);
    expect(text).toContain("等 8 项");
  });

  it("目录还没填时不许渲染成 undefined", () => {
    const plan = buildSyncPlan(ENTRIES, "left_to_right", "", "");
    const text = syncPlanSummary(plan);
    expect(text).not.toContain("undefined");
    expect(text).toContain("（未填）");
  });
});
