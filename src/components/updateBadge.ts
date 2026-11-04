/**
 * 更新角标的**纯判据** —— 不 import React / antd / Tauri，才能在 node 里单测。
 *
 * 从 UpdateCenter.tsx 抽出来不是为了好看：2026-11-04 刚踩过一次「门禁文件
 * import 抄错测试框架，5 条断言从头到尾没跑过」。判据必须能被直接 import。
 */

export type UpdatePhase = "idle" | "checking" | "downloading" | "installed" | "error";

export interface BadgeView {
  /** 是否挂视觉标记（红点）。只有「确实有新版可装」才亮。 */
  show: boolean;
  label: string;
  tone: "none" | "update" | "busy" | "done" | "error";
}

/**
 * 版本比较：只做**前端防御**，权威判据在 Tauri 插件（它还验签名）。
 *
 * 存在意义：manifest 配错（版本号倒退 / 仍与当前相同）时，插件偶尔仍会
 * 返回一个 update 对象；此时若直接亮「有更新」，用户点了会装回旧版。
 * 宁可不亮，也不要亮一个装不新的标记。
 *
 * 预发布后缀（0.2.3-beta.1）按 0.2.3 处理：与稳定版同号时**不算**更新。
 */
export function parseVersion(input: string): number[] {
  const core = input.trim().replace(/^v/i, "").split(/[+-]/)[0] ?? "";
  const parts = core.split(".").map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return parts.length ? parts : [0];
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 角落入口的标记判据：抽成纯函数，才有办法用测试证明「有更新才会亮」。 */
export function badgeOf(input: {
  hasUpdate: boolean;
  phase: UpdatePhase;
  latestVersion: string | null;
}): BadgeView {
  const { hasUpdate, phase, latestVersion } = input;
  if (phase === "checking") return { show: false, label: "正在检查更新…", tone: "busy" };
  if (phase === "downloading") return { show: false, label: "正在下载并安装更新…", tone: "busy" };
  if (phase === "installed") return { show: false, label: "更新已装好，等待重启", tone: "done" };
  if (phase === "error") return { show: true, label: "更新失败，点击查看", tone: "error" };
  if (hasUpdate) {
    return {
      show: true,
      label: latestVersion ? `有更新 v${latestVersion} · 点击自动更新` : "有更新 · 点击自动更新",
      tone: "update",
    };
  }
  return { show: false, label: "已是最新版本 · 点击重新检查", tone: "none" };
}
