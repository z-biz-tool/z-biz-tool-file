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

// 文件类型分类
export type FileType = "image" | "video" | "audio" | "text" | "epub" | "mobi" | "pdf" | "other";

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

  setCurrentPath: (path) => set({ currentPath: path }),
  setFileList: (list) => set({ fileList: list }),
  setSelectedFile: (file) => set({ selectedFile: file }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchResults: (results) => set({ searchResults: results }),
  setIsSearching: (searching) => set({ isSearching: searching }),
  setSearchMode: (mode) => set({ searchMode: mode }),
  setSearchRoot: (path) => set({ searchRoot: path }),
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
      "md",
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
