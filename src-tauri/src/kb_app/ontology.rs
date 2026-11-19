//! 本体（Ontology）：类型 / 关系 / 实例 / 关系实例的本地声明式存储。
//!
//! 交互形态对齐 future-brain 本体板块（左栏双 Tab + 图谱画布 + 实例层），
//! 数据模型取其最小集：对象类型（Tag）/ 关系类型（Edge）/ 属性（Property）/
//! 实例（Instance）/ 关系实例（Link）。与 kb 索引同一惯例：整份 JSON 落盘，
//! 结构变更直接写（future-brain 走提案审批，本地单人场景砍成直写）。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::store;
use crate::atomic_write::atomic_write;

pub struct OntState(pub Mutex<OntologyData>);

/// 属性值类型：text / number / date / bool。
pub const PROP_DATA_TYPES: [&str; 4] = ["text", "number", "date", "bool"];

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn default_true() -> bool {
    true
}

/// 类型/关系上的属性声明。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OntProperty {
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default = "default_data_type")]
    pub data_type: String,
    #[serde(default = "default_true")]
    pub nullable: bool,
}

fn default_data_type() -> String {
    "text".to_string()
}

/// 对象类型（future-brain 的 Tag）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OntType {
    pub id: String,
    /// 唯一代号（同本体内部唯一，图谱节点主键）。
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    /// 分类（分组展示用，可空）。
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub properties: Vec<OntProperty>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 关系类型（future-brain 的 Edge）：两端各绑一个对象类型，允许自环。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OntEdge {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    pub src_type: String,
    pub dst_type: String,
    #[serde(default)]
    pub properties: Vec<OntProperty>,
}

