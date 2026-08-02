import { useState, useEffect, useRef } from "react";
import { Empty, Spin, Typography } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useFileStore, getFileType, formatFileSize, formatTime } from "../stores/fileStore";
import EpubReader from "./EpubReader";

const { Text } = Typography;

export default function PreviewPane() {
  const { selectedFile } = useFileStore();
  const [loading, setLoading] = useState(false);
  const [textContent, setTextContent] = useState("");
  const [error, setError] = useState("");
  const [fileInfo, setFileInfo] = useState<any>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

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

    // 获取文件信息
    invoke("get_file_info", { path: selectedFile.path })
      .then((info) => setFileInfo(info))
      .catch(() => setFileInfo(null));

    if (fileType === "text") {
      setLoading(true);
      invoke("read_file_content", { path: selectedFile.path })
        .then((result: any) => {
          if (result.is_binary) {
            setError(result.content);
          } else {
            setTextContent(result.content);
          }
        })
        .catch((err) => setError("读取文件失败: " + err))
        .finally(() => setLoading(false));
    }
  }, [selectedFile]);

  if (!selectedFile) {
    return (
      <div className="preview-container">
        <Empty description="请选择一个文件" />
      </div>
    );
  }

  if (selectedFile.is_dir) {
    return (
      <div className="preview-container" style={{ flexDirection: "column", gap: 16 }}>
        <Empty description={selectedFile.name} />
        {fileInfo && (
          <div style={{ textAlign: "center" }}>
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

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* 文件信息栏 */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid #f0f0f0",
          background: "#fff",
          fontSize: 12,
          color: "#666",
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <Text strong style={{ fontSize: 13 }}>{selectedFile.name}</Text>
        {fileInfo && (
          <>
            <Text type="secondary">大小: {formatFileSize(fileInfo.size)}</Text>
            <Text type="secondary">修改: {formatTime(fileInfo.modified)}</Text>
            <Text type="secondary">路径: {fileInfo.path}</Text>
          </>
        )}
      </div>

      {/* 预览内容 */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {error && (
          <div className="preview-container">
            <Text type="secondary">{error}</Text>
          </div>
        )}

        {loading && (
          <div className="preview-container">
            <Spin tip="加载中..." />
          </div>
        )}

        {!error && !loading && fileType === "image" && (
          <div className="preview-container">
            <img src={fileUrl} alt={selectedFile.name} className="preview-image" />
          </div>
        )}

        {!error && !loading && fileType === "video" && (
          <div className="preview-container">
            <video src={fileUrl} controls className="preview-video" />
          </div>
        )}

        {!error && !loading && fileType === "audio" && (
          <div className="preview-container" style={{ flexDirection: "column", gap: 16 }}>
            <div style={{ fontSize: 48 }}>🎵</div>
            <Text strong>{selectedFile.name}</Text>
            <audio ref={audioRef} src={fileUrl} controls className="preview-audio" />
          </div>
        )}

        {!error && !loading && fileType === "text" && (
          <pre className="preview-text">{textContent}</pre>
        )}

        {!error && !loading && fileType === "epub" && (
          <EpubReader filePath={selectedFile.path} fileName={selectedFile.name} />
        )}

        {!error && !loading && fileType === "pdf" && (
          <div className="preview-container">
            <iframe src={fileUrl} style={{ width: "100%", height: "100%", border: "none" }} />
          </div>
        )}

        {!error && !loading && fileType === "other" && (
          <div className="preview-container">
            <Empty description="此文件类型不支持预览" />
          </div>
        )}
      </div>
    </div>
  );
}
