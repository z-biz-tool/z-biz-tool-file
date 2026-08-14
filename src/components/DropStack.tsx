import { useState, useCallback } from "react";
import { Button, List, Badge, Tooltip, message, theme } from "antd";
import {
  InboxOutlined,
  DeleteOutlined,
  CopyOutlined,
  SwapOutlined,
  ClearOutlined,
  DownOutlined,
  RightOutlined,
  FileOutlined,
  FolderOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
interface StackItem {
  path: string;
  name: string;
  is_dir: boolean;
}

interface DropStackProps {
  currentPath: string;
  onRefresh: () => void;
}

export default function DropStack({ currentPath, onRefresh }: DropStackProps) {
  const [stack, setStack] = useState<StackItem[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [isOver, setIsOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const { token } = theme.useToken();

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    setIsOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);

    const pathsData = e.dataTransfer?.getData("application/x-z-tool-paths");
    if (pathsData) {
      try {
        const paths: string[] = JSON.parse(pathsData);
        const newItems: StackItem[] = paths.map((p) => ({
          path: p,
          name: p.split("/").filter(Boolean).pop() || p,
          is_dir: false, // 无法从路径判断，默认 false
        }));
        // 去重
        setStack((prev) => {
          const existing = new Set(prev.map((item) => item.path));
          const unique = newItems.filter((item) => !existing.has(item.path));
          return [...prev, ...unique];
        });
        if (newItems.length > 0) {
          message.success(`已添加 ${newItems.length} 项到暂存栈`);
        }
        return;
      } catch {
        message.error("拖拽数据解析失败");
        return;
      }
    }

    // 兼容旧格式
    const filesData = e.dataTransfer?.getData("application/x-z-tool-files");
    if (filesData) {
      try {
        const items: { path: string; name: string; is_dir: boolean }[] = JSON.parse(filesData);
        setStack((prev) => {
          const existing = new Set(prev.map((s) => s.path));
          const unique = items.filter((item) => !existing.has(item.path));
          return [...prev, ...unique];
        });
        if (items.length > 0) {
          message.success(`已添加 ${items.length} 项到暂存栈`);
        }
      } catch {
        message.error("拖拽数据解析失败");
      }
    }
  }, []);

  const removeItem = useCallback((path: string) => {
    setStack((prev) => prev.filter((item) => item.path !== path));
  }, []);

  const clearStack = useCallback(() => {
    setStack([]);
  }, []);

  const copyToCurrent = useCallback(async () => {
    if (stack.length === 0 || !currentPath) return;
    setLoading(true);
    try {
      let count = 0;
      for (const item of stack) {
        if (item.path === currentPath) continue;
        await invoke("copy_file", { srcPath: item.path, destDir: currentPath });
        count++;
      }
      if (count > 0) {
        message.success(`已复制 ${count} 项到当前目录`);
        onRefresh();
      }
    } catch (err) {
      message.error("复制失败: " + err);
    } finally {
      setLoading(false);
    }
  }, [stack, currentPath, onRefresh]);

  const moveToCurrent = useCallback(async () => {
    if (stack.length === 0 || !currentPath) return;
    setLoading(true);
    try {
      let count = 0;
      for (const item of stack) {
        if (item.path === currentPath) continue;
        if (currentPath.startsWith(item.path + "/")) continue;
        await invoke("move_file", { srcPath: item.path, destDir: currentPath });
        count++;
      }
      if (count > 0) {
        message.success(`已移动 ${count} 项到当前目录`);
        setStack([]);
        onRefresh();
      }
    } catch (err) {
      message.error("移动失败: " + err);
    } finally {
      setLoading(false);
    }
  }, [stack, currentPath, onRefresh]);

  return (
    <div style={{ padding: "8px" }}>
      {/* 标题栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontWeight: 600,
          fontSize: 13,
          color: token.colorText,
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? <RightOutlined /> : <DownOutlined />}
        <InboxOutlined />
        <span>暂存栈</span>
        {stack.length > 0 && (
          <Badge
            count={stack.length}
            size="small"
            style={{ marginLeft: 4 }}
          />
        )}
      </div>

      {!collapsed && (
        <>
          {/* 拖放区域 */}
          <div
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
              marginTop: 8,
              minHeight: stack.length === 0 ? 60 : 0,
              border: `1px dashed ${isOver ? token.colorPrimary : token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusSM,
              background: isOver
                ? "rgba(22, 119, 255, 0.06)"
                : token.colorBgContainer,
              transition: "all 0.15s",
              display: "flex",
              alignItems: stack.length === 0 ? "center" : "stretch",
              justifyContent: "center",
            }}
          >
            {stack.length === 0 ? (
              <span
                style={{
                  color: token.colorTextSecondary,
                  fontSize: 12,
                  padding: "12px 0",
                }}
              >
                拖拽文件到此处暂存
              </span>
            ) : (
              <List
                size="small"
                split={false}
                dataSource={stack}
                style={{ width: "100%" }}
                renderItem={(item) => (
                  <List.Item
                    style={{
                      padding: "4px 8px",
                      fontSize: 12,
                    }}
                    actions={[
                      <Tooltip key="remove" title="移除">
                        <Button
                          type="text"
                          size="small"
                          icon={<DeleteOutlined />}
                          onClick={() => removeItem(item.path)}
                          style={{ opacity: 0.4, transition: "opacity 0.2s" }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLElement).style.opacity = "1";
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.opacity = "0.4";
                          }}
                        />
                      </Tooltip>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={
                        item.is_dir ? (
                          <FolderOutlined style={{ color: "#faad14", fontSize: 13 }} />
                        ) : (
                          <FileOutlined style={{ color: "#8c8c8c", fontSize: 13 }} />
                        )
                      }
                      title={
                        <Tooltip title={item.path}>
                          <span
                            style={{
                              fontSize: 12,
                              color: token.colorText,
                              maxWidth: 160,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              display: "inline-block",
                            }}
                          >
                            {item.name}
                          </span>
                        </Tooltip>
                      }
                      style={{ margin: 0 }}
                    />
                  </List.Item>
                )}
              />
            )}
          </div>

          {/* 操作按钮 */}
          {stack.length > 0 && (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                gap: 4,
                flexWrap: "wrap",
              }}
            >
              <Tooltip title="复制所有暂存文件到当前目录">
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={copyToCurrent}
                  loading={loading}
                  style={{ fontSize: 11 }}
                >
                  复制到当前
                </Button>
              </Tooltip>
              <Tooltip title="移动所有暂存文件到当前目录">
                <Button
                  size="small"
                  icon={<SwapOutlined />}
                  onClick={moveToCurrent}
                  loading={loading}
                  style={{ fontSize: 11 }}
                >
                  移动到当前
                </Button>
              </Tooltip>
              <Tooltip title="清空暂存栈">
                <Button
                  size="small"
                  icon={<ClearOutlined />}
                  onClick={clearStack}
                  danger
                  style={{ fontSize: 11 }}
                >
                  清空
                </Button>
              </Tooltip>
            </div>
          )}
        </>
      )}
    </div>
  );
}
