/**
 * 右侧阅读面板：点中书之后直接在这里读，不用离开图书馆。
 *
 * 阅读器本身复用文件管理那边已经调好的两个（src/components/PdfViewer、EpubReader）：
 * PDF 走 PDF.js 的内嵌 viewer（fit-width、放大旋转都有了），EPUB 走后端 parse_epub
 * 分章渲染。这里只负责「按格式选哪个」以及图片/纯文本这两条轻量路径。
 */
import { useEffect, useState } from "react";
import { Button, Empty, Result, Space, Spin, Tag, theme, Typography } from "antd";
import { CloseOutlined, ExportOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import PdfViewer from "../../../components/PdfViewer";
import EpubReader from "../../../components/EpubReader";
import type { LibraryEntry } from "../libraryClient";
import { formatLabel, progressText, readStatusOf, resolveReaderKind, STATUS_LABEL } from "../facets";

const { Text } = Typography;

interface Props {
  entry: LibraryEntry | null;
  onClose: () => void;
  onOpenExternal: (entry: LibraryEntry) => void;
  onReveal: (entry: LibraryEntry) => void;
  /** 阅读器回写进度（0..1）。上层负责落库并同步列表 */
  onReadProgress?: (entry: LibraryEntry, progress: number) => void;
}

export default function ReaderPane({
  entry,
  onClose,
  onOpenExternal,
  onReveal,
  onReadProgress,
}: Props) {
  const { token } = theme.useToken();

  if (!entry) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: token.colorBgContainer,
        }}
      >
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Text type="secondary">从左边选一本书，在这里读</Text>}
        />
      </div>
    );
  }

  const kind = resolveReaderKind(entry);
  const status = readStatusOf(entry);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: token.colorBgContainer,
        borderLeft: `1px solid ${token.colorBorderSecondary}`,
        minWidth: 0,
      }}
    >
      {/* 标题条：书名可能很长，所以让它占满剩余宽度并省略，按钮固定右侧 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong ellipsis style={{ fontSize: 13, display: "block" }} title={entry.path}>
            {entry.title}
          </Text>
          <Space size={6} style={{ fontSize: 11 }}>
            <Tag style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}>
              {formatLabel(entry)}
            </Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {STATUS_LABEL[status]} · {progressText(entry)}
            </Text>
          </Space>
        </div>
        <Button
          size="small"
          type="text"
          icon={<FolderOpenOutlined />}
          aria-label="在 Finder 中显示"
          onClick={() => onReveal(entry)}
        />
        <Button
          size="small"
          type="text"
          icon={<ExportOutlined />}
          aria-label="用默认应用打开"
          onClick={() => onOpenExternal(entry)}
        />
        <Button
          size="small"
          type="text"
          icon={<CloseOutlined />}
          aria-label="关闭阅读面板"
          onClick={onClose}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {kind === "pdf" && <PdfViewer filePath={entry.path} fileName={entry.title} />}
        {kind === "epub" && (
          <EpubReader
            filePath={entry.path}
            fileName={entry.title}
            onProgress={(p) => onReadProgress?.(entry, p)}
          />
        )}
        {kind === "image" && <ImagePage entry={entry} />}
        {kind === "text" && <TextPage entry={entry} />}
        {kind === null && (
          <Result
            status="info"
            title="这个格式还不能在应用内阅读"
            subTitle={`${formatLabel(entry)} 需要外部应用打开`}
            extra={
              <Button type="primary" onClick={() => onOpenExternal(entry)}>
                用默认应用打开
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}

function ImagePage({ entry }: { entry: LibraryEntry }) {
  const { token } = theme.useToken();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div style={{ padding: 24 }}>
        <Result status="warning" title="图片加载失败" subTitle={entry.path} />
      </div>
    );
  }
  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        background: token.colorFillQuaternary,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 12,
      }}
    >
      <img
        src={convertFileSrc(entry.path)}
        alt={entry.title}
        onError={() => setFailed(true)}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
      />
    </div>
  );
}

/** 纯文本：直接读文件内容。超过 1 MB 的不读 —— 那不是拿来"读书"的，是日志。 */
const TEXT_LIMIT = 1024 * 1024;

function TextPage({ entry }: { entry: LibraryEntry }) {
  const { token } = theme.useToken();
  const [state, setState] = useState<{ loading: boolean; text: string; error?: string }>({
    loading: true,
    text: "",
  });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, text: "" });
    invoke<{ content: string; size: number; is_binary: boolean }>("read_file_content", {
      path: entry.path,
    })
      .then((r) => {
        if (cancelled) return;
        if (r.is_binary) {
          setState({ loading: false, text: "", error: "这个文件按二进制读出来的，不是文本" });
        } else if (r.size > TEXT_LIMIT) {
          setState({
            loading: false,
            text: "",
            error: `文件 ${(r.size / 1024 / 1024).toFixed(1)} MB，太大了，建议用默认应用打开`,
          });
        } else {
          setState({ loading: false, text: r.content });
        }
      })
      .catch((e) => {
        if (!cancelled) setState({ loading: false, text: "", error: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [entry.path]);

  if (state.loading) {
    return (
      <div style={{ padding: 48, textAlign: "center" }}>
        <Spin />
      </div>
    );
  }
  if (state.error) {
    return (
      <div style={{ padding: 24 }}>
        <Result status="warning" title="读不了这个文件" subTitle={state.error} />
      </div>
    );
  }
  return (
    <pre
      style={{
        height: "100%",
        overflow: "auto",
        margin: 0,
        padding: 16,
        fontSize: 13,
        lineHeight: 1.7,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: token.colorText,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      }}
    >
      {state.text}
    </pre>
  );
}
