import { useState, useEffect } from "react";
import { Button, InputNumber, Space, Tag, theme } from "antd";
import {
  ZoomInOutlined,
  ZoomOutOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  FileTextOutlined,
  PrinterOutlined,
} from "@ant-design/icons";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "@tauri-apps/api/core";
import { useTheme, LoadingState, ErrorState } from "../_shared";

interface Props {
  filePath: string;
  fileName: string;
}

interface PdfMeta {
  title: string;
  author: string;
  page_count: number;
  creator: string;
}

export default function PdfViewer({ filePath }: Props) {
  const { mode } = useTheme();
  const { token } = theme.useToken();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<PdfMeta | null>(null);
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [fallbackText, setFallbackText] = useState("");
  const [useIframe, setUseIframe] = useState(true);

  // PDF.js 浏览器内置 viewer 的 view 参数：FitH = 横向适配 iframe 宽度，
  // 这样无论预览区多宽，PDF 页面都会自动按比例占满，不再缩在一边。
  const fileUrl = `${convertFileSrc(filePath)}#view=FitH`;

  useEffect(() => {
    setLoading(true);
    setError("");
    invoke("get_pdf_metadata", { path: filePath })
      .then((result: unknown) => {
        setMeta(result as PdfMeta);
      })
      .catch(() => setMeta(null))
      .finally(() => setLoading(false));
  }, [filePath]);

  const zoomIn = () => setZoom((z) => Math.min(200, z + 25));
  const zoomOut = () => setZoom((z) => Math.max(50, z - 25));
  const rotateLeft = () => setRotation((r) => (r - 90 + 360) % 360);
  const rotateRight = () => setRotation((r) => (r + 90) % 360);

  const handleIframeError = () => {
    // iframe不支持PDF，回退到文本模式
    setUseIframe(false);
    invoke("extract_pdf_text", { path: filePath })
      .then((text: unknown) => {
        setFallbackText(text as string);
      })
      .catch((err) => setError("PDF文本提取失败: " + err));
  };

  const handlePrint = () => {
    window.open(fileUrl, "_blank");
  };

  if (loading) return <LoadingState tip="加载PDF中..." minHeight={300} />;
  if (error) return <ErrorState message={error} />;

  const isDark = mode === "dark";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* 工具栏 */}
      <div
        style={{
          padding: "6px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Space size={4}>
          <Button size="small" icon={<ZoomOutOutlined />} onClick={zoomOut} disabled={zoom <= 50} />
          <InputNumber
            size="small"
            value={zoom}
            onChange={(v) => v && setZoom(v)}
            min={50}
            max={200}
            step={25}
            formatter={(v) => `${v}%`}
            parser={(v) => Number(v?.replace("%", "")) || 100}
            style={{ width: 72 }}
          />
          <Button size="small" icon={<ZoomInOutlined />} onClick={zoomIn} disabled={zoom >= 200} />
        </Space>

        <Space size={4}>
          <Button size="small" icon={<RotateLeftOutlined />} onClick={rotateLeft} />
          <Button size="small" icon={<RotateRightOutlined />} onClick={rotateRight} />
        </Space>

        {meta && (
          <Space size={8}>
            {meta.title && <Tag color="blue">{meta.title}</Tag>}
            {meta.author && <Tag>{meta.author}</Tag>}
            <Tag color="green">{meta.page_count} 页</Tag>
          </Space>
        )}

        <div style={{ flex: 1 }} />

        <Button size="small" icon={<FileTextOutlined />} onClick={() => {
          if (useIframe) {
            setUseIframe(false);
            invoke("extract_pdf_text", { path: filePath })
              .then((text: unknown) => setFallbackText(text as string))
              .catch((err) => setError("PDF文本提取失败: " + err));
          } else {
            setUseIframe(true);
          }
        }}>
          {useIframe ? "文本模式" : "PDF模式"}
        </Button>
        <Button size="small" icon={<PrinterOutlined />} onClick={handlePrint} />
      </div>

      {/* PDF内容 */}
      <div style={{ flex: 1, overflow: "auto", background: isDark ? "#2a2a2a" : "#525659" }}>
        {useIframe ? (
          <iframe
            src={fileUrl}
            style={{
              width: `${zoom}%`,
              height: "100%",
              border: "none",
              transform: `rotate(${rotation}deg)`,
              transformOrigin: "center center",
            }}
            onError={handleIframeError}
          />
        ) : (
          <div
            style={{
              padding: 24,
              background: isDark ? "#1a1a1a" : "#fff",
              color: isDark ? "#d4d4d4" : "#333",
              lineHeight: 1.8,
              fontSize: 14,
              whiteSpace: "pre-wrap",
              fontFamily: "serif",
              maxWidth: 800,
              margin: "0 auto",
            }}
          >
            {fallbackText || "正在提取文本..."}
          </div>
        )}
      </div>
    </div>
  );
}
