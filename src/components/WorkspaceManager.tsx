import { useState, useCallback } from "react";
import { Popover, List, Button, Input, message, Tag, theme } from "antd";
import {
  SaveOutlined,
  DeleteOutlined,
  FolderOutlined,
  LayoutOutlined,
} from "@ant-design/icons";

export interface Workspace {
  name: string;
  path: string;
  viewMode: string;
  showHidden: boolean;
  timestamp: number;
}

interface Props {
  currentPath: string;
  viewMode: string;
  showHidden: boolean;
  onRestore: (ws: Workspace) => void;
}

const STORAGE_KEY = "z-tool-workspaces";

function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveWorkspaces(list: Workspace[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export default function WorkspaceManager({
  currentPath,
  viewMode,
  showHidden,
  onRestore,
}: Props) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces);
  const [nameInput, setNameInput] = useState("");

  const refresh = useCallback(() => {
    setWorkspaces(loadWorkspaces());
  }, []);

  const handleSave = useCallback(() => {
    const name = nameInput.trim();
    if (!name) {
      message.warning("请输入工作区名称");
      return;
    }
    if (!currentPath) {
      message.warning("当前没有打开的目录");
      return;
    }
    const list = loadWorkspaces();
    const existing = list.findIndex((w) => w.name === name);
    const ws: Workspace = {
      name,
      path: currentPath,
      viewMode,
      showHidden,
      timestamp: Date.now(),
    };
    if (existing >= 0) {
      list[existing] = ws;
      message.success("工作区已更新");
    } else {
      list.push(ws);
      message.success("工作区已保存");
    }
    saveWorkspaces(list);
    setNameInput("");
    refresh();
  }, [nameInput, currentPath, viewMode, showHidden, refresh]);

  const handleDelete = useCallback(
    (name: string) => {
      const list = loadWorkspaces().filter((w) => w.name !== name);
      saveWorkspaces(list);
      refresh();
      message.success("已删除工作区");
    },
    [refresh]
  );

  const handleRestore = useCallback(
    (ws: Workspace) => {
      onRestore(ws);
      setOpen(false);
    },
    [onRestore]
  );

  const content = (
    <div style={{ width: 280 }}>
      <div style={{ marginBottom: 8 }}>
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 8,
          }}
        >
          <Input
            size="small"
            placeholder="工作区名称"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onPressEnter={handleSave}
            style={{ flex: 1 }}
          />
          <Button
            size="small"
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
          >
            保存
          </Button>
        </div>
      </div>

      <List
        size="small"
        split={false}
        dataSource={workspaces}
        locale={{ emptyText: "暂无保存的工作区" }}
        renderItem={(ws) => (
          <List.Item
            style={{
              padding: "6px 8px",
              cursor: "pointer",
              borderRadius: token.borderRadiusSM,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.backgroundColor =
                token.colorBgTextHover;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.backgroundColor =
                "transparent";
            }}
            onClick={() => handleRestore(ws)}
            actions={[
              <Button
                key="delete"
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(ws.name);
                }}
                style={{ opacity: 0.4, transition: "opacity 0.2s" }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.opacity = "0.4";
                }}
              />,
            ]}
          >
            <List.Item.Meta
              avatar={<FolderOutlined style={{ color: token.colorTextSecondary }} />}
              title={
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 13,
                  }}
                >
                  <span style={{ color: token.colorText }}>{ws.name}</span>
                  <Tag
                    style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px", margin: 0 }}
                  >
                    {ws.viewMode}
                  </Tag>
                </div>
              }
              description={
                <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
                  <div
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ws.path}
                  </div>
                  <div>{new Date(ws.timestamp).toLocaleString("zh-CN")}</div>
                </div>
              }
              style={{ margin: 0 }}
            />
          </List.Item>
        )}
      />
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          <LayoutOutlined />
          <span>工作区</span>
        </div>
      }
      content={content}
      trigger="click"
      placement="bottomRight"
    >
      <Button size="small" icon={<LayoutOutlined />} type="text" title="工作区管理" />
    </Popover>
  );
}
