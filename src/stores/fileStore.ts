import { create } from "zustand";

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

interface FileStore {
  // 当前路径
  currentPath: string;
  // 当前目录下的文件列表
  fileList: FileEntry[];
  // 选中的文件
  selectedFile: FileEntry | null;
  // 搜索关键词
  searchQuery: string;
  // 搜索结果
  searchResults: SearchResultItem[];
  // 是否正在搜索
  isSearching: boolean;
  // 搜索模式：filename | content
  searchMode: "filename" | "content";
  // 搜索根路径
  searchRoot: string;
  // 是否显示隐藏文件
  showHidden: boolean;
  // 剪贴板
  clipboard: ClipboardItem[];
  // 书签
  bookmarks: BookmarkItem[];
  // 文件列表显示模式
  viewMode: "table" | "grid" | "list" | "column";
  // 多标签页
  tabs: Array<{ id: string; path: string }>;
  activeTabId: string | null;
  // 文件标签/备注（path → tag）
  tagsByPath: Record<string, { color: string; label: string; note: string }>;
  // 设置当前路径
  setCurrentPath: (path: string) => void;
  // 设置文件列表
  setFileList: (list: FileEntry[]) => void;
  // 设置选中文件
  setSelectedFile: (file: FileEntry | null) => void;
  // 设置搜索关键词
  setSearchQuery: (query: string) => void;
  // 设置搜索结果
  setSearchResults: (results: SearchResultItem[]) => void;
  // 设置搜索状态
  setIsSearching: (searching: boolean) => void;
  // 设置搜索模式
  setSearchMode: (mode: "filename" | "content") => void;
  // 设置搜索根路径
  setSearchRoot: (path: string) => void;
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
  openTab: (path: string) => string; // 返回 tab id
  closeTab: (id: string) => void;
  switchTab: (id: string) => void;
  updateActiveTabPath: (path: string) => void;
  // 标签操作
  loadAllTags: () => Promise<void>;
  setTag: (path: string, tag: { color: string; label: string; note: string }) => Promise<void>;
  removeTag: (path: string) => Promise<void>;
}

export const useFileStore = create<FileStore>((set) => ({
  currentPath: "",
  fileList: [],
  selectedFile: null,
  searchQuery: "",
  searchResults: [],
  isSearching: false,
  searchMode: "filename",
  searchRoot: "",
  showHidden: false,
  clipboard: [],
  bookmarks: JSON.parse(localStorage.getItem("z-tool-bookmarks") || "[]") as BookmarkItem[],
  viewMode: "table" as const,
  tabs: [] as Array<{ id: string; path: string }>,
  activeTabId: null,
  tagsByPath: {} as Record<string, { color: string; label: string; note: string }>,

  setCurrentPath: (path) => set({ currentPath: path }),
  setFileList: (list) => set({ fileList: list }),
  setSelectedFile: (file) => set({ selectedFile: file }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchResults: (results) => set({ searchResults: results }),
  setIsSearching: (searching) => set({ isSearching: searching }),
  setSearchMode: (mode) => set({ searchMode: mode }),
  setSearchRoot: (path) => set({ searchRoot: path }),
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
  openTab: (path) => {
    // 始终创建新 tab，不去重。3 个调用点（挂载初始化 / ⌘+T / +按钮）
    // 都期望真的新增，重复打开让用户自己决定要不要关。
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({
      tabs: [...s.tabs, { id, path }],
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
          tabs: [{ id: homeId, path: home }],
          activeTabId: homeId,
        };
      }
      return { tabs: newTabs, activeTabId: newActive };
    });
  },
  switchTab: (id) => {
    set((s) => {
      if (!s.tabs.find((t) => t.id === id)) return s;
      const tab = s.tabs.find((t) => t.id === id);
      return {
        activeTabId: id,
        currentPath: tab?.path ?? s.currentPath,
      };
    });
  },
  updateActiveTabPath: (path) => {
    set((s) => {
      if (!s.activeTabId) return s;
      return {
        tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, path } : t)),
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
