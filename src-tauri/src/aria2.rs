// Aria2 离线下载管理
// 通过 XML-RPC 调用 aria2c daemon（需要用户先启动 aria2c --enable-rpc）
use serde::{Deserialize, Serialize};
use std::process::{Command, Child};
use std::sync::Mutex;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Aria2Task {
    pub gid: String,
    pub status: String,           // "active" | "waiting" | "paused" | "error" | "complete"
    pub total_length: u64,
    pub completed_length: u64,
    pub download_speed: u64,
    pub upload_speed: u64,
    pub files: Vec<Aria2File>,
    pub dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Aria2File {
    pub path: String,
    pub length: u64,
    pub completed_length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Aria2GlobalStat {
    pub download_speed: u64,
    pub upload_speed: u64,
    pub num_active: u32,
    pub num_waiting: u32,
    pub num_stopped: u32,
}

pub struct Aria2State {
    pub rpc_url: String,
    pub rpc_secret: String,
    pub auto_started: Mutex<Option<Child>>,
}

impl Default for Aria2State {
    fn default() -> Self {
        Self {
            rpc_url: "http://127.0.0.1:6800/jsonrpc".to_string(),
            rpc_secret: "".to_string(),
            auto_started: Mutex::new(None),
        }
    }
}

/// 检查 aria2 RPC 是否在线
#[tauri::command]
pub fn aria2_ping(state: tauri::State<Aria2State>) -> bool {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "1",
        "method": "aria2.getVersion",
        "params": state.rpc_secret.is_empty().then(|| vec!["token:".to_string() + &state.rpc_secret]).unwrap_or_default(),
    });
    ureq::post(&state.rpc_url)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .is_ok()
}

/// 添加下载任务
#[tauri::command]
pub fn aria2_add_uri(
    uri: String,
    options: Option<HashMap<String, String>>,
    state: tauri::State<Aria2State>,
) -> Result<String, String> {
    let mut params: Vec<serde_json::Value> = vec![serde_json::json!([uri])];
    if !state.rpc_secret.is_empty() {
        params.insert(0, serde_json::json!("token:".to_string() + &state.rpc_secret));
    }
    if let Some(opts) = options {
        params.push(serde_json::to_value(opts).unwrap_or_default());
    }
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "1",
        "method": "aria2.addUri",
        "params": params,
    });
    let resp = ureq::post(&state.rpc_url)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| format!("aria2 RPC 失败: {}", e))?
        .into_string()
        .map_err(|e| format!("解析响应失败: {}", e))?;
    // 解析返回的 gid
    let v: serde_json::Value = serde_json::from_str(&resp)
        .map_err(|e| format!("JSON 解析失败: {}", e))?;
    v.get("result")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("返回无 result: {}", resp))
}

/// 获取所有任务状态
#[tauri::command]
pub fn aria2_get_tasks(state: tauri::State<Aria2State>) -> Result<Vec<Aria2Task>, String> {
    let mut params = vec![];
    if !state.rpc_secret.is_empty() {
        params.push(serde_json::json!("token:".to_string() + &state.rpc_secret));
    }

    // tellActive
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "1",
        "method": "aria2.tellActive",
        "params": params,
    });
    let resp = ureq::post(&state.rpc_url)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| format!("RPC 失败: {}", e))?
        .into_string()
        .map_err(|e| format!("响应读取失败: {}", e))?;
    let v: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;

    let tasks = v
        .get("result")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    Some(Aria2Task {
                        gid: t.get("gid")?.as_str()?.to_string(),
                        status: t.get("status")?.as_str()?.to_string(),
                        total_length: t.get("totalLength")?.as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
                        completed_length: t.get("completedLength")?.as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
                        download_speed: t.get("downloadSpeed")?.as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
                        upload_speed: t.get("uploadSpeed")?.as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
                        files: vec![],
                        dir: t.get("dir")?.as_str().unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(tasks)
}

/// 暂停任务
#[tauri::command]
pub fn aria2_pause(gid: String, state: tauri::State<Aria2State>) -> Result<(), String> {
    let mut params = vec![serde_json::json!(gid)];
    if !state.rpc_secret.is_empty() {
        params.insert(0, serde_json::json!("token:".to_string() + &state.rpc_secret));
    }
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "1",
        "method": "aria2.pause",
        "params": params,
    });
    ureq::post(&state.rpc_url)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| format!("RPC 失败: {}", e))?;
    Ok(())
}

/// 删除任务
#[tauri::command]
pub fn aria2_remove(gid: String, state: tauri::State<Aria2State>) -> Result<(), String> {
    let mut params = vec![serde_json::json!(gid)];
    if !state.rpc_secret.is_empty() {
        params.insert(0, serde_json::json!("token:".to_string() + &state.rpc_secret));
    }
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "1",
        "method": "aria2.removeDownloadResult",
        "params": params,
    });
    ureq::post(&state.rpc_url)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| format!("RPC 失败: {}", e))?;
    Ok(())
}

/// 全局统计
#[tauri::command]
pub fn aria2_global_stat(state: tauri::State<Aria2State>) -> Result<Aria2GlobalStat, String> {
    let mut params = vec![];
    if !state.rpc_secret.is_empty() {
        params.push(serde_json::json!("token:".to_string() + &state.rpc_secret));
    }
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "1",
        "method": "aria2.getGlobalStat",
        "params": params,
    });
    let resp = ureq::post(&state.rpc_url)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| format!("RPC 失败: {}", e))?
        .into_string()
        .map_err(|e| format!("响应读取失败: {}", e))?;
    let v: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    let r = v.get("result").ok_or("无 result")?;
    Ok(Aria2GlobalStat {
        download_speed: r.get("downloadSpeed").and_then(|s| s.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0),
        upload_speed: r.get("uploadSpeed").and_then(|s| s.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0),
        num_active: r.get("numActive").and_then(|s| s.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0),
        num_waiting: r.get("numWaiting").and_then(|s| s.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0),
        num_stopped: r.get("numStoppedTotal").and_then(|s| s.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0),
    })
}

/// 启动 aria2c daemon（如果用户机器已安装）
#[tauri::command]
pub fn start_aria2_daemon(
    state: tauri::State<Aria2State>,
    download_dir: String,
) -> Result<(), String> {
    let mut guard = state.auto_started.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("aria2c 已在运行".to_string());
    }
    let child = Command::new("aria2c")
        .args([
            "--enable-rpc",
            "--rpc-listen-all=false",
            "--rpc-allow-origin-all=true",
            "--dir", &download_dir,
        ])
        .spawn()
        .map_err(|e| format!("启动 aria2c 失败: {}（请确认已安装 aria2）", e))?;
    *guard = Some(child);
    Ok(())
}
