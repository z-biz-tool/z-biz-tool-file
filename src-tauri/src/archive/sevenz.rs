//! 7z 读写后端（sevenz-rust2 0.23）。
//!
//! 0.23 相对旧的 `sevenz-rust` 0.6 是**彻底重写**：`sevenz_rust::decompress(file, dest)`
//! 这类一把梭的函数没有了，`DatabaseFile` 改名 `ArchiveEntry`，读走 `ArchiveReader`、
//! 写走 `ArchiveWriter`。commands.rs 里那句老调用是这次替换的主要动机之一。
//!
//! ## 三个必须知道的结构性事实
//!
//! **1. solid 块内的条目必须逐个排空。** `for_each_entries` 给每个条目一个
//! `BoundedReader`（只限字节数，不会自动跳过）。不选中就直接返回的话，底层
//! `block_reader` 的位置没往前走，**下一个条目会读到错位的字节**——解出来是垃圾而且
//! CRC 校验失败。所以未选中的条目一律 `copy` 到 `sink()`。solid 归档想只取一个文件
//! 就是这么慢的，这是格式本身的代价，不是实现问题。
//!
//! **2. 写不出分卷。** crate 的输出是一个 `Write + Seek`，没有卷的概念；7z 的分卷
//! 还要求后续卷复制签名头，属于格式层的事。所以 `format.rs` 里 7z 的
//! `supports_volumes` 是 false，`create` 收到 `volume_size > 0` 直接报错而不是静默忽略。
//! 同理，读 `.7z.001` 也做不到（`Archive` 里没有卷拼接逻辑），错误信息会把这点说清楚。
//!
//! **3. 追加 = 整体重写。** 7z 的目录在文件末尾，插一个条目就得重排 pack stream。
//! `Caps.add` 因此是 false，前端不该给出"添加到压缩包"这一项（见 [[feedback-ui-fewer-buttons]]）。
//!
//! ## solid 分批的依据
//!
//! `push_archive_entries` 是**流式**写到输出文件的（不进内存），但它一次调用就是一个
//! solid 块，进度只能在块之间刷新。crate 自己的 util 用 4 GiB 一块，那样大任务会长时间
//! 没有进度。这里取 512 MiB：LZMA2 字典最大也就 64 MiB 量级，块再大对压缩率的增益
//! 已经很薄，而用户每压 512 MiB 就能看到一次进度跳动。
//!
//! ## CRC 与"测试压缩包"
//!
//! 解码时 `Crc32VerifyingReader` 会自动比对每个条目的 CRC32（`has_crc` 时），
//! 失败以 `io::Error` 冒出来。所以 `test()` 不需要额外实现校验逻辑，把数据读到
//! `sink()` 就是完整的完整性测试。

use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

// `EncoderConfiguration` 在 crate 根上（`archive.rs` 里 pub 的），不在 `encoder_options`
// 里——那个模块只是 `use crate::EncoderConfiguration` 引进来给自己用的，私有的。
use sevenz_rust2::encoder_options::{AesEncoderOptions, Lzma2Options};
use sevenz_rust2::{
    Archive, ArchiveEntry, ArchiveReader, ArchiveWriter, EncoderConfiguration, EncoderMethod,
    Error as SzError, NtTime, Password, SourceReader,
};

use super::io::{cancelled_error, is_cancelled};
use super::job::Reporter;
use super::select::{map_output, normalize, single_root, Selector};
use super::tar::{archive_name_for, clamp, excluded};
use super::types::{ArchiveMeta, CreateOptions, Entry, ExtractOptions, Stats};
use super::guard;

/// solid 块的输入上限（未压缩字节）。见模块头"sold 分批的依据"。
const SOLID_BLOCK_BYTES: u64 = 512 * 1024 * 1024;
/// solid 块的条目数上限：几万个 1 KB 小文件也不该挤进一个块，否则头部 sub-stream 表巨大
const SOLID_BLOCK_FILES: usize = 8192;

type Reader = ArchiveReader<File>;

// ============================================================================
// 打开与错误翻译
// ============================================================================

fn password_of(pw: Option<&str>) -> Password {
    match pw {
        Some(s) if !s.is_empty() => Password::new(s),
        _ => Password::empty(),
    }
}

fn open(path: &Path, pw: Option<&str>) -> Result<Reader, String> {
    ArchiveReader::open(path, password_of(pw)).map_err(|e| open_err(path, e, pw))
}

/// 把 crate 的错误翻成人话。**密码类错误必须能区分"没给密码"和"密码错了"**，
/// 前端要靠这个决定是弹密码框还是抖一下密码框。
fn open_err(path: &Path, e: SzError, pw: Option<&str>) -> String {
    let had = pw.map(|s| !s.is_empty()).unwrap_or(false);
    match e {
        SzError::PasswordRequired => {
            if had {
                "密码错误：这个 7z 连文件名都加密了。".to_string()
            } else {
                "这个 7z 加密了文件名，需要密码才能列出内容。".to_string()
            }
        }
        SzError::MaybeBadPassword(_) => {
            if had {
                "密码错误。".to_string()
            } else {
                "这个 7z 需要密码。".to_string()
            }
        }
        SzError::BadSignature(_) => volume_hint(path).unwrap_or_else(|| {
            "不是有效的 7z 文件（签名不匹配）。".to_string()
        }),
        SzError::UnsupportedCompressionMethod(m) => {
            format!("暂不支持的 7z 压缩方法: {}（可用 7-Zip 解开）", m)
        }
        SzError::ChecksumVerificationFailed | SzError::NextHeaderCrcMismatch => {
            "7z 文件头校验失败，文件很可能已损坏或没下载完整。".to_string()
        }
        SzError::FileNotFound => format!("文件不存在: {}", path.display()),
        SzError::MaxMemLimited { max_kb, .. } => {
            format!("解压这个 7z 需要的内存超过上限（{} KB）", max_kb)
        }
        other => format!("打开 7z 失败: {:?}", other),
    }
}

