import { List, Button, message, theme } from "antd";
import { FolderOutlined, DeleteOutlined, StarOutlined, PlusOutlined } from "@ant-design/icons";
import { useFileStore } from "../stores/fileStore";

interface Props {
  onNavigate: (path: string) => void;
}

export default function Bookmarks({ onNavigate }: Props) {
  const { bookmarks, currentPath, addBookmark, removeBookmark } = useFileStore();
  const { token } = theme.useToken();

  const handleAdd = () => {
    if (!currentPath) {
      message.warning("当前没有打开的目录");
      return;
    }
    if (bookmarks.some((b) => b.path === currentPath)) {
      message.info("该目录已在收藏夹中");
      return;
    }
    const name = currentPath.split("/").filter(Boolean).pop() || currentPath;
    addBookmark({ name, path: currentPath });
    message.success("已添加到收藏夹");
  };

  return (
    <div style={{ padding: "8px" }}>
      <div
        style={{
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontWeight: 600,
          fontSize: 13,
          color: token.colorText,
        }}
      >
        <StarOutlined />
        <span>收藏夹</span>
      </div>

      <List
        size="small"
        split={false}
        dataSource={bookmarks}
        locale={{ emptyText: "暂无收藏" }}
        renderItem={(item) => (
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
              (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
            }}
            onClick={() => onNavigate(item.path)}
            actions={[
              <Button
                key="delete"
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  removeBookmark(item.path);
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
                <span style={{ fontSize: 13, color: token.colorText }}>{item.name}</span>
              }
              style={{ margin: 0 }}
            />
          </List.Item>
        )}
      />

      <Button
        type="dashed"
        size="small"
        icon={<PlusOutlined />}
        block
        onClick={handleAdd}
        style={{ marginTop: 8 }}
      >
        添加收藏
      </Button>
    </div>
  );
}
