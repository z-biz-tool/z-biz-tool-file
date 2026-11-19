//! 知识库板块的命令层：库/目录/物料的 CRUD、导入、解析、检索、问答、
//! 配置与语雀接入。
//!
//! 命令分两档（对应 project-z-biz-tool-sqlite-and-ipc-hazards 的教训）：
//! - **重 IO / 网络**（导入、解析、语雀拉取、检索建索引）：`async fn` +
//!   `spawn_blocking`，绝不占 IPC 主线程；
//! - **轻元数据读写**（库/目录/物料小改）：同步直做，与 glossary_app 同口径。
//!
//! 解析是后台任务：命令只把状态翻成 parsing 就返回，前端轮询
//! `kb_material_list` 看进度 —— 与 future-brain 的异步任务模型一致。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::kb_app::parse;
use crate::kb_app::search;
use crate::kb_app::secret;
use crate::kb_app::store::{
    self, KbCategory, KbIndex, KbMaterial, KnowledgeBase, YuqueRef, STATUS_FAILED, STATUS_PARSED,
    STATUS_PARSING, STATUS_PENDING,
};
use crate::kb_app::yuque::{YuqueClient, YuqueRepo, YuqueTocItem};
use crate::kb_app::KbState;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ── 视图 ──

#[derive(Serialize)]
pub struct KbSummary {
    #[serde(flatten)]
    pub base: KnowledgeBase,
    pub material_count: usize,
    pub parsed_count: usize,
}

fn summarize(index: &KbIndex, base: &KnowledgeBase) -> KbSummary {
    let materials = index.materials_of(&base.id);
    let parsed_count = materials
        .iter()
        .filter(|m| m.parse_status == STATUS_PARSED)
        .count();
    KbSummary {
        base: base.clone(),
        material_count: materials.len(),
        parsed_count,
    }
}

/// 条目详情：物料元数据 + 当前解析稿全文 + 目录路径。
#[derive(Serialize)]
pub struct MaterialDetail {
    #[serde(flatten)]
    pub material: KbMaterial,
    pub draft: Option<String>,
    pub category_path: Vec<String>,
}

#[derive(Serialize)]
pub struct SkippedItem {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct ImportReport {
    pub registered: Vec<KbMaterial>,
    pub skipped: Vec<SkippedItem>,
}

#[derive(Deserialize)]
pub struct BaseCreateInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

// ── 知识库 CRUD ──

#[tauri::command]
pub fn kb_base_list(state: State<'_, KbState>) -> Result<Vec<KbSummary>, String> {
    let index = state.0.lock().unwrap();
    let mut bases = index.bases.clone();
    bases.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    Ok(bases.iter().map(|b| summarize(&index, b)).collect())
}

#[tauri::command]
pub fn kb_base_create(
    state: State<'_, KbState>,
    input: BaseCreateInput,
) -> Result<KbSummary, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("知识库名称不能为空".to_string());
    }
    let now = now_ms();
    let base = KnowledgeBase {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        description: input.description.filter(|s| !s.trim().is_empty()),
        created_at: now,
        updated_at: now,
    };
    let mut index = state.0.lock().unwrap();
    if index.bases.iter().any(|b| b.name == base.name) {
        return Err(format!("已存在同名知识库「{}」", base.name));
    }
    index.bases.push(base.clone());
    store::save_index(&index)?;
    Ok(summarize(&index, &base))
}

#[tauri::command]
pub fn kb_base_rename(
    state: State<'_, KbState>,
    kb_id: String,
    name: String,
    description: Option<String>,
) -> Result<KbSummary, String> {
    let name = name.trim().to_string();
    let mut index = state.0.lock().unwrap();
    if !index.bases.iter().any(|b| b.id == kb_id) {
        return Err("知识库不存在".to_string());
    }
    if name.is_empty() {
        return Err("知识库名称不能为空".to_string());
    }
    if index.bases.iter().any(|b| b.id != kb_id && b.name == name) {
        return Err(format!("已存在同名知识库「{}」", name));
    }
    let base = index
        .bases
        .iter_mut()
        .find(|b| b.id == kb_id)
        .ok_or_else(|| "知识库不存在".to_string())?;
    base.name = name;
    base.description = description.filter(|s| !s.trim().is_empty());
    base.updated_at = now_ms();
    let snapshot = base.clone();
    store::save_index(&index)?;
    Ok(summarize(&index, &snapshot))
}

