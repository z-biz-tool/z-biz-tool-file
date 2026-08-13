import { useState, useEffect, useRef, useCallback } from "react";
import { Spin, theme } from "antd";
import {
  FolderOutlined, FileOutlined,
  FileImageOutlined, FilePdfOutlined,
  FileZipOutlined, FileTextOutlined,
  VideoCameraOutlined, SoundOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { getFileType, type FileEntry } from "../stores/fileStore";

interface ThumbnailCache {
  [path: string]: string; // base64 data URL
}

const ThumbnailImg: React.FC<{ path: string; cache: ThumbnailCache; setCache: (p: string, v: string) => void }> = ({
  path,
  cache,
  setCache,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (cache[path]) return;
    let cancelled = false;
    setLoading(true);
    invoke<{ data: string; width: number; height: number }>("get_image_thumbnail", {
      path,
      maxSize: 200,
    })
      .then((res) => {
        if (!cancelled) {
          setCache(path, `data:image/png;base64,${res.data}`);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, cache, setCache]);

  if (error) {
    return <FileImageOutlined style={{ fontSize: 36, color: "#8c8c8c" }} />;
  }
  if (loading || !cache[path]) {
    return <Spin size="small" />;
  }
  return (
    <img
      src={cache[path]}
      alt=""
      style={{
        maxWidth: "100%",
        maxHeight: "100%",
        objectFit: "contain",
      }}
      draggable={false}
    />
  );
};

const getIcon = (entry: FileEntry) => {
  if (entry.is_dir) return <FolderOutlined style={{ fontSize: 38, color: "#faad14" }} />;
  const type = getFileType(entry.name);
  switch (type) {
    case "image":
      return <FileImageOutlined style={{ fontSize: 38, color: "#1677ff" }} />;
    case "video":
      return <VideoCameraOutlined style={{ fontSize: 38, color: "#722ed1" }} />;
    case "audio":
      return <SoundOutlined style={{ fontSize: 38, color: "#13c2c2" }} />;
    case "pdf":
      return <FilePdfOutlined style={{ fontSize: 38, color: "#f5222d" }} />;
    case "doc":
    case "markdown":
    case "text":
      return <FileTextOutlined style={{ fontSize: 38, color: "#52c41a" }} />;
    default:
      if (entry.name.endsWith(".zip")) {
        return <FileZipOutlined style={{ fontSize: 38, color: "#fa8c16" }} />;
      }
      return <FileOutlined style={{ fontSize: 38, color: "#8c8c8c" }} />;
  }
};

type ViewMode = "table" | "grid" | "list";

interface GridViewProps {
  mode: ViewMode;
  files: FileEntry[];
  selectedFile: FileEntry | null;
  selectedRowKeys: React.Key[];
  onClick: (entry: FileEntry) => void;
  onDoubleClick?: (entry: FileEntry) => void;
  onContextMenu?: (entry: FileEntry, e: React.MouseEvent) => void;
  onDragStart?: (entry: FileEntry, e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

export default function GridView({
  mode,
  files,
  selectedFile,
  selectedRowKeys,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: GridViewProps) {
  const { token } = theme.useToken();
  const [thumbCache, setThumbCache] = useState<ThumbnailCache>({});
  const cacheRef = useRef(thumbCache);
  cacheRef.current = thumbCache;

  const setCache = useCallback((path: string, dataUrl: string) => {
    setThumbCache((prev) => ({ ...prev, [path]: dataUrl }));
  }, []);

  if (mode === "table") {
    // 表格视图由调用方使用 antd Table 渲染
    return null;
  }

  // 列表模式：每行 1 个项，紧凑
  if (mode === "list") {
    return (
      <div style={{ padding: 8 }}>
        {files.map((entry) => {
          const isSelected = selectedFile?.path === entry.path || selectedRowKeys.includes(entry.path);
          const isImage = !entry.is_dir && getFileType(entry.name) === "image";
          return (
            <div
              key={entry.path}
              draggable
              onDragStart={(e) => onDragStart?.(entry, e)}
              onDragEnd={onDragEnd}
              onClick={() => onClick(entry)}
              onDoubleClick={() => onDoubleClick?.(entry)}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu?.(entry, e);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 12px",
                borderRadius: 6,
                cursor: "pointer",
                background: isSelected ? token.colorPrimaryBg : "transparent",
                marginBottom: 4,
                border: `1px solid ${isSelected ? token.colorPrimary : "transparent"}`,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  overflow: "hidden",
                  borderRadius: 4,
                  background: token.colorFillTertiary,
                }}
              >
                {isImage ? (
                  <ThumbnailImg path={entry.path} cache={thumbCache} setCache={setCache} />
                ) : (
                  getIcon(entry)
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: isSelected ? 600 : 400,
                    color: token.colorText,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={entry.name}
                >
                  {entry.name}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // grid 视图
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
        gap: 8,
        padding: 8,
      }}
    >
      {files.map((entry) => {
        const isSelected = selectedFile?.path === entry.path || selectedRowKeys.includes(entry.path);
        const isImage = !entry.is_dir && getFileType(entry.name) === "image";
        return (
          <div
            key={entry.path}
            draggable
            onDragStart={(e) => onDragStart?.(entry, e)}
            onDragEnd={onDragEnd}
            onClick={() => onClick(entry)}
            onDoubleClick={() => onDoubleClick?.(entry)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu?.(entry, e);
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              padding: 8,
              borderRadius: 6,
              cursor: "pointer",
              background: isSelected ? token.colorPrimaryBg : "transparent",
              border: `1px solid ${isSelected ? token.colorPrimary : "transparent"}`,
              transition: "background 0.15s",
              userSelect: "none",
            }}
            title={entry.name}
          >
            <div
              style={{
                width: 90,
                height: 90,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
                borderRadius: 4,
                background: token.colorFillTertiary,
                marginBottom: 6,
              }}
            >
              {isImage ? (
                <ThumbnailImg path={entry.path} cache={thumbCache} setCache={setCache} />
              ) : (
                getIcon(entry)
              )}
            </div>
            <div
              style={{
                fontSize: 12,
                textAlign: "center",
                wordBreak: "break-all",
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                lineHeight: 1.3,
                maxHeight: 32,
                color: token.colorText,
                fontWeight: isSelected ? 600 : 400,
              }}
            >
              {entry.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}
