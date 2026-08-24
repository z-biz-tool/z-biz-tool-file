import { useMemo, useState } from "react";
import { Alert, Button, Tooltip } from "antd";
import { CaretDownOutlined, CaretRightOutlined } from "@ant-design/icons";
import { useTheme } from "../_shared";

interface JsonPreviewProps {
  content: string;
  fileName: string;
}

/** JSON 节点：递归把任意 JS 值映射到一棵 React 树 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

/** 浅色/深色下不同 token 类型的颜色（参考 VSCode 暗色主题） */
function useJsonColors() {
  const { mode } = useTheme();
  const isDark = mode === "dark";
  return {
    key: isDark ? "#9cdcfe" : "#0451a5",
    string: isDark ? "#ce9178" : "#a31515",
    number: isDark ? "#b5cea8" : "#098658",
    boolean: isDark ? "#569cd6" : "#0000ff",
    null: isDark ? "#569cd6" : "#0000ff",
    punctuation: isDark ? "#d4d4d4" : "#000000",
    bracket: isDark ? "#ffd700" : "#0431fa",
    bg: isDark ? "#1e1e1e" : "#ffffff",
    subtle: isDark ? "#888" : "#888",
  };
}

/** 字符串安全渲染（防 React XSS） */
function safeStr(s: string): string {
  return s;
}
interface NodeProps {
  value: JsonValue;
  k?: string;
  path?: string;
  depth?: number;
}

function Node({ value, k, path = "$", depth = 0 }: NodeProps) {
  const colors = useJsonColors();
  const [collapsed, setCollapsed] = useState(false);
  // 缩进
  const indent = depth * 16;

  // 渲染 key
  const keyEl = k !== undefined ? (
    <>
      <span style={{ color: colors.subtle }}>"</span>
      <span style={{ color: colors.key }}>{safeStr(k)}</span>
      <span style={{ color: colors.subtle }}>"</span>
      <span style={{ color: colors.punctuation, marginRight: 4 }}>:</span>
    </>
  ) : null;

  // null
  if (value === null) {
    return (
      <div style={{ paddingLeft: indent, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.6 }}>
        {keyEl}
        <span style={{ color: colors.null }}>null</span>
      </div>
    );
  }
  // 标量
  if (typeof value === "string") {
    return (
      <div style={{ paddingLeft: indent, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.6 }}>
        {keyEl}
        <span style={{ color: colors.string }}>"{safeStr(value)}"</span>
      </div>
    );
  }
  if (typeof value === "number") {
    return (
      <div style={{ paddingLeft: indent, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.6 }}>
        {keyEl}
        <span style={{ color: colors.number }}>{String(value)}</span>
      </div>
    );
  }
  if (typeof value === "boolean") {
    return (
      <div style={{ paddingLeft: indent, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.6 }}>
        {keyEl}
        <span style={{ color: colors.boolean }}>{String(value)}</span>
      </div>
    );
  }

  // 数组
  if (Array.isArray(value)) {
    const open = value.length > 0 && !collapsed;
    return (
      <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.6 }}>
        <div
          style={{ paddingLeft: indent, cursor: value.length > 0 ? "pointer" : "default", userSelect: "none" }}
          onClick={() => value.length > 0 && setCollapsed(!collapsed)}
        >
          {value.length > 0 && (
            <span style={{ color: colors.subtle, marginRight: 4, fontSize: 10 }}>
              {collapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}
            </span>
          )}
          {keyEl}
          <span style={{ color: colors.bracket }}>[</span>
          {!open && (
            <>
              <span style={{ color: colors.subtle, marginLeft: 4 }}>
                {value.length} 项
              </span>
              <span style={{ color: colors.bracket }}>]</span>
            </>
          )}
        </div>
        {open && (
          <>
            {value.map((item, i) => (
              <Node key={i} value={item} path={`${path}[${i}]`} depth={depth + 1} />
            ))}
            <div style={{ paddingLeft: indent }}>
              <span style={{ color: colors.bracket }}>]</span>
            </div>
          </>
        )}
      </div>
    );
  }

  // 对象
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const open = keys.length > 0 && !collapsed;
    return (
      <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.6 }}>
        <div
          style={{ paddingLeft: indent, cursor: keys.length > 0 ? "pointer" : "default", userSelect: "none" }}
          onClick={() => keys.length > 0 && setCollapsed(!collapsed)}
        >
          {keys.length > 0 && (
            <span style={{ color: colors.subtle, marginRight: 4, fontSize: 10 }}>
              {collapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}
            </span>
          )}
          {keyEl}
          <span style={{ color: colors.bracket }}>{`{`}</span>
          {!open && (
            <>
              <span style={{ color: colors.subtle, marginLeft: 4 }}>
                {keys.length} 个键
              </span>
              <span style={{ color: colors.bracket }}>{`}`}</span>
            </>
          )}
        </div>
        {open && (
          <>
            {keys.map((key) => (
              <Node
                key={key}
                k={key}
                value={(value as Record<string, JsonValue>)[key]}
                path={`${path}.${key}`}
                depth={depth + 1}
              />
            ))}
            <div style={{ paddingLeft: indent }}>
              <span style={{ color: colors.bracket }}>{`}`}</span>
            </div>
          </>
        )}
      </div>
    );
  }

  return null;
}

export default function JsonPreview({ content, fileName }: JsonPreviewProps) {
  const colors = useJsonColors();
  const [expandAll, setExpandAll] = useState(true);

  const parsed = useMemo<{ ok: true; data: JsonValue } | { ok: false; error: string }>(() => {
    try {
      const data = JSON.parse(content) as JsonValue;
      return { ok: true, data };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }, [content]);

  if (!parsed.ok) {
    return (
      <div style={{ padding: 16 }}>
        <Alert
          type="error"
          showIcon
          message="JSON 解析失败"
          description={
            <>
              <div style={{ marginBottom: 8 }}>{parsed.error}</div>
              <div style={{ fontSize: 12, color: colors.subtle }}>
                文件 {fileName} 不是合法的 JSON
              </div>
            </>
          }
        />
        <pre
          className="preview-text"
          style={{
            marginTop: 12,
            color: colors.string,
            background: colors.bg,
            padding: 12,
            borderRadius: 4,
            fontSize: 12,
            maxHeight: 400,
            overflow: "auto",
          }}
        >
          {content.slice(0, 2000)}
          {content.length > 2000 && "\n... (截断)"}
        </pre>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: colors.bg,
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          fontSize: 12,
          color: colors.subtle,
          borderBottom: `1px solid ${colors.subtle}22`,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ fontWeight: 600, color: colors.punctuation }}>{fileName}</span>
        <span>有效 JSON</span>
        <div style={{ flex: 1 }} />
        <Tooltip title={expandAll ? "默认全展开（可点击行折叠）" : ""}>
          <Button
            type="text"
            size="small"
            onClick={() => setExpandAll(!expandAll)}
          >
            {expandAll ? "全展开" : "全收起"}
          </Button>
        </Tooltip>
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "12px 16px",
        }}
      >
        <Node value={parsed.data} />
      </div>
    </div>
  );
}
