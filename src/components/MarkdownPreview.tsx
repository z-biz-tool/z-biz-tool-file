import { useMemo, useState, useCallback } from "react";
import { theme, Button, Tooltip, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { useTheme } from "../_shared";

interface MarkdownPreviewProps {
  content: string;
  /**
   * 是否渲染内置的"复制源码"按钮。
   * - true (默认)：MarkdownPreview 自己画这个浮动按钮
   * - false：由外层（一般是 PreviewPane）统一把复制按钮放到顶栏里，避免位置冲突
   */
  showCopyButton?: boolean;
}

/** 将原始 Markdown 文本转换为 HTML 字符串（简易实现，无外部依赖） */
function convertMarkdown(md: string): string {
  // 先保护代码块和行内代码，避免内部被其他规则误转换
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 提取围栏代码块 ```lang\n...\n```
  let html = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const idx = codeBlocks.length;
    const escapedCode = escapeHtml(code.replace(/\n$/, ""));
    const langClass = lang ? `language-${lang}` : "";
    codeBlocks.push(
      `<pre class="md-code-block${langClass ? " " + langClass : ""}"><code${langClass ? ` class="${langClass}"` : ""}>${escapedCode}</code></pre>`
    );
    return `\x00CB${idx}\x00`;
  });

  // 提取行内代码 `code`
  html = html.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="md-inline-code">${escapeHtml(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  // 水平线 --- / *** / ___
  html = html.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr class="md-hr" />');

  // 表格（基本管道表格）
  html = convertTables(html);

  // 标题 h1-h6
  html = html.replace(/^#{6}\s+(.+)$/gm, '<h6 class="md-h6">$1</h6>');
  html = html.replace(/^#{5}\s+(.+)$/gm, '<h5 class="md-h5">$1</h5>');
  html = html.replace(/^#{4}\s+(.+)$/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^#{3}\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^#{2}\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^#{1}\s+(.+)$/gm, '<h1 class="md-h1">$1</h1>');

  // 引用块 > text（合并连续行）
  html = html.replace(/^(?:&gt;|>)\s?(.+)$/gm, '<blockquote-line>$1</blockquote-line>');
  html = html.replace(
    /((?:<blockquote-line>.*<\/blockquote-line>\n?)+)/g,
    (_match, block: string) => {
      const inner = block
        .replace(/<\/?blockquote-line>/g, "")
        .trim();
      return `<blockquote class="md-blockquote">${inner}</blockquote>`;
    }
  );

  // 图片 ![alt](src)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img class="md-image" alt="$1" src="$2" />');

  // 链接 [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 粗体 **text** 或 __text__
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // 斜体 *text* 或 _text_（避免与粗体冲突，只匹配单符号）
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<em>$1</em>");

  // 无序列表 - / * / +
  html = html.replace(/^[\-\*\+]\s+(.+)$/gm, '<li class="md-ul-item">$1</li>');
  html = html.replace(
    /((?:<li class="md-ul-item">.*<\/li>\n?)+)/g,
    (_match, block: string) => `<ul class="md-ul">${block}</ul>`
  );

  // 有序列表 1. text
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li class="md-ol-item">$1</li>');
  html = html.replace(
    /((?:<li class="md-ol-item">.*<\/li>\n?)+)/g,
    (_match, block: string) => `<ol class="md-ol">${block}</ol>`
  );

  // 段落：将连续非标签行包裹为 <p>
  html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, '<p class="md-p">$1</p>');

  // 还原行内代码
  inlineCodes.forEach((code, idx) => {
    html = html.replace(`\x00IC${idx}\x00`, code);
  });

  // 还原代码块
  codeBlocks.forEach((code, idx) => {
    html = html.replace(`\x00CB${idx}\x00`, code);
  });

  return html;
}

/** 转换管道表格 */
function convertTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // 检测表格起始：当前行包含 | 且下一行是分隔行（---|---）
    if (
      i + 1 < lines.length &&
      /\|/.test(lines[i]) &&
      /^\|?\s*[-:]+[-| :]*$/.test(lines[i + 1])
    ) {
      const headerLine = lines[i];
      const sepLine = lines[i + 1];
      const aligns = parseAligns(sepLine);
      const headers = parseRow(headerLine);

      let tableHtml = '<table class="md-table"><thead><tr>';
      headers.forEach((h, ci) => {
        const align = aligns[ci] ? ` style="text-align:${aligns[ci]}"` : "";
        tableHtml += `<th${align}>${inlineFormat(h)}</th>`;
      });
      tableHtml += "</tr></thead><tbody>";

      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && !/^$/.test(lines[i])) {
        const cells = parseRow(lines[i]);
        tableHtml += "<tr>";
        cells.forEach((c, ci) => {
          const align = aligns[ci] ? ` style="text-align:${aligns[ci]}"` : "";
          tableHtml += `<td${align}>${inlineFormat(c)}</td>`;
        });
        tableHtml += "</tr>";
        i++;
      }
      tableHtml += "</tbody></table>";
      result.push(tableHtml);
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

function parseRow(line: string): string[] {
  const trimmed = line.trim();
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.map((c) => c.trim());
}

function parseAligns(sepLine: string): string[] {
  const cells = parseRow(sepLine);
  return cells.map((c) => {
    const t = c.trim();
    if (t.startsWith(":") && t.endsWith(":")) return "center";
    if (t.endsWith(":")) return "right";
    if (t.startsWith(":")) return "left";
    return "";
  });
}

/** 表格单元格内的简单行内格式 */
function inlineFormat(text: string): string {
  let r = text;
  r = r.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  r = r.replace(/\*(.+?)\*/g, "<em>$1</em>");
  r = r.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return r;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default function MarkdownPreview({ content, showCopyButton = true }: MarkdownPreviewProps) {
  const { mode } = useTheme();
  const { token } = theme.useToken();
  const isDark = mode === "dark";
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => convertMarkdown(content), [content]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      message.success("已复制源码");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error("复制失败");
    }
  }, [content]);

  // ---- 样式 ----
  const bgCode = isDark ? "#1e1e2e" : "#f6f8fa";
  const bgInlineCode = isDark ? "rgba(110,118,129,0.3)" : "rgba(175,184,193,0.2)";
  const borderTable = isDark ? token.colorBorderSecondary : "#dfe2e5";
  const bgBlockquote = isDark ? "rgba(110,118,129,0.12)" : "rgba(0,0,0,0.04)";
  const borderBlockquote = isDark ? token.colorBorderSecondary : "#dfe2e5";
  const hrColor = isDark ? token.colorBorderSecondary : "#e1e4e8";
  const linkColor = token.colorPrimary;
  const textColor = token.colorText;
  const textSecondary = token.colorTextSecondary;

  const containerStyle: React.CSSProperties = {
    height: "100%",
    overflow: "auto",
    position: "relative",
    padding: "24px 32px",
    color: textColor,
    lineHeight: 1.75,
    fontSize: 15,
    background: token.colorBgContainer,
  };

  const copyBtnStyle: React.CSSProperties = {
    position: "sticky",
    top: 0,
    float: "right",
    zIndex: 10,
    marginTop: -8,
    marginRight: -8,
  };

  const css = `
.md-h1 { font-size: 2em; font-weight: 700; margin: 0.67em 0 0.4em; padding-bottom: 0.3em; border-bottom: 1px solid ${hrColor}; }
.md-h2 { font-size: 1.5em; font-weight: 600; margin: 1em 0 0.4em; padding-bottom: 0.25em; border-bottom: 1px solid ${hrColor}; }
.md-h3 { font-size: 1.25em; font-weight: 600; margin: 1em 0 0.3em; }
.md-h4 { font-size: 1.1em; font-weight: 600; margin: 0.8em 0 0.3em; }
.md-h5 { font-size: 1em; font-weight: 600; margin: 0.8em 0 0.2em; }
.md-h6 { font-size: 0.9em; font-weight: 600; margin: 0.8em 0 0.2em; color: ${textSecondary}; }
.md-p { margin: 0.6em 0; }
.md-code-block { background: ${bgCode}; border-radius: 6px; padding: 16px; overflow-x: auto; margin: 1em 0; font-size: 13px; line-height: 1.6; border: 1px solid ${isDark ? "rgba(110,118,129,0.2)" : "#e1e4e8"}; }
.md-code-block code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; }
.md-inline-code { background: ${bgInlineCode}; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; }
.md-link { color: ${linkColor}; text-decoration: none; }
.md-link:hover { text-decoration: underline; }
.md-ul, .md-ol { padding-left: 2em; margin: 0.5em 0; }
.md-ul { list-style-type: disc; }
.md-ol { list-style-type: decimal; }
.md-ul-item, .md-ol-item { margin: 0.25em 0; }
.md-blockquote { border-left: 4px solid ${borderBlockquote}; background: ${bgBlockquote}; padding: 0.6em 1em; margin: 1em 0; border-radius: 0 4px 4px 0; color: ${textSecondary}; }
.md-hr { border: none; border-top: 2px solid ${hrColor}; margin: 1.5em 0; }
.md-table { border-collapse: collapse; width: 100%; margin: 1em 0; overflow: auto; }
.md-table th, .md-table td { border: 1px solid ${borderTable}; padding: 8px 12px; text-align: left; }
.md-table th { background: ${isDark ? "rgba(110,118,129,0.12)" : "#f6f8fa"}; font-weight: 600; }
.md-table tr:nth-child(even) { background: ${isDark ? "rgba(110,118,129,0.06)" : "rgba(0,0,0,0.02)"}; }
.md-image { max-width: 100%; height: auto; border-radius: 4px; margin: 0.5em 0; }
/* 语法高亮 CSS 类名占位（可配合外部高亮主题） */
.language-javascript, .language-js, .language-typescript, .language-ts,
.language-python, .language-py, .language-java, .language-c, .language-cpp,
.language-go, .language-rust, .language-bash, .language-shell, .language-json,
.language-html, .language-css, .language-yaml, .language-markdown, .language-sql {}
`;

  return (
    <div style={containerStyle}>
      <style>{css}</style>
      {showCopyButton && (
        <div style={copyBtnStyle}>
          <Tooltip title={copied ? "已复制" : "复制源码"}>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={handleCopy}
              type={copied ? "primary" : "default"}
            />
          </Tooltip>
        </div>
      )}
      <div
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
