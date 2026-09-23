import { create } from "zustand";
import type { MediaGallerySize, MediaViewMode } from "../utils/mediaLayout";

// 文件条目类型
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

// 搜索结果类型
export interface SearchResultItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  matched_line?: string | null;
}

// 剪贴板条目类型
export interface ClipboardItem {
  path: string;
  name: string;
  is_dir: boolean;
  operation: "copy" | "cut"; // cut = move, copy = copy
}

// 书签条目类型
export interface BookmarkItem {
  name: string;
  path: string;
}

// 文件类型分类
export type FileType = "image" | "video" | "audio" | "text" | "markdown" | "doc" | "epub" | "mobi" | "pdf" | "other";

// 标签页。kind 不能省：activeTabKind / switchTab / TabsBar 的标题与图标都按 kind 分支，
// 缺 kind 的 tab 会被当成目录 tab，于是 "library://main" 这类伪路径会被拿去加载目录。
export interface FileTab {
  id: string;
  path: string;
  // directory(目录浏览) / library(图书馆&媒体库) / media(媒体库 - 兼容)
  kind: "directory" | "library" | "media";
  meta?: { libraryKind?: string }; // library tab 可指定 book/music/movie...
}

interface FileStore {
  // 当前路径
  currentPath: string;
  // 当前目录下的文件列表
  fileList: FileEntry[];
  // 选中的文件
  selectedFile: FileEntry | null;
  // 搜索关键词
  // 搜索结果
  // 是否正在搜索
  // 搜索模式：filename | content
  // 搜索根路径
  // 是否显示隐藏文件
  showHidden: boolean;
  // 剪贴板
  clipboard: ClipboardItem[];
  // 书签
  bookmarks: BookmarkItem[];
  // 文件列表显示模式
  viewMode: "table" | "grid" | "list" | "column";
  // 多标签页
  tabs: FileTab[];
  activeTabId: string | null;
  // 文件标签/备注（path → tag）
  tagsByPath: Record<string, { color: string; label: string; note: string }>;
  // AI 功能相关状态
  // 媒体库状态
  /** 索引被列表对齐改动过的次数：搜索面板靠它刷新「索引已就绪 N 个文件」 */
  indexEpoch: number;
  bumpIndexEpoch: () => void;
  mediaViewMode: MediaViewMode;
  mediaGallerySize: MediaGallerySize;
  // 设置当前路径
  setCurrentPath: (path: string) => void;
  // 设置文件列表
  setFileList: (list: FileEntry[]) => void;
  // 设置选中文件
  setSelectedFile: (file: FileEntry | null) => void;
  // 设置搜索关键词
  // 设置搜索结果
  // 设置搜索状态
  // 设置搜索模式
  // 设置搜索根路径
  // 设置是否显示隐藏文件
  setShowHidden: (show: boolean) => void;
  // 设置剪贴板
  setClipboard: (items: ClipboardItem[], operation: "copy" | "cut") => void;
  // 清空剪贴板
  clearClipboard: () => void;
  // 添加书签
  addBookmark: (item: BookmarkItem) => void;
  // 移除书签
  removeBookmark: (path: string) => void;
  // 设置文件列表显示模式
  setViewMode: (mode: "table" | "grid" | "list" | "column") => void;
  // 多标签操作
  openTab: (path: string, kind?: FileTab["kind"], meta?: FileTab["meta"]) => string; // 返回 tab id
  closeTab: (id: string) => void;
  switchTab: (id: string) => void;
  updateActiveTabPath: (path: string) => void;
  // 标签操作
  loadAllTags: () => Promise<void>;
  setTag: (path: string, tag: { color: string; label: string; note: string }) => Promise<void>;
  removeTag: (path: string) => Promise<void>;
  // AI 功能状态更新
  // 媒体库状态更新
  setMediaViewMode: (mode: "gallery" | "list") => void;
  setMediaGallerySize: (size: "small" | "medium" | "large") => void;
}

