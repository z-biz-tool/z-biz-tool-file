/**
 * 目录同步的"要动手了什么"清单。
 *
 * 同步是这一堆面板里唯一会覆盖别人文件的动作：点一下就按方向把差异项写过去，
 * 而方向是一个随手可切的开关。所以确认框里的文案必须把"从哪到哪、几项、其中几项是覆盖"
 * 说准，不能只写"确定要同步吗"。做成纯函数是因为这段话值得被断言（方向反了要说反了，
 * 覆盖项数不能拿总数凑）。
 */

export type SyncStatus = "only_left" | "only_right" | "modified";

export interface SyncDiffEntry {
  name: string;
  status: SyncStatus;
}

export type SyncDirection = "left_to_right" | "right_to_left";

export interface SyncPlan {
  sourceDir: string;
  targetDir: string;
  names: string[];
  /** 目标端已有同名/内容不同的那几项 —— 同步会把它们盖掉 */
  overwriteNames: string[];
  total: number;
}

/** 该方向上要处理的差异：只在本侧的新增项 + 两侧都有的修改项 */
export function pickSyncable(entries: SyncDiffEntry[], direction: SyncDirection): SyncDiffEntry[] {
  const wanted: SyncStatus = direction === "left_to_right" ? "only_left" : "only_right";
  return entries.filter((e) => e.status === wanted || e.status === "modified");
}

export function buildSyncPlan(
  entries: SyncDiffEntry[],
  direction: SyncDirection,
  leftDir: string,
  rightDir: string
): SyncPlan {
  const picked = pickSyncable(entries, direction);
  const [sourceDir, targetDir] =
    direction === "left_to_right" ? [leftDir, rightDir] : [rightDir, leftDir];
  return {
    sourceDir,
    targetDir,
    names: picked.map((e) => e.name),
    overwriteNames: picked.filter((e) => e.status === "modified").map((e) => e.name),
    total: picked.length,
  };
}

/** 确认框里那句说明：方向 + 数量 + 覆盖清单（覆盖最多列 5 个，剩下用"等 N 项"收口） */
export function syncPlanSummary(plan: SyncPlan): string {
  const head = `把 ${plan.total} 项从 ${plan.sourceDir || "（未填）"} 同步到 ${plan.targetDir || "（未填）"}。`;
  if (!plan.overwriteNames.length) return `${head} 目标端没有同名项，不会覆盖已有文件。`;
  const shown = plan.overwriteNames.slice(0, 5).join("、");
  const more =
    plan.overwriteNames.length > 5 ? ` 等 ${plan.overwriteNames.length} 项` : "";
  return `${head} 其中 ${plan.overwriteNames.length} 项目标端已有不同内容，会被覆盖：${shown}${more}。`;
}
