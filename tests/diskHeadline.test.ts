/**
 * 概览页磁盘卡片的容量口径（回归测试）。
 *
 * 曾经的实现是 `disks.filter(d => d.mountPoint === "/" || d.totalBytes > 0)`
 * 再求和 —— 那个 OR 对几乎所有卷都为真，于是 APFS 的 "/" 与
 * "/System/Volumes/Data" 被算成两块盘，容量与已用同时翻倍，而卡片百分比
 * 恰好仍是 92%（两卷同分子分母），看起来和告警一致，极难被发现。
 */
import { describe, expect, it } from "vitest";

import type { DiskMetrics } from "../src/apps/sys/ipc_contract";
import { pickDiskHeadline } from "../src/apps/sys/lib/diskHeadline";

const GiB = 1024 ** 3;

function volume(mountPoint: string, over: Partial<DiskMetrics> = {}): DiskMetrics {
  return {
    name: mountPoint,
    mountPoint,
    fileSystem: "apfs",
    totalBytes: 460 * GiB,
    usedBytes: 425 * GiB,
    availableBytes: 35 * GiB,
    usagePercent: 92.39,
    readBytesPerSec: null,
    writeBytesPerSec: null,
    available: true,
    ...over,
  };
}

describe("pickDiskHeadline", () => {
  it("APFS 同一容器的两个卷只算一次，容量不翻倍", () => {
    const disks = [
      volume("/"),
      volume("/System/Volumes/Data", { usagePercent: 92.02 }),
    ];
    const out = pickDiskHeadline(disks);

    expect(out.totalBytes).toBe(460 * GiB);
    expect(out.usedBytes).toBe(425 * GiB);
    // 求和的旧实现会给出 920 GiB，这一条就是防它回来
    expect(out.totalBytes).not.toBe(920 * GiB);
  });

  it("取最吃紧的卷，与后端 worst_disk / 磁盘告警同口径", () => {
    const out = pickDiskHeadline([
      volume("/", { usagePercent: 26.1, usedBytes: 120 * GiB }),
      volume("/System/Volumes/Data", { usagePercent: 92.02 }),
      volume("/Volumes/External", {
        usagePercent: 40,
        totalBytes: 1000 * GiB,
        usedBytes: 400 * GiB,
      }),
    ]);

    expect(out.mountPoint).toBe("/System/Volumes/Data");
    expect(out.percent).toBe(92.02);
  });

  it("不可用卷不参与，全部不可用时给出空占位", () => {
    expect(
      pickDiskHeadline([
        volume("/Volumes/Broken", { available: false, totalBytes: 0, usagePercent: 100 }),
        volume("/", { usagePercent: 26.1 }),
      ]).mountPoint
    ).toBe("/");

    const empty = pickDiskHeadline([volume("/Volumes/Broken", { available: false, totalBytes: 0 })]);
    expect(empty.mountPoint).toBeNull();
    expect(empty.totalBytes).toBe(0);

    expect(pickDiskHeadline(undefined).mountPoint).toBeNull();
  });
});
