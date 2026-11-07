//! AI 任务看板板块（2026-11-07 从 z-biz-tool-worker 仓搬入）。
//!
//! 和 db_app / sys_app 完全同一套并入模式：
//! - file 是唯一的 app，worker 独立运行时的 `run()` 不再存在；
//! - 这里只给 file 的 lib.rs 暴露两个钩子：
//!   - `attach(builder) -> Builder`：manage 状态、注册 36 个命令（`zbiz_take_pending`
//!     跳过 —— file 家族统一深链命令已有一份同名同义的，重复注册会让 Tauri 启动 panic）；
//!   - `startup()`：在 setup 里调用，负责拉起 agent-proxy 子进程。
//!
//! ⚠️ agent-proxy（连接本地 CLI 的守护进程）只有在用户真的进数据库……不，进
//! worker 这个板块时才应该有？—— 目前没有前端 active 信号，所以它和无条件常驻的
//! 采集循环一样：只要 app 起来就 spawn。**这跟 sys 的采集闸门是同一类问题**，
//! 若要省资源需给前端加一个「板块是否在前台」的开关，见 startup() 里的注释。

mod agent_proxy;
pub mod agent_session; // 命令从主 invoke_handler 注册，须 pub 否则 lib.rs 引用不到
pub mod commands; // 命令从主 invoke_handler 注册，须 pub 否则 lib.rs 引用不到
mod db;
mod models;
mod storage;
mod task_state;

use tauri::Manager;

/// 把 worker 板块的状态挂到 file 的 Tauri builder 上。
/// `zbiz_take_pending` 有意跳过：file 的 lib.rs 已经注册了同名的家族统一深链命令。
///
/// 命令**不在这里注册**，而是全部放在 file lib.rs 的主 invoke_handler 里
/// （和 sys_app 同一个模式）。如果在 attach 里再开一个 generate_handler 注册
/// 同一批命令，Tauri 宏会把每个命令展开成同名的 `__cmd__xxx` 静态量，
/// 两个 handler 一碰就报 `defined multiple times`。
pub fn attach(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(agent_proxy::AgentProxyHandle(std::sync::Mutex::new(None)))
        .manage(agent_session::AgentSessionState::load())
}

/// 在 setup 里调用，拉起 agent-proxy 守护进程。
///
/// ⚠️ 与 sys 的采集闸门是同一类「常驻但未必被用到」的资源：
/// 目前只要 file 启动，agent-proxy 就会被 spawn（它负责连本地 CLI 的健壮性，
/// 启动失败只打 eprintln 不挡主流程）。worker 板块若也需要「按需启停」，
/// 参考 sys_app 的 `active` 闸门给前端加一个板块前台信号，这里在 ineffective
/// 时 kill 子进程、active 时重新 spawn。当前先保持与独立运行时一致（常驻），
/// 因为 agent-proxy 本身轻量、且冷启动拉起来比首次点进板块再拉体验好。
pub fn startup(app: &tauri::AppHandle) {
    match agent_proxy::spawn() {
        Ok(child) => {
            let state = app.state::<agent_proxy::AgentProxyHandle>();
            *state.0.lock().expect("agent-proxy mutex poisoned") = Some(child);
        }
        Err(e) => {
            eprintln!("[worker/agent-proxy] failed to start: {}", e);
        }
    }
}

/// 退出时清理 agent-proxy 子进程（在 RunEvent::Exit 里调用）。
pub fn shutdown(app_handle: &tauri::AppHandle) {
    let child_opt = {
        let state = app_handle.state::<agent_proxy::AgentProxyHandle>();
        let mut guard = state.0.lock().expect("agent-proxy mutex poisoned");
        let taken = guard.take();
        drop(guard);
        taken
    };
    if let Some(mut child) = child_opt {
        agent_proxy::kill(&mut child);
    }
}