//! 批量操作的任务制：进度事件 + 协作式取消。
//!
//! ## 为什么不用「一条 invoke 跑完再返回」
//!
//! 删 1000 个文件、给 1000 个文件改名，这些活儿要几秒到几十秒。这段时间里如果界面
//! 只有一个转圈，用户既不知道到哪了，也**停不下来**——只能干等，或者去任务管理器杀进程。
//! 所以批量操作改成**任务制**：命令立刻返回 `operation_id`，进度走 `operation-progress`
//! 事件，取消走 `cancel_operation`。
//!
//! 这套约定与 `archive/job.rs` 是同一套（事件名不同、账本各自独立），不另起一套。
//!
//! ## 取消是真的停，不是「标记一下」
//!
//! 取消置的是 [`CancellationToken`] 里的一个标志位；批量循环在**每一项之前**看这个标志，
//! 看到就 `break`，剩下的一项都不碰。
//!
//! 这条是硬要求：如果取消只是打个标记然后把剩下的跑完，用户按了取消还会看着界面
//! 继续删文件——那比没有取消按钮更糟，因为它骗人。
//!
//! 停止延迟 = 一个条目本身的耗时。重命名/删除都是毫秒级，落在「取消后 ≤500ms 停止」
//! 的验收线内（见 `doc/优化方案/05_实施路线与任务拆解.md` T2-06）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::RenameOptions;

/// 进度事件名。前端 `src/hooks/operationController.ts` 里的同名常量必须与这里一致。
pub const PROGRESS_EVENT: &str = "operation-progress";

/// 进度事件的节流间隔。
///
/// 1000 个文件就是 1000 次 emit，WebView 的 JS 队列会被灌满，界面反而卡成幻灯片。
/// 按时间节流，但**开始与结束一定强制发一次**，保证用户看到的第一个和最后一个状态是准的。
const EMIT_INTERVAL_MS: u64 = 100;

// ============================================================================
// 取消令牌
// ============================================================================

/// 协作式取消令牌。
///
/// 名字与 `tokio_util::sync::CancellationToken` 一样，但**不引那个依赖**（本轮不新增
/// crates.io 依赖）：批量操作需要的全部语义就是「一个能被别处置位、这边随时读到的
/// 布尔标志」，自己写二十来行比拉一个依赖更划算。
///
/// 之所以还叫这个名字：台账里 T2-06 的实测依据写的是「全仓无 `cancel_operation`、
/// 无 `CancellationToken`」，这个类型就是那句话的后半截。
#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 请求取消。可重复调用，幂等。
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// 是否已被取消。批量循环在每一项之前问一次。
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

// ============================================================================
// 进度载荷
// ============================================================================

/// 批量操作的类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 批量重命名
    Rename,
    /// 批量永久删除
    Delete,
    /// 批量移到回收站
    Trash,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Rename => "rename",
            Kind::Delete => "delete",
            Kind::Trash => "trash",
        }
    }

    /// 解析前端传来的类型。认不出来返回 `None`，让命令层直接报错。
    ///
    /// 叫 `parse` 不叫 `from_str`：后者会被误当成 `std::str::FromStr::from_str`
    /// （那个签名是 `fn(&str) -> Result<Self, _>`，和这里的 `Option` 不是一回事）。
    ///
    /// **不兜底成某个默认类型**：默默拿另一种语义去动用户的文件（把「永久删除」
    /// 当成「移到回收站」，或者反过来）是这个仓里最贵的一类错误。
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "rename" => Some(Kind::Rename),
            "delete" => Some(Kind::Delete),
            "trash" => Some(Kind::Trash),
            _ => None,
        }
    }
}

/// 发给前端的进度载荷。字段名是 camelCase（Rust 侧统一挂了 `rename_all`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub operation_id: String,
    pub kind: String,
    /// running / done / cancelled / error
    pub phase: String,
    /// 一共要处理多少项
    pub total: u64,
    /// 已经处理过多少项（取消后剩下的项不算）
    pub processed: u64,
    pub succeeded: u64,
    pub failed: u64,
    /// 当前正在处理的文件名，用于界面上那行「正在删除 xxx」
    pub current: String,
    /// 0..100
    pub percent: f64,
    pub message: String,
    /// 失败项的说明
    pub errors: Vec<String>,
}

