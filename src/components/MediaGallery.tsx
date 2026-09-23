/**
 * 媒体库视图组件
 * 包括：照片馆、音乐馆、视频馆等专用视图
 */

import { useState, useEffect } from "react";
import { Spin, theme, Dropdown } from "antd";
import { PictureOutlined, VideoCameraOutlined, AudioOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../stores/fileStore";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatFileSize } from "../stores/fileStore";
import { toMediaItems, type MediaItem, type MediaType } from "../utils/mediaType";
import { buildMediaMenu, type MediaActions } from "../utils/mediaMenu";
import { mediaKeyAction, nextSelectedIndex } from "../utils/mediaKeys";
import {
  gridStyle,
  listGridStyle,
  type MediaGallerySize,
  type MediaViewMode,
} from "../utils/mediaLayout";

interface MediaGalleryProps {
  directory: string;
  mediaType: MediaType;
  /** 画廊=缩略图网格，列表=名称/大小/日期三列。缺省画廊 */
  viewMode?: MediaViewMode;
  /** 网格列宽档位；列表视图与音频的单列行用不上 */
  size?: MediaGallerySize;
  /** 打开：卡片双击与菜单"打开"是同一条路径 */
  onOpen?: (item: MediaItem) => void;
  onReveal?: (item: MediaItem) => void;
  /** 删除：afterDeleted 只应在"真的删掉了"之后调用，用来把这一张从画廊列表里摘掉 */
  onDelete?: (item: MediaItem, afterDeleted: () => void) => void;
}

// 获取媒体文件列表
async function fetchMediaFiles(directory: string, type: MediaType): Promise<MediaItem[]> {
  try {
    return toMediaItems(await invoke<FileEntry[]>("list_directory", { path: directory }), type);
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

/**
 * 三个卡片组件同构，共用这一份 props。
 *
 * onContextMenu 是 Dropdown 注入进来的（rc-trigger 用 cloneElement 传 props，TS 看不见调用点，
 * 所以只能标成可选），它要的签名是"参数为原生事件"。之前这里声明并按 (item, e) 调用，
 * 注入的处理器就把 MediaItem 当成事件：clientX 是 undefined、event.preventDefault() 直接抛
 * TypeError，菜单停在 (0,0)，App 侧回调永远收不到。
 */
interface MediaItemCardProps {
  item: MediaItem;
  /** 单击只选中，双击才打开 —— 与主列表 onRow.onDoubleClick、文件树、分栏同一口径 */
  onSelect: (item: MediaItem) => void;
  onOpen: (item: MediaItem) => void;
  selected: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
}

/** 选中环：三种卡片同构，配色都取主题的 colorPrimary */
function ringStyle(selected: boolean, color: string): React.CSSProperties {
  return selected ? { boxShadow: `0 0 0 2px ${color}, 0 0 0 4px rgba(0,0,0,0.15)` } : {};
}

// 图片项组件
const ImageItem: React.FC<MediaItemCardProps> = ({ item, onSelect, onOpen, selected, onContextMenu }) => {
  const { token } = theme.useToken();
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
      onClick={() => onSelect(item)}
      onDoubleClick={() => onOpen(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      style={{
        position: "relative",
        aspectRatio: "1/1",
        borderRadius: 8,
        overflow: "hidden",
        cursor: "pointer",
        background: "var(--ant-color-fill-tertiary)",
        transition: "transform 0.2s, box-shadow 0.2s",
        ...ringStyle(selected, token.colorPrimary),
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
const VideoItem: React.FC<MediaItemCardProps> = ({ item, onSelect, onOpen, selected, onContextMenu }) => {
  const { token } = theme.useToken();
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
      onClick={() => onSelect(item)}
      onDoubleClick={() => onOpen(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      style={{
        position: "relative",
        aspectRatio: "16/9",
        borderRadius: 8,
        overflow: "hidden",
        cursor: "pointer",
        background: "#000",
        transition: "transform 0.2s, box-shadow 0.2s",
        ...ringStyle(selected, token.colorPrimary),
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
const AudioItem: React.FC<MediaItemCardProps> = ({ item, onSelect, onOpen, selected, onContextMenu }) => {
  const { token } = theme.useToken();
  return (
    <div
      onClick={() => onSelect(item)}
      onDoubleClick={() => onOpen(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 16px",
        borderRadius: 8,
        cursor: "pointer",
        transition: "background 0.2s",
        background: selected ? token.colorFillSecondary : "transparent",
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

// 列表视图的一行：与卡片共用同一套激活口径（单击选中、双击打开、右键同一份菜单）
const ListRow: React.FC<MediaItemCardProps & { icon: React.ReactNode }> = ({
  item,
  onSelect,
  onOpen,
  selected,
  onContextMenu,
  icon,
}) => {
  const { token } = theme.useToken();
  return (
    <div
      onClick={() => onSelect(item)}
      onDoubleClick={() => onOpen(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      role="row"
      aria-selected={selected}
      title={item.path}
      style={{
        ...listGridStyle(),
        padding: "6px 16px",
        borderRadius: 6,
        cursor: "pointer",
        background: selected ? token.colorFillSecondary : "transparent",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
          color: token.colorText,
        }}
      >
        <span style={{ color: token.colorPrimary, flex: "0 0 auto" }}>{icon}</span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.name}
        </span>
      </div>
      <div style={{ textAlign: "right", color: token.colorTextSecondary, fontSize: 12 }}>
        {item.metadata?.size ? formatFileSize(item.metadata.size) : "-"}
      </div>
      <div style={{ textAlign: "right", color: token.colorTextTertiary, fontSize: 12 }}>
        {item.metadata?.date || "-"}
      </div>
    </div>
  );
};

// 媒体画廊主组件
export const MediaGallery: React.FC<MediaGalleryProps> = ({
  directory,
  mediaType,
  viewMode = "gallery",
  size = "medium",
  onOpen,
  onReveal,
  onDelete,
}) => {
  const { token } = theme.useToken();
  const [mediaFiles, setMediaFiles] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    setSelectedPath(null); // 换目录/换馆之后，上一张的选中环没有意义，还可能指着一个不存在的路径
    if (!directory) {
      // 目录为空时不能把 loading 留在 true：那是个转不完的圈，界面没有任何出口
      setMediaFiles([]);
      setLoading(false);
      return;
    }
    // 切馆（照片馆→视频馆）会并发两次拉取，后到的旧响应会把新结果盖掉
    let alive = true;
    fetchMediaFiles(directory, mediaType).then((files) => {
      if (!alive) return;
      setMediaFiles(files);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [directory, mediaType]);

  // 卡片双击与菜单里的"打开"走同一个函数：分两处写迟早只改一处
  const handleOpen = (item: MediaItem) => {
    if (onOpen) {
      onOpen(item);
    } else {
      // 默认打开方式
      invoke("open_with_default_app", { path: item.path }).catch(console.error);
    }
  };

  const actions: MediaActions = {
    onOpen,
    onReveal,
    // 删除是真异步的（确认框 + invoke），所以由调用方在"确实删掉了"之后回调
    // afterDeleted —— 主列表会刷新，但画廊自己那份列表不清的话，刚删的那一张
    // 会继续留在原地，再点它就是"文件不存在"。
    onDelete: onDelete
      ? (item) =>
          onDelete(item, () => {
            setMediaFiles((files) => files.filter((f) => f.path !== item.path));
            setSelectedPath((cur) => (cur === item.path ? null : cur));
          })
      : undefined,
  };

  const cardProps = (item: MediaItem) => ({
    item,
    selected: selectedPath === item.path,
    onSelect: (one: MediaItem) => setSelectedPath(one.path),
    onOpen: handleOpen,
  });

  /**
   * 每一项都从这儿过一遍右键菜单：网格、列表共用同一条接线，
   * 免得"卡片有菜单、列表没有"这种只在某一种版式下响的口径分叉。
   */
  const withMenu = (item: MediaItem, node: React.ReactElement) => (
    <Dropdown
      key={item.path}
      menu={{ items: buildMediaMenu(item, actions) }}
      trigger={["contextMenu"]}
    >
      {node}
    </Dropdown>
  );

  // 渲染网格
  const renderGrid = () => {
    switch (mediaType) {
      case "image":
        return (
          <div style={gridStyle("image", size)}>
            {mediaFiles.map((item) => withMenu(item, <ImageItem {...cardProps(item)} />))}
          </div>
        );

      case "video":
        return (
          <div style={gridStyle("video", size)}>
            {mediaFiles.map((item) => withMenu(item, <VideoItem {...cardProps(item)} />))}
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
            {mediaFiles.map((item) => withMenu(item, <AudioItem {...cardProps(item)} />))}
          </div>
        );
    }
  };

  // 渲染列表：名称/大小/修改时间三列，缩略图没加载出来的版式下反而看得清东西
  const renderList = () => {
    const icon =
      mediaType === "image" ? (
        <PictureOutlined />
      ) : mediaType === "video" ? (
        <VideoCameraOutlined />
      ) : (
        <AudioOutlined />
      );
    return (
      <div style={{ padding: "8px 0" }} role="table" aria-label={`${mediaType} 列表`}>
        <div
          style={{
            ...listGridStyle(),
            padding: "4px 16px 8px",
            color: token.colorTextTertiary,
            fontSize: 12,
          }}
        >
          <div>名称</div>
          <div style={{ textAlign: "right" }}>大小</div>
          <div style={{ textAlign: "right" }}>修改时间</div>
        </div>
        {mediaFiles.map((item) => withMenu(item, <ListRow {...cardProps(item)} icon={icon} />))}
      </div>
    );
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

  const selectedIndex = mediaFiles.findIndex((f) => f.path === selectedPath);

  /**
   * 键盘口径与主列表对齐：Enter 打开、⌘⌫/Delete 移到回收站、←/→ 换选中。
   * 没有选中项时"打开/删除"什么都不做也不吃掉按键；Esc 只在有选中时清选中并挡住冒泡，
   * 没选中就让它去关弹窗 —— 和 Finder 的习惯一致。
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const action = mediaKeyAction(e);
    if (!action) return;
    if (action === "clear") {
      if (selectedIndex < 0) return;
      e.stopPropagation();
      e.preventDefault();
      setSelectedPath(null);
      return;
    }
    const one = mediaFiles[selectedIndex];
    if (action === "open") {
      if (!one) return;
      e.preventDefault();
      handleOpen(one);
      return;
    }
    if (action === "delete") {
      if (!one || !actions.onDelete) return;
      e.preventDefault();
      actions.onDelete(one);
      return;
    }
    e.preventDefault();
    const moved = mediaFiles[nextSelectedIndex(selectedIndex, mediaFiles.length, action)];
    if (moved) setSelectedPath(moved.path);
  };

  return (
    <div
      tabIndex={0}
      role="listbox"
      aria-label="媒体库"
      onKeyDown={onKeyDown}
      style={{
        height: "100%",
        overflow: "auto",
        padding: "8px",
        outline: "none",
      }}
    >
      {viewMode === "list" ? renderList() : renderGrid()}
    </div>
  );
};
