/**
 * 模糊匹配工具 — 当前目录的快速过滤
 *
 * 实现：subsequence + 简单评分
 * - 输入"idnex"能匹配"index.ts"
 * - 大小写不敏感
 * - 连续字符加分（"abc" 匹配 "xabcy" 比 "axbxcx" 分数高）
 * - 文件名前缀匹配优先
 */

export interface FuzzyMatchResult {
  /** 匹配得分（越高越相关） */
  score: number;
  /** 匹配位置 [start, end) — 用于 UI 高亮（后续可加） */
  matches: Array<[number, number]>;
}

/**
 * 检查 needle 是否在 haystack 里 subsequence 匹配
 * 返回 null 表示不匹配，否则返回 (score, matches)
 */
export function fuzzyMatch(
  needle: string,
  haystack: string,
): FuzzyMatchResult | null {
  if (!needle) return { score: 1, matches: [] };
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  const nLen = n.length;
  const hLen = h.length;
  if (nLen === 0) return { score: 1, matches: [] };
  if (hLen < nLen) return null;

  let nIdx = 0;
  let hIdx = 0;
  let score = 0;
  let lastMatchedIdx = -2; // 初始化为 -2，让第一个匹配的得分高
  let consecutive = 0;
  const matchPositions: number[] = [];

  while (nIdx < nLen && hIdx < hLen) {
    if (n[nIdx] === h[hIdx]) {
      matchPositions.push(hIdx);
      consecutive += 1;
      // 连续匹配加权
      score += 1 + consecutive * 2;
      // 紧邻上一匹配再加权
      if (hIdx === lastMatchedIdx + 1) {
        score += 5;
      }
      // 前缀匹配
      if (hIdx === 0) {
        score += 10;
      }
      // 词边界加分（"-" "/" "." "_" 之后的字符）
      if (hIdx > 0 && /[-/._\s]/.test(h[hIdx - 1])) {
        score += 3;
      }
      lastMatchedIdx = hIdx;
      nIdx += 1;
    } else {
      consecutive = 0;
    }
    hIdx += 1;
  }

  if (nIdx < nLen) return null; // 没匹配完

  // 长度惩罚：needle 在 haystack 中占比越低越好
  score -= Math.max(0, hLen - nLen) * 0.1;

  // 转成 [start, end) 范围对（连续区间合并）
  const ranges: Array<[number, number]> = [];
  for (const p of matchPositions) {
    const last = ranges[ranges.length - 1];
    if (last && p === last[1]) {
      last[1] = p + 1;
    } else {
      ranges.push([p, p + 1]);
    }
  }
  return { score, matches: ranges };
}

/**
 * 简单的"是/否"匹配 — 仅判断是否 subsequence 命中
 */
export function isFuzzyMatch(needle: string, haystack: string): boolean {
  return fuzzyMatch(needle, haystack) !== null;
}

/**
 * 过滤 + 排序：返回匹配项的子集，按相关度降序
 */
export function fuzzyFilter<T extends { name: string }>(
  needle: string,
  items: T[],
): T[] {
  if (!needle) return items;
  const results: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const m = fuzzyMatch(needle, item.name);
    if (m) results.push({ item, score: m.score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.map((r) => r.item);
}
