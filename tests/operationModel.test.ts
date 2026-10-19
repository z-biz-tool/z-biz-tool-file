/**
 * 批量操作状态机（`src/utils/operationModel.ts`）的单测。
 *
 * 这段逻辑是"最容易出错又最难测"的部分，所以刻意做成不依赖 React 的纯函数
 * （本仓 vitest 是 `environment: "node"`，没有 DOM，也没有 @testing-library/react）。
 *
 * 三条规则各自对应一类真实会咬人的坑：
 * 1. 不同任务的进度不串台；
 * 2. 终态不被在途快照盖回去（否则界面永远转圈、取消按钮点不动）；
 * 3. percent 一律夹到 0..100。
 */
import { describe, expect, it } from "vitest";
import {
  clampPercent,
  describeProgress,
  initialOperationState,
  isRunning,
  isTerminal,
  reduceOperationState,
  type OperationProgress,
} from "../src/utils/operationModel";

function progress(over: Partial<OperationProgress> = {}): OperationProgress {
  return {
    operationId: "op-1",
    kind: "rename",
    phase: "running",
    total: 10,
    processed: 0,
    succeeded: 0,
    failed: 0,
    current: "",
    percent: 0,
    message: "",
    errors: [],
    ...over,
  };
}

describe("批量操作状态机", () => {
  it("终态判定：只有 running 算还在跑", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("error")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isRunning("running")).toBe(true);
    expect(isRunning("done")).toBe(false);
  });

  it("开始一个任务后，进度挂在这个任务 id 上", () => {
    const s = reduceOperationState(initialOperationState, { type: "started", operationId: "op-1" });
    expect(s.operationId).toBe("op-1");
    expect(s.progress).toBeNull();
    expect(s.error).toBeNull();
  });

  it("不同任务的进度不串台：operationId 对不上就整条丢掉", () => {
    const started = reduceOperationState(initialOperationState, {
      type: "started",
      operationId: "op-1",
    });
    const after = reduceOperationState(started, {
      type: "progress",
      progress: progress({ operationId: "op-2", processed: 5 }),
    });
    expect(after).toBe(started);
    expect(after.progress).toBeNull();
  });

  it("终态不被在途快照盖回去（否则界面永远转圈、取消也点不动）", () => {
    let s = reduceOperationState(initialOperationState, { type: "started", operationId: "op-1" });
    s = reduceOperationState(s, {
      type: "progress",
      progress: progress({ phase: "done", processed: 10, percent: 100 }),
    });
    expect(s.progress?.phase).toBe("done");
    // 终态之后又来一个在途快照
    s = reduceOperationState(s, {
      type: "progress",
      progress: progress({ phase: "running", processed: 3, percent: 30 }),
    });
    expect(s.progress?.phase).toBe("done");
    expect(s.progress?.processed).toBe(10);
  });

  it("percent 一律夹到 0..100，界面上的进度条宽度不能被越界的数字撑坏", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(42.5)).toBe(42.5);

    let s = reduceOperationState(initialOperationState, { type: "started", operationId: "op-1" });
    s = reduceOperationState(s, { type: "progress", progress: progress({ percent: 999 }) });
    expect(s.progress?.percent).toBe(100);
  });

  it("启动失败记下错误，但不影响已登记的任务 id", () => {
    let s = reduceOperationState(initialOperationState, { type: "started", operationId: "op-1" });
    s = reduceOperationState(s, { type: "failed", error: "启动失败" });
    expect(s.error).toBe("启动失败");
    expect(s.operationId).toBe("op-1");
  });

  it("reset 把状态清空，可以接着再跑一个任务", () => {
    let s = reduceOperationState(initialOperationState, { type: "started", operationId: "op-1" });
    s = reduceOperationState(s, { type: "progress", progress: progress() });
    s = reduceOperationState(s, { type: "reset" });
    expect(s).toEqual(initialOperationState);
  });

  it("给界面用的一句话：要说清现在动的是哪个文件", () => {
    expect(describeProgress(null)).toBe("");
    expect(
      describeProgress(progress({ processed: 3, total: 10, current: "a.txt" }))
    ).toContain("a.txt");
    expect(describeProgress(progress({ phase: "done", processed: 10 }))).toContain("已完成");
    expect(describeProgress(progress({ phase: "cancelled", processed: 4, total: 10 }))).toContain(
      "已取消"
    );
  });
});
