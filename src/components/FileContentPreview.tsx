import { useState, useEffect, useCallback } from "react";
import { Empty, Tooltip, Button, Modal, Spin, App as AntdApp } from "antd";
import {
  CopyOutlined,
  SwapOutlined,
  EyeOutlined,
  CodeOutlined,
  CloseOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getFileType, formatFileSize, formatTime, type FileEntry } from "../stores/fileStore";
import { LoadingState, ErrorState, EmptyState } from "../_shared";
import EpubReader from "./EpubReader";
import PdfViewer from "./PdfViewer";
import AudioPlayer from "./AudioPlayer";
import VideoPlayer from "./VideoPlayer";
import ImageEditor from "./ImageEditor";
import MarkdownPreview from "./MarkdownPreview";
import CsvPreview from "./CsvPreview";
import JsonPreview from "./JsonPreview";
import YamlPreview from "./YamlPreview";
import TextConverter from "./TextConverter";

interface FileContentPreviewProps {
  file: FileEntry;
  /**
   * 是否渲染内置"基本信息 tab 头"（带"复制源码 / 转换"按钮等）。
   * - true (默认)：渲染带按钮的顶栏
   * - false：只渲染内容，外部容器自己加按钮
   */
  showTopbar?: boolean;
  /** Markdown 切换"预览/源码"按钮组（只对 md 文件生效） */
  enableMdToggle?: boolean;
  onCollapse?: () => void;
}

interface ReadResult {
  is_binary: boolean;
  content: string;
}

interface FileInfo {
  path: string;
  size: number;
  modified: number;
  is_dir: boolean;
}

/**
 * 文件内容预览的统一入口：按 fileType 分发到对应的专用组件。
 * 原来散落在 PreviewPane.tsx 里的"按类型分支"逻辑全部抽到这里。
 */
