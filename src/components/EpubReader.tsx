import { useState, useEffect } from "react";
import { Spin, Empty, Typography, Button, Space } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

const { Text } = Typography;

interface EpubReaderProps {
  filePath: string;
  fileName: string;
}

export default function EpubReader({ filePath, fileName }: EpubReaderProps) {
  const [loading, setLoading] = useState(true);
  const [textContent, setTextContent] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState<string[]>([]);

  useEffect(() => {
    setLoading(true);
    setError("");
    setTextContent("");
    setPages([]);
    setPage(0);

    // EPUB本质是ZIP文件，尝试通过read_file_content读取
    // 如果是二进制则提示无法预览
    invoke("read_file_content", { path: filePath })
      .then((result: any) => {
        if (result.is_binary) {
          // EPUB是二进制文件，无法直接解析为文本
          setError("EPUB是二进制格式（ZIP压缩包），当前版本支持简单文本提取。完整EPUB阅读器需要额外的解压库支持。");
        } else {
          // 如果意外是文本，直接显示
          const text = result.content;
          // 按段落分页
          const paragraphs = text.split(/\n\s*\n/).filter((p: string) => p.trim());
          if (paragraphs.length > 0) {
            setPages(paragraphs);
            setTextContent(paragraphs[0]);
          } else {
            setTextContent(text);
            setPages([text]);
          }
        }
      })
      .catch((err) => {
        setError("读取EPUB文件失败: " + err);
      })
      .finally(() => setLoading(false));
  }, [filePath]);

  const handlePrevPage = () => {
    if (page > 0) {
      setPage(page - 1);
      setTextContent(pages[page - 1]);
    }
  };

  const handleNextPage = () => {
    if (page < pages.length - 1) {
      setPage(page + 1);
      setTextContent(pages[page + 1]);
    }
  };

  if (loading) {
    return (
      <div className="preview-container">
        <Spin tip="加载EPUB..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="preview-container" style={{ flexDirection: "column", gap: 16, padding: 24 }}>
        <Empty description="EPUB预览" />
        <Text type="secondary" style={{ textAlign: "center", maxWidth: 600 }}>
          {error}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          文件: {fileName}
        </Text>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: 16 }}>
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        <Text strong style={{ fontSize: 16 }}>{fileName}</Text>
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "16px 24px",
          background: "#fff",
          borderRadius: 8,
          lineHeight: 1.8,
          fontSize: 15,
          whiteSpace: "pre-wrap",
        }}
      >
        {textContent}
      </div>
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 16, padding: "12px 0" }}>
        <Space>
          <Button
            icon={<LeftOutlined />}
            disabled={page === 0}
            onClick={handlePrevPage}
          >
            上一页
          </Button>
          <Text type="secondary">
            {page + 1} / {pages.length}
          </Text>
          <Button
            disabled={page >= pages.length - 1}
            onClick={handleNextPage}
          >
            下一页
            <RightOutlined />
          </Button>
        </Space>
      </div>
    </div>
  );
}
