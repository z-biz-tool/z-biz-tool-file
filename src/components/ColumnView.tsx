import { useState, useEffect, useRef } from "react";
import { theme } from "antd";
import {
  FolderOutlined,
  FileOutlined,
  FileImageOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { formatFileSize, formatTime, type FileEntry } from "../stores/fileStore";

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
      {columns.map((col, colIndex) => (
        <div
          key={col.path + "-" + colIndex}
          style={{
            width: 200,
            minWidth: 200,
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
        </div>
      ))}

      {/* 预览列 */}
      <div
        style={{
          width: 280,
          minWidth: 280,
          display: "flex",
          flexDirection: "column",
          background: token.colorBgContainer,
          borderLeft: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <div
          style={{
            padding: "6px 12px",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            fontWeight: 600,
            fontSize: 12,
            color: token.colorTextSecondary,
            background: token.colorBgContainer,
            flexShrink: 0,
          }}
        >
          预览
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {selectedFile ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* 图标 */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  padding: 16,
                }}
              >
                {selectedFile.is_dir ? (
                  <FolderOutlined style={{ fontSize: 64, color: "#faad14" }} />
                ) : isImageFile(selectedFile.name) ? (
                  <FileImageOutlined style={{ fontSize: 64, color: token.colorPrimary }} />
                ) : (
                  <FileOutlined style={{ fontSize: 64, color: "#8c8c8c" }} />
                )}
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
                {selectedFile.name}
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
                  <span>{selectedFile.is_dir ? "-" : formatFileSize(selectedFile.size)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>修改时间</span>
                  <span>{formatTime(selectedFile.modified)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>类型</span>
                  <span>{selectedFile.is_dir ? "文件夹" : "文件"}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span>路径</span>
                  <span style={{ wordBreak: "break-all", color: token.colorText }}>
                    {selectedFile.path}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: token.colorTextSecondary,
                fontSize: 13,
              }}
            >
              选择文件以预览
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
