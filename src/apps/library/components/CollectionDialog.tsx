/**
 * 新建 / 编辑图书集。
 *
 * 颜色是预设色块而不是取色器：图书集是"几本书的分类"，用户在这一步想的是
 * 「给我标成蓝的」，不是调一个 #4A90D9。预设 6 个，够区分又不会选择困难。
 */
import { useEffect, useState } from "react";
import { Input, Modal, Space, theme } from "antd";
import type { Collection } from "../libraryClient";

const PRESET_COLORS = ["#1677ff", "#389e0d", "#d4380d", "#d48806", "#531dab", "#08979c"];

interface Props {
  open: boolean;
  /** 传了就是编辑，没传就是新建 */
  collection?: Collection | null;
  onCancel: () => void;
  onSubmit: (values: { name: string; description?: string; color?: string }) => Promise<void> | void;
}

export default function CollectionDialog({ open, collection, onCancel, onSubmit }: Props) {
  const { token } = theme.useToken();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(PRESET_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 每次打开都要重置：编辑 A 之后打开 B，不能把 A 的表单值带过去
  useEffect(() => {
    if (!open) return;
    setName(collection?.name ?? "");
    setDescription(collection?.description ?? "");
    setColor(collection?.color ?? PRESET_COLORS[0]);
    setError("");
  }, [open, collection]);

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      setError("名称不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit({ name: n, description: description.trim() || undefined, color });
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={collection ? "编辑图书集" : "新建图书集"}
      open={open}
      onCancel={onCancel}
      onOk={submit}
      okText={collection ? "保存" : "创建"}
      cancelText="取消"
      confirmLoading={saving}
      destroyOnHidden
      width={420}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size={12}>
        <div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 4 }}>
            名称
          </div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：技术书、待读、某某全集"
            maxLength={40}
            autoFocus
            onPressEnter={submit}
          />
        </div>
        <div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 4 }}>
            说明（可选）
          </div>
          <Input.TextArea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={200}
            placeholder="这一摞是为什么放在一起的"
          />
        </div>
        <div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 6 }}>
            颜色
          </div>
          <Space size={8}>
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`选择颜色 ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 5,
                  background: c,
                  border:
                    color === c ? `2px solid ${token.colorText}` : `1px solid ${token.colorBorder}`,
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            ))}
          </Space>
        </div>
        {error && (
          <div style={{ color: token.colorError, fontSize: 12 }} role="alert">
            {error}
          </div>
        )}
      </Space>
    </Modal>
  );
}
