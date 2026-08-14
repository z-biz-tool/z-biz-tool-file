import { useState, useEffect, useCallback } from "react";
import { Modal, Table, Button, message, Spin, theme } from "antd";
import { FolderOutlined, FileOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { formatFileSize } from "../stores/fileStore";

interface ZipEntry {
  name: string;
  size: number;
  is_dir: boolean;
  modified: number;
}

interface ZipBrowserProps {
  open: boolean;
  onClose: () => void;
  zipPath: string | null;
  currentPath: string;
  onRefresh: () => void;
}

export default function ZipBrowser({
  open,
  onClose,
  zipPath,
  currentPath,
  onRefresh,
}: ZipBrowserProps) {
  const [entries, setEntries] = useState<ZipEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const { token } = theme.useToken();

  const loadContents = useCallback(async () => {
    if (!zipPath) return;
    setLoading(true);
    try {
      const result = await invoke<ZipEntry[]>("list_zip_contents", {
        zipPath,
      });
      setEntries(result);
    } catch (err) {
      message.error("读取ZIP内容失败: " + err);
    } finally {
      setLoading(false);
    }
  }, [zipPath]);

  useEffect(() => {
    if (open && zipPath) {
      loadContents();
    }
    if (!open) {
      setEntries([]);
    }
  }, [open, zipPath, loadContents]);

  const handleExtractFile = useCallback(
    async (entry: ZipEntry) => {
      if (entry.is_dir) return;
      setExtracting(true);
      try {
        await invoke("extract_zip_file", {
          zipPath,
          entryName: entry.name,
          destDir: currentPath,
        });
        message.success(`已解压: ${entry.name}`);
        onRefresh();
      } catch (err) {
        message.error("解压失败: " + err);
      } finally {
        setExtracting(false);
      }
    },
    [zipPath, currentPath, onRefresh]
  );

  const handleExtractAll = useCallback(async () => {
    if (!zipPath) return;
    setExtracting(true);
    try {
      await invoke("extract_zip", {
        zipPath,
        destDir: currentPath,
      });
      message.success("全部解压完成");
      onRefresh();
    } catch (err) {
      message.error("解压失败: " + err);
    } finally {
      setExtracting(false);
    }
  }, [zipPath, currentPath, onRefresh]);

  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      ellipsis: true,
      render: (name: string, record: ZipEntry) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {record.is_dir ? (
            <FolderOutlined style={{ color: token.colorWarning }} />
          ) : (
            <FileOutlined style={{ color: token.colorTextSecondary }} />
          )}
          {name}
        </span>
      ),
    },
    {
      title: "大小",
      dataIndex: "size",
      key: "size",
      width: 100,
      render: (size: number, record: ZipEntry) =>
        record.is_dir ? "-" : formatFileSize(size),
    },
    {
      title: "类型",
      key: "type",
      width: 80,
      render: (_: unknown, record: ZipEntry) =>
        record.is_dir ? "文件夹" : "文件",
    },
    {
      title: "修改时间",
      dataIndex: "modified",
      key: "modified",
      width: 180,
      render: (modified: number) => {
        if (!modified) return "-";
        const date = new Date(modified * 1000);
        return date.toLocaleString("zh-CN");
      },
    },
  ];

  return (
    <Modal
      title={
        <span>
          ZIP 浏览器
          {zipPath && (
            <span
              style={{
                fontSize: 12,
                color: token.colorTextSecondary,
                marginLeft: 8,
              }}
            >
              {zipPath}
            </span>
          )}
        </span>
      }
      open={open}
      onCancel={onClose}
      width={700}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>关闭</Button>
          <Button
            type="primary"
            onClick={handleExtractAll}
            loading={extracting}
            disabled={entries.length === 0}
          >
            全部解压
          </Button>
        </div>
      }
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <Spin size="large" />
          <div
            style={{
              marginTop: 12,
              color: token.colorTextSecondary,
            }}
          >
            正在读取ZIP内容...
          </div>
        </div>
      ) : (
        <Table
          columns={columns}
          dataSource={entries.map((e, i) => ({ ...e, key: i }))}
          size="small"
          pagination={entries.length > 50 ? { pageSize: 50 } : false}
          scroll={{ y: 400 }}
          onRow={(record) => ({
            onDoubleClick: () => handleExtractFile(record),
            style: { cursor: record.is_dir ? "default" : "pointer" },
          })}
        />
      )}
    </Modal>
  );
}
