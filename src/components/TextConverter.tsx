import { useState } from "react";
import { Modal, Input, Radio, message, Typography, Space } from "antd";
import { SwapOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

interface Props {
  filePath: string;
  fileName: string;
  content: string;
  open: boolean;
  onClose: () => void;
}

interface ConvertResult {
  success: boolean;
  message: string;
  output_path: string;
}

export default function TextConverter({ fileName, content, open, onClose }: Props) {
  const [title, setTitle] = useState(fileName.replace(/\.\w+$/, ""));
  const [author, setAuthor] = useState("未知");
  const [format, setFormat] = useState<"epub" | "mobi" | "pdf">("epub");
  const [loading, setLoading] = useState(false);

  const handleConvert = async () => {
    if (!title.trim()) {
      message.warning("请输入标题");
      return;
    }
    setLoading(true);
    try {
      const ext = format;
      const defaultName = `${title}.${ext}`;
      const destPath = await save({
        defaultPath: defaultName,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!destPath) {
        setLoading(false);
        return;
      }

      let result: ConvertResult;
      if (format === "epub") {
        result = await invoke("text_to_epub", { title, author, content, destPath });
      } else if (format === "mobi") {
        result = await invoke("text_to_mobi", { title, author, content, destPath });
      } else {
        result = await invoke("text_to_pdf", { title, content, destPath });
      }

      if (result.success) {
        message.success(result.message);
      } else {
        message.error(result.message);
      }
      onClose();
    } catch (err) {
      message.error("转换失败: " + err);
    } finally {
      setLoading(false);
    }
  };

  const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;

  return (
    <Modal
      title={<Space><SwapOutlined />转换为其他格式</Space>}
      open={open}
      onOk={handleConvert}
      onCancel={onClose}
      okText="转换"
      confirmLoading={loading}
      width={520}
    >
      <div style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary">文件预览</Typography.Text>
        <div style={{
          background: "#f5f5f5", padding: 8, borderRadius: 4, marginTop: 4,
          maxHeight: 120, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap",
        }}>
          {preview}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ marginBottom: 4, fontWeight: 500 }}>标题</div>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="书名" />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ marginBottom: 4, fontWeight: 500 }}>作者</div>
        <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="作者" />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ marginBottom: 4, fontWeight: 500 }}>目标格式</div>
        <Radio.Group value={format} onChange={(e) => setFormat(e.target.value)}>
          <Radio value="epub">EPUB</Radio>
          <Radio value="mobi">MOBI</Radio>
          <Radio value="pdf">PDF</Radio>
        </Radio.Group>
      </div>

      {(format === "mobi" || format === "pdf") && (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          {format === "mobi"
            ? "MOBI格式将先生成EPUB，建议使用Calibre转换为MOBI。"
            : "PDF格式将先生成EPUB，建议使用Calibre转换为PDF。"}
        </Typography.Text>
      )}
    </Modal>
  );
}
