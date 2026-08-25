import { useState, useEffect, useRef } from "react";
import { Tabs, theme, Button, Tooltip } from "antd";
import {
  FolderOutlined,
  FileOutlined,
  FileImageOutlined,
  InfoCircleOutlined,
  EyeOutlined,
  EditOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { formatFileSize, formatTime, type FileEntry } from "../stores/fileStore";
import { getFileTypeVisual } from "../utils/fileTypeIcon";
import FileContentPreview from "./FileContentPreview";

interface ColumnViewProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onFileSelect: (entry: FileEntry) => void;
  selectedFile: FileEntry | null;
  showHidden: boolean;
}

interface CacheEntry {
  entries: FileEntry[];
  loading: boolean;
}

/** 将路径拆分为从根到当前目录的每一段路径 */
function splitPathToSegments(path: string): { name: string; path: string }[] {
  if (!path || path === "/") {
    return [{ name: "/", path: "/" }];
  }
  const parts = path.split("/").filter(Boolean);
  const segments: { name: string; path: string }[] = [
    { name: "/", path: "/" },
  ];
  let accumulated = "";
  for (const part of parts) {
    accumulated += "/" + part;
    segments.push({ name: part, path: accumulated });
  }
  return segments;
}

/** 根据文件扩展名判断是否为图片 */
function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif"].includes(ext);
}

/** 排序：文件夹优先 + 中文/英文混合 localeCompare */
function sortEntries(list: FileEntry[]): FileEntry[] {
  return list.slice().sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1;
    if (!a.is_dir && b.is_dir) return 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
}

