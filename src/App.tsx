import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense, type ReactNode } from "react";
import {
  Input, Button, Table, Dropdown, App as AntdApp, Tooltip, Segmented, Modal,
} from "antd";
import type { MenuProps } from "antd";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  SearchOutlined,
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
  BookOutlined,
  ReadOutlined,
  FormOutlined,
  ColumnHeightOutlined,
  RadarChartOutlined,
  CodeOutlined,
  // 数据库板块（2026-11-06 从 z-biz-tool-db 仓搬入）
  DatabaseOutlined,
  DashboardOutlined,
  ProjectOutlined,
  CopyFilled,
  SwapOutlined,
  SafetyCertificateOutlined,
  TagOutlined,
  FileTextOutlined,
  ClearOutlined,
  SettingOutlined,
  CloudServerOutlined,
  ThunderboltOutlined,
  PieChartOutlined,
  PictureOutlined,
  PicRightOutlined,
  VideoCameraOutlined,
  AudioOutlined,
  RocketOutlined,
  StarOutlined,
  InboxOutlined,
  ToolOutlined,
  GlobalOutlined,
  BulbOutlined,
  BulbFilled,
  ShareAltOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startDeepLinkReceiver, ZBIZ_TAKE_PENDING } from "z-biz-tool-shared/protocol";
import { resolveFileDeepLink, type HandoffItem } from "./_shared/deepLink";
// 终端板块的深链交接槽（纯数据模块，不带 React/xterm，不会破坏懒加载分包）
import { putTerminalHandoff } from "./apps/terminal/handoff";
// 系统监控板块的深链分流槽（与终端同一个模式：本仓只留一个接收器）
import { putSysHandoff } from "./apps/sys/handoff";
// AI 任务看板板块的深链分流槽（与终端/系统同一个模式：本仓只留一个接收器）
import { putWorkerHandoff } from "./apps/worker/handoff";
// 思维导图板块的深链分流槽（纯数据模块，不拖 React 依赖进首屏）
import { putMindHandoff } from "./apps/mind/handoff";
import { getFileTypeVisual, compareByKindThenName } from "./utils/fileTypeIcon";
import { fuzzyFilter } from "./utils/fuzzyMatch";
import { toKeySet } from "./utils/virtualList";
// 标签色板与配色函数单独住一个文件：App.tsx 只用 getTagColor 一个纯函数，
// 从 TagEditModal 里 import 会把整个弹窗（连带 antd Form/Select）静态拖回首屏。
import { getTagColor } from "./utils/tagColor";
import { Skeleton } from "antd";
import ErrorBoundary from "./components/ErrorBoundary";
import { resolveHomeDir, homeDirSync } from "./utils/homeDir";
import { batchToast, placeBatch } from "./utils/conflictChoice";
import { syncDirIndex } from "./services/indexService";
import { lastExtension, openRejectText, resolveOpen, resolveRenameTarget } from "./utils/openBehavior";
import type { HashTarget } from "./utils/batchHash";
import {
  useFileStore, formatFileSize, formatTime, type FileEntry,
} from "./stores/fileStore";
import PreviewPane from "./components/PreviewPane";
import SearchBar from "./components/SearchBar";
import Bookmarks from "./components/Bookmarks";
import GridView from "./components/GridView";
import DualPanelView from "./components/DualPanelView";
import BuiltInTerminal from "./components/BuiltInTerminal";
import DropStack from "./components/DropStack";
import WorkspaceManager, { type Workspace } from "./components/WorkspaceManager";
import TabsBar from "./components/TabsBar";
import GitStatus from "./components/GitStatus";
import ColumnView from "./components/ColumnView";
import FileTagsPanel from "./components/FileTagsPanel";
import type { CreateSource } from "./components/ArchiveCreateDialog";
import ArchiveJobPanel from "./components/ArchiveJobPanel";
import { useArchiveJobStore } from "./stores/archiveJobStore";
import { describeArchiveError, fsBaseName, joinFsPath, type ExtractOptions } from "./utils/archiveModel";
import {
  UpdateCenterProvider,
  UpdateLauncher,
  UpdateTopButton,
} from "./components/UpdateCenter";
import TransferQueue from "./components/TransferQueue";
import { DragDropTarget } from "./components/DragDropMove";
// 「点开才用」的弹窗统一走 lazyModal（open 为真才挂载，否则不发起 import）
import { lazyModal } from "./_shared/lazyModal";
import { APP_VERSION, BUILD_TIME, GIT_HASH } from "./_shared/version";
import {
  ThemeProvider,
  AppShell,
  shortcutHints,
  useKeyboardShortcuts,
  useTheme,
} from "./_shared";
import {
  hintSuffixOf,
  ShortcutHintsProvider,
} from "./_shared/ShortcutHints";
import Omnibar from "./_shared/Omnibar";
import ActivityBar, { ActivityBarMore, type ActivityBarApp, type ActivityBarItem } from "./components/ActivityBar";
import SidebarPanel from "./components/SidebarPanel";
import { sizeControlEnabled, type MediaGallerySize, type MediaViewMode } from "./utils/mediaLayout";
import { parentOfPath } from "./utils/parentDir";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { checkFileNameForCreate, sanitizeFileNameInput } from "./utils/validateFileName";
import { topmostLayer, type LayerState } from "./utils/layerStack";

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

/**
 * 活动栏上半截的「应用」清单。
 *
 * 活动栏是纵向两段：
 *  1. 应用（这里）—— 决定主区进哪个板块，永远有且只有一个处于选中态；
 *  2. 应用之下的功能项（搜索/收藏夹/终端…）—— 点开一块面板，再点收起。
 *
 * file 仓的本体就是第一个应用「文件管理」，所以默认一打开就在它里面，
 * 不需要先点一下图标。以后要把别的板块（笔记、图书馆…）并进来，
 * 在这里加一条即可，主区的分支在下面 `activeApp === "files"` 那处。
 */
const RAIL_APPS: ActivityBarApp[] = [
  { key: "files", label: "文件管理", icon: <FolderOpenOutlined /> },
  { key: "terminal", label: "终端", icon: <CodeOutlined /> },
  { key: "library", label: "图书馆", icon: <ReadOutlined /> },
  // 图片库：紧贴图书馆。两者是同一类「按类型看内容」的视图（书 / 图），
  // 都独立于文件管理的目录树 —— 放在一起，用户找"换个方式看我的东西"时
  // 不用在两个相隔很远的位置之间跳。
  { key: "gallery", label: "图片库", icon: <PictureOutlined /> },
  // 数据库板块：2026-11-06 从 z-biz-tool-db 仓搬入（db 独立 app 废弃）。
  // 排在图书馆之后 —— 它和图书馆一样是「叠在主区上的独立工作台」，
  // 与文件管理的浏览树不是一回事。
  { key: "db", label: "数据库", icon: <DatabaseOutlined /> },
  // 系统板块：2026-11-06 从 z-biz-tool-sys 仓搬入（sys 独立 app 废弃）。
  // 排最后 —— 它是「整机的视角」，前面四个都是「内容/数据的视角」；
  // 用户从具体文件一路看到底层资源，顺序上是收口的位置。
  { key: "sys", label: "系统监控", icon: <DashboardOutlined /> },
  // AI 任务看板：2026-11-07 从 z-biz-tool-worker 仓搬入。
  // 排最后 —— 它是最「需要用户主动打开」的工具型板块（项目管理），
  // 不像文件/系统那样一进来就要用，放末尾不抢注意力。
  { key: "worker", label: "工作台", icon: <ProjectOutlined /> },
  // 思维导图：2026-11-08 从 z-biz-tool-mind 仓搬入。
  // 排最后 —— 和「工作台」一样是「需要用户主动打开」的工具型板块。
  // 导图产出（.emmx）本身就是本地文件，和文件管理天然一体：在这里编辑，
  // 导出/保存后直接就在文件区里看到、可用其它板块继续处理。
  { key: "mind", label: "思维导图", icon: <ShareAltOutlined /> },
  // 词库板块：2026-11-08 新建（kb 通用能力由 cap-glossary 承载）。
  // 排最后 —— 和「工作台」「思维导图」一路，是「需要用户主动打开」的沉淀型板块。
  // 词条/问答/检索文件三块都在这里沉淀和回看。
  { key: "glossary", label: "词库", icon: <BookOutlined /> },
];

/**
 * 终端板块按需加载。
 *
 * 它是从 z-biz-tool-terminal 仓整体搬进来的（1300 行根组件 + 30 多个面板 +
 * xterm + AI 一整套），静态 import 会把文件管理的首屏 bundle 直接撑大一倍，
 * 而这些代码只有用户真的点了活动栏第二个图标才需要。
 * 代价是首次切过去有一次 chunk 下载（本地文件协议，几十毫秒）。
 */
const TerminalApp = lazy(() => import("./apps/terminal/TerminalApp"));

/**
 * 图书馆板块同样按需加载：它是「叠在文件树上的一层书目视图」，
 * 首屏在文件管理时完全用不到，没必要让每个用户都下载一遍书目界面。
 */
const LibraryApp = lazy(() => import("./apps/library/LibraryApp"));

/**
 * 图片库板块按需加载。
 *
 * 它复用 components/MediaGallery（678 行，画廊/列表 + 三档缩略图尺寸），
 * 首屏在文件管理时完全用不到 —— 没必要让每个用户都下载一遍。
 */
const GalleryApp = lazy(() => import("./apps/gallery/GalleryApp"));

/**
 * 数据库板块同样按需加载。
 *
 * 2026-11-06 从 z-biz-tool-db 仓搬入（db 独立 app 废弃，能力并入本仓）。
 * 它比终端还重：SQL 编辑器（CodeMirror）、图表（recharts）、报表工作台，
 * 静态 import 会把首屏 bundle 撑大一大截 —— 而这些代码只有用户真的点了
 * 活动栏第四个图标才需要。
 */
const DbApp = lazy(() => import("./apps/db/DbApp"));

/**
 * 系统监控板块同样按需加载。
 *
 * 2026-11-06 从 z-biz-tool-sys 仓搬入（sys 独立 app 废弃，能力并入本仓）。
 * 它是八个 tab 一整套（概览/磁盘/网络/进程/清理/大文件/启动项/系统信息）
 * 外加采集曲线与告警面板 —— 首屏完全用不到，只有点了活动栏第五个图标才需要。
 *
 * 这一条不只是为了首屏体积：它的 hooks 一挂载就会 start_process_stream
 * 拉进程流，静态 import 等于让所有用户一进文件管理就开始采进程表。
 */
const SysApp = lazy(() => import("./apps/sys/SysApp"));

/**
 * AI 任务看板板块按需加载（2026-11-07 从 z-biz-tool-worker 仓搬入）。
 * 项目管理在文件管理场景下用不到，没必要让每个用户都下载一遍。
 */
const WorkerApp = lazy(() => import("./apps/worker/WorkerApp"));
// 思维导图板块按需加载（和 WorkerApp 同样的理由：2.7 万行前端 + 手写 SVG
// 画布引擎，静态 import 会撑大文件管理首屏；本地协议下切过去的 chunk 下载几十毫秒）。
const MindApp = lazy(() => import("./apps/mind/App"));
// 词库板块按需加载（和 WorkerApp 同样的理由：沉淀型板块，文件管理场景用不到）。
const GlossayApp = lazy(() => import("./apps/glossary/GlossaryApp"));

/**
 * 「点开才用」的功能组件 —— 一律走 lazyModal。
 *
 * 这些组件原来是静态 import，全部躺在首屏包里。2026-11-06 用 sourcemap
 * 逐个归因才发现：首屏 1733KB 里排第一的不是 antd 本体，而是这一批
 * 「open=false 时压根不显示」的弹窗（归档浏览器、PDF 工具、OCR、差异对比…）。
 *
 * 为什么是 lazyModal 而不是裸 lazy()：它们的写法是「无条件渲染 + 靠 open 显隐」，
 * 裸 lazy() 在首帧就会触发 import，等于白拆。lazyModal 多一层「open 为真才挂载」。
 * 详见 ./_shared/lazyModal.tsx。
 */
const BatchRename = lazyModal(() => import("./components/BatchRename"));
const FileProperties = lazyModal(() => import("./components/FileProperties"));
const DuplicateFinder = lazyModal(() => import("./components/DuplicateFinder"));
const HashCalculator = lazyModal(() => import("./components/HashCalculator"));
const DirectorySync = lazyModal(() => import("./components/DirectorySync"));
const SettingsModal = lazyModal(() => import("./components/SettingsModal"));
const TrashModal = lazyModal(() => import("./components/TrashModal"));
const SftpModal = lazyModal(() => import("./components/SftpModal"));
const StorageAnalyzerModal = lazyModal(() => import("./components/StorageAnalyzerModal"));
const QuickActionsModal = lazyModal(() => import("./components/QuickActionsModal"));
const ShortcutHelp = lazyModal(() => import("./components/ShortcutHelp"));
const NewFileTemplate = lazyModal(() => import("./components/NewFileTemplate"));
const ArchiveExplorer = lazyModal(() => import("./components/ArchiveExplorer"));
const PdfTools = lazyModal(() => import("./components/PdfTools"));
const DiffViewer = lazyModal(() => import("./components/DiffViewer"));
const OcrTool = lazyModal(() => import("./components/OcrTool"));
const Aria2Manager = lazyModal(() => import("./components/Aria2Manager"));
const LibraryView = lazyModal(() => import("./components/LibraryView"));
const Updater = lazyModal(() => import("./components/Updater"));

