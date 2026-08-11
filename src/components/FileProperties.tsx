import { useState, useEffect } from "react";
import { Drawer, Descriptions, Button, Spin, message, theme } from "antd";
import { CopyOutlined, DesktopOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { formatFileSize, formatTime } from "../stores/fileStore";

interface Props {
  open: boolean;
  onClose: () => void;
  filePath: string | null;
}

interface FileInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
  created: number;
  readonly: boolean;
}

interface FilePermissions {
  readonly: boolean;
  mode: number;
  readable: boolean;
  writable: boolean;
  executable: boolean;
}

function getFileTypeLabel(name: string, isDir: boolean): string {
  if (isDir) return "文件夹";
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : "";
  return ext ? `文件 (${ext})` : "文件";
}

function modeToOctal(mode: number): string {
  return "0" + (mode & 0o777).toString(8).padStart(3, "0");
}

export default function FileProperties({ open, onClose, filePath }: Props) {
  const { token } = theme.useToken();

  const [loading, setLoading] = useState(false);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [permissions, setPermissions] = useState<FilePermissions | null>(null);
  const [dirSize, setDirSize] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !filePath) {
      setFileInfo(null);
      setPermissions(null);
      setDirSize(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const info = (await invoke("get_file_info", { path: filePath })) as FileInfo;
        if (cancelled) return;
        setFileInfo(info);

        const perms = (await invoke("get_file_permissions", { path: filePath })) as FilePermissions;
        if (cancelled) return;
        setPermissions(perms);

        if (info.is_dir) {
          const size = (await invoke("get_directory_size", { path: filePath })) as number;
          if (cancelled) return;
          setDirSize(size);
        } else {
          setDirSize(null);
        }
      } catch (err) {
        if (!cancelled) {
          message.error("获取文件信息失败: " + err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, filePath]);

  const handleCopyPath = async () => {
    if (!fileInfo?.path) return;
    try {
      await navigator.clipboard.writeText(fileInfo.path);
      message.success("路径已复制");
    } catch {
      message.error("复制失败");
    }
  };

  const handleOpenWithDefault = async () => {
    if (!filePath) return;
    try {
      await invoke("open_with_default_app", { path: filePath });
    } catch (err) {
      message.error("打开失败: " + err);
    }
  };

  const BoolMark = ({ value }: { value: boolean }) => (
    <span style={{ color: value ? token.colorSuccess : token.colorError }}>
      {value ? "✓" : "✗"}
    </span>
  );

  return (
    <Drawer
      title="文件属性"
      placement="right"
      width={400}
      open={open}
      onClose={onClose}
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: "48px 0" }}>
          <Spin tip="加载中..." />
        </div>
      ) : fileInfo && permissions ? (
        <>
          <Descriptions
            title="基本信息"
            column={1}
            size="small"
            bordered
            style={{ marginBottom: token.marginLG }}
          >
            <Descriptions.Item label="文件名">{fileInfo.name}</Descriptions.Item>
            <Descriptions.Item label="路径">
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ wordBreak: "break-all", flex: 1 }}>{fileInfo.path}</span>
                <Button
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={handleCopyPath}
                />
              </div>
            </Descriptions.Item>
            <Descriptions.Item label="类型">
              {getFileTypeLabel(fileInfo.name, fileInfo.is_dir)}
            </Descriptions.Item>
            <Descriptions.Item label="大小">
              {fileInfo.is_dir && dirSize !== null
                ? formatFileSize(dirSize)
                : formatFileSize(fileInfo.size)}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {formatTime(fileInfo.created)}
            </Descriptions.Item>
            <Descriptions.Item label="修改时间">
              {formatTime(fileInfo.modified)}
            </Descriptions.Item>
          </Descriptions>

          <Descriptions
            title="权限信息"
            column={1}
            size="small"
            bordered
            style={{ marginBottom: token.marginLG }}
          >
            <Descriptions.Item label="读取">
              <BoolMark value={permissions.readable} />
            </Descriptions.Item>
            <Descriptions.Item label="写入">
              <BoolMark value={permissions.writable} />
            </Descriptions.Item>
            <Descriptions.Item label="执行">
              <BoolMark value={permissions.executable} />
            </Descriptions.Item>
            <Descriptions.Item label="只读">
              <BoolMark value={permissions.readonly} />
            </Descriptions.Item>
            <Descriptions.Item label="权限模式">
              {modeToOctal(permissions.mode)}
            </Descriptions.Item>
          </Descriptions>

          <Button
            icon={<DesktopOutlined />}
            onClick={handleOpenWithDefault}
            block
          >
            用默认应用打开
          </Button>
        </>
      ) : null}
    </Drawer>
  );
}
