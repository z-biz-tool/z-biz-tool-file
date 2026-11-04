/**
 * 编辑书目信息。
 *
 * 字段与后端 EntryMetaPatch 一一对应。空串清空、不填不改 —— 但表单里没法区分
 * "没动过" 和 "清空了"，所以这里统一策略：**打开时把现值填进去，保存时整体提交**。
 * 用户看到什么就是什么，不需要猜"我只改了作者，出版社会不会被抹掉"。
 */
import { useEffect, useState } from "react";
import { Input, InputNumber, Modal, Rate, Select, Space, theme } from "antd";
import type { EntryMetaPatch, LibraryEntry } from "../libraryClient";

interface Props {
  open: boolean;
  entry: LibraryEntry | null;
  onCancel: () => void;
  onSubmit: (patch: EntryMetaPatch) => Promise<void> | void;
}

export default function BookMetaDialog({ open, entry, onCancel, onSubmit }: Props) {
  const { token } = theme.useToken();
  const [form, setForm] = useState({
    title: "",
    author: "",
    publisher: "",
    publishYear: undefined as number | undefined,
    series: "",
    seriesIndex: undefined as number | undefined,
    tags: [] as string[],
    rating: 0,
    description: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !entry) return;
    setForm({
      title: entry.title,
      author: entry.author ?? "",
      publisher: entry.publisher ?? "",
      publishYear: entry.publish_year ?? undefined,
      series: entry.series ?? "",
      seriesIndex: entry.series_index ?? undefined,
      tags: entry.tags ?? [],
      rating: entry.rating ?? 0,
      description: entry.description ?? "",
    });
  }, [open, entry]);

  const submit = async () => {
    setSaving(true);
    try {
      await onSubmit({
        title: form.title.trim(),
        author: form.author.trim(),
        publisher: form.publisher.trim(),
        publishYear: form.publishYear,
        series: form.series.trim(),
        seriesIndex: form.seriesIndex,
        tags: form.tags,
        rating: form.rating,
        description: form.description.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  const label = (t: string) => (
    <div style={{ fontSize: 12, color: token.colorTextSecondary, marginBottom: 4 }}>{t}</div>
  );

  return (
    <Modal
      title="编辑书目信息"
      open={open}
      onCancel={onCancel}
      onOk={submit}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      destroyOnHidden
      width={560}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size={10}>
        <div>
          {label("书名")}
          <Input
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            {label("作者")}
            <Input
              value={form.author}
              onChange={(e) => setForm((f) => ({ ...f, author: e.target.value }))}
              placeholder="多个作者用、分隔"
            />
          </div>
          <div style={{ flex: 1 }}>
            {label("出版社")}
            <Input
              value={form.publisher}
              onChange={(e) => setForm((f) => ({ ...f, publisher: e.target.value }))}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ width: 120 }}>
            {label("出版年份")}
            <InputNumber
              value={form.publishYear}
              onChange={(v) => setForm((f) => ({ ...f, publishYear: v ?? undefined }))}
              min={1000}
              max={2999}
              style={{ width: "100%" }}
              placeholder="2024"
            />
          </div>
          <div style={{ flex: 1 }}>
            {label("系列")}
            <Input
              value={form.series}
              onChange={(e) => setForm((f) => ({ ...f, series: e.target.value }))}
              placeholder="例如：三体"
            />
          </div>
          <div style={{ width: 90 }}>
            {label("卷号")}
            <InputNumber
              value={form.seriesIndex}
              onChange={(v) => setForm((f) => ({ ...f, seriesIndex: v ?? undefined }))}
              min={1}
              style={{ width: "100%" }}
            />
          </div>
        </div>
        <div>
          {label("标签")}
          <Select
            mode="tags"
            value={form.tags}
            onChange={(v) => setForm((f) => ({ ...f, tags: v }))}
            style={{ width: "100%" }}
            placeholder="回车创建标签"
            tokenSeparators={[",", "，"]}
          />
        </div>
        <div>
          {label("评分")}
          <Rate value={form.rating} onChange={(v) => setForm((f) => ({ ...f, rating: v }))} />
        </div>
        <div>
          {label("简介")}
          <Input.TextArea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            rows={3}
          />
        </div>
      </Space>
    </Modal>
  );
}