/// `.7z.001` 这类分卷：签名读不出来时给一句明确的解释，比"不是有效的 7z 文件"有用得多。
fn volume_hint(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    if name.ends_with(".001") || name.contains(".7z.") {
        return Some(split_volume_message());
    }
    None
}

/// 分卷 7z 的统一说辞。`format::detect` 能从扩展名认出 `.7z.001`，mod.rs 会在真正
/// 打开之前就拦下来（`sevenz_split_refusal`），不必等 crate 抛 `BadSignature`；
/// 这里保留它是给"扩展名看不出来、但打开时签名确实对不上"的兜底。
pub fn split_volume_message() -> String {
    SPLIT_VOLUME_MESSAGE.to_string()
}

const SPLIT_VOLUME_MESSAGE: &str = "这是分卷 7z（.7z.001/.002…），暂不支持——分卷拼接属于 7z \
     格式层的逻辑，当前引擎读不了。请改用 7-Zip 合并后解压。";

/// 密码没给但归档需要（内容加密或文件名加密）时，`list` 用这个判断要不要向前端要密码。
fn needs_password(path: &Path) -> bool {
    matches!(
        ArchiveReader::open(path, Password::empty()),
        Err(SzError::PasswordRequired) | Err(SzError::MaybeBadPassword(_))
    )
}

/// 打开并归类失败原因。mod.rs 靠 `kind` 决定"弹密码框"还是"报错"——拿中文措辞做
/// 匹配是不行的，措辞一改前端就瞎了。
///
/// 两种密码错误的区别是本后端的关键：
/// - `PasswordRequired` 只在**连文件名都加密**时出现，此时目录一条都列不出来，
///   `encrypted_headers = true`；
/// - `MaybeBadPassword` 是"头能读、数据块解不开"，既可能是密码错也可能是压根没给。
///   crate 自己都说 maybe，这里不去猜：两种情况对前端是同一种处理（弹密码框），
///   统一归到 `NeedPassword`，让用户再试一次就知道是不是密码的问题。
pub fn open_status(path: &Path, pw: Option<&str>) -> super::OpenStatus {
    use super::OpenStatus;
    match ArchiveReader::open(path, password_of(pw)) {
        Ok(_) => OpenStatus::Ok,
        Err(SzError::PasswordRequired) => OpenStatus::NeedPassword {
            message: open_err(path, SzError::PasswordRequired, pw),
            encrypted_headers: true,
        },
        Err(e @ SzError::MaybeBadPassword(_)) => OpenStatus::NeedPassword {
            message: open_err(path, e, pw),
            encrypted_headers: false,
        },
        Err(e) => OpenStatus::Failed {
            message: open_err(path, e, pw),
        },
    }
}

// ============================================================================
// 元信息
// ============================================================================

/// NtTime（Windows FILETIME，1601 起的 100ns 计数）→ Unix 秒。
/// 没有该时间字段时返回 0，上层 `set_mtime` 会跳过，不会写个 1970 上去。
fn nt_to_unix(nt: NtTime, has: bool) -> u64 {
    if !has {
        return 0;
    }
    let st = std::time::SystemTime::from(nt);
    st.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn block_of(arc: &Archive, i: usize) -> Option<usize> {
    arc.stream_map.file_block_index.get(i).copied().flatten()
}

fn block_encrypted(arc: &Archive, bi: usize) -> bool {
    arc.blocks
        .get(bi)
        .map(|b| {
            b.coders
                .iter()
                .any(|c| c.encoder_method_id() == EncoderMethod::ID_AES256_SHA256)
        })
        .unwrap_or(false)
}

/// 一个块里的编码器链拼成可读串，例如 `BCJ_X86 + LZMA2`。
/// AES 不算"压缩方法"，剔掉——它由 `encrypted` 字段单独表达。
fn block_method(arc: &Archive, bi: usize) -> String {
    let Some(b) = arc.blocks.get(bi) else {
        return String::new();
    };
    let names: Vec<&str> = b
        .coders
        .iter()
        .filter_map(|c| EncoderMethod::by_id(c.encoder_method_id()))
        .filter(|m| *m != EncoderMethod::AES256_SHA256)
        .map(|m| m.name())
        .collect();
    match names.len() {
        0 => "Copy".to_string(),
        _ => names.join(" + "),
    }
}

pub fn list(path: &Path, pw: Option<&str>) -> Result<(Vec<Entry>, ArchiveMeta), String> {
    // 先不带密码探一次，用来判断"是不是加密文件名"——这个信息打开之后就查不到了
    // （crate 没有 exposed 的 encrypted-headers 标志，只能靠 open 失败来推断）。
    let headers_encrypted = needs_password(path);
    let ar = open(path, pw)?;
    let arc = ar.archive();

    let mut entries = Vec::with_capacity(arc.files.len().min(super::MAX_ENTRIES));
    for (i, f) in arc.files.iter().enumerate() {
        if entries.len() >= super::MAX_ENTRIES {
            break;
        }
        let bi = block_of(arc, i);
        let is_dir = f.is_directory();
        let encrypted = bi.map(|b| block_encrypted(arc, b)).unwrap_or(false);
        let p = normalize(&f.name);
        entries.push(Entry {
            index: i as u32,
            name: p.rsplit('/').next().unwrap_or("").to_string(),
            path: p,
            is_dir,
            size: if is_dir { 0 } else { f.size },
            // solid 归档里所有条目共享字典，单条目的压缩后大小没有意义（crate 也只在
            // 每块第一个文件上填这个值），如实填 0 比填个误导性的数字强
            packed: if arc.is_solid {
                0
            } else {
                f.compressed_size
            },
            modified: nt_to_unix(f.last_modified_date(), f.has_last_modified_date) as i64,
            method: if is_dir {
                String::new()
            } else {
                bi.map(|b| block_method(arc, b)).unwrap_or_default()
            },
            encrypted,
            crc: if f.has_crc { f.crc as u32 } else { 0 },
            comment: String::new(), // 7z 的注释字段 crate 尚未实现读写
            symlink_target: String::new(),
        });
    }

    // 7z 会写真正的目录条目，但 size 是 0。目录大小的子树汇总统一在
    // mod.rs::info() 的出口处做（六个后端共用一份），这里如实返回原始值。
    let meta = ArchiveMeta {
        solid: arc.is_solid,
        encrypted_headers: headers_encrypted,
        // 写不出也读不了分卷，见模块头
        multipart: false,
        volumes: Vec::new(),
        comment: String::new(),
        needs_password: headers_encrypted || entries.iter().any(|e| e.encrypted),
    };
    Ok((entries, meta))
}

// ============================================================================
// 解压 / 校验
// ============================================================================

/// 回调里不能直接返回 `String`（签名是 `Result<bool, SzError>`），
/// 致命错误和取消都用这两个出参带出来，回来后统一翻成 `Err`。
struct Cb<'a> {
    dest: &'a Path,
    opts: &'a ExtractOptions,
    sel: &'a Selector,
    strip_root: Option<String>,
    cancel: &'a AtomicBool,
    reporter: &'a mut Reporter,
    stats: Stats,
    fatal: Option<String>,
    cancelled: bool,
    buf: Vec<u8>,
    started: std::time::Instant,
}