/// 实例：挂在某个对象类型下的具体条目。
pub type PropMap = BTreeMap<String, serde_json::Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OntInstance {
    pub id: String,
    pub type_id: String,
    pub name: String,
    #[serde(default)]
    pub properties: PropMap,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 关系实例：某条关系类型连接的两个实例。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OntLink {
    pub id: String,
    pub edge_id: String,
    pub src_id: String,
    pub dst_id: String,
    #[serde(default)]
    pub properties: PropMap,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OntologyData {
    #[serde(default)]
    pub types: Vec<OntType>,
    #[serde(default)]
    pub edges: Vec<OntEdge>,
    #[serde(default)]
    pub instances: Vec<OntInstance>,
    #[serde(default)]
    pub links: Vec<OntLink>,
    /// 图谱画布的节点坐标（前端拖拽后回存）。
    #[serde(default)]
    pub layout: BTreeMap<String, Vec<f64>>,
}

fn ontology_path() -> PathBuf {
    store::kb_data_dir().join("ontology.json")
}

pub fn load_data() -> OntologyData {
    let path = ontology_path();
    let Ok(bytes) = std::fs::read(&path) else {
        return OntologyData::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(data) => data,
        Err(e) => {
            eprintln!("[kb_app] ontology.json 解析失败（按空本体处理）: {}", e);
            OntologyData::default()
        }
    }
}

fn save_data(data: &OntologyData) -> Result<(), String> {
    store::ensure_dirs()?;
    let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
    atomic_write(&ontology_path(), &bytes)
}

// ── 视图 ──

#[derive(Serialize)]
pub struct OntTypeView {
    #[serde(flatten)]
    pub t: OntType,
    pub instance_count: usize,
}

#[derive(Serialize)]
pub struct OntOverview {
    pub types: Vec<OntTypeView>,
    pub edges: Vec<OntEdge>,
    pub instance_total: usize,
    pub link_total: usize,
    pub layout: BTreeMap<String, Vec<f64>>,
}

#[derive(Serialize)]
pub struct InstancePage {
    pub total: usize,
    pub items: Vec<OntInstance>,
}

#[derive(Serialize)]
pub struct LinkView {
    pub id: String,
    pub edge_id: String,
    pub edge_name: String,
    pub src_id: String,
    pub dst_id: String,
    pub src_name: String,
    pub dst_name: String,
    pub properties: PropMap,
}

#[derive(Serialize)]
pub struct GraphNode {
    pub id: String,
    pub type_id: String,
    pub type_name: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct GraphEdgeView {
    pub id: String,
    pub edge_name: String,
    pub src_id: String,
    pub dst_id: String,
}

#[derive(Serialize)]
pub struct NeighborsResult {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdgeView>,
}

fn type_view(t: &OntType, data: &OntologyData) -> OntTypeView {
    OntTypeView {
        instance_count: data.instances.iter().filter(|i| i.type_id == t.id).count(),
        t: t.clone(),
    }
}

fn e_name(data: &OntologyData, edge_id: &str) -> String {
    data.edges
        .iter()
        .find(|e| e.id == edge_id)
        .map(|e| {
            if e.display_name.is_empty() {
                e.name.clone()
            } else {
                e.display_name.clone()
            }
        })
        .unwrap_or_else(|| "?".to_string())
}

fn instance_name_of<'a>(data: &'a OntologyData, id: &str) -> &'a str {
    data.instances
        .iter()
        .find(|i| i.id == id)
        .map(|i| i.name.as_str())
        .unwrap_or("?")
}

fn link_view(data: &OntologyData, l: &OntLink) -> LinkView {
    LinkView {
        id: l.id.clone(),
        edge_id: l.edge_id.clone(),
        edge_name: e_name(data, &l.edge_id),
        src_id: l.src_id.clone(),
        dst_id: l.dst_id.clone(),
        src_name: instance_name_of(data, &l.src_id).to_string(),
        dst_name: instance_name_of(data, &l.dst_id).to_string(),
        properties: l.properties.clone(),
    }
}

fn validate_props(props: &[(String, OntProperty)], values: &PropMap) -> Result<(), String> {
    for (key, value) in values {
        let Some(def) = props.iter().find(|(n, _)| n == key) else {
            return Err(format!("属性「{}」不在类型声明中", key));
        };
        let def = &def.1;
        let is_null = value.is_null();
        if is_null {
            if !def.nullable {
                return Err(format!("属性「{}」不允许为空", key));
            }
            continue;
        }
        let ok = match def.data_type.as_str() {
            "number" => value.is_number(),
            "bool" => value.is_boolean(),
            "date" => value.is_string(),
            _ => value.is_string(),
        };
        if !ok {
            return Err(format!(
                "属性「{}」的类型应为 {}",
                key,
                PROP_DATA_TYPES
                    .iter()
                    .find(|t| **t == def.data_type)
                    .copied()
                    .unwrap_or("text")
            ));
        }
    }
    Ok(())
}

// ── 输入 ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSaveInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeSaveInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    pub src_type: String,
    pub dst_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyInput {
    /// "type" | "edge"
    pub owner: String,
    pub owner_id: String,
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default = "default_data_type")]
    pub data_type: String,
    #[serde(default = "default_true")]
    pub nullable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceSaveInput {
    pub id: Option<String>,
    pub type_id: String,
    pub name: String,
    #[serde(default)]
    pub properties: PropMap,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSaveInput {
    pub id: Option<String>,
    pub edge_id: String,
    pub src_id: String,
    pub dst_id: String,
}

// ── 命令 ──

fn data_mut<T>(
    state: &State<'_, OntState>,
    f: impl FnOnce(&mut OntologyData) -> Result<T, String>,
) -> Result<T, String> {
    let mut data = state.0.lock().unwrap();
    let out = f(&mut data)?;
    save_data(&data)?;
    Ok(out)
}

/// 邻域：从某实例出发按跳数收子图（BFS，最多 4 跳，防失控）。
fn neighbors(data: &OntologyData, instance_id: &str, hops: usize) -> NeighborsResult {
    let hops = hops.clamp(1, 4);
    let mut seen: std::collections::HashSet<String> =
        std::collections::HashSet::from([instance_id.to_string()]);
    let mut frontier = vec![instance_id.to_string()];
    let mut edges: Vec<GraphEdgeView> = Vec::new();
    let mut seen_edges: std::collections::HashSet<String> = std::collections::HashSet::new();
    for _ in 0..hops {
        let mut next = Vec::new();
        for id in &frontier {
            for l in &data.links {
                if l.src_id != *id && l.dst_id != *id {
                    continue;
                }
                if seen_edges.insert(l.id.clone()) {
                    edges.push(GraphEdgeView {
                        id: l.id.clone(),
                        edge_name: e_name(data, &l.edge_id),
                        src_id: l.src_id.clone(),
                        dst_id: l.dst_id.clone(),
                    });
                }
                let peer = if l.src_id == *id {
                    &l.dst_id
                } else {
                    &l.src_id
                };
                if seen.insert(peer.clone()) {
                    next.push(peer.clone());
                }
            }
        }
        frontier = next;
    }
    let mut nodes: Vec<GraphNode> = seen
        .iter()
        .filter_map(|id| {
            let inst = data.instances.iter().find(|i| &i.id == id)?;
            let t = data.types.iter().find(|t| t.id == inst.type_id)?;
            Some(GraphNode {
                id: inst.id.clone(),
                type_id: t.id.clone(),
                type_name: t.name.clone(),
                name: inst.name.clone(),
            })
        })
        .collect();
    nodes.sort_by(|a, b| a.type_name.cmp(&b.type_name).then(a.name.cmp(&b.name)));
    NeighborsResult { nodes, edges }
}

#[tauri::command]
pub fn onto_overview(state: State<'_, OntState>) -> Result<OntOverview, String> {
    let data = state.0.lock().unwrap();
    Ok(OntOverview {
        types: data.types.iter().map(|t| type_view(t, &data)).collect(),
        edges: data.edges.clone(),
        instance_total: data.instances.len(),
        link_total: data.links.len(),
        layout: data.layout.clone(),
    })
}

#[tauri::command]
pub fn onto_type_save(
    state: State<'_, OntState>,
    input: TypeSaveInput,
) -> Result<OntTypeView, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("类型代号不能为空".to_string());
    }
    data_mut(&state, |data| {
        if data
            .types
            .iter()
            .any(|t| input.id.as_deref() != Some(t.id.as_str()) && t.name == name)
        {
            return Err(format!("类型代号「{}」已存在", name));
        }
        if let Some(id) = &input.id {
            let t = data
                .types
                .iter_mut()
                .find(|t| &t.id == id)
                .ok_or_else(|| "类型不存在".to_string())?;
            t.name = name;
            t.display_name = input.display_name;
            t.category = input.category;
            t.updated_at = now_ms();
            let snapshot = t.clone();
            Ok(type_view(&snapshot, data))
        } else {
            if data.types.iter().any(|t| t.name == name) {
                return Err(format!("类型代号「{}」已存在", name));
            }
            let now = now_ms();
            let t = OntType {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                display_name: input.display_name,
                category: input.category,
                properties: vec![],
                created_at: now,
                updated_at: now,
            };
            data.types.push(t.clone());
            Ok(type_view(&t, data))
        }
    })
}

