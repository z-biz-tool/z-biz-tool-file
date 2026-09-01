/**
 * 媒体库视图组件
 * 包括：照片馆、音乐馆、视频馆等专用视图
 */

import { useState, useEffect, useMemo } from "react";
import { Spin, theme, Image, Dropdown, type MenuProps } from "antd";
import { PictureOutlined, VideoCameraOutlined, AudioOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { getFileType, type FileEntry } from "../stores/fileStore";
import { getFileTypeVisual } from "../utils/fileTypeIcon";
import { convertFileSrc } from "@tauri-apps/api/core";

// 媒体类型枚举
export type MediaType = "image" | "video" | "audio";

interface MediaItem {
  path: string;
  name: string;
  type: MediaType;
  thumbnail?: string;
  metadata?: {
    duration?: string;
    resolution?: string;
    size?: number;
    date?: string;
  };
}

interface MediaGalleryProps {
  directory: string;
  mediaType: MediaType;
  onItemDoubleClick?: (item: MediaItem) => void;
  onItemRightClick?: (item: MediaItem, e: React.MouseEvent) => void;
}

// 获取媒体文件列表
async function fetchMediaFiles(directory: string, type: MediaType): Promise<MediaItem[]> {
  try {
    const files = await invoke<FileEntry[]>("list_directory", { path: directory });
    
    const mediaItems: MediaItem[] = [];
    
    for (const file of files) {
      if (!file.is_dir) {
        const fileType = getFileType(file.name);
        let mediaType: MediaType | null = null;
        
        if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"].includes(fileType)) {
          mediaType = "image";
        } else if (["mp4", "webm", "ogg", "mov", "avi", "mkv"].includes(fileType)) {
          mediaType = "video";
        } else if (["mp3", "wav", "flac", "aac", "m4a", "wma"].includes(fileType)) {
          mediaType = "audio";
        }
        
        if (mediaType && mediaType === type) {
          mediaItems.push({
            path: file.path,
            name: file.name,
            type: mediaType,
            metadata: {
              size: file.size,
              date: new Date(file.modified * 1000).toLocaleDateString(),
            },
          });
        }
      }
    }
    
    return mediaItems;
  } catch (error) {
    console.error(`Failed to fetch ${type} files:`, error);
    return [];
  }
}

// 获取图片缩略图
async function getImageThumbnail(path: string): Promise<string | undefined> {
  try {
    const result = await invoke<{ data: string }>("get_image_thumbnail", {
      path,
      maxSize: 300,
    });
    return `data:image/png;base64,${result.data}`;
  } catch (error) {
    return undefined;
  }
}

// 获取视频缩略图
async function getVideoThumbnail(path: string): Promise<string | undefined> {
  try {
    const result = await invoke<{ thumb_path: string }>("get_video_thumbnail", { path });
    return convertFileSrc(result.thumb_path);
  } catch (error) {
    return undefined;
  }
}

// 获取音频图标
function getAudioIcon(metadata?: MediaItem["metadata"]) {
  return (
    <div style={{ textAlign: "center", padding: "20px 10px" }}>
      <AudioOutlined style={{ fontSize: 48, color: "#1677ff" }} />
      {metadata?.duration && (
        <div style={{ fontSize: 12, color: "#8c8c8c", marginTop: 4 }}>
          {metadata.duration}
        </div>
      )}
    </div>
  );
}

// 图片项组件
const ImageItem: React.FC<{
  item: MediaItem;
  onClick: (item: MediaItem) => void;
  onContextMenu: (item: MediaItem, e: React.MouseEvent) => void;
}> = ({ item, onClick, onContextMenu }) => {
  const [thumbnail, setThumbnail] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!thumbnail) {
      getImageThumbnail(item.path).then((url) => {
        setThumbnail(url);
        setLoading(false);
      });
    }
  }, [item.path, thumbnail]);

  return (
    <div
      onClick={() => onClick(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(item, e);
      }}
      style={{
        position: "relative",
        aspectRatio: "1/1",
        borderRadius: 8,
        overflow: "hidden",
        cursor: "pointer",
        background: "#f0f0f0",
        transition: "transform 0.2s, box-shadow 0.2s",
      }}
      title={item.name}
    >
      {loading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Spin size="small" />
        </div>
      )}
      
      {thumbnail && <img src={thumbnail} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(to-top, rgba(0,0,0,0.6), transparent)",
          display: "flex",
          alignItems: "flex-end",
          padding: "8px",
        }}
      >
        <div
          style={{
            color: "white",
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.name}
        </div>
      </div>
    </div>
  );
};

// 视频项组件
const VideoItem: React.FC<{
  item: MediaItem;
  onClick: (item: MediaItem) => void;
  onContextMenu: (item: MediaItem, e: React.MouseEvent) => void;
}> = ({ item, onClick, onContextMenu }) => {
  const [thumbnail, setThumbnail] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!thumbnail) {
      getVideoThumbnail(item.path).then((url) => {
        setThumbnail(url);
        setLoading(false);
      });
    }
  }, [item.path, thumbnail]);

  return (
    <div
      onClick={() => onClick(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(item, e);
      }}
      style={{
        position: "relative",
        aspectRatio: "16/9",
        borderRadius: 8,
        overflow: "hidden",
        cursor: "pointer",
        background: "#000",
        transition: "transform 0.2s, box-shadow 0.2s",
      }}
      title={item.name}
    >
      {loading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Spin size="small" />
        </div>
      )}
      
      {thumbnail && <img src={thumbnail} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          background: "rgba(0,0,0,0.7)",
          padding: "2px 8px",
          borderRadius: 4,
        }}
      >
        <VideoCameraOutlined style={{ color: "white", fontSize: 14 }} />
      </div>
      
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(to-top, rgba(0,0,0,0.8), transparent)",
          display: "flex",
          alignItems: "flex-end",
          padding: "12px",
        }}
      >
        <div
          style={{
            color: "white",
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.name}
        </div>
      </div>
    </div>
  );
};