impl Cb<'_> {
    fn stopped(&self) -> bool {
        self.cancel.load(Ordering::Relaxed) || self.reporter.cancelled()
    }

    /// solid 块里未选中的条目必须排空，否则后续条目读到错位字节（见模块头）。
    /// 顺手把跳过的字节也报进进度：这部分解码时间是真实花掉的，不报进度条会假死。
    fn drain(&mut self, data: &mut dyn Read) -> io::Result<()> {
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(cancelled_error());
            }
            let n = data.read(&mut self.buf)?;
            if n == 0 {
                break;
            }
            self.reporter.advance_bytes(n as u64);
        }
        Ok(())
    }

    fn write_entry(&mut self, target: &Path, data: &mut dyn Read) -> io::Result<u64> {
        if let Some(p) = target.parent() {
            fs::create_dir_all(p)?;
        }
        let mut f = File::create(target)?;
        let mut total = 0u64;
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(cancelled_error());
            }
            let n = data.read(&mut self.buf)?;
            if n == 0 {
                break;
            }
            f.write_all(&self.buf[..n])?;
            total += n as u64;
            self.reporter.advance_bytes(n as u64);
        }
        f.flush()?;
        Ok(total)
    }
}

/// `for_each_entries` 的回调体。返回 `Ok(false)` 表示"停下"，用于取消和致命错误。
fn handle(
    cb: &mut Cb<'_>,
    entry: &ArchiveEntry,
    data: &mut dyn Read,
) -> Result<bool, SzError> {
    if cb.stopped() {
        cb.cancelled = true;
        return Ok(false);
    }
    let name = normalize(entry.name());
    if name.is_empty() || entry.is_anti_item() {
        // anti-item 是 7z 增量归档用来标记"删除"的，落地没有意义
        cb.drain(data)?;
        return Ok(true);
    }
    cb.reporter.set_entry(&name);

    let selected = cb.sel.matches(&name);
    let out_rel = if selected {
        map_output(&name, cb.strip_root.as_deref(), cb.opts.flatten)
    } else {
        String::new()
    };
    if !selected || out_rel.is_empty() {
        cb.drain(data)?;
        if !selected {
            cb.stats.skipped += 1;
        }
        return Ok(true);
    }

    let target = match guard::resolve_target(cb.dest, &out_rel, cb.opts.overwrite) {
        Ok(Some(t)) => t,
        Ok(None) => {
            cb.stats.skipped += 1;
            cb.drain(data)?;
            cb.reporter.entry_done(&name, 0);
            return Ok(true);
        }
        Err(e) => {
            cb.drain(data)?;
            if cb.opts.keep_broken {
                cb.stats.errors.push(e.to_string());
                cb.stats.skipped += 1;
                return Ok(true);
            }
            cb.fatal = Some(e.to_string());
            return Ok(false);
        }
    };

    if entry.is_directory() {
        if let Err(e) = fs::create_dir_all(&target) {
            cb.fatal = Some(format!("创建目录 {} 失败: {}", target.display(), e));
            return Ok(false);
        }
        cb.stats.entries_done += 1;
        cb.reporter.entry_done(&name, 0);
        return Ok(true);
    }

    match cb.write_entry(&target, data) {
        Ok(n) => {
            apply_attrs(&target, entry);
            cb.stats.entries_done += 1;
            cb.stats.bytes_done += n;
            cb.reporter.entry_done(&name, 0);
            Ok(true)
        }
        Err(e) => {
            let _ = fs::remove_file(&target); // 不留半截文件
            if is_cancelled(&e) {
                cb.cancelled = true;
                return Ok(false);
            }
            let msg = format!("写出 {} 失败: {}", target.display(), e);
            if cb.opts.keep_broken {
                cb.stats.errors.push(msg);
                cb.stats.skipped += 1;
                return Ok(true);
            }
            cb.fatal = Some(msg);
            Ok(false)
        }
    }
}