/**
 * 这三个不能走 lazyModal，都是「同名文件还导出了别的东西」：
 * - TagEditModal / ArchiveCreateDialog 里有 `getTagColor` / `CreateSource`
 *   这样的纯函数与类型，lazyModal 的 load 只能取 default，取不到具名导出；
 * - MediaGallery 外层本来就有 `{mediaLibraryOpen && ...}` 条件渲染，
 *   裸 lazy() 已经不会在首帧触发 import，不必再加一层。
 */
const TagEditModal = lazy(() =>
  import("./components/TagEditModal").then((m) => ({ default: m.default })),
);
const ArchiveCreateDialog = lazy(() =>
  import("./components/ArchiveCreateDialog").then((m) => ({ default: m.default })),
);
const MediaGallery = lazy(() =>
  import("./components/MediaGallery").then((m) => ({ default: m.MediaGallery })),
);

// —— AntdApp 内部组件：能够使用 App context（message / modal / notification）
function AppShellInner() {
  const { message, modal } = AntdApp.useApp();
  // 剪贴板可能被权限/非安全上下文拒绝；先 await 再报成功
  const copyToClipboard = async (text: string, okText: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(okText);
    } catch (e) {
      console.warn("[file] 写入剪贴板失败:", e);
      message.error("复制失败，请手动复制");
    }
  };
  // ⌘ + ⇧ + L 走的就是这里（注册表那条 spec）；主题本身由 _shared/ThemeProvider 持久化
  const { mode, toggle: toggleTheme } = useTheme();
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
  const [duplicateFinderOpen, setDuplicateFinderOpen] = useState(false);
  const [duplicateRoot, setDuplicateRoot] = useState<string | null>(null);
  const [hashCalcOpen, setHashCalcOpen] = useState(false);
  const [hashFiles, setHashFiles] = useState<HashTarget[]>([]);
  const [dirSyncOpen, setDirSyncOpen] = useState(false);
  const [archiveExplorerOpen, setArchiveExplorerOpen] = useState(false);
  const [archiveExplorerPath, setArchiveExplorerPath] = useState<string | null>(null);
  const [archiveCreateOpen, setArchiveCreateOpen] = useState(false);
  const [archiveCreateSources, setArchiveCreateSources] = useState<CreateSource[]>([]);
  /**
   * 双击路由表：哪些扩展名该进归档浏览器而不是交给系统默认程序。
   * 启动时取一次就够（它来自编译期常量表），但**必须**从后端取——写死在前端的话，
   * 后端加一种格式而这里忘了跟，症状是"双击新格式的压缩包没反应"，一句报错都没有。
   */
  const [archiveOpenExts, setArchiveOpenExts] = useState<string[]>([]);
  const [pdfToolsOpen, setPdfToolsOpen] = useState(false);
  const [pdfToolsPath, setPdfToolsPath] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [aria2Open, setAria2Open] = useState(false);
    const [updaterOpen, setUpdaterOpen] = useState(false);
  const [newFileTemplateOpen, setNewFileTemplateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [tagEditOpen, setTagEditOpen] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  // 媒体库视图状态
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  const [mediaLibraryType, setMediaLibraryType] = useState<"image" | "video" | "audio">("image");
  const [mediaLibraryPath, setMediaLibraryPath] = useState<string>("");
  // 预览面板的图片编辑态（右键「图片编辑」与预览顶栏那颗按钮共用这一个开关）
  const [previewEditImage, setPreviewEditImage] = useState(false);
  // 当前目录的快速过滤（subsequence 模糊匹配）
  const [quickFilter, setQuickFilter] = useState("");
  const [siderCollapsed, setSiderCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("z-tool-sider-collapsed") === "1";
  });
  /**
   * 活动栏当前激活的入口。空字符串 = 面板区收起（只剩 48px 的图标栏）。
   * 持久化到 localStorage：用户上次停在哪个面板，下次打开还在那儿。
   */
  const [railActive, setRailActive] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("z-tool-rail-active") ?? "";
  });
  /**
   * 活动栏上半截「应用」里当前所在的板块。
   *
   * 默认就是第一个应用（文件管理）—— 打开就是文件界面，不需要先点一下。
   * 持久化方式和 railActive 一致：这次停在哪个板块，下次打开还是那个。
   * 目前只注册了 files 一个，所以切换是恒等的；第二个应用接进来时，
   * 主区的分支在下面 `activeApp === "files" ? ... : ...` 那处。
   */
  const [activeApp, setActiveApp] = useState<string>(() => {
    if (typeof window === "undefined") return RAIL_APPS[0].key;
    const stored = localStorage.getItem("z-tool-active-app");
    // 白名单校验：这串是主区的渲染分支判据，读到脏值（改版本、手改存储）
    // 会落到"未知应用"的兜底分支，界面上就是一块空白
    return stored && RAIL_APPS.some((a) => a.key === stored) ? stored : RAIL_APPS[0].key;
  });
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("z-tool-active-app", activeApp);
  }, [activeApp]);

  /**
   * 图书集列表：文件管理右键的「加入图书集」子菜单要用。
   *
   * 跟着 activeApp 刷新而不是只在启动时取一次 —— 用户在图书馆里新建/删掉一个集
   * 再切回文件管理，子菜单必须跟着变，否则点了「技术书」会报"未找到图书集"。
   */
  const [libraryCollections, setLibraryCollections] = useState<
    Array<{ id: string; name: string; color: string | null }>
  >([]);
  useEffect(() => {
    invoke<Array<{ id: string; name: string; color: string | null }>>("library_list_collections")
      .then(setLibraryCollections)
      .catch((e) => console.warn("[library] 图书集列表读取失败:", e));
  }, [activeApp]);
  // 新建集的输入值：modal.confirm 的内容是自己渲染的 Input，只能靠 ref 取出来
  const newCollectionNameRef = useRef("");
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
    } catch (e) {
      console.warn("[ui] 表头列宽记录损坏，本次用默认列宽:", e);
      return {};
    }
  });

  // 启动后的静默检查已收进 UpdateCenterProvider：角标与「真正能装」的通道
  // 必须是同一份状态，否则又会出现「红点亮着、点开却是手动下载」。

  useEffect(() => {
    try {
      localStorage.setItem("z-tool-table-col-widths", JSON.stringify(columnWidths));
    } catch {
      /* 容量满或隐私模式，忽略 */
    }
  }, [columnWidths]);

  useEffect(() => {
    try {
      localStorage.setItem("z-tool-rail-active", railActive);
    } catch {
      /* 容量满或隐私模式，忽略 */
    }
  }, [railActive]);

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
  const autoWatchRef = useRef(true);

  // 订阅后端 file-change 事件（全局仅此一个订阅）
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    listen<{ path: string; kind: string }>("file-change", (evt) => {
      if (!autoWatchRef.current) return;
      const { path } = evt.payload;
      // 只刷新当前目录（或当前目录的子项）
      const dir = currentPathRef.current;
      if (!dir) return;
      if (path === dir || path.startsWith(dir + "/")) {
        // 防抖：300ms 内多次事件合并
        if (fileChangeTimerRef.current) clearTimeout(fileChangeTimerRef.current);
        fileChangeTimerRef.current = setTimeout(() => {
          // 以触发时刻的最新目录为准，避免切换目录后回刷旧路径
          const latest = currentPathRef.current;
          if (latest) loadDirectoryRef.current?.(latest);
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
      if (fileChangeTimerRef.current) clearTimeout(fileChangeTimerRef.current);
    };
  }, []);

  // 组件 unmount 时停止监听
  useEffect(() => {
    return () => {
      invoke("stop_watching").catch((e) => {
        console.warn("[watch] 停止文件监听失败（退出后由后端回收）:", e);
      });
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
    mediaViewMode, mediaGallerySize,
    setMediaViewMode, setMediaGallerySize,
    bumpIndexEpoch,
  } = useFileStore();

  // 家族深链要定位的文件路径。
  //
  // 深链落地要两步：先 navigateTo 切目录（异步加载列表），再在列表里选中那个文件。
  // 这里存住「待选中的路径」，等 fileList 里真的出现它时再落地 ——
  // 直接造一个 FileEntry 会带进编造的 size/modified，排序和预览都会失真。
  const [pendingRevealPath, setPendingRevealPath] = useState<string | null>(null);

  // 目录列表就绪后落地待选中的文件。
  useEffect(() => {
    if (!pendingRevealPath) return;
    const hit = fileList.find((e) => e.path === pendingRevealPath);
    if (!hit) return;
    setSelectedFile(hit);
    setSelectedRowKeys([hit.path]);
    setPendingRevealPath(null);
  }, [pendingRevealPath, fileList, setSelectedFile]);

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
  const [dirLoading, setDirLoading] = useState(true);
  const [dirError, setDirError] = useState<string | null>(null);
  const loadDirectory = useCallback((path: string) => {
    const cmd = showHidden ? "list_directory_with_hidden" : "list_directory";
    const args = showHidden ? { path, showHidden: true } : { path };
    setDirLoading(true);
    setDirError(null);
    invoke(cmd, args)
      .then((entries: unknown) => {
        const list = entries as FileEntry[];
        setFileList(list);
        setDirLoading(false);
        setDirError(null);
        // 列表是唯一权威：这一层现在有什么就按什么对齐索引（后台跑，不挡渲染）
        syncDirIndex(
          path,
          list.map((e) => ({ name: e.name, size: e.size, modified: e.modified })),
          showHidden
        ).then((res) => {
          // 只有真的剔掉/补上东西才敲一次索引版本号；稳态浏览不该惊动搜索面板
          if (res && (res.dropped > 0 || res.refreshed > 0)) bumpIndexEpoch();
        });
      })
      .catch((err) => {
        // 加载失败也必须收掉骨架屏，否则视图永远停在"还在转"的状态
        setDirLoading(false);
        // 旧目录的行不能留在新路径下面：那是在把上一层的文件冒充成这一层的
        setFileList([]);
        setSelectedFile(null);
        setSelectedRowKeys([]);
        setDirError(String(err));
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
  useEffect(() => {
    autoWatchRef.current = autoWatch;
  }, [autoWatch]);

  // 导航到路径
  const navigateTo = useCallback((path: string, isRoot: boolean = false) => {
    setCurrentPath(path);
    // 换目录先清掉上一层的行：慢盘上加载那一两秒里不能把旧目录冒充成新目录
    setFileList([]);
    setDirError(null);
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

  // 家族深链（zbiz://file/open?file=…）：box 等产品递过来的文件，切到它所在目录。
  //
  // 机制（冷启动补取 + zbiz-open 监听 + 不静默吞掉）在共享层 startDeepLinkReceiver，
  // 本仓只提供语义：resolveFileDeepLink 决定「定位到哪个路径、要不要真的打开」。
  //
  // navigateTo 依赖 historyIndex 会频繁变化，监听器里用 ref 取最新一份。
  const navigateToRef = useRef(navigateTo);
  useEffect(() => { navigateToRef.current = navigateTo; }, [navigateTo]);

  useEffect(() => {
    const stop = startDeepLinkReceiver({
      productId: "file",
      invoke: () => invoke<HandoffItem[]>(ZBIZ_TAKE_PENDING),
      listen: (event, handler) => listen(event, handler),
      translate: (item) => {
        const out = resolveFileDeepLink(item);
        if (!out.path) {
          return { ok: false, problem: out.problem ?? "深链里没有可定位的路径" };
        }
        return { ok: true, effect: { path: out.path, shouldOpen: out.shouldOpen } };
      },
      onProblem: (msg, item) => {
        // 终端的深链不是「发错了」，而是本仓**另一个板块**的。
        // 共享层先按 productId 过滤、不符就丢进 onProblem，所以这里是唯一能接手的地方：
        // 转投给终端板块并切过去。不这么做的话，两个接收器会各自 take_pending，
        // 先跑的把队列整个取走，后跑的永远拿到空数组（take 是消费式的）。
        //
        // 顺带说明为什么不能靠 translate 拦：共享层在调 translate 之前就 product 过滤了。
        if (item.product === "terminal") {
          putTerminalHandoff(item);
          setActiveApp("terminal");
          return;
        }
        // 系统监控板块同理（2026-11-06 从 sys 仓搬入）：它也只从那个 handoff 槽取，
        // 自己不注册接收器 —— 两个接收器抢消费式的 take_pending 就是「点了没反应」。
        if (item.product === "sys") {
          putSysHandoff(item);
          setActiveApp("sys");
          return;
        }
        // AI 任务看板板块同理（2026-11-07 从 worker 仓搬入）
        if (item.product === "worker") {
          putWorkerHandoff(item);
          setActiveApp("worker");
          return;
        }
        // 思维导图板块同理（2026-11-08 从 mind 仓搬入）：它是 lazy 板块，
        // 必须由这里切过去才挂载；早到的深链由 mind/handoff.ts 暂存。
        if (item.product === "mind") {
          putMindHandoff(item);
          setActiveApp("mind");
          return;
        }
        console.warn("[file] 深链:", msg);
        message.warning(msg);
      },
      onEffect: (effect) => {
        const path = String(effect.path ?? "");
        if (!path) return;
        // 先切到目标所在目录，让文件出现在列表里。
        navigateToRef.current(parentOfPath(path));
        // 再选中它 —— 只有 open 动作才承诺打开，reveal 只保证「看得见」。
        //
        // 选中必须等目录列表加载完（navigateTo → loadDirectory → setFileList 是异步的），
        // 所以挂一个待选路径，由下面那个 effect 在 fileList 就绪时落地。
        //
        // 不在这里订阅 store：深链指向的文件若不存在，订阅永远不会命中也永远不会解除。
        if (effect.shouldOpen) setPendingRevealPath(path);
      },
      log: (msg, item) => console.debug("[file] 深链", msg, item),
    });
    return stop;
  }, [message]);

  // 初始化：定位到当前登录用户的主目录（跨平台解析，不硬编码）
  useEffect(() => {
    let cancelled = false;
    resolveHomeDir().then((defaultPath) => {
      if (cancelled) return;
      setRootPath(defaultPath);
      navigateTo(defaultPath, true);
      // 初始化第一个 tab
      if (tabs.length === 0) openTab(defaultPath);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 归档任务的两件事都挂在 App 而不是挂在浏览器弹窗上，因为它们要活得比弹窗久：
   * - 进度订阅：解压一个 7 GB 的包是十分钟级的事，用户中途关掉浏览窗口，
   *   进度和取消按钮得留在右下角。订阅要是挂在弹窗里，一关窗就再也没人收事件了。
   * - 双击路由表：见 `archiveOpenExts` 的声明处。
   */
  useEffect(() => {
    void useArchiveJobStore.getState().startListening();
    invoke<string[]>("archive_open_extensions")
      .then(setArchiveOpenExts)
      // 取不到就退回"压缩包一律交给系统"：那是这次改动之前的行为，
      // 降级可用，比让双击整个失效（连目录都进不去）好
      .catch((e) => {
        console.warn("[archive] 读取可解压扩展名失败，压缩包改交给系统打开:", e);
        setArchiveOpenExts([]);
      });
  }, []);

  // showHidden变化时重新加载
  useEffect(() => {
    if (currentPath) loadDirectory(currentPath);
  }, [showHidden, currentPath, loadDirectory]);

  // 监听开关 / 切换目录：全局唯一一处 start_watching，关闭时显式 stop_watching
  useEffect(() => {
    if (!autoWatch) {
      invoke("stop_watching").catch((e) => {
        console.warn("[watch] 停止文件监听失败（退出后由后端回收）:", e);
      });
      return;
    }
    if (!currentPath) return;
    invoke("start_watching", { path: currentPath }).catch((err) =>
      console.warn("启动监听失败:", err)
    );
  }, [autoWatch, currentPath]);

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
    if (!currentPath) return;
    // 同一份"取父目录"逻辑与右键"加入图片库"共享。手写的取最后一段在
    // Windows 盘符根（"C:\\"）上会拼出 "C:/"，看起来像切到了另一个目录。
    const parent = parentOfPath(currentPath);
    if (!parent || parent === currentPath) return;
    navigateTo(parent);
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
      const done = await placeBatch(
        currentPath,
        clipboard.map((item) => ({
          src: item.path,
          mode: item.operation === "copy" ? ("copy" as const) : ("move" as const),
        })), modal);
      // 用户在冲突框里点了取消：一个字节都不动，剪贴板也留着，稍后还能贴到别处
      if (!done) return;
      const toast = batchToast(done, "已粘贴", currentPath);
      if (!toast) return;
      message[toast.kind](toast.text);
      if (toast.refresh) {
        clearClipboard();
        loadDirectory(currentPath);
      }
    } catch (err) {
      message.error("粘贴失败: " + err);
      loadDirectory(currentPath); // 半途失败也要重扫，否则列表还指着已经搬走的项
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
    if (!currentPath) return;
    const check = checkFileNameForCreate(createName);
    if (!check.ok) {
      // 用户敲完直接按 Enter；给一句明确的话，而不是让后端报"无效路径"那种模糊的错
      message.error(`无法创建：${check.issue.message}`);
      return;
    }
    // 实时查重：用户在弹窗里敲到一半时，名字与现有条目撞了就把按钮禁掉；
    // 这里再做一次兜底是怕 fileList 与 createName 之间有竞态（异步刷新时
    // 列表里还没有同名，但后端校验时会拿到同样的输入）。
    if (fileList.some((f) => f.name === check.name)) {
      message.error(`无法创建：当前目录已有同名「${check.name}」`);
      return;
    }
    const fullPath = currentPath + "/" + check.name;
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
  }, [createName, createModal.type, currentPath, fileList, loadDirectory, message]);

  /**
   * 弹窗里需要"实时知道 createName 是否与现有条目冲突"。
   * 抽出来供 Input 的 status 与 okButtonProps.disabled 共享，否则两处判断
   * 漂移一下就会出现"按钮没禁用但提交后报错"或者"按钮禁了但提交走另一条
   * 路径"。
   */
  const createNameValid = useMemo(() => {
    if (!createName) return false;
    const check = checkFileNameForCreate(createName);
    if (!check.ok) return false;
    return !fileList.some((f) => f.name === check.name);
  }, [createName, fileList]);

  // 批量操作选中的文件。
  // 声明位置比多数派生值靠前，是因为归档那几个 handler 在 useCallback 的**依赖数组**里
  // 直接引用它——依赖数组是当场求值的，声明在后面就是 TDZ，编译不过。
  const selectedFiles = selectedRowKeys.length > 0
    ? fileList.filter((f) => selectedRowKeys.includes(f.path))
    : selectedFile
    ? [selectedFile]
    : [];

  /**
   * 压缩：开"新建压缩"对话框。
   *
   * 一个入口两种起点：选中了东西就压它们，什么都没选就先开文件选择框。
   * 后者不是多余的——它顶掉了原来工具栏那个"解压"按钮的选文件能力，也让这个按钮
   * 不必写成 `disabled={selectedFiles.length === 0}`：一个永远灰着的按钮只是噪音。
   */
  const handleCompress = useCallback(async () => {
    let items: Pick<FileEntry, "path" | "name" | "is_dir">[] =
      selectedFiles.length > 0 ? selectedFiles : [];
    if (items.length === 0) {
      try {
        const picked = await openDialog({
          multiple: true,
          directory: false,
          title: "选择要压缩的文件",
          defaultPath: currentPath || undefined,
        });
        if (!picked) return;
        const paths = Array.isArray(picked) ? picked : [picked];
        items = paths.map((p) => ({ path: p, name: fsBaseName(p), is_dir: false }));
      } catch (err) {
        message.error("选择文件失败: " + err);
        return;
      }
    }
    setArchiveCreateSources(
      items.map((f) => ({ path: f.path, name: f.name, isDir: f.is_dir })),
    );
    setArchiveCreateOpen(true);
  }, [currentPath, message, selectedFiles]);

  /**
   * 右键菜单里的"直接解压"：不进浏览器，起一个后台任务，进度落在右下角。
   *
   * 两处刻意的选择：
   * - 目标目录名由后端 `archive_extract_dir_name` 按格式算（`movie.tar.gz` → `movie.tar`）。
   *   原来这里是前端手写的一串 endsWith if，加一种格式就要两边改，漏一边就得到一个
   *   名叫 `movie.tar` 的目录里套着 `movie/`。
   * - 覆盖策略固定 `rename`（保留两者），不弹重名确认框。菜单里那一下点的是"快点解开"，
   *   再插一个模态框就把快捷入口变成了慢入口；而 `rename` 永远不会盖掉用户已有的文件，
   *   要精细控制的话归档浏览器里有完整的重名探测。
   *
   * 要密码的包不适合在这里静默起任务（进度面板会挂一个立刻失败的条目），
   * 改成打开浏览器——那儿有密码框。
   */
  const extractArchiveNow = useCallback(
    async (entry: Pick<FileEntry, "path" | "name">, dest: string) => {
      const options: ExtractOptions = {
        entries: null,
        password: null,
        overwrite: "rename",
        keepBroken: true,
        stripRoot: false,
        flatten: false,
        includeChildren: true,
      };
      try {
        await invoke<string>("archive_extract", { path: entry.path, dest, options });
        message.success("已开始解压，进度见右下角");
        loadDirectory(currentPath);
      } catch (err) {
        const f = describeArchiveError(err);
        if (f.needPassword || f.badPassword) {
          setArchiveExplorerPath(entry.path);
          setArchiveExplorerOpen(true);
          return;
        }
        message.error(f.message);
      }
    },
    [currentPath, loadDirectory, message],
  );

  /** 解压到与压缩包同目录的 `<名字>` 文件夹里（7-Zip 的"解压到 xxx\"） */
  const handleExtractToSibling = useCallback(
    async (entry: Pick<FileEntry, "path" | "name">) => {
      let dirName: string;
      try {
        dirName = await invoke<string>("archive_extract_dir_name", { path: entry.path });
      } catch (err) {
        message.error("解压失败: " + err);
        return;
      }
      await extractArchiveNow(entry, joinFsPath(parentOfPath(entry.path), dirName));
    },
    [extractArchiveNow, message],
  );

  /** 校验完整性：起一个后台任务，坏的条目会写进任务的错误列表里 */
  const handleTestArchive = useCallback(
    async (entry: Pick<FileEntry, "path" | "name">) => {
      try {
        await invoke<string>("archive_test", { path: entry.path, password: null });
        message.success("已开始校验，进度见右下角");
      } catch (err) {
        const f = describeArchiveError(err);
        if (f.needPassword || f.badPassword) {
          setArchiveExplorerPath(entry.path);
          setArchiveExplorerOpen(true);
          return;
        }
        message.error(f.message);
      }
    },
    [message],
  );

  /** 打开归档浏览器（双击、Enter、右键"打开压缩包"都是这一条） */
  const openArchiveBrowser = useCallback((path: string) => {
    setArchiveExplorerPath(path);
    setArchiveExplorerOpen(true);
  }, []);

  // 删除文件
  const handleDelete = useCallback(
    // 只读 name/path，所以按这两个字段收：画廊里删一张图时手上只有 MediaItem，
    // 凑一个 size:0 / modified:0 的假 FileEntry 只会让以后谁多用一个字段时静默拿到 0。
    (entry: Pick<FileEntry, "name" | "path">, permanent = false, onDone?: () => void) => {
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
            // 调用方（比如画廊）要在这之后才摘掉自己那份列表：删除失败时列表不能骗人
            onDone?.();
            loadDirectory(currentPath);
          } catch (err) {
            message.error("删除失败: " + err);
          }
        },
      });
    },
    [currentPath, loadDirectory, message, modal],
  );

  // 批量删除：一次确认、逐条执行、汇总失败项。右键菜单与 Delete/⌘⌫ 共用这一条路径，
  // 避免"菜单里删 N 项、快捷键只删 1 项"这种口径分叉。
  const handleDeleteMany = useCallback(
    (entries: FileEntry[], permanent: boolean) => {
      if (entries.length === 0) return;
      if (entries.length === 1) {
        handleDelete(entries[0], permanent);
        return;
      }
      const count = entries.length;
      modal.confirm({
        title: permanent ? "永久删除" : "移到回收站？",
        content: permanent
          ? `将永久删除 ${count} 项，无法恢复。`
          : `将 ${count} 项移到回收站，可以在「设置」旁的回收站按钮中恢复。`,
        okText: permanent ? "永久删除" : "移到回收站",
        okType: "danger",
        cancelText: "取消",
        onOk: async () => {
          let ok = 0;
          const failed: string[] = [];
          for (const r of entries) {
            try {
              await invoke(permanent ? "delete_file" : "delete_to_trash", { path: r.path });
              ok++;
            } catch (err) {
              failed.push(`${r.name}: ${err}`);
            }
          }
          // 一项都没成功就别报「已处理」：那会让用户以为删掉了
          if (ok > 0) message.success(`已删除 ${ok} 项`);
          // 被拦下的那条路径往往才是用户要的答案（path_guard 会说明原因），只报第一条
          if (failed.length) message.error(`${failed.length} 项没有删除：${failed[0]}`);
          setSelectedRowKeys([]);
          setSelectionAnchor(null);
          loadDirectory(currentPath);
        },
      });
    },
    [currentPath, handleDelete, loadDirectory, message, modal],
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

  /**
   * 打开：目录进入、压缩包进归档浏览器、其余交给默认应用。
   * 双面板视图一直就是这么做的，主表格却只认目录 —— 双击文件没有任何反应，
   * 用户只能右键找"用默认应用打开"。
   */
  const handleOpen = useCallback(
    (entries: FileEntry[]) => {
      const action = resolveOpen(entries, archiveOpenExts);
      if (action.kind === "none") {
        // 多选不逐个 open：一次 Enter 弹出几十个外部应用窗口不是用户想要的
        message.warning(openRejectText(action.reason));
        return;
      }
      if (action.kind === "navigate") {
        navigateTo(action.path);
        return;
      }
      if (action.kind === "open-archive") {
        openArchiveBrowser(action.path);
        return;
      }
      invoke("open_with_default_app", { path: action.path }).catch((err) =>
        message.error("打开失败: " + err),
      );
    },
    [archiveOpenExts, message, navigateTo, openArchiveBrowser],
  );

  /** 重命名：目录也要能改名（原先的 Enter 分支写死了 !is_dir） */
  const handleRenameOne = useCallback(
    (entries: FileEntry[]) => {
      const target = resolveRenameTarget(entries);
      if (!target) {
        message.warning(entries.length ? "一次只能重命名一项" : "请先选中要重命名的项目");
        return;
      }
      setRenameModal({ visible: true, path: target.path, oldName: target.name });
      setNewName(target.name);
    },
    [message],
  );

  // 单文件右键菜单
  // 菜单里的键位提示走 hint()。它是注册表的派生值，声明在本 callback 之后，
  // 所以**不能**进下面的 deps（渲染期取值会撞 TDZ："Cannot access before initialization"）；
  // 提示内容只由注册表里的键位决定，而键位是编译期常量，不会出现"菜单显示的是旧键位"。
  /**
   * 把文件塞进某个图书集。
   *
   * 走的是 library_add_paths_to_collection，后端会在书上不存在时当场补一条记录 ——
   * 所以用户不需要先「添加扫描目录、扫一遍」才能把一本散落的 PDF 收进馆。
   */
  const addPathsToCollection = useCallback(
    async (paths: string[], collectionId: string, collectionName: string) => {
      try {
        const added = await invoke<number>("library_add_paths_to_collection", {
          paths,
          collectionId,
        });
        message.success(
          added > 0 ? `已加入「${collectionName}」（新收录 ${added} 本）` : `已加入「${collectionName}」`,
        );
      } catch (e) {
        message.error("加入图书集失败: " + String(e));
      }
    },
    [message],
  );

  /** 右键「新建图书集」：建完立刻把这批文件放进去，不然用户还要再点一次 */
  const createCollectionAndAdd = useCallback(
    (paths: string[]) => {
      newCollectionNameRef.current = "";
      modal.confirm({
        title: paths.length > 1 ? `新建图书集并加入这 ${paths.length} 个文件` : "新建图书集",
        content: (
          <Input
            placeholder="例如：技术书、待读、某某全集"
            maxLength={40}
            autoFocus
            onChange={(e) => {
              newCollectionNameRef.current = e.target.value;
            }}
            onPressEnter={() => {
              // 回车等同点确定：confirm 的按钮拿不到键盘事件，这里只是让它别没反应
            }}
          />
        ),
        okText: "创建并加入",
        cancelText: "取消",
        onOk: async () => {
          const name = newCollectionNameRef.current.trim();
          if (!name) {
            message.warning("名称不能为空");
            // 抛错让 confirm 不关闭，用户接着改
            throw new Error("名称不能为空");
          }
          try {
            const created = await invoke<{ id: string; name: string }>(
              "library_create_collection",
              { name },
            );
            await invoke("library_add_paths_to_collection", {
              paths,
              collectionId: created.id,
            });
            const list = await invoke<Array<{ id: string; name: string; color: string | null }>>(
              "library_list_collections",
            );
            setLibraryCollections(list);
            message.success(`已创建「${created.name}」并加入`);
          } catch (e) {
            message.error("创建失败: " + String(e));
            throw e;
          }
        },
      });
    },
    [message, modal],
  );

  const singleContextMenuItems = useCallback((record: FileEntry): MenuProps["items"] => {
    const lowerName = record.name.toLowerCase();
    const isDir = record.is_dir;
    // 归档判定不再手写一串 endsWith：那串只认得 8 种后缀，rar / cab / zst / 分卷全漏，
    // 而且每加一种格式就要在这里和 format.rs 两处同时改。现在直接问后端那张表。
    const isArchive = !isDir && archiveOpenExts.includes(lastExtension(record.name));
    const isPdf = lowerName.endsWith(".pdf");
    const isImage = /\.(png|jpe?g|gif|bmp|webp|tiff?|heic|svg)$/i.test(lowerName);
    const isVideo = /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(lowerName);
    const isAudio = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(lowerName);
    const isText = /\.(txt|md|markdown|json|ya?ml|toml|xml|html?|css|scss|less|sass|js|jsx|ts|tsx|vue|svelte|py|rs|go|java|kt|swift|c|h|cc|cpp|hpp|sh|bash|zsh|sql|log|conf|ini|csv|tsv)$/i.test(lowerName);

    const items: MenuProps["items"] = [
      {
        key: "open",
        // 目录交给系统 open 会在 Finder 里再开一个窗口 —— 在文件管理器里"打开"应该是走过去
        label: isDir ? "打开" : "用默认应用打开",
        icon: <RocketOutlined />,
        onClick: () => handleOpen([record]),
      },
      ...(!isDir ? [{
        key: "quicklook", label: "Quick Look 预览", icon: <EyeOutlined />, onClick: () => {
          invoke("quick_look_preview", { path: record.path }).catch((err) => message.error("Quick Look 失败: " + err));
        },
      }] : []),
      { type: "divider" as const },
      ...(isPdf ? [{
        key: "pdf-tools", label: "PDF 工具集", icon: <FilePdfOutlined />, onClick: () => { setPdfToolsPath(record.path); setPdfToolsOpen(true); },
      }] : []),
      ...(isImage ? [{
        key: "ocr", label: "OCR 文字识别", icon: <ScanOutlined />, onClick: () => { setSelectedFile(record); setOcrOpen(true); },
      }, {
        key: "image-editor", label: "图片编辑", icon: <EditOutlined />, onClick: () => {
          // 之前这里只弹一句"请使用工具栏 [OCR] 进入图片编辑"：OCR 面板里没有图片编辑，
          // 而默认的表格视图 + 右侧预览也没有任何进编辑的按钮（只有分栏视图的 tab 栏有）
          setSelectedFile(record);
          setSelectedRowKeys([record.path]);
          setPreviewVisible(true);
          setPreviewEditImage(true);
        },
      }] : []),
      ...(isImage || isVideo ? [{
        key: "media-library", label: isVideo ? "加入视频库" : "加入图片库", icon: <PictureOutlined />, onClick: () => {
          // 媒体库吃的是目录：原来直接把 record.path 交出去，画廊就去 list_directory 一个文件，
          // 开出来是一座空馆，用户只会看到"该目录下没有图片文件"。工具栏那三条传的就是 currentPath
          setMediaLibraryType(isVideo ? "video" : "image");
          setMediaLibraryPath(parentOfPath(record.path));
          setMediaLibraryOpen(true);
        },
      }] : []),
      ...(isAudio ? [{
        key: "audio-library", label: "加入音乐库", icon: <AudioOutlined />, onClick: () => {
          setMediaLibraryType("audio");
          setMediaLibraryPath(parentOfPath(record.path));
          setMediaLibraryOpen(true);
        },
      }] : []),
      // 加入图书集：不按扩展名限制 —— 图书馆是书目视图，用户可能想把一份 .md 讲义、
      // 一个 .cbz 漫画也归到某条线里。能不能在应用内读是另一回事（右侧面板会兜底提示）
      {
        key: "book-collection",
        label: "加入图书集",
        icon: <BookOutlined />,
        children: [
          ...libraryCollections.map((c) => ({
            key: `coll:${c.id}`,
            label: c.name,
            onClick: () => void addPathsToCollection([record.path], c.id, c.name),
          })),
          ...(libraryCollections.length > 0 ? [{ type: "divider" as const }] : []),
          {
            key: "coll:new",
            label: "新建图书集…",
            onClick: () => createCollectionAndAdd([record.path]),
          },
        ],
      },
      ...(isText && !isDir ? [{
        key: "diff", label: "与另一个文件对比", icon: <SwapOutlined />, onClick: () => { setDiffOpen(true); setSelectedFile(record); },
      }] : []),
      ...(isArchive ? [{
        // 收进一个子菜单：原来这里平铺"浏览压缩包 + 解压缩"两条，加上"压缩为 ZIP"是三条，
        // 而四条归档动作里真正高频的只有"打开"。低频的进子菜单，高频的留在双击/Enter 上。
        key: "archive", label: "归档", icon: <FileZipOutlined />,
        children: [
          { key: "archive-open", label: "打开压缩包", icon: <FolderOpenOutlined />, onClick: () => openArchiveBrowser(record.path) },
          { key: "archive-extract-sibling", label: "解压到同名文件夹", icon: <ExpandOutlined />, onClick: () => { void handleExtractToSibling(record); } },
          { key: "archive-extract-here", label: "解压到当前文件夹", icon: <ExpandOutlined />, onClick: () => { void extractArchiveNow(record, currentPath); } },
          { key: "archive-test", label: "校验完整性", icon: <SafetyCertificateOutlined />, onClick: () => { void handleTestArchive(record); } },
        ],
      }] : [{
        key: "compress", label: `压缩为…${hint("压缩选中项")}`, icon: <FileZipOutlined />, onClick: () => {
          setSelectedFile(record);
          setArchiveCreateSources([{ path: record.path, name: record.name, isDir: record.is_dir }]);
          setArchiveCreateOpen(true);
        },
      }]),
      ...(!isDir ? [{
        key: "hash", label: "计算哈希", icon: <SafetyCertificateOutlined />, onClick: () => { setSelectedFile(record); setHashFiles([]); setHashCalcOpen(true); },
      }] : []),
      ...(isDir ? [{
        key: "duplicate-scan", label: "查找重复文件", icon: <CopyOutlined />, onClick: () => { setSelectedFile(record); setDuplicateRoot(record.path); setDuplicateFinderOpen(true); },
      }, {
        key: "storage-analyze", label: "存储分析", icon: <PieChartOutlined />, onClick: () => { setSelectedFile(record); setStorageOpen(true); },
      }] : []),
      { type: "divider" as const },
      { key: "copy", label: `复制${hint("复制选中")}`, icon: <CopyOutlined />, onClick: () => handleCopy([record]) },
      { key: "cut", label: `剪切${hint("剪切选中")}`, icon: <ScissorOutlined />, onClick: () => handleCut([record]) },
      { key: "rename", label: `重命名${hint("重命名选中项")}`, icon: <EditOutlined />, onClick: () => handleRenameOne([record]) },
      { key: "copy-path", label: "复制完整路径", icon: <CopyFilled />, onClick: () => {
        void copyToClipboard(record.path, "已复制路径");
      }},
      { key: "delete", label: "移到回收站", icon: <DeleteOutlined />, onClick: () => handleDelete(record, false) },
      { key: "delete_permanent", label: "永久删除", danger: true, onClick: () => handleDelete(record, true) },
      { type: "divider" as const },
      { key: "tags", label: tagsByPath[record.path] ? "编辑标签/备注" : "加标签/备注", icon: <TagOutlined />, onClick: () => {
        setSelectedFile(record);
        setTagEditOpen(true);
      }},
      { key: "properties", label: "属性", icon: <InfoCircleOutlined />, onClick: () => {
        setSelectedFile(record);
        setPropertiesOpen(true);
      }},
      { type: "divider" as const },
      { key: "reveal", label: "在 Finder 中显示", icon: <FolderOpenOutlined />, onClick: () => {
        invoke("reveal_in_finder", { path: record.path }).catch((err) => message.error("打开 Finder 失败: " + err));
      }},
      ...(isDir ? [{
        key: "terminal", label: "在终端中打开", icon: <CodeOutlined />, onClick: () => { invoke("open_terminal_at", { path: record.path }).catch((err) => message.error("打开终端失败: " + err)); },
      }, {
        key: "new-tab", label: "在新标签页打开", icon: <FileAddOutlined />, onClick: () => { openTab(record.path); },
      }] : []),
      { key: "sftp-upload", label: "SFTP 上传到远程…", icon: <CloudServerOutlined />, onClick: () => {
        setSelectedFile(record);
        setSftpOpen(true);
      }},
    ];

    return items;
  }, [
    handleCopy, handleCut, handleDelete, setSelectedFile, message, tagsByPath, openTab,
    handleOpen, handleRenameOne,
    // 归档子菜单：判定表 + 四个动作 + "解压到当前文件夹"要用的落点
    archiveOpenExts, openArchiveBrowser, handleExtractToSibling, extractArchiveNow,
    handleTestArchive, currentPath,
    // 加入图书集：子菜单直接列当前所有集，所以集列表变了要重建
    libraryCollections, addPathsToCollection, createCollectionAndAdd,
  ]);

  // 多选右键菜单（基于 selectedRowKeys）
  const multiContextMenuItems = useCallback((records: FileEntry[]): MenuProps["items"] => {
    const count = records.length;
    const allDirs = records.every((r) => r.is_dir);
    const allFiles = records.every((r) => !r.is_dir);
    const allPdf = records.every((r) => r.name.toLowerCase().endsWith(".pdf"));
    const allImages = records.every((r) => /\.(png|jpe?g|gif|bmp|webp|tiff?|heic|svg)$/i.test(r.name));
    const totalSize = records.reduce((s, r) => s + (r.size || 0), 0);
    const sizeStr = totalSize < 1024 ? `${totalSize} B`
      : totalSize < 1024 * 1024 ? `${(totalSize / 1024).toFixed(1)} KB`
      : totalSize < 1024 * 1024 * 1024 ? `${(totalSize / 1024 / 1024).toFixed(1)} MB`
      : `${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`;

    const items: MenuProps["items"] = [
      {
        key: "header",
        type: "group" as const,
        label: (
          <span style={{ fontWeight: 600, color: "#1677ff" }}>
            已选中 {count} 项 · {sizeStr}
          </span>
        ),
        children: [],
      },
      { type: "divider" as const },

      // 批量压缩
      {
        key: "batch-compress",
        label: `压缩为…（${count} 项）${hint("压缩选中项")}`,
        icon: <FileZipOutlined />,
        onClick: () => {
          setArchiveCreateSources(
            records.map((r) => ({ path: r.path, name: r.name, isDir: r.is_dir })),
          );
          setArchiveCreateOpen(true);
        },
      },
      // 批量加入图书集：一次选十本书归到同一条线里，是整理书库最常用的动作
      {
        key: "batch-book-collection",
        label: `加入图书集（${count} 项）`,
        icon: <BookOutlined />,
        children: [
          ...libraryCollections.map((c) => ({
            key: `coll:${c.id}`,
            label: c.name,
            onClick: () =>
              void addPathsToCollection(
                records.map((r) => r.path),
                c.id,
                c.name,
              ),
          })),
          ...(libraryCollections.length > 0 ? [{ type: "divider" as const }] : []),
          {
            key: "coll:new",
            label: "新建图书集…",
            onClick: () => createCollectionAndAdd(records.map((r) => r.path)),
          },
        ],
      },
      ...(allPdf ? [{
        key: "batch-pdf-merge",
        label: `合并为 PDF（${count} 项）`,
        icon: <FilePdfOutlined />,
        onClick: () => {
          setPdfToolsPath(records[0].path);
          setPdfToolsOpen(true);
        },
      }] : []),
      ...(allImages ? [{
        key: "batch-ocr",
        label: `批量 OCR 识别（${count} 张图）`,
        icon: <ScanOutlined />,
        onClick: () => {
          if (records.length === 1) {
            setSelectedFile(records[0]);
            setOcrOpen(true);
            return;
          }
          (async () => {
            for (const r of records) {
              try {
                const result: any = await invoke("ocr_image", { path: r.path, language: "chi_sim+eng" });
                message.success(`${r.name}: ${(result.text || "").slice(0, 50)}...`);
              } catch (e) {
                message.error(`${r.name} 失败: ${e}`);
              }
            }
          })();
        },
      }] : []),
      { type: "divider" as const },

      // 批量重命名 + 标签
      {
        key: "batch-rename",
        label: `批量重命名（${count} 项）`,
        icon: <EditOutlined />,
        onClick: () => {
          setSelectedFile(records[0]);
          setBatchRenameOpen(true);
        },
      },
      {
        key: "batch-tag",
        label: `批量加标签`,
        icon: <TagOutlined />,
        onClick: () => {
          setSelectedFile(records[0]);
          setTagEditOpen(true);
          message.info("批量打标签:将为所有选中项添加相同标签");
        },
      },
      { type: "divider" as const },

      // 复制 / 剪切
      { key: "batch-copy", label: `复制 (${count} 项)`, icon: <CopyOutlined />, onClick: () => handleCopy(records) },
      { key: "batch-cut", label: `剪切 (${count} 项)`, icon: <ScissorOutlined />, onClick: () => handleCut(records) },
      {
        key: "batch-copy-paths",
        label: `复制 ${count} 个路径`,
        icon: <CopyFilled />,
        onClick: () => {
          void copyToClipboard(records.map((r) => r.path).join("\n"), `已复制 ${count} 个路径`);
        },
      },
      {
        key: "batch-copy-names",
        label: `复制 ${count} 个文件名`,
        icon: <CopyFilled />,
        onClick: () => {
          void copyToClipboard(records.map((r) => r.name).join("\n"), `已复制 ${count} 个文件名`);
        },
      },
      { type: "divider" as const },

      // 批量哈希
      ...(allFiles ? [{
        key: "batch-hash",
        label: `批量计算哈希（${count} 项）`,
        icon: <SafetyCertificateOutlined />,
        onClick: () => {
          setHashFiles(records.map((r) => ({ path: r.path, name: r.name })));
          setHashCalcOpen(true);
        },
      }] : []),

      // 批量合并目录
      ...(allDirs ? [{
        key: "batch-merge-dirs",
        label: `合并到第一个目录`,
        icon: <FolderAddOutlined />,
        onClick: () => {
          (async () => {
            const target = records[0].path;
            const done = await placeBatch(
              target,
              records.slice(1).map((r) => ({ src: r.path, mode: "move" as const })), modal);
            if (!done) return;
            const toast = batchToast(done, "已合并入", records[0].name);
            if (toast) message[toast.kind](toast.text);
            loadDirectory(currentPath);
          })().catch((e) => {
            message.error("合并失败: " + e);
            loadDirectory(currentPath);
          });
        },
      }] : []),
      { type: "divider" as const },

      // 批量删除
      {
        key: "batch-delete",
        label: `移到回收站 (${count} 项)`,
        icon: <DeleteOutlined />,
        onClick: () => handleDeleteMany(records, false),
      },
      {
        key: "batch-delete-permanent",
        label: `永久删除 (${count} 项)`,
        danger: true,
        onClick: () => handleDeleteMany(records, true),
      },
      { type: "divider" as const },

      // 批量上传
      {
        key: "batch-sftp",
        label: `SFTP 批量上传 (${count} 项)`,
        icon: <CloudServerOutlined />,
        onClick: () => {
          setSelectedFile(records[0]);
          setSftpOpen(true);
        },
      },
      { type: "divider" as const },

      // 取消选择
      {
        key: "deselect",
        label: "取消选择",
        icon: <ClearOutlined />,
        onClick: () => {
          setSelectedRowKeys([]);
          setSelectedFile(null);
        },
      },
    ];

    return items;
  }, [handleCopy, handleCut, handleDeleteMany, message, modal, loadDirectory, currentPath, setSelectedFile, setBatchRenameOpen, setTagEditOpen, setHashCalcOpen, setHashFiles, setSftpOpen, setArchiveCreateSources, setArchiveCreateOpen, setPdfToolsPath, setPdfToolsOpen, setOcrOpen, libraryCollections, addPathsToCollection, createCollectionAndAdd]);

  // 兼容旧接口的 contextMenuItems:根据是否多选派发
  const contextMenuItems = useCallback((record: FileEntry): MenuProps["items"] => {
    if (selectedRowKeys.length > 1 && selectedRowKeys.includes(record.path)) {
      const selected = fileList.filter((f) => selectedRowKeys.includes(f.path));
      return multiContextMenuItems(selected);
    }
    return singleContextMenuItems(record);
  }, [selectedRowKeys, fileList, singleContextMenuItems, multiContextMenuItems]);

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
            // 单击选中、双击打开 —— 跟 macOS Finder 一致（文件也终于能双击打开了）
            // cell 上不放 onClick，避免和行级 onClick（handleRowClick）重复触发
            onDoubleClick={() => handleOpen([record])}
            style={{
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
            title={`${visual.label}${tag?.label ? ` · 🏷 ${tag.label}` : ""}${tag?.note ? ` · 📝 ${tag.note}` : ""} · 拖拽以移动到其他目录；双击打开`}
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
                // 用 token 而不是写死的 #1677ff：暗色主题下那个蓝会亮得发飘
                color:
                  selectedFile?.path === record.path
                    ? "var(--ant-color-primary)"
                    : "inherit",
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
                  background: tagColor || "var(--ant-color-primary)",
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
  ], [selectedFile, handleRowDragStart, handleRowDragEnd, navigateTo, handleOpen, columnWidths]);

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
    // 先把"这一下点完之后哪些还是选中的"算出来，再一次性落状态。
    // 原来是无条件 setSelectedFile(record) + 函数式更新 keys，于是
    // **⌘+点击取消选中**之后，右侧预览区还显示着那个"刚被取消"的文件 ——
    // 它在列表里已经不是选中态了，预览却赖着不走。
    // 用 React.Key[] 而不是 string[]：selectedRowKeys 本身就是 Key[]（antd Table 的类型），
    // 在这里收窄成 string[] 会在 toggle 分支上类型不兼容。
    let nextKeys: React.Key[];

    if (e.shiftKey && selectionAnchor) {
      // 区间选择：anchor → current 之间的所有行
      const startIdx = filteredFileList.findIndex((f) => f.path === selectionAnchor);
      const endIdx = filteredFileList.findIndex((f) => f.path === record.path);
      if (startIdx >= 0 && endIdx >= 0) {
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        nextKeys = filteredFileList.slice(from, to + 1).map((f) => f.path);
      } else {
        // anchor 不在当前列表里（切过目录 / 搜索过滤掉了），退化到单选
        nextKeys = [record.path];
      }
    } else if (e.metaKey || e.ctrlKey) {
      // toggle
      nextKeys = selectedRowKeys.includes(record.path)
        ? selectedRowKeys.filter((k) => k !== record.path)
        : [...selectedRowKeys, record.path];
      // 注：record.path 是 string，Key 是 string | number，includes 对 string 是安全的
    } else {
      // 单选
      nextKeys = [record.path];
    }

    setSelectedRowKeys(nextKeys);

    // 预览跟着"还有效的选中项"走：
    // - 这一行还选着 → 就预览它；
    // - 这一行刚被 ⌘+点击取消 → 退到剩余选中项里的第一项，一个都不剩才清空。
    if (nextKeys.includes(record.path)) {
      setSelectedFile(record);
    } else {
      const fallback = filteredFileList.find((f) => nextKeys.includes(f.path)) ?? null;
      setSelectedFile(fallback);
    }
    setSelectionAnchor(record.path);
  }, [filteredFileList, selectionAnchor, selectedRowKeys]);

  /**
   * 右键即选中（macOS 的习惯）。
   *
   * 外层那个 Dropdown 的 menu.items 读的是 selectedFile（`selectedFile ? contextMenuItems(selectedFile) : []`），
   * 而行上原来只挂了 onClick/onDoubleClick —— 于是要点过一行的右键，弹出来是个零项的空壳，
   * 看起来就像"这个应用的右键菜单是坏的"。
   */
  const selectForContextMenu = useCallback(
    (record: FileEntry) => {
      if (selectedFile?.path === record.path && selectedRowKeys.includes(record.path)) return;
      setSelectedFile(record);
      setSelectedRowKeys([record.path]);
      setSelectionAnchor(record.path);
    },
    [selectedFile, selectedRowKeys, setSelectedFile, setSelectionAnchor],
  );

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

  // 文件对比的两个入参：多选时按列表顺序取前两个；只选一个就当左边，右边留给用户挑。
  // 之前工具栏那条入口开面板永远是从空开始，等于让用户把路径再敲一遍。
  // 换选中项就退出图片编辑：不退回的话，下一个文件一点开预览就莫名进编辑态
  useEffect(() => {
    setPreviewEditImage(false);
  }, [selectedFile?.path]);

  const diffSeeds = {
    left: selectedFiles[0]?.path ?? null,
    right: selectedFiles[1]?.path ?? null,
  };

  // 当前激活的 tab 信息（用于判断是否显示图书馆/媒体库视图）
  const activeTabKind = useMemo(() => {
    if (!activeTabId) return "directory";
    const tab = tabs.find((t) => t.id === activeTabId);
    return tab?.kind ?? "directory";
  }, [activeTabId, tabs]);

  /**
   * Esc 的关层顺序（越靠前越"在上面"）与当前开着的层。
   * 前 12 项沿用原来的相对顺序，后面是原先漏掉的那些面板。
   */
  const openLayers: LayerState = {
    rename: renameModal.visible,
    create: createModal.visible,
    batchRename: batchRenameOpen,
    properties: propertiesOpen,
    dualPanel: dualPanelOpen,
    duplicateFinder: duplicateFinderOpen,
    hashCalc: hashCalcOpen,
    dirSync: dirSyncOpen,
    archiveExplorer: archiveExplorerOpen,
    newFileTemplate: newFileTemplateOpen,
    shortcutHelp: shortcutHelpOpen,
    mediaLibrary: mediaLibraryOpen,
    quickActions: quickActionsOpen,
    tagEdit: tagEditOpen,
    archiveCreate: archiveCreateOpen,
    pdfTools: pdfToolsOpen,
    diff: diffOpen,
    ocr: ocrOpen,
    aria2: aria2Open,
    updater: updaterOpen,
    settings: settingsOpen,
    trash: trashOpen,
    sftp: sftpOpen,
    storage: storageOpen,
    // 预览区是常驻侧栏，和 terminal 同一类「最下面那层」：
// 上面还开着任何弹窗时，Esc 不该顺手把它收掉
    preview: previewVisible,
  };
  const ESC_LAYERS = Object.keys(openLayers);

  // 选中集：行渲染每行都要判"选中了吗"，O(行数 × 选中数) 的 includes 换成一次查表
  const selectedSet = useMemo(() => toKeySet(selectedRowKeys), [selectedRowKeys]);

  /**
   * 选中集里的压缩包。工具栏那一个按钮靠它在「压缩」和「解压」之间换脸：
   * 与其摆两个按钮（其中总有一个在当下是灰的），不如让这个按钮说出此刻唯一有意义的那件事。
   * ⌘⇧E 用的是同一份，省得两处各写一遍过滤条件——写两遍的下场是它们慢慢长得不一样。
   */
  const selectedArchives = useMemo(
    () =>
      selectedFiles.filter(
        (f) => !f.is_dir && archiveOpenExts.includes(lastExtension(f.name)),
      ),
    [archiveOpenExts, selectedFiles],
  );

  // 方向键在"过滤后的列表"里移动焦点，与鼠标点选走同一套 state（预览/右键菜单跟着走）
  const moveSelection = useCallback(
    (delta: number) => {
      if (filteredFileList.length === 0) return;
      const current = filteredFileList.findIndex((f) => f.path === selectedFile?.path);
      const raw = current < 0 ? (delta > 0 ? 0 : filteredFileList.length - 1) : current + delta;
      const next = Math.min(Math.max(raw, 0), filteredFileList.length - 1);
      const record = filteredFileList[next];
      if (!record) return;
      setSelectedFile(record);
      setSelectedRowKeys([record.path]);
      setSelectionAnchor(record.path);
    },
    [filteredFileList, selectedFile?.path, setSelectedFile, setSelectedRowKeys, setSelectionAnchor],
  );

  const focusQuickFilter = useCallback(() => {
    const el = document.getElementById("z-tool-quick-filter") as HTMLInputElement | null;
    el?.focus();
    el?.select();
  }, []);

  // 网格视图的回调必须稳定，否则每帧新建箭头函数会把行组件的 memo 全部作废
  const handleGridClick = useCallback(
    (entry: FileEntry) => {
      setSelectedFile(entry);
      if (!entry.is_dir) setSelectedRowKeys([entry.path]);
    },
    [setSelectedFile, setSelectedRowKeys],
  );
  const handleGridDoubleClick = useCallback((entry: FileEntry) => handleOpen([entry]), [handleOpen]);
  const handleGridContextMenu = useCallback(
    (entry: FileEntry) => {
      if (selectedFile?.path !== entry.path) setSelectedFile(entry);
    },
    [selectedFile?.path, setSelectedFile],
  );

  // 键盘快捷键。这同一份数组既喂给 hook 也喂给快捷键面板（ShortcutHelp）：
  // 面板要是另抄一张"功能 → 键位"表，改了键位它就开始教用户按一个不存在的组合键。
  const shortcutSpecs = useMemo(() => ([
    { key: "b", meta: true, handler: () => setSiderCollapsed((v) => !v), description: "折叠/展开侧栏", group: "视图" },
    { key: "f", meta: true, handler: focusQuickFilter, description: "过滤当前目录", group: "导航" },
    { key: "/", handler: focusQuickFilter, description: "过滤当前目录", group: "导航" },
    { key: "ArrowDown", handler: () => moveSelection(1), description: "选中下一项", group: "导航" },
    { key: "ArrowUp", handler: () => moveSelection(-1), description: "选中上一项", group: "导航" },
    // 无修饰的 ← → **只在网格视图**注册。
    //
    // 原来这两条是无条件注册的，等于把方向键从浏览器手里抢走了（hook 默认
    // preventDefault）。后果按视图分：
    // - 表格/列表：本来 ← → 可以横向滚动长文件名，被抢走后变成"上下移动选中项"，
    //   在一个纵向列表里横向键做纵向移动，反直觉且丢掉了滚动；
    // - 分栏视图：那里的列本身横着排，← → 应该是"进出目录"，
    //   现在却变成换选中项 —— 和用户按 ← 想退回上一列的预期完全相反。
    // 网格视图是二维的，← → 换选中项才成立，所以只在那里绑。
    ...(viewMode === "grid" ? [
      { key: "ArrowRight", handler: () => moveSelection(1), description: "网格视图向右选中", group: "导航" },
      { key: "ArrowLeft", handler: () => moveSelection(-1), description: "网格视图向左选中", group: "导航" },
    ] : []),
    // 主题按钮的 tooltip 一直写着 "⌘ + ⇧ + L 切换主题"，但全站没有任何一处注册过它：
    // 按下去不会发生事。这里把承诺补上，tooltip 的键位继续由注册表推导（单一来源）。
    { key: "l", meta: true, shift: true, handler: toggleTheme, description: "切换主题", group: "视图" },
    { key: "\\", meta: true, handler: () => setPreviewVisible((v) => !v), description: "显示/隐藏预览区", group: "视图" },
    { key: "ArrowLeft", alt: true, handler: goBack, description: "后退", group: "导航" },
    { key: "ArrowRight", alt: true, handler: goForward, description: "前进", group: "导航" },
    { key: "ArrowUp", alt: true, handler: goUp, description: "返回上级", group: "导航" },
    { key: "r", meta: true, handler: () => currentPath && loadDirectory(currentPath), description: "刷新当前目录", group: "导航" },
    { key: "t", meta: true, handler: () => { openTab(currentPath || homeDirSync()); }, description: "新建标签页", group: "标签页" },
    { key: "w", meta: true, handler: () => { activeTabId && closeTab(activeTabId); }, description: "关闭当前标签页", group: "标签页" },
    { key: "h", meta: true, shift: true, handler: () => setShowHidden(!showHidden), description: "显示/隐藏隐藏文件", group: "视图" },
    { key: "1", meta: true, handler: () => setViewMode("table"), description: "表格视图", group: "视图" },
    { key: "2", meta: true, handler: () => setViewMode("list"), description: "列表视图", group: "视图" },
    { key: "3", meta: true, handler: () => setViewMode("grid"), description: "网格视图", group: "视图" },
    { key: "4", meta: true, handler: () => setViewMode("column"), description: "分栏视图", group: "视图" },
    { key: "n", meta: true, shift: true, handler: () => { setCreateModal({ visible: true, type: "file" }); setCreateName(""); }, description: "新建文件", group: "文件" },
    { key: "n", meta: true, alt: true, handler: () => { setCreateModal({ visible: true, type: "dir" }); setCreateName(""); }, description: "新建文件夹", group: "文件" },
    { key: "c", meta: true, handler: () => selectedFiles.length > 0 && handleCopy(selectedFiles), description: "复制选中", group: "编辑" },
    { key: "x", meta: true, handler: () => selectedFiles.length > 0 && handleCut(selectedFiles), description: "剪切选中", group: "编辑" },
    { key: "v", meta: true, handler: handlePaste, description: "粘贴", group: "编辑" },
    { key: "a", meta: true, handler: () => setSelectedRowKeys(filteredFileList.map((f) => f.path)), description: "全选当前目录", group: "编辑" },
    // 删除走"选中项"而不是"当前行"：选中 50 项按 ⌘⌫ 只干掉 1 项是意外的差别
    { key: "Backspace", meta: true, handler: () => handleDeleteMany(selectedFiles, false), description: "移到回收站", group: "删除" },
    { key: "Delete", handler: () => handleDeleteMany(selectedFiles, false), description: "移到回收站", group: "删除" },
    { key: "Backspace", meta: true, shift: true, handler: () => handleDeleteMany(selectedFiles, true), description: "永久删除选中", group: "删除" },
    { key: "Delete", shift: true, handler: () => handleDeleteMany(selectedFiles, true), description: "永久删除选中", group: "删除" },
    // Enter 一直是"改文件名"，但只对单个文件生效：选中目录按 Enter 什么都没有发生，
    // 想改文件夹名也只能右键。现在 Enter 与双击同义，重命名让给 F2（两平台通用）。
    { key: "Enter", handler: () => handleOpen(selectedFiles), allowInInput: false, description: "打开选中项（目录进入 / 压缩包浏览 / 文件用默认应用）", group: "导航" },
    { key: "F2", handler: () => handleRenameOne(selectedFiles), allowInInput: false, description: "重命名选中项", group: "文件" },
    // 归档那组。⌘⇧A / ⌘⇧E 对齐全站"主修饰键 + Shift = 对选中项动手"的既有口径
    // （⌘⇧N 新建文件、⌘⇧H 隐藏文件、⌘⇧⌫ 永久删除），也和 7-Zip 的 A / X 习惯对得上。
    { key: "a", meta: true, shift: true, handler: () => { void handleCompress(); }, description: "压缩选中项", group: "归档" },
    { key: "e", meta: true, shift: true, handler: () => {
      // 多选就逐个起任务：解压本来就是后台任务，N 个包就是 N 条进度，
      // 这正是右下角那块任务面板存在的理由，不必为了"一次只解一个"再插一层确认
      if (selectedArchives.length === 0) {
        message.warning(selectedFiles.length === 0 ? "请先选中要解压的压缩包" : "选中的项目里没有压缩包");
        return;
      }
      for (const f of selectedArchives) void handleExtractToSibling(f);
    }, description: "解压选中项", group: "归档" },
    { key: "Escape", handler: () => {
      // 一次只关最上面那一层；顺序与"当前开着谁"分开成数据，
      // 新加面板时漏掉这里会被 tests/escapeClosesTopLayer.test.ts 判红
      const top = topmostLayer(ESC_LAYERS, openLayers);
      if (!top) {
        // 没有弹窗可关时，Esc 退回"什么都没选"（多选最容易误留的状态）
        setSelectedRowKeys([]);
        setSelectionAnchor(null);
        // 预览也要跟着退：只清 keys 不清 selectedFile 的话，列表里一个选中项
        // 都没有了，右侧还挂着一个文件，和 ⌘+点击取消选中是同一个毛病。
        setSelectedFile(null);
        return;
      }
      const close: Record<string, () => void> = {
        rename: () => { setRenameModal({ visible: false, path: "", oldName: "" }); setNewName(""); },
        create: () => { setCreateModal({ visible: false, type: "file" }); setCreateName(""); },
        batchRename: () => setBatchRenameOpen(false),
        properties: () => setPropertiesOpen(false),
        dualPanel: () => setDualPanelOpen(false),
        duplicateFinder: () => setDuplicateFinderOpen(false),
        hashCalc: () => setHashCalcOpen(false),
        dirSync: () => setDirSyncOpen(false),
        archiveExplorer: () => { setArchiveExplorerOpen(false); setArchiveExplorerPath(null); },
        newFileTemplate: () => setNewFileTemplateOpen(false),
        shortcutHelp: () => setShortcutHelpOpen(false),
        mediaLibrary: () => setMediaLibraryOpen(false),
        quickActions: () => setQuickActionsOpen(false),
        tagEdit: () => setTagEditOpen(false),
        archiveCreate: () => { setArchiveCreateOpen(false); setArchiveCreateSources([]); },
        pdfTools: () => { setPdfToolsOpen(false); setPdfToolsPath(null); },
        diff: () => setDiffOpen(false),
        ocr: () => setOcrOpen(false),
        aria2: () => setAria2Open(false),
        updater: () => setUpdaterOpen(false),
        settings: () => setSettingsOpen(false),
        trash: () => setTrashOpen(false),
        sftp: () => setSftpOpen(false),
        storage: () => setStorageOpen(false),
        preview: () => setPreviewVisible(false),
      };
      close[top]?.();
    }, description: "关闭最上层弹窗", group: "通用" },
    // 26 条注册项都写了 description，却没有任何界面显示过它们；F1 是这个面板的入口，
    // 顶部工具栏的「?」按钮走的是同一个 state。
    // Space = Quick Look。macOS 上这是「看一眼」的本能动作 —— 右键菜单里
    // 一直有 Quick Look，但全站没有快捷键，用户按 Space 只会滚动列表。
    //
    // preventDefault 显式关掉：没有选中项、或选中的是目录时，Space 应该照常
    // 滚动（否则在空目录里按空格，页面僵住不动，比不响应还糟）。
    { key: " ", preventDefault: false, handler: (e: KeyboardEvent) => {
      const f = selectedFile;
      if (!f || f.is_dir) return;
      e.preventDefault();
      invoke("quick_look_preview", { path: f.path }).catch((err) =>
        message.error("Quick Look 失败: " + err),
      );
    }, description: "Quick Look 快速预览", group: "导航" },
    { key: "F1", handler: () => setShortcutHelpOpen((v) => !v), description: "查看快捷键面板", group: "通用" },
  ]), [
    goBack, goForward, goUp, currentPath, loadDirectory, showHidden, setShowHidden,
    setViewMode, selectedFiles, handleCopy, handleCut, handlePaste, selectedFile, handleDelete,
    // openTab/closeTab/activeTabId 缺一个，⌘T 就会一直开旧路径、⌘W 一直关最初那个标签
    openTab, closeTab, activeTabId,
    // 新增的 ⌘A / Delete 系：漏了会让闭包拿到首帧的列表和选择集
    filteredFileList, setSelectedRowKeys, handleDeleteMany,
    handleOpen, handleRenameOne,
    toggleTheme,
    renameModal.visible, createModal.visible, batchRenameOpen, propertiesOpen,
    dualPanelOpen, duplicateFinderOpen, hashCalcOpen, dirSyncOpen, archiveExplorerOpen,
    // 归档那组快捷键的依赖：漏了 selectedArchives，⌘⇧E 会拿首帧的空列表，
    // 于是永远弹"请先选中要解压的压缩包"
    handleCompress, handleExtractToSibling, selectedArchives, message,
    // ← → 现在按视图条件注册，漏了 viewMode 就会永远停在首帧那个视图上
    viewMode, moveSelection,
    newFileTemplateOpen, shortcutHelpOpen,
  ]);
  // 只在「文件管理」板块内生效：终端板块自己也注册了一套全局快捷键（分屏、搜索、
  // 命令面板…），两套同时在 window 上监听会让 ⌘F / ⌘K 这类键一次触发两个动作。
  // 换板块时把文件管理这套整体关掉，比逐个判断"当前在哪个 app"干净。
  useKeyboardShortcuts(shortcutSpecs, activeApp === "files");

  // tooltip / 右键菜单里的键位提示全部从这份注册表现算。写死 "刷新 (⌘+R)" 有两个错：
  // Windows/Linux 上用户在按一个不存在的键（matchSpec 的主修饰键在那边是 Ctrl），
  // 以及快捷键一改，tooltip 就悄悄开始说谎。
  const shortcutHintMap = useMemo(() => shortcutHints(shortcutSpecs), [shortcutSpecs]);
  const hint = useCallback((desc: string) => hintSuffixOf(shortcutHintMap, desc), [
    shortcutHintMap,
  ]);

  // ——— 活动栏（左侧窄图标栏）———
  //
  // 形态变化：从「280px 常驻宽侧栏」改成「48px 图标栏 + 按需展开的面板区」。
  // 原来三块（搜索 / 收藏夹 / 暂存栈）常驻占着 280px，在 13 寸屏上比文件列表
  // 本身还宽。现在没打开的面板不占任何横向空间。
  //
  // 入口分两组：
  //   「浏览」组 —— 在本机文件系统里找东西（搜索 / 收藏 / 暂存）
  //   「工具」组 —— 对文件做事（工具箱 / 下载 / 远程 / 回收站）
  // 后续从别的仓合并进来的能力（终端、PDF、OCR…）也落在「工具」组，
  // 每个能力在栏上只占一个图标，不必再往宽侧栏里塞一整块面板。
  // 活动栏「浏览」组的三个入口会展开面板区，面板内容在下面的 railPanel 里渲染。
  // 这里只声明「哪些 key 是面板型入口」，内容不重复写两份 ——
  // 同一份 SearchBar 写两遍的话，改了一处忘了另一处，就是两个入口行为不一致。
  const railItems: ActivityBarItem[] = [
    {
      key: "search",
      label: "搜索",
      icon: <SearchOutlined />,
      group: "browse",
    },
    {
      key: "bookmarks",
      label: "收藏夹",
      icon: <StarOutlined />,
      group: "browse",
    },
    {
      key: "dropstack",
      label: "暂存栈",
      icon: <InboxOutlined />,
      group: "browse",
    },
    {
      key: "terminal",
      label: "终端",
      icon: <CodeOutlined />,
      group: "tools",
    },
    {
      key: "tools",
      label: "工具箱",
      icon: <ToolOutlined />,
      group: "tools",
      onClick: () => setQuickActionsOpen(true),
    },
    {
      key: "downloads",
      label: "下载",
      icon: <CloudDownloadOutlined />,
      group: "tools",
      onClick: () => setAria2Open(true),
    },
    {
      key: "remote",
      label: "远程",
      icon: <GlobalOutlined />,
      group: "tools",
      onClick: () => setSftpOpen(true),
    },
    {
      key: "trash",
      label: "回收站",
      icon: <DeleteOutlined />,
      group: "tools",
      onClick: () => setTrashOpen(true),
    },
  ];

  // 当前展开的面板内容。railActive 为空时不渲染整个面板区。
  const railPanel = (() => {
    switch (railActive) {
      case "search":
        return (
          <SidebarPanel title="搜索" icon={<SearchOutlined />} onClose={() => setRailActive("")}>
            <div style={{ padding: 8 }}>
              <SearchBar rootPath={rootPath} />
            </div>
          </SidebarPanel>
        );
      case "bookmarks":
        return (
          <SidebarPanel title="收藏夹" icon={<StarOutlined />} onClose={() => setRailActive("")}>
            <Bookmarks onNavigate={(path) => navigateTo(path)} />
          </SidebarPanel>
        );
      case "dropstack":
        return (
          <SidebarPanel title="暂存栈" icon={<InboxOutlined />} onClose={() => setRailActive("")}>
            <DropStack currentPath={currentPath} onRefresh={() => loadDirectory(currentPath)} />
          </SidebarPanel>
        );
      case "terminal":
        return (
          <SidebarPanel title="终端" icon={<CodeOutlined />} onClose={() => setRailActive("")}>
            <div style={{ height: "100%", minHeight: 0 }}>
              <BuiltInTerminal
                currentPath={currentPath}
                onPathChange={(path) => navigateTo(path)}
                visible
                embedded
                onClose={() => setRailActive("")}
              />
            </div>
          </SidebarPanel>
        );
      default:
        return null;
    }
  })();

  /**
   * 标签条右端的窗口级动作。
   *
   * 原来这些是顶栏的 headerExtra，和左端一个品牌图标对拉在 48px 的一条里。
   * 顶栏取消后（AppShell hideHeader），它们跟标签挤进同一行：
   * 左边「在哪些地方」，右边「对当前窗口整体做什么」，一行说完。
   *
   * 后退 / 前进 / 上级**没有**搬过来：下面路径栏（Omnibar）里本来就有这三个，
   * 隔一行的两条一模一样，纯属重复。导航按钮摆在要导航的路径旁边才顺手。
   */
  const tabActions = (
    <>
      {/* 版本戳：构建时注入的版本号 + 构建时刻 + git 哈希。
          放顶栏最左（其它都是动作按钮，它只是“现在是哪个包”的身份信息）。
          平时只露一个 v0.2.2，hover 才看得到打包时间与 commit。 */}
      <Tooltip
        title={
          <>
            版本 {APP_VERSION}
            <br />
            构建于 {BUILD_TIME}
            {GIT_HASH !== "—" && (
              <>
                <br />
                提交 {GIT_HASH}
              </>
            )}
          </>
        }
        placement="bottom"
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--ant-color-text-tertiary)",
            padding: "0 6px",
            cursor: "default",
            whiteSpace: "nowrap",
            userSelect: "none",
          }}
          aria-label={`版本 ${APP_VERSION}，构建于 ${BUILD_TIME}${GIT_HASH !== "—" ? `，提交 ${GIT_HASH}` : ""}`}
        >
          v{APP_VERSION}
        </span>
      </Tooltip>
      <Tooltip title={`刷新${hint("刷新当前目录")}`} placement="bottom">
        <Button
          type="text"
          icon={<ReloadOutlined />}
          onClick={() => loadDirectory(currentPath)}
          size="small"
          aria-label="刷新"
        />
      </Tooltip>
      <Tooltip title={`${showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}${hint("显示/隐藏隐藏文件")}`} placement="bottom">
        <Button
          size="small"
          icon={showHidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
          onClick={() => setShowHidden(!showHidden)}
          type={showHidden ? "primary" : "text"}
          aria-label={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
        />
      </Tooltip>
      {/* 预览区开关。
          以前它是「预览区收起时贴在主区右上角」的一颗小按钮 —— 收起之后
          那个位置空出来，用户反而找不到再打开的入口（唯一的入口藏在了
          "已经收起"的地方）。挪到顶栏后始终在，且它和刷新/隐藏文件/主题
          本来就是同一类窗口级动作。
          分栏视图下不渲染：那个模式本身就是多列预览（下面预览区的
          渲染条件也写了 `viewMode !== "column"`），放一个永远灰着的按钮
          只会让人以为坏了。 */}
      {viewMode !== "column" && (
        <Tooltip
          title={`${previewVisible ? "收起预览" : "展开预览"}${hint("显示/隐藏预览区")}`}
          placement="bottom"
        >
          <Button
            size="small"
            type={previewVisible ? "primary" : "text"}
            icon={<PicRightOutlined />}
            onClick={() => setPreviewVisible((v) => !v)}
            aria-label={previewVisible ? "收起预览区" : "展开预览区"}
          />
        </Tooltip>
      )}
      <Tooltip title={`快捷键${hint("查看快捷键面板")}`} placement="bottom">
        <Button
          size="small"
          type="text"
          icon={<ThunderboltOutlined />}
          onClick={() => setShortcutHelpOpen(true)}
          aria-label="快捷键"
        />
      </Tooltip>
      <Tooltip
        title={`${mode === "dark" ? "切换到亮色" : "切换到暗色"}${hint("切换主题")}`}
        placement="bottom"
      >
        <Button
          type="text"
          size="small"
          icon={mode === "dark" ? <BulbFilled /> : <BulbOutlined />}
          onClick={toggleTheme}
          aria-label={mode === "dark" ? "切换到亮色" : "切换到暗色"}
        />
      </Tooltip>
    </>
  );

  return (
    // 更新中心放在这一层：既有 AppShell 里的两个入口（左下角 + 顶栏），
    // 也有兜底的手动下载面板，三者都读同一份 check() 结果。
    <UpdateCenterProvider onOpenManualDownload={() => setUpdaterOpen(true)}>
    {/* 子组件（Omnibar / TabsBar / 预览区）通过 useShortcutHint() 取同一份注册表，
        不再各自抄一份 mac 专属文案。这里不重排内部缩进，只为少 800 行噪音 diff。 */}
    <ShortcutHintsProvider specs={shortcutSpecs}>
    <AppShell
      title="z-biz-tool-file"
      // 顶栏取消：按钮进标签条右端，品牌图标进活动栏顶部。
      // 48px 的横条只装一个图标 + 一排按钮，不如让标签条本身就是顶栏。
      hideHeader
      rail={
        <ActivityBar
          apps={RAIL_APPS}
          activeApp={activeApp}
          onAppChange={setActiveApp}
          // 下段「功能入口」全是文件管理板块的功能（搜索 / 收藏夹 / 暂存栈 / 终端面板…），
          // 切到终端板块时整段让位：终端自己左边有一列服务器列表，三段竖栏并排会挤成一条缝。
          // 面板区同理（railPanel 传 undefined = 收起），否则那边还挂着一块文件管理的面板。
          items={activeApp === "files" ? railItems : []}
          activeKey={railActive}
          onActiveChange={setRailActive}
          footer={
            activeApp === "files" ? (
              <>
                {/* 左下角常驻：平时安静，有新版挂红点，点一下自己装完重启 */}
                <UpdateLauncher />
                <ActivityBarMore label="更多工具" onClick={() => setQuickActionsOpen(true)} />
              </>
            ) : undefined
          }
        />
      }
      railPanel={activeApp === "files" ? railPanel : undefined}
      railPanelWidth={280}
    >
      {/* 应用切换的落点：主区渲染哪个板块由 activeApp 决定。
          当前只注册了 files 一个应用，所以永远走第一支 —— 点活动栏顶部的
          文件管理图标是恒等的。第二个应用接进来时在这里加分支，
          不用回头改 ActivityBar。 */}
      {activeApp === "files" ? (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {/* 多标签页（同时也是窗口的顶栏：右侧挂窗口级动作） */}
        <TabsBar
          actions={tabActions}
          onOpenNewTab={() => {
            const id = openTab(currentPath || homeDirSync());
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
            prefix={<SearchOutlined style={{ color: "var(--ant-color-text-tertiary)" }} />}
            placeholder="过滤…"
            id="z-tool-quick-filter"
            value={quickFilter}
            onChange={(e) => setQuickFilter(e.target.value)}
            style={{ width: 180 }}
            aria-label="快速过滤当前目录"
          />
          <Tooltip title={`新建文件${hint("新建文件")}`}>
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
          <Tooltip title={`新建文件夹${hint("新建文件夹")}`}>
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
          {selectedArchives.length > 0 ? (
            <Tooltip title={`解压到压缩包旁边的文件夹${hint("解压选中项")}`}>
              <Button
                size="small"
                type="primary"
                icon={<ExpandOutlined />}
                onClick={() => {
                  for (const f of selectedArchives) void handleExtractToSibling(f);
                }}
                aria-label="解压选中项"
              >
                解压{selectedArchives.length > 1 ? ` ${selectedArchives.length} 项` : ""}
              </Button>
            </Tooltip>
          ) : (
            <Tooltip title="压缩选中项；什么都没选就先挑文件">
              <Button
                size="small"
                icon={<FileZipOutlined />}
                onClick={() => { void handleCompress(); }}
                aria-label="压缩"
              >
                压缩
              </Button>
            </Tooltip>
          )}
          <Tooltip title="PDF 工具集（合并/拆分/水印/压缩/提取图片）">
            <Button
              size="small"
              icon={<FilePdfOutlined />}
              onClick={() => {
                // 选中的就是那个 PDF 时直接带进去：右键菜单那条入口本来就这么做，
                // 工具栏这里原先一律塞 null，等于逼用户再挑一次同一个文件
                setPdfToolsPath(selectedFile?.path ?? null);
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
          <Tooltip title="图书馆 & 媒体库（Calibre 风格，新标签页打开）">
            <Button
              size="small"
              icon={<BookOutlined />}
              onClick={() => openTab("library://main", "library")}
              aria-label="打开图书馆"
            >
              图书馆
            </Button>
          </Tooltip>
          {/* 有新版才出现；与左下角入口共用 UpdateCenter 的同一份状态 */}
          <UpdateTopButton />
          <Tooltip title="回收站（已删除的文件）">
            <Button
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => setTrashOpen(true)}
              aria-label="打开回收站"
            />
          </Tooltip>
          <Tooltip title={`复制${hint("复制选中")}`}>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => selectedFiles.length > 0 && handleCopy(selectedFiles)}
              disabled={selectedFiles.length === 0}
              aria-label="复制"
            />
          </Tooltip>
          <Tooltip title={`剪切${hint("剪切选中")}`}>
            <Button
              size="small"
              icon={<ScissorOutlined />}
              onClick={() => selectedFiles.length > 0 && handleCut(selectedFiles)}
              disabled={selectedFiles.length === 0}
              aria-label="剪切"
            />
          </Tooltip>
          <Tooltip title={`粘贴${hint("粘贴")}`}>
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
              // 终端搬进活动栏面板后，这里不再是"开/关底部抽屉"，
              // 而是"跳到活动栏的终端面板"——两处入口指向同一个面板。
              onClick={() => setRailActive((v) => (v === "terminal" ? "" : "terminal"))}
              type={railActive === "terminal" ? "primary" : "text"}
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
              { value: "table", icon: <TableOutlined />, title: `表格${hint("表格视图")}` },
              { value: "list", icon: <UnorderedListOutlined />, title: `列表${hint("列表视图")}` },
              { value: "grid", icon: <AppstoreOutlined />, title: `网格${hint("网格视图")}` },
              { value: "column", label: "分栏", title: `分栏${hint("分栏视图")}` },
            ]}
          />
        </div>

        {/* 根据当前 active tab 类型决定主内容：directory=文件列表，library=图书馆&媒体库全屏。
            嵌入用法全站只有一处，所以 initialTab 显式给 library：LibraryView 缺省是 media，
            那样标签写着图书馆、点进去却是照片列表，名称与落地页不一致。 */}
        {activeTabKind === "library" ? (
          <div style={{ flex: 1, overflow: "auto", background: "var(--ant-color-bg-layout)" }}>
            <LibraryView open={true} onClose={() => {}} embedded initialTab="library" />
          </div>
        ) : (
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
              {dirError ? (
                <div
                  role="alert"
                  style={{
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    padding: 24,
                    textAlign: "center",
                  }}
                >
                  <div style={{ color: "var(--ant-color-error)" }}>读取这个目录失败：{dirError}</div>
                  <div style={{ color: "var(--ant-color-text-secondary)", fontSize: 12 }}>{currentPath}</div>
                  <Button size="small" onClick={() => loadDirectory(currentPath)}>重试</Button>
                </div>
              ) : viewMode === "table" ? (
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
                        onDoubleClick: () => handleOpen([record]),
                        onContextMenu: () => selectForContextMenu(record),
                      })}
                      rowClassName={(record) =>
                        selectedSet.has(String(record.path)) ? "z-tool-row-selected" : ""
                      }
                      locale={{
                        // 目录还没回来时先给骨架屏，别闪一下"该文件夹为空"
                        emptyText: dirLoading ? (
                          <Skeleton active title={false} paragraph={{ rows: 8 }} />
                        ) : (
                          "该文件夹为空"
                        ),
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
                <ErrorBoundary inline resetKey={currentPath}>
                <Dropdown
                  trigger={["contextMenu"]}
                  menu={{ items: selectedFile ? contextMenuItems(selectedFile) : [] }}
                >
                  <div style={{ height: "100%" }}>
                    <GridView
                      mode={viewMode}
                      files={filteredFileList}
                      selectedFile={selectedFile}
                      selectedRowKeys={selectedRowKeys}
                      onClick={handleGridClick}
                      onDoubleClick={handleGridDoubleClick}
                      // 网格/分栏视图同样要"右键即选中"：菜单项读的是 selectedFile。
                      // 这里不动 selectedRowKeys（网格的 onClick 也不动），免得把目录塞进批量选择里。
                      onContextMenu={handleGridContextMenu}
                      onDragStart={(entry, e) => handleRowDragStart(e, entry)}
                      onDragEnd={handleRowDragEnd}
                    />
                  </div>
                </Dropdown>
                </ErrorBoundary>
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
                <PreviewPane
                  onCollapse={() => setPreviewVisible(false)}
                  editingImage={previewEditImage}
                  onEditImage={() => setPreviewEditImage(true)}
                  onExitEditImage={() => setPreviewEditImage(false)}
                />
              </div>
            </>
          )}
          {/* 预览区收起时这里不再挂「展开」按钮 —— 那个入口已经挪到顶栏
              （tabActions 里那个 PicRight 图标）。留在这里的话，收起后
              主区右边会多出一条空地，而按钮本身又只在这个空地才出现。 */}
        </div>
        )}
      </div>
      ) : activeApp === "terminal" ? (
        // 终端板块：整块替换主区。它自带侧栏与顶栏工具条，不共用文件管理那套
        // 标签条/路径栏 —— 两边的"导航对象"根本不是一回事（文件路径 vs SSH 会话）。
        <Suspense
          fallback={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--ant-color-text-tertiary)",
                fontSize: 13,
              }}
            >
              正在加载终端…
            </div>
          }
        >
          <TerminalApp />
        </Suspense>
      ) : activeApp === "library" ? (
        // 图书馆板块：同样是整块替换。它自己带归纳侧栏与阅读面板，
        // 与文件管理的「路径 + 标签条」不是一回事，塞进同一个壳只会互相打架。
        <Suspense
          fallback={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--ant-color-text-tertiary)",
                fontSize: 13,
              }}
            >
              正在打开图书馆…
            </div>
          }
        >
          <LibraryApp />
        </Suspense>
      ) : activeApp === "gallery" ? (
        // 图片库板块：整块替换主区。
        // 它有自己的浏览位置（默认 ~/Pictures，记在 localStorage），
        // **不跟文件管理的 currentPath 联动** —— 「按类型看内容」和
        // 「当前站在哪个目录」本来就是两件事。
        <Suspense
          fallback={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--ant-color-text-tertiary)",
                fontSize: 13,
              }}
            >
              正在打开图片库…
            </div>
          }
        >
          <GalleryApp />
        </Suspense>
      ) : activeApp === "db" ? (
        // 数据库板块：2026-11-06 从 z-biz-tool-db 仓搬入。
        // 同样是整块替换 —— 它自带连接列表侧栏 + SQL 编辑器 + 报表工作台，
        // 与文件管理的「路径 + 标签条」和图书馆的「归纳 + 书目 + 阅读」都不是一回事。
        <Suspense
          fallback={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--ant-color-text-tertiary)",
                fontSize: 13,
              }}
            >
              正在打开数据库…
            </div>
          }
        >
          <DbApp />
        </Suspense>
      ) : activeApp === "sys" ? (
        // 系统板块：2026-11-06 从 z-biz-tool-sys 仓搬入。
        // 整块替换主区 —— 它自成一套「顶栏 + 8 个 tab + 采集曲线」的仪表盘，
        // 塞进文件管理那套「路径 + 标签条」里既没有意义也摆不下。
        <Suspense
          fallback={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--ant-color-text-tertiary)",
                fontSize: 13,
              }}
            >
              正在加载系统监控…
            </div>
          }
        >
          <SysApp />
        </Suspense>
      ) : activeApp === "worker" ? (
        // AI 任务看板板块：2026-11-07 从 z-biz-tool-worker 仓搬入。
        // 整块替换主区 —— 项目和任务的看板不适合塞进文件管理的目录树。
        <Suspense
          fallback={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--ant-color-text-tertiary)",
                fontSize: 13,
              }}
            >
              正在加载任务看板…
            </div>
          }
        >
          <WorkerApp />
        </Suspense>
      ) : activeApp === "mind" ? (
        // 思维导图板块：2026-11-08 从 z-biz-tool-mind 仓搬入。
        // 整块替换主区 —— 导图编辑器自成一整套「工具条 + 页签 + 画布」，跟文件管理
        // 的目录树 / 文件列表不搭；保存/导出的 .emmx 会进文件区，两者天然衔接。
        <Suspense
          fallback={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--ant-color-text-tertiary)",
                fontSize: 13,
              }}
            >
              正在加载思维导图…
            </div>
          }
        >
          <MindApp />
        </Suspense>
      ) : activeApp === "glossary" ? (
        // 词库板块：2026-11-08 新建。kb 通用能力落地，三个页签（词条/问答/检索文件）。
        <Suspense
          fallback={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--ant-color-text-tertiary)",
                fontSize: 13,
              }}
            >
              正在加载词库…
            </div>
          }
        >
          <GlossayApp />
        </Suspense>
      ) : (
        // 兜底分支：只有"注册了应用但主区还没接"才会走到这里。
        // 留一句人话，总比切过去看到一片空白、以为程序崩了强。
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "var(--ant-color-text-tertiary)",
            fontSize: 13,
          }}
        >
          「{RAIL_APPS.find((a) => a.key === activeApp)?.label ?? activeApp}」这个板块还没接进来
        </div>
      )}

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
        // 名字含 / 或 \\ 时让后端拿到的是 "/currentpath/a/b"，等于悄悄建到子目录，
        // 弹窗看着"成功了"，用户找不到刚建的文件。onChange 实时吞掉这些字符，
        // 并把"非空 + 合法 + 与现有条目不重名"作为 okButton 可用的判据 ——
        // Enter 提交也走这条，按钮没亮起来就按不动 Enter。
        okButtonProps={{ disabled: !createNameValid }}
      >
        <Input
          value={createName}
          onChange={(e) => setCreateName(sanitizeFileNameInput(e.target.value))}
          onPressEnter={handleCreate}
          placeholder={createModal.type === "file" ? "请输入文件名（含扩展名）" : "请输入文件夹名"}
          autoFocus
          status={createName && !createNameValid ? "error" : undefined}
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
            // 双面板里双击压缩包也要进本应用的归档浏览器。这里原先无条件交给系统默认程序，
            // 于是同一个包在主表格里双击进浏览器、在双面板里双击弹出 7-Zip ——
            // 而"能替掉 7-Zip"这件事，恰恰要求后者不再发生。
            // 目录走不到这里（面板自己 navigateTo 了），所以只需判文件那半边。
            if (archiveOpenExts.includes(lastExtension(fsBaseName(path)))) {
              openArchiveBrowser(path);
              return;
            }
            invoke("open_with_default_app", { path }).catch((err) =>
              message.error("打开失败: " + err)
            );
          }}
        />
      )}

      {/* 重复文件查找 */}
      <DuplicateFinder
        open={duplicateFinderOpen}
        onClose={() => { setDuplicateFinderOpen(false); setDuplicateRoot(null); }}
        currentPath={currentPath}
        initialPath={duplicateRoot}
        onRefresh={() => loadDirectory(currentPath)}
      />

      {/* 哈希计算 */}
      <HashCalculator
        open={hashCalcOpen}
        onClose={() => setHashCalcOpen(false)}
        filePath={selectedFile?.path || null}
        files={hashFiles}
      />

      {/* 目录同步 */}
      <DirectorySync
        open={dirSyncOpen}
        onClose={() => setDirSyncOpen(false)}
        currentPath={currentPath}
      />

      {/* 归档浏览器（双击压缩包 / Enter / 右键"打开压缩包"都落到这里） */}
      <ArchiveExplorer
        open={archiveExplorerOpen}
        onClose={() => { setArchiveExplorerOpen(false); setArchiveExplorerPath(null); }}
        archivePath={archiveExplorerPath}
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
        initialLeft={diffSeeds.left}
        initialRight={diffSeeds.right}
      />

      {/* OCR */}
      <OcrTool
        open={ocrOpen}
        onClose={() => setOcrOpen(false)}
        initialPath={selectedFile?.path ?? null}
      />

      {/* Aria2 离线下载 */}
      <Aria2Manager open={aria2Open} onClose={() => setAria2Open(false)} />

      {/* 图书馆 & 媒体库（作为 tab 内嵌显示，不需要独立 modal）*/}

      {/* 应用更新 */}
      <Updater open={updaterOpen} onClose={() => setUpdaterOpen(false)} />

      {/* 压缩对话框：任务起来就关，进度交给右下角那块常驻面板 */}
      <ArchiveCreateDialog
        open={archiveCreateOpen}
        onClose={() => { setArchiveCreateOpen(false); setArchiveCreateSources([]); }}
        sources={archiveCreateSources}
        defaultDir={currentPath}
        onStarted={() => loadDirectory(currentPath)}
      />

      {/*
        任务面板常驻，不受任何弹窗的 open 控制：解压一个 7 GB 的包是十分钟级的事，
        用户中途关掉浏览窗口，进度和取消按钮必须还在
      */}
      <ArchiveJobPanel />

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
            <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
              {mediaLibraryType === "image" && <PictureOutlined style={{ color: "#1677ff" }} />}
              {mediaLibraryType === "video" && <VideoCameraOutlined style={{ color: "#1677ff" }} />}
              {mediaLibraryType === "audio" && <AudioOutlined style={{ color: "#1677ff" }} />}
              {mediaLibraryType === "image" && "照片馆"}
              {mediaLibraryType === "video" && "视频馆"}
              {mediaLibraryType === "audio" && "音乐馆"}
              {/* 版式开关放在标题栏：库里几十张图时，唯一能救回屏幕空间的就是切列表 */}
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }} onClick={(e) => e.stopPropagation()}>
                <Segmented
                  size="small"
                  value={mediaViewMode}
                  onChange={(v) => setMediaViewMode(v as MediaViewMode)}
                  options={[
                    { label: "画廊", value: "gallery" },
                    { label: "列表", value: "list" },
                  ]}
                  aria-label="切换版式"
                />
                <Segmented
                  size="small"
                  // 尺寸只作用于网格；音乐馆的画廊本来就是单列行，列表视图也没有列宽可调
                  disabled={!sizeControlEnabled(mediaViewMode, mediaLibraryType)}
                  value={mediaGallerySize}
                  onChange={(v) => setMediaGallerySize(v as MediaGallerySize)}
                  options={[
                    { label: "小", value: "small" },
                    { label: "中", value: "medium" },
                    { label: "大", value: "large" },
                  ]}
                  aria-label="缩略图尺寸"
                />
              </div>
            </div>
          }
          open={mediaLibraryOpen}
          // antd Modal 没有 onClose 这个 prop，只有 onCancel：X、遮罩、Esc 三条关闭
          // 路径全走它。之前写的是 onClose ⇒ 三个都不响，而全站没有任何一处把
          // mediaLibraryOpen 置回 false，照片馆/视频馆/音乐馆一打开就出不来，只能 ⌘R。
          // （实测：点 X 后 .ant-modal 停在 ant-zoom-appear，连 ant-zoom-leave 都不出现；
          // 同一条通道里对比弹窗的 X 是会进 leave 的。）
          onCancel={() => setMediaLibraryOpen(false)}
          width="90vw"
          footer={null}
          // Modal 也没有 height：亮高挂在 styles.body 上，正文那句 height:100% 才有参照
          styles={{ body: { padding: "0", overflow: "hidden", height: "80vh" } }}
        >
          <div style={{ height: "100%", overflow: "hidden" }}>
            <MediaGallery
              directory={mediaLibraryPath}
              mediaType={mediaLibraryType}
              viewMode={mediaViewMode}
              size={mediaGallerySize}
              onOpen={(item) => {
                invoke("open_with_default_app", { path: item.path }).catch((err) =>
                  message.error("打开失败: " + err)
                );
              }}
              onReveal={(item) => {
                invoke("reveal_in_finder", { path: item.path }).catch((err) =>
                  message.error("打开 Finder 失败: " + err)
                );
              }}
              // 删除只走 handleDelete 一条路：它自带"移到回收站？"确认框（危险操作
              // 主按钮写明动作），而这里原先额外套了一层写死的 Modal.confirm，等于
              // 同一次删除两个口径的确认文案，且那层弹窗没走 App 的 modal 实例。
              onDelete={(item, afterDeleted) =>
                handleDelete({ name: item.name, path: item.path }, false, afterDeleted)
              }
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
        initialPath={currentPath || homeDirSync()}
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
        suggestedPath={selectedFile?.path || currentPath}
      />
      <ShortcutHelp
        open={shortcutHelpOpen}
        onClose={() => setShortcutHelpOpen(false)}
        specs={shortcutSpecs}
      />

      {/* 传输队列 */}
      <TransferQueue />
    </AppShell>
    </ShortcutHintsProvider>
    </UpdateCenterProvider>
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
  okButtonProps,
  children,
}: {
  open: boolean;
  onOk: () => void;
  onCancel: () => void;
  title: ReactNode;
  okText?: string;
  cancelText?: string;
  /** 透传给 antd Modal 的 OK 按钮（disabled / loading / danger 等）。 */
  okButtonProps?: { disabled?: boolean; loading?: boolean; danger?: boolean };
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
      okButtonProps={okButtonProps}
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
        {/*
          更新中心挂在 AppShellInner 内部（见那里的 UpdateCenterProvider）：
          原先这里有个从 terminal 搬来的 UpdaterGate 自己弹窗，与顶栏红点用的
          GitHub Releases 静默检查是两套状态 —— 已收敛成一条官方 updater 通道。
        */}
        <AppShellInner />
      </AntdApp>
    </ThemeProvider>
  );
}