//! 思维导图板块（mind_app）：2026-11-08 从 z-biz-tool-mind 仓搬入。
//!
//! 与 worker_app 同构：板块的每个配置文件读写、日志、崩溃上报等能力
//! 都挂在 `crate::mind_app::*` 下，命令在主 `invoke_handler` 注册，
//! `attach` 只 manage 状态并跑初始化。

pub mod ai;
pub mod backup;
pub mod commands; // 命令从主 invoke_handler 注册，须 pub 否则 lib.rs 引用不到
pub mod config;
pub mod crash;
pub mod license;
pub mod log;
pub mod net;
pub mod openfile;
pub mod paths;
pub mod quota;
pub mod recent;
pub mod secret;
pub mod sso;

/// 把思维导图板块的状态挂到 file 的 Tauri builder 上。
///
/// 命令**不在这里注册**，而是全部放在 file lib.rs 的主 invoke_handler 里
/// （同一个 Tauri 宏展开一次，避免重复 `__cmd__` 静态量）。
pub fn attach(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    // 日志级别/代理/崩溃开关这几个配置必须在命令被调用前就位。
    // 这里用 std::sync::Once 只初始化一次 —— attach 每次启动调用一回。
    init_runtime();

    builder
        // 文件关联打开（双击 .emmx）的待开队列。
        .manage(openfile::Pending::default())
        // SSO 登录态：回环回调服务器 + OS 密钥库，token 不落 localStorage。
        .manage(sso::SsoState::default())
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

// ─────────────────────────────────────────────────────────────────────────────
// 测试用的进程级配置目录隔离（从 z-biz-tool-mind 的 crate 根一并搬入）。
//
// 配置目录靠环境变量 Z_MIND_CONFIG_DIR 指定，而环境变量是整个测试进程共享的。
// 各模块各留一把 GUARD 不够：并行时一个测试刚 set_var 指到自己的临时目录，
// 另一个就把它改走了。所以锁放在这里（mind_app 模块层），所有子模块共用，
// 并让 log::log() 在写之前断言「本线程持锁了吗」，把随机 flaky 变成当场失败。
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
static CONFIG_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

// 用 // 而不是 ///：doc 注释挂在 thread_local! 宏调用上是「unused doc comment」。
#[cfg(test)]
thread_local! {
    static CONFIG_ENV_LOCK_HELD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 持有配置目录锁的守卫。Drop 时清掉「本线程持锁」标记。
#[cfg(test)]
pub(crate) struct ConfigEnvGuard {
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for ConfigEnvGuard {
    fn drop(&mut self) {
        CONFIG_ENV_LOCK_HELD.with(|c| c.set(false));
    }
}

/// 本线程是否正持有配置目录锁（写日志前要问一句）。
#[cfg(test)]
pub(crate) fn config_env_lock_held() -> bool {
    CONFIG_ENV_LOCK_HELD.with(|c| c.get())
}

#[cfg(test)]
fn isolated_config_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "z-mind-{}-{}-{}",
        tag,
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::env::set_var("Z_MIND_CONFIG_DIR", &dir);
    dir
}

/// 拿锁 + 指向一个唯一临时配置目录，返回（守卫，目录）。
/// 顺序必须是先拿锁、再改环境变量。
#[cfg(test)]
pub(crate) fn isolated_sandbox(tag: &str) -> (ConfigEnvGuard, std::path::PathBuf) {
    let g = lock_config_env();
    let dir = isolated_config_dir(tag);
    (g, dir)
}

#[cfg(test)]
fn lock_config_env() -> ConfigEnvGuard {
    // 某个测试 panic 会把锁毒化；锁里只有 ()，恢复即可。
    let g = CONFIG_ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    CONFIG_ENV_LOCK_HELD.with(|c| c.set(true));
    ConfigEnvGuard { _guard: g }
}