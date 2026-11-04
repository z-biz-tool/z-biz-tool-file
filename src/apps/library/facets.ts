/**
 * 图书馆的纯逻辑：状态判定、阅读器分派、侧栏导航构建。
 *
 * 抽出来是因为这几段都有边界条件（进度 0.99 / 0.01、系列内排序、空维度的去留），
 * 埋在 JSX 里就只能靠肉眼点界面验。测试在 tests/libraryFacets.test.ts。
 */
import type {
  Collection,
  FacetValue,
  LibraryEntry,
  LibraryFacets,
  LibraryFilter,
} from "./libraryClient";

export type ReadStatus = "unread" | "reading" | "finished";

/** 0.99 以上算读完：EPUB 的分章进度很难正好落到 1.0，卡在 0.997 的书不该永远显示「在读」 */
export const FINISHED_THRESHOLD = 0.99;

export function readStatusOf(entry: Pick<LibraryEntry, "read_progress">): ReadStatus {
  const p = entry.read_progress ?? 0;
  if (p >= FINISHED_THRESHOLD) return "finished";
  if (p > 0) return "reading";
  return "unread";
}

export const STATUS_LABEL: Record<ReadStatus, string> = {
  unread: "未读",
  reading: "在读",
  finished: "已读",
};

/** 右侧面板用哪个阅读器。返回 null 表示这个格式在应用内读不了，交给系统打开。 */
export type ReaderKind = "pdf" | "book" | "comic" | "image" | "text" | null;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "avif"]);

/**
 * 走同一个翻页阅读器的所有格式。
 *
 * 后端 `parse_ebook` 把它们统一解析成「章节数组 + HTML」，所以前端不必按格式
 * 分支 —— 新增一种书只要后端能产出章节，这里加个扩展名就行。
 * TXT 也在这一档：`<pre>` 那种等宽纯文本不是「读书」的形态，分章分页才对。
 */
const BOOK_EXT = new Set([
  "epub",
  "mobi",
  "azw",
  "azw3",
  "prc",
  "fb2",
  "txt",
  // 部分下载工具会把 epub 存成 .epub3
  "epub3",
]);

/** 图片序列（漫画）。CBZ 是 zip，能解；CBR 是 rar，没有解码库，走外部打开。 */
const COMIC_EXT = new Set(["cbz"]);

/** 代码/结构化文本：这些用等宽字体原样显示比「排版成书」更合适 */
const TEXT_EXT = new Set(["md", "markdown", "log", "json", "csv", "tsv", "yaml", "yml", "xml"]);

export function resolveReaderKind(entry: Pick<LibraryEntry, "path" | "format">): ReaderKind {
  // 以扩展名为准而不是 format 字段：format 是扫描时算的快照，
  // 用户在 Finder 里把 .txt 改成 .epub 之后它会过期，而 path 永远是当前事实。
  const ext = extOf(entry.path);
  if (ext === "pdf") return "pdf";
  if (BOOK_EXT.has(ext)) return "book";
  if (COMIC_EXT.has(ext)) return "comic";
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return null;
}

export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 侧栏「格式」那一档显示的名字，大写好看一点（PDF / EPUB / MOBI） */
export function formatLabel(entry: Pick<LibraryEntry, "path" | "format">): string {
  const f = entry.format || extOf(entry.path);
  return f ? f.toUpperCase() : "未知";
}

// =============== 侧栏导航 ===============

/**
 * 一个归纳维度。side 决定点它时写进 filter 的哪个字段。
 *
 * `keepEmpty` 的维度（状态 / 收藏 / 图书集）即使计数为 0 也要显示 ——
 * 它们是「功能入口」，藏起来用户就再也找不到「已读」这一档；
 * 而作者 / 出版社这类是「数据长出来的」，没有就是没有，留着空标题只是噪音。
 */
export interface FacetSection {
  key: string;
  title: string;
  field: "author" | "publisher" | "year" | "series" | "tag" | "format";
  values: FacetValue[];
  keepEmpty: boolean;
}

