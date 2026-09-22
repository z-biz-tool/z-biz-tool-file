import { Tabs, Button, Tooltip } from "antd";
import { PlusOutlined, CloseOutlined, BookOutlined, PictureOutlined, FolderOpenOutlined, SparkleOutlined } from "@ant-design/icons";
import { useFileStore } from "../stores/fileStore";

interface Props {
  onOpenNewTab: () => void;
  onSwitchTo: (path: string) => void;
}

/** 把绝对路径压缩成 tab 标题：~/Downloads/foo */
function tabTitle(tab: { path: string; kind: string }): string {
  // 特殊 tab（library / media）显示友好名
  if (tab.kind === "library") return "图书馆";
  if (tab.kind === "media") return "媒体库";
  // 普通目录 tab
  const path = tab.path;
  if (!path || path === "/") return "/";
  const home = "/Users/zifang";
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~/" + path.slice(home.length + 1);
  return path;
}

/** 不同类型 tab 的图标 */
function tabIcon(kind: string): React.ReactNode {
  if (kind === "library") return <BookOutlined style={{ fontSize: 12, color: '#667eea' }} />;
  if (kind === "media") return <PictureOutlined style={{ fontSize: 12, color: '#764ba2' }} />;
  return <FolderOpenOutlined style={{ fontSize: 12, background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }} />;
}

export default function TabsBar({ onOpenNewTab, onSwitchTo }: Props) {
  const tabs = useFileStore((s) => s.tabs);
  const activeTabId = useFileStore((s) => s.activeTabId);
  const closeTab = useFileStore((s) => s.closeTab);
  const switchTab = useFileStore((s) => s.switchTab);

  if (tabs.length === 0) return null;

  const items = tabs.map((t) => {
    const title = tabTitle(t);
    return {
      key: t.id,
      label: (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            maxWidth: 200,
            userSelect: "none",
            padding: "4px 8px",
            borderRadius: 8,
            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            // 双击 tab = 新建（macOS 行为）
            onOpenNewTab();
          }}
          onMouseEnter={(ev) => {
            if ((ev.target as HTMLElement).closest('.ant-tabs-tab')) {
              (ev.currentTarget as HTMLElement).style.background = "rgba(102,126,234,0.08)";
            }
          }}
          onMouseLeave={(ev) => {
            if ((ev.target as HTMLElement).closest('.ant-tabs-tab')) {
              (ev.currentTarget as HTMLElement).style.background = "transparent";
            }
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 180,
            }}
            title={t.path}
          >
            {tabIcon(t.kind)}
            <span style={{ marginLeft: 4 }}>{title}</span>
          </span>
        </span>
      ),
      closable: tabs.length > 1,
      closeIcon: (
        <span
          onClick={(e) => {
            e.stopPropagation();
            closeTab(t.id);
          }}
          style={{ 
            fontSize: 11, 
            padding: "0 2px",
            borderRadius: 4,
            width: 16,
            height: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
          aria-label={`关闭 tab ${title}`}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "#ff4d4f";
            (e.currentTarget as HTMLElement).style.color = "white";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
            (e.currentTarget as HTMLElement).style.color = "var(--ant-color-text-secondary)";
          }}
        >
          <CloseOutlined />
        </span>
      ),
    };
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        background: "linear-gradient(180deg, #f8fafd 0%, #eef2f7 100%)",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
        paddingLeft: 4,
        boxShadow: "0 2px 4px rgba(0,0,0,0.02)",
      }}
    >
      <Tabs
        type="editable-card"
        hideAdd
        size="small"
        activeKey={activeTabId ?? undefined}
        onChange={(key) => {
          switchTab(key as string);
          const tab = tabs.find((t) => t.id === key);
          // 仅 directory tab 才触发目录切换；library/media tab 不调用 onSwitchTo
          if (tab && tab.kind === "directory") onSwitchTo(tab.path);
        }}
        onEdit={(targetKey, action) => {
          if (action === "remove") {
            closeTab(targetKey as string);
          }
        }}
        items={items}
        style={{ flex: 1, minHeight: 32 }}
        tabBarStyle={{ margin: 0, borderBottom: "none" }}
        cardGutter={8}
      />
      <Tooltip title="新建标签页 (⌘+T)">
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          onClick={onOpenNewTab}
          style={{ 
            marginRight: 8,
            borderRadius: 8,
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            color: "white",
            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
          aria-label="新建标签页"
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.transform = "scale(1.05)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.transform = "scale(1)";
          }}
        />
      </Tooltip>
    </div>
  );
}