#[tauri::command]
pub fn onto_type_delete(state: State<'_, OntState>, type_id: String) -> Result<(), String> {
    data_mut(&state, |data| {
        if !data.types.iter().any(|t| t.id == type_id) {
            return Err("类型不存在".to_string());
        }
        let dead_instances: Vec<String> = data
            .instances
            .iter()
            .filter(|i| i.type_id == type_id)
            .map(|i| i.id.clone())
            .collect();
        data.instances.retain(|i| i.type_id != type_id);
        let dead_edges: Vec<String> = data
            .edges
            .iter()
            .filter(|e| e.src_type == type_id || e.dst_type == type_id)
            .map(|e| e.id.clone())
            .collect();
        data.edges
            .retain(|e| e.src_type != type_id && e.dst_type != type_id);
        data.links.retain(|l| {
            !dead_edges.contains(&l.edge_id)
                && !dead_instances.contains(&l.src_id)
                && !dead_instances.contains(&l.dst_id)
        });
        data.types.retain(|t| t.id != type_id);
        data.layout.remove(&type_id);
        Ok(())
    })
}

#[tauri::command]
pub fn onto_edge_save(state: State<'_, OntState>, input: EdgeSaveInput) -> Result<OntEdge, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("关系代号不能为空".to_string());
    }
    data_mut(&state, |data| {
        if !data.types.iter().any(|t| t.id == input.src_type) {
            return Err("起点类型不存在".to_string());
        }
        if !data.types.iter().any(|t| t.id == input.dst_type) {
            return Err("终点类型不存在".to_string());
        }
        if let Some(id) = &input.id {
            if data.edges.iter().any(|e| &e.id != id && e.name == name) {
                return Err(format!("关系代号「{}」已存在", name));
            }
            let e = data
                .edges
                .iter_mut()
                .find(|e| &e.id == id)
                .ok_or_else(|| "关系不存在".to_string())?;
            // 改两端时，已建的关系实例可能不再合法 —— 一并清掉。
            if e.src_type != input.src_type || e.dst_type != input.dst_type {
                data.links.retain(|l| &l.edge_id != id);
            }
            e.name = name;
            e.display_name = input.display_name;
            e.src_type = input.src_type;
            e.dst_type = input.dst_type;
            Ok(e.clone())
        } else {
            if data.edges.iter().any(|e| e.name == name) {
                return Err(format!("关系代号「{}」已存在", name));
            }
            let e = OntEdge {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                display_name: input.display_name,
                src_type: input.src_type,
                dst_type: input.dst_type,
                properties: vec![],
            };
            data.edges.push(e.clone());
            Ok(e)
        }
    })
}

