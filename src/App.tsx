import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import {
  Input, Button, Breadcrumb, Table, Dropdown, App as AntdApp, Tooltip, Segmented, Modal,
} from "antd";
import type { MenuProps, BreadcrumbProps } from "antd";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  SearchOutlined,
  HomeOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ReloadOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  CopyOutlined,
  ScissorOutlined,
  SnippetsOutlined,
  FileAddOutlined,
  FolderAddOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  AppstoreOutlined,
  UnorderedListOutlined,
  TableOutlined,
  InfoCircleOutlined,
  FileZipOutlined,
  ExpandOutlined,
  FilePdfOutlined,
  ScanOutlined,
  CloudDownloadOutlined,
  UpOutlined,
  BookOutlined,
  FormOutlined,
  ColumnHeightOutlined,
  RadarChartOutlined,
  CodeOutlined,
  CopyFilled,
  SwapOutlined,
  SafetyCertificateOutlined,
  TagOutlined,
  Badge,
  FileTextOutlined,
  ClearOutlined,
  SettingOutlined,
  CloudServerOutlined,
  ThunderboltOutlined,
  PieChartOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  AudioOutlined,
  BrainOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getFileTypeVisual, compareByKindThenName } from "./utils/fileTypeIcon";
import { fuzzyFilter } from "./utils/fuzzyMatch";
import {
  useFileStore, formatFileSize, formatTime, type FileEntry,
} from "./stores/fileStore";
import PreviewPane from "./components/PreviewPane";
import SearchBar from "./components/SearchBar";
import Bookmarks from "./components/Bookmarks";
import BatchRename from "./components/BatchRename";
import FileProperties from "./components/FileProperties";
import GridView from "./components/GridView";
import DualPanelView from "./components/DualPanelView";
import BuiltInTerminal from "./components/BuiltInTerminal";
import DropStack from "./components/DropStack";
import DuplicateFinder from "./components/DuplicateFinder";
import HashCalculator from "./components/HashCalculator";
import DirectorySync from "./components/DirectorySync";
import WorkspaceManager, { type Workspace } from "./components/WorkspaceManager";
import SettingsModal from "./components/SettingsModal";
import TrashModal from "./components/TrashModal";
import TabsBar from "./components/TabsBar";
import SftpModal from "./components/SftpModal";
import StorageAnalyzerModal from "./components/StorageAnalyzerModal";
import TagEditModal, { getTagColor } from "./components/TagEditModal";
import QuickActionsModal from "./components/QuickActionsModal";
import GitStatus from "./components/GitStatus";
import ColumnView from "./components/ColumnView";
import FileTagsPanel from "./components/FileTagsPanel";
import NewFileTemplate from "./components/NewFileTemplate";
import ZipBrowser from "./components/ZipBrowser";
import ArchiveManager from "./components/ArchiveManager";
import PdfTools from "./components/PdfTools";
import DiffViewer from "./components/DiffViewer";
import OcrTool from "./components/OcrTool";
import Aria2Manager from "./components/Aria2Manager";
import LibraryView from "./components/LibraryView";
import Updater from "./components/Updater";
import TransferQueue from "./components/TransferQueue";
import { DragDropTarget } from "./components/DragDropMove";
import { ThemeProvider, AppShell, useKeyboardShortcuts, CollapsiblePanel } from "./_shared";
import Omnibar from "./_shared/Omnibar";
import { MediaGallery, PhotoGallery, VideoGallery, MusicGallery } from "./components/MediaGallery";
import AISettingPanel from "./components/AISettingPanel";

/**
 * 可拖拽列宽的表头单元格。
 * - 通过 components.header.cell 注入 antd Table
 * - 鼠标拖拽右边缘 6px 热区即可调整列宽
 * - 最小宽度 50px（可按需调整）
 * - 通过 onWidthChange 把新宽度冒泡到上层 state
 */
interface ResizableHeaderCellProps {
  children?: React.ReactNode;
  onWidthChange?: (delta: number) => void;
  minWidth?: number;
  style?: React.CSSProperties;
  className?: string;
  // antd 注入的其它 props（如 colSpan / rowSpan）
  [key: string]: unknown;
}
function ResizableHeaderCell({
  children,
  onWidthChange,
  minWidth = 50,
  style,
  className,
  ...rest
}: ResizableHeaderCellProps) {
  // ref 记录拖拽起始状态，避免在 React 渲染里来回算
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    onMove: (e: MouseEvent) => void;
    onUp: () => void;
  } | null>(null);

  const onMouseDown = (e: React.MouseEvent<HTMLSpanElement>) => {
    const th = (e.currentTarget as HTMLElement).closest("th");
    if (!th) return;
    const startX = e.clientX;
    const startWidth = th.offsetWidth;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const next = Math.max(minWidth, startWidth + delta);
      onWidthChange?.(next - startWidth);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      dragRef.current = null;
    };
    dragRef.current = { startX, startWidth, onMove, onUp };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <th {...rest} className={className} style={{ position: "relative", ...style }}>
      {children}
      <span
        onMouseDown={onMouseDown}
        className="z-tool-col-resizer"
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: "col-resize",
          userSelect: "none",
          touchAction: "none",
        }}
        aria-label="拖拽调整列宽"
      />
    </th>
  );
}

