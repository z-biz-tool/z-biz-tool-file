import { useState, useEffect } from "react";
import { Modal, Input, Select, Button, message, theme } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { writeFile } from "@tauri-apps/plugin-fs";

interface Props {
  open: boolean;
  onClose: () => void;
  currentPath: string;
  onRefresh: () => void;
}

interface TemplateOption {
  label: string;
  value: string;
  ext: string;
  content: string;
}

const TEMPLATES: TemplateOption[] = [
  {
    label: "空白文件",
    value: "empty",
    ext: "",
    content: "",
  },
  {
    label: "文本文件 (.txt)",
    value: "txt",
    ext: ".txt",
    content: "",
  },
  {
    label: "Markdown (.md)",
    value: "md",
    ext: ".md",
    content: "# Title\n",
  },
  {
    label: "HTML (.html)",
    value: "html",
    ext: ".html",
    content:
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Document</title>\n</head>\n<body>\n\n</body>\n</html>\n',
  },
  {
    label: "Python (.py)",
    value: "py",
    ext: ".py",
    content: '#!/usr/bin/env python3\n\n\ndef main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n',
  },
  {
    label: "JavaScript (.js)",
    value: "js",
    ext: ".js",
    content: '// JavaScript file\n\nfunction main() {\n  \n}\n\nmain();\n',
  },
  {
    label: "JSON (.json)",
    value: "json",
    ext: ".json",
    content: "{\n  \n}\n",
  },
  {
    label: "Shell脚本 (.sh)",
    value: "sh",
    ext: ".sh",
    content: "#!/bin/bash\n\n",
  },
  {
    label: "CSS (.css)",
    value: "css",
    ext: ".css",
    content: "/* Stylesheet */\n\n",
  },
  {
    label: "自定义",
    value: "custom",
    ext: "",
    content: "",
  },
];

export default function NewFileTemplate({
  open,
  onClose,
  currentPath,
  onRefresh,
}: Props) {
  const { token } = theme.useToken();

  const [fileName, setFileName] = useState("");
  const [templateKey, setTemplateKey] = useState("empty");
  const [customContent, setCustomContent] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setFileName("");
      setTemplateKey("empty");
      setCustomContent("");
    }
  }, [open]);

  const selectedTemplate = TEMPLATES.find((t) => t.value === templateKey)!;

  const previewContent =
    templateKey === "custom" ? customContent : selectedTemplate.content;

  const handleFileNameChange = (value: string) => {
    setFileName(value);
  };

  const handleTemplateChange = (value: string) => {
    setTemplateKey(value);
  };

  const handleCreate = async () => {
    const trimmedName = fileName.trim();
    if (!trimmedName) {
      message.warning("请输入文件名");
      return;
    }

    let finalName = trimmedName;
    // Auto-append extension if user didn't type one and template has an extension
    if (
      selectedTemplate.ext &&
      !finalName.endsWith(selectedTemplate.ext) &&
      templateKey !== "custom" &&
      templateKey !== "empty"
    ) {
      finalName = finalName + selectedTemplate.ext;
    }

    const fullPath = currentPath
      ? `${currentPath}/${finalName}`
      : finalName;

    setCreating(true);
    try {
      await invoke("create_file", { path: fullPath });
      const content = templateKey === "custom" ? customContent : selectedTemplate.content;
      if (content) {
        const encoder = new TextEncoder();
        await writeFile(fullPath, encoder.encode(content));
      }
      message.success(`文件 ${finalName} 创建成功`);
      onRefresh();
      onClose();
    } catch (err) {
      message.error("创建文件失败: " + err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      title="新建文件"
      open={open}
      onCancel={onClose}
      width={500}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="create"
          type="primary"
          loading={creating}
          onClick={handleCreate}
        >
          创建
        </Button>,
      ]}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: token.marginMD }}>
        <div>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>文件名</div>
          <Input
            value={fileName}
            onChange={(e) => handleFileNameChange(e.target.value)}
            placeholder="输入文件名"
            onPressEnter={handleCreate}
          />
        </div>

        <div>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>文件模板</div>
          <Select
            style={{ width: "100%" }}
            value={templateKey}
            onChange={handleTemplateChange}
            options={TEMPLATES.map((t) => ({
              label: t.label,
              value: t.value,
            }))}
          />
        </div>

        {templateKey === "custom" && (
          <div>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>自定义内容</div>
            <Input.TextArea
              value={customContent}
              onChange={(e) => setCustomContent(e.target.value)}
              rows={6}
              placeholder="输入文件内容"
            />
          </div>
        )}

        {previewContent && templateKey !== "custom" && (
          <div>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>模板预览</div>
            <Input.TextArea
              value={previewContent}
              readOnly
              rows={8}
              style={{
                fontFamily: "monospace",
                fontSize: 12,
                backgroundColor: token.colorBgLayout,
              }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
