/**
 * 图书馆 app 与后端的唯一接口层。
 *
 * 全部命令都在 src-tauri/src/library.rs，2026-11-04 新增的那一组以
 * `library_list_collections` 打头。老的 `library_query_books` 仍在给媒体库弹窗
 * 用，不要混着调 —— 那个只认 kind / search 两个参数，这里需要的是结构化过滤。
 */
import { invoke } from "@tauri-apps/api/core";

// =============== 类型（与后端 serde 输出一一对应，注意是 snake_case） ===============

export interface LibraryEntry {
  id: string;
  item_id: string;
  kind: string;
  title: string;
  path: string;
  author: string | null;
  series: string | null;
  series_index: number | null;
  publisher: string | null;
  publish_year: number | null;
  isbn: string | null;
  tags: string[];
  rating: number | null;
  description: string | null;
  cover_url: string | null;
  added_at: number;
  last_read_at: number | null;
  read_progress: number | null;
  collections: string[];
  favorite: boolean;
  format: string | null;
  file_size: number;
  modified_at: number;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: number;
  sort: number;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface CollectionCount {
  collection: Collection;
  count: number;
}

export interface LibraryFacets {
  total: number;
  unread: number;
  reading: number;
  finished: number;
  favorites: number;
  authors: FacetValue[];
  publishers: FacetValue[];
  years: FacetValue[];
  series: FacetValue[];
  tags: FacetValue[];
  formats: FacetValue[];
  collections: CollectionCount[];
}

export interface LibraryFilter {
  search?: string;
  collectionId?: string;
  author?: string;
  publisher?: string;
  year?: string;
  series?: string;
  tag?: string;
  format?: string;
  status?: string;
  favoritesOnly?: boolean;
  sort?: string;
}

export interface EntryMetaPatch {
  title?: string;
  author?: string;
  publisher?: string;
  publishYear?: number;
  series?: string;
  seriesIndex?: number;
  tags?: string[];
  rating?: number;
  description?: string;
}

// =============== 命令封装 ===============

export const libraryApi = {
  facets: () => invoke<LibraryFacets>("library_facets"),

  query: (filter: LibraryFilter) => invoke<LibraryEntry[]>("library_query", { filter }),

  listCollections: () => invoke<Collection[]>("library_list_collections"),

  createCollection: (name: string, description?: string, color?: string) =>
    invoke<Collection>("library_create_collection", { name, description, color }),

  updateCollection: (
    id: string,
    patch: { name?: string; description?: string; color?: string },
  ) => invoke<void>("library_update_collection", { id, ...patch }),

  deleteCollection: (id: string) => invoke<void>("library_delete_collection", { id }),

  addPathsToCollection: (paths: string[], collectionId: string) =>
    invoke<number>("library_add_paths_to_collection", { paths, collectionId }),

  removeFromCollection: (ids: string[], collectionId: string) =>
    invoke<void>("library_remove_from_collection", { ids, collectionId }),

  removeEntry: (id: string) => invoke<void>("library_remove_entry", { id }),

  toggleFavorite: (id: string) => invoke<boolean>("library_toggle_entry_favorite", { id }),

  setReadStatus: (id: string, status: "unread" | "reading" | "finished") =>
    invoke<void>("library_set_read_status", { id, status }),

  /** 阅读器回写进度（0..1）。后端会把 0 收敛成 0.01，避免被判回「未读」 */
  setReadProgress: (id: string, progress: number) =>
    invoke<void>("library_set_read_progress", { id, progress }),

  updateMeta: (id: string, patch: EntryMetaPatch) =>
    invoke<void>("library_update_entry_meta", { id, patch }),

  enrichMetadata: (limit?: number) => invoke<number>("library_enrich_metadata", { limit }),

  scanBooks: () => invoke<unknown>("library_scan_books"),

  addScanDir: (dir: string) => invoke<void>("library_add_scan_dir", { dir }),

  stats: () => invoke<{ total_media: number; total_library: number; scan_dirs: string[] }>(
    "library_stats",
  ),
};
