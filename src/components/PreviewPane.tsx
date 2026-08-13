import { useState, useEffect } from "react";
import { Typography, theme, Button } from "antd";
import { FileOutlined, EditOutlined, SwapOutlined, EyeOutlined, CodeOutlined } from "@ant-design/icons";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useFileStore, getFileType, formatFileSize, formatTime } from "../stores/fileStore";
import EpubReader from "./EpubReader";
import PdfViewer from "./PdfViewer";
import AudioPlayer from "./AudioPlayer";
import VideoPlayer from "./VideoPlayer";
import ImageEditor from "./ImageEditor";
import TextConverter from "./TextConverter";
import MarkdownPreview from "./MarkdownPreview";
import { EmptyState, LoadingState, ErrorState } from "../_shared";

const { Text } = Typography;

interface FileInfo {
  path: string;
  size: number;
  modified: number;
  is_dir: boolean;
}

interface ReadResult {
  is_binary: boolean;
  content: string;
}

export default function PreviewPane() {
  const { selectedFile } = useFileStore();
  const { token } = theme.useToken();
  const [loading, setLoading] = useState(false);
  const [textContent, setTextContent] = useState("");
  const [error, setError] = useState("");
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [editingImage, setEditingImage] = useState(false);
  const [showConverter, setShowConverter] = useState(false);
  const [mdPreviewMode, setMdPreviewMode] = useState(true); // true=预览, false=源码

  useEffect(() => {
    if (!selectedFile || selectedFile.is_dir) {
      setTextContent("");
      setError("");
      setFileInfo(null);
      return;
    }

    const fileType = getFileType(selectedFile.name);
    setError("");
    setTextContent("");
    setMdPreviewMode(true);

    // 获取文件信息
    invoke("get_file_info", { path: selectedFile.path })
      .then((info) => setFileInfo(info as FileInfo))
      .catch(() => setFileInfo(null));

    if (fileType === "text" || fileType === "markdown") {
      setLoading(true);
      invoke("read_file_content", { path: selectedFile.path })
        .then((result: unknown) => {
          const r = result as ReadResult;
          if (r.is_binary) {
            setError(r.content);
          } else {
            setTextContent(r.content);
          }
        })
        .catch((err) => setError("读取文件失败: " + err))
        .finally(() => setLoading(false));
    }
  }, [selectedFile]);

  if (!selectedFile) {
    return (
      <EmptyState
        title="请选择一个文件"
        description="从文件列表或文件树中选择文件以预览"
        icon={<FileOutlined style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }} />}
      />
    );
  }

  if (selectedFile.is_dir) {
    return (
      <div style={{ height: "100%", overflow: "auto", padding: 16 }}>
        <EmptyState
          title={selectedFile.name}
          description="这是一个文件夹"
          icon={<FileOutlined style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }} />}
        />
        {fileInfo && (
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <Text type="secondary">路径: {fileInfo.path}</Text>
            <br />
            <Text type="secondary">修改时间: {formatTime(fileInfo.modified)}</Text>
          </div>
        )}
      </div>
    );
  }

  const fileType = getFileType(selectedFile.name);
  const fileUrl = convertFileSrc(selectedFile.path);

  // 图片编辑模式
  if (editingImage && fileType === "image") {
    return (
      <ImageEditor
        filePath={selectedFile.path}
        fileName={selectedFile.name}
        onBack={() => setEditingImage(false)}
      />
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* 文件信息栏 */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          fontSize: 12,
          color: token.colorTextSecondary,
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Text strong style={{ fontSize: 13 }}>
          {selectedFile.name}
        </Text>
        {fileInfo && (
          <>
            <Text type="secondary">大小: {formatFileSize(fileInfo.size)}</Text>
            <Text type="secondary">修改: {formatTime(fileInfo.modified)}</Text>
          </>
        )}
        <div style={{ flex: 1 }} />
        {/* Markdown 预览/源码切换 */}
        {fileType === "markdown" && (
          <Button
            size="small"
            type={mdPreviewMode ? "primary" : "text"}
            icon={mdPreviewMode ? <EyeOutlined /> : <CodeOutlined />}
            onClick={() => setMdPreviewMode(!mdPreviewMode)}
          >
            {mdPreviewMode ? "预览" : "源码"}
          </Button>
        )}
      </div>

      {/* 预览内容 */}
      <div style={{ flex: 1, overflow: "auto", background: token.colorBgLayout }}>
        {loading && <LoadingState tip="加载文件中..." minHeight={300} />}

        {!loading && error && (
          <ErrorState
            message={error}
            onRetry={() => {
              setError("");
              setLoading(true);
              invoke("read_file_content", { path: selectedFile.path })
                .then((result: unknown) => {
                  const r = result as ReadResult;
                  if (r.is_binary) {
                    setError(r.content);
                  } else {
                    setTextContent(r.content);
                  }
                })
                .catch((err) => setError("读取文件失败: " + err))
                .finally(() => setLoading(false));
            }}
          />
        )}

        {!error && !loading && fileType === "image" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              position: "relative",
            }}
          >
            <img src={fileUrl} alt={selectedFile.name} className="preview-image" />
            <Button
              type="primary"
              icon={<EditOutlined />}
              onClick={() => setEditingImage(true)}
              style={{ position: "absolute", top: 12, right: 12 }}
            >
              编辑
            </Button>
          </div>
        )}

        {!error && !loading && fileType === "video" && (
          <VideoPlayer filePath={selectedFile.path} fileName={selectedFile.name} />
        )}

        {!error && !loading && fileType === "audio" && (
          <AudioPlayer filePath={selectedFile.path} fileName={selectedFile.name} />
        )}

        {!error && !loading && fileType === "markdown" && (
          <div style={{ position: "relative", height: "100%" }}>
            {mdPreviewMode ? (
              <MarkdownPreview content={textContent} />
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
        )}

        {!error && !loading && fileType === "text" && (
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
        )}

        {!error && !loading && (fileType === "epub" || fileType === "mobi") && (
          <EpubReader filePath={selectedFile.path} fileName={selectedFile.name} />
        )}

        {!error && !loading && fileType === "pdf" && (
          <PdfViewer filePath={selectedFile.path} fileName={selectedFile.name} />
        )}

        {!error && !loading && fileType === "doc" && (
          <EmptyState
            title="Office 文档预览"
            description="可右键选择「用默认应用打开」查看"
            icon={
              <FileOutlined style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }} />
            }
          />
        )}

        {!error && !loading && fileType === "other" && (
          <EmptyState
            title="暂不支持预览此格式"
            description={`文件类型: ${selectedFile.name.split(".").pop() || "未知"}`}
            icon={
              <FileOutlined style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }} />
            }
          />
        )}
      </div>

      {/* 文本转格式弹窗 */}
      {selectedFile && (fileType === "text" || fileType === "markdown") && (
        <TextConverter
          filePath={selectedFile.path}
          fileName={selectedFile.name}
          content={textContent}
          open={showConverter}
          onClose={() => setShowConverter(false)}
        />
      )}
    </div>
  );
}
