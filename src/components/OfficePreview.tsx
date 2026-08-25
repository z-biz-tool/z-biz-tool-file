import { useEffect, useState, useCallback } from "react";
import { Alert, Button, Tooltip, App as AntdApp } from "antd";
import { FileOutlined, ReloadOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useTheme, LoadingState, ErrorState } from "../_shared";
import PdfViewer from "./PdfViewer";

interface Props {
  filePath: string;
  fileName: string;
}

interface ConvertResult {
  pdf_path: string;
  cache_hit: boolean;
  elapsed_ms: number;
}

interface OfficeStatus {
  installed: boolean;
  path: string | null;
}

/**
 * Office 文档预览：调 LibreOffice 转 PDF，再用 PdfViewer 渲染。
 * 缓存策略：基于源文件 path + mtime 的 hash，相同输入复用上次 PDF。
 */
export default function OfficePreview({ filePath, fileName }: Props) {
  const { mode } = useTheme();
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [status, setStatus] = useState<OfficeStatus | null>(null);

  const convert = useCallback(async () => {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      // 先检查 LibreOffice 是否安装
      const st = await invoke<OfficeStatus>("get_office_status");
      setStatus(st);
      if (!st.installed) {
        setLoading(false);
        return;
      }
      const r = await invoke<ConvertResult>("convert_office_to_pdf", { path: filePath });
      setResult(r);
      if (r.cache_hit) {
        message.success(`已复用缓存（上次转换）`, 1.2);
      } else {
        message.success(`转换完成（${(r.elapsed_ms / 1000).toFixed(1)}s）`, 1.5);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [filePath, message]);

  useEffect(() => {
    convert();
  }, [convert]);

  if (loading) return <LoadingState tip="LibreOffice 转换中..." minHeight={300} />;
  if (error) {
    return (
      <div style={{ padding: 16 }}>
        <ErrorState
          message="Office 文档转换失败"
          onRetry={convert}
        />
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12, fontSize: 12 }}
          message={error}
        />
      </div>
    );
  }
  if (status && !status.installed) {
    return (
      <div style={{ padding: 24 }}>
        <Alert
          type="info"
          showIcon
          message="未安装 LibreOffice"
          description={
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              <p>Office 文档预览依赖 <code>soffice</code> 命令行工具（来自 LibreOffice）。</p>
              <p>安装方式（任选其一）：</p>
              <ul style={{ marginBottom: 8 }}>
                <li><code>brew install --cask libreoffice</code>（推荐）</li>
                <li>到 <a href="https://www.libreoffice.org/download" target="_blank" rel="noreferrer">libreoffice.org</a> 下载 .dmg</li>
              </ul>
              <p style={{ color: "#888" }}>安装后重启本 app，会自动检测。</p>
            </div>
          }
        />
      </div>
    );
  }
  if (result) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            padding: "6px 12px",
            background: mode === "dark" ? "#1f1f1f" : "#fafafa",
            borderBottom: `1px solid ${mode === "dark" ? "#303030" : "#e8e8e8"}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: mode === "dark" ? "#999" : "#666",
            flexShrink: 0,
          }}
        >
          <FileOutlined />
          <span>由 LibreOffice 转换为 PDF 后预览</span>
          <span style={{ color: "#888" }}>·</span>
          <span>{fileName}</span>
          <div style={{ flex: 1 }} />
          <Tooltip title="重新转换（清缓存）">
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              onClick={convert}
            />
          </Tooltip>
          <Tooltip title="在 Finder 中显示原文件">
            <Button
              size="small"
              type="text"
              icon={<FolderOpenOutlined />}
              onClick={() => invoke("open_with_default_app", { path: filePath }).catch(() => {})}
            />
          </Tooltip>
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <PdfViewer filePath={result.pdf_path} fileName={fileName + " (via LibreOffice)"} />
        </div>
      </div>
    );
  }
  return null;
}
