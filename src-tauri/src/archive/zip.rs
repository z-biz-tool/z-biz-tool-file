//! ZIP：读写都完整支持，含 AES-256 加密、注释、追加（不解压地拷贝原有条目）。
//!
//! 三个和"能替换 7-Zip"直接相关的点：
//! 1. **列表不解压**。`by_index_data(i)` 只读中央目录，不 seek 到数据区。8638 个条目的
//!    7.4 GB 包秒开；`by_index(i)` 会把每个条目的 reader 建起来，慢一个数量级。
//! 2. **CRC 自动校验**。zip crate 在读到 EOF 时用 `Crc32Reader` 比对，损坏包会报
//!    "Invalid checksum"，不需要自己再算一遍。这也是"测试压缩包"功能的实现基础。
//! 3. **追加用 `raw_copy_file`**。原有条目的压缩字节直接搬过去，既不重新压缩（快），
//!    也不需要密码就能搬加密条目（密码只在解开时才需要）。

use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

// Datelike/Timelike 要显式引进来：`unix_to_dos` 取的 year()/month()/hour() 都是
// 这两个 trait 上的方法，不在作用域里就是"方法不存在"
use chrono::{Datelike, Timelike, TimeZone};
use zip::read::ZipArchive;
use zip::write::{FileOptions, ZipWriter};
use zip::{AesMode, CompressionMethod, DateTime};

use super::guard;
use super::io::TrackingReader;
use super::job::Reporter;
use super::select::{map_output, normalize, single_root, Selector};
use super::types::{CreateOptions, Entry, ExtractOptions, Stats};

/// 列表 / 抽取用的条目元信息快照。
///
/// 为什么要抄一份：`by_index_data(i)` 借 `&self`，`by_index(i)` 借 `&mut self`，
/// 两个借用不能重叠。先扫一遍把字段抄下来（顺带算出进度总量），再逐条取数据。
#[derive(Debug, Clone)]
struct Meta {
    index: usize,
    path: String,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
    packed: u64,
    modified: i64,
    mode: Option<u32>,
    encrypted: bool,
    crc: u32,
    method: String,
}

type Ar = ZipArchive<BufReader<File>>;

fn open(path: &Path) -> Result<Ar, String> {
    let f = File::open(path).map_err(|e| format!("打开失败: {}", e))?;
    ZipArchive::new(BufReader::with_capacity(256 * 1024, f))
        .map_err(|e| format!("不是有效的 ZIP（或中央目录已损坏）: {}", e))
}

/// 体检用：只读中央目录，确认这真的是个 zip。
///
/// zip 的目录本身不加密（加密的只是条目数据），所以这里不存在"需要密码"这一档，
/// 失败只有"不是 zip / 中央目录损坏 / 分卷缺最后一卷"，一律归到 `Failed`。
pub fn open_status(path: &Path) -> super::OpenStatus {
    match open(path) {
        Ok(_) => super::OpenStatus::Ok,
        Err(message) => super::OpenStatus::Failed { message },
    }
}

fn scan(ar: &mut Ar) -> Result<Vec<Meta>, String> {    let n = ar.len();
    let mut out = Vec::with_capacity(n.min(super::MAX_ENTRIES));
    for i in 0..n {
        let e = ar
            .by_index_data(i)
            .map_err(|e| format!("读取条目 #{} 失败: {}", i, e))?;
        // ZIP 允许非 UTF-8 的条目名（CP437/GBK 时代的老包）。zip crate 会尽力转，
        // 转不出来时给个占位名，比整包打不开强。
        let raw = e
            .name()
            .map(|c| c.to_string())
            .unwrap_or_else(|_| format!("<非 UTF-8 名字 #{}>", i));
        out.push(Meta {
            index: i,
            path: raw,
            is_dir: e.is_dir(),
            is_symlink: e.is_symlink(),
            size: e.size(),
            packed: e.compressed_size(),
            modified: dos_to_unix(e.last_modified()),
            mode: e.unix_mode(),
            encrypted: e.encrypted(),
            crc: e.crc32(),
            method: method_label(e.compression()),
        });
        if out.len() >= super::MAX_ENTRIES {
            break;
        }
    }
    Ok(out)
}

/// MS-DOS 时间是**本地时间**（ZIP 格式诞生时没考虑时区），直接按 UTC 解释会比
/// 北京时间早 8 小时，列表里每个文件的时间都是错的。这里补上本地偏移。
fn dos_to_unix(dt: Option<DateTime>) -> i64 {
    let Some(t) = dt else { return 0 };
    let date = chrono::NaiveDate::from_ymd_opt(t.year() as i32, t.month() as u32, t.day() as u32);
    let time = chrono::NaiveTime::from_hms_opt(t.hour() as u32, t.minute() as u32, t.second() as u32);
    let (Some(d), Some(tm)) = (date, time) else {
        return 0;
    };
    let naive = chrono::NaiveDateTime::new(d, tm);
    // from_local_datetime 在夏令时切换的模糊小时里会给 Ambiguous/None；
    // 取 earliest 就够——这是显示用的时间，不是审计用的。
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| chrono::Local.from_local_datetime(&naive).earliest())
        .map(|dt| dt.timestamp())
        .unwrap_or_else(|| naive.and_utc().timestamp())
}

fn unix_to_dos(secs: u64) -> DateTime {
    let naive = chrono::DateTime::from_timestamp(secs as i64, 0)
        .map(|d| d.with_timezone(&chrono::Local).naive_local());
    match naive {
        Some(d) => DateTime::from_date_and_time(
            d.year() as u16,
            d.month() as u8,
            d.day() as u8,
            d.hour() as u8,
            d.minute() as u8,
            d.second() as u8,
        )
        .unwrap_or_else(|_| DateTime::default_for_write()),
        None => DateTime::default_for_write(),
    }
}

