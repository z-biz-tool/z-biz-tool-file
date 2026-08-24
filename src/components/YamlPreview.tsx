import { useTheme } from "../_shared";

interface YamlPreviewProps {
  content: string;
  fileName: string;
  /** 简单文件类型信息：yaml/toml/ini/conf 等都用同一套渲染 */
  format?: "yaml" | "toml" | "ini" | "env";
}

type Token = { text: string; type: string };

/**
 * 极简 YAML/TOML/INI 行级高亮 tokenizer。
 * 不追求 100% 准确（YAML 语法复杂），目标是"读起来够清晰"。
 */
function tokenizeLine(line: string, format: "yaml" | "toml" | "ini" | "env"): Token[] {
  const out: Token[] = [];

  // 整行注释：# 或 // (ini)
  if (format === "ini" || format === "env") {
    if (/^\s*[#;]/.test(line)) {
      return [{ text: line, type: "comment" }];
    }
    if (line.trim() === "") return [{ text: line, type: "plain" }];
    // INI/TOML/ENV: key = value 或 [section]
    const m = line.match(/^(\s*)(\[[^\]]+\]|[^=:#]+?)\s*([=:]?)\s*(.*)$/);
    if (m) {
      const [, lead, key, sep, val] = m;
      if (lead) out.push({ text: lead, type: "plain" });
      if (key.startsWith("[")) {
        out.push({ text: key, type: "section" });
      } else {
        out.push({ text: key, type: "key" });
      }
      if (sep) out.push({ text: sep + " ", type: "punct" });
      if (val) {
        // value 着色
        if (/^(true|false|null|yes|no|on|off)$/i.test(val.trim())) {
          out.push({ text: val, type: "boolean" });
        } else if (/^-?\d+(\.\d+)?$/.test(val.trim())) {
          out.push({ text: val, type: "number" });
        } else if (/^["'].*["']$/.test(val.trim())) {
          out.push({ text: val, type: "string" });
        } else {
          out.push({ text: val, type: "string" });
        }
      }
      return out;
    }
    return [{ text: line, type: "plain" }];
  }

  // YAML
  // 1. 空行
  if (line.trim() === "") return [{ text: line, type: "plain" }];

  // 2. 整行注释
  if (/^\s*#/.test(line)) {
    return [{ text: line, type: "comment" }];
  }

  // 3. 列表项 `- key: value` 或 `- value`
  const listMatch = line.match(/^(\s*)(-)\s+(.*)$/);
  if (listMatch) {
    const [, lead, dash, rest] = listMatch;
    if (lead) out.push({ text: lead, type: "plain" });
    out.push({ text: dash + " ", type: "list" });
    // rest 可能包含 "key: value" 或纯 value
    const kvMatch = rest.match(/^([^:#]+?)\s*(:)\s*(.*)$/);
    if (kvMatch) {
      const [, k, colon, v] = kvMatch;
      out.push({ text: k, type: "key" });
      out.push({ text: colon + " ", type: "punct" });
      out.push(...tokenizeValue(v));
    } else {
      out.push(...tokenizeValue(rest));
    }
    return out;
  }

  // 4. key: value
  const kvMatch = line.match(/^(\s*)([^:#]+?)\s*(:)\s*(.*)$/);
  if (kvMatch) {
    const [, lead, k, colon, v] = kvMatch;
    if (lead) out.push({ text: lead, type: "plain" });
    out.push({ text: k, type: "key" });
    out.push({ text: colon, type: "punct" });
    if (v) {
      out.push({ text: " ", type: "plain" });
      out.push(...tokenizeValue(v));
    }
    return out;
  }

  return [{ text: line, type: "plain" }];
}

function tokenizeValue(v: string): Token[] {
  // 注释优先
  const hashIdx = findUnquotedHash(v);
  let valuePart = v;
  let commentPart = "";
  if (hashIdx >= 0) {
    valuePart = v.slice(0, hashIdx);
    commentPart = v.slice(hashIdx);
  }
  const out: Token[] = [];
  const trimmed = valuePart.trimEnd();
  if (trimmed === "") {
    if (valuePart) out.push({ text: valuePart, type: "plain" });
    if (commentPart) out.push({ text: commentPart, type: "comment" });
    return out;
  }
  out.push({ text: valuePart.slice(0, valuePart.length - trimmed.length), type: "plain" });
  const t = trimmed;
  if (/^(true|false|null|~)$/i.test(t)) {
    out.push({ text: t, type: "boolean" });
  } else if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
    out.push({ text: t, type: "number" });
  } else if (/^["'].*["']$/.test(t)) {
    out.push({ text: t, type: "string" });
  } else if (t === "|" || t === ">" || t.startsWith("|") || t.startsWith(">")) {
    out.push({ text: t, type: "scalar" });
  } else {
    out.push({ text: t, type: "string" });
  }
  if (commentPart) out.push({ text: commentPart, type: "comment" });
  return out;
}

function findUnquotedHash(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) return i;
  }
  return -1;
}

export default function YamlPreview({ content, fileName, format = "yaml" }: YamlPreviewProps) {
  const { mode } = useTheme();
  const isDark = mode === "dark";

  const colors = {
    plain: isDark ? "#d4d4d4" : "#1a1a1a",
    comment: isDark ? "#6a9955" : "#008000",
    key: isDark ? "#9cdcfe" : "#0451a5",
    string: isDark ? "#ce9178" : "#a31515",
    number: isDark ? "#b5cea8" : "#098658",
    boolean: isDark ? "#569cd6" : "#0000ff",
    list: isDark ? "#c586c0" : "#af00db",
    punct: isDark ? "#d4d4d4" : "#000000",
    section: isDark ? "#dcdcaa" : "#795e26",
    scalar: isDark ? "#dcdcaa" : "#795e26",
    guide: isDark ? "#3a3a3a" : "#e8e8e8",
    bg: isDark ? "#1e1e1e" : "#ffffff",
  };

  const lines = content.split(/\r?\n/);
  const formatLabel = format.toUpperCase();

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
          color: isDark ? "#999" : "#666",
          borderBottom: `1px solid ${colors.guide}`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600, color: colors.plain }}>{fileName}</span>
        <span style={{ marginLeft: 12 }}>{formatLabel} · {lines.length.toLocaleString()} 行</span>
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "12px 0",
          fontFamily: "ui-monospace, Menlo, Consolas, monospace",
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        {lines.map((line, i) => {
          const tokens = tokenizeLine(line, format);
          return (
            <div
              key={i}
              style={{
                display: "flex",
                paddingLeft: 8,
                paddingRight: 16,
                whiteSpace: "pre",
              }}
            >
              {/* 行号 */}
              <span
                style={{
                  minWidth: 40,
                  textAlign: "right",
                  marginRight: 16,
                  color: colors.guide,
                  userSelect: "none",
                  fontSize: 12,
                }}
              >
                {i + 1}
              </span>
              <div style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {tokens.map((t, j) => (
                  <span
                    key={j}
                    style={{
                      color: colors[t.type as keyof typeof colors] || colors.plain,
                      fontStyle: t.type === "comment" ? "italic" : "normal",
                      fontWeight: t.type === "key" || t.type === "section" ? 600 : 400,
                    }}
                  >
                    {t.text}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
