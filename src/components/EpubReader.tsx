import { useState, useEffect, useMemo } from "react";
import { Typography, Button, Progress, theme } from "antd";
import { LeftOutlined, RightOutlined, ReadOutlined, BookOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useTheme, LoadingState, EmptyState, ErrorState } from "../_shared";

const { Text } = Typography;

interface Chapter {
  title: string;
  content: string;
}

interface EpubReaderProps {
  filePath: string;
  fileName: string;
}

interface ReadResult {
  is_binary: boolean;
  content: string;
}

/// 解析章节：优先识别中英文标题，回退按段落分割
function parseChapters(text: string): Chapter[] {
  // 中文章节标题：第X章/回/节/篇
  const cnRegex = /^[ \t]*(第[\d一二三四五六七八九十百千两]+[章回节篇][^\n]*)$/gm;
  // 英文章节标题：Chapter X
  const enRegex = /^[ \t]*(Chapter\s+\d+[^\n]*)$/gim;

  const cnMatches = [...text.matchAll(cnRegex)];
  const enMatches = [...text.matchAll(enRegex)];
  const matches = cnMatches.length >= enMatches.length ? cnMatches : enMatches;

  if (matches.length > 0) {
    const chapters: Chapter[] = [];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index ?? 0;
      const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
      const content = text.slice(start, end).trim();
      chapters.push({ title: matches[i][1].trim(), content });
    }
    return chapters;
  }

  // 回退：按段落分割
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length === 0) return [{ title: "全文", content: text }];
  return paragraphs.map((p, i) => ({
    title: `段落 ${i + 1}`,
    content: p.trim(),
  }));
}

export default function EpubReader({ filePath, fileName }: EpubReaderProps) {
  const { mode } = useTheme();
  const { token } = theme.useToken();
  const [loading, setLoading] = useState(true);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [currentChapter, setCurrentChapter] = useState(0);
  const [error, setError] = useState("");
  const [showSidebar, setShowSidebar] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError("");
    setChapters([]);
    setCurrentChapter(0);

    invoke("read_file_content", { path: filePath })
      .then((result: unknown) => {
        const r = result as ReadResult;
        if (r.is_binary) {
          setError(
            "EPUB是二进制格式（ZIP压缩包），当前版本仅支持简单文本提取。完整EPUB阅读器需要额外的解压库支持。"
          );
        } else {
          setChapters(parseChapters(r.content));
        }
      })
      .catch((err) => {
        setError("读取EPUB文件失败: " + err);
      })
      .finally(() => setLoading(false));
  }, [filePath]);

  const progress = useMemo(() => {
    if (chapters.length === 0) return 0;
    return Math.round(((currentChapter + 1) / chapters.length) * 100);
  }, [currentChapter, chapters.length]);

  const handlePrev = () => {
    if (currentChapter > 0) setCurrentChapter((c) => c - 1);
  };
  const handleNext = () => {
    if (currentChapter < chapters.length - 1) setCurrentChapter((c) => c + 1);
  };

  if (loading) {
    return <LoadingState tip="加载EPUB中..." minHeight={300} />;
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <ErrorState message={error} />
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            文件: {fileName}
          </Text>
        </div>
      </div>
    );
  }

  if (chapters.length === 0) {
    return <EmptyState title="EPUB内容为空" description="未能从该文件提取到任何文本内容" />;
  }

  // 暗色模式下自动夜间模式
  const isDark = mode === "dark";
  const readingBg = isDark ? "#1a1a1a" : "#ffffff";
  const readingColor = isDark ? "#d4d4d4" : "#333333";
  const headingColor = isDark ? "#ffffff" : "#000000";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* 顶部标题栏 */}
      <div
        style={{
          textAlign: "center",
          padding: "8px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Text strong style={{ fontSize: 14 }}>
          <BookOutlined style={{ marginRight: 6 }} />
          {fileName}
        </Text>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* 章节目录侧边栏 */}
        {showSidebar && (
          <div
            style={{
              width: 180,
              borderRight: `1px solid ${token.colorBorderSecondary}`,
              overflow: "auto",
              background: token.colorBgContainer,
            }}
          >
            <div
              style={{
                padding: "8px 12px",
                fontWeight: 600,
                fontSize: 12,
                color: token.colorTextSecondary,
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                position: "sticky",
                top: 0,
                background: token.colorBgContainer,
              }}
            >
              目录 ({chapters.length} 章)
            </div>
            {chapters.map((ch, i) => (
              <div
                key={i}
                onClick={() => setCurrentChapter(i)}
                style={{
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: 12,
                  background: i === currentChapter ? token.colorPrimaryBg : "transparent",
                  color: i === currentChapter ? token.colorPrimary : token.colorText,
                  fontWeight: i === currentChapter ? 600 : 400,
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={ch.title}
              >
                {ch.title}
              </div>
            ))}
          </div>
        )}

        {/* 阅读区 */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div
            style={{
              flex: 1,
              overflow: "auto",
              padding: "16px 24px",
              background: readingBg,
              color: readingColor,
              lineHeight: 1.8,
              fontSize: 15,
              whiteSpace: "pre-wrap",
            }}
          >
            <div
              style={{
                fontWeight: 600,
                fontSize: 17,
                marginBottom: 16,
                color: headingColor,
              }}
            >
              {chapters[currentChapter].title}
            </div>
            {chapters[currentChapter].content}
          </div>

          {/* 底部进度 + 翻页 */}
          <div
            style={{
              padding: "8px 16px",
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgContainer,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
              <Button
                size="small"
                icon={<LeftOutlined />}
                disabled={currentChapter === 0}
                onClick={handlePrev}
              />
              <Progress percent={progress} size="small" style={{ flex: 1, minWidth: 0 }} />
              <Button
                size="small"
                icon={<RightOutlined />}
                disabled={currentChapter >= chapters.length - 1}
                onClick={handleNext}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {currentChapter + 1} / {chapters.length} 章 · {progress}%
              </Text>
              <Button
                type="text"
                size="small"
                icon={<ReadOutlined />}
                onClick={() => setShowSidebar((s) => !s)}
              >
                {showSidebar ? "隐藏目录" : "显示目录"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
