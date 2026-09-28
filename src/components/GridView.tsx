import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Empty, Spin, theme } from "antd";
import { FileImageOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getFileType, type FileEntry } from "../stores/fileStore";
import { getFileTypeVisual } from "../utils/fileTypeIcon";
import { computeWindow, createLru, scrollIndexIntoView, toKeySet } from "../utils/virtualList";
import { virtualScrollConfig } from "../_shared/animations";

/** 固定行高：窗口计算的前提，渲染样式必须与之一致 */
const GRID_ROW_HEIGHT = 152;
const LIST_ROW_HEIGHT = 60;
const GRID_MIN_COLUMN_WIDTH = 128;
/** 缩略图在 JS 堆里是 base64 字符串，封顶后才敢让大目录随便翻 */
const THUMB_CACHE_ENTRIES = 320;

const thumbCache = createLru<string>(THUMB_CACHE_ENTRIES);
/** 同一张图被两个组件同时请求过一次就够（来回滚动时很容易撞上） */
const thumbInflight = new Map<string, Promise<string>>();

type ThumbKind = "image" | "video";

function requestThumbnail(path: string, kind: ThumbKind): Promise<string> {
  const hit = thumbCache.get(path);
  if (hit) return Promise.resolve(hit);
  const pending = thumbInflight.get(path);
  if (pending) return pending;
  const task =
    kind === "image"
      ? invoke<{ data: string }>("get_image_thumbnail", { path, maxSize: 200 }).then(
          (res) => `data:image/png;base64,${res.data}`
        )
      : invoke<{ thumb_path: string }>("get_video_thumbnail", { path }).then((res) =>
          convertFileSrc(res.thumb_path)
        );
  const tracked = task.then((url) => {
    thumbCache.set(path, url);
    thumbInflight.delete(path);
    return url;
  });
  tracked.catch(() => thumbInflight.delete(path));
  thumbInflight.set(path, tracked);
  return tracked;
}

