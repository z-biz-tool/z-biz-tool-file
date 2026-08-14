import { useEffect, useRef } from "react";
import { List, Button, Tag, Spin, Badge, theme } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useTransferStore, TransferItem } from "../stores/transferStore";

const statusLabel: Record<TransferItem["status"], string> = {
  pending: "等待",
  running: "进行中",
  done: "完成",
  error: "失败",
};

const statusColor: Record<TransferItem["status"], string> = {
  pending: "default",
  running: "processing",
  done: "success",
  error: "error",
};

export default function TransferQueue() {
  const { items, updateStatus, removeCompleted } = useTransferStore();
  const processingRef = useRef(false);
  const { token } = theme.useToken();

  // Process items one at a time
  useEffect(() => {
    if (processingRef.current) return;

    const pending = items.find((item) => item.status === "pending");
    const running = items.find((item) => item.status === "running");

    if (!pending || running) return;

    processingRef.current = true;
    updateStatus(pending.id, "running");

    const command = pending.operation === "copy" ? "copy_file" : "move_file";

    invoke(command, {
      srcPath: pending.sourcePath,
      destDir: pending.destDir,
    })
      .then(() => {
        updateStatus(pending.id, "done");
      })
      .catch((err) => {
        updateStatus(pending.id, "error", String(err));
      })
      .finally(() => {
        processingRef.current = false;
      });
  }, [items, updateStatus]);

  if (items.length === 0) return null;

  const activeCount = items.filter(
    (i) => i.status === "pending" || i.status === "running"
  ).length;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        width: 340,
        maxHeight: 320,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        boxShadow: token.boxShadowSecondary,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        zIndex: 1000,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500 }}>
          传输队列{" "}
          <Badge
            count={activeCount}
            size="small"
            style={{ marginLeft: 4 }}
          />
        </span>
        <Button
          type="text"
          size="small"
          icon={<DeleteOutlined />}
          onClick={removeCompleted}
        >
          清除已完成
        </Button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflow: "auto", padding: "0 4px" }}>
        <List
          size="small"
          dataSource={items}
          renderItem={(item) => (
            <List.Item
              style={{ padding: "6px 8px", fontSize: 12 }}
              extra={
                item.status === "running" ? (
                  <Spin size="small" />
                ) : (
                  <Tag
                    color={statusColor[item.status]}
                    style={{ margin: 0, fontSize: 11 }}
                  >
                    {statusLabel[item.status]}
                  </Tag>
                )
              }
            >
              <List.Item.Meta
                title={
                  <span style={{ fontSize: 12 }}>
                    {item.operation === "copy" ? "复制" : "移动"}:{" "}
                    {item.sourceName}
                  </span>
                }
                description={
                  <span
                    style={{
                      fontSize: 11,
                      color: token.colorTextSecondary,
                      wordBreak: "break-all",
                    }}
                  >
                    → {item.destDir}
                    {item.error && (
                      <span style={{ color: token.colorError, marginLeft: 4 }}>
                        {item.error}
                      </span>
                    )}
                  </span>
                }
                style={{ marginBottom: 0 }}
              />
            </List.Item>
          )}
        />
      </div>
    </div>
  );
}
