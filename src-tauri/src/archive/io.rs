//! 计数字节流。进度条要准，就得知道"读了/写了多少字节"。
//!
//! 关键取点位置：**计数器放在解码器外面**（贴着磁盘文件），不是里面。
//! `.tar.gz` 解压时里面的明文长度事先不知道，但压缩文件的总大小是已知的，
//! 于是"从文件读走了多少字节 / 文件多大"就是精确的百分比。放在里面则永远算不出总量。

use std::fs;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use super::job::Cancelled;

/// 统一的"用户取消了"错误。各处自己 `io::Error::new(Interrupted, ...)` 会写出不同的
/// message，上层就没法靠文本认出来，取消会被当成失败弹红色错误框。
pub fn cancelled_error() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, Cancelled.to_string())
}

pub fn is_cancelled(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::Interrupted && e.to_string() == Cancelled.to_string()
}

pub struct CountingReader<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R> CountingReader<R> {
    pub fn new(inner: R) -> (Self, Arc<AtomicU64>) {
        let c = Arc::new(AtomicU64::new(0));
        (
            CountingReader {
                inner,
                count: c.clone(),
            },
            c,
        )
    }
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            self.count.fetch_add(n as u64, Ordering::Relaxed);
        }
        Ok(n)
    }
}

pub struct CountingWriter<W> {
    inner: W,
    count: Arc<AtomicU64>,
}

impl<W> CountingWriter<W> {
    pub fn new(inner: W) -> (Self, Arc<AtomicU64>) {
        let c = Arc::new(AtomicU64::new(0));
        (
            CountingWriter {
                inner,
                count: c.clone(),
            },
            c,
        )
    }

    pub fn into_inner(self) -> W {
        self.inner
    }
}

impl<W: Write> Write for CountingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        if n > 0 {
            self.count.fetch_add(n as u64, Ordering::Relaxed);
        }
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// 带取消检查的拷贝：每写满一块就问一下"用户按取消了吗"。
///
/// 用 64KB 块，和 `add_file_to_zip` 里那个尺寸保持一致——太小 IO 调用次数翻倍，
/// 太大则取消响应会迟到一个块的时间（大文件上可能几秒）。
///
/// `on_chunk` 是 `FnMut` 而不是 `Fn`：所有调用方传的都是 `|n| reporter.advance_bytes(n)`，
/// 而 `Reporter` 的方法全要 `&mut self`。收成 `Fn` 就得让每个调用点自己套一层
/// `Arc<AtomicU64>` 再轮询，纯属给自己找麻烦。
pub fn copy_with_cancel<R: Read, W: Write>(
    r: &mut R,
    w: &mut W,
    cancel: &AtomicBool,
    mut on_chunk: impl FnMut(u64),
) -> io::Result<u64> {
    const BUF: usize = 64 * 1024;
    let mut buf = vec![0u8; BUF];
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled_error());
        }
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n])?;
        total += n as u64;
        on_chunk(n as u64);
    }
    Ok(total)
}

/// 压缩时用：把"源文件读走了多少字节"直接接到进度回调上，并逐块检查取消。
///
/// 进度按**源文件字节**算（而不是产出的压缩包字节）：压缩前扫一遍就知道总量，
/// 百分比精确；按产出算则事先不知道压缩包会多大，只能显示不确定进度。
pub struct TrackingReader<'a, R, F: FnMut(u64)> {
    inner: R,
    on_read: F,
    cancel: &'a AtomicBool,
}

impl<'a, R, F: FnMut(u64)> TrackingReader<'a, R, F> {
    pub fn new(inner: R, cancel: &'a AtomicBool, on_read: F) -> Self {
        TrackingReader {
            inner,
            on_read,
            cancel,
        }
    }
}

impl<R: Read, F: FnMut(u64)> Read for TrackingReader<'_, R, F> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(cancelled_error());
        }
        let n = self.inner.read(buf)?;
        if n > 0 {
            (self.on_read)(n as u64);
        }
        Ok(n)
    }
}

// ============================================================================
// 文件系统元数据
// ============================================================================

/// Unix 秒。0 表示取不到（该文件系统不存 mtime，或时间早于 1970）。
pub fn mtime_of(m: &fs::Metadata) -> u64 {
    filetime::FileTime::from_last_modification_time(m)
        .unix_seconds()
        .max(0) as u64
}

/// 落地文件的时间戳。`unix_secs == 0` 时什么都不做——保留"刚才创建的"时间，
/// 比写一个 1970-01-01 上去强（用户按时间排序时这些文件会全挤到最前面）。
pub fn set_mtime(path: &std::path::Path, unix_secs: u64) {
    if unix_secs == 0 {
        return;
    }
    let ft = filetime::FileTime::from_unix_time(unix_secs as i64, 0);
    let _ = filetime::set_file_mtime(path, ft);
}

#[cfg(unix)]
pub fn unix_mode_of(m: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode()
}

/// Windows 上没有 mode 位，一律给 0o644：tar 头这一格必须有值，留 0 的话
/// 在 Linux 上解出来的文件一个权限位都没有，连 `cat` 都打不开。
///
/// 用 `#[cfg]` 分平台而不是在调用点写 `if cfg!(unix)`：后者是**运行时**判断，
/// 两个分支都得编译，而 `PermissionsExt` 在 Windows 上根本不存在。
#[cfg(not(unix))]
pub fn unix_mode_of(_m: &fs::Metadata) -> u32 {
    0o644
}
