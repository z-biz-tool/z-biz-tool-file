/**
 * 双栏对比的行对齐算法。
 *
 * 后端 `diff_files` 返回的是一条**扁平的行序列**（context / add / remove 混在一起），
 * 而并排视图要的是"左右两栏同一行对齐"：左边第 N 行和右边第 M 行摆在同一横排上，
 * 变更块里的删除行与新增行还要彼此对应。
 *
 * 所以这里做的事只有一件：把扁平序列折成"行对行"的表格。
 *
 * 折叠规则（与主流 diff 工具一致）：
 * - context 行：左右都有，直接成对。
 * - 连续的 remove / add 视为一个**变更块**。块里的 remove 与 add 按出现顺序两两配对；
 *   数量不等时多出来的那几行在另一侧留空（空槽），而不是硬凑成一行内容对不上。
 *
 * 纯函数、零依赖：既好测，又不会被 UI 改动带着一起坏。
 */

/** 与后端 `DiffLine` 对应。 */
export interface DiffLine {
  kind: "context" | "add" | "remove";
  old_line: number | null;
  new_line: number | null;
  content: string;
}

/** 一栏里的一行。`null` 表示这一侧在当前横排上没有内容（变更块数量不等时的空槽）。 */
export interface SideCell {
  /** 该侧的行号（后端给的是 1 起）。空槽为 null。 */
  lineNo: number | null;
  content: string;
  /** 这一行是新增还是删除（context 侧为 "context"）。 */
  kind: "context" | "add" | "remove";
}

/** 一横排：左右两栏各一格。 */
export interface SideBySideRow {
  left: SideCell | null;
  right: SideCell | null;
  /** "equal" = 两侧相同；"changed" = 这一横排有增删。 */
  type: "equal" | "changed";
}

/**
 * 给一段变更块配对。
 *
 * 抽出来单独导出是因为这是整个算法里唯一有"顺序"讲究的部分：
 * 删除的第 k 行要对着新增的第 k 行，中间不能插别的块。
 * 单独导出便于单独测试，也便于以后想换配对策略时只动这一处。
 */
export function pairChangeBlock(removes: DiffLine[], adds: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  const pairs = Math.max(removes.length, adds.length);
  for (let k = 0; k < pairs; k += 1) {
    const r = removes[k];
    const a = adds[k];
    rows.push({
      left: r ? { lineNo: r.old_line, content: r.content, kind: "remove" } : null,
      right: a ? { lineNo: a.new_line, content: a.content, kind: "add" } : null,
      type: "changed",
    });
  }
  return rows;
}

/**
 * 把扁平 diff 行序列折成左右对齐的横排。
 *
 * 空输入返回空数组（不是 null）：调用方直接 `.map` 就行。
 */
export function buildSideBySide(lines: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.kind === "context") {
      rows.push({
        left: { lineNo: line.old_line, content: line.content, kind: "context" },
        right: { lineNo: line.new_line, content: line.content, kind: "context" },
        type: "equal",
      });
      i += 1;
      continue;
    }

    // 变更块：把紧跟着的 remove / add 全收进来
    const removes: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind !== "context") {
      if (lines[i].kind === "remove") removes.push(lines[i]);
      else adds.push(lines[i]);
      i += 1;
    }

    rows.push(...pairChangeBlock(removes, adds));
  }

  return rows;
}

/** 对齐结果的统计：左右各多少行、多少个变更横排。 */
export interface SideBySideStats {
  leftLines: number;
  rightLines: number;
  changedRows: number;
  equalRows: number;
}

/**
 * 数一数对齐结果的规模。
 *
 * 这不是"从 rows 反推行数"那么显然的事：空槽那一侧不计入行数，
 * 所以统计口径是"这一侧真的排出来了几行内容"。
 */
export function sideBySideStats(rows: SideBySideRow[]): SideBySideStats {
  let leftLines = 0;
  let rightLines = 0;
  let changedRows = 0;
  let equalRows = 0;
  for (const row of rows) {
    if (row.left) leftLines += 1;
    if (row.right) rightLines += 1;
    if (row.type === "changed") changedRows += 1;
    else equalRows += 1;
  }
  return { leftLines, rightLines, changedRows, equalRows };
}
