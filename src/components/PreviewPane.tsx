import { useEffect, useState } from "react";
import { Typography } from "antd";
import { FileOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useFileStore, formatTime } from "../stores/fileStore";
import { EmptyState, LoadingState } from "../_shared";
import FileContentPreview from "./FileContentPreview";

const { Text } = Typography;

interface FileInfo {
  path: string;
  size: number;
  modified: number;
  is_dir: boolean;
}

/**
 * 文件预览面板（窄条式，主表格右侧的预览）
 * - 没选文件：占位
 * - 选中文件夹：显示基本信息
 * - 选中文件：委托给 FileContentPreview（统一预览逻辑：图片/视频/音频/md/csv/json/yaml/epub/pdf/...）
 */
export default function PreviewPane({ onCollapse }: { onCollapse?: () => void } = {}) {
  const { selectedFile } = useFileStore();
  const [dirInfo, setDirInfo] = useState<FileInfo | null>(null);
  const [dirLoading, setDirLoading] = useState(false);

  // 文件夹时单独拉一次 fileInfo 显示路径/修改时间（FileContentPreview 内部
  // 只在 file.is_dir=false 时拉，且它的"文件夹"分支不展示元信息）
  useEffect(() => {
    if (selectedFile?.is_dir) {
      setDirLoading(true);
      invoke<FileInfo>("get_file_info", { path: selectedFile.path })
        .then((info) => setDirInfo(info))
        .catch(() => setDirInfo(null))
        .finally(() => setDirLoading(false));
    } else {
      setDirInfo(null);
      setDirLoading(false);
    }
  }, [selectedFile?.path, selectedFile?.is_dir]);

  if (!selectedFile) {
    return (
      <EmptyState
        title="请选择一个文件"
        description="从文件列表或文件树中选择文件以预览"
        icon={<FileOutlined style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }} />}
      />
    );
  }

  if (selectedFile.is_dir) {
    return (
      <div style={{ height: "100%", overflow: "auto", padding: 16 }}>
        <EmptyState
          title={selectedFile.name}
          description="这是一个文件夹"
          icon={<FileOutlined style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }} />}
        />
        {dirLoading && <LoadingState tip="加载中..." minHeight={120} />}
        {dirInfo && (
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <Text type="secondary">路径: {dirInfo.path}</Text>
            <br />
            <Text type="secondary">修改时间: {formatTime(dirInfo.modified)}</Text>
          </div>
        )}
      </div>
    );
  }

  return (
    <FileContentPreview
      file={selectedFile}
      showTopbar
      enableMdToggle
      onCollapse={onCollapse}
    />
  );
}
