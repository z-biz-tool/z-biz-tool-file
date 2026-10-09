//! 归档任务的进度上报与取消。
//!
//! 老的解压/压缩是"发一条 invoke，然后转圈等它回来"：7.4 GB 的 RAR 解一半时
//! 用户既看不到进度也停不下来，只能去任务管理器杀进程（而这台机器上杀进程
//! 曾经连带触发过 Autodesk 许可锁死，见 [[feedback-never-touch-dcc-app-lifecycle]]）。
//! 所以这里把归档操作改成**任务制**：命令立刻返回 job id，进度走事件，取消走独立命令。
//!
//! 事件通道沿用 `watcher.rs` 已有的 `tauri::Emitter` 约定，不另起一套。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

pub const PROGRESS_EVENT: &str = "archive-progress";

/// 任务类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Extract,
    Create,
    Test,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Extract => "extract",
            Kind::Create => "create",
            Kind::Test => "test",
        }
    }
}

/// 发给前端的进度载荷
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub job_id: String,
    pub kind: String,
    /// scanning（还没数完条目）/ working / finishing / done / cancelled / error
    pub phase: String,
    pub archive: String,
    pub dest: String,
    /// 当前正在处理的条目名，用于界面上那行"正在解压 xxx"
    pub entry: String,
    pub entries_done: u64,
    pub entries_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// 0..100，两个总量都未知时为 -1（前端显示不定进度条）
    pub percent: f64,
    pub speed_bps: f64,
    pub message: String,
}

impl Progress {
    fn new(job_id: String, kind: Kind, archive: String, dest: String) -> Self {
        Progress {
            job_id,
            kind: kind.as_str().to_string(),
            phase: "scanning".to_string(),
            archive,
            dest,
            entry: String::new(),
            entries_done: 0,
            entries_total: 0,
            bytes_done: 0,
            bytes_total: 0,
            percent: -1.0,
            speed_bps: 0.0,
            message: String::new(),
        }
    }
}

#[derive(Default)]
struct Ctl {
    /// 单独 Arc 出来，是因为后端要的是 `&AtomicBool`，而 Reporter 自己又要 `&mut`：
    /// 两者同时存在就只能让标志位脱离 `&Ctl` 的借用独立活着。
    cancel: Arc<AtomicBool>,
    done: AtomicBool,
    snapshot: Mutex<Option<Progress>>,
}

/// 全局任务表。放进 Tauri 的 managed state。
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Arc<Ctl>>>);

impl Jobs {
    /// 取回（没有就建）某个任务的控制块。`Ctl` 是模块私有的，所以这是给同文件的
    /// `Reporter` 用的内部入口；外面只能拿 `flag`。
    ///
    /// 账本超过 200 条时清掉已结束的：这是内存里的表，不能只进不出。
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

