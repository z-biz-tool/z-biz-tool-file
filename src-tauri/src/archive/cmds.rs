//! 归档引擎的 Tauri 命令层。
//!
//! ## 为什么耗时操作返回的是 job_id 而不是结果
//!
//! 老的 `extract_archive` 是"发一条 invoke，然后转圈等它回来"。7.4 GB 的 RAR 解到一半时
//! 用户既看不到进度也停不下来，只能去任务管理器杀进程——而这台机器上杀进程曾经连带触发过
//! Autodesk 许可锁死（见 [[feedback-never-touch-dcc-app-lifecycle]]）。所以现在：
//! 命令做完**同步体检**就立刻返回 job id，真正的活在 blocking 线程里跑，进度走
//! `archive-progress` 事件，取消走 `archive_cancel`。
//!
//! ## 为什么体检要放在起 job 之前
//!
//! "需要密码"、"这是分卷的后续卷"、"压缩包在被压目录里面"这几类失败是**立刻**就能判出来的。
//! 放到任务里报，前端就得先建一个进度条再拆掉，中间还会闪一下红色错误——用户看到的是
//! "任务失败了"，而实际上是"你还没输密码"。同步返回 `ArchiveError::NeedPassword`
//! 让前端能直接弹密码框。
//!
//! 体检自己也要读归档头部（上万条目的中央目录不是免费的），所以它跑在 `spawn_blocking`
//! 里、`await` 之后才决定起不起任务。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Manager, State};

use super::format::{self, FormatOption};
use super::job::{new_job_id, Jobs, Kind, Progress, Reporter};
use super::types::{ArchiveInfo, CreateOptions, ExtractOptions, ProbeResult, Stats};
use super::ArchiveError;

/// 重名探测结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictReport {
    /// 真实冲突文件数（`paths` 可能被截断到 `super::CONFLICT_PREVIEW_CAP`）
    pub total: usize,
    pub paths: Vec<String>,
    /// 目标目录本身已存在。"解压到 xxx" 时几乎总是如此，前端据此把措辞从
    /// "有 N 个文件会被覆盖" 调成 "目录已存在，其中 N 个文件重名"
    pub dest_exists: bool,
}

// ============================================================================
// 任务骨架
// ============================================================================

/// 起一个后台归档任务，立刻返回 job_id。
///
/// 两层 spawn 不是多余的：外层 `spawn` 让命令本身不阻塞 IPC 线程，内层 `spawn_blocking`
/// 把真正的磁盘活放到 blocking 线程池——解压是纯同步 IO，跑在异步执行器的工作线程上
/// 会把同一条执行器上的其它任务一起饿死。
fn spawn_job<F>(app: &AppHandle, kind: Kind, archive: String, dest: String, work: F) -> String
where
    F: FnOnce(&mut Reporter, &AtomicBool) -> Result<Stats, String> + Send + 'static,
{
    let job_id = new_job_id(kind);
    // 先登记再返回 id，否则前端拿到 id 立刻点取消会撞上"没这个任务"
    app.state::<Jobs>().flag(&job_id);

    let app2 = app.clone();
    let id2 = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let (reporter, cancel) = Reporter::new(app2, id2, kind, archive, dest);
            drive(reporter, cancel, kind, work);
        })
        .await;
    });
    job_id
}

/// 跑一次任务并把结果翻译成前端要的三种终态：done / cancelled / error。
fn drive<F>(mut reporter: Reporter, cancel: Arc<AtomicBool>, kind: Kind, work: F)
where
    F: FnOnce(&mut Reporter, &AtomicBool) -> Result<Stats, String>,
{
    let started = Instant::now();
    match work(&mut reporter, &cancel) {
        Ok(mut s) => {
            // 后端大多自己填了 elapsed_ms，但漏填一个就会显示"用时 0.0 秒"，这里兜底
            if s.elapsed_ms == 0 {
                s.elapsed_ms = started.elapsed().as_millis() as u64;
            }
            // 完整性校验是唯一的例外：查出错位就必须判失败，不能绿色收尾。
            // 解压/压缩里"个别条目出错"是正常的部分成功（用户能看到完整列表再决定怎么办），
            // 但"测试压缩包"只回答一个问题——这个包还能不能用。让它以 done 收尾，
            // 用户扫一眼任务列表看到绿色就关掉了，坏包照样被拷进备份里。
            if kind == Kind::Test && !s.errors.is_empty() {
                reporter.fail(&test_failure_message(&s));
                return;
            }
            reporter.finish(&done_message(&s));
        }
        // 以标志位为准而不是解析错误文本：用户按了取消之后，后端可能正好撞上
        // 一个别的 IO 错误，这时候他想看到的是"已取消"，不是一条莫名其妙的报错
        Err(_) if cancel.load(Ordering::Relaxed) => reporter.cancel(),
        Err(e) => reporter.fail(&e),
    }
}