fn method_label(m: CompressionMethod) -> String {
    let s = match m {
        CompressionMethod::Stored => "Store",
        CompressionMethod::Deflated => "Deflate",
        CompressionMethod::Deflate64 => "Deflate64",
        CompressionMethod::Bzip2 => "BZip2",
        CompressionMethod::Lzma => "LZMA",
        CompressionMethod::Zstd => "Zstd",
        CompressionMethod::Xz => "XZ",
        CompressionMethod::Ppmd => "PPMd",
        CompressionMethod::Aes => "AES",
        other => return other.to_string(),
    };
    s.to_string()
}

// ============================================================================
// 列举
// ============================================================================

pub fn list(path: &Path) -> Result<Vec<Entry>, String> {
    let mut ar = open(path)?;
    let metas = scan(&mut ar)?;
    let mut entries: Vec<Entry> = metas
        .iter()
        .map(|m| {
            let p = normalize(&m.path);
            let name = p.rsplit('/').next().unwrap_or("").to_string();
            Entry {
                index: m.index as u32,
                path: p,
                name,
                is_dir: m.is_dir,
                size: m.size,
                packed: m.packed,
                modified: m.modified,
                method: m.method.clone(),
                encrypted: m.encrypted,
                crc: m.crc,
                comment: String::new(),
                symlink_target: String::new(),
            }
        })
        .collect();
    fill_symlink_targets(&mut ar, &metas, &mut entries);
    // ZIP 里的目录条目自身大小永远是 0，表格里一整列 0 B 看着像坏了。子树汇总统一在
    // mod.rs::info() 的出口处做（六个后端共用一份），这里如实返回原始值。
    Ok(entries)
}

/// 符号链接的目标就是文件内容本身，读一下很便宜（几乎总是几十字节）。
/// 加密的条目读不了，跳过——UI 上那格留空，不影响解压。
fn fill_symlink_targets(ar: &mut Ar, metas: &[Meta], entries: &mut [Entry]) {
    for (i, m) in metas.iter().enumerate() {
        if !m.is_symlink || m.encrypted || i >= entries.len() {
            continue;
        }
        if let Ok(mut f) = ar.by_index(m.index) {
            let mut buf = String::new();
            if f.read_to_string(&mut buf).is_ok() {
                entries[i].symlink_target = buf;
            }
        }
    }
}

/// 归档注释（前端"属性"里显示）
pub fn archive_comment(path: &Path) -> String {
    let Ok(ar) = open(path) else {
        return String::new();
    };
    String::from_utf8_lossy(ar.comment()).trim().to_string()
}

// ============================================================================
// 解压
// ============================================================================

pub fn extract(
    path: &Path,
    dest: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let mut ar = open(path)?;
    let metas = scan(&mut ar)?;
    let sel = Selector::new(opts.entries.clone(), opts.include_children);
    let strip_root = if opts.strip_root {
        single_root(metas.iter().map(|m| m.path.as_str()))
    } else {
        None
    };

    let work: Vec<&Meta> = metas.iter().filter(|m| sel.matches(&m.path)).collect();
    let total_bytes: u64 = work.iter().map(|m| m.size).sum();
    reporter.set_totals(work.len() as u64, total_bytes);
    reporter.set_phase("working");
    fs::create_dir_all(dest).map_err(|e| format!("创建目标目录失败: {}", e))?;

    let pw = opts.password.as_deref().map(|s| s.as_bytes());
    let mut stats = Stats::default();
    let started = std::time::Instant::now();

    for m in work {
        if cancel.load(Ordering::Relaxed) || reporter.cancelled() {
            stats.elapsed_ms = started.elapsed().as_millis() as u64;
            return Err(super::job::Cancelled.to_string());
        }
        reporter.set_entry(&m.path);
        let out_rel = map_output(&m.path, strip_root.as_deref(), opts.flatten);
        // 剥壳后顶层目录自己变成空字符串：它已经由 create_dir_all(dest) 建出来了
        if out_rel.is_empty() {
            continue;
        }
        match write_one(
            &mut ar, m, dest, &out_rel, pw, opts, cancel, reporter, &mut stats,
        ) {
            Ok(()) => {}
            Err(e) if is_cancel(&e) => {
                stats.elapsed_ms = started.elapsed().as_millis() as u64;
                return Err(e);
            }
            Err(e) => {
                let msg = format!("{}: {}", m.path, e);
                if opts.keep_broken {
                    stats.errors.push(msg);
                } else {
                    stats.elapsed_ms = started.elapsed().as_millis() as u64;
                    return Err(msg);
                }
            }
        }
    }

    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(stats)
}

