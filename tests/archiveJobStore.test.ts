/**
 * 归档任务账本：进度事件是节流发的、还可能乱序，账本必须自己扛住。
 *
 * 真正会咬人的两条：
 * - **终态是最终的**。先收到 done、再收到一个在途快照的话，列表里会留一个永远转圈、
 *   点取消也停不下来的任务——用户以为 7 GB 的包卡死了，其实是账本记错了。
 * - **撞上限时只扔已结束的任务**。扔掉一个还在跑的，它后续的进度就再也没人收，
 *   取消按钮也跟着消失。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { selectActiveCount, useArchiveJobStore } from "../src/stores/archiveJobStore";
import type { ArchiveProgress, JobPhase } from "../src/utils/archiveModel";

function job(id: string, phase: JobPhase = "working", over: Partial<ArchiveProgress> = {}): ArchiveProgress {
  return {
    jobId: id,
    kind: "extract",
    phase,
    archive: `D:/a/${id}.zip`,
    dest: "D:/a/out",
    entry: "",
    entriesDone: 0,
    entriesTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    percent: -1,
    speedBps: 0,
    message: "",
    ...over,
  };
}

const jobs = () => useArchiveJobStore.getState().jobs;
const { upsert, dismiss, clearFinished } = useArchiveJobStore.getState();

beforeEach(() => {
  useArchiveJobStore.setState({ jobs: [] });
});

describe("upsert", () => {
  it("新任务插在最前面，任务列表因此不用再排序", () => {
    upsert(job("a"));
    upsert(job("b"));
    expect(jobs().map((j) => j.jobId)).toEqual(["b", "a"]);
  });

  it("同一个任务的后续进度原地更新，不改变它在列表里的位置", () => {
    upsert(job("a"));
    upsert(job("b"));
    upsert(job("a", "working", { percent: 42 }));
    expect(jobs().map((j) => j.jobId)).toEqual(["b", "a"]);
    expect(jobs()[1].percent).toBe(42);
  });

  it("终态之后来的在途快照被丢掉", () => {
    upsert(job("a", "done", { percent: 100 }));
    upsert(job("a", "working", { percent: 30 }));
    expect(jobs()[0].phase).toBe("done");
    expect(jobs()[0].percent).toBe(100);
  });

  it("在途 → 终态是正常方向，照收", () => {
    upsert(job("a", "working", { percent: 30 }));
    upsert(job("a", "error", { message: "CRC 校验失败" }));
    expect(jobs()[0].phase).toBe("error");
    expect(jobs()[0].message).toBe("CRC 校验失败");
  });

  it("撞上限时先扔最旧的已结束任务，一个都不结束就一个不扔", () => {
    for (let i = 0; i < 50; i += 1) upsert(job(`j${i}`, i < 10 ? "done" : "working"));
    expect(jobs()).toHaveLength(50);
    // 第 51 个进来：最旧的那批 done 被清掉，活跃的一个不少
    upsert(job("new"));
    expect(jobs()).toHaveLength(50);
    expect(jobs().some((j) => j.jobId === "new")).toBe(true);
    expect(jobs().filter((j) => j.phase === "working")).toHaveLength(41);
  });

  it("全都在跑时宁可超上限也不扔活跃任务", () => {
    for (let i = 0; i < 51; i += 1) upsert(job(`r${i}`));
    expect(jobs()).toHaveLength(51);
    expect(selectActiveCount(jobs())).toBe(51);
  });
});

describe("dismiss / clearFinished", () => {
  it("dismiss 只拿掉那一条", () => {
    upsert(job("a", "done"));
    upsert(job("b", "working"));
    dismiss("a");
    expect(jobs().map((j) => j.jobId)).toEqual(["b"]);
  });

  it("clearFinished 留下的全是还在跑的", () => {
    upsert(job("a", "done"));
    upsert(job("b", "cancelled"));
    upsert(job("c", "error"));
    upsert(job("d", "finishing"));
    clearFinished();
    expect(jobs().map((j) => j.jobId)).toEqual(["d"]);
  });
});

describe("selectActiveCount", () => {
  it("scanning / working / finishing 都算活跃", () => {
    expect(selectActiveCount([job("a", "scanning"), job("b", "finishing")])).toBe(2);
    expect(selectActiveCount([job("a", "done"), job("b", "cancelled"), job("c", "error")])).toBe(0);
    expect(selectActiveCount([])).toBe(0);
  });
});