/// 校验失败时的话术。出错条目的取前 3 条规则和 `done_message` 保持一致，
/// 用户不必再点开任务详情就知道坏在哪。
fn test_failure_message(s: &Stats) -> String {
    let head: Vec<&str> = s.errors.iter().take(3).map(|e| e.as_str()).collect();
    format!(
        "校验失败：{} 个条目损坏（{}{}）",
        s.errors.len(),
        head.join("；"),
        if s.errors.len() > 3 { " …" } else { "" }
    )
}

fn done_message(s: &Stats) -> String {
    let mut parts = vec![
        format!("{} 个条目", s.entries_done),
        human_bytes(s.bytes_done),
    ];
    if s.skipped > 0 {
        parts.push(format!("跳过 {}", s.skipped));
    }
    if !s.errors.is_empty() {
        // 只带前 3 条：完整列表在前端的任务详情里看，事件载荷不该无上限地长
        let head: Vec<&str> = s.errors.iter().take(3).map(|s| s.as_str()).collect();
        parts.push(format!(
            "{} 个条目出错（{}{}）",
            s.errors.len(),
            head.join("；"),
            if s.errors.len() > 3 { " …" } else { "" }
        ));
    }
    parts.push(format!("用时 {:.1} 秒", s.elapsed_ms as f64 / 1000.0));
    parts.join("，")
}

/// 和资源管理器一致的 1024 进制，但沿用 KB/MB/GB 的写法（Windows 就是这么显示的）。
fn human_bytes(n: u64) -> String {
    const K: f64 = 1024.0;
    let units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let mut f = n as f64;
    let mut i = 0;
    while f >= K && i < units.len() - 1 {
        f /= K;
        i += 1;
    }
    if i == 0 {
        format!("{} B", n)
    } else {
        format!("{:.1} {}", f, units[i])
    }
}

// ============================================================================
// 查询类命令
// ============================================================================

/// 右键菜单渲染前调：这是不是归档？能干什么？只读文件头几百字节。
#[tauri::command]
pub fn archive_probe(path: String) -> Result<ProbeResult, String> {
    let p = crate::path_guard::readable(&path)?;
    Ok(super::probe(&p))
}

/// 打开归档并列出全部条目。
#[tauri::command]
pub async fn archive_info(
    path: String,
    password: Option<String>,
) -> Result<ArchiveInfo, ArchiveError> {
    let p = crate::path_guard::readable(&path).map_err(ArchiveError::from)?;
    let pw = password.filter(|s| !s.is_empty());
    tauri::async_runtime::spawn_blocking(move || super::info(&p, pw.as_deref()))
        .await
        .map_err(|e| ArchiveError::failed(e.to_string()))?
}

/// 解压前的重名探测。前端拿到结果再决定 `overwrite` 策略——引擎是同步阻塞的，
/// 中途弹窗会把整条解压停住。
#[tauri::command]
pub async fn archive_conflicts(
    path: String,
    dest: String,
    options: ExtractOptions,
) -> Result<ConflictReport, ArchiveError> {
    let src = crate::path_guard::readable(&path).map_err(ArchiveError::from)?;
    // dest 此刻通常还不存在，必须用 writable（它按"最近的已存在祖先"校验并照样拆符号链接）
    let dst = crate::path_guard::writable(&dest).map_err(ArchiveError::from)?;
    let dest_exists = Path::new(&dst).exists();
    let (total, paths) =
        tauri::async_runtime::spawn_blocking(move || super::conflicts(&src, &dst, &options))
            .await
            .map_err(|e| ArchiveError::failed(e.to_string()))??;
    Ok(ConflictReport {
        total,
        paths,
        dest_exists,
    })
}

/// "新建压缩"对话框的数据源。写死在 Rust 侧是为了让能力表和实现永远是同一份，
/// 不会出现前端列了个后端根本不会写的格式。
#[tauri::command]
pub fn archive_formats() -> Vec<FormatOption> {
    format::writable_formats()
}

