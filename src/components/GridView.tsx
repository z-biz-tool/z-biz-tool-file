import { useState, useEffect, useRef, useCallback } from "react";
import { Spin, theme } from "antd";
import { FileImageOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { getFileType, type FileEntry } from "../stores/fileStore";
import { getFileTypeVisual } from "../utils/fileTypeIcon";
import { convertFileSrc } from "@tauri-apps/api/core";

interface ThumbnailCache {
  [path: string]: string; // base64 data URL (for images) OR asset URL (for video thumbs)
}

const ThumbnailBox: React.FC<{
  path: string;
  kind: "image" | "video";
  cache: ThumbnailCache;
  setCache: (p: string, v: string) => void;
}> = ({ path, kind, cache, setCache }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (cache[path]) return;
    let cancelled = false;
    setLoading(true);

    if (kind === "image") {
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
    } else {
      // 视频缩略图：调 ffmpeg
      invoke<{ thumb_path: string }>("get_video_thumbnail", { path })
        .then((res) => {
          if (!cancelled) {
            // 用 convertFileSrc 把本地路径转 webview 可访问的 URL
            setCache(path, convertFileSrc(res.thumb_path));
          }
        })
        .catch(() => {
          if (!cancelled) setError(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [path, kind, cache, setCache]);

  if (error) {
    return kind === "image" ? (
      <FileImageOutlined style={{ fontSize: 36, color: "#8c8c8c" }} />
    ) : (
      <VideoCameraOutlined style={{ fontSize: 36, color: "#8c8c8c" }} />
    );
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
  // 用统一的 fileTypeIcon 工具拿到"颜色 + 图标"，和表格/列表视图保持一致
  const visual = getFileTypeVisual(entry.name, entry.is_dir);
  return (
    <span style={{ color: visual.color, fontSize: 38, lineHeight: 1 }}>
      {visual.icon}
    </span>
  );
};

type ViewMode = "table" | "grid" | "list" | "column";

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
          const fileType = !entry.is_dir ? getFileType(entry.name) : null;
          const isImage = fileType === "image";
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
                  <ThumbnailBox path={entry.path} kind="image" cache={thumbCache} setCache={setCache} />
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
        const fileType = !entry.is_dir ? getFileType(entry.name) : null;
        const isImage = fileType === "image";
        const isVideo = fileType === "video";
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
              {isImage || isVideo ? (
                <ThumbnailBox
                  path={entry.path}
                  kind={isVideo ? "video" : "image"}
                  cache={thumbCache}
                  setCache={setCache}
                />
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
