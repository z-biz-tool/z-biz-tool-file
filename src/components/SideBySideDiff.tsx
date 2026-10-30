import { useMemo } from "react";
import { Empty, theme } from "antd";
import {
  buildSideBySide,
  sideBySideStats,
  type DiffLine,
  type SideCell,
} from "../utils/diffSideBySide";

/**
 * 并排双栏 diff 视图。
 *
 * 这是"双栏对比"里真正干活的那一半：把后端 `diff_files` 的扁平行序列折成左右对齐的
 * 横排，逐行并排显示，删除行与新增行在同一个变更块里彼此对应。
 *
 * 颜色一律走主题变量（token / CSS 变量）：这个 app 的默认态是深色，
 * 写死亮色字面量会在深色下变成"深底亮字"的刺眼条带。
 */

interface SideBySideDiffProps {
  lines: DiffLine[];
  /** 左侧栏标题（一般是文件名或路径） */
  leftLabel: string;
  rightLabel: string;
  /** 高度上限；不给则自适应内容 */
  maxHeight?: number;
}

/** 一侧单元格。空槽（null）渲染成一条空白占位，让两栏高度对齐。 */
function SideCellView({ cell }: { cell: SideCell | null }) {
  const { token } = theme.useToken();

  const bg =
    cell === null
      ? token.colorFillAlter
      : cell.kind === "add"
        ? token.colorSuccessBg
        : cell.kind === "remove"
          ? token.colorErrorBg
          : "transparent";

  const fg = cell !== null && cell.kind !== "context" ? token.colorText : token.colorText;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        minHeight: 20,
        background: bg,
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: 12,
      }}
    >
      <div
        style={{
          width: 48,
          flex: "0 0 48px",
          padding: "1px 6px",
          textAlign: "right",
          color: token.colorTextTertiary,
          userSelect: "none",
          borderRight: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {cell?.lineNo ?? ""}
      </div>
      <div
        style={{
          width: 16,
          flex: "0 0 16px",
          padding: "1px 2px",
          textAlign: "center",
          color: fg,
          userSelect: "none",
        }}
      >
        {cell === null ? "" : cell.kind === "add" ? "+" : cell.kind === "remove" ? "-" : ""}
      </div>
      <div
        style={{
          flex: 1,
          padding: "1px 8px",
          whiteSpace: "pre",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: fg,
        }}
      >
        {cell?.content ?? ""}
      </div>
    </div>
  );
}

export default function SideBySideDiff({
  lines,
  leftLabel,
  rightLabel,
  maxHeight,
}: SideBySideDiffProps) {
  const { token } = theme.useToken();
  const rows = useMemo(() => buildSideBySide(lines), [lines]);
  const stats = useMemo(() => sideBySideStats(rows), [rows]);

  if (rows.length === 0) {
    return <Empty description="没有可显示的差异" />;
  }

  const headerStyle: React.CSSProperties = {
    display: "flex",
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
    background: token.colorFillAlter,
    fontSize: 12,
  };
  const headCellStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    padding: "4px 10px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: token.colorTextSecondary,
  };

  return (
    <div
      style={{
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      <div style={headerStyle}>
        <div style={{ ...headCellStyle, borderRight: `1px solid ${token.colorBorderSecondary}` }}>
          {leftLabel}
        </div>
        <div style={headCellStyle}>{rightLabel}</div>
      </div>
      <div
        style={{
          maxHeight: maxHeight ?? 520,
          overflow: "auto",
          fontFamily: "ui-monospace, Menlo, monospace",
        }}
      >
        {rows.map((row, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              background: row.type === "changed" ? token.colorFillAlter : "transparent",
            }}
          >
            <div
              style={{
                flex: 1,
                minWidth: 0,
                borderRight: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <SideCellView cell={row.left} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SideCellView cell={row.right} />
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          padding: "4px 10px",
          fontSize: 12,
          color: token.colorTextSecondary,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorFillAlter,
        }}
      >
        左 {stats.leftLines} 行 · 右 {stats.rightLines} 行 · 变更 {stats.changedRows} 处 · 相同{" "}
        {stats.equalRows} 处
      </div>
    </div>
  );
}