/// 恢复时间戳和只读位。
///
/// Windows 属性里只取"只读"这一位：把 hidden/system 也还原过去，用户解出来的文件
/// 会在资源管理器里直接看不见——那比不还原属性糟糕得多。和 rar.rs 的处理保持一致。
fn apply_attrs(target: &Path, entry: &ArchiveEntry) {
    let mt = nt_to_unix(entry.last_modified_date(), entry.has_last_modified_date);
    if mt > 0 {
        super::io::set_mtime(target, mt);
    }
    #[cfg(windows)]
    if entry.has_windows_attributes && (entry.windows_attributes & 0x1) != 0 {
        if let Ok(mut perm) = fs::metadata(target).map(|m| m.permissions()) {
            perm.set_readonly(true);
            let _ = fs::set_permissions(target, perm);
        }
    }
    #[cfg(unix)]
    if entry.has_windows_attributes {
        // 7z 把 unix 模式存在 windows_attributes 的高 16 位
        let mode = entry.windows_attributes >> 16;
        if mode != 0 {
            let _ = guard::apply_mode(target, mode);
        }
    }
}

fn finish(mut cb: Cb<'_>, r: Result<(), SzError>, kind: &str) -> Result<Stats, String> {
    cb.stats.elapsed_ms = cb.started.elapsed().as_millis() as u64;
    if cb.cancelled {
        return Err(super::job::Cancelled.to_string());
    }
    if let Some(msg) = cb.fatal.take() {
        return Err(msg);
    }
    if let Err(e) = r {
        // CRC 不匹配是从 io::Error 里裹着出来的，这里把里层挖出来给出准确说法
        if let SzError::Io(ioe, _) = &e {
            if let Some(inner) = ioe.get_ref().and_then(|x| x.downcast_ref::<SzError>()) {
                if matches!(inner, SzError::ChecksumVerificationFailed) {
                    return Err(format!("{}失败：CRC 校验不通过，压缩包内容已损坏", kind));
                }
            }
        }
        return Err(format!("{}失败: {:?}", kind, e));
    }
    Ok(cb.stats)
}

pub fn extract(
    path: &Path,
    dest: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let mut ar = open(path, opts.password.as_deref())?;
    let names: Vec<String> = ar.archive().files.iter().map(|f| normalize(&f.name)).collect();
    let all_bytes: u64 = ar.archive().files.iter().map(|f| f.size).sum();
    let sel = Selector::new(opts.entries.clone(), opts.include_children);
    let strip_root = if opts.strip_root {
        single_root(names.iter().map(|s| s.as_str()))
    } else {
        None
    };
    let total_entries = names.iter().filter(|n| sel.matches(n)).count() as u64;

    // bytes_total 用**整个归档**的解压后大小，不是选中条目的大小。
    // 因为 `for_each_entries` 会走一遍所有块，未选中的条目也要解码后排空（见模块头第 1 条），
    // 这些字节是真实花掉的时间。按选中量算的话，solid 包里只取一个文件会让进度条
    // 瞬间冲到 100% 然后卡在那儿几十分钟——比不显示进度还糟。
    reporter.set_totals(total_entries, all_bytes);
    reporter.set_phase("working");

    let mut cb = Cb {
        dest,
        opts,
        sel: &sel,
        strip_root,
        cancel,
        reporter,
        stats: Stats::default(),
        fatal: None,
        cancelled: false,
        buf: vec![0u8; 256 * 1024],
        started: std::time::Instant::now(),
    };
    let r = ar.for_each_entries(|e, d| handle(&mut cb, e, d));
    finish(cb, r, "解压")
}

pub fn test(
    path: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let mut ar = open(path, opts.password.as_deref())?;
    let (count, all_bytes) = {
        let files = &ar.archive().files;
        (files.len() as u64, files.iter().map(|f| f.size).sum::<u64>())
    };
    reporter.set_totals(count, all_bytes);
    reporter.set_phase("working");

    let sel = Selector::new(None, true);
    let mut cb = Cb {
        dest: Path::new(""),
        opts,
        sel: &sel,
        strip_root: None,
        cancel,
        reporter,
        stats: Stats::default(),
        fatal: None,
        cancelled: false,
        buf: vec![0u8; 256 * 1024],
        started: std::time::Instant::now(),
    };
    // 校验不落盘，只把数据读过去——Crc32VerifyingReader 会在读的过程中比对 CRC
    let r = ar.for_each_entries(|e, d| {
        if cb.stopped() {
            cb.cancelled = true;
            return Ok(false);
        }
        let name = normalize(e.name());
        cb.reporter.set_entry(&name);
        loop {
            if cb.cancel.load(Ordering::Relaxed) {
                cb.cancelled = true;
                return Ok(false);
            }
            let n = d.read(&mut cb.buf)?;
            if n == 0 {
                break;
            }
            cb.reporter.advance_bytes(n as u64);
        }
        cb.stats.entries_done += 1;
        cb.reporter.entry_done(&name, 0);
        Ok(true)
    });
    finish(cb, r, "校验")
}

// ============================================================================
// 压缩
// ============================================================================

fn methods_of(opts: &CreateOptions) -> Result<Vec<EncoderConfiguration>, String> {
    let level = clamp(opts.level.unwrap_or(5), 0, 9) as u32;
    let name = opts.method.as_deref().unwrap_or("lzma2").trim().to_ascii_lowercase();
    let base: EncoderConfiguration = match name.as_str() {
        "" | "lzma2" => Lzma2Options::from_level(level).into(),
        "copy" | "store" | "none" => EncoderMethod::COPY.into(),
        other => {
            return Err(format!(
                "7z 暂不支持写入 {} 方法（能读不能写）。可选: lzma2 / copy",
                other
            ))
        }
    };
    match opts.password.as_deref().filter(|s| !s.is_empty()) {
        // 顺序有意义：索引 0 最靠近输出文件，数据是**逆序**流过这个 Vec 的，
        // 所以 AES 必须排在 LZMA2 前面（先压后加密）。这也是 7-Zip 自己的做法。
        Some(pw) => Ok(vec![AesEncoderOptions::new(Password::new(pw)).into(), base]),
        None => Ok(vec![base]),
    }
}

/// 压缩计划里的一项。目录单独列出来，7z 才有真正的目录条目（否则空文件夹会丢）。
enum Plan {
    Dir(String),
    File { name: String, path: PathBuf, size: u64 },
}

