import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import {
  Input, Button, Breadcrumb, Table, Dropdown, App as AntdApp, Tooltip, Segmented, Modal,
} from "antd";
import type { MenuProps, BreadcrumbProps } from "antd";
import type { DragEvent as ReactDragEvent } from "react";
import {
  FolderOutlined,
  FileOutlined,
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
  FormOutlined,
  ColumnHeightOutlined,
  RadarChartOutlined,
  CodeOutlined,
  CopyFilled,
  SwapOutlined,
  SafetyCertificateOutlined,
  TagOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useFileStore, formatFileSize, formatTime, type FileEntry,
} from "./stores/fileStore";
import FileTree from "./components/FileTree";
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
import GitStatus from "./components/GitStatus";
import ColumnView from "./components/ColumnView";
import FileTagsPanel from "./components/FileTagsPanel";
import NewFileTemplate from "./components/NewFileTemplate";
import ZipBrowser from "./components/ZipBrowser";
import TransferQueue from "./components/TransferQueue";
import { DragDropTarget } from "./components/DragDropMove";
import { ThemeProvider, AppShell, useKeyboardShortcuts, CollapsiblePanel } from "./_shared";

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
  const [dualPanelOpen, setDualPanelOpen] = useState(false);
  const [autoWatch, setAutoWatch] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [duplicateFinderOpen, setDuplicateFinderOpen] = useState(false);
  const [hashCalcOpen, setHashCalcOpen] = useState(false);
  const [dirSyncOpen, setDirSyncOpen] = useState(false);
  const [zipBrowserOpen, setZipBrowserOpen] = useState(false);
  const [zipBrowserPath, setZipBrowserPath] = useState<string | null>(null);
  const [newFileTemplateOpen, setNewFileTemplateOpen] = useState(false);
  const [siderCollapsed, setSiderCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("z-tool-sider-collapsed") === "1";
  });

  const {
    currentPath, fileList, selectedFile, showHidden, viewMode,
    clipboard,
    setSelectedFile, setCurrentPath, setFileList,
    setShowHidden, setViewMode,
    setClipboard, clearClipboard,
  } = useFileStore();

  // 记忆侧栏折叠状态
  useEffect(() => {
    localStorage.setItem("z-tool-sider-collapsed", siderCollapsed ? "1" : "0");
  }, [siderCollapsed]);

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

  // 导航到路径
  const navigateTo = useCallback((path: string, isRoot: boolean = false) => {
    setCurrentPath(path);
    loadDirectory(path);

    setHistory((prev) => {
      if (isRoot) return [path];
      const newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push(path);
      setHistoryIndex(newHistory.length - 1);
      return newHistory;
    });
  }, [historyIndex, setCurrentPath, loadDirectory]);

  // 初始化：macOS默认用户目录
  useEffect(() => {
    const defaultPath = "/Users/zifang";
    setRootPath(defaultPath);
    navigateTo(defaultPath, true);
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

  // 文件/文件夹点击
  const handleFileClick = useCallback((entry: FileEntry) => {
    setSelectedFile(entry);
    if (entry.is_dir) {
      navigateTo(entry.path);
    }
  }, [setSelectedFile, navigateTo]);

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

  // 解压
  const handleExtract = useCallback(async (entry: FileEntry) => {
    if (!entry.name.endsWith(".zip")) return;
    const dirName = entry.name.replace(/\.zip$/i, "");
    try {
      await invoke("extract_zip", { zipPath: entry.path, destDir: currentPath + "/" + dirName });
      message.success("解压成功: " + dirName);
      loadDirectory(currentPath);
    } catch (err) {
      message.error("解压失败: " + err);
    }
  }, [currentPath, loadDirectory, message]);

  // 删除文件
  const handleDelete = useCallback((entry: FileEntry) => {
    modal.confirm({
      title: "确认删除",
      content: `确定要删除「${entry.name}」吗？此操作不可恢复。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await invoke("delete_file", { path: entry.path });
          message.success("删除成功");
          loadDirectory(currentPath);
        } catch (err) {
          message.error("删除失败: " + err);
        }
      },
    });
  }, [currentPath, loadDirectory, message, modal]);

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
        label: "删除 (⌘+Shift+⌫)",
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () => handleDelete(record),
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
        label: "标签",
        icon: <TagOutlined />,
        onClick: () => {
          setSelectedFile(record);
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

    // ZIP文件增加解压和浏览选项
    if (record.name.endsWith(".zip")) {
      items.splice(5, 0, {
        key: "browse-zip",
        label: "浏览压缩包",
        icon: <FileZipOutlined />,
        onClick: () => {
          setZipBrowserPath(record.path);
          setZipBrowserOpen(true);
        },
      }, {
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
      sorter: (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name),
      render: (text: string, record: FileEntry) => (
        <div
          draggable
          onDragStart={(e) => handleRowDragStart(e, record)}
          onDragEnd={handleRowDragEnd}
          onClick={() => handleFileClick(record)}
          onDoubleClick={() => record.is_dir && navigateTo(record.path)}
          style={{
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
          title="拖拽以移动到其他目录；双击打开文件夹"
        >
          {record.is_dir ? (
            <FolderOutlined style={{ color: "#faad14" }} />
          ) : (
            <FileOutlined style={{ color: "#8c8c8c" }} />
          )}
          <span
            style={{
              color: selectedFile?.path === record.path ? "#1677ff" : "inherit",
              fontWeight: selectedFile?.path === record.path ? 600 : 400,
            }}
          >
            {text}
          </span>
        </div>
      ),
    },
    {
      title: "大小",
      dataIndex: "size",
      key: "size",
      width: 100,
      sorter: (a: FileEntry, b: FileEntry) => a.size - b.size,
      render: (size: number, record: FileEntry) => (record.is_dir ? "-" : formatFileSize(size)),
    },
    {
      title: "修改时间",
      dataIndex: "modified",
      key: "modified",
      width: 180,
      sorter: (a: FileEntry, b: FileEntry) => a.modified - b.modified,
      render: (modified: number) => formatTime(modified),
    },
  ], [selectedFile, handleRowDragStart, handleRowDragEnd, handleFileClick, navigateTo]);

  // 批量操作选中的文件
  const selectedFiles = selectedRowKeys.length > 0
    ? fileList.filter((f) => selectedRowKeys.includes(f.path))
    : selectedFile
    ? [selectedFile]
    : [];

  // 键盘快捷键
  useKeyboardShortcuts(useMemo(() => ([
    { key: "b", meta: true, handler: () => setSiderCollapsed((v) => !v), description: "折叠/展开侧栏" },
    { key: "ArrowLeft", alt: true, handler: goBack, description: "后退" },
    { key: "ArrowRight", alt: true, handler: goForward, description: "前进" },
    { key: "ArrowUp", alt: true, handler: goUp, description: "返回上级" },
    { key: "r", meta: true, handler: () => currentPath && loadDirectory(currentPath), description: "刷新当前目录" },
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

  // 侧栏：搜索栏 + 收藏夹 + 暂存栈 + 文件树
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
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <CollapsiblePanel title="文件树" defaultExpanded={true}>
          <FileTree rootPath={rootPath} />
        </CollapsiblePanel>
      </div>
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
        {/* 面包屑 + 路径输入 + 操作按钮 */}
        <div
          style={{
            padding: "8px 12px",
            borderBottom: `1px solid var(--ant-color-border-secondary, rgba(0,0,0,0.06))`,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--ant-color-bg-container)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <Breadcrumb items={buildBreadcrumbItems()} />
          </div>
          <Input
            placeholder="根目录路径"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            onPressEnter={() => navigateTo(rootPath, true)}
            style={{ width: 200 }}
            size="small"
            aria-label="根目录路径"
          />
        </div>

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
                      dataSource={fileList}
                      rowKey="path"
                      size="small"
                      pagination={false}
                      scroll={{ y: "calc(100vh - 240px)" }}
                      rowSelection={{
                        selectedRowKeys,
                        onChange: setSelectedRowKeys,
                      }}
                      onRow={(record) => ({
                        onClick: () => {
                          setSelectedFile(record);
                          if (!record.is_dir) {
                            setSelectedRowKeys([record.path]);
                          }
                        },
                        onDoubleClick: () => {
                          if (record.is_dir) navigateTo(record.path);
                        },
                      })}
                      locale={{
                        emptyText: "该文件夹为空",
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
          <div
            style={{
              width: 420,
              background: "var(--ant-color-bg-container)",
              borderLeft: `1px solid var(--ant-color-border-secondary, rgba(0,0,0,0.06))`,
              overflow: "hidden",
            }}
            role="region"
            aria-label="预览区"
          >
            <PreviewPane />
          </div>
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

      {/* 新建文件模板 */}
      <NewFileTemplate
        open={newFileTemplateOpen}
        onClose={() => setNewFileTemplateOpen(false)}
        currentPath={currentPath}
        onRefresh={() => loadDirectory(currentPath)}
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