/// 文件选择对话框的过滤器用。含只读格式（rar/cab），因为"打开"也要能选到它们。
#[tauri::command]
pub fn archive_extensions() -> Vec<String> {
    format::all_extensions()
        .into_iter()
        .map(|s| s.to_string())
    .collect()
}

/// "解压到 <这个名字>" 的默认目录名。原来这段逻辑在前端手写了一串 if，
/// 加一种格式就要两边改；现在由后端算。
#[tauri::command]
pub fn archive_extract_dir_name(path: String) -> String {
    format::stem_for_extract(Path::new(&path))
}

// ============================================================================
// 任务类命令（立刻返回 job_id）
// ============================================================================

#[tauri::command]
pub async fn archive_extract(
    app: AppHandle,
    path: String,
    dest: String,
    options: ExtractOptions,
) -> Result<String, ArchiveError> {
    let src = crate::path_guard::readable(&path).map_err(ArchiveError::from)?;
    let dst = crate::path_guard::writable(&dest).map_err(ArchiveError::from)?;
    let pw = options.password.clone().filter(|s| !s.is_empty());

    let probe_src = src.clone();
    let det = tauri::async_runtime::spawn_blocking(move || super::preflight(&probe_src, pw.as_deref()))
        .await
        .map_err(|e| ArchiveError::failed(e.to_string()))??;

    let (a, d) = (src.display().to_string(), dst.display().to_string());
    Ok(spawn_job(&app, Kind::Extract, a, d, move |rep, cancel| {
        super::extract(&src, &det, &dst, &options, rep, cancel)
    }))
}

#[tauri::command]
pub async fn archive_create(
    app: AppHandle,
    sources: Vec<String>,
    dest: String,
    options: CreateOptions,
) -> Result<String, ArchiveError> {
    let srcs = resolve_sources(&sources)?;
    let dst = crate::path_guard::writable(&dest).map_err(ArchiveError::from)?;

    // 目标文件已存在就拒绝：静默覆盖一个同名压缩包是最容易丢数据的一种失败。
    // 要往现有包里加东西是 archive_add，不是这条。
    if dst.exists() {
        return Err(ArchiveError::failed(format!(
            "目标已存在: {}。换个名字，或先删掉旧的。",
            dst.display()
        )));
    }

    let probe_srcs = srcs.clone();
    let probe_dst = dst.clone();
    let probe_opts = options.clone();
    tauri::async_runtime::spawn_blocking(move || {
        super::create_preflight(&probe_srcs, &probe_dst, &probe_opts)
    })
    .await
    .map_err(|e| ArchiveError::failed(e.to_string()))?
    .map_err(ArchiveError::failed)?;

    let (a, d) = (source_label(&srcs), dst.display().to_string());
    Ok(spawn_job(&app, Kind::Create, a, d, move |rep, cancel| {
        super::create(&srcs, &dst, &options, rep, cancel)
    }))
}

#[tauri::command]
pub async fn archive_add(
    app: AppHandle,
    archive: String,
    sources: Vec<String>,
    options: CreateOptions,
) -> Result<String, ArchiveError> {
    let arc = crate::path_guard::readable(&archive).map_err(ArchiveError::from)?;
    let srcs = resolve_sources(&sources)?;

    let probe_arc = arc.clone();
    let probe_srcs = srcs.clone();
    tauri::async_runtime::spawn_blocking(move || super::add_preflight(&probe_arc, &probe_srcs))
        .await
        .map_err(|e| ArchiveError::failed(e.to_string()))?
        .map_err(ArchiveError::failed)?;

    let (a, d) = (source_label(&srcs), arc.display().to_string());
    Ok(spawn_job(&app, Kind::Create, a, d, move |rep, cancel| {
        super::add(&arc, &srcs, &options, rep, cancel)
    }))
}

#[tauri::command]
pub async fn archive_test(
    app: AppHandle,
    path: String,
    password: Option<String>,
) -> Result<String, ArchiveError> {
    let src = crate::path_guard::readable(&path).map_err(ArchiveError::from)?;
    let pw = password.filter(|s| !s.is_empty());

    let probe_src = src.clone();
    let probe_pw = pw.clone();
    let det = tauri::async_runtime::spawn_blocking(move || {
        super::preflight(&probe_src, probe_pw.as_deref())
    })
    .await
    .map_err(|e| ArchiveError::failed(e.to_string()))??;

    let a = src.display().to_string();
    Ok(spawn_job(&app, Kind::Test, a, String::new(), move |rep, cancel| {
        super::test(&src, &det, pw.as_deref(), rep, cancel)
    }))
}

