import { useState, useEffect, useCallback } from "react";
import {
  Modal,
  Table,
  Button,
  Space,
  Tooltip,
  Empty,
  App as AntdApp,
} from "antd";
import {
  DeleteOutlined,
  ReloadOutlined,
  FolderOpenOutlined,
  ExclamationCircleOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  open: boolean;
  onClose: () => void;
  onRestored?: () => void;
}

interface TrashCleanupReport {
  removed: number;
  bytes_freed: number;
  kept_unknown_age: number;
  retain_days: number;
}

interface TrashEntry {
  trash_path: string;
  original_path: string;
  name: string;
  is_dir: boolean;
  size: number;
  deleted_at: string;
  age_secs: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 与后端 DEFAULT_TRASH_RETAIN_DAYS 保持一致 */
const RETAIN_DAYS = 30;
const DAY_SECS = 86400;

function formatAge(secs: number): string {
  if (secs < 0) return "时间未知";
  if (secs < 60) return `${secs} 秒前`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`;
  return `${Math.floor(secs / 86400)} 天前`;
}

export default function TrashModal({ open, onClose, onRestored }: Props) {
  const { message, modal } = AntdApp.useApp();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [trashPath, setTrashPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, size, path] = await Promise.all([
        invoke<TrashEntry[]>("list_trash"),
        invoke<number>("get_trash_size"),
        invoke<string>("get_trash_path"),
      ]);
      setEntries(list);
      setTotalSize(size);
      setTrashPath(path);
    } catch (err) {
      message.error("读取回收站失败: " + err);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const onRestore = async (e: TrashEntry) => {
    try {
      await invoke("restore_from_trash", {
        trashPath: e.trash_path,
        targetPath: null,
      });
      message.success(`已恢复 "${e.name}" 到原位置`);
      refresh();
      onRestored?.();
    } catch (err) {
      message.error("恢复失败: " + err);
    }
  };

  const onPermanentDelete = (e: TrashEntry) => {
    modal.confirm({
      title: "永久删除？",
      icon: <ExclamationCircleOutlined style={{ color: "#ff4d4f" }} />,
      content: (
        <span>
          将永久删除 <code>{e.name}</code>，无法恢复。确定吗？
        </span>
      ),
      okText: "永久删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await invoke("permanent_delete", { trashPath: e.trash_path });
          message.success("已永久删除");
          refresh();
        } catch (err) {
          message.error("删除失败: " + err);
        }
      },
    });
  };

  // 时间未知的条目（age_secs < 0）一律不计入，交给后端保留
  const expiredCount = entries.filter((e) => e.age_secs > RETAIN_DAYS * DAY_SECS).length;

  const onCleanExpired = () => {
    modal.confirm({
      title: "清理超期条目？",
      icon: <ExclamationCircleOutlined style={{ color: "#faad14" }} />,
      content: `将永久删除回收站中超过 ${RETAIN_DAYS} 天的条目，无法恢复。`,
      okText: "清理",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setCleaning(true);
        try {
          const r = await invoke<TrashCleanupReport>("cleanup_expired_trash", {
            retainDays: RETAIN_DAYS,
          });
          message.success(
            `已清理 ${r.removed} 项，释放 ${formatSize(r.bytes_freed)}` +
              (r.kept_unknown_age > 0 ? `；${r.kept_unknown_age} 项因时间未知被保留` : "")
          );
          refresh();
        } catch (err) {
          message.error("清理失败: " + err);
        } finally {
          setCleaning(false);
        }
      },
    });
  };

  const onEmpty = () => {
    if (entries.length === 0) return;
    modal.confirm({
      title: "清空回收站？",
      icon: <ExclamationCircleOutlined style={{ color: "#ff4d4f" }} />,
      content: `将永久删除回收站中所有 ${entries.length} 项，无法恢复。`,
      okText: "清空",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const bytes = await invoke<number>("empty_trash");
          message.success(`已清空，释放 ${formatSize(bytes)}`);
          refresh();
        } catch (err) {
          message.error("清空失败: " + err);
        }
      },
    });
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={780}
      title={
        <Space>
          <DeleteOutlined />
          <span>回收站</span>
          <span style={{ color: "var(--ant-color-text-tertiary)", fontSize: 12, fontWeight: 400 }}>
            ({entries.length} 项 · {formatSize(totalSize)})
          </span>
        </Space>
      }
      destroyOnClose
    >
      {/* 顶部信息 + 操作栏 */}
      <div
        style={{
          marginBottom: 12,
          padding: "8px 12px",
          background: "var(--ant-color-bg-layout)",
          borderRadius: 4,
          fontSize: 12,
          color: "var(--ant-color-text-secondary)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <FolderOpenOutlined />
        <span style={{ wordBreak: "break-all" }}>{trashPath}</span>
        <div style={{ flex: 1 }} />
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
          刷新
        </Button>
        <Tooltip title={`删除超过 ${RETAIN_DAYS} 天的条目`}>
          <Button
            size="small"
            icon={<ClockCircleOutlined />}
            onClick={onCleanExpired}
            loading={cleaning}
            disabled={expiredCount === 0}
          >
            清理超期{expiredCount > 0 ? ` (${expiredCount})` : ""}
          </Button>
        </Tooltip>
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={onEmpty}
          disabled={entries.length === 0}
        >
          清空回收站
        </Button>
      </div>

      {entries.length === 0 && !loading ? (
        <Empty description="回收站是空的" style={{ marginTop: 40 }} />
      ) : (
        <Table
          rowKey="trash_path"
          dataSource={entries}
          loading={loading}
          size="small"
          pagination={{ pageSize: 20, showSizeChanger: false }}
          scroll={{ y: 400 }}
          columns={[
            {
              title: "名称",
              dataIndex: "name",
              ellipsis: true,
              render: (name: string, e) => (
                <Tooltip title={e.original_path}>
                  <span style={{ fontWeight: 500 }}>{name}</span>
                  {e.is_dir && (
                    <span style={{ color: "var(--ant-color-text-tertiary)", marginLeft: 4, fontSize: 11 }}>(目录)</span>
                  )}
                </Tooltip>
              ),
            },
            {
              title: "原位置",
              dataIndex: "original_path",
              ellipsis: true,
              width: 280,
              render: (p: string) => (
                <Tooltip title={p}>
                  <span style={{ color: "var(--ant-color-text-tertiary)", fontSize: 12 }}>{p}</span>
                </Tooltip>
              ),
            },
            {
              title: "大小",
              dataIndex: "size",
              width: 90,
              align: "right",
              render: (s: number) => formatSize(s),
            },
            {
              title: (
                <span>
                  <ClockCircleOutlined /> 删除于
                </span>
              ),
              dataIndex: "age_secs",
              width: 110,
              render: (secs: number) => (
                <Tooltip title={new Date(Date.now() - secs * 1000).toLocaleString()}>
                  <span style={{ color: "var(--ant-color-text-tertiary)", fontSize: 12 }}>{formatAge(secs)}</span>
                </Tooltip>
              ),
            },
            {
              title: "操作",
              width: 130,
              render: (_: any, e: TrashEntry) => (
                <Space size="small">
                  <Button
                    type="link"
                    size="small"
                    onClick={() => onRestore(e)}
                    style={{ padding: 0 }}
                  >
                    恢复
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    danger
                    onClick={() => onPermanentDelete(e)}
                    style={{ padding: 0 }}
                  >
                    永久删
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}