export function buildFacetSections(facets: LibraryFacets): FacetSection[] {
  const sections: FacetSection[] = [
    { key: "authors", title: "作者", field: "author", values: facets.authors, keepEmpty: false },
    { key: "series", title: "系列", field: "series", values: facets.series, keepEmpty: false },
    { key: "publishers", title: "出版社", field: "publisher", values: facets.publishers, keepEmpty: false },
    { key: "years", title: "年份", field: "year", values: facets.years, keepEmpty: false },
    { key: "tags", title: "标签", field: "tag", values: facets.tags, keepEmpty: false },
    { key: "formats", title: "格式", field: "format", values: facets.formats, keepEmpty: false },
  ];
  return sections.filter((s) => s.keepEmpty || s.values.length > 0);
}

/**
 * 同一系列的书排在一起、集内按 series_index 升序；没有系列的书留在原位后面。
 *
 * 只给「按系列浏览」用，主列表不调它 —— 主列表用户自己选排序方式。
 */
export function groupBySeries(entries: LibraryEntry[]): Array<{
  series: string | null;
  items: LibraryEntry[];
}> {
  const groups = new Map<string, LibraryEntry[]>();
  const loose: LibraryEntry[] = [];
  for (const e of entries) {
    const s = e.series?.trim();
    if (!s) {
      loose.push(e);
      continue;
    }
    const list = groups.get(s) ?? [];
    list.push(e);
    groups.set(s, list);
  }
  const out: Array<{ series: string | null; items: LibraryEntry[] }> = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "zh"))
    .map(([series, items]) => ({
      series,
      items: items.sort((a, b) => {
        // 没有卷号的一律排到有卷号的后面：否则卷 1/2/3 中间会插进一本 None
        const ai = a.series_index;
        const bi = b.series_index;
        if (ai == null && bi == null) return a.title.localeCompare(b.title, "zh");
        if (ai == null) return 1;
        if (bi == null) return -1;
        return ai - bi;
      }),
    }));
  if (loose.length > 0) {
    out.push({ series: null, items: loose.sort((a, b) => a.title.localeCompare(b.title, "zh")) });
  }
  return out;
}

// =============== 展示辅助 ===============

/** 「12.3 MB」；0 字节的文件不少见（同步占位），显示成 0 B 而不是负数 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function progressText(entry: Pick<LibraryEntry, "read_progress">): string {
  const p = entry.read_progress ?? 0;
  if (p <= 0) return "未开始";
  if (p >= FINISHED_THRESHOLD) return "已读完";
  return `${Math.round(p * 100)}%`;
}

/**
 * 侧栏当前停在哪一格。做成一个判别联合而不是「一堆可选字段的 filter」：
 * 后者允许「同时选中两个作者」这种非法状态，而侧栏本来就是单选的。
 */
export type LibraryView =
  | { kind: "all" }
  | { kind: "status"; value: ReadStatus }
  | { kind: "favorites" }
  | { kind: "collection"; id: string }
  | { kind: "facet"; field: FacetSection["field"]; value: string };

export function viewKey(view: LibraryView): string {
  switch (view.kind) {
    case "all":
      return "all";
    case "status":
      return `status:${view.value}`;
    case "favorites":
      return "favorites";
    case "collection":
      return `collection:${view.id}`;
    case "facet":
      return `facet:${view.field}:${view.value}`;
  }
}

/** 浏览位置 + 排序 + 搜索 → 后端 library_query 的 filter */
export function viewToFilter(
  view: LibraryView,
  opts: { search?: string; sort?: string } = {},
): LibraryFilter {
  const f: LibraryFilter = {};
  if (opts.search?.trim()) f.search = opts.search.trim();
  if (opts.sort) f.sort = opts.sort;
  switch (view.kind) {
    case "all":
      break;
    case "status":
      f.status = view.value;
      break;
    case "favorites":
      f.favoritesOnly = true;
      break;
    case "collection":
      f.collectionId = view.id;
      break;
    case "facet":
      f[view.field] = view.value;
      break;
  }
  return f;
}

export function viewTitle(view: LibraryView, collections: Collection[] = []): string {
  switch (view.kind) {
    case "all":
      return "全部图书";
    case "status":
      return STATUS_LABEL[view.value];
    case "favorites":
      return "收藏";
    case "collection":
      return collections.find((c) => c.id === view.id)?.name ?? "图书集";
    case "facet": {
      const prefix: Record<FacetSection["field"], string> = {
        author: "作者",
        publisher: "出版社",
        year: "年份",
        series: "系列",
        tag: "标签",
        format: "格式",
      };
      return `${prefix[view.field]} · ${view.value}`;
    }
  }
}