/// 递归收集要压进去的东西。
///
/// 语义和 tar.rs 的 `add_path` 保持一致：`base` 是每个源的**父目录**并原样往下传，
/// `excluded` 命中就整棵子树跳过，符号链接当普通文件读（读不到就跳过）。
fn plan_sources(sources: &[PathBuf], opts: &CreateOptions) -> Result<Vec<Plan>, String> {
    let mut out = Vec::new();
    for src in sources {
        let base = src.parent().unwrap_or(src);
        plan_path(src, base, opts, &mut out)?;
    }
    Ok(out)
}

fn plan_path(src: &Path, base: &Path, opts: &CreateOptions, out: &mut Vec<Plan>) -> Result<(), String> {
    if excluded(src, &opts.exclude_patterns) {
        return Ok(());
    }
    let meta = fs::symlink_metadata(src)
        .map_err(|e| format!("读取 {} 失败: {}", src.display(), e))?;
    let name = archive_name_for(src, base, opts.store_full_path)?;
    if name.is_empty() {
        return Ok(());
    }
    if meta.is_dir() {
        out.push(Plan::Dir(name));
        for child in read_dir_sorted(src)? {
            plan_path(&child, base, opts, out)?;
        }
        return Ok(());
    }
    if meta.file_type().is_symlink() {
        // 7z 能存符号链接（走 windows_attributes + 特殊属性），但 crate 没暴露写入口。
        // 退化成读目标内容：结果不对但至少不静默丢文件，且解出来是个能看的普通文件。
        if let Ok(t) = fs::read_link(src) {
            if t.is_dir() {
                return Ok(());
            }
        }
    }
    out.push(Plan::File {
        name,
        path: src.to_path_buf(),
        size: meta.len(),
    });
    Ok(())
}

/// 排序保证同名输入每次产出字节级一致的归档（可复现构建），也让进度条按字母序推进
fn read_dir_sorted(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("读取目录 {} 失败: {}", dir.display(), e))?
        .map(|e| e.map(|e| e.path()))
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    v.sort();
    Ok(v)
}

/// solid 批量压缩用的延迟打开读取器。
///
/// `push_archive_entries` 要一次性拿到整批的读取器；如果那时就 open，几万个小文件会
/// 直接把文件句柄打满。crate 自己的 `LazyFileReader` 是 `pub(crate)` 拿不到，
/// 所以这里做一份等价的，顺便挂上字节计数和取消检查。
struct LazySrc<'a> {
    path: PathBuf,
    inner: Option<BufReader<File>>,
    eof: bool,
    counter: &'a AtomicU64,
    cancel: &'a AtomicBool,
}

impl Read for LazySrc<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.eof {
            return Ok(0);
        }
        if self.cancel.load(Ordering::Relaxed) {
            return Err(cancelled_error());
        }
        if self.inner.is_none() {
            self.inner = Some(BufReader::with_capacity(
                256 * 1024,
                File::open(&self.path).map_err(|e| {
                    io::Error::new(e.kind(), format!("打开 {} 失败: {}", self.path.display(), e))
                })?,
            ));
        }
        let n = self.inner.as_mut().expect("just set").read(buf)?;
        if n == 0 {
            // 读完立刻关掉：整批里同时最多只开一个句柄
            self.inner = None;
            self.eof = true;
        } else {
            self.counter.fetch_add(n as u64, Ordering::Relaxed);
        }
        Ok(n)
    }
}

pub fn create(
    sources: &[PathBuf],
    dest: &Path,
    opts: &CreateOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    if opts.volume_size.unwrap_or(0) > 0 {
        return Err("7z 暂不支持分卷压缩（引擎只能写单文件 .7z）。请取消分卷设置。".to_string());
    }
    if sources.is_empty() {
        return Err("没有要压缩的内容。".to_string());
    }
    if opts.comment.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
        // 静默忽略会让用户以为注释存进去了，下次打开发现没有更难受
        return Err("7z 暂不支持写入注释。请清空注释，或改用 zip 格式。".to_string());
    }

    let methods = methods_of(opts)?;
    let plan = plan_sources(sources, opts)?;
    if plan.is_empty() {
        return Err("所有源都被排除规则过滤掉了，没有可压缩的内容。".to_string());
    }

    let file_count = plan.iter().filter(|p| matches!(p, Plan::File { .. })).count();
    let byte_total: u64 = plan
        .iter()
        .filter_map(|p| match p {
            Plan::File { size, .. } => Some(*size),
            Plan::Dir(_) => None,
        })
        .sum();
    reporter.set_totals(file_count as u64, byte_total);
    reporter.set_phase("working");

    if let Some(p) = dest.parent() {
        fs::create_dir_all(p).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }
    let mut w = ArchiveWriter::create(dest).map_err(|e| format!("创建 {} 失败: {}", dest.display(), e))?;
    w.set_content_methods(methods);
    // crate 的默认值是 true（等于 7z 的 -mhe），必须显式设成用户的选择：
    // 不设的话"只加密内容"会变成"连文件名一起加密"，用户下次不看密码框根本列不出内容
    w.set_encrypt_header(opts.encrypt_header && opts.password.as_deref().map(|s| !s.is_empty()).unwrap_or(false));

    let started = std::time::Instant::now();
    let mut stats = Stats::default();

    // 目录条目没有数据流，先一次性写完；push_archive_entry 传 None 时不会碰 content_methods
    for p in plan.iter() {
        if let Plan::Dir(name) = p {
            if cancel.load(Ordering::Relaxed) {
                let _ = fs::remove_file(dest);
                return Err(super::job::Cancelled.to_string());
            }
            w.push_archive_entry::<File>(ArchiveEntry::new_directory(name), None)
                .map_err(|e| format!("写入目录 {} 失败: {:?}", name, e))?;
            stats.entries_done += 1;
            reporter.entry_done(name, 0);
        }
    }

    let r = if opts.solid {
        push_solid(&mut w, &plan, reporter, cancel, &mut stats)
    } else {
        push_each(&mut w, &plan, reporter, cancel, &mut stats)
    };
    if let Err(e) = r {
        // finish() 没跑就不会写出头部，留下的是个残缺文件，直接删掉别让用户误以为成功
        drop(w);
        let _ = fs::remove_file(dest);
        stats.elapsed_ms = started.elapsed().as_millis() as u64;
        return Err(e);
    }

    w.finish()
        .map_err(|e| format!("收尾写入 {} 失败: {}", dest.display(), e))?;
    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    reporter.set_phase("finishing");
    Ok(stats)
}