/// 删除知识库：连同目录、物料索引和已拷入的原件/解析稿一起清掉。
/// 重 IO（文件数可能上千），放后台线程。
#[tauri::command]
pub async fn kb_base_delete(app: AppHandle, kb_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KbState>();
        let mut index = state.0.lock().unwrap();
        if index.base(&kb_id).is_none() {
            return Err("知识库不存在".to_string());
        }
        let material_ids: Vec<String> = index
            .materials
            .iter()
            .filter(|m| m.kb_id == kb_id)
            .map(|m| m.id.clone())
            .collect();
        for id in &material_ids {
            if let Some(mat) = index.material(id) {
                if let Some(original) = &mat.original_path {
                    let _ = std::fs::remove_file(original);
                }
                let _ = std::fs::remove_file(store::draft_path(id));
            }
        }
        index.materials.retain(|m| m.kb_id != kb_id);
        index.categories.retain(|c| c.kb_id != kb_id);
        index.bases.retain(|b| b.id != kb_id);
        store::save_index(&index)
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

// ── 目录 ──

#[tauri::command]
pub fn kb_category_tree(
    state: State<'_, KbState>,
    kb_id: String,
) -> Result<Vec<KbCategory>, String> {
    let index = state.0.lock().unwrap();
    if index.base(&kb_id).is_none() {
        return Err("知识库不存在".to_string());
    }
    Ok(index.categories_of(&kb_id).into_iter().cloned().collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryCreateInput {
    pub kb_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub name: String,
}

#[tauri::command]
pub fn kb_category_create(
    state: State<'_, KbState>,
    input: CategoryCreateInput,
) -> Result<KbCategory, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("目录名不能为空".to_string());
    }
    let mut index = state.0.lock().unwrap();
    if index.base(&input.kb_id).is_none() {
        return Err("知识库不存在".to_string());
    }
    if let Some(parent) = &input.parent_id {
        if !index
            .categories
            .iter()
            .any(|c| c.id == *parent && c.kb_id == input.kb_id)
        {
            return Err("父目录不存在".to_string());
        }
    }
    let siblings = index
        .categories
        .iter()
        .filter(|c| c.kb_id == input.kb_id && c.parent_id == input.parent_id);
    if siblings.into_iter().any(|c| c.name == name) {
        return Err(format!("同级已存在同名目录「{}」", name));
    }
    let category = KbCategory {
        id: uuid::Uuid::new_v4().to_string(),
        kb_id: input.kb_id,
        parent_id: input.parent_id,
        name,
        sort_no: now_ms(),
        local_path: None,
        created_at: now_ms(),
    };
    let created = category.clone();
    index.categories.push(category);
    store::save_index(&index)?;
    Ok(created)
}

#[tauri::command]
pub fn kb_category_rename(
    state: State<'_, KbState>,
    category_id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("目录名不能为空".to_string());
    }
    let mut index = state.0.lock().unwrap();
    let category = index
        .categories
        .iter_mut()
        .find(|c| c.id == category_id)
        .ok_or_else(|| "目录不存在".to_string())?;
    category.name = name;
    store::save_index(&index)
}

/// 删除目录：子孙目录级联删除，其下物料降级为「未分类」（内容不丢）。
#[tauri::command]
pub fn kb_category_delete(
    state: State<'_, KbState>,
    kb_id: String,
    category_id: String,
) -> Result<(), String> {
    let mut index = state.0.lock().unwrap();
    let subtree = index.category_subtree_ids(&kb_id, &category_id);
    index
        .materials
        .iter_mut()
        .filter(|m| {
            m.kb_id == kb_id
                && m.category_id
                    .as_deref()
                    .map(|cid| subtree.iter().any(|s| s == cid))
                    .unwrap_or(false)
        })
        .for_each(|m| {
            m.category_id = None;
            m.updated_at = now_ms();
        });
    index.categories.retain(|c| !subtree.contains(&c.id));
    store::save_index(&index)
}

// ── 物料 ──

#[tauri::command]
pub fn kb_material_list(
    state: State<'_, KbState>,
    kb_id: String,
) -> Result<Vec<KbMaterial>, String> {
    let index = state.0.lock().unwrap();
    if index.base(&kb_id).is_none() {
        return Err("知识库不存在".to_string());
    }
    Ok(index.materials_of(&kb_id).into_iter().cloned().collect())
}

#[tauri::command]
pub fn kb_material_detail(
    state: State<'_, KbState>,
    material_id: String,
) -> Result<MaterialDetail, String> {
    let index = state.0.lock().unwrap();
    let mat = index
        .material(&material_id)
        .ok_or_else(|| "物料不存在".to_string())?
        .clone();
    let category_path = index.category_path(&mat.kb_id, mat.category_id.as_deref());
    let draft = std::fs::read_to_string(store::draft_path(&material_id)).ok();
    Ok(MaterialDetail {
        material: mat,
        draft,
        category_path,
    })
}

#[tauri::command]
pub fn kb_material_move(
    state: State<'_, KbState>,
    material_id: String,
    category_id: Option<String>,
) -> Result<(), String> {
    let mut index = state.0.lock().unwrap();
    // 先借不可变引用查物料归属，再拿可变引用改 —— 两段借用不能重叠。
    let kb_of = index
        .material(&material_id)
        .map(|m| m.kb_id.clone())
        .ok_or_else(|| "物料不存在".to_string())?;
    if let Some(cid) = &category_id {
        let belongs = index
            .categories
            .iter()
            .any(|c| c.id == *cid && c.kb_id == kb_of);
        if !belongs {
            return Err("目标目录不存在".to_string());
        }
    }
    let mat = index
        .material_mut(&material_id)
        .ok_or_else(|| "物料不存在".to_string())?;
    mat.category_id = category_id;
    mat.updated_at = now_ms();
    store::save_index(&index)
}

