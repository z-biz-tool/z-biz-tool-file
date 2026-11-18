// 知识库板块的后端命令封装与类型（与 kb_app 的 Rust 结构一一对应）。
import { invoke } from "@tauri-apps/api/core";

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string | null;
  created_at: number;
  updated_at: number;
}

export interface KbSummary extends KnowledgeBase {
  material_count: number;
  parsed_count: number;
}

export interface KbCategory {
  id: string;
  kb_id: string;
  parent_id?: string | null;
  name: string;
  sort_no: number;
  /** 绑定的本地文件夹（绝对路径），有值时目录可「同步此目录」 */
  local_path?: string | null;
  created_at: number;
}

export interface YuqueRef {
  namespace: string;
  slug: string;
  url: string;
}

export interface KbMaterial {
  id: string;
  kb_id: string;
  category_id?: string | null;
  title: string;
  ext?: string | null;
  size_bytes: number;
  source_type: "local" | "yuque" | "text";
  fingerprint: string;
  version_no: number;
  parse_status: "pending" | "parsing" | "parsed" | "failed";
  parse_error?: string | null;
  parsed_at?: number | null;
  parser_name?: string | null;
  original_path?: string | null;
  yuque?: YuqueRef | null;
  registered_at: number;
  updated_at: number;
}

export interface MaterialDetail extends KbMaterial {
  draft?: string | null;
  category_path: string[];
}

export interface SkippedItem {
  path: string;
  reason: string;
}

export interface ImportReport {
  registered: KbMaterial[];
  skipped: SkippedItem[];
}

export interface YuqueRepo {
  namespace: string;
  name: string;
  scope: string;
}

export interface YuqueTocItem {
  uuid: string;
  parent_uuid: string;
  kind: "TITLE" | "DOC" | "LINK" | string;
  title: string;
  url: string;
}

export interface SearchHit {
  material_id: string;
  title: string;
  category_path: string[];
  snippet: string;
  score: number;
}

export interface Citation {
  path: string;
  title: string;
  heading: string;
  anchor: string;
  text: string;
  score: number;
  no: number;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
}

export interface KbConfigView {
  mineru_base_url?: string | null;
  yuque_api_base?: string | null;
  yuque_token_set: boolean;
}

// ── 命令封装（Tauri 参数 camelCase → Rust snake_case）──

/** 重 IO 命令的上限：超时要报错，不能让界面永远转圈。 */
const CMD_TIMEOUT_MS = 120_000;

