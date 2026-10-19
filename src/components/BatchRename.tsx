import { useState, useMemo } from "react";
import {
  Modal,
  Input,
  Table,
  Segmented,
  Checkbox,
  InputNumber,
  Space,
  Progress,
  Button,
  Typography,
  App as AntdApp,
} from "antd";
import type { FileEntry } from "../stores/fileStore";
import { computeNewName, type RenameMode, type RenameOptions } from "../utils/renameModel";
import { useOperation } from "../hooks/useOperation";
import { describeProgress } from "../utils/operationModel";

interface Props {
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
  files: FileEntry[];
}

const MODE_OPTIONS: { label: string; value: RenameMode }[] = [
  { label: "查找替换", value: "find_replace" },
  { label: "前缀后缀", value: "prefix_suffix" },
  { label: "自动编号", value: "auto_number" },
];

export default function BatchRename({ open, onClose, onRefresh, files }: Props) {
  const { message } = AntdApp.useApp();
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
  const operation = useOperation();

  const renameOptions: RenameOptions = useMemo(
    () => ({
      mode,
      findText,
      replaceText,
      caseSensitive,
      prefix,
      suffix,
      startNumber,
      step,
      digits,
    }),
    [mode, findText, replaceText, caseSensitive, prefix, suffix, startNumber, step, digits]
  );

  const previewData = useMemo(() => {
    return files.map((file, index) => {
      const newName = computeNewName(file.name, index, renameOptions);
      return {
        key: file.path,
        original: file.name,
        renamed: newName,
        changed: newName !== file.name,
      };
    });
  }, [files, renameOptions]);

  const hasChanges = previewData.some((item) => item.changed);

  const handleOk = async () => {
    if (!hasChanges) {
      message.warning("没有需要重命名的文件");
      return;
    }
    setLoading(true);
    operation.reset();
    const operationId = await operation.start(
      "rename",
      files.map((f) => f.path),
      {
        mode,
        findText,
        replaceText,
        prefix,
        suffix,
        startNumber,
        step,
        digits,
        caseSensitive,
      }
    );
    if (!operationId) {
      setLoading(false);
      message.error("批量重命名失败: " + (operation.error ?? "启动失败"));
      return;
    }
    // 命令立刻返回任务 id，真正的改名在后台跑；这里等进度事件收尾。
    // 不用「等 invoke 返回」——那是 fire-and-forget，用户看不到也停不下来。
    await new Promise<void>((resolve) => {
      const stop = setInterval(() => {
        if (!operation.running) {
          clearInterval(stop);
          resolve();
        }
      }, 120);
    });
    setLoading(false);
    if (operation.progress?.phase === "cancelled") {
      message.warning("批量重命名已取消");
    } else if (operation.progress?.phase === "error") {
      message.error("批量重命名失败: " + (operation.progress.message || "未知错误"));
    } else {
      message.success("批量重命名完成");
    }
    onRefresh();
    onClose();
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
      onCancel={operation.running ? () => void operation.cancel() : onClose}
      okText="应用重命名"
      cancelText={operation.running ? "停止" : "取消"}
      confirmLoading={loading}
      okButtonProps={{ disabled: !hasChanges || operation.running }}
      width={700}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Segmented
          options={MODE_OPTIONS}
          value={mode}
          onChange={(v) => setMode(v as RenameMode)}
        />

        {renderModeContent()}

        {/* 进行中的进度与取消入口：没有这一段，用户只能看着转圈等它跑完 */}
        {operation.running && operation.progress && (
          <div>
            <Progress
              percent={operation.progress.percent}
              status="active"
            />
            <Typography.Text type="secondary">
              {describeProgress(operation.progress)}
            </Typography.Text>
            <Button
              size="small"
              danger
              style={{ marginLeft: 12 }}
              onClick={() => void operation.cancel()}
            >
              停止
            </Button>
          </div>
        )}

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