#[tauri::command]
pub fn kb_material_delete(state: State<'_, KbState>, material_id: String) -> Result<(), String> {
    let mut index = state.0.lock().unwrap();
    let mat = index
        .material(&material_id)
        .ok_or_else(|| "物料不存在".to_string())?
        .clone();
    if let Some(original) = &mat.original_path {
        let _ = std::fs::remove_file(original);
    }
    let _ = std::fs::remove_file(store::draft_path(&material_id));
    index.materials.retain(|m| m.id != material_id);
    store::save_index(&index)
}

/// 人工编辑解析稿：覆盖当前稿，parser_name 标记为 manual-edit。
#[tauri::command]
pub fn kb_draft_save(
    state: State<'_, KbState>,
    material_id: String,
    content: String,
) -> Result<(), String> {
    let mut index = state.0.lock().unwrap();
    let mat = index
        .material_mut(&material_id)
        .ok_or_else(|| "物料不存在".to_string())?;
    mat.parse_status = STATUS_PARSED.to_string();
    mat.parser_name = Some("manual-edit".to_string());
    mat.parsed_at = Some(now_ms());
    mat.updated_at = now_ms();
    let draft = store::draft_path(&material_id);
    store::ensure_dirs()?;
    crate::atomic_write::atomic_write(&draft, content.as_bytes())?;
    store::save_index(&index)
}

// ── 导入：本地文件/目录 ──

/// 目录导入时要跳过的噪音目录（隐藏目录、依赖目录）。
fn is_noise_dir(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "__pycache__" | "dist" | "build"
        )
}

/// 递归收集文件（带相对目录链，用于镜像目录结构到库内目录树）。
fn collect_files(
    path: &std::path::Path,
    rel_dirs: &[String],
    depth: usize,
    out: &mut Vec<(std::path::PathBuf, Vec<String>)>,
) -> Result<(), String> {
    if depth > 12 {
        return Err(format!("目录嵌套过深（>12 层）: {}", path.display()));
    }
    let meta =
        std::fs::metadata(path).map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
    if meta.is_file() {
        out.push((path.to_path_buf(), rel_dirs.to_vec()));
        return Ok(());
    }
    let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(path)
        .map_err(|e| format!("读取目录 {} 失败: {}", path.display(), e))?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let child = entry.path();
        if child.is_dir() {
            if is_noise_dir(&name) {
                continue;
            }
            let mut child_rel = rel_dirs.to_vec();
            child_rel.push(name);
            collect_files(&child, &child_rel, depth + 1, out)?;
        } else if !name.starts_with('.') {
            out.push((child, rel_dirs.to_vec()));
        }
    }
    Ok(())
}

/// 流式计算 SHA-256（不把整个文件读进内存）。
fn sha256_file(path: &std::path::Path) -> Result<(String, u64), String> {
    use sha2::Digest;
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("打开 {} 失败: {}", path.display(), e))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("读取 {} 元信息失败: {}", path.display(), e))?;
    if meta.len() > store::MAX_FILE_SIZE {
        return Err(format!("文件超过 100MB 上限（{} 字节）", meta.len()));
    }
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
    Ok((hex, meta.len()))
}

/// 在目录树下逐级建目录，同层同名复用（对应 future-brain 的 ensureCategoryPath）。
fn ensure_category_path(
    index: &mut KbIndex,
    kb_id: &str,
    base_id: Option<String>,
    dirs: &[String],
) -> Result<Option<String>, String> {
    let mut parent = base_id;
    for name in dirs {
        let existing = index
            .categories
            .iter()
            .find(|c| c.kb_id == kb_id && c.parent_id == parent && c.name == *name)
            .map(|c| c.id.clone());
        parent = Some(existing.unwrap_or_else(|| {
            let created = KbCategory {
                id: uuid::Uuid::new_v4().to_string(),
                kb_id: kb_id.to_string(),
                parent_id: parent.clone(),
                name: name.clone(),
                sort_no: now_ms(),
                local_path: None,
                created_at: now_ms(),
            };
            index.categories.push(created.clone());
            created.id
        }));
    }
    Ok(parent)
}

#[allow(clippy::too_many_arguments)] // 一条物料记录的字段，拆 struct 只是换一种写法
fn register_material(
    index: &mut KbIndex,
    kb_id: &str,
    category_id: Option<String>,
    title: String,
    ext: Option<String>,
    size_bytes: u64,
    source_type: &str,
    fingerprint: String,
    original_path: Option<String>,
    source_path: Option<String>,
    yuque: Option<YuqueRef>,
) -> KbMaterial {
    let now = now_ms();
    let mat = KbMaterial {
        id: uuid::Uuid::new_v4().to_string(),
        kb_id: kb_id.to_string(),
        category_id,
        title,
        ext,
        size_bytes,
        source_type: source_type.to_string(),
        fingerprint,
        version_no: 1,
        parse_status: STATUS_PENDING.to_string(),
        parse_error: None,
        parsed_at: None,
        parser_name: None,
        original_path,
        source_path,
        yuque,
        registered_at: now,
        updated_at: now,
    };
    index.materials.push(mat.clone());
    mat
}

