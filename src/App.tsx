import { useState, useEffect, useCallback, useRef } from "react";
import {
  Input, Button, Breadcrumb, Table, Dropdown, message, Modal, theme,
  Tooltip, Segmented,
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
import { ThemeProvider, AppShell } from "./_shared";

export default function App() {
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
  const { token } = theme.useToken();

  const {
    currentPath, fileList, selectedFile, showHidden, viewMode,
    clipboard,
    setSelectedFile, setCurrentPath, setFileList,
    setShowHidden, setViewMode,
    setClipboard, clearClipboard,
  } = useFileStore();

  // 初始化：macOS默认用户目录
  useEffect(() => {
    const defaultPath = "/Users/zifang";
    setRootPath(defaultPath);
    navigateTo(defaultPath, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 导航到路径
  const navigateTo = (path: string, isRoot: boolean = false) => {
    setCurrentPath(path);
    loadDirectory(path);

    if (isRoot) {
      setHistory([path]);
      setHistoryIndex(0);
    } else {
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(path);
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
    }
  };

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
  }, [showHidden, setFileList]);

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
  const goBack = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      const path = history[newIndex];
      setCurrentPath(path);
      loadDirectory(path);
    }
  };

  // 前进
  const goForward = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      const path = history[newIndex];
      setCurrentPath(path);
      loadDirectory(path);
    }
  };

  // 返回上级目录
  const goUp = () => {
    if (currentPath && currentPath !== "/") {
      const parts = currentPath.split("/").filter(Boolean);
      parts.pop();
      const parentPath = "/" + parts.join("/");
      navigateTo(parentPath || "/");
    }
  };

  // 文件/文件夹点击
  const handleFileClick = (entry: FileEntry) => {
    setSelectedFile(entry);
    if (entry.is_dir) {
      navigateTo(entry.path);
    }
  };

  // 面包屑导航
  const buildBreadcrumbItems = (): BreadcrumbProps["items"] => {
    if (!currentPath) return [];
    const parts = currentPath.split("/").filter(Boolean);
    const items: NonNullable<BreadcrumbProps["items"]> = [
      {
        title: (
          <span onClick={() => navigateTo("/", true)} style={{ cursor: "pointer" }}>
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
          <span onClick={() => navigateTo(currentPathCopy)} style={{ cursor: "pointer" }}>
            {part}
          </span>
        ),
      });
    });
    return items;
  };

  // 剪贴板操作
  const handleCopy = (entries: FileEntry[]) => {
    setClipboard(
      entries.map((e) => ({ path: e.path, name: e.name, is_dir: e.is_dir, operation: "copy" as const })),
      "copy"
    );
    message.success(`已复制 ${entries.length} 项`);
  };

  const handleCut = (entries: FileEntry[]) => {
    setClipboard(
      entries.map((e) => ({ path: e.path, name: e.name, is_dir: e.is_dir, operation: "cut" as const })),
      "cut"
    );
    message.success(`已剪切 ${entries.length} 项`);
  };

  const handlePaste = async () => {
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
  };

  // 拖拽源（行级别）：从表格行拖出
  const handleRowDragStart = (e: ReactDragEvent, record: FileEntry) => {
    // 如果该行被选中，拖拽所有选中的；否则只拖这一个
    const items = selectedRowKeys.includes(record.path) && selectedRowKeys.length > 0
      ? selectedRowKeys.map(String)
      : [record.path];
    e.dataTransfer.setData("application/x-z-tool-paths", JSON.stringify(items));
    // 把拖拽来源信息也存一下（用于剪贴板兼容）
    e.dataTransfer.setData("application/x-z-tool-operation", "cut");
    e.dataTransfer.effectAllowed = "move";
  };

  const handleRowDragEnd = () => {
    // dragend - 浏览器内部会清理 dataTransfer
  };

  // 新建文件/文件夹
  const handleCreate = async () => {
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
  };

  // 压缩
  const handleCompress = async () => {
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
  };

  // 解压
  const handleExtract = async (entry: FileEntry) => {
    if (!entry.name.endsWith(".zip")) return;
    const dirName = entry.name.replace(/\.zip$/i, "");
    try {
      await invoke("extract_zip", { zipPath: entry.path, destDir: currentPath + "/" + dirName });
      message.success("解压成功: " + dirName);
      loadDirectory(currentPath);
    } catch (err) {
      message.error("解压失败: " + err);
    }
  };

  // 删除文件
  const handleDelete = (entry: FileEntry) => {
    Modal.confirm({
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
  };

  // 重命名
  const handleRename = async () => {
    if (!renameModal.path || !newName.trim()) return;
    try {
      await invoke("rename_file", { oldPath: renameModal.path, newName: newName.trim() });
      message.success("重命名成功");
      loadDirectory(currentPath);
    } catch (err) {
      message.error("重命名失败: " + err);
    }
    setRenameModal({ visible: false, path: "", oldName: "" });
  };

  // 右键菜单
  const contextMenuItems = (record: FileEntry): MenuProps["items"] => {
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
        label: "复制",
        icon: <CopyOutlined />,
        onClick: () => handleCopy([record]),
      },
      {
        key: "cut",
        label: "剪切",
        icon: <ScissorOutlined />,
        onClick: () => handleCut([record]),
      },
      {
        key: "rename",
        label: "重命名",
        icon: <EditOutlined />,
        onClick: () => {
          setRenameModal({ visible: true, path: record.path, oldName: record.name });
          setNewName(record.name);
        },
      },
      {
        key: "delete",
        label: "删除",
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
  };

  // 表格列定义
  const columns = [
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
          style={{
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
          title="拖拽以移动到其他目录"
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
  ];

  // 侧栏：搜索栏 + 收藏夹 + 暂存栈 + 文件树
  const sidebar = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flexShrink: 0 }}>
        <SearchBar rootPath={rootPath} />
      </div>
      <div style={{ flexShrink: 0, maxHeight: 180, overflow: "auto" }}>
        <Bookmarks onNavigate={(path) => navigateTo(path)} />
      </div>
      <div style={{ flexShrink: 0, maxHeight: 200, overflow: "auto" }}>
        <DropStack currentPath={currentPath} onRefresh={() => loadDirectory(currentPath)} />
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <FileTree rootPath={rootPath} />
      </div>
    </div>
  );

  // 顶栏额外内容：工具栏
  const headerExtra = (
    <>
      <Button
        icon={<ArrowLeftOutlined />}
        onClick={goBack}
        disabled={historyIndex <= 0}
        size="small"
      />
      <Button
        icon={<ArrowRightOutlined />}
        onClick={goForward}
        disabled={historyIndex >= history.length - 1}
        size="small"
      />
      <Button icon={<ReloadOutlined />} onClick={() => loadDirectory(currentPath)} size="small" />
      <Button onClick={goUp} size="small">
        上级
      </Button>
      <Button
        size="small"
        icon={showHidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
        onClick={() => setShowHidden(!showHidden)}
        type={showHidden ? "primary" : "text"}
        title={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
      />
    </>
  );

  // 批量操作选中的文件
  const selectedFiles = selectedRowKeys.length > 0
    ? fileList.filter((f) => selectedRowKeys.includes(f.path))
    : selectedFile
    ? [selectedFile]
    : [];

  return (
    <ThemeProvider>
      <AppShell
        title="z-biz-tool-file"
        icon={<FolderOpenOutlined style={{ fontSize: 18, color: "#1677ff" }} />}
        sidebar={sidebar}
        headerExtra={headerExtra}
        siderWidth={280}
      >
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          {/* 面包屑 + 路径输入 + 操作按钮 */}
          <div
            style={{
              padding: "8px 12px",
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: token.colorBgContainer,
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
            />
          </div>

          {/* 操作工具栏 */}
          <div
            style={{
              padding: "4px 12px",
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgContainer,
              display: "flex",
              alignItems: "center",
              gap: 4,
              flexWrap: "wrap",
            }}
          >
            <Tooltip title="新建文件">
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
              />
            </Tooltip>
            <Tooltip title="新建文件夹">
              <Button
                size="small"
                icon={<FolderAddOutlined />}
                onClick={() => { setCreateModal({ visible: true, type: "dir" }); setCreateName(""); }}
              >
                新建文件夹
              </Button>
            </Tooltip>
            <Tooltip title="复制">
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => selectedFiles.length > 0 && handleCopy(selectedFiles)}
                disabled={selectedFiles.length === 0}
              />
            </Tooltip>
            <Tooltip title="剪切">
              <Button
                size="small"
                icon={<ScissorOutlined />}
                onClick={() => selectedFiles.length > 0 && handleCut(selectedFiles)}
                disabled={selectedFiles.length === 0}
              />
            </Tooltip>
            <Tooltip title="粘贴">
              <Button
                size="small"
                icon={<SnippetsOutlined />}
                onClick={handlePaste}
                disabled={clipboard.length === 0}
              />
            </Tooltip>
            <Tooltip title="批量重命名">
              <Button
                size="small"
                icon={<FormOutlined />}
                onClick={() => setBatchRenameOpen(true)}
                disabled={selectedFiles.length === 0}
              />
            </Tooltip>
            <Tooltip title="压缩为ZIP">
              <Button
                size="small"
                icon={<FileZipOutlined />}
                onClick={handleCompress}
                disabled={selectedFiles.length === 0}
              />
            </Tooltip>
            <Tooltip title="文件属性">
              <Button
                size="small"
                icon={<InfoCircleOutlined />}
                onClick={() => selectedFile && setPropertiesOpen(true)}
                disabled={!selectedFile}
              />
            </Tooltip>
            <FileTagsPanel filePath={selectedFile?.path || null} />
            <Tooltip title="双面板模式">
              <Button
                size="small"
                icon={<ColumnHeightOutlined />}
                onClick={() => setDualPanelOpen(true)}
              />
            </Tooltip>
            <Tooltip title={autoWatch ? "文件监听已开启，点此关闭" : "文件监听已关闭，点此开启"}>
              <Button
                size="small"
                icon={<RadarChartOutlined />}
                onClick={() => setAutoWatch(!autoWatch)}
                type={autoWatch ? "primary" : "text"}
              />
            </Tooltip>
            <Tooltip title="内置终端">
              <Button
                size="small"
                icon={<CodeOutlined />}
                onClick={() => setTerminalVisible(!terminalVisible)}
                type={terminalVisible ? "primary" : "text"}
              />
            </Tooltip>
            <Tooltip title="重复文件查找">
              <Button
                size="small"
                icon={<CopyFilled />}
                onClick={() => setDuplicateFinderOpen(true)}
              />
            </Tooltip>
            <Tooltip title="目录同步">
              <Button
                size="small"
                icon={<SwapOutlined />}
                onClick={() => setDirSyncOpen(true)}
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
              options={[
                { value: "table", icon: <TableOutlined /> },
                { value: "list", icon: <UnorderedListOutlined /> },
                { value: "grid", icon: <AppstoreOutlined /> },
                { value: "column", label: "分栏" },
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
              <div style={{ height: "100%", overflow: "auto" }}>
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
                        })}
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
                background: token.colorBgContainer,
                borderLeft: `1px solid ${token.colorBorderSecondary}`,
                overflow: "hidden",
              }}
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
        <Modal
          title="重命名"
          open={renameModal.visible}
          onOk={handleRename}
          onCancel={() => setRenameModal({ visible: false, path: "", oldName: "" })}
          okText="确定"
          cancelText="取消"
        >
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onPressEnter={handleRename}
          />
        </Modal>

        {/* 新建文件/文件夹弹窗 */}
        <Modal
          title={createModal.type === "file" ? "新建文件" : "新建文件夹"}
          open={createModal.visible}
          onOk={handleCreate}
          onCancel={() => setCreateModal({ visible: false, type: "file" })}
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
        </Modal>

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
    </ThemeProvider>
  );
}