#[tauri::command]
pub fn onto_edge_delete(state: State<'_, OntState>, edge_id: String) -> Result<(), String> {
    data_mut(&state, |data| {
        if !data.edges.iter().any(|e| e.id == edge_id) {
            return Err("关系不存在".to_string());
        }
        data.links.retain(|l| l.edge_id != edge_id);
        data.edges.retain(|e| e.id != edge_id);
        Ok(())
    })
}

#[tauri::command]
pub fn onto_property_set(state: State<'_, OntState>, input: PropertyInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("属性代号不能为空".to_string());
    }
    if !PROP_DATA_TYPES.contains(&input.data_type.as_str()) {
        return Err(format!("属性类型只能是 {}", PROP_DATA_TYPES.join(" / ")));
    }
    data_mut(&state, |data| {
        let located = match input.owner.as_str() {
            "type" => data
                .types
                .iter()
                .position(|t| t.id == input.owner_id)
                .map(|idx| (idx, true))
                .ok_or_else(|| "类型不存在".to_string()),
            "edge" => data
                .edges
                .iter()
                .position(|e| e.id == input.owner_id)
                .map(|idx| (idx, false))
                .ok_or_else(|| "关系不存在".to_string()),
            _ => Err("owner 只能是 type 或 edge".to_string()),
        };
        let (idx, is_type) = located?;
        let props = if is_type {
            &mut data.types[idx].properties
        } else {
            &mut data.edges[idx].properties
        };
        if let Some(existing) = props.iter_mut().find(|p| p.name == input.name) {
            existing.display_name = input.display_name;
            existing.data_type = input.data_type;
            existing.nullable = input.nullable;
        } else {
            props.push(OntProperty {
                name: input.name.trim().to_string(),
                display_name: input.display_name,
                data_type: input.data_type,
                nullable: input.nullable,
            });
        }
        Ok(())
    })
}

