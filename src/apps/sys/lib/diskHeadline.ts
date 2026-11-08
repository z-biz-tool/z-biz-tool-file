import type { DiskMetrics } from "../ipc_contract";

/**
 * 概览页「磁盘使用」卡片展示的那一个卷。
 *
 * 不能把 snapshot.disks 全部相加：macOS APFS 上 "/" 与
 * "/System/Volumes/Data" 是同一容器的两个卷，两者的 totalBytes 都是容器
 * 容量、availableBytes 都是容器共享的可用空间，相加会把一块 460 GiB 的盘
 * 显示成 920 GiB，已用也跟着翻倍（截图里 847.4 GB / 920.9 GB 就是这么来的）。
 *
 * 口径与后端告警的 worst_disk 完全一致：取可用卷里 usagePercent 最高的那个，
 * 卡片百分比才不会和「磁盘使用率 92.0%」告警对不上。所有卷的明细在「磁盘」页。
 */
export interface DiskHeadline {
  usedBytes: number;
  totalBytes: number;
  percent: number;
  /** null 表示还没有可用卷（首帧未到 / 全部不可用），界面应显示占位而不是 0 */
  mountPoint: string | null;
}

export function pickDiskHeadline(disks: DiskMetrics[] | undefined): DiskHeadline {
  const usable = (disks ?? []).filter((d) => d.available && d.totalBytes > 0);
  if (!usable.length) {
    return { usedBytes: 0, totalBytes: 0, percent: 0, mountPoint: null };
  }
  const worst = usable.reduce((a, b) => (b.usagePercent > a.usagePercent ? b : a));
  return {
    usedBytes: worst.usedBytes,
    totalBytes: worst.totalBytes,
    percent: worst.usagePercent,
    mountPoint: worst.mountPoint,
  };
}
