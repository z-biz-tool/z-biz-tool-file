use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// 文件变化事件
#[derive(Debug, Clone, Serialize)]
pub struct FileChangeEvent {
    pub path: String,
    pub kind: String, // create / modify / remove
}

/// 监听配置
#[derive(Debug, Clone)]
pub struct WatcherConfig {
    /// 最大递归深度（防止监视整盘）
    pub max_depth: usize,
    /// 同一路径在窗口内的多次事件合并为一次
    pub debounce: Duration,
}

impl Default for WatcherConfig {
    fn default() -> Self {
        Self {
            max_depth: 3,
            debounce: Duration::from_millis(500),
        }
    }
}

/// 全局监听器状态
pub struct WatcherState {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    last_path: Mutex<Option<String>>,
    /// 路径 → 最近一次事件的时间戳，用于去重
    last_event_at: Mutex<HashMap<PathBuf, Instant>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            last_path: Mutex::new(None),
            last_event_at: Mutex::new(HashMap::new()),
        }
    }
}

/// 启动文件监听（递归 + depth 限制 + 防抖去重）
#[tauri::command]
pub fn start_watching(
    path: String,
    state: State<'_, WatcherState>,
    app: AppHandle,
) -> Result<(), String> {
    start_watching_with_config(path, WatcherConfig::default(), state, app)
}

/// 内部入口：带配置参数，供测试调用
pub fn start_watching_with_config(
    path: String,
    cfg: WatcherConfig,
    state: State<'_, WatcherState>,
    app: AppHandle,
) -> Result<(), String> {
    let watch_path = Path::new(&path);
    if !watch_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    // 停止旧监听器并清空去重表
    {
        let mut watcher_guard = state.watcher.lock().unwrap();
        if let Some(old) = watcher_guard.take() {
            drop(old);
        }
    }
    state.last_event_at.lock().unwrap().clear();
    {
        let mut last_path = state.last_path.lock().unwrap();
        *last_path = Some(path.clone());
    }

    let app_clone = app.clone();
    let path_for_filter = PathBuf::from(&path);
    let max_depth = cfg.max_depth;
    let debounce = cfg.debounce;
    let state_clone_path = path.clone();
    // 把 state 的指针搬到闭包里；通过 raw pointer + Mutex 是 notify 闭包 trait 限制下的常规做法
    // （notify 推荐 watcher 的回调是 FnMut + Send + 'static）
    let last_event_at = Mutex::new(HashMap::<PathBuf, Instant>::new());

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            let kind = match event.kind {
                EventKind::Create(_) => "create",
                EventKind::Modify(_) => "modify",
                EventKind::Remove(_) => "remove",
                _ => return,
            };
            for event_path in event.paths.iter() {
                // 1. 必须位于监听根目录之内
                let canonical = match event_path.canonicalize() {
                    Ok(p) => p,
                    Err(_) => event_path.clone(),
                };
                if !canonical.starts_with(&path_for_filter) {
                    continue;
                }
                // 2. 深度限制（相对监听根目录的 .. 数）
                let rel = canonical.strip_prefix(&path_for_filter).unwrap_or(&canonical);
                let depth = rel.components().filter(|c| matches!(c, std::path::Component::Normal(_))).count();
                if depth > max_depth {
                    continue;
                }
                // 3. 防抖去重：同路径在窗口内仅触发一次
                let now = Instant::now();
                let mut map = last_event_at.lock().unwrap();
                if let Some(prev) = map.get(&canonical) {
                    if now.duration_since(*prev) < debounce {
                        continue;
                    }
                }
                map.insert(canonical.clone(), now);

                let evt = FileChangeEvent {
                    path: canonical.to_string_lossy().to_string(),
                    kind: kind.to_string(),
                };
                let _ = app_clone.emit("file-change", evt);
            }
        }
    })
    .map_err(|e| format!("创建监听器失败: {}", e))?;

    watcher
        .watch(watch_path, RecursiveMode::Recursive)
        .map_err(|e| format!("启动监听失败: {}", e))?;

    {
        let mut watcher_guard = state.watcher.lock().unwrap();
        *watcher_guard = Some(watcher);
    }

    // 引用抑制警告
    let _ = state_clone_path;

    Ok(())
}

/// 停止文件监听
#[tauri::command]
pub fn stop_watching(state: State<'_, WatcherState>) -> Result<(), String> {
    let mut watcher_guard = state.watcher.lock().unwrap();
    if let Some(old) = watcher_guard.take() {
        drop(old);
    }
    let mut last_path = state.last_path.lock().unwrap();
    *last_path = None;
    state.last_event_at.lock().unwrap().clear();
    Ok(())
}

/// 当前监听路径
#[tauri::command]
pub fn get_watching_path(state: State<'_, WatcherState>) -> Result<String, String> {
    let last_path = state.last_path.lock().unwrap();
    Ok(last_path.clone().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_config_defaults_are_safe() {
        let cfg = WatcherConfig::default();
        assert_eq!(cfg.max_depth, 3);
        assert_eq!(cfg.debounce, Duration::from_millis(500));
    }

    #[test]
    fn watcher_state_default_is_empty() {
        let s = WatcherState::default();
        assert!(s.watcher.lock().unwrap().is_none());
        assert!(s.last_path.lock().unwrap().is_none());
        assert!(s.last_event_at.lock().unwrap().is_empty());
    }
}