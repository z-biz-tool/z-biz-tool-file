import { invoke } from "@tauri-apps/api/core";

// 索引状态
export interface IndexStats {
  version: number;
  built_at: number;
  total_files: number;
  total_size: number;
}

// 文件索引项
export interface FileIndexItem {
  path: string;
  name: string;
  is_dir: boolean;
  size: number;
  modified: number;
  ext: string;
}

// 内容索引项
export interface ContentIndexItem {
  path: string;
  word: string;
  line_number: number;
  snippet: string;
}

// 索引构建进度
export interface IndexProgress {
  total: number;
  processed: number;
  current_file: string;
  status: "idle" | "building" | "ready" | "error";
}

/**
 * 初始化索引系统
 */
export async function initIndexer(): Promise<{ status: string; stats: IndexStats }> {
  try {
    const result = await invoke<{ status: string; stats: IndexStats }>("indexer_init");
    return result;
  } catch (error) {
    console.error("Failed to init indexer:", error);
    return { status: "error", stats: defaultStats() };
  }
}

/**
 * 构建索引
 */
export async function buildIndexer(rootPath: string): Promise<{ status: string; stats: IndexStats }> {
  try {
    const result = await invoke<{ status: string; stats: IndexStats }>("indexer_build", { rootPath });
    return result;
  } catch (error) {
    console.error("Failed to build indexer:", error);
    return { status: "error", stats: defaultStats() };
  }
}

/**
 * 搜索文件名
 */
export async function searchFiles(query: string, maxResults: number = 50): Promise<FileIndexItem[]> {
  try {
    const result = await invoke<{ results: FileIndexItem[] }>("indexer_search_files", {
      query,
      maxResults,
    });
    return result.results || [];
  } catch (error) {
    console.error("Failed to search files:", error);
    return [];
  }
}

/**
 * 搜索文件内容
 */
export async function searchContent(query: string, maxResults: number = 50): Promise<ContentIndexItem[]> {
  try {
    const result = await invoke<{ results: ContentIndexItem[] }>("indexer_search_content", {
      query,
      maxResults,
    });
    return result.results || [];
  } catch (error) {
    console.error("Failed to search content:", error);
    return [];
  }
}

/**
 * 获取索引统计
 */
export async function getIndexStats(): Promise<IndexStats> {
  try {
    const result = await invoke<{ stats: IndexStats }>("indexer_get_stats");
    return result.stats || defaultStats();
  } catch (error) {
    console.error("Failed to get index stats:", error);
    return defaultStats();
  }
}

function defaultStats(): IndexStats {
  return {
    version: 0,
    built_at: 0,
    total_files: 0,
    total_size: 0,
  };
}

/**
 * 自动索引更新（当文件变化时）
 */
export async function updateFileIndex(path: string): Promise<void> {
  try {
    // 使用 Tauri 的文件系统事件监听
    const { listen } = await import("@tauri-apps/api/event");
    
    // 监听文件变化并自动更新索引
    // 这里可以添加更复杂的逻辑
  } catch (error) {
    console.error("Failed to update file index:", error);
  }
}
