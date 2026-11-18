// 资料/目录混排树的模型层（移植自 fe_future-brain 的 mix-entry-model.ts）：
// 类型推导（扩展名 → 条目类型）、状态徽标口径、目录树组装与平铺。
import type { KbCategory, KbMaterial } from "./api";

export type EntryType =
  | "document"
  | "table"
  | "image"
  | "audio"
  | "video"
  | "web"
  | "code"
  | "json";

export const ENTRY_TYPE_META: Record<EntryType, { label: string }> = {
  document: { label: "文档" },
  table: { label: "表格" },
  image: { label: "图片" },
  audio: { label: "音频" },
  video: { label: "视频" },
  web: { label: "网页" },
  code: { label: "代码" },
  json: { label: "接口数据" },
};

export type EntryState = "parsed" | "parsing" | "queued" | "failed";

/** 状态徽标口径与 future-brain 一致：绿/蓝/灰/红。 */
export const ENTRY_STATE_META: Record<EntryState, { label: string; color: string }> = {
  parsed: { label: "已解析", color: "green" },
  parsing: { label: "解析中", color: "blue" },
  queued: { label: "待解析", color: "default" },
  failed: { label: "解析失败", color: "red" },
};

const EXT_TYPE_MAP: Record<string, EntryType> = {
  xlsx: "table",
  xls: "table",
  xlsm: "table",
  csv: "table",
  tsv: "table",
  ods: "table",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  tif: "image",
  tiff: "image",
  ico: "image",
  heic: "image",
  avif: "image",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  ogg: "audio",
  wma: "audio",
  amr: "audio",
  mp4: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  webm: "video",
  flv: "video",
  wmv: "video",
  m4v: "video",
  html: "web",
  htm: "web",
  mhtml: "web",
  mht: "web",
  json: "json",
  jsonl: "json",
  ndjson: "json",
  py: "code",
  java: "code",
  js: "code",
  jsx: "code",
  ts: "code",
  tsx: "code",
  go: "code",
  rs: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  rb: "code",
  php: "code",
  sh: "code",
  bash: "code",
  sql: "code",
  yaml: "code",
  yml: "code",
  xml: "code",
  toml: "code",
  kt: "code",
  swift: "code",
  scala: "code",
  lua: "code",
  css: "code",
  scss: "code",
  less: "code",
  vue: "code",
  svelte: "code",
};

export function normalizeExt(ext?: string | null): string {
  return (ext || "").toLowerCase().replace(/^\./, "");
}

export function deriveEntryType(material: Pick<KbMaterial, "ext">): EntryType {
  return EXT_TYPE_MAP[normalizeExt(material.ext)] || "document";
}

export function deriveEntryState(parseStatus?: string): EntryState {
  if (parseStatus === "parsed") return "parsed";
  if (parseStatus === "parsing") return "parsing";
  if (parseStatus === "failed") return "failed";
  return "queued";
}

export const SOURCE_TYPE_LABEL: Record<string, string> = {
  local: "本地上传",
  text: "文本登记",
  yuque: "语雀",
};

const PARSER_LABEL: Record<string, string> = {
  mineru: "MinerU",
  "cap-doc": "文本层兜底",
  text: "文本直读",
  "manual-edit": "人工编辑",
  yuque: "语雀同步",
};

export function parserLabel(name?: string | null): string {
  if (!name) return "—";
  return PARSER_LABEL[name] || name;
}

export interface TreeEntry {
  material: KbMaterial;
  type: EntryType;
  state: EntryState;
}

export interface TreeNode {
  category: KbCategory;
  children: TreeNode[];
  entries: TreeEntry[];
  count: number;
}

export interface TreeModel {
  roots: TreeNode[];
  /** 没有挂在任何目录上的条目（未分类） */
  unclassified: TreeEntry[];
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries
    .slice()
    .sort((a, b) => a.material.title.localeCompare(b.material.title, "zh-Hans-CN"));
}

/** 组装目录 + 条目混排树。目录按创建序，条目按标题序（与 future-brain 同口径）。 */
export function buildTree(categories: KbCategory[], materials: KbMaterial[]): TreeModel {
  const byCategory = new Map<string, KbMaterial[]>();
  const unclassifiedRaw: KbMaterial[] = [];
  const known = new Set(categories.map((c) => c.id));
  for (const material of materials) {
    const key = material.category_id && known.has(material.category_id) ? material.category_id : "";
    if (!key) {
      unclassifiedRaw.push(material);
      continue;
    }
    const list = byCategory.get(key) || [];
    list.push(material);
    byCategory.set(key, list);
  }

  const byId = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const category of categories) {
    byId.set(category.id, { category, children: [], entries: [], count: 0 });
  }
  for (const category of categories) {
    const node = byId.get(category.id)!;
    if (category.parent_id && byId.has(category.parent_id)) {
      byId.get(category.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const fill = (node: TreeNode): number => {
    const own = byCategory.get(node.category.id) || [];
    node.entries = sortEntries(
      own.map((material) => ({
        material,
        type: deriveEntryType(material),
        state: deriveEntryState(material.parse_status),
      })),
    );
    node.count = node.entries.length + node.children.reduce((sum, c) => sum + fill(c), 0);
    return node.count;
  };
  roots.forEach(fill);

  return {
    roots,
    unclassified: sortEntries(
      unclassifiedRaw.map((material) => ({
        material,
        type: deriveEntryType(material),
        state: deriveEntryState(material.parse_status),
      })),
    ),
  };
}

export function collectCategoryIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => [n.category.id, ...collectCategoryIds(n.children)]);
}

/** TreeSelect/下拉用的目录选项（带层级路径名）。 */
export function flattenFolders(
  nodes: TreeNode[],
  trail: string[] = [],
): { id: string; name: string; path: string[] }[] {
  return nodes.flatMap((node) => {
    const path = [...trail, node.category.name];
    return [
      { id: node.category.id, name: node.category.name, path },
      ...flattenFolders(node.children, path),
    ];
  });
}

export function formatSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatTime(ts?: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
