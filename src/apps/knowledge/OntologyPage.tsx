// 本体页（认知 → 本体）：左右分栏对齐 future-brain 本体板块的交互形态。
// 左栏：本体身份卡（类型/关系/实例统计）+ 对象类型 / 关系类型双 Tab 声明管理；
// 右侧：图谱（SVG 力导向，可拖拽回存布局）/ 实例 两视图切换 + 跨类型实例搜索。
// 与 future-brain 的差异：建模直写（无提案链），图谱用自绘 SVG（不引 G6）。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App as AntdApp,
  AutoComplete,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import {
  ApartmentOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  TableOutlined,
} from "@ant-design/icons";
import {
  ontoLayoutSave,
  ontoOverview,
  ontoPropertyDelete,
  ontoPropertySet,
  ontoSearch,
  ontoTypeDelete,
  ontoTypeSave,
  ontoEdgeDelete,
  ontoEdgeSave,
  type OntEdge,
  type OntGraphNode,
  type OntOverview,
  type OntType,
} from "./api";
import OntGraph from "./ontology/OntGraph";
import OntInstances from "./ontology/OntInstances";

const { Text, Title } = Typography;

const DATA_TYPE_OPTIONS = [
  { value: "text", label: "文本" },
  { value: "number", label: "数字" },
  { value: "date", label: "日期" },
  { value: "bool", label: "布尔" },
];

const dataTypeLabel: Record<string, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  bool: "布尔",
};

