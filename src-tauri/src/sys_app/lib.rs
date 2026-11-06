//! 系统监控板块（2026-11-06 从 `z-biz-tool-sys` 仓整体搬入）。
//!
//! 为什么是「搬进 file 当第二个板块」而不是继续独立成 app：
//! 家族里「系统监控 + 系统清理 + 大文件扫描 + 进程管理」这几件事，和文件管理器
//! 是同一类活 —— 用户在两处之间来回切只为了看「谁占着这个盘 / 这堆缓存能不能删」。
//! file 已经有活动栏（每个能力一个图标）这个落点形态，加一块比再装一个 app 更省事。
//!
//! 挂载方式照 `db_app` 的先例：整棵模块树挂在 `crate::sys_app::*` 下，
//! file 的 `lib.rs` 只做三件事 —— 声明模块、注册命令、把状态与启动钩子接上。
//!
//! **和原来独立 app 的唯一区别**：这里不再有 `run()`（Tauri Builder 归 file 管），
//! 换成 `attach()` + `startup()` 两段，分别对应「Builder 阶段能做的事」和
//! 「必须有 AppHandle 才能做的事」。

mod agent;
mod alert;
mod cleanup;
pub mod commands;
#[cfg(test)]
mod contract_fixtures;
mod error;
mod export;
mod history;
mod log_sanitize;
mod monitor;
mod netinfo;
mod notify;
mod observe;
mod platform;
mod prefs;
mod safety;
mod startup;

use tauri::Manager;

/// 把本板块的全局状态挂到 Builder 上。必须在 `file::run()` 里、`build()` 之前调用。
///
/// 拆成独立函数而不是直接往 file 的 `run()` 里塞几行 `manage`：采集服务在
/// `new()` 之后就要 `publish()` 一次（那是给 `get_metrics_snapshot` 读的初始快照，
/// 晚一步前端首帧就拿不到值），这两步必须挨着写才不会有人漏掉后半句。
pub fn attach(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let service = monitor::MonitorService::new();
    service.publish();
    builder
        .manage(service)
        // 告警配置：采集循环里读（判阈值）、`get_alert_config` 里读写，两边同一份。
        .manage(alert::AlertState::default())
        // 系统通知的投递记账：循环里写、`notify_status` 里读。
        .manage(notify::NotifyState::default())
}

/// 启动钩子：历史存储与采集循环。必须在 file 的 `setup()` 里调用。
///
/// 历史库路径要靠 `AppHandle` 解析（走 Tauri 的 app_local_data_dir），
/// 所以不能放进 `attach()` —— Builder 阶段还没有 AppHandle。
pub fn startup(app: &tauri::AppHandle) {
    // 历史存储只在启动时解析一次：采集循环拿写入端，command 拿只读端。
    let store = history::store_for(app);
    app.manage(history::HistoryState(store.clone()));
    // 告警历史同理：循环里写、`get_alert_history` 里读，各自持一份路径相同的句柄。
    let alert_store = history::alert_store_for(app);
    app.manage(history::AlertHistoryState(alert_store.clone()));

    // 状态是从 attach() 里 manage 进来的，这里取回来交给采集循环。
    // 取不到就说明 attach() 没被调用 —— 那是接线错误，不该静默跳过，
    // 否则表现成「界面永远停在正在连接后端采集器」，排查起来毫无头绪。
    let Some(service) = app.try_state::<monitor::MonitorService>() else {
        eprintln!("[sys] 采集服务未注册：file 的 run() 里漏调了 sys_app::attach()");
        return;
    };
    let Some(alert_state) = app.try_state::<alert::AlertState>() else {
        eprintln!("[sys] 告警状态未注册，采集循环跳过告警判定");
        return;
    };
    let Some(notify_state) = app.try_state::<notify::NotifyState>() else {
        eprintln!("[sys] 通知状态未注册，采集循环跳过系统通知");
        return;
    };

    service.inner().clone().spawn(
        app.clone(),
        store,
        alert_store,
        alert_state.0.clone(),
        notify_state.inner().clone(),
    );
}
