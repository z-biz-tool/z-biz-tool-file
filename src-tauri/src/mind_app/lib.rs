//! 思维导图板块（mind_app）：2026-11-08 从 z-biz-tool-mind 仓搬入。
//!
//! 与 worker_app 同构：板块的每个配置文件读写、日志、崩溃上报等能力
//! 都挂在 `crate::mind_app::*` 下，命令在主 `invoke_handler` 注册，
//! `attach` 只 manage 状态并跑初始化。

pub mod backup;
pub mod commands; // 命令从主 invoke_handler 注册，须 pub 否则 lib.rs 引用不到
pub mod config;
pub mod crash;
pub mod log;
pub mod net;
pub mod openfile;
pub mod paths;
pub mod recent;
pub mod secret;

/// 把思维导图板块的状态挂到 file 的 Tauri builder 上。
///
/// 命令**不在这里注册**，而是全部放在 file lib.rs 的主 invoke_handler 里
/// （同一个 Tauri 宏展开一次，避免重复 `__cmd__` 静态量）。
pub fn attach(
    mut builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    // 日志级别/代理/崩溃开关这几个配置必须在命令被调用前就位。
    // 这里用 std::sync::Once 只初始化一次 —— attach 每次启动调用一回。
    init_runtime();

    builder.manage(openfile::Pending::default())
}

/// 运行前初始化：读配置配好日志、应用代理、装崩溃钩子。
/// 这些在 file 里每个板块都有自己一份（互不干扰），且只看自身 config.json。
fn init_runtime() {
    let cfg = config::read_config();
    let level = log::configure_from(&cfg);
    log::log("info", "config", &format!("日志级别 = {level}"));
    match net::install(&cfg) {
        Ok(st) => log::log("info", "net", &st.message),
        Err(e) => log::log(
            "error",
            "net",
            &format!("代理设置无法应用，已按跟随系统启动: {e}"),
        ),
    }
    let crash_on = crash::configure_from(&cfg);
    crash::install_panic_hook();
    log::log(
        "debug",
        "config",
        &format!("崩溃记录 = {}", if crash_on { "开" } else { "关" }),
    );
    log::prune();
}