#[allow(clippy::too_many_arguments)]
fn write_one(
    ar: &mut Ar,
    m: &Meta,
    dest: &Path,
    out_rel: &str,
    pw: Option<&[u8]>,
    opts: &ExtractOptions,
    cancel: &AtomicBool,
    reporter: &mut Reporter,
    stats: &mut Stats,
) -> Result<(), String> {
    let target = match guard::resolve_target(dest, out_rel, opts.overwrite).map_err(|e| e.to_string())? {
        Some(t) => t,
        None => {
            stats.skipped += 1;
            // 跳过的条目也要把字节数记上，否则进度条永远到不了 100%
            reporter.advance_bytes(m.size);
            return Ok(());
        }
    };

    if m.is_dir {
        fs::create_dir_all(&target).map_err(|e| format!("建目录失败: {}", e))?;
        if let Some(mode) = m.mode {
            let _ = guard::apply_mode(&target, mode);
        }
        return Ok(());
    }

    if let Some(p) = target.parent() {
        fs::create_dir_all(p).map_err(|e| format!("建上级目录失败: {}", e))?;
    }

    let mut f = if m.encrypted {
        let Some(p) = pw else {
            return Err("已加密，需要密码".to_string());
        };
        ar.by_index_decrypt(m.index, p).map_err(decrypt_err)?
    } else {
        ar.by_index(m.index)
            .map_err(|e| format!("定位条目失败: {}", e))?
    };

    let file = File::create(&target).map_err(|e| format!("创建文件失败: {}", e))?;
    let mut out = io::BufWriter::with_capacity(256 * 1024, file);
    let res = super::io::copy_with_cancel(&mut f, &mut out, cancel, |n| reporter.advance_bytes(n));
    drop(out);
    match res {
        Ok(_) => {}
        Err(e) => {
            // 失败时把半成品删掉：留一个截断的文件在那儿，用户会以为解压成功了
            let _ = fs::remove_file(&target);
            if super::io::is_cancelled(&e) {
                return Err(super::job::Cancelled.to_string());
            }
            return Err(read_err(e));
        }
    }

    if let Some(mode) = m.mode {
        let _ = guard::apply_mode(&target, mode);
    }
    super::io::set_mtime(&target, m.modified.max(0) as u64);
    stats.entries_done += 1;
    stats.bytes_done += m.size;
    Ok(())
}

/// 密码错误有两层表现：AES 和多数 ZipCrypto 会在头部校验时直接返回 `InvalidPassword`；
/// 但 ZipCrypto 的校验只有 1/256 的把握，错密码常常一路解到 CRC 才对不上。
/// 两种都要说"密码不对"，否则用户会以为压缩包坏了、去重下一遍。
fn decrypt_err(e: zip::result::ZipError) -> String {
    match e {
        zip::result::ZipError::InvalidPassword => "密码不正确".to_string(),
        zip::result::ZipError::UnsupportedArchive(s) => format!("不支持: {}", s),
        other => format!("{}", other),
    }
}

fn read_err(e: io::Error) -> String {
    // zip crate 的 Crc32Reader 在读完时比对 CRC，不匹配就报 "Invalid checksum"
    if e.to_string().contains("Invalid checksum") {
        return "校验失败（CRC 不匹配：文件损坏或密码错误）".to_string();
    }
    if e.to_string().contains("Invalid password") {
        return "密码不正确".to_string();
    }
    format!("读取失败: {}", e)
}

fn is_cancel(msg: &str) -> bool {
    msg == super::job::Cancelled.to_string()
}

// ============================================================================
// 完整性测试
// ============================================================================

/// 把每个条目读到 EOF。CRC 由 zip crate 的 `Crc32Reader` 在收尾时比对，
/// 所以"能读完"就等于"数据没坏"。加密条目没有密码就跳过并记进 errors。
pub fn test(
    path: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let mut ar = open(path)?;
    let metas = scan(&mut ar)?;
    let total_bytes: u64 = metas.iter().map(|m| m.size).sum();
    reporter.set_totals(metas.len() as u64, total_bytes);
    reporter.set_phase("working");

    let pw = opts.password.as_deref().map(|s| s.as_bytes());
    let mut stats = Stats::default();
    let started = std::time::Instant::now();

    for m in &metas {
        if cancel.load(Ordering::Relaxed) || reporter.cancelled() {
            return Err(super::job::Cancelled.to_string());
        }
        reporter.set_entry(&m.path);
        if m.is_dir {
            continue;
        }
        let mut f = if m.encrypted {
            match pw {
                Some(p) => ar.by_index_decrypt(m.index, p).map_err(decrypt_err)?,
                None => {
                    stats.skipped += 1;
                    stats.errors.push(format!("{}: 已加密，未提供密码", m.path));
                    reporter.advance_bytes(m.size);
                    continue;
                }
            }
        } else {
            ar.by_index(m.index)
                .map_err(|e| format!("定位条目失败: {}", e))?
        };
        match super::io::copy_with_cancel(&mut f, &mut io::sink(), cancel, |n| {
            reporter.advance_bytes(n)
        }) {
            Ok(_) => {
                stats.entries_done += 1;
                stats.bytes_done += m.size;
            }
            Err(e) => {
                if super::io::is_cancelled(&e) {
                    return Err(super::job::Cancelled.to_string());
                }
                stats.errors.push(format!("{}: {}", m.path, read_err(e)));
            }
        }
    }
    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(stats)
}

// ============================================================================
// 创建
// ============================================================================

/// 压缩方法。zip crate 的写路径只支持 Store/Deflate/BZip2/Zstd/XZ
/// （LZMA、Deflate64 能读不能写）。选了就明确报错，**不要静默降级**成 Deflate：
/// 用户明确要 LZMA 说明他在意压缩率，偷偷换成 Deflate 得到的包比预期大得多，
/// 而且他没法从结果看出来发生了什么。
fn method_of(name: &str, level: i32) -> Result<(CompressionMethod, Option<i64>), String> {
    Ok(match name.trim().to_ascii_lowercase().as_str() {
        "" | "deflate" | "zip" => {
            if level <= 0 {
                (CompressionMethod::Stored, None)
            } else {
                (
                    CompressionMethod::Deflated,
                    Some(super::tar::clamp(level, 1, 9) as i64),
                )
            }
        }
        "store" | "stored" | "none" | "copy" => (CompressionMethod::Stored, None),
        "bzip2" | "bz2" => (
            CompressionMethod::Bzip2,
            Some(super::tar::clamp(level, 1, 9) as i64),
        ),
        "zstd" => (
            CompressionMethod::Zstd,
            Some(super::tar::clamp(level, 1, 22) as i64),
        ),
        "xz" => (
            CompressionMethod::Xz,
            Some(super::tar::clamp(level, 0, 9) as i64),
        ),
        "lzma" => {
            return Err(
                "ZIP 不支持写入 LZMA 方法（能读不能写）。想用 LZMA 请改选 7z 格式。".to_string(),
            )
        }
        other => return Err(format!("未知的 ZIP 压缩方法: {}", other)),
    })
}