export default function FileContentPreview({
  file,
  showTopbar = true,
  enableMdToggle = false,
  onCollapse,
}: FileContentPreviewProps) {
  const { message: antdMessage } = AntdApp.useApp();
  const fileType = getFileType(file.name);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [textContent, setTextContent] = useState("");
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [editingImage, setEditingImage] = useState(false);
  const [showConverter, setShowConverter] = useState(false);
  const [mdPreviewMode, setMdPreviewMode] = useState(true);
  const [mdCopied, setMdCopied] = useState(false);
  // AI 摘要
  const [aiSummaryOpen, setAiSummaryOpen] = useState(false);
  const [aiSummary, setAiSummary] = useState("");
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [aiSummaryElapsed, setAiSummaryElapsed] = useState(0);

  // 加载文本内容 + 文件信息
  useEffect(() => {
    setError("");
    setTextContent("");
    setFileInfo(null);
    if (file.is_dir) {
      setLoading(false);
      return;
    }

    // 文件元信息
    invoke<FileInfo>("get_file_info", { path: file.path })
      .then((info) => setFileInfo(info))
      .catch(() => setFileInfo(null));

    if (fileType === "text" || fileType === "markdown") {
      setLoading(true);
      invoke<ReadResult>("read_file_content", { path: file.path })
        .then((r) => {
          if (r.is_binary) {
            setError(r.content);
          } else {
            setTextContent(r.content);
          }
        })
        .catch((err) => setError("读取文件失败: " + err))
        .finally(() => setLoading(false));
    }
  }, [file.path, file.is_dir, fileType]);

  const handleMdCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(textContent);
      setMdCopied(true);
      setTimeout(() => setMdCopied(false), 2000);
    } catch {
      /* clipboard 偶发被拒；可从源码模式手动复制 */
    }
  }, [textContent]);

  const handleAiSummary = useCallback(async () => {
    if (file.is_dir) {
      antdMessage.warning("目录不支持 AI 摘要");
      return;
    }
    setAiSummaryOpen(true);
    setAiSummary("");
    setAiSummaryLoading(true);
    setAiSummaryElapsed(0);
    try {
      const result = await invoke<{ summary: string; elapsed_ms: number }>(
        "ai_summarize_file",
        { path: file.path, customPrompt: null },
      );
      setAiSummary(result.summary);
      setAiSummaryElapsed(result.elapsed_ms);
    } catch (err) {
      setAiSummary(`❌ 摘要失败：${err}\n\n提示：到 设置 → AI/LLM 配置 填入 API Key。`);
    } finally {
      setAiSummaryLoading(false);
    }
  }, [file.path, file.is_dir, antdMessage]);

  // ——— 渲染分支 ———
  let body: React.ReactNode;

  if (loading) {
    body = <LoadingState tip="加载文件中..." minHeight={300} />;
  } else if (error) {
    body = <ErrorState message={error} onRetry={() => window.location.reload()} />;
  } else if (file.is_dir) {
    body = (
      <Empty
        description="文件夹不支持内容预览"
        style={{ marginTop: 60 }}
      />
    );
  } else {
    switch (fileType) {
      case "image": {
        if (editingImage) {
          body = (
            <ImageEditor
              filePath={file.path}
              fileName={file.name}
              onBack={() => setEditingImage(false)}
            />
          );
        } else {
          body = (
            <div style={{ position: "relative", height: "100%", background: "#000" }}>
              <img
                src={convertFileSrc(file.path)}
                alt={file.name}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                }}
              />
              <Button
                size="small"
                onClick={() => setEditingImage(true)}
                style={{ position: "absolute", top: 12, right: 12 }}
              >
                编辑
              </Button>
            </div>
          );
        }
        break;
      }
      case "video":
        body = <VideoPlayer filePath={file.path} fileName={file.name} />;
        break;
      case "audio":
        body = <AudioPlayer filePath={file.path} fileName={file.name} />;
        break;
      case "markdown":
        body = (
          <div style={{ position: "relative", height: "100%" }}>
            {mdPreviewMode ? (
              <MarkdownPreview content={textContent} showCopyButton={false} />
            ) : (
              <pre className="preview-text">{textContent}</pre>
            )}
            <Button
              icon={<SwapOutlined />}
              onClick={() => setShowConverter(true)}
              style={{ position: "absolute", top: 12, right: 12 }}
              size="small"
            >
              转换
            </Button>
          </div>
        );
        break;
      case "text": {
        const ext = file.name.split(".").pop()?.toLowerCase() || "";
        const isStructured = ["csv", "json", "yaml", "yml", "toml", "ini", "conf", "env"].includes(ext);
        if (isStructured) {
          if (ext === "csv") {
            body = <CsvPreview content={textContent} fileName={file.name} />;
          } else if (ext === "json") {
            body = <JsonPreview content={textContent} fileName={file.name} />;
          } else {
            const fmt = (["yaml", "yml"].includes(ext)
              ? "yaml"
              : ext === "toml"
              ? "toml"
              : ext === "env"
              ? "env"
              : "ini") as "yaml" | "toml" | "env" | "ini";
            body = <YamlPreview content={textContent} fileName={file.name} format={fmt} />;
          }
        } else {
          body = (
            <div style={{ position: "relative", height: "100%" }}>
              <pre className="preview-text">{textContent}</pre>
              <Button
                icon={<SwapOutlined />}
                onClick={() => setShowConverter(true)}
                style={{ position: "absolute", top: 12, right: 12 }}
              >
                转换格式
              </Button>
            </div>
          );
        }
        break;
      }
      case "epub":
      case "mobi":
        body = <EpubReader filePath={file.path} fileName={file.name} />;
        break;
      case "pdf":
        body = <PdfViewer filePath={file.path} fileName={file.name} />;
        break;
      case "doc":
        body = (
          <EmptyState
            title="Office 文档预览"
            description="需要 LibreOffice 或其他工具转换"
          />
        );
        break;
      default:
        body = (
          <EmptyState
            title="暂不支持预览"
            description={`文件类型 "${fileType}" 暂无专用预览`}
          />
        );
    }
  }

  // ——— 顶栏（可选） ———
  const topbar = !showTopbar ? null : (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--ant-color-border-secondary)",
        background: "var(--ant-color-bg-container)",
        fontSize: 12,
        color: "var(--ant-color-text-secondary)",
        display: "flex",
        gap: 16,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <span style={{ color: "var(--ant-color-text)", fontSize: 13, fontWeight: 600 }}>
        {file.name}
      </span>
      {fileInfo && (
        <>
          <span>大小: {formatFileSize(fileInfo.size)}</span>
          <span>修改: {formatTime(fileInfo.modified)}</span>
        </>
      )}
      <div style={{ flex: 1 }} />
      {onCollapse && (
        <Tooltip title="收起预览 (⌘+\\)">
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            onClick={onCollapse}
            aria-label="收起预览面板"
          />
        </Tooltip>
      )}
      {fileType === "markdown" && enableMdToggle && (
        <Button
          size="small"
          type={mdPreviewMode ? "primary" : "text"}
          icon={mdPreviewMode ? <EyeOutlined /> : <CodeOutlined />}
          onClick={() => setMdPreviewMode(!mdPreviewMode)}
        >
          {mdPreviewMode ? "预览" : "源码"}
        </Button>
      )}
      {fileType === "markdown" && (
        <Tooltip title={mdCopied ? "已复制" : "复制源码"}>
          <Button
            size="small"
            type={mdCopied ? "primary" : "text"}
            icon={<CopyOutlined />}
            onClick={handleMdCopy}
            aria-label="复制 Markdown 源码"
          />
        </Tooltip>
      )}
      {/* AI 摘要（仅非目录文件） */}
      {!file.is_dir && (
        <Tooltip title="AI 摘要（用 LLM 设置里的模型）">
          <Button
            size="small"
            type="text"
            icon={<RobotOutlined />}
            onClick={handleAiSummary}
            aria-label="AI 摘要"
          />
        </Tooltip>
      )}
    </div>
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {topbar}
      <div style={{ flex: 1, overflow: "auto", background: "var(--ant-color-bg-layout)" }}>
        {body}
      </div>
      <TextConverter
        open={showConverter}
        filePath={file.path}
        fileName={file.name}
        content={textContent}
        onClose={() => setShowConverter(false)}
      />
      <Modal
        open={aiSummaryOpen}
        onCancel={() => setAiSummaryOpen(false)}
        footer={null}
        width={600}
        title={
          <span>
            <RobotOutlined style={{ marginRight: 8 }} />
            AI 摘要 — {file.name}
          </span>
        }
      >
        {aiSummaryLoading ? (
          <div style={{ padding: "40px 0", textAlign: "center" }}>
            <Spin tip="正在调用 LLM..." />
          </div>
        ) : (
          <>
            <div
              style={{
                whiteSpace: "pre-wrap",
                lineHeight: 1.8,
                fontSize: 14,
                padding: "8px 0",
              }}
            >
              {aiSummary}
            </div>
            {aiSummaryElapsed > 0 && (
              <div
                style={{
                  marginTop: 12,
                  fontSize: 11,
                  color: "#888",
                  textAlign: "right",
                }}
              >
                耗时 {(aiSummaryElapsed / 1000).toFixed(1)}s
              </div>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
