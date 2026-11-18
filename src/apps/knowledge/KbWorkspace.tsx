// 知识库工作台外壳：顶栏（返回 + 库名 + 统计 + 设置/更多）+ 三个一级页签
// 资料 / 知识检索 / AI 助手 —— 对应 future-brain detail.tsx 的 workspaceTabs。
// 检索与 AI 命中资料时经 onOpenMaterial 跳回资料页签并聚焦该条目。
import { useState } from "react";
import {
  App as AntdApp,
  Button,
  Dropdown,
  Form,
  Input,
  Space,
  Tag,
  Tabs,
  Tooltip,
  Typography,
} from "antd";
import {
  ArrowLeftOutlined,
  BulbOutlined,
  DeleteOutlined,
  EditOutlined,
  MessageOutlined,
  MoreOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import type { KbSummary } from "./api";
import { kbBaseDelete, kbBaseRename } from "./api";
import MaterialsView from "./MaterialsView";
import RetrievalView from "./RetrievalView";
import AssistantView from "./AssistantView";
import SettingsModal from "./SettingsModal";

const { Title } = Typography;

type WorkspaceTab = "materials" | "retrieval" | "assistant";

export default function KbWorkspace({
  kb,
  onKbChange,
  onBack,
}: {
  kb: KbSummary;
  onKbChange: (kb: KbSummary) => void;
  onBack: () => void;
}) {
  const { message: msgApi, modal } = AntdApp.useApp();
  const [tab, setTab] = useState<WorkspaceTab>("materials");
  const [stats, setStats] = useState({ material: kb.material_count, parsed: kb.parsed_count });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [focusMaterial, setFocusMaterial] = useState<string | null>(null);

  function handleStats(next: { material: number; parsed: number }) {
    setStats(next);
    onKbChange({ ...kb, material_count: next.material, parsed_count: next.parsed });
  }

  function openMaterial(materialId: string) {
    setFocusMaterial(materialId);
    setTab("materials");
  }

  function handleRename() {
    let name = kb.name;
    let description = kb.description ?? "";
    modal.confirm({
      title: "重命名知识库",
      icon: null,
      content: (
        <Form layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="名称" required>
            <Input defaultValue={kb.name} onChange={(e) => (name = e.target.value)} />
          </Form.Item>
          <Form.Item label="描述">
            <Input.TextArea
              defaultValue={kb.description ?? ""}
              autoSize
              onChange={(e) => (description = e.target.value)}
            />
          </Form.Item>
        </Form>
      ),
      onOk: async () => {
        if (!name.trim()) {
          msgApi.warning("名称不能为空");
          return Promise.reject();
        }
        try {
          const next = await kbBaseRename(kb.id, name.trim(), description);
          onKbChange({ ...kb, ...next });
          msgApi.success("已重命名");
        } catch (e) {
          msgApi.error(`${e}`);
          return Promise.reject();
        }
      },
    });
  }

  function handleDelete() {
    modal.confirm({
      title: `删除知识库「${kb.name}」？`,
      content: `将删除其中的 ${stats.material} 条资料（含已拷入的原件与解析稿）。源文件不受影响。`,
      okText: "删除",
      okButtonProps: { danger: true },
      autoFocusButton: "cancel",
      onOk: async () => {
        try {
          await kbBaseDelete(kb.id);
          msgApi.success("知识库已删除");
          onBack();
        } catch (e) {
          msgApi.error(`${e}`);
          return Promise.reject();
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
          gap: 10,
          padding: "10px 14px 0",
          flexShrink: 0,
        }}
      >
        <Tooltip title="返回知识库列表">
          <Button type="text" icon={<ArrowLeftOutlined />} aria-label="返回知识库列表" onClick={onBack} />
        </Tooltip>
        <Title level={4} style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <BulbOutlined style={{ color: "var(--ant-color-primary)", flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {kb.name}
          </span>
        </Title>
        <Tag>{stats.material} 资料</Tag>
        <Tag color="green">{stats.parsed} 已解析</Tag>
        <div style={{ flex: 1 }} />
        <Space>
          <Tooltip title="刷新">
            <Button
              type="text"
              icon={<ReloadOutlined />}
              aria-label="刷新工作台"
              onClick={() => setReloadKey((k) => k + 1)}
            />
          </Tooltip>
          <Tooltip title="解析服务与语雀接入设置（MinerU 可选，留空即纯本地）">
            <Button
              type="text"
              icon={<SettingOutlined />}
              aria-label="知识库设置"
              onClick={() => setSettingsOpen(true)}
            />
          </Tooltip>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "settings", icon: <SettingOutlined />, label: "设置（解析服务 / 语雀）" },
                { key: "rename", icon: <EditOutlined />, label: "重命名" },
                { key: "delete", icon: <DeleteOutlined />, label: "删除知识库", danger: true },
              ],
              onClick: ({ key }) => {
                if (key === "settings") setSettingsOpen(true);
                if (key === "rename") handleRename();
                if (key === "delete") handleDelete();
              },
            }}
          >
            <Button type="text" icon={<MoreOutlined />} aria-label="工作台更多操作" />
          </Dropdown>
        </Space>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: "4px 14px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Tabs
            activeKey={tab}
            onChange={(k) => setTab(k as WorkspaceTab)}
            style={{ flex: 1, minWidth: 0 }}
            items={[
              {
                key: "materials",
                label: (
                  <span>
                    <BulbOutlined style={{ marginRight: 4 }} />
                    资料
                  </span>
                ),
                children: (
                  <MaterialsView
                    kb={kb}
                    reloadKey={reloadKey}
                    focusMaterialId={focusMaterial}
                    onConsumedFocus={() => setFocusMaterial(null)}
                    onStatsChange={handleStats}
                  />
                ),
              },
              {
                key: "retrieval",
                label: (
                  <span>
                    <SearchOutlined style={{ marginRight: 4 }} />
                    知识检索
                  </span>
                ),
                children: <RetrievalView kbId={kb.id} onOpenMaterial={openMaterial} />,
              },
              {
                key: "assistant",
                label: (
                  <span>
                    <MessageOutlined style={{ marginRight: 4 }} />
                    AI 助手
                  </span>
                ),
                children: <AssistantView kbId={kb.id} onOpenMaterial={openMaterial} />,
              },
            ]}
          />
          <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
            设置
          </Button>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
