import { useMemo } from "react";
import { Table, Empty } from "antd";
import { useTheme } from "../_shared";

interface CsvPreviewProps {
  content: string;
  fileName: string;
}

/**
 * 极简 RFC 4180 解析器：
 * - 支持引号包裹字段
 * - 支持引号内逗号 ("," 仍是同一字段)
 * - 支持双引号转义 ("")
 * - 支持 CRLF / LF 行结束
 * - 不支持：自定义分隔符（只认逗号）
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        // 处理 CRLF：\r 后面如果是 \n 跳过
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else {
        field += c;
      }
    }
  }
  // 收尾：最后一行（如果文件不以换行结尾）
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export default function CsvPreview({ content, fileName }: CsvPreviewProps) {
  const { mode } = useTheme();
  const isDark = mode === "dark";

  const { columns, dataSource, stats } = useMemo(() => {
    const rows = parseCsv(content);
    if (rows.length === 0) {
      return { columns: [], dataSource: [], stats: { rows: 0, cols: 0 } };
    }
    const [header, ...body] = rows;
    // 补齐：每行列数对齐到表头长度
    const colCount = header.length;
    const normalized = body.map((r) => {
      const padded = r.length < colCount
        ? [...r, ...Array(colCount - r.length).fill("")]
        : r.slice(0, colCount);
      return padded;
    });
    const cols = header.map((title, idx) => ({
      key: `c${idx}`,
      title: title || `(列 ${idx + 1})`,
      dataIndex: idx,
      ellipsis: true,
      width: 160,
      // 数字列右对齐
      align: normalized.every((r) => r[idx] === "" || !isNaN(Number(r[idx])))
        ? ("right" as const)
        : ("left" as const),
    }));
    const ds = normalized.map((cells, i) => ({
      key: i,
      ...Object.fromEntries(cells.map((v, idx) => [idx, v])),
    }));
    return {
      columns: cols,
      dataSource: ds,
      stats: { rows: body.length, cols: colCount },
    };
  }, [content]);

  if (columns.length === 0) {
    return <Empty description="空 CSV 或解析失败" />;
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* 顶部统计栏 */}
      <div
        style={{
          padding: "6px 12px",
          fontSize: 12,
          color: isDark ? "#999" : "#666",
          background: isDark ? "#1f1f1f" : "#fafafa",
          borderBottom: `1px solid ${isDark ? "#303030" : "#e8e8e8"}`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600 }}>{fileName}</span>
        <span style={{ marginLeft: 12 }}>
          {stats.rows.toLocaleString()} 行 × {stats.cols} 列
        </span>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <Table
          columns={columns}
          dataSource={dataSource}
          size="small"
          pagination={{ pageSize: 100, showSizeChanger: false }}
          scroll={{ x: "max-content" }}
          bordered
        />
      </div>
    </div>
  );
}