/// 非 solid：一个文件一个块，逐个 `push_archive_entry`。
/// 进度直接挂在 `TrackingReader` 上，字节级精确。
fn push_each(
    w: &mut ArchiveWriter<File>,
    plan: &[Plan],
    reporter: &mut Reporter,
    cancel: &AtomicBool,
    stats: &mut Stats,
) -> Result<(), String> {
    for p in plan {
        let Plan::File { name, path, size } = p else {
            continue;
        };
        if cancel.load(Ordering::Relaxed) || reporter.cancelled() {
            return Err(super::job::Cancelled.to_string());
        }
        let f = File::open(path).map_err(|e| format!("打开 {} 失败: {}", path.display(), e))?;
        reporter.set_entry(name);
        let tracked = super::io::TrackingReader::new(
            BufReader::with_capacity(256 * 1024, f),
            cancel,
            |n| reporter.advance_bytes(n),
        );
        match w.push_archive_entry(ArchiveEntry::from_path(path, name.clone()), Some(tracked)) {
            Ok(_) => {
                stats.entries_done += 1;
                stats.bytes_done += size;
                // 字节已经由 TrackingReader 边读边推进了，这里再传 size 会算两遍
                reporter.entry_done(name, 0);
            }
            Err(e) => return Err(push_err(e, name)),
        }
    }
    Ok(())
}

/// solid：按 512 MiB / 8192 条切块，每块一次 `push_archive_entries`。
/// 进度只能在块之间刷新（回调拿不到 reporter），所以块不宜过大——见模块头。
fn push_solid(
    w: &mut ArchiveWriter<File>,
    plan: &[Plan],
    reporter: &mut Reporter,
    cancel: &AtomicBool,
    stats: &mut Stats,
) -> Result<(), String> {
    let counter = AtomicU64::new(0);
    let files: Vec<&Plan> = plan
        .iter()
        .filter(|p| matches!(p, Plan::File { .. }))
        .collect();

    let mut i = 0usize;
    while i < files.len() {
        if cancel.load(Ordering::Relaxed) || reporter.cancelled() {
            return Err(super::job::Cancelled.to_string());
        }
        let mut entries: Vec<ArchiveEntry> = Vec::new();
        let mut readers: Vec<SourceReader<LazySrc<'_>>> = Vec::new();
        let mut batch_bytes = 0u64;
        let mut batch_names: Vec<&str> = Vec::new();
        while i < files.len() {
            let Plan::File { name, path, size } = files[i] else {
                i += 1;
                continue;
            };
            if !entries.is_empty()
                && (batch_bytes + size > SOLID_BLOCK_BYTES || entries.len() >= SOLID_BLOCK_FILES)
            {
                break;
            }
            entries.push(ArchiveEntry::from_path(path, name.clone()));
            readers.push(SourceReader::new(LazySrc {
                path: path.clone(),
                inner: None,
                eof: false,
                counter: &counter,
                cancel,
            }));
            batch_bytes += size;
            batch_names.push(name);
            i += 1;
        }
        if entries.is_empty() {
            continue;
        }
        let n = entries.len();
        reporter.set_entry(&format!("{} 等 {} 个文件", batch_names[0], n));
        let before = counter.load(Ordering::Relaxed);
        // push_archive_entries 在长度不等时会 panic（assert_eq!），这里天然相等
        if let Err(e) = w.push_archive_entries(entries, readers) {
            return Err(push_err(e, batch_names.first().unwrap_or(&"?")));
        }
        // 计数器是跨批复用的绝对值，只把这一批的增量报进进度
        reporter.advance_bytes(counter.load(Ordering::Relaxed) - before);
        stats.entries_done += n as u64;
        stats.bytes_done += batch_bytes;
        reporter.entry_done(&format!("solid 块（{} 个文件）", n), 0);
    }
    Ok(())
}

fn push_err(e: SzError, name: &str) -> String {
    match &e {
        SzError::Io(ioe, _) if is_cancelled(ioe) => super::job::Cancelled.to_string(),
        _ => format!("压缩 {} 失败: {:?}", name, e),
    }
}

