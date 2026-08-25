import { useEffect, useState } from "react";
import { Modal, Form, Input, Select, Button, App as AntdApp, Space } from "antd";
import { TagOutlined, DeleteOutlined } from "@ant-design/icons";
import { useFileStore } from "../stores/fileStore";

interface Props {
  open: boolean;
  onClose: () => void;
  filePath: string;
  fileName: string;
}

const COLORS = [
  { value: "", label: "无" },
  { value: "red", label: "红", color: "#f5222d" },
  { value: "orange", label: "橙", color: "#fa8c16" },
  { value: "yellow", label: "黄", color: "#fadb14" },
  { value: "green", label: "绿", color: "#52c41a" },
  { value: "blue", label: "蓝", color: "#1677ff" },
  { value: "purple", label: "紫", color: "#722ed1" },
  { value: "gray", label: "灰", color: "#8c8c8c" },
];

const COLOR_HEX: Record<string, string> = {
  red: "#f5222d",
  orange: "#fa8c16",
  yellow: "#fadb14",
  green: "#52c41a",
  blue: "#1677ff",
  purple: "#722ed1",
  gray: "#8c8c8c",
};

export function getTagColor(name: string): string | undefined {
  return COLOR_HEX[name];
}

export default function TagEditModal({ open, onClose, filePath, fileName }: Props) {
  const { message } = AntdApp.useApp();
  const tag = useFileStore((s) => s.tagsByPath[filePath]);
  const setTag = useFileStore((s) => s.setTag);
  const removeTag = useFileStore((s) => s.removeTag);
  const [color, setColor] = useState(tag?.color ?? "");
  const [label, setLabel] = useState(tag?.label ?? "");
  const [note, setNote] = useState(tag?.note ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setColor(tag?.color ?? "");
      setLabel(tag?.label ?? "");
      setNote(tag?.note ?? "");
    }
  }, [open, tag]);

  const onSave = async () => {
    setSaving(true);
    try {
      await setTag(filePath, { color, label, note });
      message.success("标签已保存");
      onClose();
    } catch (err) {
      message.error("保存失败: " + err);
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    try {
      await removeTag(filePath);
      message.success("已清除");
      onClose();
    } catch (err) {
      message.error("清除失败: " + err);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          {tag && (
            <Button danger icon={<DeleteOutlined />} onClick={onDelete}>
              清除标签
            </Button>
          )}
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={onSave} loading={saving}>
            保存
          </Button>
        </Space>
      }
      width={480}
      title={
        <Space>
          <TagOutlined />
          <span>标签 & 备注 — {fileName}</span>
        </Space>
      }
    >
      <Form layout="vertical">
        <Form.Item label="颜色">
          <Select
            value={color || undefined}
            onChange={(v) => setColor(v ?? "")}
            placeholder="选择颜色"
            style={{ width: "100%" }}
            options={COLORS.map((c) => ({
              value: c.value,
              label: c.value ? (
                <span>
                  <span
                    style={{
                      display: "inline-block",
                      width: 12,
                      height: 12,
                      borderRadius: 2,
                      background: c.color,
                      marginRight: 8,
                      verticalAlign: "middle",
                    }}
                  />
                  {c.label}
                </span>
              ) : (
                <span style={{ color: "#999" }}>无</span>
              ),
            }))}
          />
        </Form.Item>
        <Form.Item label="简短标签（显示在文件名旁边）">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="如：重要 / 待办 / 草稿"
            maxLength={20}
          />
        </Form.Item>
        <Form.Item label="备注（更详细的说明）">
          <Input.TextArea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="可选，详细备注"
            rows={3}
            maxLength={500}
            showCount
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