impl Progress {
    fn new(operation_id: String, kind: Kind, total: u64) -> Self {
        Progress {
            operation_id,
            kind: kind.as_str().to_string(),
            phase: "running".to_string(),
            total,
            processed: 0,
            succeeded: 0,
            failed: 0,
            current: String::new(),
            percent: 0.0,
            message: String::new(),
            errors: Vec::new(),
        }
    }
}

// ============================================================================
// 进度事件的出口
// ============================================================================

/// 进度事件的出口。
///
/// 生产环境是 `AppHandle`（`emit` 到 WebView）；单元测试里没有 WebView，
/// 于是换成一个把事件收进内存的实现——**驱动的是同一条生产代码路径**。
pub trait ProgressSink: Send + Sync {
    fn emit(&self, progress: &Progress);
}

/// 发到 WebView。
struct AppSink(AppHandle);

impl ProgressSink for AppSink {
    fn emit(&self, progress: &Progress) {
        // 发不出去（窗口已关）不该让整个操作失败：进度只是给人看的
        let _ = self.0.emit(PROGRESS_EVENT, progress.clone());
    }
}

/// 测试用的收集器：把每次发出的进度按顺序收进内存。
///
/// **只在测试构建里存在**（`#[cfg(test)]`）：它的唯一用途是让单元测试能断言
/// 「进度事件真的发出去了、内容对不对」，生产构建里没有它 ⇒ clippy 的 dead_code
/// 不会盯着一段永远不会被调用的脚手架。
#[cfg(test)]
#[derive(Default)]
pub struct CollectingSink {
    events: Mutex<Vec<Progress>>,
}