/// 造一份 FileOptions。
///
/// 中间变量必须显式写成 `FileOptions<'a, 'static, ()>`：`with_aes_encryption` 的签名是
/// `fn(self, mode, password: &'k str) -> FileOptions<'k, 'n, T>`，密码借用期就是 `'k`，
/// 所以 `SimpleFileOptions`（= `FileOptions<'static, 'static, ()>`）根本装不下借来的密码，
/// 编译器会要求 `&'static str`。
fn file_opts<'a>(
    pw: Option<&'a str>,
    method: CompressionMethod,
    level: Option<i64>,
) -> FileOptions<'a, 'static, ()> {
    let o: FileOptions<'a, 'static, ()> = FileOptions::default()
        .compression_method(method)
        .compression_level(level)
        .large_file(true);
    match pw {
        Some(p) => o.with_aes_encryption(AesMode::Aes256, p),
        None => o,
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
        return Err("ZIP 不支持分卷。需要分卷请改选 7z 格式。".to_string());
    }
    let level = opts.level.unwrap_or(6);
    let (method, clevel) = method_of(opts.method.as_deref().unwrap_or(""), level)?;
    let pw = opts.password.as_deref().filter(|s| !s.is_empty());

    if let Some(p) = dest.parent() {
        fs::create_dir_all(p).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }
    let file = File::create(dest).map_err(|e| format!("创建目标文件失败: {}", e))?;
    // auto_large_file：超过 4 GB 的条目自动切 ZIP64。不开的话写大文件会在收尾时报错，
    // 而那时用户已经等了很久。
    let mut writer = ZipWriter::new(file).set_auto_large_file();
    if let Some(c) = opts.comment.as_deref().filter(|s| !s.is_empty()) {
        writer
            .set_comment(c)
            .map_err(|e| format!("写入注释失败: {}", e))?;
    }

    let (total_files, total_bytes) = super::tar::scan_sources(sources)?;
    reporter.set_totals(total_files, total_bytes);
    reporter.set_phase("working");

    let mut stats = Stats::default();
    for src in sources {
        add_path(
            &mut writer,
            src,
            src.parent().unwrap_or(src),
            method,
            clevel,
            pw,
            opts,
            reporter,
            cancel,
            &mut stats,
        )?;
    }
    writer
        .finish()
        .map_err(|e| format!("收尾 ZIP 失败: {}", e))?;
    Ok(stats)
}

/// `base` 是"归档内路径的基准目录"，递归时原样往下传，不要每层重算。
///
/// 顶层调用传 `(src, src.parent())`：`D:\a\b\dir` → `dir/`、`dir/sub/x.txt`，
/// 和 7-Zip 右键"添加到压缩包"一致。传成 `(src, src)` 的话顶层叫 `dir` 而子项叫
/// `sub/x.txt`，解出来是一堆散落的目录。
#[allow(clippy::too_many_arguments)]
fn add_path(
    writer: &mut ZipWriter<File>,
    src: &Path,
    base: &Path,
    method: CompressionMethod,
    clevel: Option<i64>,
    pw: Option<&str>,
    opts: &CreateOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
    stats: &mut Stats,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) || reporter.cancelled() {
        return Err(super::job::Cancelled.to_string());
    }
    if super::tar::excluded(src, &opts.exclude_patterns) {
        stats.skipped += 1;
        return Ok(());
    }
    let meta = fs::symlink_metadata(src)
        .map_err(|e| format!("读取 {} 失败: {}", src.display(), e))?;
    let name = super::tar::archive_name_for(src, base, opts.store_full_path)?;
    if name.is_empty() {
        return Ok(());
    }

    if meta.is_dir() {
        writer
            // 目录条目不加密也不需要压缩参数，所以这里可以用 `'static`；
            // 类型参数必须写全，`FileOptions::default()` 推不出 T
            .add_directory(format!("{}/", name), FileOptions::<'static, 'static, ()>::default())
            .map_err(|e| format!("写入目录 {} 失败: {}", name, e))?;
        stats.entries_done += 1;
        for child in read_dir_sorted(src)? {
            add_path(
                writer, &child, base, method, clevel, pw, opts, reporter, cancel, stats,
            )?;
        }
        return Ok(());
    }
    if !meta.is_file() {
        // 符号链接、命名管道、设备文件：按普通文件读会得到怪东西（链接目标、阻塞、
        // 读到 EOF 为止的随机字节）。明确跳过并计数，别静默产出错误的归档。
        stats.skipped += 1;
        return Ok(());
    }

    let mtime = super::io::mtime_of(&meta);
    let o = file_opts(pw, method, clevel).last_modified_time(unix_to_dos(mtime));
    #[cfg(unix)]
    let o = o.unix_permissions(super::io::unix_mode_of(&meta));

    reporter.set_entry(&name);
    writer
        .start_file(&name, o)
        .map_err(|e| format!("开始写入 {} 失败: {}", name, e))?;
    let f = File::open(src).map_err(|e| format!("打开 {} 失败: {}", src.display(), e))?;
    let mut r = TrackingReader::new(BufReader::with_capacity(256 * 1024, f), cancel, |n| {
        reporter.advance_bytes(n)
    });
    let copied = io::copy(&mut r, writer.by_ref());
    // r 借走了 reporter，必须先掉下去才能再调 reporter 的方法
    drop(r);
    match copied {
        Ok(n) => {
            stats.entries_done += 1;
            stats.bytes_done += n;
            reporter.entry_done(&name, 0);
        }
        Err(e) => {
            if super::io::is_cancelled(&e) {
                return Err(super::job::Cancelled.to_string());
            }
            return Err(format!("写入 {} 失败: {}", name, e));
        }
    }
    Ok(())
}

