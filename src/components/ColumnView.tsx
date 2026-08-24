import { useState, useEffect, useRef, useCallback } from "react";
import { Tabs, theme } from "antd";
import {
  FolderOutlined,
  FileOutlined,
  FileImageOutlined,
  InfoCircleOutlined,
  EyeOutlined,
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

interface ColumnData {
  path: string;
  name: string;
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

export default function ColumnView({
  currentPath,
  onNavigate,
  onFileSelect,
  selectedFile,
  showHidden,
}: ColumnViewProps) {
  const { token } = theme.useToken();
  const containerRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState<ColumnData[]>([]);

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
  const [previewWidth, setPreviewWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 320;
    const v = Number(localStorage.getItem("z-tool-colview-preview-width"));
    return Number.isFinite(v) && v >= 240 && v <= 800 ? v : 320;
  });

  useEffect(() => {
    try {
      localStorage.setItem("z-tool-colview-col-widths", JSON.stringify(colWidths));
    } catch { /* ignore */ }
  }, [colWidths]);
  useEffect(() => {
    try {
      localStorage.setItem("z-tool-colview-preview-width", String(previewWidth));
    } catch { /* ignore */ }
  }, [previewWidth]);

  // ——— 列宽拖动：拖动条拖到左侧列上，调该列宽 ———
  // 用 ref 记录 baseline 防止 React 重渲染中断拖拽
  const widthBaselineRef = useRef<{ index: number; startWidth: number; startX: number; isPreview: boolean } | null>(null);
  const setColWidth = useCallback((index: number, delta: number) => {
    if (delta === 0) return;
    setColWidths((prev) => {
      const next = [...prev];
      const baseline = widthBaselineRef.current?.startWidth ?? prev[index] ?? 200;
      const newVal = Math.max(120, baseline + delta);
      widthBaselineRef.current && (widthBaselineRef.current.startWidth = newVal);
      next[index] = newVal;
      return next;
    });
  }, []);

  const onResizeStart = (
    e: React.MouseEvent,
    target: { index?: number; isPreview: boolean },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = target.isPreview
      ? previewWidth
      : colWidths[target.index!] ?? 200;
    widthBaselineRef.current = {
      index: target.index ?? -1,
      isPreview: target.isPreview,
      startWidth,
      startX: e.clientX,
    };
    const startX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      if (!widthBaselineRef.current) return;
      const delta = ev.clientX - startX;
      if (target.isPreview) {
        setPreviewWidth((prev) => {
          const base = widthBaselineRef.current?.startWidth ?? prev;
          const nv = Math.max(240, Math.min(800, base + delta));
          if (widthBaselineRef.current) widthBaselineRef.current.startWidth = nv;
          return nv;
        });
      } else {
        setColWidth(target.index!, delta);
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      widthBaselineRef.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const segments = splitPathToSegments(currentPath);

  /** 当路径或 showHidden 变化时，重建列并加载内容 */
  useEffect(() => {
    const newColumns: ColumnData[] = segments.map((seg) => ({
      path: seg.path,
      name: seg.name,
      entries: [],
      loading: false,
    }));
    setColumns(newColumns);

    // 加载每一列
    segments.forEach((seg, idx) => {
      const cmd = showHidden ? "list_directory_with_hidden" : "list_directory";
      const args = showHidden ? { path: seg.path, showHidden: true } : { path: seg.path };

      invoke(cmd, args)
        .then((entries: unknown) => {
          const fileList = entries as FileEntry[];
          fileList.sort((a, b) => {
            if (a.is_dir && !b.is_dir) return -1;
            if (!a.is_dir && b.is_dir) return 1;
            return a.name.localeCompare(b.name, "zh-CN");
          });
          setColumns((prev) => {
            const next = [...prev];
            if (next[idx] && next[idx].path === seg.path) {
              next[idx] = { ...next[idx], entries: fileList, loading: false };
            }
            return next;
          });
        })
        .catch(() => {
          setColumns((prev) => {
            const next = [...prev];
            if (next[idx] && next[idx].path === seg.path) {
              next[idx] = { ...next[idx], loading: false };
            }
            return next;
          });
        });
    });
  }, [currentPath, showHidden]);

  /** 自动滚动到最右侧列 */
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollLeft = containerRef.current.scrollWidth;
    }
  }, [columns.length]);

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
      const nextCol = columns[colIndex + 1];
      return nextCol?.path === entry.path;
    }
    // 文件选中：是否为当前选中的文件
    return selectedFile?.path === entry.path;
  };

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        height: "100%",
        overflowX: "auto",
        overflowY: "hidden",
        background: token.colorBgLayout,
      }}
    >
      {columns.map((col, colIndex) => {
        const colWidth = colWidths[colIndex] ?? 200;
        return (
        <div
          key={col.path + "-" + colIndex}
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
            {col.name}
          </div>
          {/* 文件列表 */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              overflowX: "hidden",
            }}
          >
            {col.loading && (
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
            {!col.loading && col.entries.length === 0 && (
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
            {col.entries.map((entry) => {
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
            onMouseDown={(e) => onResizeStart(e, { index: colIndex, isPreview: false })}
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
            aria-label={`调整 ${col.name} 列宽度`}
            title="拖动调整列宽"
          />
        </div>
        );
      })}

      {/* 预览列：两个 tab — 基本信息 / 内容详情 */}
      <div
        style={{
          width: previewWidth,
          minWidth: 240,
          position: "relative",
          display: "flex",
          flexDirection: "column",
          background: token.colorBgContainer,
          borderLeft: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {selectedFile ? (
          <Tabs
            defaultActiveKey="info"
            size="small"
            style={{ height: "100%", display: "flex", flexDirection: "column" }}
            tabBarStyle={{ margin: 0, padding: "0 12px" }}
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
                    <FileContentPreview file={selectedFile} showTopbar={false} />
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
        {/* 预览列宽拖动条（左边缘） */}
        <span
          onMouseDown={(e) => onResizeStart(e, { isPreview: true })}
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
          aria-label="调整预览列宽度"
          title="拖动调整列宽"
        />
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
