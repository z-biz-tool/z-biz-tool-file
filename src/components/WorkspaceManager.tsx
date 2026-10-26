import { useState, useCallback } from "react";
import { Popover, List, Button, Input, Tag, theme, App as AntdApp } from "antd";
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
  } catch (e) {
    console.warn("[workspace] 本地存储里的工作区记录损坏，按空列表处理:", e);
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
  const { message, modal } = AntdApp.useApp();
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces);
  const [nameInput, setNameInput] = useState("");

  const refresh = useCallback(() => {
    setWorkspaces(loadWorkspaces());
  }, []);

  // localStorage 写失败（隐私模式/配额满）必须报出来，否则「已保存」是假的
  const persist = useCallback(
    (list: Workspace[]) => {
      try {
        saveWorkspaces(list);
        return true;
      } catch (e) {
        message.error("工作区没有保存: " + e);
        return false;
      }
    },
    [message]
  );

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
    const commit = () => {
      if (existing >= 0) list[existing] = ws;
      else list.push(ws);
      if (!persist(list)) return;
      setNameInput("");
      refresh();
      message.success(existing >= 0 ? "工作区已更新" : "工作区已保存");
    };
    if (existing >= 0) {
      modal.confirm({
        title: `覆盖工作区「${name}」？`,
        content: (
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            <div>路径：{currentPath}</div>
            <div>会用当前目录和视图设置替换原有的同名工作区。</div>
          </div>
        ),
        okText: "覆盖",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: commit,
      });
      return;
    }
    commit();
  }, [nameInput, currentPath, viewMode, showHidden, refresh, persist, modal, message]);

  const handleDelete = useCallback(
    (ws: Workspace) => {
      modal.confirm({
        title: `删除工作区「${ws.name}」？`,
        content: (
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            <div>路径：{ws.path}</div>
            <div>只删除这条本地工作区记录，磁盘上的文件不受影响。</div>
          </div>
        ),
        okText: "删除",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: () => {
          const list = loadWorkspaces().filter((w) => w.name !== ws.name);
          if (!persist(list)) return;
          refresh();
          message.success("已删除工作区");
        },
      });
    },
    [refresh, persist, modal, message]
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
            role="button"
            tabIndex={0}
            aria-label={`恢复工作区「${ws.name}」`}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRestore(ws);
            }}
            actions={[
              <Button aria-label="删除这个工作区"
                key="delete"
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(ws);
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
      <Button aria-label="工作区管理" size="small" icon={<LayoutOutlined />} type="text" title="工作区管理" />
    </Popover>
  );
}