// —— AntdApp 内部组件：能够使用 App context（message / modal / notification）
function AppShellInner() {
  const { message, modal } = AntdApp.useApp();
  const [rootPath, setRootPath] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [renameModal, setRenameModal] = useState<{
    visible: boolean;
    path: string;
    oldName: string;
  }>({ visible: false, path: "", oldName: "" });
  const [newName, setNewName] = useState("");
  const [createModal, setCreateModal] = useState<{
    visible: boolean;
    type: "file" | "dir";
  }>({ visible: false, type: "file" });
  const [createName, setCreateName] = useState("");
  const [batchRenameOpen, setBatchRenameOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  // 多选锚点：用于 Shift+Click 区间选择的起点（macOS Finder 行为）
  const [selectionAnchor, setSelectionAnchor] = useState<React.Key | null>(null);
  const [dualPanelOpen, setDualPanelOpen] = useState(false);
  const [autoWatch, setAutoWatch] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [duplicateFinderOpen, setDuplicateFinderOpen] = useState(false);
  const [hashCalcOpen, setHashCalcOpen] = useState(false);
  const [dirSyncOpen, setDirSyncOpen] = useState(false);
  const [zipBrowserOpen, setZipBrowserOpen] = useState(false);
  const [zipBrowserPath, setZipBrowserPath] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveMode, setArchiveMode] = useState<"compress" | "extract">("compress");
  const [archiveSources, setArchiveSources] = useState<string[]>([]);
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [pdfToolsOpen, setPdfToolsOpen] = useState(false);
  const [pdfToolsPath, setPdfToolsPath] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [aria2Open, setAria2Open] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
    const [updaterOpen, setUpdaterOpen] = useState(false);
    const [hasUpdate, setHasUpdate] = useState(false);
  const [newFileTemplateOpen, setNewFileTemplateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [tagEditOpen, setTagEditOpen] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  // 媒体库视图状态
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  const [mediaLibraryType, setMediaLibraryType] = useState<"image" | "video" | "audio">("image");
  const [mediaLibraryPath, setMediaLibraryPath] = useState<string>("");
  // 当前目录的快速过滤（subsequence 模糊匹配）
  const [quickFilter, setQuickFilter] = useState("");
  const [siderCollapsed, setSiderCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("z-tool-sider-collapsed") === "1";
  });
  const [previewWidth, setPreviewWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 420;
    const stored = Number(localStorage.getItem("z-tool-preview-width"));
    return Number.isFinite(stored) && stored >= 240 && stored <= 800 ? stored : 420;
  });
  const [previewVisible, setPreviewVisible] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const v = localStorage.getItem("z-tool-preview-visible");
    return v === null ? true : v === "1";
  });
  // 表格列宽：键为 column.key，值为 px 宽度；持久化到 localStorage
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = localStorage.getItem("z-tool-table-col-widths");
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
      return {};
    }
  });

  // 启动时静默检查更新
  useEffect(() => {
    invoke("updater_silent_check").then((status) => {
      if (status) setHasUpdate(true);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("z-tool-table-col-widths", JSON.stringify(columnWidths));
    } catch {
      /* 容量满或隐私模式，忽略 */
    }
  }, [columnWidths]);

  /**
   * 调整指定列的列宽。由 ResizableHeaderCell 在 onMouseMove 时反复调用，
   * 传入 delta（px）。最小宽度 50 在 ResizableHeaderCell 内部保证。
   * 注意：拖拽过程中 React 重新 render 会让 header.cell 组件 unmount/remount，
   * 因此通过"累加"而不是"重设 startWidth"来保持连续 — 用 ref 记录 baseline。
   */
  const columnWidthBaselineRef = useRef<Record<string, number>>({});
  const updateColumnWidth = useCallback(
    (key: string, delta: number) => {
      if (delta === 0) return;
      setColumnWidths((prev) => {
        const baseline = columnWidthBaselineRef.current[key];
        const cur = baseline ?? prev[key] ?? (key === "modified" ? 180 : 100);
        const nextVal = Math.max(50, cur + delta);
        columnWidthBaselineRef.current[key] = nextVal;
        return { ...prev, [key]: nextVal };
      });
    },
    [],
  );

  // 预览分隔条拖拽
  const previewDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 持 currentPath / loadDirectory 的 ref，避免 useEffect 闭包陈旧
  const currentPathRef = useRef<string>("");
  const loadDirectoryRef = useRef<((path: string) => void) | null>(null);

  // ——— 实时文件监听 ———
  // 切换目录时自动启动监听；监听期间文件改动 → 防抖 300ms 后刷新列表
  const fileChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenFileChangeRef = useRef<(() => void) | null>(null);

  // 订阅后端 file-change 事件（仅订阅一次，组件 mount 时）
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen<{ path: string; kind: string }>("file-change", (evt) => {
      const { path } = evt.payload;
      // 只刷新当前目录（或当前目录的子项）
      const dir = currentPathRef.current;
      if (!dir) return;
      if (path === dir || path.startsWith(dir + "/")) {
        // 防抖：300ms 内多次事件合并
        if (fileChangeTimerRef.current) clearTimeout(fileChangeTimerRef.current);
        fileChangeTimerRef.current = setTimeout(() => {
          loadDirectoryRef.current?.(dir);
        }, 300);
      }
    })
      .then((u) => {
        unlistenFn = u;
        unlistenFileChangeRef.current = u;
      })
      .catch((err) => console.error("订阅 file-change 失败:", err));
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // 组件 unmount 时停止监听
  useEffect(() => {
    return () => {
      invoke("stop_watching").catch(() => {});
    };
  }, []);
  const {
    currentPath, fileList, selectedFile, showHidden, viewMode,
    clipboard,
    setSelectedFile, setCurrentPath, setFileList,
    setShowHidden, setViewMode,
    setClipboard, clearClipboard,
    tabs, activeTabId,
    tagsByPath,
    openTab, closeTab, updateActiveTabPath,
    loadAllTags,
    // AI 和媒体状态
    aiEnabled, aiModel, aiEndpoint,
    setAiEnabled, setAiModel, setAiEndpoint,
    mediaViewMode, mediaGallerySize,
    setMediaViewMode, setMediaGallerySize,
  } = useFileStore();

  // 记忆侧栏折叠状态
  useEffect(() => {
    localStorage.setItem("z-tool-sider-collapsed", siderCollapsed ? "1" : "0");
  }, [siderCollapsed]);

  // 启动时加载所有标签
  useEffect(() => {
    loadAllTags().catch((err) => console.error("加载标签失败:", err));
  }, [loadAllTags]);

  // 记忆预览区状态
  useEffect(() => {
    localStorage.setItem("z-tool-preview-visible", previewVisible ? "1" : "0");
  }, [previewVisible]);
  useEffect(() => {
    localStorage.setItem("z-tool-preview-width", String(previewWidth));
  }, [previewWidth]);

  // 预览分隔条：横向拖拽改变预览宽度
  const handlePreviewDragStart = useCallback((e: ReactMouseEvent) => {
    if (!previewVisible) return;
    e.preventDefault();
    previewDragRef.current = { startX: e.clientX, startWidth: previewWidth };

    const handleMove = (ev: MouseEvent) => {
      if (!previewDragRef.current) return;
      const delta = previewDragRef.current.startX - ev.clientX;
      const next = Math.min(800, Math.max(240, previewDragRef.current.startWidth + delta));
      setPreviewWidth(next);
    };
    const handleUp = () => {
      previewDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [previewWidth, previewVisible]);

  // 加载目录
  const loadDirectory = useCallback((path: string) => {
    const cmd = showHidden ? "list_directory_with_hidden" : "list_directory";
    const args = showHidden ? { path, showHidden: true } : { path };
    invoke(cmd, args)
      .then((entries: unknown) => {
        setFileList(entries as FileEntry[]);
      })
      .catch((err) => {
        message.error("加载目录失败: " + err);
      });
  }, [showHidden, setFileList, message]);

  // 同步 ref 让 file-change 监听能用最新值
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);
  useEffect(() => {
    loadDirectoryRef.current = loadDirectory;
  }, [loadDirectory]);

  // 切换目录时重新启动监听
  useEffect(() => {
    if (!currentPath) return;
    invoke("start_watching", { path: currentPath })
      .catch((err) => console.error("启动监听失败:", err));
    return () => {
      // 卸载监听由下次 start_watching 自动覆盖；显式 stop 留给组件 unmount
    };
  }, [currentPath]);

  // 导航到路径
  const navigateTo = useCallback((path: string, isRoot: boolean = false) => {
    setCurrentPath(path);
    loadDirectory(path);
    // 同步更新 active tab 的 path
    if (activeTabId) updateActiveTabPath(path);
    // 切目录：清掉旧目录的多选状态（macOS Finder 行为）
    setSelectedRowKeys([]);
    setSelectedFile(null);
    setSelectionAnchor(null);

    setHistory((prev) => {
      if (isRoot) return [path];
      const newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push(path);
      setHistoryIndex(newHistory.length - 1);
      return newHistory;
    });
  }, [historyIndex, setCurrentPath, loadDirectory, activeTabId, updateActiveTabPath]);

  // 初始化：macOS默认用户目录
  useEffect(() => {
    const defaultPath = "/Users/zifang";
    setRootPath(defaultPath);
    navigateTo(defaultPath, true);
    // 初始化第一个 tab
    if (tabs.length === 0) openTab(defaultPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // showHidden变化时重新加载
  useEffect(() => {
    if (currentPath) loadDirectory(currentPath);
  }, [showHidden, currentPath, loadDirectory]);

  // 文件监听：当 enabled 时自动监听当前目录
  const watchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!autoWatch || !currentPath) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const setup = async () => {
      try {
        await invoke("start_watching", { path: currentPath });
      } catch (err) {
        console.warn("启动监听失败:", err);
      }
      if (cancelled) return;

      const un = await listen<{ path: string; kind: string }>(
        "file-change",
        (event) => {
          if (!currentPath) return;
          const evt = event.payload;
          // 仅当事件路径在当前目录下时刷新
          if (!evt.path.startsWith(currentPath + "/") && evt.path !== currentPath) {
            return;
          }
          // 防抖：300ms 内只触发一次
          if (watchTimerRef.current) clearTimeout(watchTimerRef.current);
          watchTimerRef.current = setTimeout(() => {
            loadDirectory(currentPath);
          }, 300);
        }
      );
      if (cancelled) {
        un();
      } else {
        unlisten = un;
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (watchTimerRef.current) {
        clearTimeout(watchTimerRef.current);
        watchTimerRef.current = null;
      }
    };
  }, [autoWatch, currentPath, loadDirectory]);

  // 后退
  const goBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      const path = history[newIndex];
      setHistoryIndex(newIndex);
      setCurrentPath(path);
      loadDirectory(path);
    }
  }, [historyIndex, history, setCurrentPath, loadDirectory]);

  // 前进
  const goForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      const path = history[newIndex];
      setHistoryIndex(newIndex);
      setCurrentPath(path);
      loadDirectory(path);
    }
  }, [historyIndex, history, setCurrentPath, loadDirectory]);

  // 返回上级目录
  const goUp = useCallback(() => {
    if (currentPath && currentPath !== "/") {
      const parts = currentPath.split("/").filter(Boolean);
      parts.pop();
      const parentPath = "/" + parts.join("/");
      navigateTo(parentPath || "/");
    }
  }, [currentPath, navigateTo]);

  // 面包屑导航
  const buildBreadcrumbItems = useCallback((): BreadcrumbProps["items"] => {
    if (!currentPath) return [];
    const parts = currentPath.split("/").filter(Boolean);
    const items: NonNullable<BreadcrumbProps["items"]> = [
      {
        title: (
          <span
            onClick={() => navigateTo("/", true)}
            style={{ cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                navigateTo("/", true);
              }
            }}
          >
            <HomeOutlined />
          </span>
        ),
      },
    ];
    let path = "";
    parts.forEach((part) => {
      path += "/" + part;
      const currentPathCopy = path;
      items.push({
        title: (
          <span
            onClick={() => navigateTo(currentPathCopy)}
            style={{ cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                navigateTo(currentPathCopy);
              }
            }}
          >
            {part}
          </span>
        ),
      });
    });
    return items;
  }, [currentPath, navigateTo]);

  // 剪贴板操作
  const handleCopy = useCallback((entries: FileEntry[]) => {
    setClipboard(
      entries.map((e) => ({ path: e.path, name: e.name, is_dir: e.is_dir, operation: "copy" as const })),
      "copy"
    );
    message.success(`已复制 ${entries.length} 项`);
  }, [setClipboard, message]);

  const handleCut = useCallback((entries: FileEntry[]) => {
    setClipboard(
      entries.map((e) => ({ path: e.path, name: e.name, is_dir: e.is_dir, operation: "cut" as const })),
      "cut"
    );
    message.success(`已剪切 ${entries.length} 项`);
  }, [setClipboard, message]);

  const handlePaste = useCallback(async () => {
    if (clipboard.length === 0 || !currentPath) return;
    try {
      for (const item of clipboard) {
        if (item.operation === "copy") {
          await invoke("copy_file", { srcPath: item.path, destDir: currentPath });
        } else {
          await invoke("move_file", { srcPath: item.path, destDir: currentPath });
        }
      }
      message.success(`已粘贴 ${clipboard.length} 项`);
      clearClipboard();
      loadDirectory(currentPath);
    } catch (err) {
      message.error("粘贴失败: " + err);
    }
  }, [clipboard, currentPath, clearClipboard, loadDirectory, message]);

  // 拖拽源（行级别）：从表格行拖出
  const handleRowDragStart = useCallback((e: ReactDragEvent, record: FileEntry) => {
    // 如果该行被选中，拖拽所有选中的；否则只拖这一个
    const items = selectedRowKeys.includes(record.path) && selectedRowKeys.length > 0
      ? selectedRowKeys.map(String)
      : [record.path];
    e.dataTransfer.setData("application/x-z-tool-paths", JSON.stringify(items));
    // 把拖拽来源信息也存一下（用于剪贴板兼容）
    e.dataTransfer.setData("application/x-z-tool-operation", "cut");
    e.dataTransfer.effectAllowed = "move";
  }, [selectedRowKeys]);

  const handleRowDragEnd = useCallback(() => {
    // dragend - 浏览器内部会清理 dataTransfer
  }, []);

  // 新建文件/文件夹
  const handleCreate = useCallback(async () => {
    if (!createName.trim() || !currentPath) return;
    const fullPath = currentPath + "/" + createName.trim();
    try {
      if (createModal.type === "file") {
        await invoke("create_file", { path: fullPath });
        message.success("文件创建成功");
      } else {
        await invoke("create_directory", { path: fullPath });
        message.success("文件夹创建成功");
      }
      loadDirectory(currentPath);
    } catch (err) {
      message.error("创建失败: " + err);
    }
    setCreateModal({ visible: false, type: "file" });
    setCreateName("");
  }, [createName, createModal.type, currentPath, loadDirectory, message]);

  // 压缩
  const handleCompress = useCallback(async () => {
    if (selectedRowKeys.length === 0 && !selectedFile) return;
    const paths = selectedRowKeys.length > 0
      ? selectedRowKeys.map(String)
      : [selectedFile!.path];
    const defaultName = (paths.length === 1 ? selectedFile?.name || "archive" : "archive") + ".zip";
    try {
      await invoke("compress_to_zip", { paths, destPath: currentPath + "/" + defaultName });
      message.success("压缩成功: " + defaultName);
      loadDirectory(currentPath);
    } catch (err) {
      message.error("压缩失败: " + err);
    }
  }, [selectedRowKeys, selectedFile, currentPath, loadDirectory, message]);

  // 解压：按后缀自动选格式
  const handleExtract = useCallback(async (entry: FileEntry) => {
    const lower = entry.name.toLowerCase();
    let dirName = entry.name;
    if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) dirName = entry.name.replace(/\.(tar\.gz|tgz)$/i, "");
    else if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) dirName = entry.name.replace(/\.(tar\.bz2|tbz2)$/i, "");
    else if (lower.endsWith(".tar.xz") || lower.endsWith(".txz")) dirName = entry.name.replace(/\.(tar\.xz|txz)$/i, "");
    else if (lower.endsWith(".zip")) dirName = entry.name.replace(/\.zip$/i, "");
    else if (lower.endsWith(".tar")) dirName = entry.name.replace(/\.tar$/i, "");
    else if (lower.endsWith(".7z")) dirName = entry.name.replace(/\.7z$/i, "");
    else if (lower.endsWith(".gz")) dirName = entry.name.replace(/\.gz$/i, "");
    else {
      message.error("暂不支持该压缩格式: " + entry.name);
      return;
    }
    try {
      await invoke("extract_archive", { archivePath: entry.path, destDir: currentPath + "/" + dirName });
      message.success("解压成功: " + dirName);
      loadDirectory(currentPath);
    } catch (err) {
      message.error("解压失败: " + err);
    }
  }, [currentPath, loadDirectory, message]);

  // 删除文件
  const handleDelete = useCallback(
    (entry: FileEntry, permanent = false) => {
      modal.confirm({
        title: permanent ? "永久删除" : "移到回收站？",
        content: permanent
          ? `「${entry.name}」将永久删除，无法恢复。`
          : `「${entry.name}」将移到回收站，可以在「设置」旁的回收站按钮中恢复。`,
        okText: permanent ? "永久删除" : "移到回收站",
        okType: "danger",
        cancelText: "取消",
        onOk: async () => {
          try {
            if (permanent) {
              await invoke("delete_file", { path: entry.path });
              message.success("已永久删除");
            } else {
              await invoke("delete_to_trash", { path: entry.path });
              message.success("已移到回收站");
            }
            loadDirectory(currentPath);
          } catch (err) {
            message.error("删除失败: " + err);
          }
        },
      });
    },
    [currentPath, loadDirectory, message, modal],
  );

  // 重命名
  const handleRename = useCallback(async () => {
    if (!renameModal.path || !newName.trim()) return;
    try {
      await invoke("rename_file", { oldPath: renameModal.path, newName: newName.trim() });
      message.success("重命名成功");
      loadDirectory(currentPath);
    } catch (err) {
      message.error("重命名失败: " + err);
    }
    setRenameModal({ visible: false, path: "", oldName: "" });
  }, [renameModal.path, newName, currentPath, loadDirectory, message]);

  // 右键菜单
  const contextMenuItems = useCallback((record: FileEntry): MenuProps["items"] => {
    const items: MenuProps["items"] = [
      {
        key: "open",
        label: "用默认应用打开",
        icon: <AppstoreOutlined />,
        onClick: () => {
          invoke("open_with_default_app", { path: record.path }).catch((err) =>
            message.error("打开失败: " + err)
          );
        },
      },
      {
        key: "quicklook",
        label: "Quick Look 预览",
        icon: <EyeOutlined />,
        onClick: () => {
          invoke("quick_look_preview", { path: record.path }).catch((err) =>
            message.error("Quick Look 失败: " + err)
          );
        },
      },
      { type: "divider" },
      {
        key: "copy",
        label: "复制 (⌘+C)",
        icon: <CopyOutlined />,
        onClick: () => handleCopy([record]),
      },
      {
        key: "cut",
        label: "剪切 (⌘+X)",
        icon: <ScissorOutlined />,
        onClick: () => handleCut([record]),
      },
      {
        key: "rename",
        label: "重命名 (Enter)",
        icon: <EditOutlined />,
        onClick: () => {
          setRenameModal({ visible: true, path: record.path, oldName: record.name });
          setNewName(record.name);
        },
      },
      {
        key: "delete",
        label: "移到回收站 (⌘+Shift+⌫)",
        icon: <DeleteOutlined />,
        onClick: () => handleDelete(record, false),
      },
      {
        key: "delete_permanent",
        label: "永久删除 (Shift+Option+⌫)",
        danger: true,
        onClick: () => handleDelete(record, true),
      },
      { type: "divider" },
      {
        key: "hash",
        label: "计算哈希",
        icon: <SafetyCertificateOutlined />,
        onClick: () => {
          setSelectedFile(record);
          setHashCalcOpen(true);
        },
      },
      {
        key: "tags",
        label: tagsByPath[record.path] ? "编辑标签/备注" : "加标签/备注",
        icon: <TagOutlined />,
        onClick: () => {
          setSelectedFile(record);
          setTagEditOpen(true);
        },
      },
      {
        key: "properties",
        label: "属性",
        icon: <InfoCircleOutlined />,
        onClick: () => {
          setSelectedFile(record);
          setPropertiesOpen(true);
        },
      },
    ];

    // 压缩包：ZIP 提供浏览 + 解压；其他格式（tar/7z 等）只提供解压
    const lowerName = record.name.toLowerCase();
    const isZip = lowerName.endsWith(".zip");
    const isArchive =
      isZip ||
      lowerName.endsWith(".tar") ||
      lowerName.endsWith(".tar.gz") || lowerName.endsWith(".tgz") ||
      lowerName.endsWith(".tar.bz2") || lowerName.endsWith(".tbz2") ||
      lowerName.endsWith(".tar.xz") || lowerName.endsWith(".txz") ||
      lowerName.endsWith(".7z") ||
      lowerName.endsWith(".gz");
    if (isArchive) {
      if (isZip) {
        items.splice(5, 0, {
          key: "browse-zip",
          label: "浏览压缩包",
          icon: <FileZipOutlined />,
          onClick: () => {
            setZipBrowserPath(record.path);
            setZipBrowserOpen(true);
          },
        });
      }
      items.splice(isZip ? 6 : 5, 0, {
        key: "extract",
        label: "解压缩",
        icon: <FileZipOutlined />,
        onClick: () => handleExtract(record),
      });
    }

    return items;
  }, [handleCopy, handleCut, handleDelete, handleExtract, setSelectedFile, message]);

  // 表格列定义
  const columns = useMemo(() => [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      // 组合排序：先按文件类型分组（同 kind 相邻），组内按字母
      sorter: (a: FileEntry, b: FileEntry) => compareByKindThenName(a, b),
      defaultSortOrder: "ascend" as const,
      onHeaderCell: () => ({ "data-column-key": "name" } as React.ThHTMLAttributes<HTMLTableHeaderCellElement>),
      render: (text: string, record: FileEntry) => {
        const visual = getFileTypeVisual(record.name, record.is_dir);
        const tag = tagsByPath[record.path];
        const tagColor = tag?.color ? getTagColor(tag.color) : undefined;
        return (
          <div
            draggable
            onDragStart={(e) => handleRowDragStart(e, record)}
            onDragEnd={handleRowDragEnd}
            // 单击选中、双击打开 —— 跟 macOS Finder 一致
            // cell 上不放 onClick，避免和行级 onClick（handleRowClick）重复触发
            onDoubleClick={() => record.is_dir && navigateTo(record.path)}
            style={{
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
            title={`${visual.label}${tag?.label ? ` · 🏷 ${tag.label}` : ""}${tag?.note ? ` · 📝 ${tag.note}` : ""} · 拖拽以移动到其他目录；双击打开文件夹`}
          >
            {/* 标签色块（用户自定义的，优先级高于类型色条） */}
            {tagColor && (
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 4,
                  height: 16,
                  borderRadius: 2,
                  background: tagColor,
                  marginRight: 2,
                  flexShrink: 0,
                }}
              />
            )}
            {/* 左侧类型色条（macOS Finder 风格） */}
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 3,
                height: 16,
                borderRadius: 2,
                background: visual.color,
                marginRight: 2,
                flexShrink: 0,
              }}
            />
            <span style={{ color: visual.color, display: "inline-flex", fontSize: 14 }}>
              {visual.icon}
            </span>
            <span
              style={{
                color: selectedFile?.path === record.path ? "#1677ff" : "inherit",
                fontWeight: selectedFile?.path === record.path ? 600 : 400,
              }}
            >
              {text}
            </span>
            {tag?.label && (
              <span
                style={{
                  fontSize: 11,
                  padding: "0 6px",
                  borderRadius: 8,
                  background: tagColor || "#1677ff",
                  color: "#fff",
                  fontWeight: 500,
                  flexShrink: 0,
                }}
              >
                {tag.label}
              </span>
            )}
          </div>
        );
      },
    },
    {
      title: "大小",
      dataIndex: "size",
      key: "size",
      width: columnWidths["size"] ?? 100,
      sorter: (a: FileEntry, b: FileEntry) => a.size - b.size,
      onHeaderCell: () => ({ "data-column-key": "size" } as React.ThHTMLAttributes<HTMLTableHeaderCellElement>),
      render: (size: number, record: FileEntry) => (record.is_dir ? "-" : formatFileSize(size)),
    },
    {
      title: "修改时间",
      dataIndex: "modified",
      key: "modified",
      width: columnWidths["modified"] ?? 180,
      sorter: (a: FileEntry, b: FileEntry) => a.modified - b.modified,
      onHeaderCell: () => ({ "data-column-key": "modified" } as React.ThHTMLAttributes<HTMLTableHeaderCellElement>),
      render: (modified: number) => formatTime(modified),
    },
  ], [selectedFile, handleRowDragStart, handleRowDragEnd, navigateTo, columnWidths]);

  // 快速过滤后的 fileList（用于表格）
  const filteredFileList = useMemo(
    () => (quickFilter ? fuzzyFilter(quickFilter, fileList) : fileList),
    [quickFilter, fileList],
  );

  // 行点击：macOS 原生选择行为
  //   普通点击：清空选择，只选这一行
  //   ⌘/Ctrl + 点击：toggle 这一行（多选）
  //   Shift + 点击：从上一次 anchor 到这一行，区间选择
  //   任何情况都把 selectedFile 更新到当前行（用于预览和单文件操作）
  const handleRowClick = useCallback((e: React.MouseEvent, record: FileEntry) => {
    setSelectedFile(record);

    if (e.shiftKey && selectionAnchor) {
      // 区间选择：anchor → current 之间的所有行
      const startIdx = filteredFileList.findIndex((f) => f.path === selectionAnchor);
      const endIdx = filteredFileList.findIndex((f) => f.path === record.path);
      if (startIdx >= 0 && endIdx >= 0) {
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const range = filteredFileList.slice(from, to + 1).map((f) => f.path);
        setSelectedRowKeys(range);
      } else {
        // anchor 不在当前列表里（切过目录 / 搜索过滤掉了），退化到单选
        setSelectedRowKeys([record.path]);
      }
    } else if (e.metaKey || e.ctrlKey) {
      // toggle
      setSelectedRowKeys((prev) =>
        prev.includes(record.path)
          ? prev.filter((k) => k !== record.path)
          : [...prev, record.path]
      );
    } else {
      // 单选
      setSelectedRowKeys([record.path]);
    }
    setSelectionAnchor(record.path);
  }, [filteredFileList, selectionAnchor]);

  // Virtual Table 要求 scroll.x 必须是数字（"max-content" 会被当作 1px → 行选择列脱位）。
  // 用所有列宽之和 + 安全余量做兜底，让 body 容器有足够空间放下三列数据（行选择列已去掉）。
  const tableScrollX = useMemo(() => {
    const nameCol = 400; // "名称"列没显式 width，按 flex 处理，给个合理下限
    const sizeCol = columnWidths["size"] ?? 100;
    const modCol = columnWidths["modified"] ?? 180;
    return nameCol + sizeCol + modCol;
  }, [columnWidths]);

  // Virtual Table 也要求 scroll.y 是数字。监听 window 高度变化，给一个合理高度。
  const [tableScrollY, setTableScrollY] = useState(() =>
    typeof window === "undefined" ? 500 : window.innerHeight - 240,
  );
  useEffect(() => {
    const onResize = () => setTableScrollY(window.innerHeight - 240);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 批量操作选中的文件
  const selectedFiles = selectedRowKeys.length > 0
    ? fileList.filter((f) => selectedRowKeys.includes(f.path))
    : selectedFile
    ? [selectedFile]
    : [];

  // 键盘快捷键
  useKeyboardShortcuts(useMemo(() => ([
    { key: "b", meta: true, handler: () => setSiderCollapsed((v) => !v), description: "折叠/展开侧栏" },
    { key: "\\", meta: true, handler: () => setPreviewVisible((v) => !v), description: "显示/隐藏预览区" },
    { key: "ArrowLeft", alt: true, handler: goBack, description: "后退" },
    { key: "ArrowRight", alt: true, handler: goForward, description: "前进" },
    { key: "ArrowUp", alt: true, handler: goUp, description: "返回上级" },
    { key: "r", meta: true, handler: () => currentPath && loadDirectory(currentPath), description: "刷新当前目录" },
    { key: "t", meta: true, handler: () => { openTab(currentPath || "/Users/zifang"); }, description: "新建标签页" },
    { key: "w", meta: true, handler: () => { activeTabId && closeTab(activeTabId); }, description: "关闭当前标签页" },
    { key: "h", meta: true, shift: true, handler: () => setShowHidden(!showHidden), description: "显示/隐藏隐藏文件" },
    { key: "1", meta: true, handler: () => setViewMode("table"), description: "表格视图" },
    { key: "2", meta: true, handler: () => setViewMode("list"), description: "列表视图" },
    { key: "3", meta: true, handler: () => setViewMode("grid"), description: "网格视图" },
    { key: "4", meta: true, handler: () => setViewMode("column"), description: "分栏视图" },
    { key: "n", meta: true, shift: true, handler: () => { setCreateModal({ visible: true, type: "file" }); setCreateName(""); }, description: "新建文件" },
    { key: "n", meta: true, alt: true, handler: () => { setCreateModal({ visible: true, type: "dir" }); setCreateName(""); }, description: "新建文件夹" },
    { key: "c", meta: true, handler: () => selectedFiles.length > 0 && handleCopy(selectedFiles), description: "复制选中" },
    { key: "x", meta: true, handler: () => selectedFiles.length > 0 && handleCut(selectedFiles), description: "剪切选中" },
    { key: "v", meta: true, handler: handlePaste, description: "粘贴" },
    { key: "Backspace", meta: true, shift: true, handler: () => selectedFile && handleDelete(selectedFile), description: "删除选中" },
    { key: "Enter", handler: () => {
      // 重命名快捷键：选中文件时按 Enter 打开重命名
      if (selectedFile && !selectedFile.is_dir) {
        setRenameModal({ visible: true, path: selectedFile.path, oldName: selectedFile.name });
        setNewName(selectedFile.name);
      }
    }, allowInInput: false, description: "重命名选中文件" },
    { key: "Escape", handler: () => {
      // 关闭最上层弹窗
      if (renameModal.visible) { setRenameModal({ visible: false, path: "", oldName: "" }); setNewName(""); }
      else if (createModal.visible) { setCreateModal({ visible: false, type: "file" }); setCreateName(""); }
      else if (batchRenameOpen) setBatchRenameOpen(false);
      else if (propertiesOpen) setPropertiesOpen(false);
      else if (dualPanelOpen) setDualPanelOpen(false);
      else if (duplicateFinderOpen) setDuplicateFinderOpen(false);
      else if (hashCalcOpen) setHashCalcOpen(false);
      else if (dirSyncOpen) setDirSyncOpen(false);
      else if (zipBrowserOpen) { setZipBrowserOpen(false); setZipBrowserPath(null); }
      else if (newFileTemplateOpen) setNewFileTemplateOpen(false);
      else if (terminalVisible) setTerminalVisible(false);
    }, description: "关闭弹窗" },
  ]), [
    goBack, goForward, goUp, currentPath, loadDirectory, showHidden, setShowHidden,
    setViewMode, selectedFiles, handleCopy, handleCut, handlePaste, selectedFile, handleDelete,
    renameModal.visible, createModal.visible, batchRenameOpen, propertiesOpen,
    dualPanelOpen, duplicateFinderOpen, hashCalcOpen, dirSyncOpen, zipBrowserOpen,
    newFileTemplateOpen, terminalVisible,
  ]));

  // 侧栏：搜索栏 + 收藏夹 + 暂存栈（文件树已移除，路径导航靠面包屑 + 中间列表 + 上级按钮 + 路径输入框）
  const sidebar = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <CollapsiblePanel title="搜索" defaultExpanded={true}>
        <div style={{ maxHeight: 280, overflow: "auto" }}>
          <SearchBar rootPath={rootPath} />
        </div>
      </CollapsiblePanel>
      <CollapsiblePanel title="收藏夹" defaultExpanded={true}>
        <div style={{ maxHeight: 180, overflow: "auto" }}>
          <Bookmarks onNavigate={(path) => navigateTo(path)} />
        </div>
      </CollapsiblePanel>
      <CollapsiblePanel title="暂存栈" defaultExpanded={true}>
        <div style={{ maxHeight: 200, overflow: "auto" }}>
          <DropStack currentPath={currentPath} onRefresh={() => loadDirectory(currentPath)} />
        </div>
      </CollapsiblePanel>
    </div>
  );

  // 顶栏额外内容：工具栏
  const headerExtra = (
    <>
      <Tooltip title="后退 (⌥+←)" placement="bottom">
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={goBack}
          disabled={historyIndex <= 0}
          size="small"
          aria-label="后退"
        />
      </Tooltip>
      <Tooltip title="前进 (⌥+→)" placement="bottom">
        <Button
          icon={<ArrowRightOutlined />}
          onClick={goForward}
          disabled={historyIndex >= history.length - 1}
          size="small"
          aria-label="前进"
        />
      </Tooltip>
      <Tooltip title="刷新 (⌘+R)" placement="bottom">
        <Button
          icon={<ReloadOutlined />}
          onClick={() => loadDirectory(currentPath)}
          size="small"
          aria-label="刷新"
        />
      </Tooltip>
      <Tooltip title="上级目录 (⌥+↑)" placement="bottom">
        <Button onClick={goUp} size="small" aria-label="上级目录">
          上级
        </Button>
      </Tooltip>
      <Tooltip title={showHidden ? "隐藏隐藏文件 (⌘+Shift+H)" : "显示隐藏文件 (⌘+Shift+H)"} placement="bottom">
        <Button
          size="small"
          icon={showHidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
          onClick={() => setShowHidden(!showHidden)}
          type={showHidden ? "primary" : "text"}
          aria-label={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
        />
      </Tooltip>
    </>
  );

  return (
    <AppShell
      title="z-biz-tool-file"
      icon={<FolderOpenOutlined style={{ fontSize: 18, color: "#1677ff" }} />}
      sidebar={sidebar}
      headerExtra={headerExtra}
      siderWidth={280}
      collapsedSider={siderCollapsed}
      onToggleSider={() => setSiderCollapsed((v) => !v)}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {/* 多标签页 */}
        <TabsBar
          onOpenNewTab={() => {
            const id = openTab(currentPath || "/Users/zifang");
            // 新 tab 默认显示当前路径
            setTimeout(() => {
              const tab = useFileStore.getState().tabs.find((t) => t.id === id);
              if (tab) navigateTo(tab.path);
            }, 0);
          }}
          onSwitchTo={(path) => navigateTo(path)}
        />
        {/* 面包屑 + 路径输入 + 操作按钮 */}
        <Omnibar
          currentPath={currentPath}
          onNavigate={(path) => navigateTo(path)}
          rootPath={rootPath}
          onRootNavigate={(path) => { setRootPath(path); navigateTo(path, true); }}
          onBack={goBack}
          onForward={goForward}
          onUp={goUp}
          historyIndex={historyIndex}
          history={history}
        />

        {/* 操作工具栏 */}
        <div
          role="toolbar"
          aria-label="文件操作工具栏"
          style={{
            padding: "4px 12px",
            borderBottom: `1px solid var(--ant-color-border-secondary, rgba(0,0,0,0.06))`,
            background: "var(--ant-color-bg-container)",
            display: "flex",
            alignItems: "center",
            gap: 4,
            flexWrap: "wrap",
          }}
        >
          {/* 快速过滤（当前目录的模糊搜索） */}
          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined style={{ color: "#999" }} />}
            placeholder="过滤…"
            value={quickFilter}
            onChange={(e) => setQuickFilter(e.target.value)}
            style={{ width: 180 }}
            aria-label="快速过滤当前目录"
          />
          <Tooltip title="新建文件 (⌘+Shift+N)">
            <Button
              size="small"
              icon={<FileAddOutlined />}
              onClick={() => { setCreateModal({ visible: true, type: "file" }); setCreateName(""); }}
            >
              新建文件
            </Button>
          </Tooltip>
          <Tooltip title="新建文件（模板）">
            <Button
              size="small"
              icon={<FileTextOutlined />}
              onClick={() => setNewFileTemplateOpen(true)}
              aria-label="新建文件（模板）"
            />
          </Tooltip>
          <Tooltip title="新建文件夹 (⌘+Alt+N)">
            <Button
              size="small"
              icon={<FolderAddOutlined />}
              onClick={() => { setCreateModal({ visible: true, type: "dir" }); setCreateName(""); }}
            >
              新建文件夹
            </Button>
          </Tooltip>
          <Tooltip title="清理 EPUB 临时缓存（/tmp/z-tool-epub-*）">
            <Button
              size="small"
              icon={<ClearOutlined />}
              onClick={async () => {
                try {
                  const r = await invoke<{ dirs: number; bytes_freed: number }>("cleanup_epub_temp");
                  const mb = (r.bytes_freed / 1024 / 1024).toFixed(1);
                  if (r.dirs === 0) {
                    message.info("没有可清理的 EPUB 临时缓存");
                  } else {
                    message.success(`已清理 ${r.dirs} 个临时目录，释放 ${mb} MB`);
                  }
                } catch (err) {
                  message.error("清理失败: " + err);
                }
              }}
              aria-label="清理 EPUB 临时缓存"
            />
          </Tooltip>
          <Tooltip title="设置 (AI / LLM / 通用)">
            <Button
              size="small"
              icon={<SettingOutlined />}
              onClick={() => setSettingsOpen(true)}
              aria-label="打开设置"
            />
          </Tooltip>
          <Tooltip title="照片馆 (图片媒体库)">
            <Button
              size="small"
              icon={<PictureOutlined />}
              onClick={() => {
                setMediaLibraryType("image");
                setMediaLibraryPath(currentPath);
                setMediaLibraryOpen(true);
              }}
              aria-label="打开照片馆"
            />
          </Tooltip>
          <Tooltip title="视频馆 (视频媒体库)">
            <Button
              size="small"
              icon={<VideoCameraOutlined />}
              onClick={() => {
                setMediaLibraryType("video");
                setMediaLibraryPath(currentPath);
                setMediaLibraryOpen(true);
              }}
              aria-label="打开视频馆"
            />
          </Tooltip>
          <Tooltip title="音乐馆 (音频媒体库)">
            <Button
              size="small"
              icon={<AudioOutlined />}
              onClick={() => {
                setMediaLibraryType("audio");
                setMediaLibraryPath(currentPath);
                setMediaLibraryOpen(true);
              }}
              aria-label="打开音乐馆"
            />
          </Tooltip>
          <Tooltip title="SSH / SFTP 远程浏览">
            <Button
              size="small"
              icon={<CloudServerOutlined />}
              onClick={() => setSftpOpen(true)}
              aria-label="打开 SSH / SFTP"
            />
          </Tooltip>
          <Tooltip title="存储分析（磁盘占用）">
            <Button
              size="small"
              icon={<PieChartOutlined />}
              onClick={() => setStorageOpen(true)}
              aria-label="打开存储分析"
            />
          </Tooltip>
          <Tooltip title="快速操作（脚本/Quick Actions）">
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => setQuickActionsOpen(true)}
              aria-label="打开快速操作"
            />
          </Tooltip>
          <Tooltip title="归档管理器（压缩/解压）">
            <Button
              size="small"
              icon={<FileZipOutlined />}
              onClick={() => {
                setArchiveSources(selectedFiles);
                setArchiveMode("compress");
                setArchiveOpen(true);
              }}
              aria-label="打开归档管理器"
            >
              归档
            </Button>
          </Tooltip>
          <Tooltip title="解压归档（选择 .zip/.tar.gz 等）">
            <Button
              size="small"
              icon={<ExpandOutlined />}
              onClick={() => {
                setArchiveTarget(null);
                setArchiveMode("extract");
                setArchiveOpen(true);
              }}
              aria-label="解压归档"
            >
              解压
            </Button>
          </Tooltip>
          <Tooltip title="PDF 工具集（合并/拆分/水印/压缩/提取图片）">
            <Button
              size="small"
              icon={<FilePdfOutlined />}
              onClick={() => {
                setPdfToolsPath(null);
                setPdfToolsOpen(true);
              }}
              aria-label="打开 PDF 工具集"
            >
              PDF
            </Button>
          </Tooltip>
          <Tooltip title="文件对比（Diff / 目录对比）">
            <Button
              size="small"
              icon={<SwapOutlined />}
              onClick={() => setDiffOpen(true)}
              aria-label="打开文件对比"
            >
              对比
            </Button>
          </Tooltip>
          <Tooltip title="OCR 文字识别（图片/PDF）">
            <Button
              size="small"
              icon={<ScanOutlined />}
              onClick={() => setOcrOpen(true)}
              aria-label="打开 OCR"
            >
              OCR
            </Button>
          </Tooltip>
          <Tooltip title="离线下载 Aria2（HTTP/FTP/magnet/BT）">
            <Button
              size="small"
              icon={<CloudDownloadOutlined />}
              onClick={() => setAria2Open(true)}
              aria-label="打开离线下载"
            >
              下载
            </Button>
          </Tooltip>
          <Tooltip title="图书馆 & 媒体库（Calibre 风格）">
            <Button
              size="small"
              icon={<BookOutlined />}
              onClick={() => setLibraryOpen(true)}
              aria-label="打开图书馆"
            >
              图书馆
            </Button>
          </Tooltip>
          {hasUpdate && (
            <Tooltip title="发现新版本，点击更新">
              <Badge dot>
                <Button
                  size="small"
                  type="primary"
                  icon={<UpOutlined />}
                  onClick={() => setUpdaterOpen(true)}
                  aria-label="更新可用"
                >
                  更新
                </Button>
              </Badge>
            </Tooltip>
          )}
          <Tooltip title="回收站（已删除的文件）">
            <Button
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => setTrashOpen(true)}
              aria-label="打开回收站"
            />
          </Tooltip>
          <Tooltip title="复制 (⌘+C)">
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => selectedFiles.length > 0 && handleCopy(selectedFiles)}
              disabled={selectedFiles.length === 0}
              aria-label="复制"
            />
          </Tooltip>
          <Tooltip title="剪切 (⌘+X)">
            <Button
              size="small"
              icon={<ScissorOutlined />}
              onClick={() => selectedFiles.length > 0 && handleCut(selectedFiles)}
              disabled={selectedFiles.length === 0}
              aria-label="剪切"
            />
          </Tooltip>
          <Tooltip title="粘贴 (⌘+V)">
            <Button
              size="small"
              icon={<SnippetsOutlined />}
              onClick={handlePaste}
              disabled={clipboard.length === 0}
              aria-label="粘贴"
            />
          </Tooltip>
          <Tooltip title="批量重命名">
            <Button
              size="small"
              icon={<FormOutlined />}
              onClick={() => setBatchRenameOpen(true)}
              disabled={selectedFiles.length === 0}
              aria-label="批量重命名"
            />
          </Tooltip>
          <Tooltip title="压缩为ZIP">
            <Button
              size="small"
              icon={<FileZipOutlined />}
              onClick={handleCompress}
              disabled={selectedFiles.length === 0}
              aria-label="压缩为ZIP"
            />
          </Tooltip>
          <Tooltip title="文件属性">
            <Button
              size="small"
              icon={<InfoCircleOutlined />}
              onClick={() => selectedFile && setPropertiesOpen(true)}
              disabled={!selectedFile}
              aria-label="文件属性"
            />
          </Tooltip>
          <FileTagsPanel filePath={selectedFile?.path || null} />
          <Tooltip title="双面板模式">
            <Button
              size="small"
              icon={<ColumnHeightOutlined />}
              onClick={() => setDualPanelOpen(true)}
              aria-label="双面板模式"
            />
          </Tooltip>
          <Tooltip title={autoWatch ? "文件监听已开启，点此关闭" : "文件监听已关闭，点此开启"}>
            <Button
              size="small"
              icon={<RadarChartOutlined />}
              onClick={() => setAutoWatch(!autoWatch)}
              type={autoWatch ? "primary" : "text"}
              aria-label="切换文件监听"
            />
          </Tooltip>
          <Tooltip title="内置终端">
            <Button
              size="small"
              icon={<CodeOutlined />}
              onClick={() => setTerminalVisible(!terminalVisible)}
              type={terminalVisible ? "primary" : "text"}
              aria-label="切换内置终端"
            />
          </Tooltip>
          <Tooltip title="重复文件查找">
            <Button
              size="small"
              icon={<CopyFilled />}
              onClick={() => setDuplicateFinderOpen(true)}
              aria-label="重复文件查找"
            />
          </Tooltip>
          <Tooltip title="目录同步">
            <Button
              size="small"
              icon={<SwapOutlined />}
              onClick={() => setDirSyncOpen(true)}
              aria-label="目录同步"
            />
          </Tooltip>
          <WorkspaceManager
            currentPath={currentPath}
            viewMode={viewMode}
            showHidden={showHidden}
            onRestore={(ws: Workspace) => {
              navigateTo(ws.path);
              setViewMode(ws.viewMode as "table" | "grid" | "list" | "column");
              setShowHidden(ws.showHidden);
            }}
          />
          <GitStatus currentPath={currentPath} />
          <div style={{ flex: 1 }} />
          <Segmented
            size="small"
            value={viewMode}
            onChange={(v) => setViewMode(v as "table" | "grid" | "list" | "column")}
            aria-label="视图切换"
            options={[
              { value: "table", icon: <TableOutlined />, title: "表格 (⌘+1)" },
              { value: "list", icon: <UnorderedListOutlined />, title: "列表 (⌘+2)" },
              { value: "grid", icon: <AppstoreOutlined />, title: "网格 (⌘+3)" },
              { value: "column", label: "分栏", title: "分栏 (⌘+4)" },
            ]}
          />
        </div>

        {/* 文件列表 + 预览区 */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          <DragDropTarget
            targetPath={currentPath}
            targetLabel={currentPath}
            onDrop={() => loadDirectory(currentPath)}
            style={{ flex: 1, overflow: "hidden" }}
          >
            <div
              style={{ height: "100%", overflow: "auto" }}
              role="region"
              aria-label="文件列表"
            >
              {viewMode === "table" ? (
                <Dropdown
                  trigger={["contextMenu"]}
                  menu={{ items: selectedFile ? contextMenuItems(selectedFile) : [] }}
                >
                  <div style={{ height: "100%" }}>
                    <Table
                      columns={columns}
                      dataSource={filteredFileList}
                      rowKey="path"
                      size="small"
                      pagination={false}
                      scroll={{ y: tableScrollY, x: tableScrollX }}
                      virtual
                      // macOS 原生选择：
                      //   点击：单选 ｜ ⌘+点击：toggle ｜ Shift+点击：区间
                      onRow={(record) => ({
                        onClick: (e) => handleRowClick(e, record),
                        onDoubleClick: () => {
                          if (record.is_dir) navigateTo(record.path);
                        },
                      })}
                      rowClassName={(record) =>
                        selectedRowKeys.includes(record.path) ? "z-tool-row-selected" : ""
                      }
                      locale={{
                        emptyText: "该文件夹为空",
                      }}
                      components={{
                        header: {
                          cell: (cellProps: {
                            children?: React.ReactNode;
                            style?: React.CSSProperties;
                            className?: string;
                            "data-column-key"?: string;
                            [key: string]: unknown;
                          }) => {
                            // 通过 onHeaderCell 注入的 data-column-key 拿到当前列标识
                            const colKey = cellProps["data-column-key"];
                            if (!colKey) {
                              return (
                                <ResizableHeaderCell {...cellProps}>
                                  {cellProps.children}
                                </ResizableHeaderCell>
                              );
                            }
                            return (
                              <ResizableHeaderCell
                                {...cellProps}
                                onWidthChange={(delta) => updateColumnWidth(colKey, delta)}
                              >
                                {cellProps.children}
                              </ResizableHeaderCell>
                            );
                          },
                        },
                      }}
                    />
                  </div>
                </Dropdown>
              ) : viewMode === "column" ? (
                <ColumnView
                  currentPath={currentPath}
                  onNavigate={(path) => navigateTo(path)}
                  onFileSelect={(entry) => {
                    setSelectedFile(entry);
                    setSelectedRowKeys([entry.path]);
                  }}
                  selectedFile={selectedFile}
                  showHidden={showHidden}
                />
              ) : (
                <Dropdown
                  trigger={["contextMenu"]}
                  menu={{ items: selectedFile ? contextMenuItems(selectedFile) : [] }}
                >
                  <div style={{ height: "100%" }}>
                    <GridView
                      mode={viewMode}
                      files={fileList}
                      selectedFile={selectedFile}
                      selectedRowKeys={selectedRowKeys}
                      onClick={(entry) => {
                        setSelectedFile(entry);
                        if (!entry.is_dir) {
                          setSelectedRowKeys([entry.path]);
                        }
                      }}
                      onDoubleClick={(entry) => {
                        if (entry.is_dir) navigateTo(entry.path);
                      }}
                      onDragStart={(entry, e) => handleRowDragStart(e, entry)}
                      onDragEnd={handleRowDragEnd}
                    />
                  </div>
                </Dropdown>
              )}
            </div>
          </DragDropTarget>
          {previewVisible && viewMode !== "column" && (
            <>
              {/* 预览区分隔条：拖拽改变预览宽度 */}
              <div
                onMouseDown={handlePreviewDragStart}
                onDoubleClick={() => setPreviewVisible(false)}
                title="拖拽调整宽度 · 双击收起"
                style={{
                  width: 6,
                  cursor: "col-resize",
                  background: "transparent",
                  borderLeft: `1px solid var(--ant-color-border-secondary, rgba(0,0,0,0.06))`,
                  borderRight: `1px solid var(--ant-color-border-secondary, rgba(0,0,0,0.06))`,
                  flexShrink: 0,
                  position: "relative",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "var(--ant-color-primary-bg, rgba(22,119,255,0.12))";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "transparent";
                }}
                role="separator"
                aria-orientation="vertical"
                aria-label="预览区分隔条"
              />
              <div
                style={{
                  width: previewWidth,
                  background: "var(--ant-color-bg-container)",
                  overflow: "hidden",
                }}
                role="region"
                aria-label="预览区"
              >
                <PreviewPane onCollapse={() => setPreviewVisible(false)} />
              </div>
            </>
          )}
          {!previewVisible && (
            <Tooltip title="展开预览 (⌘+\\)" placement="left">
              <Button
                size="small"
                type="text"
                icon={<EyeInvisibleOutlined />}
                onClick={() => setPreviewVisible(true)}
                style={{ alignSelf: "flex-start", margin: "8px 4px" }}
                aria-label="展开预览区"
              />
            </Tooltip>
          )}
        </div>

        {/* 内置终端 */}
        <BuiltInTerminal
          currentPath={currentPath}
          onPathChange={(path) => navigateTo(path)}
          visible={terminalVisible}
          onClose={() => setTerminalVisible(false)}
        />
      </div>

      {/* 重命名弹窗 */}
      <ModalWrap
        title="重命名"
        open={renameModal.visible}
        onOk={handleRename}
        onCancel={() => { setRenameModal({ visible: false, path: "", oldName: "" }); setNewName(""); }}
        okText="确定"
        cancelText="取消"
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={handleRename}
          autoFocus
        />
      </ModalWrap>

      {/* 新建文件/文件夹弹窗 */}
      <ModalWrap
        title={createModal.type === "file" ? "新建文件" : "新建文件夹"}
        open={createModal.visible}
        onOk={handleCreate}
        onCancel={() => { setCreateModal({ visible: false, type: "file" }); setCreateName(""); }}
        okText="创建"
        cancelText="取消"
      >
        <Input
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          onPressEnter={handleCreate}
          placeholder={createModal.type === "file" ? "请输入文件名（含扩展名）" : "请输入文件夹名"}
          autoFocus
        />
      </ModalWrap>

      {/* 批量重命名 */}
      <BatchRename
        open={batchRenameOpen}
        onClose={() => setBatchRenameOpen(false)}
        onRefresh={() => loadDirectory(currentPath)}
        files={selectedFiles}
      />

      {/* 文件属性 */}
      <FileProperties
        open={propertiesOpen}
        onClose={() => setPropertiesOpen(false)}
        filePath={selectedFile?.path || null}
      />

      {/* 双面板视图 */}
      {dualPanelOpen && (
        <DualPanelView
          onClose={() => setDualPanelOpen(false)}
          onOpenFile={(path) => {
            invoke("open_with_default_app", { path }).catch((err) =>
              message.error("打开失败: " + err)
            );
          }}
        />
      )}

      {/* 重复文件查找 */}
      <DuplicateFinder
        open={duplicateFinderOpen}
        onClose={() => setDuplicateFinderOpen(false)}
        currentPath={currentPath}
        onRefresh={() => loadDirectory(currentPath)}
      />

      {/* 哈希计算 */}
      <HashCalculator
        open={hashCalcOpen}
        onClose={() => setHashCalcOpen(false)}
        filePath={selectedFile?.path || null}
      />

      {/* 目录同步 */}
      <DirectorySync
        open={dirSyncOpen}
        onClose={() => setDirSyncOpen(false)}
        currentPath={currentPath}
      />

      {/* ZIP 浏览器 */}
      <ZipBrowser
        open={zipBrowserOpen}
        onClose={() => { setZipBrowserOpen(false); setZipBrowserPath(null); }}
        zipPath={zipBrowserPath}
        currentPath={currentPath}
        onRefresh={() => loadDirectory(currentPath)}
      />

      {/* PDF 工具集 */}
      <PdfTools
        open={pdfToolsOpen}
        onClose={() => {
          setPdfToolsOpen(false);
          setPdfToolsPath(null);
        }}
        initialPath={pdfToolsPath}
      />

      {/* 文件对比 */}
      <DiffViewer
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
      />

      {/* OCR */}
      <OcrTool open={ocrOpen} onClose={() => setOcrOpen(false)} />

      {/* Aria2 离线下载 */}
      <Aria2Manager open={aria2Open} onClose={() => setAria2Open(false)} />

      {/* 图书馆 & 媒体库 */}
      <LibraryView open={libraryOpen} onClose={() => setLibraryOpen(false)} />

      {/* 应用更新 */}
      <Updater open={updaterOpen} onClose={() => setUpdaterOpen(false)} />

      {/* 归档管理器 (压缩/解压) */}
      <ArchiveManager
        open={archiveOpen}
        onClose={() => {
          setArchiveOpen(false);
          setArchiveSources([]);
          setArchiveTarget(null);
        }}
        sourcePaths={archiveMode === "compress" ? archiveSources : undefined}
        archivePath={archiveMode === "extract" ? archiveTarget : null}
        onRefresh={() => loadDirectory(currentPath)}
      />

      {/* 新建文件模板 */}
      <NewFileTemplate
        open={newFileTemplateOpen}
        onClose={() => setNewFileTemplateOpen(false)}
        currentPath={currentPath}
        onRefresh={() => loadDirectory(currentPath)}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      {/* 媒体库视图 */}
      {mediaLibraryOpen && (
        <Modal
          title={
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {mediaLibraryType === "image" && <PictureOutlined style={{ color: "#1677ff" }} />}
              {mediaLibraryType === "video" && <VideoCameraOutlined style={{ color: "#1677ff" }} />}
              {mediaLibraryType === "audio" && <AudioOutlined style={{ color: "#1677ff" }} />}
              {mediaLibraryType === "image" && "照片馆"}
              {mediaLibraryType === "video" && "视频馆"}
              {mediaLibraryType === "audio" && "音乐馆"}
            </div>
          }
          open={mediaLibraryOpen}
          onClose={() => setMediaLibraryOpen(false)}
          width="90vw"
          height="80vh"
          footer={null}
          styles={{ body: { padding: "0", overflow: "hidden" } }}
        >
          <div style={{ height: "100%", overflow: "hidden" }}>
            <MediaGallery
              directory={mediaLibraryPath}
              mediaType={mediaLibraryType}
              onItemDoubleClick={(item) => {
                invoke("open_with_default_app", { path: item.path }).catch((err) =>
                  message.error("打开失败: " + err)
                );
              }}
              onItemRightClick={(item, e) => {
                e.preventDefault();
                const menuItems: MenuProps["items"] = [
                  { key: "open", label: "打开", onClick: () => invoke("open_with_default_app", { path: item.path }) },
                  { key: "copy", label: "复制", onClick: () => handleCopy([item]) },
                  { key: "delete", label: "删除", onClick: () => handleDelete(item) },
                ];
                Modal.confirm({
                  title: "操作确认",
                  content: `确定要删除「${item.name}」吗？`,
                  onOk: async () => {
                    await handleDelete(item, false);
                  },
                });
              }}
            />
          </div>
        </Modal>
      )}
      <TrashModal
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onRestored={() => loadDirectory(currentPath)}
      />
      <SftpModal
        open={sftpOpen}
        onClose={() => setSftpOpen(false)}
      />
      <StorageAnalyzerModal
        open={storageOpen}
        onClose={() => setStorageOpen(false)}
        initialPath={currentPath || "/Users/zifang"}
      />
      <TagEditModal
        open={tagEditOpen}
        onClose={() => setTagEditOpen(false)}
        filePath={selectedFile?.path ?? ""}
        fileName={selectedFile?.name ?? ""}
      />
      <QuickActionsModal
        open={quickActionsOpen}
        onClose={() => setQuickActionsOpen(false)}
      />

      {/* 传输队列 */}
      <TransferQueue />
    </AppShell>
  );
}

// Modal 包装：确保 z-index 提升到 AntdApp 内的统一容器
function ModalWrap({
  open,
  onOk,
  onCancel,
  title,
  okText,
  cancelText,
  children,
}: {
  open: boolean;
  onOk: () => void;
  onCancel: () => void;
  title: ReactNode;
  okText?: string;
  cancelText?: string;
  children: ReactNode;
}) {
  return (
    <Modal
      title={title}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      okText={okText}
      cancelText={cancelText}
      destroyOnClose
      maskClosable={false}
    >
      {children}
    </Modal>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AntdApp>
        <AppShellInner />
      </AntdApp>
    </ThemeProvider>
  );
}