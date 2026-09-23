export interface CompressReport {
  original_size: number;
  new_size: number;
  rewritten: number;
  flated: number;
  skipped: string[];
}

// 后端对 CompressReport.skipped 只约定了文案形状：整份退回原样时那条说明带
// "已按原样输出副本"，其余每一条都对应一张没动的图。用"排除法"而不是匹配
// "第 N 页"前缀，是因为标签里改了字就会把保持原样的张数静默算错。
export const isDocReverted = (reason: string): boolean =>
  reason.includes("已按原样输出副本");

export const isImageSkip = (reason: string): boolean => !isDocReverted(reason);

export function countImageSkips(report: Pick<CompressReport, "skipped">): number {
  return report.skipped.filter(isImageSkip).length;
}

export function docReverted(report: Pick<CompressReport, "skipped">): boolean {
  return report.skipped.some(isDocReverted);
}

export function defaultCompressPath(path: string): string {
  return path.replace(/\.pdf$/i, "") + "-compressed.pdf";
}

export function compressPercent(report: Pick<CompressReport, "original_size" | "new_size">): number {
  if (report.original_size <= 0) return 0;
  return Math.round((1 - report.new_size / report.original_size) * 100);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 压完给用户的一句话：数字必须和后端实际做过的事对齐，不夸大也不报忧 */
export function compressSummary(report: CompressReport): { kind: "info" | "success"; text: string } {
  if (docReverted(report)) {
    return { kind: "info", text: `重排之后反而更大，已按原样输出副本（${formatSize(report.new_size)}）` };
  }
  const saved = report.original_size - report.new_size;
  const pct = ((saved / report.original_size) * 100).toFixed(1);
  const kept = countImageSkips(report);
  return {
    kind: "success",
    text:
      `压缩完成：${formatSize(report.original_size)} → ${formatSize(report.new_size)}，减少 ${pct}%` +
      (kept ? `，${kept} 张保持原样` : ""),
  };
}
