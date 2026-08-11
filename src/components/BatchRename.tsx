import { useState, useMemo } from "react";
import {
  Modal,
  Input,
  Table,
  Segmented,
  Checkbox,
  InputNumber,
  Space,
  Typography,
  message,
} from "antd";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../stores/fileStore";

interface Props {
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
  files: FileEntry[];
}

type RenameMode = "find_replace" | "prefix_suffix" | "auto_number";

const MODE_OPTIONS: { label: string; value: RenameMode }[] = [
  { label: "查找替换", value: "find_replace" },
  { label: "前缀后缀", value: "prefix_suffix" },
  { label: "自动编号", value: "auto_number" },
];

/** 将文件名拆分为名称部分和扩展名部分 */
function splitFileName(fileName: string): [string, string] {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return [fileName, ""];
  return [fileName.slice(0, dotIndex), fileName.slice(dotIndex)];
}

/** 根据模式计算新文件名 */
function computeNewName(
  original: string,
  mode: RenameMode,
  findText: string,
  replaceText: string,
  caseSensitive: boolean,
  prefix: string,
  suffix: string,
  startNumber: number,
  step: number,
  digits: number,
  index: number
): string {
  const [name, ext] = splitFileName(original);

  switch (mode) {
    case "find_replace": {
      if (!findText) return original;
      const flags = caseSensitive ? "g" : "gi";
      try {
        const regex = new RegExp(escapeRegExp(findText), flags);
        return name.replace(regex, replaceText) + ext;
      } catch {
        return original;
      }
    }
    case "prefix_suffix": {
      return prefix + name + suffix + ext;
    }
    case "auto_number": {
      const num = startNumber + index * step;
      const numStr = String(num).padStart(digits, "0");
      return name + numStr + ext;
    }
    default:
      return original;
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function BatchRename({ open, onClose, onRefresh, files }: Props) {
  const [mode, setMode] = useState<RenameMode>("find_replace");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [startNumber, setStartNumber] = useState(1);
  const [step, setStep] = useState(1);
  const [digits, setDigits] = useState(2);
  const [loading, setLoading] = useState(false);

  const previewData = useMemo(() => {
    return files.map((file, index) => {
      const newName = computeNewName(
        file.name,
        mode,
        findText,
        replaceText,
        caseSensitive,
        prefix,
        suffix,
        startNumber,
        step,
        digits,
        index
      );
      return {
        key: file.path,
        original: file.name,
        renamed: newName,
        changed: newName !== file.name,
      };
    });
  }, [files, mode, findText, replaceText, caseSensitive, prefix, suffix, startNumber, step, digits]);

  const hasChanges = previewData.some((item) => item.changed);

  const handleOk = async () => {
    if (!hasChanges) {
      message.warning("没有需要重命名的文件");
      return;
    }
    setLoading(true);
    try {
      await invoke("batch_rename", {
        paths: files.map((f) => f.path),
        mode,
        findText,
        replaceText,
        prefix,
        suffix,
        startNumber,
        step,
        digits,
      });
      message.success("批量重命名成功");
      onRefresh();
      onClose();
    } catch (err) {
      message.error("批量重命名失败: " + err);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: "原文件名",
      dataIndex: "original",
      key: "original",
      ellipsis: true,
    },
    {
      title: "新文件名",
      dataIndex: "renamed",
      key: "renamed",
      ellipsis: true,
      render: (text: string, record: (typeof previewData)[number]) =>
        record.changed ? (
          <Typography.Text type="success">{text}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">{text}</Typography.Text>
        ),
    },
  ];

  const renderModeContent = () => {
    switch (mode) {
      case "find_replace":
        return (
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>查找</div>
              <Input
                value={findText}
                onChange={(e) => setFindText(e.target.value)}
                placeholder="输入要查找的文本"
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>替换为</div>
              <Input
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                placeholder="输入替换后的文本"
              />
            </div>
            <Checkbox
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            >
              区分大小写
            </Checkbox>
          </Space>
        );
      case "prefix_suffix":
        return (
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>前缀</div>
              <Input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="添加到文件名前（保留扩展名）"
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>后缀</div>
              <Input
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
                placeholder="添加到扩展名前"
              />
            </div>
          </Space>
        );
      case "auto_number":
        return (
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <div style={{ display: "flex", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ marginBottom: 4, fontWeight: 500 }}>起始编号</div>
                <InputNumber
                  min={0}
                  value={startNumber}
                  onChange={(v) => setStartNumber(v ?? 1)}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ marginBottom: 4, fontWeight: 500 }}>步长</div>
                <InputNumber
                  min={1}
                  value={step}
                  onChange={(v) => setStep(v ?? 1)}
                  style={{ width: "100%" }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ marginBottom: 4, fontWeight: 500 }}>位数</div>
                <InputNumber
                  min={1}
                  max={10}
                  value={digits}
                  onChange={(v) => setDigits(v ?? 2)}
                  style={{ width: "100%" }}
                />
              </div>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              编号将插入到文件名末尾、扩展名之前，不足位数用 0 补齐。例如：文件{startNumber.toString().padStart(digits, "0")}.txt
            </Typography.Text>
          </Space>
        );
    }
  };

  return (
    <Modal
      title="批量重命名"
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      okText="应用重命名"
      cancelText="取消"
      confirmLoading={loading}
      okButtonProps={{ disabled: !hasChanges }}
      width={700}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Segmented
          options={MODE_OPTIONS}
          value={mode}
          onChange={(v) => setMode(v as RenameMode)}
        />

        {renderModeContent()}

        <div>
          <Typography.Text
            type="secondary"
            style={{ marginBottom: 8, display: "block" }}
          >
            预览（共 {files.length} 个文件，{previewData.filter((d) => d.changed).length} 个将变更）
          </Typography.Text>
          <Table
            columns={columns}
            dataSource={previewData}
            pagination={false}
            size="small"
            scroll={{ y: 280 }}
          />
        </div>
      </Space>
    </Modal>
  );
}