export default function ColumnView({
  currentPath,
  onNavigate,
  onFileSelect,
  selectedFile,
  showHidden,
}: ColumnViewProps) {
  const { token } = theme.useToken();
  const containerRef = useRef<HTMLDivElement>(null);

  // 图片编辑状态：提到 ColumnView 是为了把"编辑"按钮放到 tab 栏右侧
  const [editingImage, setEditingImage] = useState(false);
  // 当前激活的 tab（"info" / "content"）
  const [activeTab, setActiveTab] = useState<string>("info");
  // 选中文件变化时重置编辑态 + 切回基本信息 tab
  useEffect(() => {
    setEditingImage(false);
    setActiveTab("info");
  }, [selectedFile?.path]);

  // 预览区宽度：可拖动调宽，记忆到 localStorage（跟目录列宽一致的做法）
  const [previewWidth, setPreviewWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 320;
    const v = Number(localStorage.getItem("z-tool-colview-preview-width"));
    return Number.isFinite(v) && v >= 240 && v <= 1200 ? v : 320;
  });
  useEffect(() => {
    try {
      localStorage.setItem("z-tool-colview-preview-width", String(previewWidth));
    } catch { /* ignore */ }
  }, [previewWidth]);

  // 预览区拖动：mousedown 时记 startWidth + startX，mousemove 算 delta（不存 ref 状态）
  const previewDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = previewWidth;

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // 往左拖 = 预览变宽
      const newWidth = Math.max(240, Math.min(1200, startWidth + delta));
      setPreviewWidth(newWidth);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ——— 路径缓存：key = `${path}::${showHidden ? 1 : 0}`
  // 切到深目录时只发"未缓存"路径的请求；回退/切兄弟时直接复用缓存 ———
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const [cacheVersion, setCacheVersion] = useState(0); // 触发重渲染
  const cacheKey = (p: string, hidden: boolean) => `${p}::${hidden ? 1 : 0}`;

  // ——— 列宽：每列独立可调，默认 200，记忆到 localStorage ———
  const [colWidths, setColWidths] = useState<number[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem("z-tool-colview-col-widths");
      return raw ? (JSON.parse(raw) as number[]) : [];
    } catch {
      return [];
    }
  });
  // 预览区现在用 flex: 1 自动填满右侧剩余空间，不再需要手动宽度状态

  useEffect(() => {
    try {
      localStorage.setItem("z-tool-colview-col-widths", JSON.stringify(colWidths));
    } catch { /* ignore */ }
  }, [colWidths]);

  // ——— 列宽拖动：mousedown 时记下 startWidth + startX，每次 mousemove 从头算 ———
  // 不用 ref 中间态，React 18 批处理时不会读到过期值，列宽始终跟着鼠标。
  const onResizeStart = (
    e: React.MouseEvent,
    index: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[index] ?? 200;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.max(60, startWidth + delta); // 最小 60px，更灵活
      setColWidths((prev) => {
        const next = [...prev];
        next[index] = newWidth;
        return next;
      });
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const segments = splitPathToSegments(currentPath);
  const lastSegmentKey = segments[segments.length - 1]?.path ?? "";

  /** 增量加载：只对缓存缺失的路径发请求 */
  useEffect(() => {
    const cache = cacheRef.current;
    const inflight = inFlightRef.current;

    // 找出当前路径链上还没缓存的路径（保持顺序：父在前）
    const toFetch: string[] = [];
    for (const seg of segments) {
      const k = cacheKey(seg.path, showHidden);
      if (!cache.has(k) && !inflight.has(k)) {
        toFetch.push(seg.path);
      }
    }
    if (toFetch.length === 0) return;

    // 立刻把"加载中"状态写入缓存，避免空白闪烁
    toFetch.forEach((p) => {
      const k = cacheKey(p, showHidden);
      inflight.add(k);
      cache.set(k, { entries: [], loading: true });
    });
    setCacheVersion((v) => v + 1);

    // 并行拉取
    toFetch.forEach((p) => {
      const k = cacheKey(p, showHidden);
      const cmd = showHidden ? "list_directory_with_hidden" : "list_directory";
      const args = showHidden ? { path: p, showHidden: true } : { path: p };

      invoke(cmd, args)
        .then((entries: unknown) => {
          cache.set(k, {
            entries: sortEntries(entries as FileEntry[]),
            loading: false,
          });
        })
        .catch(() => {
          cache.set(k, { entries: [], loading: false });
        })
        .finally(() => {
          inflight.delete(k);
          setCacheVersion((v) => v + 1);
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, showHidden, lastSegmentKey]);

  /** 自动滚动到最右侧列 */
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollLeft = containerRef.current.scrollWidth;
    }
  }, [segments.length]);

  /** 点击文件夹：导航到该目录 */
  const handleFolderClick = (entry: FileEntry) => {
    onNavigate(entry.path);
  };

  /** 点击文件：选中并显示预览 */
  const handleFileClick = (entry: FileEntry) => {
    onFileSelect(entry);
  };

  /** 判断某列中某项是否被选中 */
  const isSelected = (entry: FileEntry, colIndex: number): boolean => {
    if (entry.is_dir) {
      // 文件夹选中：下一列的路径是否匹配
      const nextSeg = segments[colIndex + 1];
      return nextSeg?.path === entry.path;
    }
    // 文件选中：是否为当前选中的文件
    return selectedFile?.path === entry.path;
  };

  // 引用 cacheVersion 让 TS 知道它参与了渲染（实际读通过 ref）
  void cacheVersion;

  return (
    <div
      ref={containerRef}
      className="column-view-scroll"
      style={{
        display: "flex",
        height: "100%",
        overflowX: "scroll",
        overflowY: "hidden",
        background: token.colorBgLayout,
      }}
    >
      {segments.map((seg, colIndex) => {
        const colWidth = colWidths[colIndex] ?? 200;
        const cacheEntry = cacheRef.current.get(cacheKey(seg.path, showHidden)) ?? {
          entries: [],
          loading: true,
        };
        const { entries, loading } = cacheEntry;
        return (
        <div
          key={seg.path}
          style={{
            width: colWidth,
            minWidth: 120,
            position: "relative",
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            display: "flex",
            flexDirection: "column",
            background: token.colorBgContainer,
          }}
        >
          {/* 列头 */}
          <div
            style={{
              padding: "6px 12px",
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              fontWeight: 600,
              fontSize: 12,
              color: token.colorTextSecondary,
              background: token.colorBgContainer,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flexShrink: 0,
            }}
          >
            {seg.name}
          </div>
          {/* 文件列表 */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              overflowX: "hidden",
            }}
          >
            {loading && entries.length === 0 && (
              <div
                style={{
                  padding: 12,
                  color: token.colorTextSecondary,
                  fontSize: 12,
                }}
              >
                加载中...
              </div>
            )}
            {!loading && entries.length === 0 && (
              <div
                style={{
                  padding: 12,
                  color: token.colorTextSecondary,
                  fontSize: 12,
                }}
              >
                空文件夹
              </div>
            )}
            {entries.map((entry) => {
              const selected = isSelected(entry, colIndex);
              return (
                <div
                  key={entry.path}
                  onClick={() => {
                    if (entry.is_dir) {
                      handleFolderClick(entry);
                    } else {
                      handleFileClick(entry);
                    }
                  }}
                  style={{
                    padding: "4px 12px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: selected ? token.colorPrimaryBg : "transparent",
                    color: selected ? token.colorPrimary : token.colorText,
                    fontWeight: selected ? 600 : 400,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontSize: 13,
                    lineHeight: "24px",
                  }}
                >
                  {entry.is_dir ? (
                    <FolderOutlined style={{ color: "#faad14", flexShrink: 0 }} />
                  ) : isImageFile(entry.name) ? (
                    <FileImageOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />
                  ) : (
                    <FileOutlined style={{ color: "#8c8c8c", flexShrink: 0 }} />
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {entry.name}
                  </span>
                </div>
              );
            })}
          </div>
          {/* 列宽拖动条（右边缘） */}
          <span
            onMouseDown={(e) => onResizeStart(e, colIndex)}
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: 6,
              cursor: "col-resize",
              userSelect: "none",
              touchAction: "none",
              zIndex: 5,
            }}
            aria-label={`调整 ${seg.name} 列宽度`}
            title="拖动调整列宽"
          />
        </div>
        );
      })}

      {/* 预览区：可拖动调宽（拖左边缘分隔条），作为 column 视图下唯一的预览面板 */}
      <div
        style={{
          width: previewWidth,
          minWidth: 240,
          flexShrink: 0,
          position: "relative",
          display: "flex",
          flexDirection: "column",
          background: token.colorBgContainer,
          borderLeft: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {/* 预览区左边缘拖拽条 */}
        <span
          onMouseDown={previewDragStart}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: "col-resize",
            userSelect: "none",
            touchAction: "none",
            zIndex: 5,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLSpanElement).style.background =
              "var(--ant-color-primary-bg, rgba(22, 119, 255, 0.12))";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLSpanElement).style.background = "transparent";
          }}
          aria-label="调整预览区宽度"
          title="拖动调整宽度"
        />
        {selectedFile ? (
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            size="small"
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
            tabBarStyle={{ margin: 0, padding: "0 12px" }}
            tabBarExtraContent={
              // tab 栏右侧：对当前文件的"小操作"按钮
              // 图片在「内容详情」tab 时显示 编辑/返回 按钮
              activeTab === "content" && isImageFile(selectedFile.name)
                ? editingImage ? (
                    <Tooltip title="退出编辑">
                      <Button
                        size="small"
                        type="text"
                        icon={<CloseOutlined />}
                        onClick={() => setEditingImage(false)}
                        aria-label="退出编辑"
                      />
                    </Tooltip>
                  ) : (
                    <Tooltip title="编辑图片">
                      <Button
                        size="small"
                        type="text"
                        icon={<EditOutlined />}
                        onClick={() => setEditingImage(true)}
                        aria-label="编辑图片"
                      />
                    </Tooltip>
                  )
                : null
            }
            items={[
              {
                key: "info",
                label: (
                  <span>
                    <InfoCircleOutlined /> 基本信息
                  </span>
                ),
                children: <FileMetaInfo file={selectedFile} />,
              },
              {
                key: "content",
                label: (
                  <span>
                    <EyeOutlined /> 内容详情
                  </span>
                ),
                children: (
                  <div style={{ height: "100%" }}>
                    <FileContentPreview
                      file={selectedFile}
                      showTopbar={false}
                      editingImage={editingImage}
                      onEditImage={() => setEditingImage(true)}
                      onExitEditImage={() => setEditingImage(false)}
                    />
                  </div>
                ),
              },
            ]}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: token.colorTextSecondary,
              fontSize: 13,
            }}
          >
            选择文件以预览
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "基本信息" tab 的内容：图标 + 文件名 + 大小/修改/类型/路径
 */
function FileMetaInfo({ file }: { file: FileEntry }) {
  const { token } = theme.useToken();
  const visual = getFileTypeVisual(file.name, file.is_dir);
  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* 图标 */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: 16,
            color: visual.color,
            fontSize: 64,
          }}
        >
          {visual.icon}
        </div>
        {/* 文件名 */}
        <div
          style={{
            textAlign: "center",
            fontWeight: 600,
            fontSize: 14,
            wordBreak: "break-all",
          }}
        >
          {file.name}
        </div>
        {/* 类型标签 */}
        <div
          style={{
            textAlign: "center",
            color: visual.color,
            fontSize: 11,
            fontWeight: 500,
          }}
        >
          {visual.label}
        </div>
        {/* 详细信息 */}
        <div
          style={{
            fontSize: 12,
            color: token.colorTextSecondary,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            paddingTop: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>大小</span>
            <span>{file.is_dir ? "-" : formatFileSize(file.size)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>修改时间</span>
            <span>{formatTime(file.modified)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>类型</span>
            <span>{file.is_dir ? "文件夹" : "文件"}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span>路径</span>
            <span style={{ wordBreak: "break-all", color: token.colorText }}>
              {file.path}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
