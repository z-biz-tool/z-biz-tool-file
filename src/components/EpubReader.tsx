import { useState, useEffect, useMemo } from "react";
import { Typography, Button, Progress, theme } from "antd";
import { LeftOutlined, RightOutlined, ReadOutlined, BookOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useTheme, LoadingState, EmptyState, ErrorState } from "../_shared";

const { Text } = Typography;

interface Chapter {
  title: string;
  content: string;
  index: number;
}

interface EpubBook {
  title: string;
  author: string;
  chapters: Chapter[];
  cover_path: string;
}

interface EpubReaderProps {
  filePath: string;
  fileName: string;
}

export default function EpubReader({ filePath, fileName }: EpubReaderProps) {
  const { mode } = useTheme();
  const { token } = theme.useToken();
  const [loading, setLoading] = useState(true);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [currentChapter, setCurrentChapter] = useState(0);
  const [error, setError] = useState("");
  const [showSidebar, setShowSidebar] = useState(true);
  const [bookTitle, setBookTitle] = useState("");
  const [bookAuthor, setBookAuthor] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    setChapters([]);
    setCurrentChapter(0);
    setBookTitle("");
    setBookAuthor("");

    invoke<EpubBook>("parse_epub", { path: filePath })
      .then((book) => {
        // Rust 端已按 spine 顺序给出章节，content 是改写后的 XHTML：
        //   - <img src="相对"> → <img src="file:///tmp/z-tool-epub-{hash}/相对">
        //   - <image href> 同理
        // 配合 tauri 的 asset:// 协议让 webview 能直接加载图片
        // 不再走 xhtmlToText（会丢失图片），改用 dangerouslySetInnerHTML
        setChapters(book.chapters);
        setBookTitle(book.title || fileName.replace(/\.epub$/i, ""));
        setBookAuthor(book.author || "未知作者");
      })
      .catch((err) => {
        setError("解析EPUB文件失败: " + (typeof err === "string" ? err : JSON.stringify(err)));
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
      {/* epub 内容样式：限制图片宽度、段落间距。EPUB 自身的 <style> 不渲染，
          这里给所有渲染的 XHTML 一个统一的"舒适阅读"样式。 */}
      <style>{`
        .epub-content { line-height: 1.8; }
        .epub-content p { margin: 0.8em 0; }
        .epub-content h1, .epub-content h2, .epub-content h3,
        .epub-content h4, .epub-content h5, .epub-content h6 {
          margin-top: 1.2em; margin-bottom: 0.6em; font-weight: 600;
        }
        .epub-content img, .epub-content svg, .epub-content image {
          max-width: 100%; height: auto; display: block; margin: 0.5em auto;
        }
        .epub-content a { color: #1677ff; }
      `}</style>
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
          {bookTitle || fileName}
        </Text>
        {bookAuthor && (
          <div style={{ fontSize: 11, color: token.colorTextSecondary, marginTop: 2 }}>
            {bookAuthor}
          </div>
        )}
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
            {/* 渲染 Rust 端改写过的 XHTML（含图片 file:// 引用）。
                用 dangerouslySetInnerHTML 而不是 textContent，是因为内容里
                可能有 <img>/<svg>/<p> 等结构。EPUB 文件由用户自选，可信。 */}
            <div
              className="epub-content"
              dangerouslySetInnerHTML={{ __html: chapters[currentChapter].content }}
            />
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
