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

/**
 * 列表刷新后把这一层的索引对齐（后台跑，不阻塞浏览）。
 *
 * 索引原来只在手动「重新构建」时才更新：新建/改名/删掉一个文件之后，
 * 搜索结果里还留着已经不存在的条目，点上去是"文件不存在"；反过来新文件搜不到。
 * 失败一律咽掉 —— 这是自我修正，不是用户按下的动作，不该因为索引问题弹错误。
 */
export interface SyncDirResult {
  dropped: number;
  refreshed: number;
  unchanged: number;
}

export function syncDirIndex(
  dir: string,
  entries: Array<{ name: string; size: number; modified: number }>,
  listingIncludesHidden: boolean
): Promise<SyncDirResult | null> {
  return invoke<SyncDirResult>("indexer_sync_dir", {
    dir,
    entries: entries.map(({ name, size, modified }) => ({ name, size, modified })),
    listingIncludesHidden,
  }).catch(() => {
    // 索引对齐失败不影响这一页的显示，也不该给用户弹错误
    return null;
  });
}

function defaultStats(): IndexStats {
  return {
    version: 0,
    built_at: 0,
    total_files: 0,
    total_size: 0,
  };
}