/// 7z 不支持"追加"（见模块头第 3 条），但 mod.rs 需要一个统一的错误出口，
/// 免得前端收到一句干巴巴的 "unsupported"。
pub fn add_unsupported() -> String {
    "7z 不支持追加：它的目录在文件末尾，加一个条目就得整体重写。\
     请用「新建压缩」重新打包，或改用 zip / tar 格式。"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::super::job::Kind;
    use super::*;

    fn rep(kind: Kind) -> Reporter {
        Reporter::detached("t".into(), kind, "t.7z".into(), String::new())
    }

    fn fixture(dir: &Path) -> Vec<PathBuf> {
        let src = dir.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"hello 7z").unwrap();
        fs::write(src.join("sub/b.bin"), vec![0xABu8; 5000]).unwrap();
        fs::create_dir_all(src.join("empty-dir")).unwrap();
        vec![src]
    }

    fn roundtrip(dir: &Path, opts: CreateOptions) -> PathBuf {
        let sources = fixture(dir);
        let dest = dir.join("out.7z");
        let cancel = AtomicBool::new(false);
        let stats = create(&sources, &dest, &opts, &mut rep(Kind::Create), &cancel).unwrap();
        assert!(stats.entries_done >= 2, "{:?}", stats);
        dest
    }

    #[test]
    fn lzma2_roundtrip() {
        let dir = crate::test_bridge::TempDir::new("7z-lzma2");
        let dest = roundtrip(
            &dir,
            CreateOptions {
                format: "7z".into(),
                level: Some(5),
                ..Default::default()
            },
        );
        let (entries, meta) = list(&dest, None).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert!(names.contains(&"src/a.txt"), "{:?}", names);
        assert!(names.contains(&"src/sub/b.bin"), "{:?}", names);
        // 空目录必须作为真正的目录条目存下来，否则解出来就丢了
        assert!(names.contains(&"src/empty-dir"), "{:?}", names);
        assert!(!meta.solid);
        assert!(!meta.needs_password);
        let m = entries.iter().find(|e| e.path == "src/a.txt").unwrap();
        assert!(m.method.contains("LZMA2"), "{}", m.method);
        assert_eq!(m.size, 8);

        let out = dir.join("x");
        fs::create_dir_all(&out).unwrap();
        let cancel = AtomicBool::new(false);
        let stats = extract(&dest, &out, &ExtractOptions::default(), &mut rep(Kind::Extract), &cancel).unwrap();
        assert!(stats.errors.is_empty(), "{:?}", stats.errors);
        assert_eq!(fs::read(out.join("src/a.txt")).unwrap(), b"hello 7z");
        assert_eq!(fs::read(out.join("src/sub/b.bin")).unwrap().len(), 5000);
        assert!(out.join("src/empty-dir").is_dir(), "空目录丢了");
    }

    #[test]
    fn solid_roundtrip_and_dir_rollup() {
        let dir = crate::test_bridge::TempDir::new("7z-solid");
        let dest = roundtrip(
            &dir,
            CreateOptions {
                format: "7z".into(),
                solid: true,
                ..Default::default()
            },
        );
        let (mut entries, meta) = list(&dest, None).unwrap();
        assert!(meta.solid, "solid 标志要读得出来");
        // 目录大小的子树汇总已经上移到 mod.rs（六个后端共用一份），
        // 这里照样跑一遍：验证的是 7z 的目录条目喂给那份共享实现能不能算对
        crate::archive::rollup_dir_sizes(&mut entries);
        let sub = entries.iter().find(|e| e.path == "src/sub" && e.is_dir).unwrap();
        assert_eq!(sub.size, 5000, "目录大小要按子树汇总");
        // solid 下单条目的 packed 没有意义，必须如实填 0
        assert!(entries.iter().filter(|e| !e.is_dir).all(|e| e.packed == 0));

        let out = dir.join("x");
        fs::create_dir_all(&out).unwrap();
        let cancel = AtomicBool::new(false);
        extract(&dest, &out, &ExtractOptions::default(), &mut rep(Kind::Extract), &cancel).unwrap();
        assert_eq!(fs::read(out.join("src/sub/b.bin")).unwrap().len(), 5000);
    }

    #[test]
    fn solid_extract_of_one_file_still_yields_correct_bytes() {
        // 这条专打"sold 块里未选中条目没排空 → 后续条目读到错位字节"那个坑
        let dir = crate::test_bridge::TempDir::new("7z-solid-partial");
        let dest = roundtrip(
            &dir,
            CreateOptions {
                format: "7z".into(),
                solid: true,
                ..Default::default()
            },
        );
        let out = dir.join("x");
        fs::create_dir_all(&out).unwrap();
        let cancel = AtomicBool::new(false);
        let opts = ExtractOptions {
            entries: Some(vec!["src/sub/b.bin".into()]),
            include_children: false,
            ..Default::default()
        };
        extract(&dest, &out, &opts, &mut rep(Kind::Extract), &cancel).unwrap();
        assert_eq!(fs::read(out.join("src/sub/b.bin")).unwrap(), vec![0xABu8; 5000]);
        assert!(!out.join("src/a.txt").exists(), "没选中的不该解出来");
    }

    #[test]
    fn copy_method_roundtrips() {
        let dir = crate::test_bridge::TempDir::new("7z-copy");
        let dest = roundtrip(
            &dir,
            CreateOptions {
                format: "7z".into(),
                method: Some("copy".into()),
                ..Default::default()
            },
        );
        let (entries, _) = list(&dest, None).unwrap();
        let m = entries.iter().find(|e| e.path == "src/a.txt").unwrap();
        assert!(m.method.contains("COPY"), "{}", m.method);
        assert!(m.packed >= m.size, "Copy 方法下压缩后不该比原文件小");
    }

    #[test]
    fn encrypted_7z_needs_password_and_hides_names() {
        let dir = crate::test_bridge::TempDir::new("7z-aes");
        let dest = roundtrip(
            &dir,
            CreateOptions {
                format: "7z".into(),
                password: Some("s3cret".into()),
                encrypt_header: true,
                ..Default::default()
            },
        );
        // 不带密码：连列表都拿不到，且必须被识别成"需要密码"而不是"文件坏了"
        assert!(needs_password(&dest));
        let err = list(&dest, None).unwrap_err();
        assert!(err.contains("密码"), "{}", err);

        // 错密码
        let err = list(&dest, Some("wrong")).unwrap_err();
        assert!(err.contains("密码错误"), "{}", err);

        // 对密码
        let (entries, meta) = list(&dest, Some("s3cret")).unwrap();
        assert!(meta.encrypted_headers);
        assert!(meta.needs_password);
        assert!(entries.iter().any(|e| e.encrypted), "条目要标出加密");

        let out = dir.join("x");
        fs::create_dir_all(&out).unwrap();
        let cancel = AtomicBool::new(false);
        let opts = ExtractOptions {
            password: Some("s3cret".into()),
            ..Default::default()
        };
        extract(&dest, &out, &opts, &mut rep(Kind::Extract), &cancel).unwrap();
        assert_eq!(fs::read(out.join("src/a.txt")).unwrap(), b"hello 7z");
    }

    #[test]
    fn encrypted_content_only_keeps_names_readable() {
        let dir = crate::test_bridge::TempDir::new("7z-aes-noname");
        let dest = roundtrip(
            &dir,
            CreateOptions {
                format: "7z".into(),
                password: Some("pw".into()),
                encrypt_header: false, // 只加密内容，文件名保持明文
                ..Default::default()
            },
        );
        // 文件名没加密 → 不带密码也能列出目录，但解不开内容
        let (entries, meta) = list(&dest, None).unwrap();
        assert!(!meta.encrypted_headers);
        assert!(entries.iter().any(|e| e.encrypted));
        assert!(meta.needs_password);
        assert!(entries.iter().any(|e| e.path == "src/a.txt"));
    }

    #[test]
    fn test_archive_passes_and_detects_rot() {
        let dir = crate::test_bridge::TempDir::new("7z-test");
        let dest = roundtrip(&dir, CreateOptions::default());
        let cancel = AtomicBool::new(false);
        let stats = test(&dest, &ExtractOptions::default(), &mut rep(Kind::Test), &cancel).unwrap();
        assert!(stats.entries_done >= 2, "{:?}", stats);
        assert!(stats.errors.is_empty());

        // 翻数据区一个字节，CRC 必须报出来
        let mut bytes = fs::read(&dest).unwrap();
        let n = bytes.len();
        bytes[n / 2] ^= 0xFF;
        fs::write(&dest, &bytes).unwrap();
        let cancel = AtomicBool::new(false);
        let r = test(&dest, &ExtractOptions::default(), &mut rep(Kind::Test), &cancel);
        assert!(r.is_err(), "坏数据没被 CRC 抓出来");
    }

    #[test]
    fn volumes_are_refused_not_silently_ignored() {
        let dir = crate::test_bridge::TempDir::new("7z-vol");
        let sources = fixture(&dir);
        let cancel = AtomicBool::new(false);
        let err = create(
            &sources,
            &dir.join("v.7z"),
            &CreateOptions {
                volume_size: Some(1024),
                ..Default::default()
            },
            &mut rep(Kind::Create),
            &cancel,
        )
        .unwrap_err();
        assert!(err.contains("分卷"), "{}", err);
        assert!(!dir.join("v.7z").exists(), "失败时不该留下残缺文件");
    }

    #[test]
    fn unknown_method_errors_instead_of_downgrading() {
        // 静默降级成 LZMA2 会让用户拿到一个和预期完全不同的包，必须明确报错。
        // 这个用例只问 methods_of，不碰文件系统，所以不需要 TempDir
        let err = methods_of(&CreateOptions {
            method: Some("ppmd".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.contains("ppmd"), "{}", err);
    }

    #[test]
    fn cancel_stops_create() {
        let dir = crate::test_bridge::TempDir::new("7z-cancel");
        let sources = fixture(&dir);
        let cancel = AtomicBool::new(true);
        let err = create(
            &sources,
            &dir.join("c.7z"),
            &CreateOptions::default(),
            &mut rep(Kind::Create),
            &cancel,
        )
        .unwrap_err();
        assert!(err.contains("已取消"), "{}", err);
    }

    #[test]
    fn cancel_stops_extract() {
        let dir = crate::test_bridge::TempDir::new("7z-cancel-x");
        let dest = roundtrip(&dir, CreateOptions::default());
        let out = dir.join("x");
        fs::create_dir_all(&out).unwrap();
        let cancel = AtomicBool::new(true);
        let err = extract(&dest, &out, &ExtractOptions::default(), &mut rep(Kind::Extract), &cancel).unwrap_err();
        assert!(err.contains("已取消"), "{}", err);
    }

    #[test]
    fn nt_time_converts_to_unix_seconds() {
        let st = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let nt: NtTime = st.try_into().unwrap();
        assert_eq!(nt_to_unix(nt, true), 1_700_000_000);
        assert_eq!(nt_to_unix(nt, false), 0, "没有该时间字段时要返回 0");
        // 默认 NtTime 是公元 0001，早于 Unix 纪元，不能 panic 也不能给出负数
        assert_eq!(nt_to_unix(NtTime::default(), true), 0);
    }

    #[test]
    fn non_7z_reports_cleanly() {
        let dir = crate::test_bridge::TempDir::new("7z-bad");
        let p = dir.join("x.7z");
        fs::write(&p, b"not a 7z archive at all").unwrap();
        let err = list(&p, None).unwrap_err();
        assert!(err.contains("7z"), "{}", err);
    }

    #[test]
    fn split_7z_gets_a_specific_hint() {
        let dir = crate::test_bridge::TempDir::new("7z-split");
        let p = dir.join("big.7z.001");
        fs::write(&p, b"garbage").unwrap();
        let err = list(&p, None).unwrap_err();
        assert!(err.contains("分卷"), "{}", err);
    }

    #[test]
    fn mtime_survives_roundtrip() {
        let dir = crate::test_bridge::TempDir::new("7z-mtime");
        let dest = roundtrip(&dir, CreateOptions::default());
        let (entries, _) = list(&dest, None).unwrap();
        let m = entries.iter().find(|e| e.path == "src/a.txt").unwrap();
        let on_disk = super::super::io::mtime_of(&fs::metadata(dir.join("src/a.txt")).unwrap());
        assert!(m.modified > 0, "7z 必须存修改时间");
        assert!(
            (m.modified as u64).abs_diff(on_disk) <= 2,
            "时间戳对不上: 归档 {} vs 磁盘 {}",
            m.modified,
            on_disk
        );
    }
}
