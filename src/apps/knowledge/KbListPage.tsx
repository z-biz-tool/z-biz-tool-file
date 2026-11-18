// 知识库列表页：卡片墙（打开 / 重命名 / 删除）+ 新建。
import { useEffect, useState } from "react";
import {
  App as AntdApp,
  Button,
  Card,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Typography,
} from "antd";
import {
  BulbOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { kbBaseCreate, kbBaseDelete, kbBaseList, kbBaseRename, type KbSummary } from "./api";
import { formatTime } from "./tree";

const { Text, Title } = Typography;

export default function KbListPage({
  onOpen,
}: {
  onOpen: (kb: KbSummary) => void;
}) {
  const { message: msgApi, modal } = AntdApp.useApp();
  const [bases, setBases] = useState<KbSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<KbSummary | null>(null);
  const [createForm] = Form.useForm<{ name: string; description?: string }>();
  const [renameForm] = Form.useForm<{ name: string; description?: string }>();

  async function refresh() {
    setLoading(true);
    try {
      setBases(await kbBaseList());
    } catch (e) {
      msgApi.error(`加载知识库列表失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(values: { name: string; description?: string }) {
    try {
      const created = await kbBaseCreate(values);
      msgApi.success(`知识库「${created.name}」已创建`);
      setCreateOpen(false);
      createForm.resetFields();
      await refresh();
    } catch (e) {
      msgApi.error(`${e}`);
    }
  }

  async function handleRename(kb: KbSummary) {
    renameForm.setFieldsValue({ name: kb.name, description: kb.description ?? "" });
    setRenameTarget(kb);
  }

  async function submitRename(values: { name: string; description?: string }) {
    if (!renameTarget) return;
    try {
      await kbBaseRename(renameTarget.id, values.name.trim(), values.description);
      msgApi.success("已重命名");
      setRenameTarget(null);
      await refresh();
    } catch (e) {
      msgApi.error(`${e}`);
    }
  }

  function handleDelete(kb: KbSummary) {
    modal.confirm({
      title: `删除知识库「${kb.name}」？`,
      content: `将删除其中的 ${kb.material_count} 条资料（含已拷入的原件与解析稿）。源文件不受影响。`,
      okText: "删除",
      okButtonProps: { danger: true },
      autoFocusButton: "cancel",
      onOk: async () => {
        try {
          await kbBaseDelete(kb.id);
          msgApi.success("知识库已删除");
          await refresh();
        } catch (e) {
          // 注意：这里**不能** return Promise.reject() —— antd v6 会把 onOk 的
          // 拒绝重新抛出，变成未处理的 Promise 拒绝（曾经把整个窗口糊成错误页）。
          msgApi.error(`${e}`);
        }
      },
    });
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px 8px",
          flexShrink: 0,
        }}
      >
        <div>
          <Title level={4} style={{ margin: 0 }}>
            <BulbOutlined style={{ marginRight: 8, color: "var(--ant-color-primary)" }} />
            知识库
          </Title>
          <Text type="secondary">本地知识中枢：导入资料、解析成稿、检索问答</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} aria-label="刷新知识库列表" onClick={() => void refresh()} />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            新建知识库
          </Button>
        </Space>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 20px 20px" }}>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", paddingTop: 80 }}>
            <Spin />
          </div>
        ) : bases.length === 0 ? (
          <Empty
            style={{ paddingTop: 80 }}
            description={
              <>
                还没有知识库
                <br />
                <Text type="secondary">建一个，把本地的文件、语雀文档都收进来</Text>
              </>
            }
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建知识库
            </Button>
          </Empty>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 12,
              paddingTop: 8,
            }}
          >
            {bases.map((kb) => (
              <Card
                key={kb.id}
                size="small"
                hoverable
                onClick={() => onOpen(kb)}
                styles={{ body: { padding: "12px 14px" } }}
                title={
                  <span style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                    <BulbOutlined style={{ color: "var(--ant-color-primary)", flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {kb.name}
                    </span>
                  </span>
                }
                extra={
                  <span onClick={(e) => e.stopPropagation()}>
                    <Dropdown
                      trigger={["click"]}
                      menu={{
                        items: [
                          { key: "rename", icon: <EditOutlined />, label: "重命名" },
                          { key: "delete", icon: <DeleteOutlined />, label: "删除", danger: true },
                        ],
                        onClick: ({ key }) => {
                          if (key === "rename") handleRename(kb);
                          if (key === "delete") handleDelete(kb);
                        },
                      }}
                    >
                      <Button type="text" size="small" icon={<MoreOutlined />} aria-label="知识库更多操作" />
                    </Dropdown>
                  </span>
                }
              >
                <div style={{ minHeight: 36 }}>
                  {kb.description ? (
                    <Text
                      type="secondary"
                      style={{
                        fontSize: 12,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {kb.description}
                    </Text>
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      （无描述）
                    </Text>
                  )}
                </div>
                <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between" }}>
                  <Space size={4} wrap={false}>
                    <FolderOpenOutlined style={{ color: "var(--ant-color-text-tertiary)" }} />
                    <Text style={{ fontSize: 12 }}>
                      {kb.material_count} 资料 · {kb.parsed_count} 已解析
                    </Text>
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {formatTime(kb.created_at)}
                  </Text>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Modal
        title="新建知识库"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        okText="创建"
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入知识库名称" }, { max: 100 }]}
          >
            <Input placeholder="例如：产品资料库" autoFocus />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea placeholder="这个库用来收什么（可选）" autoSize />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="重命名知识库"
        open={renameTarget !== null}
        onCancel={() => setRenameTarget(null)}
        onOk={() => renameForm.submit()}
        okText="保存"
        destroyOnHidden
      >
        <Form form={renameForm} layout="vertical" onFinish={submitRename}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入知识库名称" }, { max: 100 }]}
          >
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea autoSize />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