    /// 取回（没有就建）某个任务的取消标志。
    ///
    /// 幂等是刻意的：命令在返回 job_id **之前**先调一次把条目建出来，工作线程里的
    /// `Reporter::new` 再调一次拿到同一个 Arc。否则前端刚收到 id 就点取消，会撞上
    /// "没这个任务"——窗口只有几毫秒，但用户点得比这快。
    pub fn flag(&self, id: &str) -> Arc<AtomicBool> {
        Arc::clone(&self.acquire(id).cancel)
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.0.lock() {
            Ok(m) => match m.get(id) {
                Some(ctl) => {
                    ctl.cancel.store(true, Ordering::Relaxed);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    pub fn snapshot(&self, id: &str) -> Option<Progress> {
        self.0
            .lock()
            .ok()?
            .get(id)?
            .snapshot
            .lock()
            .ok()?
            .clone()
    }
}

/// 一次归档操作的进度上报器。
///
/// **节流**：8638 个条目的包如果每条都 emit 一次，事件会把 WebView 的 JS 队列灌满，
/// 界面反而卡成幻灯片。这里按时间节流（100ms），但阶段变化和结束一定强制发一次，
/// 保证用户看到的最后状态是准的。
pub struct Reporter {
    /// 单元测试里没有真实的 AppHandle，此时只更新快照、不发事件
    app: Option<AppHandle>,
    ctl: Arc<Ctl>,
    progress: Progress,
    started: Instant,
    last_emit: Instant,
    bytes_done: Arc<AtomicU64>,
}

const EMIT_INTERVAL_MS: u128 = 100;

impl Reporter {
    /// 返回值第二个是取消标志：交给后端，后端在每写满一块时 load 一次。
    pub fn new(
        app: AppHandle,
        job_id: String,
        kind: Kind,
        archive: String,
        dest: String,
    ) -> (Self, Arc<AtomicBool>) {
        let ctl = app.state::<Jobs>().acquire(&job_id);
        let cancel = Arc::clone(&ctl.cancel);
        (Self::with_ctl(Some(app), ctl, job_id, kind, archive, dest), cancel)
    }

    fn with_ctl(
        app: Option<AppHandle>,
        ctl: Arc<Ctl>,
        job_id: String,
        kind: Kind,
        archive: String,
        dest: String,
    ) -> Reporter {
        Reporter {
            app,
            ctl,
            progress: Progress::new(job_id, kind, archive, dest),
            started: Instant::now(),
            // 首次 emit 必须立刻发出去，否则用户会先看到 100ms 的"没反应"
            last_emit: Instant::now()
                .checked_sub(std::time::Duration::from_secs(10))
                .unwrap_or_else(Instant::now),
            bytes_done: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 不挂 AppHandle 的上报器：只更新内存里的快照，不发事件。
    ///
    /// 两个用途，都是"没有 WebView 可通知"的场景：
    /// - 集成测试（`tests/` 编译的是普通 lib，`#[cfg(test)]` 对它们不成立）；
    /// - commands.rs 里那几个遗留的同步归档命令。它们是老前端还在用的接口，
    ///   签名不能变（返回 `Result<(), String>` 而不是 job id），所以没法带事件。
    pub fn detached(job_id: String, kind: Kind, archive: String, dest: String) -> Reporter {
        Reporter::with_ctl(None, Arc::new(Ctl::default()), job_id, kind, archive, dest)
    }

    pub fn cancelled(&self) -> bool {
        self.ctl.cancel.load(Ordering::Relaxed)
    }

    pub fn set_phase(&mut self, phase: &str) {
        self.progress.phase = phase.to_string();
        self.emit(true);
    }

    pub fn set_totals(&mut self, entries: u64, bytes: u64) {
        self.progress.entries_total = entries;
        self.progress.bytes_total = bytes;
        self.recompute_percent();
        self.emit(false);
    }

    pub fn set_entry(&mut self, name: &str) {
        self.progress.entry = name.to_string();
        self.emit(false);
    }

    /// 一个条目做完了
    pub fn entry_done(&mut self, name: &str, bytes: u64) {
        self.progress.entries_done += 1;
        self.progress.entry = name.to_string();
        self.bytes_done.fetch_add(bytes, Ordering::Relaxed);
        self.progress.bytes_done = self.bytes_done.load(Ordering::Relaxed);
        self.recompute_percent();
        self.emit(false);
    }

    /// 流式写入过程中的字节推进（压缩时按写出的原始字节算）
    pub fn advance_bytes(&mut self, bytes: u64) {
        self.bytes_done.fetch_add(bytes, Ordering::Relaxed);
        self.progress.bytes_done = self.bytes_done.load(Ordering::Relaxed);
        self.recompute_percent();
        self.emit(false);
    }

    /// 绝对值设置已处理字节数。
    /// 流式格式（tar.gz 之类）拿不到明文总量，但压缩文件的总大小是已知的，
    /// 于是进度按"从压缩包读走了多少字节"算——这条路径直接同步那个计数器的值。
    pub fn set_bytes(&mut self, bytes: u64) {
        self.bytes_done.store(bytes, Ordering::Relaxed);
        self.progress.bytes_done = bytes;
        self.recompute_percent();
        self.emit(false);
    }

    fn recompute_percent(&mut self) {
        let p = self.progress.clone();
        self.progress.percent = if p.bytes_total > 0 {
            (p.bytes_done as f64 / p.bytes_total as f64 * 100.0).min(100.0)
        } else if p.entries_total > 0 {
            (p.entries_done as f64 / p.entries_total as f64 * 100.0).min(100.0)
        } else {
            -1.0
        };
    }

    fn emit(&mut self, force: bool) {
        let now = Instant::now();
        if !force && now.duration_since(self.last_emit).as_millis() < EMIT_INTERVAL_MS {
            // 不发事件也要更新快照：前端轮询 archive_job_state 时要拿到最新值
            if let Ok(mut s) = self.ctl.snapshot.lock() {
                *s = Some(self.progress.clone());
            }
            return;
        }
        self.last_emit = now;
        let elapsed = self.started.elapsed().as_secs_f64().max(0.001);
        self.progress.speed_bps = self.progress.bytes_done as f64 / elapsed;
        if let Ok(mut s) = self.ctl.snapshot.lock() {
            *s = Some(self.progress.clone());
        }
        if let Some(app) = &self.app {
            let _ = app.emit(PROGRESS_EVENT, self.progress.clone());
        }
    }

    /// 正常结束。返回值会被写进快照，前端轮询也能拿到。
    pub fn finish(mut self, message: &str) {
        self.progress.phase = "done".to_string();
        self.progress.message = message.to_string();
        self.progress.percent = 100.0;
        self.emit(true);
        self.ctl.done.store(true, Ordering::Relaxed);
    }

    pub fn fail(mut self, error: &str) {
        self.progress.phase = "error".to_string();
        self.progress.message = error.to_string();
        self.emit(true);
        self.ctl.done.store(true, Ordering::Relaxed);
    }

    pub fn cancel(mut self) {
        self.progress.phase = "cancelled".to_string();
        self.progress.message = "已取消".to_string();
        self.emit(true);
        self.ctl.done.store(true, Ordering::Relaxed);
    }
}

/// 取消时必须能从一个纯同步的错误里认出来，前端据此显示"已取消"而不是"失败"
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("已取消")
    }
}

impl std::error::Error for Cancelled {}

/// 生成 job id。用 uuid（本仓已依赖）而不是计数器：计数器在多窗口/多标签下会撞。
pub fn new_job_id(kind: Kind) -> String {
    format!("{}-{}", kind.as_str(), uuid::Uuid::new_v4())
}
