// 本体实例层：某对象类型下的实例表格 + 实例编辑 + 详情（含关系实例管理）。
import { useEffect, useMemo, useState } from "react";
import {
  App as AntdApp,
  Button,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import {
  ontoInstanceDelete,
  ontoInstanceList,
  ontoInstanceSave,
  ontoLinkDelete,
  ontoLinkSave,
  ontoLinksOf,
  type OntEdge,
  type OntInstance,
  type OntLinkView,
  type OntType,
} from "../api";

const { Text } = Typography;

interface Props {
  type: OntType;
  types: OntType[];
  edges: OntEdge[];
  focusInstanceId?: string | null;
  onConsumedFocus?: () => void;
  onChanged?: () => void;
}

function propText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "是" : "否";
  return String(v);
}

export default function OntInstances({
  type,
  types,
  edges,
  focusInstanceId,
  onConsumedFocus,
  onChanged,
}: Props) {
  const { message: msgApi } = AntdApp.useApp();
  const [items, setItems] = useState<OntInstance[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<OntInstance | "new" | null>(null);
  const [detail, setDetail] = useState<OntInstance | null>(null);
  const [form] = Form.useForm();
  const pageSize = 50;

  async function reload(p = page, kw = keyword) {
    setLoading(true);
    try {
      const res = await ontoInstanceList(type.id, kw, p, pageSize);
      setItems(res.items);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setPage(0);
    setKeyword("");
    void reload(0, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type.id]);

  useEffect(() => {
    if (!focusInstanceId) return;
    onConsumedFocus?.();
    const found = items.find((i) => i.id === focusInstanceId);
    if (found) setDetail(found);
    else void ontoInstanceList(type.id, "", 0, 500).then((res) => {
      const hit = res.items.find((i) => i.id === focusInstanceId);
      if (hit) setDetail(hit);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusInstanceId]);

  function afterChange() {
    void reload();
    onChanged?.();
  }

  async function submitEditor() {
    const values = await form.validateFields();
    const name = (values.name as string || "").trim();
    if (!name) return;
    const properties: Record<string, unknown> = {};
    for (const p of type.properties) {
      const v = values[`p_${p.name}`];
      properties[p.name] = v === undefined ? null : v;
    }
    try {
      await ontoInstanceSave({
        id: editing === "new" ? null : (editing as OntInstance).id,
        typeId: type.id,
        name,
        properties,
      });
      setEditing(null);
      afterChange();
    } catch (e) {
      msgApi.error(`保存实例失败: ${e}`);
    }
  }

  const columns = useMemo(() => {
    const cols = [
      {
        title: "名称",
        dataIndex: "name",
        width: 220,
        render: (v: string, row: OntInstance) => (
          <a onClick={() => setDetail(row)}>{v}</a>
        ),
      },
      ...type.properties.map((p) => ({
        title: p.display_name || p.name,
        dataIndex: "properties",
        render: (_: unknown, row: OntInstance) => (
          <Text type={row.properties[p.name] == null ? "secondary" : undefined}>
            {propText(row.properties[p.name])}
          </Text>
        ),
      })),
      {
        title: "操作",
        key: "ops",
        width: 170,
        render: (_: unknown, row: OntInstance) => (
          <Space size={4}>
            <Button size="small" type="link" onClick={() => setDetail(row)}>
              详情
            </Button>
            <Button size="small" type="link" onClick={() => openEditor(row)}>
              编辑
            </Button>
            <Popconfirm
              title={`删除「${row.name}」？`}
              description="与它相关的关系实例会一并删除。"
              okText="删除"
              okButtonProps={{ danger: true }}
              onConfirm={async () => {
                try {
                  await ontoInstanceDelete(row.id);
                  afterChange();
                } catch (e) {
                  msgApi.error(`删除失败: ${e}`);
                }
              }}
            >
              <Button size="small" type="link" danger>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ];
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, items]);

  function openEditor(row?: OntInstance) {
    form.resetFields();
    const values: Record<string, unknown> = { name: row?.name ?? "" };
    for (const p of type.properties) {
      const v = row?.properties[p.name];
      if (p.data_type === "bool") values[`p_${p.name}`] = v === true;
      else values[`p_${p.name}`] = v ?? null;
    }
    form.setFieldsValue(values);
    setEditing(row ?? "new");
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <Text strong>{type.display_name || type.name}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {total} 实例
        </Text>
        <div style={{ flex: 1 }} />
        <Input.Search
          allowClear
          placeholder="按名称或属性过滤"
          style={{ width: 240 }}
          onSearch={(v) => {
            setPage(0);
            setKeyword(v.trim());
            void reload(0, v.trim());
          }}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
          新建实例
        </Button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={items}
          pagination={{
            current: page + 1,
            pageSize,
            total,
            showSizeChanger: false,
            onChange: (p) => {
              setPage(p - 1);
              void reload(p - 1);
            },
          }}
          locale={{
            emptyText: (
              <Empty description={keyword ? "没有匹配的实例" : "还没有实例，点右上角新建"} />
            ),
          }}
        />
      </div>

      <Modal
        title={editing === "new" ? `新建实例 · ${type.display_name || type.name}` : "编辑实例"}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => void submitEditor()}
        okText="保存"
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入实例名" }]}>
            <Input placeholder="例如：张三" />
          </Form.Item>
          {type.properties.map((p) => (
            <Form.Item
              key={p.name}
              name={`p_${p.name}`}
              label={`${p.display_name || p.name}${p.nullable ? "" : "（必填）"}`}
              rules={
                p.nullable
                  ? []
                  : [{ required: true, message: `请填写 ${p.display_name || p.name}` }]
              }
            >
              {p.data_type === "number" ? (
                <InputNumber style={{ width: "100%" }} />
              ) : p.data_type === "bool" ? (
                <Switch />
              ) : (
                <Input placeholder={p.data_type === "date" ? "YYYY-MM-DD" : undefined} />
              )}
            </Form.Item>
          ))}
          {type.properties.length === 0 ? (
            <Text type="secondary">该类型还没有声明属性，可在左侧类型详情里添加。</Text>
          ) : null}
        </Form>
      </Modal>

      {detail ? (
        <InstanceDetail
          instance={detail}
          type={type}
          types={types}
          edges={edges}
          onClose={() => setDetail(null)}
          onChanged={afterChange}
        />
      ) : null}
    </div>
  );
}

function InstanceDetail({
  instance,
  type,
  types,
  edges,
  onClose,
  onChanged,
}: {
  instance: OntInstance;
  type: OntType;
  types: OntType[];
  edges: OntEdge[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { message: msgApi } = AntdApp.useApp();
  const [links, setLinks] = useState<OntLinkView[]>([]);
  const [adding, setAdding] = useState(false);
  const [addForm] = Form.useForm();
  const [peerOptions, setPeerOptions] = useState<{ label: string; value: string }[]>([]);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  async function reloadLinks() {
    setLinks(await ontoLinksOf(instance.id));
  }

  useEffect(() => {
    void reloadLinks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id]);

  const relatedEdges = edges.filter(
    (e) => e.src_type === type.id || e.dst_type === type.id,
  );

  async function pickEdge(edgeId: string) {
    addForm.setFieldsValue({ peer: undefined });
    const edge = edges.find((e) => e.id === edgeId);
    if (!edge) {
      setPeerOptions([]);
      return;
    }
    const peerTypeId = edge.src_type === type.id ? edge.dst_type : edge.src_type;
    const peerType = typeById.get(peerTypeId);
    const res = await ontoInstanceList(peerTypeId, "", 0, 200);
    setPeerOptions(
      res.items.map((i) => ({
        label: `${i.name}${peerType ? `（${peerType.display_name || peerType.name}）` : ""}`,
        value: i.id,
      })),
    );
  }

  async function submitLink() {
    const values = await addForm.validateFields();
    const edge = edges.find((e) => e.id === values.edgeId);
    if (!edge) return;
    const asSrc = edge.src_type === type.id;
    try {
      await ontoLinkSave({
        edgeId: edge.id,
        srcId: asSrc ? instance.id : values.peer,
        dstId: asSrc ? values.peer : instance.id,
      });
      addForm.resetFields();
      setAdding(false);
      await reloadLinks();
      onChanged();
    } catch (e) {
      msgApi.error(`建立关系失败: ${e}`);
    }
  }

  return (
    <Modal
      title={`实例详情 · ${instance.name}`}
      open
      onCancel={onClose}
      footer={null}
      width={680}
      destroyOnHidden
    >
      <Descriptions
        size="small"
        column={1}
        bordered
        items={[
          { key: "name", label: "名称", children: instance.name },
          { key: "type", label: "类型", children: type.display_name || type.name },
          ...type.properties.map((p) => ({
            key: p.name,
            label: p.display_name || p.name,
            children: propText(instance.properties[p.name]),
          })),
        ]}
      />
      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8 }}>
        <Text strong>关系</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {links.length} 条
        </Text>
        <div style={{ flex: 1 }} />
        {relatedEdges.length > 0 ? (
          <Button size="small" icon={<PlusOutlined />} onClick={() => setAdding((v) => !v)}>
            {adding ? "收起" : "建立关系"}
          </Button>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            先在左侧创建涉及「{type.display_name || type.name}」的关系类型
          </Text>
        )}
      </div>
      {adding ? (
        <Form form={addForm} layout="inline" style={{ marginTop: 10 }}>
          <Form.Item name="edgeId" label="关系" rules={[{ required: true, message: "请选择关系" }]}>
            <Select
              style={{ minWidth: 220 }}
              placeholder="选择关系类型"
              options={relatedEdges.map((e) => {
                const asSrc = e.src_type === type.id;
                const peer = typeById.get(asSrc ? e.dst_type : e.src_type);
                return {
                  label: `${e.display_name || e.name}（${asSrc ? "本类型 → " : "对端 → 本类型"}${peer?.display_name || peer?.name || "?"}）`,
                  value: e.id,
                };
              })}
              onChange={(v) => void pickEdge(v)}
            />
          </Form.Item>
          <Form.Item name="peer" label="对端实例" rules={[{ required: true, message: "请选择对端实例" }]}>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ minWidth: 220 }}
              placeholder="先选关系，再选实例"
              options={peerOptions}
              disabled={peerOptions.length === 0}
            />
          </Form.Item>
          <Button type="primary" onClick={() => void submitLink()}>
            建立
          </Button>
        </Form>
      ) : null}
      <div style={{ marginTop: 10 }}>
        {links.length === 0 ? (
          <Text type="secondary">暂无关系。</Text>
        ) : (
          <Table
            size="small"
            rowKey="id"
            dataSource={links}
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            columns={[
              { title: "关系", dataIndex: "edge_name", width: 140 },
              {
                title: "对端",
                key: "peer",
                render: (_: unknown, row: OntLinkView) =>
                  row.src_id === instance.id ? row.dst_name : row.src_name,
              },
              {
                title: "方向",
                key: "dir",
                width: 90,
                render: (_: unknown, row: OntLinkView) =>
                  row.src_id === instance.id ? (
                    <Tag color="blue">出</Tag>
                  ) : (
                    <Tag color="green">入</Tag>
                  ),
              },
              {
                title: "操作",
                key: "ops",
                width: 70,
                render: (_: unknown, row: OntLinkView) => (
                  <Popconfirm
                    title="删除这条关系？"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    onConfirm={async () => {
                      await ontoLinkDelete(row.id);
                      await reloadLinks();
                      onChanged();
                    }}
                  >
                    <Button size="small" type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        )}
      </div>
    </Modal>
  );
}
