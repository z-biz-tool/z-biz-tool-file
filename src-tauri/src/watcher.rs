use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// 文件变化事件
#[derive(Debug, Clone, Serialize)]
pub struct FileChangeEvent {
    pub path: String,
    pub kind: String, // create / modify / remove
}

/// 全局监听器状态
pub struct WatcherState {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    last_path: Mutex<Option<String>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            last_path: Mutex::new(None),
        }
    }
}

/// 启动文件监听
#[tauri::command]
pub fn start_watching(
    path: String,
    state: State<'_, WatcherState>,
    app: AppHandle,
) -> Result<(), String> {
    let watch_path = Path::new(&path);
    if !watch_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    // 停止旧监听器
    {
        let mut watcher_guard = state.watcher.lock().unwrap();
        if let Some(old) = watcher_guard.take() {
            drop(old);
        }
    }

    {
        let mut last_path = state.last_path.lock().unwrap();
        *last_path = Some(path.clone());
    }

    let app_clone = app.clone();
    let path_for_filter = path.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            for event_path in event.paths.iter() {
                let path_str = event_path.to_string_lossy().to_string();
                if !path_str.starts_with(&path_for_filter) {
                    continue;
                }
                let kind = match event.kind {
                    EventKind::Create(_) => "create",
                    EventKind::Modify(_) => "modify",
                    EventKind::Remove(_) => "remove",
                    _ => continue,
                };
                let evt = FileChangeEvent {
                    path: path_str,
                    kind: kind.to_string(),
                };
                let _ = app_clone.emit("file-change", evt);
            }
        }
    })
    .map_err(|e| format!("创建监听器失败: {}", e))?;

    watcher
        .watch(watch_path, RecursiveMode::NonRecursive)
        .map_err(|e| format!("启动监听失败: {}", e))?;

    {
        let mut watcher_guard = state.watcher.lock().unwrap();
        *watcher_guard = Some(watcher);
    }

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
    Ok(())
}

/// 当前监听路径
#[tauri::command]
pub fn get_watching_path(state: State<'_, WatcherState>) -> Result<String, String> {
    let last_path = state.last_path.lock().unwrap();
    Ok(last_path.clone().unwrap_or_default())
}