// 音频项组件
const AudioItem: React.FC<{
  item: MediaItem;
  onClick: (item: MediaItem) => void;
  onContextMenu: (item: MediaItem, e: React.MouseEvent) => void;
}> = ({ item, onClick, onContextMenu }) => {
  return (
    <div
      onClick={() => onClick(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(item, e);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 16px",
        borderRadius: 8,
        cursor: "pointer",
        transition: "background 0.2s",
        background: "transparent",
      }}
      title={item.name}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 8,
          background: "#e6f4ff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <AudioOutlined style={{ fontSize: 28, color: "#1677ff" }} />
      </div>
      
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.name}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#8c8c8c",
            marginTop: 2,
          }}
        >
          {item.metadata?.size ? formatFileSize(item.metadata.size) : ""} •{" "}
          {item.metadata?.date || ""}
        </div>
      </div>
    </div>
  );
};

// 格式化文件大小
function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// 媒体画廊主组件
export const MediaGallery: React.FC<MediaGalleryProps> = ({
  directory,
  mediaType,
  onItemDoubleClick,
  onItemRightClick,
}) => {
  const { token } = theme.useToken();
  const [mediaFiles, setMediaFiles] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (directory) {
      fetchMediaFiles(directory, mediaType).then((files) => {
        setMediaFiles(files);
        setLoading(false);
      });
    }
  }, [directory, mediaType]);

  const handleItemDoubleClick = (item: MediaItem) => {
    if (onItemDoubleClick) {
      onItemDoubleClick(item);
    } else {
      // 默认打开方式
      invoke("open_with_default_app", { path: item.path }).catch(console.error);
    }
  };

  const handleItemContextMenu = (item: MediaItem, e: React.MouseEvent) => {
    if (onItemRightClick) {
      onItemRightClick(item, e);
    }
  };

  // 右键菜单
  const contextMenu = useMemo((): MenuProps => {
    return {
      items: [
        { key: "open", label: "打开" },
        { key: "reveal", label: "在 Finder 中显示" },
        { type: "divider" },
        { key: "delete", label: "删除" },
      ],
    };
  }, []);

  // 渲染网格
  const renderGrid = () => {
    switch (mediaType) {
      case "image":
        return (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: 16,
              padding: 16,
            }}
          >
            {mediaFiles.map((item, index) => (
              <Dropdown key={index} menu={contextMenu} trigger={["contextMenu"]}>
                <ImageItem
                  item={item}
                  onClick={handleItemDoubleClick}
                  onContextMenu={handleItemContextMenu}
                />
              </Dropdown>
            ))}
          </div>
        );

      case "video":
        return (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: 16,
              padding: 16,
            }}
          >
            {mediaFiles.map((item, index) => (
              <Dropdown key={index} menu={contextMenu} trigger={["contextMenu"]}>
                <VideoItem
                  item={item}
                  onClick={handleItemDoubleClick}
                  onContextMenu={handleItemContextMenu}
                />
              </Dropdown>
            ))}
          </div>
        );

      case "audio":
        return (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
            }}
          >
            {mediaFiles.map((item, index) => (
              <Dropdown key={index} menu={contextMenu} trigger={["contextMenu"]}>
                <AudioItem
                  item={item}
                  onClick={handleItemDoubleClick}
                  onContextMenu={handleItemContextMenu}
                />
              </Dropdown>
            ))}
          </div>
        );
    }
  };

  if (loading) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Spin size="large" tip="正在加载媒体文件..." />
      </div>
    );
  }

  if (mediaFiles.length === 0) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          color: token.colorTextTertiary,
        }}
      >
        {mediaType === "image" && <PictureOutlined style={{ fontSize: 64, marginBottom: 16 }} />}
        {mediaType === "video" && <VideoCameraOutlined style={{ fontSize: 64, marginBottom: 16 }} />}
        {mediaType === "audio" && <AudioOutlined style={{ fontSize: 64, marginBottom: 16 }} />}
        <div>该目录下没有{mediaType === "image" ? "图片" : mediaType === "video" ? "视频" : "音频"}文件</div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        padding: "8px",
      }}
    >
      {renderGrid()}
    </div>
  );
};

// 按媒体类型渲染的快捷组件
export const PhotoGallery: React.FC<Omit<MediaGalleryProps, "mediaType">> = (props) => (
  <MediaGallery mediaType="image" {...props} />
);

export const VideoGallery: React.FC<Omit<MediaGalleryProps, "mediaType">> = (props) => (
  <MediaGallery mediaType="video" {...props} />
);

export const MusicGallery: React.FC<Omit<MediaGalleryProps, "mediaType">> = (props) => (
  <MediaGallery mediaType="audio" {...props} />
);