#[tauri::command]
pub fn onto_property_delete(
    state: State<'_, OntState>,
    owner: String,
    owner_id: String,
    name: String,
) -> Result<(), String> {
    data_mut(&state, |data| match owner.as_str() {
        "type" => {
            let t = data
                .types
                .iter_mut()
                .find(|t| t.id == owner_id)
                .ok_or_else(|| "类型不存在".to_string())?;
            t.properties.retain(|p| p.name != name);
            // 实例上的值一并清掉，避免脏数据。
            let type_id = t.id.clone();
            for i in data.instances.iter_mut().filter(|i| i.type_id == type_id) {
                i.properties.remove(&name);
            }
            Ok(())
        }
        "edge" => {
            let e = data
                .edges
                .iter_mut()
                .find(|e| e.id == owner_id)
                .ok_or_else(|| "关系不存在".to_string())?;
            e.properties.retain(|p| p.name != name);
            let edge_id = e.id.clone();
            for l in data.links.iter_mut().filter(|l| l.edge_id == edge_id) {
                l.properties.remove(&name);
            }
            Ok(())
        }
        _ => Err("owner 只能是 type 或 edge".to_string()),
    })
}

#[tauri::command]
pub fn onto_instance_save(
    state: State<'_, OntState>,
    input: InstanceSaveInput,
) -> Result<OntInstance, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("实例名不能为空".to_string());
    }
    data_mut(&state, |data| {
        let t = data
            .types
            .iter()
            .find(|t| t.id == input.type_id)
            .ok_or_else(|| "类型不存在".to_string())?
            .clone();
        let decls: Vec<(String, OntProperty)> = t
            .properties
            .iter()
            .map(|p| (p.name.clone(), p.clone()))
            .collect();
        validate_props(&decls, &input.properties)?;
        let now = now_ms();
        if let Some(id) = &input.id {
            let i = data
                .instances
                .iter_mut()
                .find(|i| &i.id == id)
                .ok_or_else(|| "实例不存在".to_string())?;
            if i.type_id != input.type_id {
                return Err("实例不能更换类型".to_string());
            }
            i.name = name;
            i.properties = input.properties;
            i.updated_at = now;
            Ok(i.clone())
        } else {
            if data
                .instances
                .iter()
                .any(|i| i.type_id == input.type_id && i.name == name)
            {
                return Err(format!("该类型下已有同名实例「{}」", name));
            }
            let i = OntInstance {
                id: uuid::Uuid::new_v4().to_string(),
                type_id: input.type_id,
                name,
                properties: input.properties,
                created_at: now,
                updated_at: now,
            };
            data.instances.push(i.clone());
            Ok(i)
        }
    })
}

#[tauri::command]
pub fn onto_instance_delete(state: State<'_, OntState>, instance_id: String) -> Result<(), String> {
    data_mut(&state, |data| {
        if !data.instances.iter().any(|i| i.id == instance_id) {
            return Err("实例不存在".to_string());
        }
        data.links
            .retain(|l| l.src_id != instance_id && l.dst_id != instance_id);
        data.instances.retain(|i| i.id != instance_id);
        Ok(())
    })
}

#[tauri::command]
pub fn onto_instance_list(
    state: State<'_, OntState>,
    type_id: String,
    keyword: Option<String>,
    page: Option<usize>,
    page_size: Option<usize>,
) -> Result<InstancePage, String> {
    let data = state.0.lock().unwrap();
    let kw = keyword.unwrap_or_default().to_lowercase();
    let mut items: Vec<&OntInstance> = data
        .instances
        .iter()
        .filter(|i| i.type_id == type_id)
        .filter(|i| {
            kw.is_empty()
                || i.name.to_lowercase().contains(&kw)
                || i.properties.values().any(|v| {
                    v.as_str()
                        .map(|s| s.to_lowercase().contains(&kw))
                        .unwrap_or(false)
                })
        })
        .collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    let total = items.len();
    let page_size = page_size.unwrap_or(50).clamp(1, 500);
    let page = page.unwrap_or(0);
    let start = page * page_size;
    let items = if start >= total {
        vec![]
    } else {
        items[start..(start + page_size).min(total)]
            .iter()
            .map(|i| (*i).clone())
            .collect()
    };
    Ok(InstancePage { total, items })
}