#[cfg(test)]
impl CollectingSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// 已发出的全部事件（按发出顺序）。
    pub fn events(&self) -> Vec<Progress> {
        self.events.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.events.lock().map(|g| g.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
impl ProgressSink for CollectingSink {
    fn emit(&self, progress: &Progress) {
        if let Ok(mut g) = self.events.lock() {
            g.push(progress.clone());
        }
    }
}

// ============================================================================
// 任务账本
// ============================================================================

/// 一个批量操作的控制块。
struct Ctl {
    token: CancellationToken,
    done: AtomicBool,
    snapshot: Mutex<Option<Progress>>,
}

impl Default for Ctl {
    fn default() -> Self {
        Ctl {
            token: CancellationToken::new(),
            done: AtomicBool::new(false),
            snapshot: Mutex::new(None),
        }
    }
}

/// 全局任务表。放进 Tauri 的 managed state。
#[derive(Default)]
pub struct Operations(Mutex<HashMap<String, Arc<Ctl>>>);

impl Operations {
    /// 取回（没有就建）某个任务的控制块。
    fn acquire(&self, id: &str) -> Arc<Ctl> {
        let mut m = match self.0.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // 这是内存里的账本，不能只进不出。留着没结束的，清掉已结束的。
        if m.len() > 200 {
            m.retain(|_, c| !c.done.load(Ordering::Relaxed));
        }
        m.entry(id.to_string())
            .or_insert_with(|| Arc::new(Ctl::default()))
            .clone()
    }

    /// 取回（没有就建）某个任务的取消令牌。
    ///
    /// 幂等是刻意的：命令在返回 `operation_id` **之前**先调一次把条目建出来，
    /// 后台工作线程里再调一次拿到同一个令牌。否则前端刚收到 id 就点取消，
    /// 会撞上「没这个任务」——窗口只有几毫秒，但用户点得比这快。
    pub fn token(&self, id: &str) -> CancellationToken {
        self.acquire(id).token.clone()
    }

    /// 请求取消。返回 false 表示没这个任务（已经结束并被清出账本，或 id 写错了）。
    pub fn cancel(&self, id: &str) -> bool {
        match self.0.lock() {
            Ok(m) => match m.get(id) {
                Some(ctl) => {
                    ctl.token.cancel();
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    /// 拿某个任务的最新快照。事件漏收时的兜底。
    pub fn snapshot(&self, id: &str) -> Option<Progress> {
        self.0.lock().ok()?.get(id)?.snapshot.lock().ok()?.clone()
    }
}

// ============================================================================
// 进度上报器
// ============================================================================

/// 一次批量操作的进度上报器。
pub struct Reporter {
    ctl: Arc<Ctl>,
    sink: Option<Arc<dyn ProgressSink>>,
    progress: Progress,
    last_emit: Instant,
    throttle: Duration,
}

impl Reporter {
    /// 生产入口：事件发到 WebView。
    ///
    /// 返回值第二个是取消令牌：交给批量循环，每一项之前问一次。
    pub fn new(
        app: AppHandle,
        ops: &Operations,
        operation_id: String,
        kind: Kind,
        total: u64,
    ) -> (Self, CancellationToken) {
        let ctl = ops.acquire(&operation_id);
        let token = ctl.token.clone();
        (
            Self::build(
                ctl,
                Some(Arc::new(AppSink(app))),
                operation_id,
                kind,
                total,
                Duration::from_millis(EMIT_INTERVAL_MS),
            ),
            token,
        )
    }

    /// 不挂事件出口的上报器：只更新内存里的快照。
    /// 单元测试里没有真实的 AppHandle，用这个。
    pub fn detached(
        ops: &Operations,
        operation_id: String,
        kind: Kind,
        total: u64,
    ) -> (Self, CancellationToken) {
        let ctl = ops.acquire(&operation_id);
        let token = ctl.token.clone();
        (
            Self::build(
                ctl,
                None,
                operation_id,
                kind,
                total,
                Duration::from_millis(EMIT_INTERVAL_MS),
            ),
            token,
        )
    }

    /// 指定事件出口的上报器（测试用：把事件收进内存列表）。
    ///
    /// **只在测试构建里存在**（`#[cfg(test)]`）：生产路径走 `Reporter::new`（挂 WebView
    /// 出口）与 `Reporter::detached`（不挂出口）。这个构造器只为让单元测试能断言
    /// 「事件真的发出去了」，留着它进生产构建只会被 dead_code 盯着。
    #[cfg(test)]
    pub fn with_sink(
        sink: Arc<dyn ProgressSink>,
        ops: &Operations,
        operation_id: String,
        kind: Kind,
        total: u64,
    ) -> (Self, CancellationToken) {
        let ctl = ops.acquire(&operation_id);
        let token = ctl.token.clone();
        (
            Self::build(
                ctl,
                Some(sink),
                operation_id,
                kind,
                total,
                Duration::from_millis(EMIT_INTERVAL_MS),
            ),
            token,
        )
    }

    fn build(
        ctl: Arc<Ctl>,
        sink: Option<Arc<dyn ProgressSink>>,
        operation_id: String,
        kind: Kind,
        total: u64,
        throttle: Duration,
    ) -> Reporter {
        Reporter {
            ctl,
            sink,
            progress: Progress::new(operation_id, kind, total),
            last_emit: Instant::now(),
            throttle,
        }
    }

    /// 改节流间隔。`Duration::ZERO` = 每项都发（测试用）。
    ///
    /// **只在测试构建里存在**（`#[cfg(test)]`）：生产的节流间隔由 `EMIT_INTERVAL_MS`
    /// 固定，没有运行时调它的入口；留着它进生产构建只会被 dead_code 盯着。
    #[cfg(test)]
    pub fn set_throttle(&mut self, throttle: Duration) {
        self.throttle = throttle;
    }

    /// 正在处理哪一项。
    pub fn set_current(&mut self, name: &str) {
        self.progress.current = name.to_string();
        self.emit(false);
    }

    /// 一项做成了。
    pub fn item_ok(&mut self, name: &str) {
        self.progress.processed += 1;
        self.progress.succeeded += 1;
        self.progress.current = name.to_string();
        self.recompute_percent();
        self.emit(false);
    }

    /// 一项失败了。失败不中断整批：后面的项继续做，用户最后看汇总。
    pub fn item_err(&mut self, name: &str, error: String) {
        self.progress.processed += 1;
        self.progress.failed += 1;
        self.progress.current = name.to_string();
        self.progress.errors.push(format!("{}: {}", name, error));
        self.recompute_percent();
        self.emit(false);
    }

    fn recompute_percent(&mut self) {
        self.progress.percent = if self.progress.total > 0 {
            (self.progress.processed as f64 / self.progress.total as f64 * 100.0).min(100.0)
        } else {
            100.0
        };
    }

    fn emit(&mut self, force: bool) {
        let now = Instant::now();
        if !force && now.duration_since(self.last_emit) < self.throttle {
            // 不发事件也要更新快照：前端轮询 operation_state 时要拿到最新值
            self.store_snapshot();
            return;
        }
        self.last_emit = now;
        self.recompute_percent();
        self.store_snapshot();
        if let Some(sink) = &self.sink {
            sink.emit(&self.progress);
        }
    }

    fn store_snapshot(&self) {
        if let Ok(mut s) = self.ctl.snapshot.lock() {
            *s = Some(self.progress.clone());
        }
    }

    /// 正常结束（含部分失败：failed 计数与 errors 列表已经带在载荷里）。
    ///
    /// 百分比按**实际处理过的项**算，不在这里硬写 100：只有全部处理完时它才正好是 100。
    pub fn finish(mut self, message: &str) {
        self.progress.phase = "done".to_string();
        self.progress.message = message.to_string();
        self.emit(true);
        self.ctl.done.store(true, Ordering::Relaxed);
    }

    /// 被取消。
    pub fn cancel(mut self) {
        self.progress.phase = "cancelled".to_string();
        self.progress.message = "已取消".to_string();
        self.emit(true);
        self.ctl.done.store(true, Ordering::Relaxed);
    }

    /// 整批没跑起来。
    pub fn fail(mut self, error: &str) {
        self.progress.phase = "error".to_string();
        self.progress.message = error.to_string();
        self.emit(true);
        self.ctl.done.store(true, Ordering::Relaxed);
    }
}

// ============================================================================
// 批量循环
// ============================================================================

/// 一次批量操作的结算。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BatchOutcome {
    /// 实际处理过的项数（取消后剩下的项不算）
    pub processed: u64,
    pub succeeded: u64,
    pub failed: u64,
    /// 是否因为取消而提前收工
    pub cancelled: bool,
    pub errors: Vec<String>,
}

/// 跑一批条目。
///
/// **每一项之前先看取消标志**：已取消就 `break`，剩下的一项都不碰。
///
/// `work` 拿到「序号 + 路径」：序号是重命名 `auto_number` 模式要的（编号按选中顺序排），
/// 路径是这一项的绝对路径。
pub fn run_batch<F>(
    paths: &[String],
    token: &CancellationToken,
    reporter: &mut Reporter,
    mut work: F,
) -> BatchOutcome
where
    F: FnMut(usize, &str) -> Result<(), String>,
{
    let mut outcome = BatchOutcome::default();
    for (index, path) in paths.iter().enumerate() {
        // 取消检查在**项之前**：已经取消就别再动这一项
        if token.is_cancelled() {
            outcome.cancelled = true;
            break;
        }
        let name = file_name_of(path);
        reporter.set_current(&name);
        match work(index, path) {
            Ok(()) => {
                outcome.succeeded += 1;
                reporter.item_ok(&name);
            }
            Err(e) => {
                outcome.failed += 1;
                outcome.errors.push(format!("{}: {}", name, e));
                reporter.item_err(&name, e);
            }
        }
        outcome.processed += 1;
    }
    outcome
}

/// 取路径末段的名字，用于进度条上那行「正在删除 xxx」。
fn file_name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

// ============================================================================
// 命令层
// ============================================================================

/// 生成 operation id。用 uuid（本仓已依赖）而不是计数器：计数器在多窗口下会撞。
pub fn new_operation_id(kind: Kind) -> String {
    format!("op-{}-{}", kind.as_str(), uuid::Uuid::new_v4())
}

/// 发起一次批量操作，**立刻返回 operation_id**。
///
/// 真正的活在后台线程里跑，进度走 `operation-progress` 事件，
/// 取消走 [`cancel_operation`]。
#[tauri::command]
pub async fn batch_operation(
    app: AppHandle,
    ops: tauri::State<'_, Operations>,
    kind: String,
    paths: Vec<String>,
    rename: Option<RenameOptions>,
) -> Result<String, String> {
    let kind = Kind::parse(&kind).ok_or_else(|| format!("不支持的批量操作类型: {}", kind))?;
    if paths.is_empty() {
        return Err("没有要处理的文件".to_string());
    }
    if kind == Kind::Rename && rename.is_none() {
        return Err("重命名操作缺少 rename 参数".to_string());
    }

    let operation_id = new_operation_id(kind);
    // 先登记再返回 id，否则前端拿到 id 立刻点取消会撞上「没这个任务」
    ops.token(&operation_id);

    let app2 = app.clone();
    let id2 = operation_id.clone();
    tauri::async_runtime::spawn(async move {
        // 外层 spawn 让命令本身不阻塞 IPC 线程；内层 spawn_blocking 把真正的磁盘活
        // 放到 blocking 线程池——文件操作是纯同步 IO，跑在异步执行器的工作线程上
        // 会把同一条执行器上的其它任务一起饿死。
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let ops = app2.state::<Operations>();
            // clone 而不是 move：ops 是从 app2 借的状态，借用还活着时不能把 app2 搬走
            run_operation(Some(app2.clone()), &ops, id2, kind, paths, rename);
        })
        .await;
    });

    Ok(operation_id)
}

/// 后台干活的本体。
///
/// `app` 是 `None` 时（单元测试/集成测试里没有 WebView）不发事件，只更新内存快照——
/// 驱动的仍然是**同一条生产代码路径**。
pub fn run_operation(
    app: Option<AppHandle>,
    ops: &Operations,
    operation_id: String,
    kind: Kind,
    paths: Vec<String>,
    rename: Option<RenameOptions>,
) {
    let total = paths.len() as u64;
    let (mut reporter, token) = match &app {
        Some(a) => Reporter::new(a.clone(), ops, operation_id.clone(), kind, total),
        None => Reporter::detached(ops, operation_id.clone(), kind, total),
    };

    let outcome = match kind {
        Kind::Rename => {
            let opts = match rename {
                Some(o) => o,
                None => {
                    reporter.fail("重命名操作缺少 rename 参数");
                    return;
                }
            };
            run_batch(&paths, &token, &mut reporter, |index, path| {
                crate::commands::rename_one(path, index, &opts).map(|_| ())
            })
        }
        Kind::Delete => run_batch(&paths, &token, &mut reporter, |_index, path| {
            crate::commands::delete_file_blocking(path)
        }),
        Kind::Trash => {
            // 移到回收站要 AppHandle（回收站目录挂在 app data 下）
            let app = match app {
                Some(a) => a,
                None => {
                    reporter.fail("移到回收站需要应用上下文");
                    return;
                }
            };
            run_batch(&paths, &token, &mut reporter, |_index, path| {
                crate::commands::delete_to_trash_blocking(app.clone(), path.to_string()).map(|_| ())
            })
        }
    };

    if outcome.cancelled {
        reporter.cancel();
        return;
    }
    reporter.finish(&done_message(&outcome));
}

/// 结算的话术。
fn done_message(outcome: &BatchOutcome) -> String {
    let mut parts = vec![format!("已处理 {} 项", outcome.processed)];
    if outcome.failed > 0 {
        parts.push(format!("失败 {} 项", outcome.failed));
    }
    parts.join("，")
}

/// 请求取消。返回 false 表示没这个任务（已经结束并被清出账本，或 id 写错了）。
///
/// 取消是**协作式**的：只置一个标志位，批量循环在每一项之前检查一次。
#[tauri::command]
pub fn cancel_operation(ops: tauri::State<'_, Operations>, operation_id: String) -> bool {
    ops.cancel(&operation_id)
}

/// 轮询任务状态。正常情况下前端听 `operation-progress` 事件就够了，这个是兜底：
/// 窗口重建、事件漏收、或者想拿最终结果时用它。
#[tauri::command]
pub fn operation_state(
    ops: tauri::State<'_, Operations>,
    operation_id: String,
) -> Option<Progress> {
    ops.snapshot(&operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_bridge::TempDir;

    fn ops() -> Operations {
        Operations::default()
    }

    #[test]
    fn cancellation_token_is_idempotent_and_visible_to_clones() {
        let token = CancellationToken::new();
        let clone = token.clone();
        assert!(!clone.is_cancelled());
        token.cancel();
        assert!(clone.is_cancelled());
        // 重复取消不报错
        token.cancel();
        assert!(clone.is_cancelled());
    }

    #[test]
    fn registry_hands_out_the_same_token_for_the_same_id() {
        let o = ops();
        let a = o.token("op-1");
        let b = o.token("op-1");
        assert!(!a.is_cancelled());
        assert!(o.cancel("op-1"));
        // 同一个 id 拿到的令牌是同一个：命令先登记、工作线程后取，两边要指向同一块标志位
        assert!(a.is_cancelled());
        assert!(b.is_cancelled());
    }

    #[test]
    fn cancel_reports_false_for_unknown_operation() {
        let o = ops();
        assert!(!o.cancel("nope"));
    }

    #[test]
    fn run_batch_processes_every_item_when_not_cancelled() {
        let o = ops();
        let (mut reporter, token) = Reporter::detached(&o, "op-all".into(), Kind::Rename, 3);
        let paths = vec![
            "/a/1.txt".to_string(),
            "/a/2.txt".to_string(),
            "/a/3.txt".to_string(),
        ];
        let mut seen: Vec<String> = Vec::new();
        let outcome = run_batch(&paths, &token, &mut reporter, |_i, p| {
            seen.push(p.to_string());
            Ok(())
        });
        assert_eq!(seen.len(), 3);
        assert_eq!(outcome.processed, 3);
        assert_eq!(outcome.succeeded, 3);
        assert_eq!(outcome.failed, 0);
        assert!(!outcome.cancelled);
        let snap = o.snapshot("op-all").unwrap();
        assert_eq!(snap.processed, 3);
        assert_eq!(snap.succeeded, 3);
        assert_eq!(snap.percent, 100.0);
    }

    #[test]
    fn cancelled_batch_leaves_the_remaining_items_untouched() {
        // 这是 T2-06 的核心断言：取消不是「标记一下再把剩下的跑完」。
        // 第一项做完就取消，后面的项必须一个都没被处理。
        let o = ops();
        let (mut reporter, token) = Reporter::detached(&o, "op-cancel".into(), Kind::Delete, 5);
        let paths: Vec<String> = (0..5).map(|i| format!("/a/{}.txt", i)).collect();
        let mut handled: Vec<String> = Vec::new();
        let outcome = run_batch(&paths, &token, &mut reporter, |_i, p| {
            handled.push(p.to_string());
            if handled.len() == 1 {
                token.cancel();
            }
            Ok(())
        });
        assert_eq!(handled, vec!["/a/0.txt".to_string()]);
        assert!(outcome.cancelled);
        assert_eq!(outcome.processed, 1);
        assert_eq!(outcome.succeeded, 1);
        assert_eq!(outcome.failed, 0);
    }

    #[test]
    fn already_cancelled_batch_does_not_touch_any_item() {
        let o = ops();
        let (mut reporter, token) = Reporter::detached(&o, "op-pre".into(), Kind::Delete, 3);
        token.cancel();
        let paths = vec!["/a/1.txt".to_string(), "/a/2.txt".to_string()];
        let mut handled = 0usize;
        let outcome = run_batch(&paths, &token, &mut reporter, |_i, _p| {
            handled += 1;
            Ok(())
        });
        assert_eq!(handled, 0);
        assert!(outcome.cancelled);
        assert_eq!(outcome.processed, 0);
    }

    #[test]
    fn cancel_through_the_registry_stops_the_batch() {
        // 走的是 cancel_operation 命令的**同一条路径**（Operations::cancel → 令牌），
        // 不是直接调 token.cancel()。
        let o = ops();
        let (mut reporter, token) = Reporter::detached(&o, "op-reg".into(), Kind::Delete, 3);
        let paths = vec![
            "/a/1.txt".to_string(),
            "/a/2.txt".to_string(),
            "/a/3.txt".to_string(),
        ];
        let mut handled = 0usize;
        let outcome = run_batch(&paths, &token, &mut reporter, |_i, _p| {
            handled += 1;
            // 处理完第一项就从账本里取消（= 前端点了取消按钮）
            if handled == 1 {
                assert!(o.cancel("op-reg"));
            }
            Ok(())
        });
        assert_eq!(handled, 1);
        assert!(outcome.cancelled);
    }

    #[test]
    fn cancel_from_another_thread_stops_a_running_batch() {
        // 真实场景：操作在后台线程里跑，用户在界面上点取消（另一个线程调 cancel_operation）。
        // 用两个 channel 做握手，保证「取消一定发生在第一项之后、其余项之前」。
        use std::sync::mpsc;
        use std::sync::Arc;

        let o = Arc::new(ops());
        let (tx, rx) = mpsc::channel::<()>();
        let (ctx, crx) = mpsc::channel::<bool>();
        let (done_tx, done_rx) = mpsc::channel::<usize>();

        let o2 = o.clone();
        let worker = std::thread::spawn(move || {
            let (mut reporter, token) =
                Reporter::detached(&o2, "op-thread".into(), Kind::Delete, 50);
            let paths: Vec<String> = (0..50).map(|i| format!("/a/{}.txt", i)).collect();
            let mut handled = 0usize;
            let outcome = run_batch(&paths, &token, &mut reporter, |_i, _p| {
                // 告诉主线程「我准备处理这一项了」，然后等它回话
                tx.send(()).unwrap();
                let keep = crx.recv().unwrap();
                handled += 1;
                if !keep {
                    return Err("主线程叫停".to_string());
                }
                Ok(())
            });
            done_tx.send(handled).unwrap();
            outcome
        });

        // 主线程：等第一项开始 → 调取消（= cancel_operation）→ 放行
        rx.recv().unwrap();
        assert!(o.cancel("op-thread"));
        ctx.send(true).unwrap();

        let handled = done_rx.recv().unwrap();
        assert_eq!(handled, 1, "取消后剩余项必须没有被处理");
        worker.join().unwrap();
    }

    #[test]
    fn failures_are_collected_and_do_not_stop_the_batch() {
        let o = ops();
        let (mut reporter, token) = Reporter::detached(&o, "op-fail".into(), Kind::Delete, 3);
        let paths = vec![
            "/a/1.txt".to_string(),
            "/a/2.txt".to_string(),
            "/a/3.txt".to_string(),
        ];
        let outcome = run_batch(&paths, &token, &mut reporter, |i, _p| {
            if i == 1 {
                Err("权限不足".to_string())
            } else {
                Ok(())
            }
        });
        assert_eq!(outcome.processed, 3);
        assert_eq!(outcome.succeeded, 2);
        assert_eq!(outcome.failed, 1);
        assert_eq!(outcome.errors.len(), 1);
        assert!(outcome.errors[0].contains("权限不足"));
    }

    #[test]
    fn progress_events_are_emitted_for_every_item() {
        // T2-05 的核心断言：批量过程中真的向外发进度。
        let o = ops();
        let sink = Arc::new(CollectingSink::new());
        let (mut reporter, token) =
            Reporter::with_sink(sink.clone(), &o, "op-progress".into(), Kind::Rename, 1000);
        // 关掉节流：一项一条事件，才能数清楚
        reporter.set_throttle(Duration::ZERO);
        let paths: Vec<String> = (0..1000).map(|i| format!("/a/{}.txt", i)).collect();
        let outcome = run_batch(&paths, &token, &mut reporter, |_i, _p| Ok(()));
        assert_eq!(outcome.processed, 1000);

        let events = sink.events();
        assert!(!events.is_empty());
        // processed 单调递增，最后一条是 1000/1000
        let mut last = 0u64;
        for e in &events {
            assert!(e.processed >= last);
            last = e.processed;
        }
        assert_eq!(last, 1000);
        assert_eq!(events.last().unwrap().percent, 100.0);
    }

    #[test]
    fn terminal_state_is_always_emitted_even_under_throttling() {
        // 节流不能把终态吃掉：用户看到的最后状态必须是准的
        let o = ops();
        let sink = Arc::new(CollectingSink::new());
        let (mut reporter, _token) =
            Reporter::with_sink(sink.clone(), &o, "op-term".into(), Kind::Delete, 1);
        reporter.set_throttle(Duration::from_secs(3600));
        reporter.set_current("/a/x.txt");
        reporter.item_ok("x.txt");
        reporter.finish("已完成");
        let events = sink.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].phase, "done");
        assert_eq!(events[0].percent, 100.0);
        assert_eq!(o.snapshot("op-term").unwrap().phase, "done");
    }

    #[test]
    fn cancel_and_fail_set_their_own_terminal_phases() {
        let o = ops();
        let (reporter, _t) = Reporter::detached(&o, "op-c".into(), Kind::Delete, 1);
        reporter.cancel();
        assert_eq!(o.snapshot("op-c").unwrap().phase, "cancelled");

        let (reporter, _t) = Reporter::detached(&o, "op-e".into(), Kind::Delete, 1);
        reporter.fail("炸了");
        let snap = o.snapshot("op-e").unwrap();
        assert_eq!(snap.phase, "error");
        assert_eq!(snap.message, "炸了");
        // 终态是最终的：到了这里就别再被在途快照盖回去。
        // 这条保证**不是**靠一个 phase 判定函数，而是靠**所有权**：
        // finish / cancel / fail 都是 `fn finish(mut self)` —— 它们把上报器**消费掉**，
        // 之后再没有 emit 的机会，那份快照自然停在终态上。
        // （原来这里挂着一个 `is_terminal()` 助手，唯一的用处是断言它自己认得
        // "cancelled"/"error"/"running" 三个字符串 —— 自证式的断言，
        // 而它自己只被测试调用 ⇒ 在生产构建里是死代码，clippy 会盯着。
        // 规则留着，冗余的助手删掉。）
    }

    #[test]
    fn kind_parsing_refuses_unknown_kinds() {
        assert_eq!(Kind::parse("rename"), Some(Kind::Rename));
        assert_eq!(Kind::parse("delete"), Some(Kind::Delete));
        assert_eq!(Kind::parse("trash"), Some(Kind::Trash));
        // 认不出来就报错，不兜底成某个默认语义
        assert_eq!(Kind::parse("rm -rf"), None);
        assert_eq!(Kind::parse(""), None);
    }

    #[test]
    fn rename_batch_renames_every_file_and_reports_progress() {
        // 走真实的重命名实现（commands::rename_one），证明批量操作不是另起的一套
        let dir = TempDir::new("op-rename");
        let mut paths = Vec::new();
        for i in 0..5 {
            let p = dir.join(format!("f{}.txt", i));
            std::fs::write(&p, "x").unwrap();
            paths.push(p.to_string_lossy().to_string());
        }
        let o = ops();
        let sink = Arc::new(CollectingSink::new());
        let (mut reporter, token) =
            Reporter::with_sink(sink.clone(), &o, "op-rn".into(), Kind::Rename, 5);
        reporter.set_throttle(Duration::ZERO);
        let opts = RenameOptions {
            mode: "prefix_suffix".to_string(),
            prefix: Some("pre-".to_string()),
            ..Default::default()
        };
        let outcome = run_batch(&paths, &token, &mut reporter, |index, path| {
            crate::commands::rename_one(path, index, &opts).map(|_| ())
        });
        assert_eq!(outcome.succeeded, 5);
        assert_eq!(outcome.failed, 0);
        for i in 0..5 {
            assert!(dir.join(format!("pre-f{}.txt", i)).exists());
        }
        assert!(!sink.is_empty());
    }

    #[test]
    fn cancelled_rename_batch_leaves_later_files_untouched() {
        // 取消语义的端到端版本：真的文件层面，剩余文件不能被改名
        let dir = TempDir::new("op-rename-cancel");
        let mut paths = Vec::new();
        for i in 0..4 {
            let p = dir.join(format!("f{}.txt", i));
            std::fs::write(&p, "x").unwrap();
            paths.push(p.to_string_lossy().to_string());
        }
        let o = ops();
        let (mut reporter, token) = Reporter::detached(&o, "op-rnc".into(), Kind::Rename, 4);
        let opts = RenameOptions {
            mode: "prefix_suffix".to_string(),
            prefix: Some("pre-".to_string()),
            ..Default::default()
        };
        let mut handled = 0usize;
        let outcome = run_batch(&paths, &token, &mut reporter, |index, path| {
            crate::commands::rename_one(path, index, &opts).map(|_| ())?;
            handled += 1;
            if handled == 1 {
                token.cancel();
            }
            Ok(())
        });
        assert!(outcome.cancelled);
        assert_eq!(handled, 1);
        // 第一个被改了，其余三个原名还在
        assert!(dir.join("pre-f0.txt").exists());
        assert!(dir.join("f1.txt").exists());
        assert!(dir.join("f2.txt").exists());
        assert!(dir.join("f3.txt").exists());
    }
}