fn ext_of(file_name: &str) -> Option<String> {
    std::path::Path::new(file_name)
        .extension()
        .map(|e| store::normalize_ext(&e.to_string_lossy()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLocalInput {
    pub kb_id: String,
    #[serde(default)]
    pub category_id: Option<String>,
    pub paths: Vec<String>,
}

/// 导入本地文件/目录：拷贝原件、指纹去重、目录结构镜像成库内目录，
/// 登记后逐个投后台解析。重 IO，走 spawn_blocking。
#[tauri::command]
pub async fn kb_import_local(
    app: AppHandle,
    input: ImportLocalInput,
) -> Result<ImportReport, String> {
    // 解析任务的 spawn 放到闭包外：闭包只负责登记/拷贝，
    // 尽早把结果交回前端，后台解析另行调度。
    let app_for_state = app.clone();
    let (report, to_parse) = tauri::async_runtime::spawn_blocking(move || {
        eprintln!("[kb_import] enter, paths={:?}", input.paths);
        let state = app_for_state.state::<KbState>();
        {
            let index = state.0.lock().unwrap();
            if index.base(&input.kb_id).is_none() {
                return Err("知识库不存在".to_string());
            }
            store::ensure_dirs()?;
        }
        eprintln!("[kb_import] precheck done");

        let mut files = Vec::new();
        for raw in &input.paths {
            let path = std::path::PathBuf::from(raw.trim());
            collect_files(&path, &[], 0, &mut files).map_err(|e| format!("收集文件失败: {}", e))?;
        }
        if files.is_empty() {
            return Err("没有找到可导入的文件".to_string());
        }

        let mut report = ImportReport {
            registered: vec![],
            skipped: vec![],
        };
        let mut to_parse: Vec<String> = vec![];

        for (path, rel_dirs) in files {
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "未命名".to_string());
            let title = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| file_name.clone());
            let ext = ext_of(&file_name);

            let (fingerprint, size) = match sha256_file(&path) {
                Ok(v) => v,
                Err(e) => {
                    report.skipped.push(SkippedItem {
                        path: file_name,
                        reason: e,
                    });
                    continue;
                }
            };

            // 每个文件一段完整的「锁内事务」：去重 → 镜像目录 → 登记 → 拷原件。
            // 拷贝失败就把刚登记的条目撤回，保证索引与磁盘一致。
            let mut index = state.0.lock().unwrap();
            if index.fingerprint_exists(&input.kb_id, &fingerprint) {
                report.skipped.push(SkippedItem {
                    path: file_name,
                    reason: "同内容文件已存在（指纹重复），已跳过".to_string(),
                });
                continue;
            }
            // 目标目录：所选目录下按相对路径镜像（future-brain 的目录上传同款行为）
            let category_id = ensure_category_path(
                &mut index,
                &input.kb_id,
                input.category_id.clone(),
                &rel_dirs,
            )?;
            let mut material = register_material(
                &mut index,
                &input.kb_id,
                category_id,
                title,
                ext,
                size,
                store::SOURCE_LOCAL,
                fingerprint,
                None,
                Some(path.to_string_lossy().to_string()),
                None,
            );
            // 原件拷入库内 originals/：库与源目录解耦，源文件后续改动不影响已登记版本
            let stored = store::originals_dir().join(format!(
                "{}{}",
                material.id,
                material
                    .ext
                    .as_deref()
                    .map(|e| format!(".{}", e))
                    .unwrap_or_default()
            ));
            if let Err(e) = std::fs::copy(&path, &stored) {
                index.materials.retain(|m| m.id != material.id);
                store::save_index(&index)?;
                report.skipped.push(SkippedItem {
                    path: file_name,
                    reason: format!("拷贝原件失败: {}", e),
                });
                continue;
            }
            material.original_path = Some(stored.to_string_lossy().to_string());
            if let Some(mat) = index.material_mut(&material.id) {
                mat.original_path = material.original_path.clone();
            }
            to_parse.push(material.id.clone());
            report.registered.push(material);
            drop(index);
        }

        store::save_index(&state.0.lock().unwrap())?;
        eprintln!("[kb_import] index saved, to_parse={:?}", to_parse);
        Ok::<_, String>((report, to_parse))
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))??;

    for id in to_parse {
        parse::spawn_parse(&app, id);
    }
    eprintln!("[kb_import] parse spawned, report returned");
    Ok(report)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterTextInput {
    pub kb_id: String,
    #[serde(default)]
    pub category_id: Option<String>,
    pub title: String,
    pub content: String,
}

/// 登记一段纯文本（笔记/剪藏）：原件与解析稿同体，直接是已解析态。
#[tauri::command]
pub fn kb_register_text(
    state: State<'_, KbState>,
    input: RegisterTextInput,
) -> Result<KbMaterial, String> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    if input.content.trim().is_empty() {
        return Err("内容不能为空".to_string());
    }
    store::ensure_dirs()?;
    let bytes = input.content.as_bytes().to_vec();
    let fingerprint = store::sha256_hex(&bytes);

    let mut index = state.0.lock().unwrap();
    if index.base(&input.kb_id).is_none() {
        return Err("知识库不存在".to_string());
    }
    if index.fingerprint_exists(&input.kb_id, &fingerprint) {
        return Err("同内容文本已存在（指纹重复）".to_string());
    }
    let mut material = register_material(
        &mut index,
        &input.kb_id,
        input.category_id,
        title,
        Some("md".to_string()),
        bytes.len() as u64,
        store::SOURCE_TEXT,
        fingerprint,
        None,
        None,
        None,
    );
    let original = store::originals_dir().join(format!("{}.md", material.id));
    crate::atomic_write::atomic_write(&original, &bytes)?;
    material.original_path = Some(original.to_string_lossy().to_string());
    if let Some(mat) = index.material_mut(&material.id) {
        mat.original_path = material.original_path.clone();
        mat.parse_status = STATUS_PARSED.to_string();
        mat.parser_name = Some("text".to_string());
        mat.parsed_at = Some(now_ms());
    }
    material.parse_status = STATUS_PARSED.to_string();
    material.parser_name = Some("text".to_string());
    parse::write_initial_draft(&material.id, &input.content)?;
    store::save_index(&index)?;
    Ok(material)
}

// ── 解析 ──

/// 触发（重新）解析：状态翻成 parsing 立即返回，后台任务完成后前端轮询可见。
#[tauri::command]
pub async fn kb_parse(app: AppHandle, material_id: String) -> Result<(), String> {
    {
        let state = app.state::<KbState>();
        let mut index = state.0.lock().unwrap();
        let mat = index
            .material_mut(&material_id)
            .ok_or_else(|| "物料不存在".to_string())?;
        if mat.parse_status == STATUS_PARSING {
            return Err("该物料正在解析中".to_string());
        }
        mat.parse_status = STATUS_PENDING.to_string();
        mat.parse_error = None;
        mat.updated_at = now_ms();
        store::save_index(&index)?;
    }
    parse::spawn_parse(&app, material_id);
    Ok(())
}

// ── 检索 / 问答 ──

#[tauri::command]
pub async fn kb_search(
    app: AppHandle,
    kb_id: String,
    query: String,
    top_k: Option<usize>,
) -> Result<Vec<search::SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KbState>();
        let index = state.0.lock().unwrap().clone();
        if index.base(&kb_id).is_none() {
            return Err("知识库不存在".to_string());
        }
        Ok(search::search(&index, &kb_id, &query, top_k.unwrap_or(10)))
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

#[derive(Serialize)]
pub struct AskResult {
    pub answer: String,
    pub citations: Vec<cap_glossary::Citation>,
}

/// 库内问答：BM25 取证据片段 → 拼引用 → cap-llm 生成答案。
/// 检索不到证据时直接给兜底话术，不调模型。
#[tauri::command]
pub async fn kb_ask(app: AppHandle, kb_id: String, question: String) -> Result<AskResult, String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("问题不能为空".to_string());
    }
    // ai_chat 还要用一次 AppHandle，先分身：本体进 spawn_blocking，分身留给模型调用。
    let app_for_chat = app.clone();
    let question_for_index = question.clone();
    let (citations, corpus_chunks) = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KbState>();
        let index = state.0.lock().unwrap().clone();
        if index.base(&kb_id).is_none() {
            return Err("知识库不存在".to_string());
        }
        Ok::<_, String>(search::citations_for_ask(
            &index,
            &kb_id,
            &question_for_index,
            cap_glossary::DEFAULT_TOP_K,
        ))
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))??;

    if citations.is_empty() {
        return Ok(AskResult {
            answer: cap_glossary::no_evidence_message(corpus_chunks, false),
            citations: vec![],
        });
    }
    let user = cap_glossary::build_user_message(&question, &citations);
    let system = "你是用户个人知识库的问答助手。用户会给你若干编号片段，\
        请只依据片段内容回答问题，并在关键结论后标注对应编号（如 [1]）。\
        片段不足以回答时直接说明知识库里没有相关内容，不要编造。"
        .to_string();
    let answer = crate::ai::ai_chat(app_for_chat, system, user).await?;
    Ok(AskResult { answer, citations })
}