async function invokeWithTimeout<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoke<T>(cmd, args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${cmd} 执行超时，请刷新后查看结果`)),
          CMD_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const kbBaseList = () => invoke<KbSummary[]>("kb_base_list");

export const kbBaseCreate = (input: { name: string; description?: string }) =>
  invoke<KbSummary>("kb_base_create", { input });

export const kbBaseRename = (kbId: string, name: string, description?: string | null) =>
  invoke<KbSummary>("kb_base_rename", { kbId, name, description: description ?? undefined });

export const kbBaseDelete = (kbId: string) => invoke<void>("kb_base_delete", { kbId });

export const kbCategoryTree = (kbId: string) =>
  invoke<KbCategory[]>("kb_category_tree", { kbId });

export const kbCategoryCreate = (input: {
  kbId: string;
  parentId?: string | null;
  name: string;
}) => invoke<KbCategory>("kb_category_create", { input });

export const kbCategoryRename = (categoryId: string, name: string) =>
  invoke<void>("kb_category_rename", { categoryId, name });

export const kbCategoryDelete = (kbId: string, categoryId: string) =>
  invoke<void>("kb_category_delete", { kbId, categoryId });

/** 把目录绑定到本地文件夹（绝对路径），之后可增量同步。 */
export const kbCategoryBindLocal = (categoryId: string, localPath: string) =>
  invoke<void>("kb_category_bind_local", { categoryId, localPath });

export const kbCategoryUnbindLocal = (categoryId: string) =>
  invoke<void>("kb_category_unbind_local", { categoryId });

export interface SyncReport {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
}

export const kbSyncLocalDir = (categoryId: string) =>
  invoke<SyncReport>("kb_sync_local_dir", { categoryId });

export const kbMaterialList = (kbId: string) =>
  invoke<KbMaterial[]>("kb_material_list", { kbId });

export const kbMaterialDetail = (materialId: string) =>
  invoke<MaterialDetail>("kb_material_detail", { materialId });

export const kbMaterialMove = (materialId: string, categoryId?: string | null) =>
  invoke<void>("kb_material_move", { materialId, categoryId: categoryId ?? undefined });

export const kbMaterialDelete = (materialId: string) =>
  invoke<void>("kb_material_delete", { materialId });

export const kbImportLocal = (input: {
  kbId: string;
  categoryId?: string | null;
  paths: string[];
}) => invokeWithTimeout<ImportReport>("kb_import_local", { input });

export const kbRegisterText = (input: {
  kbId: string;
  categoryId?: string | null;
  title: string;
  content: string;
}) => invoke<KbMaterial>("kb_register_text", { input });

export const kbParse = (materialId: string) => invoke<void>("kb_parse", { materialId });

export const kbDraftSave = (materialId: string, content: string) =>
  invoke<void>("kb_draft_save", { materialId, content });

export const kbSearch = (kbId: string, query: string, topK?: number) =>
  invoke<SearchHit[]>("kb_search", { kbId, query, topK });

export const kbAsk = (kbId: string, question: string) =>
  invoke<AskResult>("kb_ask", { kbId, question });

export const kbConfigGet = () => invoke<KbConfigView>("kb_config_get");

export const kbConfigSet = (input: {
  mineruBaseUrl?: string | null;
  yuqueApiBase?: string | null;
  yuqueToken?: string | null;
}) => invoke<KbConfigView>("kb_config_set", { input });

export const kbYuqueTest = () =>
  invoke<{ login: string; name: string }>("kb_yuque_test");

export const kbYuqueRepos = () => invoke<YuqueRepo[]>("kb_yuque_repos");

export const kbYuqueToc = (namespace: string) =>
  invoke<YuqueTocItem[]>("kb_yuque_toc", { namespace });

export const kbYuqueImport = (
  kbId: string,
  categoryId: string | null,
  docs: { namespace: string; slug: string; title?: string }[],
) =>
  invoke<ImportReport>("kb_yuque_import", {
    kbId,
    categoryId: categoryId ?? undefined,
    docs,
  });

export const kbOpenOriginal = (materialId: string) =>
  invoke<void>("kb_open_original", { materialId });

export const kbRevealOriginal = (materialId: string) =>
  invoke<void>("kb_reveal_original", { materialId });

// ── 本体（认知 → 本体）──

export interface OntProperty {
  name: string;
  display_name: string;
  data_type: "text" | "number" | "date" | "bool" | string;
  nullable: boolean;
}

export interface OntType {
  id: string;
  name: string;
  display_name: string;
  category: string;
  properties: OntProperty[];
  created_at: number;
  updated_at: number;
  instance_count: number;
}

export interface OntEdge {
  id: string;
  name: string;
  display_name: string;
  src_type: string;
  dst_type: string;
  properties: OntProperty[];
}

export interface OntInstance {
  id: string;
  type_id: string;
  name: string;
  properties: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface OntOverview {
  types: OntType[];
  edges: OntEdge[];
  instance_total: number;
  link_total: number;
  layout: Record<string, number[]>;
}

export interface OntInstancePage {
  total: number;
  items: OntInstance[];
}

export interface OntLinkView {
  id: string;
  edge_id: string;
  edge_name: string;
  src_id: string;
  dst_id: string;
  src_name: string;
  dst_name: string;
  properties: Record<string, unknown>;
}

export interface OntGraphNode {
  id: string;
  type_id: string;
  type_name: string;
  name: string;
}

export interface OntGraphEdgeView {
  id: string;
  edge_name: string;
  src_id: string;
  dst_id: string;
}

export interface OntNeighbors {
  nodes: OntGraphNode[];
  edges: OntGraphEdgeView[];
}

export const ontoOverview = () => invoke<OntOverview>("onto_overview");

export const ontoTypeSave = (input: {
  id?: string | null;
  name: string;
  displayName?: string;
  category?: string;
}) => invoke<OntType>("onto_type_save", { input });

export const ontoTypeDelete = (typeId: string) =>
  invoke<void>("onto_type_delete", { typeId });

export const ontoEdgeSave = (input: {
  id?: string | null;
  name: string;
  displayName?: string;
  srcType: string;
  dstType: string;
}) => invoke<OntEdge>("onto_edge_save", { input });

export const ontoEdgeDelete = (edgeId: string) =>
  invoke<void>("onto_edge_delete", { edgeId });

export const ontoPropertySet = (input: {
  owner: "type" | "edge";
  ownerId: string;
  name: string;
  displayName?: string;
  dataType?: string;
  nullable?: boolean;
}) => invoke<void>("onto_property_set", { input });

export const ontoPropertyDelete = (
  owner: "type" | "edge",
  ownerId: string,
  name: string,
) => invoke<void>("onto_property_delete", { owner, ownerId, name });

export const ontoInstanceSave = (input: {
  id?: string | null;
  typeId: string;
  name: string;
  properties: Record<string, unknown>;
}) => invoke<OntInstance>("onto_instance_save", { input });

export const ontoInstanceDelete = (instanceId: string) =>
  invoke<void>("onto_instance_delete", { instanceId });

export const ontoInstanceList = (
  typeId: string,
  keyword?: string,
  page?: number,
  pageSize?: number,
) =>
  invoke<OntInstancePage>("onto_instance_list", {
    typeId,
    keyword: keyword || undefined,
    page,
    pageSize,
  });

export const ontoLinkSave = (input: {
  id?: string | null;
  edgeId: string;
  srcId: string;
  dstId: string;
}) => invoke<OntLinkView>("onto_link_save", { input });

export const ontoLinkDelete = (linkId: string) =>
  invoke<void>("onto_link_delete", { linkId });

export const ontoLinksOf = (instanceId: string) =>
  invoke<OntLinkView[]>("onto_links_of", { instanceId });

export const ontoNeighbors = (instanceId: string, hops?: number) =>
  invoke<OntNeighbors>("onto_neighbors", { instanceId, hops });

export const ontoSearch = (keyword: string, limit?: number) =>
  invoke<OntGraphNode[]>("onto_search", { keyword, limit });

export const ontoLayoutSave = (positions: Record<string, number[]>) =>
  invoke<void>("onto_layout_save", { positions });
