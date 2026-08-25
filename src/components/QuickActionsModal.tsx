import { useEffect, useState } from "react";
import {
  Modal,
  List,
  Button,
  Switch,
  Form,
  Input,
  Space,
  Popconfirm,
  App as AntdApp,
  Empty,
} from "antd";
import {
  ThunderboltOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  CloseCircleOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import {
  loadQuickActions,
  saveUserQuickActions,
  type QuickAction,
} from "../utils/quickActions";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 模式选择器：管理 / 执行 */
type Mode = "manage" | "run";

export default function QuickActionsModal({ open, onClose }: Props) {
  const { message } = AntdApp.useApp();
  const [mode, setMode] = useState<Mode>("manage");
  const [actions, setActions] = useState<QuickAction[]>([]);
  const [editing, setEditing] = useState<QuickAction | null>(null);
  const [editingOpen, setEditingOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [targetPath, setTargetPath] = useState("/Users/zifang");

  useEffect(() => {
    if (open) setActions(loadQuickActions());
  }, [open]);

  const persist = (next: QuickAction[]) => {
    setActions(next);
    saveUserQuickActions(next);
  };

  const onToggle = (id: string, enabled: boolean) => {
    persist(actions.map((a) => (a.id === id ? { ...a, enabled } : a)));
  };

  const onDelete = (id: string) => {
    persist(actions.filter((a) => a.id !== id));
  };

  const onNew = () => {
    setEditing({
      id: `user-${Date.now()}`,
      name: "新操作",
      program: "/bin/echo",
      args: ["{path}"],
      enabled: true,
    });
    setEditingOpen(true);
  };

  const onEdit = (a: QuickAction) => {
    setEditing({ ...a });
    setEditingOpen(true);
  };

  const onSaveEdit = () => {
    if (!editing) return;
    const exists = actions.find((a) => a.id === editing.id);
    const next = exists
      ? actions.map((a) => (a.id === editing.id ? editing : a))
      : [...actions, editing];
    persist(next);
    setEditingOpen(false);
    setEditing(null);
  };

  const onRun = async (a: QuickAction) => {
    if (a.dangerous) {
      // 二次确认在 antd Modal.confirm 已覆盖；这里用 window.confirm 简化
      if (!window.confirm(`⚠️ "${a.name}" 是危险操作，确定要执行吗？`)) return;
    }
    setRunning(true);
    try {
      const r = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
        "run_shell_command",
        { program: a.program, args: a.args, filePath: targetPath },
      );
      if (r.exit_code === 0) {
        const out = r.stdout || "(无输出)";
        message.success(`执行成功，exit 0\n${out.slice(0, 300)}`);
      } else {
        message.error(`exit ${r.exit_code}\n${r.stderr.slice(0, 500)}`);
      }
    } catch (err) {
      message.error("执行失败: " + err);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={680}
      title={
        <Space>
          <ThunderboltOutlined />
          <span>快速操作（Quick Actions）</span>
        </Space>
      }
    >
      <Space style={{ marginBottom: 12 }}>
        <Button
          type={mode === "manage" ? "primary" : "default"}
          onClick={() => setMode("manage")}
        >
          管理
        </Button>
        <Button
          type={mode === "run" ? "primary" : "default"}
          onClick={() => setMode("run")}
        >
          执行
        </Button>
        <div style={{ flex: 1 }} />
        {mode === "manage" && (
          <Button type="primary" icon={<PlusOutlined />} onClick={onNew}>
            新建
          </Button>
        )}
      </Space>

      {mode === "run" && (
        <div style={{ marginBottom: 12 }}>
          <Space.Compact style={{ width: "100%" }}>
            <Input
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder="目标文件路径（{path} 占位符会被替换）"
            />
          </Space.Compact>
        </div>
      )}

      {mode === "manage" ? (
        <List
          dataSource={actions}
          renderItem={(a) => (
            <List.Item
              actions={[
                <Switch
                  key="enabled"
                  checked={a.enabled !== false}
                  onChange={(v) => onToggle(a.id, v)}
                  checkedChildren="启用"
                  unCheckedChildren="禁用"
                />,
                <Button
                  key="edit"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => onEdit(a)}
                />,
                !a.builtin && (
                  <Popconfirm
                    key="del"
                    title="删除这个操作？"
                    onConfirm={() => onDelete(a.id)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                ),
              ].filter(Boolean)}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <code style={{ color: "#1677ff" }}>{a.program}</code>
                    <span>{a.name}</span>
                    {a.builtin && <span style={{ color: "#888", fontSize: 11 }}>内置</span>}
                    {a.dangerous && <span style={{ color: "#f5222d", fontSize: 11 }}>危险</span>}
                  </Space>
                }
                description={
                  <code style={{ fontSize: 11, color: "#666" }}>
                    {a.args.join(" ")}
                  </code>
                }
              />
            </List.Item>
          )}
        />
      ) : (
        <>
          {actions.filter((a) => a.enabled !== false).length === 0 ? (
            <Empty description="没有启用的操作" />
          ) : (
            <Space direction="vertical" style={{ width: "100%" }}>
              {actions
                .filter((a) => a.enabled !== false)
                .map((a) => (
                  <Button
                    key={a.id}
                    block
                    icon={a.dangerous ? <CloseCircleOutlined /> : <ThunderboltOutlined />}
                    loading={running}
                    onClick={() => onRun(a)}
                    style={{ textAlign: "left" }}
                  >
                    {a.name}
                    {a.dangerous && (
                      <span style={{ color: "#f5222d", marginLeft: 8, fontSize: 11 }}>
                        ⚠️ 危险
                      </span>
                    )}
                  </Button>
                ))}
            </Space>
          )}
        </>
      )}

      {/* 编辑 Modal */}
      <Modal
        open={editingOpen}
        onCancel={() => {
          setEditingOpen(false);
          setEditing(null);
        }}
        onOk={onSaveEdit}
        title={editing?.id.startsWith("user-") ? "新建操作" : "编辑操作"}
        okText="保存"
        cancelText="取消"
      >
        {editing && (
          <Form layout="vertical">
            <Form.Item label="名称">
              <Input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Form.Item>
            <Form.Item label="程序">
              <Input
                value={editing.program}
                onChange={(e) => setEditing({ ...editing, program: e.target.value })}
                placeholder="/usr/bin/open 或 /bin/bash"
              />
            </Form.Item>
            <Form.Item label="参数（每行一个，支持 {path} 占位符）">
              <Input.TextArea
                value={editing.args.join("\n")}
                rows={4}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    args: e.target.value.split("\n").filter((s) => s.length > 0),
                  })
                }
                placeholder={"-R\n{path}"}
              />
            </Form.Item>
            <Form.Item>
              <Space>
                <Switch
                  checked={editing.dangerous || false}
                  onChange={(v) => setEditing({ ...editing, dangerous: v })}
                  checkedChildren="危险"
                  unCheckedChildren="安全"
                />
                <Switch
                  checked={editing.enabled !== false}
                  onChange={(v) => setEditing({ ...editing, enabled: v })}
                  checkedChildren="启用"
                  unCheckedChildren="禁用"
                />
              </Space>
            </Form.Item>
          </Form>
        )}
      </Modal>
    </Modal>
  );
}