#[tauri::command]
pub fn onto_link_save(state: State<'_, OntState>, input: LinkSaveInput) -> Result<OntLink, String> {
    data_mut(&state, |data| {
        let edge = data
            .edges
            .iter()
            .find(|e| e.id == input.edge_id)
            .ok_or_else(|| "关系不存在".to_string())?
            .clone();
        let src = data
            .instances
            .iter()
            .find(|i| i.id == input.src_id)
            .ok_or_else(|| "起点实例不存在".to_string())?;
        let dst = data
            .instances
            .iter()
            .find(|i| i.id == input.dst_id)
            .ok_or_else(|| "终点实例不存在".to_string())?;
        if src.id == dst.id {
            return Err("起点与终点不能是同一实例".to_string());
        }
        if src.type_id != edge.src_type {
            return Err(format!("起点实例的类型不是「{}」", edge.src_type));
        }
        if dst.type_id != edge.dst_type {
            return Err(format!("终点实例的类型不是「{}」", edge.dst_type));
        }
        if let Some(id) = &input.id {
            let l = data
                .links
                .iter_mut()
                .find(|l| &l.id == id)
                .ok_or_else(|| "关系实例不存在".to_string())?;
            l.edge_id = input.edge_id;
            l.src_id = input.src_id;
            l.dst_id = input.dst_id;
            Ok(l.clone())
        } else {
            if data.links.iter().any(|l| {
                l.edge_id == input.edge_id && l.src_id == input.src_id && l.dst_id == input.dst_id
            }) {
                return Err("同样的关系已存在".to_string());
            }
            let l = OntLink {
                id: uuid::Uuid::new_v4().to_string(),
                edge_id: input.edge_id,
                src_id: input.src_id,
                dst_id: input.dst_id,
                properties: BTreeMap::new(),
                created_at: now_ms(),
            };
            data.links.push(l.clone());
            Ok(l)
        }
    })
}

#[tauri::command]
pub fn onto_link_delete(state: State<'_, OntState>, link_id: String) -> Result<(), String> {
    data_mut(&state, |data| {
        data.links.retain(|l| l.id != link_id);
        Ok(())
    })
}

#[tauri::command]
pub fn onto_links_of(
    state: State<'_, OntState>,
    instance_id: String,
) -> Result<Vec<LinkView>, String> {
    let data = state.0.lock().unwrap();
    Ok(data
        .links
        .iter()
        .filter(|l| l.src_id == instance_id || l.dst_id == instance_id)
        .map(|l| link_view(&data, l))
        .collect())
}

#[tauri::command]
pub fn onto_neighbors(
    state: State<'_, OntState>,
    instance_id: String,
    hops: Option<usize>,
) -> Result<NeighborsResult, String> {
    let data = state.0.lock().unwrap();
    if !data.instances.iter().any(|i| i.id == instance_id) {
        return Err("实例不存在".to_string());
    }
    Ok(neighbors(&data, &instance_id, hops.unwrap_or(1)))
}

#[tauri::command]
pub fn onto_search(
    state: State<'_, OntState>,
    keyword: String,
    limit: Option<usize>,
) -> Result<Vec<GraphNode>, String> {
    let data = state.0.lock().unwrap();
    let kw = keyword.trim().to_lowercase();
    if kw.is_empty() {
        return Ok(vec![]);
    }
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let mut hits: Vec<GraphNode> = data
        .instances
        .iter()
        .filter(|i| i.name.to_lowercase().contains(&kw))
        .filter_map(|i| {
            let t = data.types.iter().find(|t| t.id == i.type_id)?;
            Some(GraphNode {
                id: i.id.clone(),
                type_id: t.id.clone(),
                type_name: t.name.clone(),
                name: i.name.clone(),
            })
        })
        .take(limit)
        .collect();
    hits.sort_by(|a, b| a.type_name.cmp(&b.type_name).then(a.name.cmp(&b.name)));
    Ok(hits)
}

#[tauri::command]
pub fn onto_layout_save(
    state: State<'_, OntState>,
    positions: BTreeMap<String, Vec<f64>>,
) -> Result<(), String> {
    data_mut(&state, |data| {
        data.layout = positions;
        Ok(())
    })
}
