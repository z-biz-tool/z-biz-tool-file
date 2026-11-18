// 条目详情：头部（图标/标题/类型与状态徽标 + 动作）+ 页签（解析稿 / 基本信息）。
// 解析稿支持 MDEditor 编辑回存（parser_name 标记 manual-edit），只读态走
// MDEditor.Markdown 渲染 —— 与 worker 板块的 DocumentsView 同一组件。
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Descriptions,
  Empty,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import MDEditor from "@uiw/react-md-editor";
import {
  EditOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import {
  kbDraftSave,
  kbMaterialDetail,
  kbOpenOriginal,
  kbParse,
  kbRevealOriginal,
  type MaterialDetail as MaterialDetailData,
} from "./api";
import {
  deriveEntryState,
  deriveEntryType,
  ENTRY_STATE_META,
  ENTRY_TYPE_META,
  formatSize,
  formatTime,
  parserLabel,
  SOURCE_TYPE_LABEL,
} from "./tree";

const { Text, Title } = Typography;

export default function MaterialDetail({
  materialId,
  onChanged,
}: {
  materialId: string;
  onChanged: () => void;
}) {
  const { message: msgApi } = AntdApp.useApp();
  const [detail, setDetail] = useState<MaterialDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [parseBusy, setParseBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await kbMaterialDetail(materialId);
      setDetail(next);
      setDraft(next.draft ?? "");
    } catch (e) {
      msgApi.error(`加载详情失败: ${e}`);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 解析中：跟随轮询刷新状态（父层也在轮询，这里只转详情）
  const parsing = detail?.parse_status === "parsing";
  useEffect(() => {
    if (!parsing) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [parsing, load]);

  if (loading || !detail) {
    return (
      <div style={{ display: "flex", justifyContent: "center", paddingTop: 80 }}>
        <Spin />
      </div>
    );
  }

  const typeMeta = ENTRY_TYPE_META[deriveEntryType(detail)];
  const stateMeta = ENTRY_STATE_META[deriveEntryState(detail.parse_status)];
  const isYuque = detail.source_type === "yuque";

  async function handleParse() {
    setParseBusy(true);
    try {
      await kbParse(detail!.id);
      msgApi.success("解析任务已提交");
      onChanged();
      await load();
    } catch (e) {
      msgApi.error(`${e}`);
    } finally {
      setParseBusy(false);
    }
  }

  async function handleSaveDraft() {
    setSaving(true);
    try {
      await kbDraftSave(detail!.id, draft);
      msgApi.success("解析稿已保存");
      setEditing(false);
      await load();
      onChanged();
    } catch (e) {
      msgApi.error(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleOriginal(action: "open" | "reveal") {
    try {
      if (action === "open") await kbOpenOriginal(detail!.id);
      else await kbRevealOriginal(detail!.id);
    } catch (e) {
      msgApi.error(`${e}`);
    }
  }

  const parseActions = (
    <Space size={4} wrap>
      <Tooltip title={detail.parse_status === "parsed" ? "重新解析（覆盖当前解析稿）" : "解析"}>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={parseBusy || parsing}
          onClick={() => void handleParse()}
        >
          {detail.parse_status === "parsed" ? "重新解析" : "解析"}
        </Button>
      </Tooltip>
      {detail.original_path && !isYuque ? (
        <>
          <Tooltip title="用系统默认程序打开原件副本">
            <Button size="small" icon={<ExportOutlined />} onClick={() => void handleOriginal("open")}>
              打开原件
            </Button>
          </Tooltip>
          <Tooltip title="在文件夹中定位原件副本">
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              aria-label="在文件夹中定位原件副本"
              onClick={() => void handleOriginal("reveal")}
            />
          </Tooltip>
        </>
      ) : null}
      {isYuque && detail.yuque ? (
        <Tooltip title={detail.yuque.url}>
          <Button
            size="small"
            icon={<LinkOutlined />}
            onClick={() => {
              void navigator.clipboard
                .writeText(detail.yuque!.url)
                .then(() => msgApi.success("语雀原文链接已复制"));
            }}
          >
            复制原文链接
          </Button>
        </Tooltip>
      ) : null}
    </Space>
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 16px 0",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Title level={5} style={{ margin: 0, minWidth: 0, flex: 1 }}>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "inline-block",
                maxWidth: "100%",
                verticalAlign: "middle",
              }}
            >
              {detail.title}
            </span>
          </Title>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Tag>{typeMeta.label}</Tag>
          <Tag color={stateMeta.color === "default" ? undefined : stateMeta.color}>
            {stateMeta.label}
          </Tag>
          <Tag color={SOURCE_TYPE_LABEL[detail.source_type] ? "blue" : undefined}>
            {SOURCE_TYPE_LABEL[detail.source_type] || detail.source_type}
          </Tag>
          {detail.category_path.length > 0 ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {detail.category_path.join(" / ")}
            </Text>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              未分类
            </Text>
          )}
          <div style={{ flex: 1 }} />
          {parseActions}
        </div>
        {detail.parse_error ? (
          <Alert
            type={detail.parse_status === "failed" ? "error" : "warning"}
            showIcon
            message={detail.parse_error}
            style={{ marginTop: 2 }}
          />
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: "8px 16px 12px" }}>
        <Tabs
          style={{ height: "100%" }}
          defaultActiveKey="draft"
          items={[
            {
              key: "draft",
              label: "解析稿",
              children: (
                <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      解析器 {parserLabel(detail.parser_name)} ·{" "}
                      {formatTime(detail.parsed_at)} · {(detail.draft ?? "").length} 字符
                    </Text>
                    <div style={{ flex: 1 }} />
                    {editing ? (
                      <>
                        <Button size="small" onClick={() => {
                          setEditing(false);
                          setDraft(detail.draft ?? "");
                        }}>
                          取消
                        </Button>
                        <Button
                          size="small"
                          type="primary"
                          icon={<SaveOutlined />}
                          loading={saving}
                          onClick={() => void handleSaveDraft()}
                        >
                          保存
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => {
                          setDraft(detail.draft ?? "");
                          setEditing(true);
                        }}
                        disabled={detail.parse_status === "pending" || parsing}
                      >
                        编辑
                      </Button>
                    )}
                  </div>
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflowY: "auto",
                      border: "1px solid var(--ant-color-border-secondary)",
                      borderRadius: 8,
                      padding: editing ? 0 : "12px 16px",
                    }}
                  >
                    {detail.parse_status === "parsing" ? (
                      <div style={{ display: "flex", justifyContent: "center", paddingTop: 80 }}>
                        <Spin tip="解析中，完成后自动刷新" />
                      </div>
                    ) : detail.parse_status === "pending" && !detail.draft ? (
                      <Empty
                        style={{ paddingTop: 80 }}
                        description="尚未解析"
                      >
                        <Button type="primary" icon={<ReloadOutlined />} onClick={() => void handleParse()}>
                          立即解析
                        </Button>
                      </Empty>
                    ) : editing ? (
                      <div data-color-mode="light">
                        <MDEditor
                          value={draft}
                          onChange={(v) => setDraft(v ?? "")}
                          height="100%"
                          style={{ minHeight: 320 }}
                          preview="edit"
                        />
                      </div>
                    ) : detail.draft ? (
                      <div data-color-mode="light">
                        <MDEditor.Markdown
                          source={detail.draft}
                          style={{ background: "transparent" }}
                        />
                      </div>
                    ) : (
                      <Empty description="没有解析稿" style={{ paddingTop: 80 }} />
                    )}
                  </div>
                </div>
              ),
            },
            {
              key: "basic",
              label: "基本信息",
              children: (
                <div style={{ overflowY: "auto", height: "100%" }}>
                  <Descriptions
                    size="small"
                    column={2}
                    bordered
                    items={[
                      { key: "id", label: "条目 ID", children: <Text copyable style={{ fontSize: 12 }}>{detail.id}</Text> },
                      { key: "file", label: "文件名", children: detail.ext ? `*.${detail.ext}` : "—" },
                      { key: "type", label: "类型", children: typeMeta.label },
                      { key: "size", label: "大小", children: formatSize(detail.size_bytes) },
                      { key: "source", label: "来源", children: SOURCE_TYPE_LABEL[detail.source_type] || detail.source_type },
                      { key: "path", label: "所属路径", children: detail.category_path.join(" / ") || "未分类" },
                      { key: "reg", label: "登记时间", children: formatTime(detail.registered_at) },
                      { key: "parsed", label: "解析时间", children: formatTime(detail.parsed_at) },
                      { key: "parser", label: "解析器", children: parserLabel(detail.parser_name) },
                      { key: "ver", label: "版本", children: `v${detail.version_no}` },
                      {
                        key: "fp",
                        label: "指纹",
                        children: (
                          <Text copyable style={{ fontSize: 12 }} ellipsis>
                            {detail.fingerprint.slice(0, 16)}…
                          </Text>
                        ),
                      },
                      {
                        key: "orig",
                        label: "原件副本",
                        children: detail.original_path ? (
                          <Text style={{ fontSize: 12 }} copyable>
                            {detail.original_path}
                          </Text>
                        ) : (
                          "—"
                        ),
                      },
                    ]}
                  />
                  {detail.yuque ? (
                    <Descriptions
                      size="small"
                      column={1}
                      bordered
                      style={{ marginTop: 12 }}
                      items={[
                        { key: "ns", label: "语雀命名空间", children: detail.yuque.namespace },
                        { key: "slug", label: "语雀 slug", children: detail.yuque.slug },
                        { key: "url", label: "原文链接", children: <Text copyable style={{ fontSize: 12 }}>{detail.yuque.url}</Text> },
                      ]}
                    />
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