const ThumbnailBox: React.FC<{ path: string; kind: ThumbKind }> = ({ path, kind }) => {
  const [state, setState] = useState<{ url?: string; error?: boolean; loading: boolean }>({
    url: thumbCache.get(path),
    loading: !thumbCache.get(path),
  });

  useEffect(() => {
    const cached = thumbCache.get(path);
    if (cached) {
      setState({ url: cached, loading: false });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    requestThumbnail(path, kind)
      .then((url) => {
        if (!cancelled) setState({ url, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ error: true, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [path, kind]);

  if (state.error) {
    return kind === "image" ? (
      <FileImageOutlined style={{ fontSize: 36, color: "#8c8c8c" }} />
    ) : (
      <VideoCameraOutlined style={{ fontSize: 36, color: "#8c8c8c" }} />
    );
  }
  if (state.loading || !state.url) return <Spin size="small" />;
  return (
    <img
      src={state.url}
      alt=""
      loading="lazy"
      style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
      draggable={false}
    />
  );
};

const TypeIcon: React.FC<{ entry: FileEntry }> = ({ entry }) => {
  const visual = getFileTypeVisual(entry.name, entry.is_dir);
  return <span style={{ color: visual.color, fontSize: 38, lineHeight: 1 }}>{visual.icon}</span>;
};

const thumbKind = (entry: FileEntry): ThumbKind | null => {
  if (entry.is_dir) return null;
  const type = getFileType(entry.name);
  return type === "image" ? "image" : type === "video" ? "video" : null;
};

interface RowProps {
  entry: FileEntry;
  mode: "grid" | "list";
  selected: boolean;
  colorPrimary: string;
  colorPrimaryBg: string;
  colorText: string;
  colorFillTertiary: string;
  onClick: (entry: FileEntry) => void;
  onDoubleClick?: (entry: FileEntry) => void;
  onContextMenu?: (entry: FileEntry, e: React.MouseEvent) => void;
  onDragStart?: (entry: FileEntry, e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

/**
 * 单个条目。memo 掉是为了"选中一项只重渲染那一行"，
 * 而不是整个目录的几千行跟着重算一遍。
 */
const EntryRow = React.memo(function EntryRow({
  entry,
  mode,
  selected,
  colorPrimary,
  colorPrimaryBg,
  colorText,
  colorFillTertiary,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: RowProps) {
  const { token } = theme.useToken();
  const kind = thumbKind(entry);
  const common = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => onDragStart?.(entry, e),
    onDragEnd,
    onClick: () => onClick(entry),
    onDoubleClick: () => onDoubleClick?.(entry),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu?.(entry, e);
    },
  };
  const boxStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
    borderRadius: 4,
    background: colorFillTertiary,
  };

  if (mode === "list") {
    return (
      <div
        {...common}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          height: LIST_ROW_HEIGHT - 4,
          marginBottom: 4,
          padding: "0 12px",
          borderRadius: 6,
          cursor: "pointer",
          background: selected ? colorPrimaryBg : "transparent",
          border: `1px solid ${selected ? colorPrimary : "transparent"}`,
        }}
      >
        <div style={{ ...boxStyle, width: 40, height: 40 }}>
          {kind ? <ThumbnailBox path={entry.path} kind={kind} /> : <TypeIcon entry={entry} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: selected ? 600 : 400,
              color: colorText,
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
  }

  return (
    <div
      {...common}
      title={entry.name}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        height: GRID_ROW_HEIGHT - 8,
        padding: 8,
        borderRadius: 6,
        cursor: "pointer",
        background: selected ? colorPrimaryBg : "transparent",
        border: `1px solid ${selected ? colorPrimary : "transparent"}`,
        userSelect: "none",
        overflow: "hidden",
      }}
    >
      <div style={{ ...boxStyle, width: 90, height: 90, marginBottom: 6 }}>
        {kind ? <ThumbnailBox path={entry.path} kind={kind} /> : <TypeIcon entry={entry} />}
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
          color: colorText,
          fontWeight: selected ? 600 : 400,
        }}
      >
        {entry.name}
      </div>
      {/* token 只用一次，保证主题切换后 memo 也会跟着更新 */}
      <span hidden style={{ color: token.colorTextDescription }} />
    </div>
  );
});

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
  const rootRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const isGrid = mode === "grid";
  const rowHeight = isGrid ? GRID_ROW_HEIGHT : LIST_ROW_HEIGHT;
  const columns = isGrid
    ? Math.max(1, Math.floor((viewport.width || GRID_MIN_COLUMN_WIDTH * 4) / GRID_MIN_COLUMN_WIDTH))
    : 1;

  // 尺寸变化只走 ResizeObserver，窗口缩放时列数才会跟着变（不监听 window.resize）
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      setViewport({ width: box?.width ?? 0, height: box?.height ?? 0 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  // 滚动事件按帧合并：一次惯性滚动可能上百次事件，每次都重算窗口就是白扔帧
  const handleScroll = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setScrollTop(el.scrollTop);
    });
  }, []);
  const rafRef = useRef(0);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const win = computeWindow({
    itemCount: files.length,
    columns,
    rowHeight,
    scrollTop,
    viewportHeight: viewport.height,
    bufferRows: virtualScrollConfig.bufferSize > 100 ? 4 : 4,
  });

  // 键盘上下键换了选中项：把那一行滚进视口，否则焦点悄悄跑出屏幕
  const selectedPath = selectedFile?.path ?? null;
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !selectedPath) return;
    const index = files.findIndex((f) => f.path === selectedPath);
    if (index < 0) return;
    const next = scrollIndexIntoView(index, {
      itemCount: files.length,
      columns,
      rowHeight,
      scrollTop: el.scrollTop,
      viewportHeight: viewport.height,
      currentScrollTop: el.scrollTop,
    });
    if (next !== el.scrollTop) el.scrollTop = next;
  }, [selectedPath, files, columns, rowHeight, viewport.height]);

  // 换目录后旧窗口可能停在几百行之外：回到顶部，别让用户看到空白屏
  useEffect(() => {
    if (rootRef.current) rootRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [files]);

  const selectedSet = React.useMemo(() => toKeySet(selectedRowKeys), [selectedRowKeys]);
  // 缩略图落进缓存后叫醒一次当前视图（其他行仍由 memo 挡住）
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const t = window.setTimeout(() => bump(), 0);
    return () => window.clearTimeout(t);
  }, []);

  if (mode === "table" || mode === "column") return null;

  if (files.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该文件夹为空" />
      </div>
    );
  }

  const slice = files.slice(win.firstIndex, win.lastIndex);

  return (
    <div
      ref={rootRef}
      onScroll={handleScroll}
      style={{ height: "100%", overflowY: "auto", overflowX: "hidden", padding: 8 }}
    >
      <div style={{ height: win.padTop }} />
      {isGrid ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${columns}, minmax(${GRID_MIN_COLUMN_WIDTH}px, 1fr))`,
            gridAutoRows: `${GRID_ROW_HEIGHT}px`,
            gap: 8,
          }}
        >
          {slice.map((entry) => (
            <EntryRow
              key={entry.path}
              entry={entry}
              mode="grid"
              selected={selectedSet.has(entry.path) || selectedPath === entry.path}
              colorPrimary={token.colorPrimary}
              colorPrimaryBg={token.colorPrimaryBg}
              colorText={token.colorText}
              colorFillTertiary={token.colorFillTertiary}
              onClick={onClick}
              onDoubleClick={onDoubleClick}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      ) : (
        <div>
          {slice.map((entry) => (
            <EntryRow
              key={entry.path}
              entry={entry}
              mode="list"
              selected={selectedSet.has(entry.path) || selectedPath === entry.path}
              colorPrimary={token.colorPrimary}
              colorPrimaryBg={token.colorPrimaryBg}
              colorText={token.colorText}
              colorFillTertiary={token.colorFillTertiary}
              onClick={onClick}
              onDoubleClick={onDoubleClick}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      )}
      <div style={{ height: win.padBottom }} />
    </div>
  );
}