export const useFileStore = create<FileStore>((set) => ({
  currentPath: "",
  fileList: [],
  selectedFile: null,
  showHidden: false,
  clipboard: [],
  bookmarks: JSON.parse(localStorage.getItem("z-tool-bookmarks") || "[]") as BookmarkItem[],
  viewMode: "table" as const,
  tabs: [] as FileTab[],
  activeTabId: null,
  tagsByPath: {} as Record<string, { color: string; label: string; note: string }>,
  // AI 功能相关状态
  // 媒体库状态
  indexEpoch: 0,
  bumpIndexEpoch: () => set((s) => ({ indexEpoch: s.indexEpoch + 1 })),
  mediaViewMode: "gallery",
  mediaGallerySize: "medium",

  setCurrentPath: (path) => set({ currentPath: path }),
  setFileList: (list) => set({ fileList: list }),
  setSelectedFile: (file) => set({ selectedFile: file }),
  setShowHidden: (show) => set({ showHidden: show }),
  setClipboard: (items, operation) =>
    set({
      clipboard: items.map((item) => ({ ...item, operation })),
    }),
  clearClipboard: () => set({ clipboard: [] }),
  addBookmark: (item) =>
    set((state) => {
      const bookmarks = [...state.bookmarks, item];
      localStorage.setItem("z-tool-bookmarks", JSON.stringify(bookmarks));
      return { bookmarks };
    }),
  removeBookmark: (path) =>
    set((state) => {
      const bookmarks = state.bookmarks.filter((b) => b.path !== path);
      localStorage.setItem("z-tool-bookmarks", JSON.stringify(bookmarks));
      return { bookmarks };
    }),
  setViewMode: (mode) => set({ viewMode: mode }),
  openTab: (path, kind = "directory", meta) => {
    // 始终创建新 tab，不去重。3 个调用点（挂载初始化 / ⌘+T / +按钮）
    // 都期望真的新增，重复打开让用户自己决定要不要关。
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({
      tabs: [...s.tabs, meta ? { id, path, kind, meta } : { id, path, kind }],
      activeTabId: id,
    }));
    return id;
  },
  closeTab: (id) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const newTabs = s.tabs.filter((t) => t.id !== id);
      let newActive = s.activeTabId;
      if (s.activeTabId === id) {
        // 切到邻居
        if (newTabs.length === 0) {
          newActive = null;
        } else if (idx < newTabs.length) {
          newActive = newTabs[idx].id;
        } else {
          newActive = newTabs[newTabs.length - 1].id;
        }
      }
      // 防止 tabs 数组变空（至少保留一个"主"tab）
      if (newTabs.length === 0) {
        const home = s.currentPath || "/";
        const homeId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        return {
          tabs: [{ id: homeId, path: home, kind: "directory" }],
          activeTabId: homeId,
        };
      }
      const next = newTabs.find((t) => t.id === newActive);
      // 关掉的是当前 tab 时视图必须跟上邻居。currentPath 若还停在被关掉的那个目录，
      // 新建文件 / 粘贴 / 压缩 / ⌘T 全都写进一个用户已经关掉的文件夹。
      // library tab 的 path 是伪路径，不能塞给 currentPath（与 switchTab 同一判据）。
      return {
        tabs: newTabs,
        activeTabId: newActive,
        currentPath: next && next.kind === "directory" ? next.path : s.currentPath,
      };
    });
  },
  switchTab: (id) => {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return s;
      // library / media tab 不更新 currentPath（避免无效路径触发目录加载）
      const nextPath = tab.kind === "directory" ? tab.path : s.currentPath;
      return {
        activeTabId: id,
        currentPath: nextPath,
      };
    });
  },
  updateActiveTabPath: (path) => {
    set((s) => {
      if (!s.activeTabId) return s;
      // 只给目录 tab 记路径。library tab 的 path 是伪路径（tabTitle / tabIcon 靠它），
      // 一旦被 currentPath 覆写：标签从"图书馆"变成某个目录名，再点回去 switchTab
      // 认它是目录 tab ⇒ 主内容区从图书馆弹回文件列表，而用户没做过任何切换动作。
      // 触发时机是关 tab 的修复重渲染：App 的 [currentPath] effect 会在新激活的
      // 那一刻把 currentPath 记到"当时激活的 tab"上。
      return {
        tabs: s.tabs.map((t) =>
          t.id === s.activeTabId && t.kind === "directory" ? { ...t, path } : t
        ),
      };
    });
  },
  loadAllTags: async () => {
    // 动态 import 避免循环依赖
    const { invoke } = await import("@tauri-apps/api/core");
    const all = await invoke<Record<string, { color: string; label: string; note: string }>>(
      "get_all_tags"
    );
    set({ tagsByPath: all });
  },
  setTag: async (path, tag) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_file_tag", { filePath: path, tag });
    set((s) => {
      const next = { ...s.tagsByPath };
      if (!tag.color && !tag.label && !tag.note) {
        delete next[path];
      } else {
        next[path] = tag;
      }
      return { tagsByPath: next };
    });
  },
  removeTag: async (path) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_file_tag", { filePath: path });
    set((s) => {
      const next = { ...s.tagsByPath };
      delete next[path];
      return { tagsByPath: next };
    });
  },
  // AI 功能状态更新
  // 媒体库状态更新
  setMediaViewMode: (mode) => set({ mediaViewMode: mode }),
  setMediaGallerySize: (size) => set({ mediaGallerySize: size }),
}));

/// 根据文件扩展名判断文件类型
export function getFileType(fileName: string): FileType {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico"].includes(ext)) {
    return "image";
  }
  if (["mp4", "webm", "ogg", "mov", "avi", "mkv", "m4v"].includes(ext)) {
    return "video";
  }
  if (["mp3", "wav", "flac", "aac", "m4a", "wma", "ogg"].includes(ext)) {
    return "audio";
  }
  if (
    [
      "txt",
      "rs",
      "go",
      "py",
      "js",
      "ts",
      "tsx",
      "jsx",
      "json",
      "yaml",
      "yml",
      "toml",
      "xml",
      "html",
      "css",
      "scss",
      "sh",
      "java",
      "c",
      "cpp",
      "h",
      "cs",
      "rb",
      "php",
      "swift",
      "kt",
      "sql",
      "log",
      "csv",
      "conf",
      "ini",
      "env",
    ].includes(ext)
  ) {
    return "text";
  }
  if (["md", "markdown"].includes(ext)) {
    return "markdown";
  }
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"].includes(ext)) {
    return "doc";
  }
  if (ext === "epub") {
    return "epub";
  }
  if (ext === "mobi") {
    return "mobi";
  }
  if (ext === "pdf") {
    return "pdf";
  }
  return "other";
}

/// 格式化文件大小
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/// 格式化时间戳
export function formatTime(timestamp: number): string {
  if (!timestamp) return "-";
  const date = new Date(timestamp * 1000);
  return date.toLocaleString("zh-CN");
}