/// 请求取消。返回 false 表示没这个任务（已经结束并被清出账本，或 id 写错了）。
///
/// 取消是**协作式**的：只置一个标志位，后端在每写满一块（64 KB）时检查一次。
/// 所以大文件上可能要等一小会儿才真的停下，这是刻意的——中途砍断写入会留下
/// 半截文件，比多等几百毫秒糟得多。
#[tauri::command]
pub fn archive_cancel(jobs: State<'_, Jobs>, job_id: String) -> bool {
    jobs.cancel(&job_id)
}

/// 轮询任务状态。正常情况下前端听 `archive-progress` 事件就够了，这个是兜底：
/// 窗口重建、事件漏收、或者想拿最终结果时用它。
#[tauri::command]
pub fn archive_job_state(jobs: State<'_, Jobs>, job_id: String) -> Option<Progress> {
    jobs.snapshot(&job_id)
}

// ============================================================================
// 小工具
// ============================================================================

fn resolve_sources(sources: &[String]) -> Result<Vec<PathBuf>, ArchiveError> {
    if sources.is_empty() {
        return Err(ArchiveError::failed("没有要压缩的内容。"));
    }
    sources
        .iter()
        .map(|s| crate::path_guard::readable(s).map_err(ArchiveError::from))
        .collect()
}

/// 进度条上那一行"正在压缩 xxx"的标题。多个源时只显示第一个 + 数量，
/// 全列出来会把界面撑爆（右键 200 个文件压缩是常见操作）。
fn source_label(srcs: &[PathBuf]) -> String {
    let first = srcs
        .first()
        .map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .flatten()
        .unwrap_or_else(|| "?".to_string());
    match srcs.len() {
        // 0 项时也走这条：否则任务列表里会出现一句"? 等 0 项"，
        // 那是把一个不该发生的情况当成正常情况渲染给用户看
        0 | 1 => first,
        n => format!("{} 等 {} 项", first, n),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_bytes_uses_1024_and_picks_the_right_unit() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(1536), "1.5 KB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(human_bytes(7_516_192_768), "7.0 GB");
    }

    #[test]
    fn done_message_mentions_skips_errors_and_time() {
        let plain = Stats {
            entries_done: 12,
            bytes_done: 2048,
            elapsed_ms: 1500,
            ..Default::default()
        };
        let m = done_message(&plain);
        assert!(m.contains("12 个条目") && m.contains("2.0 KB") && m.contains("1.5 秒"), "{}", m);
        assert!(!m.contains("跳过") && !m.contains("出错"));

        let messy = Stats {
            entries_done: 3,
            bytes_done: 0,
            skipped: 2,
            errors: (0..5).map(|i| format!("坏条目 {}", i)).collect(),
            elapsed_ms: 0,
        };
        let m = done_message(&messy);
        assert!(m.contains("跳过 2"), "{}", m);
        assert!(m.contains("5 个条目出错"), "{}", m);
        assert!(m.contains("坏条目 2") && !m.contains("坏条目 3"), "只带前 3 条: {}", m);
        assert!(m.contains("…"), "{}", m);
    }

    #[test]
    fn test_failure_message_names_the_count_and_first_entries() {
        let one = Stats { errors: vec!["a.bin CRC 不符".into()], ..Default::default() };
        let m = test_failure_message(&one);
        assert_eq!(m, "校验失败：1 个条目损坏（a.bin CRC 不符）");

        let many = Stats {
            errors: (0..5).map(|i| format!("坏条目 {}", i)).collect(),
            ..Default::default()
        };
        let m = test_failure_message(&many);
        assert!(m.contains("5 个条目损坏"), "{}", m);
        assert!(m.contains("坏条目 2") && !m.contains("坏条目 3"), "只带前 3 条: {}", m);
        assert!(m.contains("…"), "{}", m);
    }

    #[test]
    fn source_label_collapses_long_selections() {
        let one = vec![PathBuf::from("D:/a/movie.mkv")];
        assert_eq!(source_label(&one), "movie.mkv");
        let many: Vec<PathBuf> = (0..200).map(|i| PathBuf::from(format!("D:/a/f{}", i))).collect();
        let l = source_label(&many);
        assert!(l.starts_with("f0 等 200 项"), "{}", l);
        assert_eq!(source_label(&[]), "?");
    }
}