// ── 配置 ──

#[derive(Serialize)]
pub struct KbConfigView {
    pub mineru_base_url: Option<String>,
    pub yuque_api_base: Option<String>,
    /// token 只回报「配没配」，明文永不回前端
    pub yuque_token_set: bool,
}

#[tauri::command]
pub fn kb_config_get() -> Result<KbConfigView, String> {
    let cfg = store::load_config();
    Ok(KbConfigView {
        mineru_base_url: cfg.mineru_base_url,
        yuque_api_base: cfg.yuque_api_base,
        yuque_token_set: secret::get_yuque_token().is_some(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSetInput {
    #[serde(default)]
    pub mineru_base_url: Option<String>,
    #[serde(default)]
    pub yuque_api_base: Option<String>,
    /// Some(非空) = 写入新 token；Some(空串) = 清除；None = 保持不变
    #[serde(default)]
    pub yuque_token: Option<String>,
}

#[tauri::command]
pub fn kb_config_set(input: ConfigSetInput) -> Result<KbConfigView, String> {
    let mut cfg = store::load_config();
    cfg.mineru_base_url = input
        .mineru_base_url
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty());
    cfg.yuque_api_base = input
        .yuque_api_base
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty());
    store::save_config(&cfg)?;
    match input.yuque_token {
        Some(token) if token.trim().is_empty() => secret::clear_yuque_token()?,
        Some(token) => secret::set_yuque_token(token.trim())?,
        None => {}
    }
    kb_config_get()
}

// ── 语雀接入 ──

fn yuque_client() -> Result<YuqueClient, String> {
    let token = secret::get_yuque_token()
        .ok_or_else(|| "尚未配置语雀 Token：请到「知识库 → 设置」填写个人访问令牌".to_string())?;
    let cfg = store::load_config();
    YuqueClient::new(cfg.yuque_api_base.as_deref(), &token)
}

#[derive(Serialize)]
pub struct YuqueUser {
    pub login: String,
    pub name: String,
}

#[tauri::command]
pub async fn kb_yuque_test() -> Result<YuqueUser, String> {
    let client = yuque_client()?;
    let (login, name) = client.current_user().await?;
    Ok(YuqueUser { login, name })
}

#[tauri::command]
pub async fn kb_yuque_repos() -> Result<Vec<YuqueRepo>, String> {
    let client = yuque_client()?;
    client.list_repos().await
}

#[tauri::command]
pub async fn kb_yuque_toc(namespace: String) -> Result<Vec<YuqueTocItem>, String> {
    let client = yuque_client()?;
    client.toc(&namespace).await
}

#[derive(Deserialize)]
pub struct YuqueDocInput {
    pub namespace: String,
    pub slug: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Serialize)]
pub struct YuqueImportReport {
    pub registered: Vec<KbMaterial>,
    pub skipped: Vec<SkippedItem>,
}

/// 导入语雀文档：先登记（pending），后台逐篇拉正文 → 原件/解析稿同体落盘 →
/// 已解析。逐篇串行 + 间隔，尊重语雀 API 限速。
#[tauri::command]
pub async fn kb_yuque_import(
    app: AppHandle,
    kb_id: String,
    category_id: Option<String>,
    docs: Vec<YuqueDocInput>,
) -> Result<YuqueImportReport, String> {
    let client = yuque_client()?;
    {
        let state = app.state::<KbState>();
        let index = state.0.lock().unwrap();
        if index.base(&kb_id).is_none() {
            return Err("知识库不存在".to_string());
        }
    }
    if docs.is_empty() {
        return Err("没有选择要导入的文档".to_string());
    }

    let mut report = YuqueImportReport {
        registered: vec![],
        skipped: vec![],
    };
    let mut queue: Vec<(String, String, String, String)> = vec![]; // (material_id, namespace, slug, title)
    {
        let state = app.state::<KbState>();
        let mut index = state.0.lock().unwrap();
        for doc in docs {
            let exists = index.materials.iter().any(|m| {
                m.kb_id == kb_id
                    && m.yuque
                        .as_ref()
                        .map(|y| y.namespace == doc.namespace && y.slug == doc.slug)
                        .unwrap_or(false)
            });
            if exists {
                report.skipped.push(SkippedItem {
                    path: doc.title.unwrap_or_else(|| doc.slug.clone()),
                    reason: "该语雀文档已在库中".to_string(),
                });
                continue;
            }
            let title = doc.title.clone().unwrap_or_else(|| doc.slug.clone());
            let fingerprint = store::sha256_hex(
                format!("yuque:{}/{}:pending", doc.namespace, doc.slug).as_bytes(),
            );
            let material = register_material(
                &mut index,
                &kb_id,
                category_id.clone(),
                title.clone(),
                Some("md".to_string()),
                0,
                store::SOURCE_YUQUE,
                fingerprint,
                None,
                None,
                Some(YuqueRef {
                    namespace: doc.namespace.clone(),
                    slug: doc.slug.clone(),
                    url: format!("https://www.yuque.com/{}/{}", doc.namespace, doc.slug),
                }),
            );
            report.registered.push(material.clone());
            queue.push((material.id, doc.namespace, doc.slug, title));
        }
        store::save_index(&index)?;
    }

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        for (material_id, namespace, slug, _title) in queue {
            let outcome = client.doc(&namespace, &slug).await;
            let now = now_ms();
            let state = app2.state::<KbState>();
            // 锁只在「更新 + 落盘」这一小段持有；块级作用域结束再 await，
            // 否则 MutexGuard 跨 await 会把整个 future 变成非 Send。
            {
                let mut index = state.0.lock().unwrap();
                match outcome {
                    Ok((fetched_title, body)) => {
                        let bytes = body.as_bytes().to_vec();
                        let fingerprint = store::sha256_hex(&bytes);
                        match parse::write_initial_draft(&material_id, &body) {
                            Ok(()) => {
                                if let Some(mat) = index.material_mut(&material_id) {
                                    mat.title = fetched_title;
                                    mat.parse_status = STATUS_PARSED.to_string();
                                    mat.parser_name = Some("yuque".to_string());
                                    mat.parsed_at = Some(now);
                                    mat.size_bytes = bytes.len() as u64;
                                    mat.fingerprint = fingerprint;
                                    mat.updated_at = now;
                                }
                            }
                            Err(e) => {
                                if let Some(mat) = index.material_mut(&material_id) {
                                    mat.parse_status = store::STATUS_FAILED.to_string();
                                    mat.parse_error = Some(format!("写解析稿失败: {}", e));
                                    mat.updated_at = now;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        if let Some(mat) = index.material_mut(&material_id) {
                            mat.parse_status = store::STATUS_FAILED.to_string();
                            mat.parse_error = Some(e);
                            mat.updated_at = now;
                        }
                    }
                }
                if let Err(e) = store::save_index(&index) {
                    eprintln!("[kb_app] 语雀导入落盘失败: {}", e);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    });

    Ok(report)
}

// ── 目录绑定本地文件夹 + 增量同步 ──

/// 把目录绑定到一个本地文件夹（绝对路径）。绑定后可「同步此目录」，
/// 把本地文件夹的内容镜像进这个目录节点。
#[tauri::command]
pub fn kb_category_bind_local(
    state: State<'_, KbState>,
    category_id: String,
    local_path: String,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(local_path.trim());
    if !path.is_dir() {
        return Err(format!("不是有效的文件夹: {}", path.display()));
    }
    let mut index = state.0.lock().unwrap();
    let category = index
        .categories
        .iter_mut()
        .find(|c| c.id == category_id)
        .ok_or_else(|| "目录不存在".to_string())?;
    category.local_path = Some(path.to_string_lossy().to_string());
    store::save_index(&index)
}

/// 解除目录与本地文件夹的绑定（已导入的资料保留在库里）。
#[tauri::command]
pub fn kb_category_unbind_local(
    state: State<'_, KbState>,
    category_id: String,
) -> Result<(), String> {
    let mut index = state.0.lock().unwrap();
    let category = index
        .categories
        .iter_mut()
        .find(|c| c.id == category_id)
        .ok_or_else(|| "目录不存在".to_string())?;
    category.local_path = None;
    store::save_index(&index)
}

/// 同步结果。
#[derive(Serialize)]
pub struct SyncReport {
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub failed: usize,
}

/// 同步目录绑定的本地文件夹：
/// - 新文件 → 登记 + 拷贝原件 + 提交解析；
/// - 同路径但内容变了 → 换新原件、版本 +1、重新解析；
/// - 没变的 → 跳过；
/// - 源文件已被删掉 → 该条目标记为「源文件已移除」（不删，保留历史）。
#[tauri::command]
pub async fn kb_sync_local_dir(app: AppHandle, category_id: String) -> Result<SyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KbState>();
        let (kb_id, local_path) = {
            let index = state.0.lock().unwrap();
            let category = index
                .categories
                .iter()
                .find(|c| c.id == category_id)
                .ok_or_else(|| "目录不存在".to_string())?;
            let local_path = category
                .local_path
                .clone()
                .ok_or_else(|| "该目录没有绑定本地文件夹".to_string())?;
            (category.kb_id.clone(), local_path)
        };

        let root = std::path::PathBuf::from(&local_path);
        let mut files = Vec::new();
        collect_files(&root, &[], 0, &mut files)?;

        let mut report = SyncReport {
            added: 0,
            updated: 0,
            unchanged: 0,
            removed: 0,
            failed: 0,
        };
        let mut to_parse: Vec<String> = Vec::new();
        let mut seen_sources: Vec<String> = Vec::new();

        for (path, _rel) in files {
            let source_path = path.to_string_lossy().to_string();
            seen_sources.push(source_path.clone());
            let (fingerprint, size) = match sha256_file(&path) {
                Ok(v) => v,
                Err(_) => {
                    report.failed += 1;
                    continue;
                }
            };
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let title = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| file_name.clone());
            let ext = ext_of(&file_name);

            let existing = {
                let index = state.0.lock().unwrap();
                index
                    .materials
                    .iter()
                    .find(|m| m.source_path.as_deref() == Some(source_path.as_str()))
                    .cloned()
            };

            let mut index = state.0.lock().unwrap();
            match existing {
                Some(mat) if mat.fingerprint == fingerprint => {
                    report.unchanged += 1;
                }
                Some(mut mat) => {
                    // 内容变了：换原件、版本 +1、重新解析
                    let stored = store::originals_dir().join(format!(
                        "{}{}",
                        mat.id,
                        ext.as_deref()
                            .map(|e| format!(".{}", e))
                            .unwrap_or_default()
                    ));
                    if let Err(e) = std::fs::copy(&path, &stored) {
                        report.failed += 1;
                        let _ = e;
                        continue;
                    }
                    if let Some(m) = index.material_mut(&mat.id) {
                        m.fingerprint = fingerprint;
                        m.size_bytes = size;
                        m.title = title;
                        m.ext = ext;
                        m.original_path = Some(stored.to_string_lossy().to_string());
                        m.version_no += 1;
                        m.parse_status = STATUS_PENDING.to_string();
                        m.parse_error = None;
                        m.updated_at = now_ms();
                    }
                    mat.original_path = Some(stored.to_string_lossy().to_string());
                    report.updated += 1;
                    to_parse.push(mat.id.clone());
                }
                None => {
                    if index.fingerprint_exists(&kb_id, &fingerprint) {
                        report.unchanged += 1;
                        continue;
                    }
                    let mut material = register_material(
                        &mut index,
                        &kb_id,
                        Some(category_id.clone()),
                        title,
                        ext,
                        size,
                        store::SOURCE_LOCAL,
                        fingerprint,
                        None,
                        Some(source_path.clone()),
                        None,
                    );
                    let stored = store::originals_dir().join(format!(
                        "{}{}",
                        material.id,
                        material
                            .ext
                            .as_deref()
                            .map(|e| format!(".{}", e))
                            .unwrap_or_default()
                    ));
                    if let Err(e) = std::fs::copy(&path, &stored) {
                        index.materials.retain(|m| m.id != material.id);
                        report.failed += 1;
                        let _ = e;
                        continue;
                    }
                    material.original_path = Some(stored.to_string_lossy().to_string());
                    if let Some(m) = index.material_mut(&material.id) {
                        m.original_path = material.original_path.clone();
                    }
                    report.added += 1;
                    to_parse.push(material.id.clone());
                }
            }
        }

        // 源文件已被删除的条目：标记出来，不删（历史资料留着）
        {
            let mut index = state.0.lock().unwrap();
            let category_ids = index.category_subtree_ids(&kb_id, &category_id);
            for mat in index.materials.iter_mut() {
                let in_category = mat
                    .category_id
                    .as_deref()
                    .map(|cid| category_ids.iter().any(|c| c == cid))
                    .unwrap_or(false);
                if !in_category {
                    continue;
                }
                let Some(source) = mat.source_path.clone() else {
                    continue;
                };
                if seen_sources.iter().any(|s| s == &source) {
                    continue;
                }
                if !std::path::Path::new(&source).exists() {
                    mat.parse_error = Some("源文件已从本地文件夹移除（同步时标记）".to_string());
                    mat.parse_status = STATUS_FAILED.to_string();
                    mat.updated_at = now_ms();
                    report.removed += 1;
                }
            }
            store::save_index(&index)?;
        }

        for id in to_parse {
            parse::spawn_parse(&app, id);
        }
        Ok(report)
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

// ── 原件打开 / 定位 ──

#[tauri::command]
pub fn kb_open_original(app: AppHandle, material_id: String) -> Result<(), String> {
    let path = {
        let state = app.state::<KbState>();
        let index = state.0.lock().unwrap();
        index
            .material(&material_id)
            .and_then(|m| m.original_path.clone())
            .ok_or_else(|| "该物料没有原件副本（语雀来源只有解析稿）".to_string())?
    };
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("打开原件失败: {}", e))
}

#[tauri::command]
pub fn kb_reveal_original(app: AppHandle, material_id: String) -> Result<(), String> {
    let path = {
        let state = app.state::<KbState>();
        let index = state.0.lock().unwrap();
        index
            .material(&material_id)
            .and_then(|m| m.original_path.clone())
            .ok_or_else(|| "该物料没有原件副本".to_string())?
    };
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| format!("定位原件失败: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端一律用 camelCase 传参。Tauri 只转换命令的**顶层**参数，
    /// 嵌套结构体里的字段不会被转换，必须自己声明 rename_all。
    #[test]
    fn nested_inputs_accept_camel_case() {
        let cat: CategoryCreateInput =
            serde_json::from_str(r#"{"kbId":"kb1","parentId":null,"name":"目录"}"#)
                .expect("camelCase 反序列化失败");
        assert_eq!(cat.kb_id, "kb1");
        assert!(cat.parent_id.is_none());

        let imp: ImportLocalInput =
            serde_json::from_str(r#"{"kbId":"kb1","categoryId":"c1","paths":["/tmp/a.pdf"]}"#)
                .expect("camelCase 反序列化失败");
        assert_eq!(imp.kb_id, "kb1");
        assert_eq!(imp.category_id.as_deref(), Some("c1"));
        assert_eq!(imp.paths.len(), 1);

        let txt: RegisterTextInput = serde_json::from_str(
            r#"{"kbId":"kb1","categoryId":null,"title":"标题","content":"正文"}"#,
        )
        .expect("camelCase 反序列化失败");
        assert_eq!(txt.kb_id, "kb1");
        assert_eq!(txt.title, "标题");

        let cfg: ConfigSetInput = serde_json::from_str(
            r#"{"mineruBaseUrl":"http://x","yuqueApiBase":null,"yuqueToken":"t"}"#,
        )
        .expect("camelCase 反序列化失败");
        assert_eq!(cfg.mineru_base_url.as_deref(), Some("http://x"));
        assert_eq!(cfg.yuque_token.as_deref(), Some("t"));
    }
}