/// 目录按名字排序后再压。
///
/// 不排序的话条目顺序取决于文件系统的 readdir 顺序（NTFS 是 B-tree 序，FAT 是创建序），
/// 同一个文件夹压两次会得到字节不同的包：`find_duplicate_files` 认不出它们是同一份，
/// 用户也没法用 hash 判断"我到底改了没有"。
fn read_dir_sorted(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("遍历 {} 失败: {}", dir.display(), e))?
        .filter_map(|d| d.ok().map(|d| d.path()))
        .collect();
    v.sort();
    Ok(v)
}

// ============================================================================
// 追加
// ============================================================================

/// 往已有 ZIP 里加东西。
///
/// `raw_copy_file` 把原条目的**压缩后字节**直接搬进新包：不解压、不重压、不需要密码
/// （连加密条目也能搬，搬的是密文）。所以给一个 2 GB 的包追加一个 1 KB 文件，代价是
/// "读写各一遍 2 GB"而不是"重新压缩 2 GB"。
///
/// 落到临时文件再 `rename` 覆盖：中途取消或断电时原包完好，不会得到一个既不是旧包
/// 也不是新包的半个文件。
pub fn add(
    archive: &Path,
    sources: &[PathBuf],
    opts: &CreateOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    if opts.volume_size.unwrap_or(0) > 0 {
        return Err("ZIP 不支持分卷。".to_string());
    }
    let level = opts.level.unwrap_or(6);
    let (method, clevel) = method_of(opts.method.as_deref().unwrap_or(""), level)?;
    let pw = opts.password.as_deref().filter(|s| !s.is_empty());

    let mut src_ar = open(archive)?;
    let metas = scan(&mut src_ar)?;
    let (new_files, new_bytes) = super::tar::scan_sources(sources)?;
    let new_names = collect_names(sources, opts)?;
    reporter.set_totals(metas.len() as u64 + new_files, new_bytes);
    reporter.set_phase("working");

    let tmp = unique_temp_sibling(archive);
    let out = File::create(&tmp).map_err(|e| format!("创建临时文件失败: {}", e))?;
    let mut writer = ZipWriter::new(out).set_auto_large_file();
    if let Some(c) = opts.comment.as_deref().filter(|s| !s.is_empty()) {
        writer
            .set_comment(c)
            .map_err(|e| format!("写入注释失败: {}", e))?;
    }

    let mut stats = Stats::default();
    let started = std::time::Instant::now();
    let result = (|| -> Result<(), String> {
        for m in &metas {
            if cancel.load(Ordering::Relaxed) || reporter.cancelled() {
                return Err(super::job::Cancelled.to_string());
            }
            reporter.set_entry(&m.path);
            if new_names.contains(&normalize(&m.path)) {
                // 新的替掉旧的：不搬运这条，稍后 add_path 会写一份新的进来
                stats.skipped += 1;
                reporter.entry_done(&m.path, 0);
                continue;
            }
            let f = src_ar
                .by_index_raw(m.index)
                .map_err(|e| format!("读取原条目 {} 失败: {}", m.path, e))?;
            writer
                .raw_copy_file(f)
                .map_err(|e| format!("拷贝原条目 {} 失败: {}", m.path, e))?;
            stats.entries_done += 1;
            stats.bytes_done += m.size;
            reporter.entry_done(&m.path, 0);
        }
        for src in sources {
            add_path(
                &mut writer,
                src,
                src.parent().unwrap_or(src),
                method,
                clevel,
                pw,
                opts,
                reporter,
                cancel,
                &mut stats,
            )?;
        }
        Ok(())
    })();

    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(()) => {
            writer
                .finish()
                .map_err(|e| format!("收尾 ZIP 失败: {}", e))?;
            replace(archive, &tmp)?;
            Ok(stats)
        }
        Err(e) => {
            // 原包一个字节都没动过，只删自己建的临时文件
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn unique_temp_sibling(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or(Path::new("."));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("archive");
    parent.join(format!("{}.{}.zbtzip.tmp", stem, uuid::Uuid::new_v4()))
}

/// 预扫一遍待追加的源，算出它们在包内的名字。
///
/// 用途只有一个：追加时把**同名的旧条目**丢掉。ZIP 格式允许重名条目，但解压时
/// 遇到哪个算哪个，用户看到的是"我明明加进去了，内容还是旧的"。7-Zip 在这种情况下
/// 是直接替换的，跟上。
fn collect_names(sources: &[PathBuf], opts: &CreateOptions) -> Result<std::collections::HashSet<String>, String> {
    let mut names = std::collections::HashSet::new();
    fn walk(
        src: &Path,
        base: &Path,
        opts: &CreateOptions,
        names: &mut std::collections::HashSet<String>,
    ) -> Result<(), String> {
        if super::tar::excluded(src, &opts.exclude_patterns) {
            return Ok(());
        }
        let meta = fs::symlink_metadata(src).map_err(|e| format!("读取 {} 失败: {}", src.display(), e))?;
        let name = super::tar::archive_name_for(src, base, opts.store_full_path)?;
        if name.is_empty() {
            return Ok(());
        }
        names.insert(normalize(&name));
        if meta.is_dir() {
            for child in read_dir_sorted(src)? {
                walk(&child, base, opts, names)?;
            }
        }
        Ok(())
    }
    for src in sources {
        walk(src, src.parent().unwrap_or(src), opts, &mut names)?;
    }
    Ok(names)
}

/// Windows 上 `fs::rename` 覆盖已存在文件是可以的（底层 MoveFileEx 带 REPLACE_EXISTING），
/// 但目标被占用（资源管理器正在预览、杀毒软件正在扫）会失败。失败时**保留**临时文件并
/// 把路径告诉用户——新包已经完整了，删掉等于白干一遍。
fn replace(dest: &Path, tmp: &Path) -> Result<(), String> {
    match fs::rename(tmp, dest) {
        Ok(()) => Ok(()),
        Err(e) => Err(format!(
            "替换 {} 失败（文件可能正被其他程序占用）: {}。新包已完整保存在 {}，可手动改名。",
            dest.display(),
            e,
            tmp.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_bridge::TempDir;

    fn rep(tag: &str) -> Reporter {
        Reporter::detached(
            format!("test-{}", tag),
            super::super::job::Kind::Extract,
            "a.zip".into(),
            "/tmp".into(),
        )
    }

    fn flag() -> AtomicBool {
        AtomicBool::new(false)
    }

    /// 造"什么都不设"的条目选项。`FileOptions::default()` 推不出类型参数 T，
    /// 写全了又啰嗦，测试里统一走这个。
    fn plain_opts() -> FileOptions<'static, 'static, ()> {
        FileOptions::default()
    }

    fn write_tree(dir: &Path) {
        fs::create_dir_all(dir.join("sub/deep")).unwrap();
        fs::write(dir.join("a.txt"), b"hello world").unwrap();
        fs::write(dir.join("sub/b.txt"), b"second file content").unwrap();
        fs::write(dir.join("sub/deep/c.bin"), vec![7u8; 5000]).unwrap();
    }

    fn base_create_opts() -> CreateOptions {
        CreateOptions::default()
    }

    #[test]
    fn zip_roundtrip() {
        let tmp = TempDir::new("zip-rt");
        let src = tmp.join("src");
        write_tree(&src);

        let dest = tmp.join("out.zip");
        create(
            &[src.clone()],
            &dest,
            &base_create_opts(),
            &mut rep("c"),
            &flag(),
        )
        .unwrap();
        assert!(dest.exists() && fs::metadata(&dest).unwrap().len() > 0);

        let entries = list(&dest).unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        // 基准目录是 src 的父目录，所以条目名以 "src/" 开头（7-Zip 的行为）
        for want in ["src", "src/a.txt", "src/sub", "src/sub/deep/c.bin"] {
            assert!(paths.contains(&want), "缺条目 {}，实际: {:?}", want, paths);
        }

        let out = tmp.join("out");
        let ex = ExtractOptions {
            overwrite: guard::Overwrite::Overwrite,
            ..Default::default()
        };
        let stats = extract(&dest, &out, &ex, &mut rep("e"), &flag()).unwrap();
        assert_eq!(stats.entries_done, 3, "entries_done 只数文件，目录不计");
        assert_eq!(fs::read(out.join("src/a.txt")).unwrap(), b"hello world");
        assert_eq!(fs::read(out.join("src/sub/deep/c.bin")).unwrap().len(), 5000);
    }

    #[test]
    fn every_writable_method_roundtrips() {
        let tmp = TempDir::new("zip-m");
        let src = tmp.join("src");
        fs::create_dir_all(&src).unwrap();
        // 可压缩内容：全零会让每种方法都退化成 Store，测不出真东西
        let payload: Vec<u8> = (0..40_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(src.join("data.bin"), &payload).unwrap();

        for (i, method) in ["", "store", "deflate", "bzip2", "zstd", "xz"]
            .into_iter()
            .enumerate()
        {
            let dest = tmp.join(format!("m{}.zip", i));
            let opts = CreateOptions {
                method: if method.is_empty() {
                    None
                } else {
                    Some(method.to_string())
                },
                level: Some(6),
                ..Default::default()
            };
            create(&[src.clone()], &dest, &opts, &mut rep("c"), &flag())
                .unwrap_or_else(|e| panic!("方法 {:?} 压缩失败: {}", method, e));
            let out = tmp.join(format!("o{}", i));
            let ex = ExtractOptions {
                overwrite: guard::Overwrite::Overwrite,
                ..Default::default()
            };
            extract(&dest, &out, &ex, &mut rep("e"), &flag())
                .unwrap_or_else(|e| panic!("方法 {:?} 解压失败: {}", method, e));
            assert_eq!(
                fs::read(out.join("src/data.bin")).unwrap(),
                payload,
                "方法 {:?} 内容不一致",
                method
            );
            let st = test(&dest, &ExtractOptions::default(), &mut rep("t"), &flag()).unwrap();
            assert!(
                st.errors.is_empty(),
                "方法 {:?} 校验有错: {:?}",
                method,
                st.errors
            );
        }
    }

    #[test]
    fn lzma_write_is_rejected_not_silently_downgraded() {
        let tmp = TempDir::new("zip-lzma");
        let src = tmp.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("x.txt"), b"x").unwrap();
        let dest = tmp.join("l.zip");
        let opts = CreateOptions {
            method: Some("lzma".into()),
            ..Default::default()
        };
        let err = create(&[src], &dest, &opts, &mut rep("c"), &flag()).unwrap_err();
        assert!(err.contains("LZMA"), "应该点名 LZMA: {}", err);
        assert!(err.contains("7z"), "应该给出可行的替代方案: {}", err);
    }

    #[test]
    fn encrypted_zip_needs_password_and_rejects_wrong_one() {
        let tmp = TempDir::new("zip-pw");
        let src = tmp.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("secret.txt"), b"top secret").unwrap();
        let dest = tmp.join("pw.zip");
        let opts = CreateOptions {
            password: Some("hunter2".to_string()),
            ..Default::default()
        };
        create(&[src.clone()], &dest, &opts, &mut rep("c"), &flag()).unwrap();

        let entries = list(&dest).unwrap();
        assert!(
            entries.iter().any(|e| e.encrypted),
            "列表要能看出条目加密了（前端据此弹密码框）"
        );

        let out = tmp.join("nopw");
        let err = extract(&dest, &out, &ExtractOptions::default(), &mut rep("e"), &flag()).unwrap_err();
        assert!(err.contains("密码"), "错误信息应该说密码: {}", err);

        let out = tmp.join("ok");
        let ex = ExtractOptions {
            password: Some("hunter2".to_string()),
            overwrite: guard::Overwrite::Overwrite,
            ..Default::default()
        };
        extract(&dest, &out, &ex, &mut rep("e"), &flag()).unwrap();
        assert_eq!(fs::read(out.join("src/secret.txt")).unwrap(), b"top secret");

        let out = tmp.join("bad");
        let ex = ExtractOptions {
            password: Some("wrong-password".to_string()),
            overwrite: guard::Overwrite::Overwrite,
            ..Default::default()
        };
        let err = extract(&dest, &out, &ex, &mut rep("e"), &flag()).unwrap_err();
        assert!(err.contains("密码"), "错密码要说人话: {}", err);
        assert!(
            !out.join("src/secret.txt").exists(),
            "解密失败不能留下截断的文件"
        );
    }

    #[test]
    fn append_keeps_old_entries_without_password() {
        let tmp = TempDir::new("zip-add");
        let s1 = tmp.join("s1");
        fs::create_dir_all(&s1).unwrap();
        fs::write(s1.join("old.txt"), b"old content").unwrap();
        let dest = tmp.join("pack.zip");
        let opts = CreateOptions {
            password: Some("pw".to_string()),
            ..Default::default()
        };
        create(&[s1.clone()], &dest, &opts, &mut rep("c"), &flag()).unwrap();

        let s2 = tmp.join("s2");
        fs::create_dir_all(&s2).unwrap();
        fs::write(s2.join("new.txt"), b"new content").unwrap();
        // 追加时不提供密码也要成功：原条目是密文搬运，新条目不加密
        add(&dest, &[s2], &CreateOptions::default(), &mut rep("a"), &flag()).unwrap();

        let entries = list(&dest).unwrap();
        assert!(
            entries.iter().any(|e| e.path == "s1/old.txt" && e.encrypted),
            "原条目应仍然是加密的: {:?}",
            entries.iter().map(|e| (&e.path, e.encrypted)).collect::<Vec<_>>()
        );
        assert!(entries.iter().any(|e| e.path == "s2/new.txt" && !e.encrypted));

        let out = tmp.join("out");
        let ex = ExtractOptions {
            password: Some("pw".to_string()),
            overwrite: guard::Overwrite::Overwrite,
            ..Default::default()
        };
        extract(&dest, &out, &ex, &mut rep("e"), &flag()).unwrap();
        assert_eq!(fs::read(out.join("s1/old.txt")).unwrap(), b"old content");
        assert_eq!(fs::read(out.join("s2/new.txt")).unwrap(), b"new content");
    }

    /// `extract_zip_file` 那个漏洞的回归测试：条目名里带 `../` 不能写到 dest 外面。
    #[test]
    fn malicious_entry_names_cannot_escape() {
        let tmp = TempDir::new("zip-slip");
        let dest_dir = tmp.join("out");
        fs::create_dir_all(&dest_dir).unwrap();
        let zip = tmp.join("evil.zip");
        {
            let f = File::create(&zip).unwrap();
            let mut w = ZipWriter::new(f);
            w.start_file("../escaped.txt", plain_opts())
                .unwrap();
            w.write_all(b"pwned").unwrap();
            w.start_file("sub/../../escaped2.txt", plain_opts())
                .unwrap();
            w.write_all(b"pwned2").unwrap();
            w.start_file("C:\\Windows\\evil3.txt", plain_opts())
                .unwrap();
            w.write_all(b"pwned3").unwrap();
            w.finish().unwrap();
        }
        let ex = ExtractOptions {
            overwrite: guard::Overwrite::Overwrite,
            ..Default::default()
        };
        // 不该 panic，也不该把文件写到 dest 外面
        let _ = extract(&zip, &dest_dir, &ex, &mut rep("e"), &flag());
        assert!(!tmp.join("escaped.txt").exists(), "zip-slip 逃逸 = 漏洞");
        assert!(!tmp.join("escaped2.txt").exists(), "zip-slip 逃逸 = 漏洞");
        assert!(!Path::new("C:\\Windows\\evil3.txt").exists(), "盘符绝对路径逃逸 = 漏洞");
    }

    #[test]
    fn dir_sizes_roll_up() {
        let tmp = TempDir::new("zip-roll");
        let src = tmp.join("src");
        write_tree(&src);
        let dest = tmp.join("r.zip");
        create(&[src], &dest, &base_create_opts(), &mut rep("c"), &flag()).unwrap();
        let mut entries = list(&dest).unwrap();
        // 子树汇总已经上移到 mod.rs（六个后端共用一份）；这里照样跑一遍，
        // 验证的是 ZIP 的目录条目喂给那份共享实现能不能算对
        crate::archive::rollup_dir_sizes(&mut entries);
        let deep = entries
            .iter()
            .find(|e| e.is_dir && e.path == "src/sub/deep")
            .expect("应该有 src/sub/deep 目录条目");
        assert_eq!(deep.size, 5000, "目录 size 应是子树合计");
        let sub = entries
            .iter()
            .find(|e| e.is_dir && e.path == "src/sub")
            .unwrap();
        assert_eq!(sub.size, 5000 + "second file content".len() as u64);
    }

    #[test]
    fn cancel_stops_extract() {
        let tmp = TempDir::new("zip-cancel");
        let src = tmp.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("big.bin"), vec![3u8; 400_000]).unwrap();
        let dest = tmp.join("c.zip");
        create(&[src], &dest, &base_create_opts(), &mut rep("c"), &flag()).unwrap();

        let stopped = AtomicBool::new(true);
        let out = tmp.join("out");
        let ex = ExtractOptions {
            overwrite: guard::Overwrite::Overwrite,
            ..Default::default()
        };
        let err = extract(&dest, &out, &ex, &mut rep("e"), &stopped).unwrap_err();
        assert!(err.contains("已取消"), "应该说已取消: {}", err);
    }

    #[test]
    fn dos_time_survives_roundtrip() {
        let tmp = TempDir::new("zip-time");
        let src = tmp.join("src");
        fs::create_dir_all(&src).unwrap();
        let f = src.join("t.txt");
        fs::write(&f, b"x").unwrap();
        let when = chrono::Local
            .from_local_datetime(&chrono::NaiveDateTime::new(
                chrono::NaiveDate::from_ymd_opt(2024, 3, 5).unwrap(),
                chrono::NaiveTime::from_hms_opt(14, 30, 0).unwrap(),
            ))
            .single()
            .unwrap();
        filetime::set_file_mtime(&f, filetime::FileTime::from_unix_time(when.timestamp(), 0))
            .unwrap();

        let dest = tmp.join("t.zip");
        create(&[src], &dest, &base_create_opts(), &mut rep("c"), &flag()).unwrap();
        let entries = list(&dest).unwrap();
        let e = entries.iter().find(|e| e.path == "src/t.txt").unwrap();
        // DOS 时间精度是 2 秒；关键是不能差一个时区（8 小时）
        assert!(
            (e.modified - when.timestamp()).abs() <= 2,
            "时间戳 {} 与 {} 差太多——多半是按 UTC 解释了 MS-DOS 本地时间",
            e.modified,
            when.timestamp()
        );
    }

    #[test]
    fn corrupt_archive_reports_clearly() {
        let tmp = TempDir::new("zip-bad");
        let bad = tmp.join("bad.zip");
        // PK\x03\x04 开头（魔数认得出是 zip）但后面是垃圾
        let mut bytes = vec![0x50, 0x4b, 0x03, 0x04];
        bytes.extend_from_slice(&[0xAB; 200]);
        fs::write(&bad, &bytes).unwrap();
        let err = list(&bad).unwrap_err();
        assert!(err.contains("ZIP"), "应该说这是 ZIP 的问题: {}", err);
    }

    #[test]
    fn file_opts_only_encrypts_when_a_password_is_given() {
        // AES-256 的开关只能靠 has_encryption() 从外面看到（字段是 pub(crate)）。
        // 这里防的是重构时把 pw 传丢了：包照样能压出来，但一个字节都没加密。
        assert!(!file_opts(None, CompressionMethod::Deflated, Some(6)).has_encryption());
        assert!(
            file_opts(Some("pw"), CompressionMethod::Deflated, Some(6)).has_encryption(),
            "给了密码就必须真的加密"
        );
    }

    /// 追加同名条目时新的替掉旧的。ZIP 格式允许重名条目，但那样解出来是随机的
    /// （取决于解压工具遇到哪个），用户看到的是"我明明加进去了，内容还是旧的"。
    #[test]
    fn append_replaces_same_named_entry() {
        let tmp = TempDir::new("zip-dup");
        let src = tmp.join("s");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("f.txt"), b"version 1").unwrap();
        let dest = tmp.join("d.zip");
        create(&[src.clone()], &dest, &base_create_opts(), &mut rep("c"), &flag()).unwrap();

        fs::write(src.join("f.txt"), b"version 2 is longer").unwrap();
        add(&dest, &[src], &CreateOptions::default(), &mut rep("a"), &flag()).unwrap();

        let entries = list(&dest).unwrap();
        let same: Vec<&Entry> = entries.iter().filter(|e| e.path == "s/f.txt").collect();
        assert_eq!(same.len(), 1, "不该留下两个同名条目: {:?}", entries.iter().map(|e| &e.path).collect::<Vec<_>>());
        let out = tmp.join("out");
        let ex = ExtractOptions {
            overwrite: guard::Overwrite::Overwrite,
            ..Default::default()
        };
        extract(&dest, &out, &ex, &mut rep("e"), &flag()).unwrap();
        assert_eq!(
            fs::read(out.join("s/f.txt")).unwrap(),
            b"version 2 is longer",
            "追加的同名文件应该替换掉旧的"
        );
    }
}