export default function OntologyPage() {
  const { message: msgApi, modal } = AntdApp.useApp();
  const [overview, setOverview] = useState<OntOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [leftTab, setLeftTab] = useState("type");
  const [leftKeyword, setLeftKeyword] = useState("");
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [view, setView] = useState<"graph" | "instances">("graph");
  const [focusInstanceId, setFocusInstanceId] = useState<string | null>(null);
  const [searchOptions, setSearchOptions] = useState<OntGraphNode[]>([]);
  const [searching, setSearching] = useState(false);

  const [typeModalOpen, setTypeModalOpen] = useState(false);
  const [editingType, setEditingType] = useState<OntType | null>(null);
  const [edgeModalOpen, setEdgeModalOpen] = useState(false);
  const [editingEdge, setEditingEdge] = useState<OntEdge | null>(null);
  const [propModalOpen, setPropModalOpen] = useState(false);
  const [typeForm] = Form.useForm();
  const [edgeForm] = Form.useForm();
  const [propForm] = Form.useForm();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await ontoOverview());
    } catch (e) {
      msgApi.error(`加载本体失败: ${e}`);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const types = overview?.types ?? [];
  const edges = overview?.edges ?? [];
  const selectedType = types.find((t) => t.id === selectedTypeId) ?? null;

  const filteredTypes = useMemo(
    () =>
      types.filter(
        (t) =>
          !leftKeyword ||
          t.name.includes(leftKeyword) ||
          t.display_name.includes(leftKeyword) ||
          t.category.includes(leftKeyword),
      ),
    [types, leftKeyword],
  );

  const typeGroups = useMemo(() => {
    const map = new Map<string, OntType[]>();
    for (const t of filteredTypes) {
      const key = t.category || "未分类";
      const list = map.get(key) || [];
      list.push(t);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [filteredTypes]);

  const filteredEdges = useMemo(
    () =>
      edges.filter(
        (e) =>
          !leftKeyword ||
          e.name.includes(leftKeyword) ||
          e.display_name.includes(leftKeyword),
      ),
    [edges, leftKeyword],
  );

  const typeNameOf = useCallback(
    (id: string) => types.find((t) => t.id === id)?.display_name || id,
    [types],
  );

  async function saveType() {
    const values = await typeForm.validateFields();
    try {
      await ontoTypeSave({
        id: editingType?.id ?? null,
        name: values.name.trim(),
        displayName: values.displayName?.trim() || undefined,
        category: values.category?.trim() || undefined,
      });
      msgApi.success(editingType ? "对象类型已更新" : "对象类型已创建");
      setTypeModalOpen(false);
      await reload();
    } catch (e) {
      msgApi.error(`${e}`);
    }
  }

  async function saveEdge() {
    const values = await edgeForm.validateFields();
    try {
      await ontoEdgeSave({
        id: editingEdge?.id ?? null,
        name: values.name.trim(),
        displayName: values.displayName?.trim() || undefined,
        srcType: values.srcType,
        dstType: values.dstType,
      });
      msgApi.success(editingEdge ? "关系类型已更新" : "关系类型已创建");
      setEdgeModalOpen(false);
      await reload();
    } catch (e) {
      msgApi.error(`${e}`);
    }
  }

  async function saveProp() {
    if (!selectedType) return;
    const values = await propForm.validateFields();
    try {
      await ontoPropertySet({
        owner: "type",
        ownerId: selectedType.id,
        name: values.name.trim(),
        displayName: values.displayName?.trim() || undefined,
        dataType: values.dataType,
        nullable: values.nullable,
      });
      msgApi.success("属性已保存");
      setPropModalOpen(false);
      await reload();
    } catch (e) {
      msgApi.error(`${e}`);
    }
  }

  function confirmDeleteType(t: OntType) {
    modal.confirm({
      title: `删除对象类型「${t.display_name}」？`,
      content: "其下所有实例、关系与布局记录会一并删除，不可恢复。",
      okButtonProps: { danger: true },
      okText: "删除",
      onOk: async () => {
        try {
          await ontoTypeDelete(t.id);
          if (selectedTypeId === t.id) setSelectedTypeId(null);
          msgApi.success("已删除");
          await reload();
        } catch (e) {
          msgApi.error(`${e}`);
        }
      },
    });
  }

  function confirmDeleteEdge(e: OntEdge) {
    modal.confirm({
      title: `删除关系类型「${e.display_name}」？`,
      content: "该关系下的所有关系实例会一并删除，不可恢复。",
      okButtonProps: { danger: true },
      okText: "删除",
      onOk: async () => {
        try {
          await ontoEdgeDelete(e.id);
          msgApi.success("已删除");
          await reload();
        } catch (e2) {
          msgApi.error(`${e2}`);
        }
      },
    });
  }

  async function runSearch(kw: string) {
    if (!kw.trim()) {
      setSearchOptions([]);
      return;
    }
    setSearching(true);
    try {
      setSearchOptions(await ontoSearch(kw.trim(), 10));
    } catch {
      setSearchOptions([]);
    } finally {
      setSearching(false);
    }
  }

  function jumpToInstance(node: OntGraphNode) {
    setSelectedTypeId(node.type_id);
    setView("instances");
    setFocusInstanceId(node.id);
  }

  const openTypeModal = (t: OntType | null) => {
    setEditingType(t);
    typeForm.setFieldsValue({
      name: t?.name ?? "",
      displayName: t?.display_name ?? "",
      category: t?.category ?? "",
    });
    setTypeModalOpen(true);
  };

  const openEdgeModal = (e: OntEdge | null) => {
    setEditingEdge(e);
    edgeForm.setFieldsValue({
      name: e?.name ?? "",
      displayName: e?.display_name ?? "",
      srcType: e?.src_type,
      dstType: e?.dst_type,
    });
    setEdgeModalOpen(true);
  };

  const typeOptions = types.map((t) => ({ value: t.id, label: t.display_name }));

  const statCard = (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--ant-color-fill-quaternary)",
        marginBottom: 12,
      }}
    >
      <Title level={5} style={{ margin: 0 }}>
        本体
      </Title>
      <Space size={16} style={{ marginTop: 6 }}>
        <Text type="secondary">
          对象类型 <Text strong>{types.length}</Text>
        </Text>
        <Text type="secondary">
          关系类型 <Text strong>{edges.length}</Text>
        </Text>
        <Text type="secondary">
          实例 <Text strong>{overview?.instance_total ?? 0}</Text>
        </Text>
        <Text type="secondary">
          关系 <Text strong>{overview?.link_total ?? 0}</Text>
        </Text>
      </Space>
    </div>
  );

  const typeList = (
    <div style={{ overflowY: "auto", flex: 1 }}>
      {typeGroups.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 12, padding: "8px 4px", display: "block" }}>
          {types.length === 0 ? "还没有对象类型，点上方「新建」开始建模" : "没有匹配的类型"}
        </Text>
      ) : (
        typeGroups.map(([category, list]) => (
          <div key={category} style={{ marginBottom: 10 }}>
            <Text type="secondary" style={{ fontSize: 12, padding: "0 4px 4px" }}>
              {category} · {list.length}
            </Text>
            {list.map((t) => (
              <div
                key={t.id}
                onClick={() => {
                  setSelectedTypeId(t.id);
                  setDrawerOpen(true);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background:
                    selectedTypeId === t.id
                      ? "var(--ant-color-primary-bg)"
                      : "transparent",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.display_name}
                  {t.display_name !== t.name ? (
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                      {t.name}
                    </Text>
                  ) : null}
                </span>
                <Tag bordered={false} style={{ fontSize: 11, marginRight: 0 }}>
                  {t.instance_count}
                </Tag>
                <Button
                  size="small"
                  type="text"
                  icon={<EditOutlined />}
                  aria-label={`编辑 ${t.display_name}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    openTypeModal(t);
                  }}
                />
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );

  const edgeList = (
    <div style={{ overflowY: "auto", flex: 1 }}>
      {filteredEdges.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 12, padding: "8px 4px", display: "block" }}>
          {edges.length === 0
            ? "还没有关系类型，点上方「新建」声明对象之间的关系"
            : "没有匹配的关系类型"}
        </Text>
      ) : (
        filteredEdges.map((e) => (
          <div
            key={e.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              borderRadius: 6,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              {e.display_name}
              <br />
              <Text type="secondary" style={{ fontSize: 11 }}>
                {typeNameOf(e.src_type)} → {typeNameOf(e.dst_type)}
              </Text>
            </span>
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              aria-label={`编辑 ${e.display_name}`}
              onClick={() => openEdgeModal(e)}
            />
            <Popconfirm
              title="删除该关系类型？其下所有关系实例会一并删除"
              onConfirm={() => confirmDeleteEdge(e)}
            >
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label={`删除 ${e.display_name}`}
              />
            </Popconfirm>
          </div>
        ))
      )}
    </div>
  );

  const leftPanel = (
    <div
      style={{
        width: 300,
        flexShrink: 0,
        borderRight: "1px solid var(--ant-color-split)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {statCard}
      <Space style={{ width: "100%", marginBottom: 8 }} direction="vertical" size={8}>
        <Input.Search
          size="small"
          placeholder="搜索类型 / 关系"
          allowClear
          onSearch={setLeftKeyword}
          onChange={(e) => {
            if (!e.target.value) setLeftKeyword("");
          }}
        />
        <Space wrap>
          {leftTab === "type" ? (
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openTypeModal(null)}>
              新建对象类型
            </Button>
          ) : (
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openEdgeModal(null)}>
              新建关系类型
            </Button>
          )}
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void reload()}>
            刷新
          </Button>
        </Space>
      </Space>
      <Tabs
        activeKey={leftTab}
        onChange={setLeftTab}
        size="small"
        items={[
          { key: "type", label: `对象类型 (${types.length})`, children: typeList },
          { key: "edge", label: `关系类型 (${edges.length})`, children: edgeList },
        ]}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      />
    </div>
  );

  const typeDetailDrawer = (
    <Drawer
      title={selectedType ? selectedType.display_name : null}
      placement="right"
      width={380}
      open={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      destroyOnHidden
    >
      {selectedType ? (
        <Space direction="vertical" style={{ width: "100%" }} size={16}>
          <Space size={8} wrap>
            {selectedType.category ? <Tag>{selectedType.category}</Tag> : null}
            <Text type="secondary" style={{ fontSize: 12 }}>
              代号 {selectedType.name} · {selectedType.instance_count} 个实例
            </Text>
          </Space>
          <Space wrap>
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => openTypeModal(selectedType)}
            >
              编辑基本信息
            </Button>
            <Button
              size="small"
              icon={<TableOutlined />}
              onClick={() => {
                setDrawerOpen(false);
                setView("instances");
              }}
            >
              查看实例
            </Button>
            <Popconfirm
              title="删除该对象类型？其下所有实例、关系会一并删除"
              onConfirm={() => confirmDeleteType(selectedType)}
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
                删除类型
              </Button>
            </Popconfirm>
          </Space>
          <div>
            <Space style={{ marginBottom: 8 }}>
              <Text strong>属性</Text>
              <Button
                size="small"
                type="text"
                icon={<PlusOutlined />}
                onClick={() => {
                  propForm.setFieldsValue({
                    name: "",
                    displayName: "",
                    dataType: "text",
                    nullable: true,
                  });
                  setPropModalOpen(true);
                }}
              >
                新增属性
              </Button>
            </Space>
            <Table
              size="small"
              rowKey="name"
              pagination={false}
              dataSource={selectedType.properties}
              columns={[
                { title: "显示名", dataIndex: "display_name", width: 90 },
                { title: "代号", dataIndex: "name", width: 90 },
                {
                  title: "类型",
                  dataIndex: "data_type",
                  width: 60,
                  render: (v: string) => dataTypeLabel[v] ?? v,
                },
                {
                  title: "",
                  width: 40,
                  render: (_: unknown, p) => (
                    <Popconfirm
                      title="删除属性？实例上的该属性值会一并清除"
                      onConfirm={async () => {
                        try {
                          await ontoPropertyDelete("type", selectedType.id, p.name);
                          msgApi.success("属性已删除");
                          await reload();
                        } catch (e) {
                          msgApi.error(`${e}`);
                        }
                      }}
                    >
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label={`删除属性 ${p.name}`}
                      />
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </div>
        </Space>
      ) : null}
    </Drawer>
  );

  return (
    <div style={{ height: "100%", display: "flex", minHeight: 0 }}>
      {leftPanel}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          padding: "8px 12px 12px",
          minHeight: 0,
        }}
      >
        <Space style={{ marginBottom: 8 }} wrap>
          <Segmented
            value={view}
            onChange={(v) => setView(v as "graph" | "instances")}
            options={[
              { value: "graph", label: "图谱", icon: <ApartmentOutlined /> },
              { value: "instances", label: "实例", icon: <TableOutlined /> },
            ]}
          />
          <AutoComplete
            style={{ width: 260 }}
            placeholder="跨类型搜索实例…"
            value={undefined}
            onSearch={(kw) => void runSearch(kw)}
            onSelect={(_v, option) => {
              const node = searchOptions.find((n) => n.id === (option as { key?: string }).key);
              if (node) jumpToInstance(node);
            }}
            options={searchOptions.map((n) => ({
              key: n.id,
              value: n.id,
              label: (
                <Space size={6}>
                  <Text>{n.name}</Text>
                  <Tag bordered={false} style={{ fontSize: 11, marginRight: 0 }}>
                    {n.type_name}
                  </Tag>
                </Space>
              ),
            }))}
            notFoundContent={searching ? <Spin size="small" /> : null}
          />
        </Space>
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          {loading && !overview ? (
            <div style={{ display: "flex", justifyContent: "center", paddingTop: 80 }}>
              <Spin />
            </div>
          ) : types.length === 0 ? (
            <Empty
              style={{ paddingTop: 80 }}
              description="还没有对象类型"
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openTypeModal(null)}>
                新建第一个对象类型
              </Button>
            </Empty>
          ) : view === "graph" ? (
            <OntGraph
              types={types}
              edges={edges}
              layout={overview?.layout ?? {}}
              selectedTypeId={selectedTypeId}
              onSelect={setSelectedTypeId}
              onPositionsChange={(positions) => {
                void ontoLayoutSave(positions).catch(() => undefined);
              }}
            />
          ) : selectedType ? (
            <OntInstances
              type={selectedType}
              types={types}
              edges={edges}
              focusInstanceId={focusInstanceId}
              onConsumedFocus={() => setFocusInstanceId(null)}
              onChanged={() => void reload()}
            />
          ) : (
            <Empty
              style={{ paddingTop: 80 }}
              description="先在左侧或图谱中选择一个对象类型"
            />
          )}
        </div>
      </div>
      {typeDetailDrawer}

      <Modal
        title={editingType ? "编辑对象类型" : "新建对象类型"}
        open={typeModalOpen}
        onOk={() => void saveType()}
        onCancel={() => setTypeModalOpen(false)}
        destroyOnHidden
      >
        <Form form={typeForm} layout="vertical">
          <Form.Item
            name="name"
            label="代号（唯一，英文/数字，如 Person）"
            rules={[{ required: true, message: "请输入代号" }]}
          >
            <Input placeholder="Person" maxLength={64} />
          </Form.Item>
          <Form.Item name="displayName" label="显示名">
            <Input placeholder="人员" maxLength={64} />
          </Form.Item>
          <Form.Item name="category" label="分类（用于左栏分组）">
            <Input placeholder="组织" maxLength={64} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingEdge ? "编辑关系类型" : "新建关系类型"}
        open={edgeModalOpen}
        onOk={() => void saveEdge()}
        onCancel={() => setEdgeModalOpen(false)}
        destroyOnHidden
      >
        <Form form={edgeForm} layout="vertical">
          <Form.Item
            name="name"
            label="代号（唯一，英文/数字，如 belongs_to）"
            rules={[{ required: true, message: "请输入代号" }]}
          >
            <Input placeholder="belongs_to" maxLength={64} />
          </Form.Item>
          <Form.Item name="displayName" label="显示名">
            <Input placeholder="属于" maxLength={64} />
          </Form.Item>
          <Form.Item name="srcType" label="起点对象类型" rules={[{ required: true }]}>
            <Select options={typeOptions} placeholder="选择起点类型" />
          </Form.Item>
          <Form.Item name="dstType" label="终点对象类型" rules={[{ required: true }]}>
            <Select options={typeOptions} placeholder="选择终点类型" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="新增属性"
        open={propModalOpen}
        onOk={() => void saveProp()}
        onCancel={() => setPropModalOpen(false)}
        destroyOnHidden
      >
        <Form form={propForm} layout="vertical">
          <Form.Item
            name="name"
            label="代号（唯一，如 age）"
            rules={[{ required: true, message: "请输入代号" }]}
          >
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="displayName" label="显示名">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="dataType" label="数据类型" initialValue="text">
            <Select options={DATA_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="nullable" label="允许为空" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
