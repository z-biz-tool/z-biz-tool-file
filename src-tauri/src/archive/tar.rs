//! tar 家族：`.tar` 及外层套流式压缩的 `.tar.gz/.tgz/.tar.bz2/.tar.xz/.tar.zst/.tar.lz4/.tar.br`。
//!
//! 外层压缩算法集中在 `Decoder` / `Encoder` 两个枚举里，加一种新算法只改这两处，
//! list / extract / create 三条路径自动都拿到支持。原来 commands.rs 里
//! `extract_tar_impl` 用 `DecompressAlgo` 枚举、`compress_to_tar_blocking` 又用字符串
//! match，两边各写一份，加格式时漏掉一边就会变成"能压不能解"。

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use super::format::Format;
use super::guard;
use super::io::{CountingReader, CountingWriter};
use super::job::Reporter;
use super::select::{map_output, normalize, single_root, Selector};
use super::types::{CreateOptions, Entry, ExtractOptions, Stats};

/// tar 外层用的压缩算法
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    None,
    Gz,
    Bz2,
    Xz,
    Zst,
    Lz4,
    Br,
}

pub fn codec_of(fmt: Format) -> Option<Codec> {
    Some(match fmt {
        Format::Tar => Codec::None,
        Format::TarGz => Codec::Gz,
        Format::TarBz2 => Codec::Bz2,
        Format::TarXz => Codec::Xz,
        Format::TarZst => Codec::Zst,
        Format::TarLz4 => Codec::Lz4,
        Format::TarBr => Codec::Br,
        _ => return None,
    })
}

pub fn clamp(v: i32, lo: i32, hi: i32) -> i32 {
    v.clamp(lo, hi)
}

pub fn default_level(codec: Codec) -> i32 {
    match codec {
        Codec::None | Codec::Lz4 => 0,
        Codec::Gz | Codec::Xz => 6,
        Codec::Bz2 => 9,
        Codec::Zst => 3,
        Codec::Br => 6,
    }
}

// ============================================================================
// 解码 / 编码包装
// ============================================================================

/// 读侧：具体类型被擦掉，因为 tar::Archive 只要求 Read。
/// 用 Multi* 变体：`cat a.gz b.gz` 这种拼接包在野很常见，单帧解码器会在第一个
/// 帧结束时就停，用户看到的是"解压出来一半"。
pub fn wrap_decoder<R: Read + 'static>(r: R, codec: Codec) -> io::Result<Box<dyn Read>> {
    Ok(match codec {
        Codec::None => Box::new(r),
        Codec::Gz => Box::new(flate2::read::MultiGzDecoder::new(r)),
        Codec::Bz2 => Box::new(bzip2::read::MultiBzDecoder::new(r)),
        Codec::Xz => Box::new(xz2::read::XzDecoder::new_multi_decoder(r)),
        Codec::Zst => Box::new(zstd::stream::read::Decoder::new(r)?),
        Codec::Lz4 => Box::new(lz4_flex::frame::FrameDecoder::new(r)),
        Codec::Br => Box::new(brotli::Decompressor::new(r, 64 * 1024)),
    })
}

type Sink = CountingWriter<BufWriter<File>>;

/// 写侧**不能**擦成 `Box<dyn Write>`：每种压缩器的"收尾"动作都不一样
/// （zstd 要写 frame 尾、lz4 要写 end mark、brotli 要发 FINISH op），
/// 藏在具体类型上。box 掉之后只能 flush，产出的包是截断的——这种坏包
/// 本机 7-Zip 打开会直接报 CRC 错，比压不出来更糟。
pub enum Encoder {
    None(Sink),
    Gz(flate2::write::GzEncoder<Sink>),
    Bz2(bzip2::write::BzEncoder<Sink>),
    Xz(xz2::write::XzEncoder<Sink>),
    Zst(zstd::stream::write::Encoder<'static, Sink>),
    Lz4(lz4_flex::frame::FrameEncoder<Sink>),
    Br(brotli::CompressorWriter<Sink>),
}

impl Encoder {
    pub fn new(sink: Sink, codec: Codec, level: i32) -> io::Result<Encoder> {
        Ok(match codec {
            Codec::None => Encoder::None(sink),
            Codec::Gz => Encoder::Gz(flate2::write::GzEncoder::new(
                sink,
                flate2::Compression::new(clamp(level, 0, 9) as u32),
            )),
            Codec::Bz2 => Encoder::Bz2(bzip2::write::BzEncoder::new(
                sink,
                bzip2::Compression::new(clamp(level, 1, 9) as u32),
            )),
            Codec::Xz => {
                Encoder::Xz(xz2::write::XzEncoder::new(sink, clamp(level, 0, 9) as u32))
            }
            Codec::Zst => Encoder::Zst(zstd::stream::write::Encoder::new(sink, clamp(level, -7, 22))?),
            Codec::Lz4 => Encoder::Lz4(lz4_flex::frame::FrameEncoder::new(sink)),
            Codec::Br => {
                // brotli quality 0..=11，lgwin 22（4MB 窗口）是它的最大值
                Encoder::Br(brotli::CompressorWriter::new(sink, 64 * 1024, clamp(level, 0, 11) as u32, 22))
            }
        })
    }

    /// 收尾并拿回底层 writer
    pub fn finish(self) -> io::Result<Sink> {
        Ok(match self {
            Encoder::None(w) => w,
            Encoder::Gz(w) => w.finish()?,
            Encoder::Bz2(w) => w.finish()?,
            Encoder::Xz(w) => w.finish()?,
            Encoder::Zst(w) => w.finish()?,
            Encoder::Lz4(w) => w
                .finish()
                .map_err(|e| io::Error::other(format!("lz4 收尾失败: {}", e)))?,
            // brotli 的 into_inner 内部会发 BROTLI_OPERATION_FINISH
            Encoder::Br(w) => w.into_inner(),
        })
    }
}

impl Write for Encoder {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Encoder::None(w) => w.write(buf),
            Encoder::Gz(w) => w.write(buf),
            Encoder::Bz2(w) => w.write(buf),
            Encoder::Xz(w) => w.write(buf),
            Encoder::Zst(w) => w.write(buf),
            Encoder::Lz4(w) => w.write(buf),
            Encoder::Br(w) => w.write(buf).map_err(io::Error::other),
        }
    }

    /// 压缩流的 flush 一律空转，只有裸 tar（`None`）才真的往下刷。
    ///
    /// 对压缩器来说 flush 的语义是 sync-flush（强行切出一个可解块的边界），
    /// 而 xz2 的 easy encoder 压根不支持：`XzEncoder::flush` 内部直接 `unwrap()`，
    /// 一调就 panic，`.xz` / `.tar.xz` 全都产不出来。tar crate 的
    /// `Builder::finish()` 自己会调一次 flush，所以这条路径躲不开，只能在这里挡住。
    ///
    /// 空转是安全的：所有压缩器都把数据留到 `finish()` 一次性吐出，
    /// 而 `Encoder::finish()` 是压缩流程里必走的最后一步。
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Encoder::None(w) => w.flush(),
            Encoder::Gz(_)
            | Encoder::Bz2(_)
            | Encoder::Xz(_)
            | Encoder::Zst(_)
            | Encoder::Lz4(_)
            | Encoder::Br(_) => Ok(()),
        }
    }
}

// ============================================================================
// 列举
// ============================================================================

/// 打开 tar 系列文件。计数器贴着磁盘文件，所以进度按"读走了压缩包的多少字节"算，
/// 压缩流内部明文总量未知也能给出准确百分比。
fn open_plain(path: &Path, codec: Codec) -> io::Result<(Box<dyn Read>, Arc<AtomicU64>)> {
    let f = File::open(path)?;
    let (counting, counter) = CountingReader::new(BufReader::with_capacity(256 * 1024, f));
    let plain = wrap_decoder(counting, codec)?;
    Ok((plain, counter))
}

fn entry_of(idx: &mut u32, header: &tar::Header, raw_path: &str) -> Entry {
    let i = *idx;
    *idx += 1;
    let et = header.entry_type();
    let n = normalize(raw_path);
    let name = n.rsplit('/').next().unwrap_or("").to_string();
    Entry {
        index: i,
        path: n.clone(),
        name: if name.is_empty() { n } else { name },
        is_dir: et.is_dir() || raw_path.ends_with('/'),
        size: header.entry_size().unwrap_or(0),
        // tar 每个条目独立成块，压缩后大小只在整包层面有意义
        packed: 0,
        modified: header.mtime().unwrap_or(0) as i64,
        method: codec_label(et),
        encrypted: false,
        crc: header.cksum().unwrap_or(0),
        comment: String::new(),
        symlink_target: header
            .link_name()
            .ok()
            .flatten()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

fn codec_label(et: tar::EntryType) -> String {
    if et.is_dir() {
        "dir".into()
    } else if et.is_symlink() {
        "symlink".into()
    } else {
        "tar".into()
    }
}

pub fn list(path: &Path, fmt: Format) -> Result<Vec<Entry>, String> {
    let codec = codec_of(fmt).ok_or_else(|| format!("不是 tar 系列格式: {}", fmt.id()))?;
    let (plain, _counter) = open_plain(path, codec).map_err(|e| format!("打开失败: {}", e))?;
    let mut ar = tar::Archive::new(plain);
    let mut out = Vec::new();
    let mut idx = 0u32;
    for item in ar.entries().map_err(|e| format!("读取 tar 目录失败: {}", e))? {
        let e = item.map_err(|e| format!("解析 tar 条目失败: {}", e))?;
        let raw = e
            .path()
            .map_err(|e| format!("条目路径无效: {}", e))?
            .to_string_lossy()
            .to_string();
        let header = e.header().clone();
        out.push(entry_of(&mut idx, &header, &raw));
        if out.len() >= super::MAX_ENTRIES {
            break;
        }
    }
    Ok(out)
}

// ============================================================================
// 解压
// ============================================================================

pub fn extract(
    path: &Path,
    fmt: Format,
    dest: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let codec = codec_of(fmt).ok_or_else(|| format!("不是 tar 系列格式: {}", fmt.id()))?;
    let total_bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    // strip_root 要先扫一遍才知道顶层目录是谁，而 tar 是单向流、seek 不回去。
    // 需要剥壳时就老老实实读两遍：多解一遍压缩流，比让用户在结果外面多套一层目录划算。
    let strip_root = if opts.strip_root {
        let (plain, _) = open_plain(path, codec).map_err(|e| format!("打开失败: {}", e))?;
        let mut ar = tar::Archive::new(plain);
        let paths: Vec<String> = ar
            .entries()
            .map_err(|e| format!("读取失败: {}", e))?
            .filter_map(|e| {
                e.ok().and_then(|e| e.path().ok().map(|p| p.to_string_lossy().to_string()))
            })
            .take(super::MAX_ENTRIES)
            .collect();
        single_root(paths.iter().map(|s| s.as_str()))
    } else {
        None
    };

    let (plain, counter) = open_plain(path, codec).map_err(|e| format!("打开失败: {}", e))?;
    reporter.set_totals(0, total_bytes);
    reporter.set_phase("working");

    let sel = Selector::new(opts.entries.clone(), opts.include_children);
    let mut ar = tar::Archive::new(plain);
    let mut stats = Stats::default();
    let mut idx = 0u32;

    for item in ar.entries().map_err(|e| format!("读取 tar 目录失败: {}", e))? {
        if cancel.load(Ordering::Relaxed) {
            return Err(super::job::Cancelled.to_string());
        }
        let mut e = item.map_err(|e| format!("解析 tar 条目失败: {}", e))?;
        let header = e.header().clone();
        let raw = e
            .path()
            .map_err(|e| format!("条目路径无效: {}", e))?
            .to_string_lossy()
            .to_string();
        let _ = entry_of(&mut idx, &header, &raw);

        let mapped = map_output(&raw, strip_root.as_deref(), opts.flatten);
        if mapped.is_empty() || !sel.matches(&mapped) {
            // 不解的条目也必须把数据流读干净，否则 tar 的块偏移会错位，
            // 后面所有条目全部解析失败
            io::copy(&mut e, &mut io::sink()).map_err(|e| format!("跳过条目失败: {}", e))?;
            continue;
        }

        let et = header.entry_type();
        if et.is_dir() || raw.ends_with('/') {
            // 目录条目在很多 tar 里根本不存在（靠路径隐含），所以文件分支也自己 create_dir_all
            let target = guard::safe_join(dest, &mapped).map_err(|e| e.to_string())?;
            fs::create_dir_all(&target).map_err(|e| format!("创建目录失败 {}: {}", mapped, e))?;
            stats.entries_done += 1;
            continue;
        }
        if et.is_symlink() || et.is_hard_link() {
            // 见 guard.rs 顶部第 3 条：符号链接一律落成"内容是目标路径"的普通文件
            let link = header
                .link_name()
                .ok()
                .flatten()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            match guard::resolve_target(dest, &mapped, opts.overwrite).map_err(|e| e.to_string())? {
                Some(target) => {
                    if let Some(p) = target.parent() {
                        fs::create_dir_all(p).map_err(|e| format!("创建父目录失败: {}", e))?;
                    }
                    fs::write(&target, link.as_bytes())
                        .map_err(|e| format!("写入失败 {}: {}", mapped, e))?;
                    stats.entries_done += 1;
                }
                None => stats.skipped += 1,
            }
            io::copy(&mut e, &mut io::sink()).map_err(|e| format!("跳过条目失败: {}", e))?;
            continue;
        }
        if !(et.is_file() || et.is_contiguous()) {
            // 设备文件 / FIFO 在 Windows 上没有对应物：记账跳过，不静默丢。
            // `Continuous`（type '7'）也算普通文件——GNU tar 就是这么读的，
            // 只认 `is_file()` 会把老式 contiguous 条目当成设备文件跳过。
            stats.skipped += 1;
            io::copy(&mut e, &mut io::sink()).map_err(|e| format!("跳过条目失败: {}", e))?;
            continue;
        }

        let target = match guard::resolve_target(dest, &mapped, opts.overwrite).map_err(|e| e.to_string())? {
            Some(t) => t,
            None => {
                stats.skipped += 1;
                io::copy(&mut e, &mut io::sink()).map_err(|e| format!("跳过条目失败: {}", e))?;
                continue;
            }
        };
        if let Some(p) = target.parent() {
            fs::create_dir_all(p).map_err(|e| format!("创建父目录失败: {}", e))?;
        }
        reporter.set_entry(&mapped);
        let mut out = File::create(&target).map_err(|e| format!("创建文件失败 {}: {}", mapped, e))?;
        let written = match super::io::copy_with_cancel(&mut e, &mut out, cancel, |_| {}) {
            Ok(n) => n,
            Err(err) => {
                drop(out);
                if cancel.load(Ordering::Relaxed) {
                    return Err(super::job::Cancelled.to_string());
                }
                if opts.keep_broken {
                    stats.errors.push(format!("{}: {}", mapped, err));
                    reporter.set_bytes(counter.load(Ordering::Relaxed));
                    continue;
                }
                return Err(format!("解压 {} 失败: {}", mapped, err));
            }
        };
        drop(out);
        if let Ok(mode) = header.mode() {
            let _ = guard::apply_mode(&target, mode);
        }
        if let Ok(mt) = header.mtime() {
            super::io::set_mtime(&target, mt);
        }
        stats.entries_done += 1;
        stats.bytes_done += written;
        reporter.set_bytes(counter.load(Ordering::Relaxed));
    }
    Ok(stats)
}

// ============================================================================
// 校验
// ============================================================================

/// 测试 tar：把整条流解到底，一个字节也不落盘。
///
/// 这件事对 tar 家族**不是多余的**，两层校验都靠它：
/// - 外层压缩流自带校验（gzip 的 CRC32、xz 的 CRC64、zstd 的 frame checksum、
///   bzip2 的块 CRC），解到末尾才会比对——没下载完的 `.tar.gz` 就是在这里现形的；
/// - 每个 tar 头有自己的 checksum，`tar` crate 解析时就会验。
///
/// 进度按"从压缩包读走了多少字节"算（`counter` 贴在磁盘文件外面，见 `open_plain`）：
/// 明文总量事先不知道，而压缩包大小是已知的，这样百分比才是准的。
pub fn test(
    path: &Path,
    fmt: Format,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let codec = codec_of(fmt).ok_or_else(|| format!("不是 tar 系列格式: {}", fmt.id()))?;
    let total_bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let (plain, counter) = open_plain(path, codec).map_err(|e| format!("打开失败: {}", e))?;
    reporter.set_totals(0, total_bytes);
    reporter.set_phase("working");

    let mut ar = tar::Archive::new(plain);
    let mut stats = Stats::default();
    for item in ar.entries().map_err(|e| format!("读取 tar 目录失败: {}", e))? {
        if cancel.load(Ordering::Relaxed) {
            return Err(super::job::Cancelled.to_string());
        }
        let mut e = item.map_err(|e| format!("解析 tar 条目失败: {}", e))?;
        let name = e
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        reporter.set_entry(&name);
        // 必须读干净：tar 的块偏移靠"前一个条目被完整消费"维持，跳读会让后面全部错位，
        // 报出来的损坏位置是假的
        match super::io::copy_with_cancel(&mut e, &mut io::sink(), cancel, |_| {}) {
            Ok(n) => {
                stats.bytes_done += n;
                stats.entries_done += 1;
            }
            Err(err) => {
                if cancel.load(Ordering::Relaxed) {
                    return Err(super::job::Cancelled.to_string());
                }
                stats.errors.push(format!("{}: {}", name, err));
                stats.entries_done += 1;
            }
        }
        reporter.set_bytes(counter.load(Ordering::Relaxed));
    }
    Ok(stats)
}

// ============================================================================
// 创建
// ============================================================================

/// 把 sources 打成 tar（可带外层压缩）。
///
/// 路径基准默认按"每个源的父目录"算（`D:\a\b\c.txt` → `c.txt`，目录 `D:\a\b\dir` →
/// `dir/...`），和 7-Zip 右键"添加到压缩包"一致；`store_full_path` 为真时才存完整路径。
pub fn create(
    sources: &[PathBuf],
    dest: &Path,
    fmt: Format,
    opts: &CreateOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let codec = codec_of(fmt).ok_or_else(|| format!("不是 tar 系列格式: {}", fmt.id()))?;
    let level = opts.level.unwrap_or_else(|| default_level(codec));

    if let Some(p) = dest.parent() {
        fs::create_dir_all(p).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }
    let file = File::create(dest).map_err(|e| format!("创建目标文件失败: {}", e))?;
    let (sink, written) = CountingWriter::new(BufWriter::with_capacity(256 * 1024, file));
    let encoder = Encoder::new(sink, codec, level).map_err(|e| format!("初始化压缩器失败: {}", e))?;
    let mut builder = tar::Builder::new(encoder);
    // Deterministic：不写 uid/gid/uname，跨机器解出来的权限才可预测
    builder.mode(tar::HeaderMode::Deterministic);
    builder.follow_symlinks(false);

    let (total_files, total_bytes) = scan_sources(sources)?;
    reporter.set_totals(total_files, total_bytes);
    reporter.set_phase("working");

    let mut stats = Stats::default();
    for src in sources {
        // base 必须是 src 的**父目录**并在递归中原样往下传：
        // 传 src 自己会让顶层叫 `dir`、子项叫 `sub/x.txt`，解出来是一堆散落的目录。
        add_path(
            &mut builder,
            src,
            src.parent().unwrap_or(src),
            opts,
            reporter,
            cancel,
            &mut stats,
        )?;
    }

    let encoder = builder
        .into_inner()
        .map_err(|e| format!("写入 tar 失败: {}", e))?;
    let sink = encoder.finish().map_err(|e| format!("收尾压缩流失败: {}", e))?;
    let mut buf = sink.into_inner();
    buf.flush().map_err(|e| format!("刷盘失败: {}", e))?;
    stats.bytes_done = written.load(Ordering::Relaxed);
    Ok(stats)
}

// ============================================================================
// 追加
// ============================================================================

/// 往已有的**纯 tar** 里加东西。
///
/// 只有 `.tar` 能原地追加：外层套了流式压缩的 `.tar.gz` 之类，追加等于解一遍再压一遍，
/// 那是 `create` 的活，`caps.add` 对它们如实标 false，前端不会渲染这一项。
///
/// 追加是**原地改写现有文件**，所以落笔之前必须先算准"已有内容到哪一字节为止"，
/// 算短一个字节就会覆盖掉最后一个条目。见 `data_end` 的说明——那里解释了为什么
/// 不能用最常见的"从文件尾往回扫第一个非零块"做法。
pub fn add(
    archive: &Path,
    sources: &[PathBuf],
    opts: &CreateOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let det = super::format::detect(archive);
    if det.format != Format::Tar {
        return Err(format!(
            "只有纯 .tar 能原地追加，{} 的外层是流式压缩，追加得整体重写。请用「新建压缩」重新打包。",
            det.format.label()
        ));
    }

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(archive)
        .map_err(|e| format!("打开 {} 失败: {}", archive.display(), e))?;
    let (mut file, end) = data_end(file)?;
    // 截掉尾部那两个全零的结束块（以及 GNU tar 按 blocking factor 补的尾随零），
    // Builder 收尾时会重新写一份结束块
    file.set_len(end)
        .map_err(|e| format!("回退到追加位置失败: {}", e))?;
    file.seek(SeekFrom::Start(end))
        .map_err(|e| format!("定位到追加位置失败: {}", e))?;

    let (sink, written) = CountingWriter::new(BufWriter::with_capacity(256 * 1024, file));
    let mut builder = tar::Builder::new(sink);
    builder.mode(tar::HeaderMode::Deterministic);
    builder.follow_symlinks(false);

    let (total_files, total_bytes) = scan_sources(sources)?;
    reporter.set_totals(total_files, total_bytes);
    reporter.set_phase("working");

    let mut stats = Stats::default();
    for src in sources {
        // base 用父目录，理由和 create 里那句注释一样
        add_path(
            &mut builder,
            src,
            src.parent().unwrap_or(src),
            opts,
            reporter,
            cancel,
            &mut stats,
        )?;
    }

    let sink = builder
        .into_inner()
        .map_err(|e| format!("写入 tar 失败: {}", e))?;
    let mut buf = sink.into_inner();
    buf.flush().map_err(|e| format!("刷盘失败: {}", e))?;
    stats.bytes_done = written.load(Ordering::Relaxed);
    Ok(stats)
}

/// 算出"已有内容到哪一字节为止"，并把 File 还给调用方。
///
/// **不能从文件尾往回扫第一个非零块**——那是 GNU tar `--append` 的老做法，但它有个
/// 会静默毁数据的洞：最后一个条目的内容恰好全是 0 时（比如一个 1000 字节的全零文件），
/// 往回扫会停在它的**头部**，于是追加从头部之后开始写，那段数据被覆盖掉，
/// 而归档看起来完全正常。这里改用 tar crate 解析出的 `raw_file_position + size`，
/// 顺便也把"这文件到底是不是合法 tar"验了一遍（追加是原地改写，验不过就别动手）。
fn data_end(file: File) -> Result<(File, u64), String> {
    let mut ar = tar::Archive::new(file);
    let mut end = 0u64;
    for item in ar.entries().map_err(|e| format!("读取 tar 目录失败: {}", e))? {
        let e = item.map_err(|e| format!("解析 tar 条目失败: {}", e))?;
        if e.header().entry_type().is_gnu_sparse() {
            // 稀疏条目的数据段里夹着 sparse map，`raw_file_position + size` 不是真实末尾，
            // 按它截断就会切掉内容。这种包只能整体重打。
            return Err(
                "这个 tar 含 GNU 稀疏条目，追加算不准数据末尾、可能截断内容。请用「新建压缩」重新打包。"
                    .to_string(),
            );
        }
        // 数据段按 512 字节对齐；目录/符号链接 size 为 0，算出来就是头部之后那一格
        let tail = e.raw_file_position().saturating_add(e.size());
        end = end.max(tail.div_ceil(512) * 512);
    }
    Ok((ar.into_inner(), end))
}

pub fn scan_sources(sources: &[PathBuf]) -> Result<(u64, u64), String> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    for s in sources {
        let meta = fs::metadata(s)
            .map_err(|e| format!("读取 {} 失败: {}", s.display(), e))?;
        if meta.is_dir() {
            for w in walkdir::WalkDir::new(s).follow_links(false) {
                let w = w.map_err(|e| format!("遍历目录失败: {}", e))?;
                if w.file_type().is_file() {
                    files += 1;
                    bytes += w.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        } else {
            files += 1;
            bytes += meta.len();
        }
    }
    Ok((files, bytes))
}

pub fn archive_name_for(src: &Path, base: &Path, store_full_path: bool) -> Result<String, String> {
    if store_full_path {
        return Ok(src
            .to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string());
    }
    let rel = if src == base {
        src.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| format!("无法取得文件名: {}", src.display()))?
    } else {
        match src.strip_prefix(base) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => src
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
        }
    };
    Ok(rel.trim_matches('/').to_string())
}

pub fn excluded(path: &Path, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let s = path.to_string_lossy().replace('\\', "/");
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    patterns.iter().any(|p| {
        let p = p.trim();
        if p.is_empty() {
            return false;
        }
        if p.contains('*') || p.contains('?') {
            let re = glob_to_regex(p);
            re.is_match(&s) || re.is_match(&name)
        } else {
            s.contains(p) || name == p
        }
    })
}

fn glob_to_regex(glob: &str) -> regex_lite::Regex {
    let mut out = String::from("(?i)^");
    for c in glob.chars() {
        match c {
            '*' => out.push_str(".*"),
            '?' => out.push('.'),
            _ => out.push_str(&regex_lite::escape(&c.to_string())),
        }
    }
    out.push('$');
    regex_lite::Regex::new(&out).unwrap_or_else(|_| regex_lite::Regex::new("$^").unwrap())
}

fn add_path<W: Write>(
    builder: &mut tar::Builder<W>,
    src: &Path,
    base: &Path,
    opts: &CreateOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
    stats: &mut Stats,
) -> Result<(), String> {
    if excluded(src, &opts.exclude_patterns) {
        return Ok(());
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(super::job::Cancelled.to_string());
    }
    let meta = fs::symlink_metadata(src)
        .map_err(|e| format!("读取 {} 失败: {}", src.display(), e))?;
    let name = archive_name_for(src, base, opts.store_full_path)?;
    if name.is_empty() {
        return Ok(());
    }

    if meta.is_dir() {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Directory);
        h.set_path(format!("{}/", name)).map_err(|e| e.to_string())?;
        h.set_size(0);
        h.set_mode(0o755);
        h.set_mtime(super::io::mtime_of(&meta));
        h.set_cksum();
        builder
            .append(&h, io::empty())
            .map_err(|e| format!("写入目录 {} 失败: {}", name, e))?;
        stats.entries_done += 1;
        for child in fs::read_dir(src)
            .map_err(|e| format!("读取目录 {} 失败: {}", src.display(), e))?
        {
            let child = child.map_err(|e| e.to_string())?;
            add_path(builder, &child.path(), base, opts, reporter, cancel, stats)?;
        }
        return Ok(());
    }

    if meta.file_type().is_symlink() {
        // Windows 上创建 symlink 要特权，读不到目标就退化成普通文件
        if let Ok(target) = fs::read_link(src) {
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::Symlink);
            h.set_path(&name).map_err(|e| e.to_string())?;
            h.set_link_name(&target).map_err(|e| e.to_string())?;
            h.set_size(0);
            h.set_mode(0o777);
            h.set_mtime(super::io::mtime_of(&meta));
            h.set_cksum();
            builder
                .append(&h, io::empty())
                .map_err(|e| format!("写入符号链接失败: {}", e))?;
            stats.entries_done += 1;
            return Ok(());
        }
    }

    let f = File::open(src).map_err(|e| format!("打开 {} 失败: {}", src.display(), e))?;
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(tar::EntryType::Regular);
    h.set_path(&name).map_err(|e| e.to_string())?;
    h.set_size(meta.len());
    h.set_mode(super::io::unix_mode_of(&meta));
    h.set_mtime(super::io::mtime_of(&meta));
    h.set_cksum();

    reporter.set_entry(&name);
    let tracked = super::io::TrackingReader::new(
        BufReader::with_capacity(256 * 1024, f),
        cancel,
        |n| reporter.advance_bytes(n),
    );
    builder
        .append_data(&mut h, &name, tracked)
        .map_err(|e| format!("写入 {} 失败: {}", name, e))?;
    stats.entries_done += 1;
    stats.bytes_done += meta.len();
    // 字节数已经由 TrackingReader 边读边推进了，这里再传 meta.len() 会算两遍，
    // 进度条会在半路就到 100%
    reporter.entry_done(&name, 0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::job::{new_job_id, Kind};

    fn rep(tag: &str) -> Reporter {
        Reporter::detached(new_job_id(Kind::Create), Kind::Create, tag.into(), tag.into())
    }

    fn write_tree(dir: &Path) {
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), b"hello").unwrap();
        fs::write(dir.join("sub/b.bin"), vec![7u8; 5000]).unwrap();
    }

    #[test]
    fn tar_roundtrip_every_codec() {
        for fmt in [
            Format::Tar,
            Format::TarGz,
            Format::TarBz2,
            Format::TarXz,
            Format::TarZst,
            Format::TarLz4,
            Format::TarBr,
        ] {
            let tmp = crate::test_bridge::TempDir::new("tar-rt");
            let src = tmp.join("src");
            write_tree(&src);
            let dest = tmp.join(format!("out{}", fmt.extension()));
            let cancel = AtomicBool::new(false);
            let opts = CreateOptions {
                format: fmt.id().into(),
                ..Default::default()
            };
            create(&[src.clone()], &dest, fmt, &opts, &mut rep("create"), &cancel)
                .unwrap_or_else(|e| panic!("{} 压缩失败: {}", fmt.id(), e));
            assert!(dest.exists(), "{} 没产出文件", fmt.id());

            let entries = list(&dest, fmt).unwrap_or_else(|e| panic!("{} 列举失败: {}", fmt.id(), e));
            let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
            for want in ["src", "src/a.txt", "src/sub", "src/sub/b.bin"] {
                assert!(paths.contains(&want), "{} 缺条目 {}: {:?}", fmt.id(), want, paths);
            }

            let out = tmp.join("out");
            fs::create_dir_all(&out).unwrap();
            let stats = extract(
                &dest,
                fmt,
                &out,
                &ExtractOptions::default(),
                &mut rep("extract"),
                &cancel,
            )
            .unwrap_or_else(|e| panic!("{} 解压失败: {}", fmt.id(), e));
            assert!(stats.errors.is_empty(), "{} 有错误: {:?}", fmt.id(), stats.errors);
            assert_eq!(fs::read(out.join("src/a.txt")).unwrap(), b"hello");
            assert_eq!(fs::metadata(out.join("src/sub/b.bin")).unwrap().len(), 5000);
        }
    }

    #[test]
    fn detect_sees_through_renamed_extension() {
        // 魔数优先的价值：`.gz` 里其实装着 tar，按单文件 gunzip 会得到一个假文件
        let tmp = crate::test_bridge::TempDir::new("tar-misname");
        let src = tmp.join("src");
        write_tree(&src);
        let dest = tmp.join("misnamed.gz");
        let cancel = AtomicBool::new(false);
        create(
            &[src],
            &dest,
            Format::TarGz,
            &CreateOptions::default(),
            &mut rep("create"),
            &cancel,
        )
        .unwrap();
        assert_eq!(
            crate::archive::format::detect(&dest).format,
            Format::TarGz,
            "扩展名说 gz，魔数该认出是 tar.gz"
        );
    }

    #[test]
    fn cancel_stops_create() {
        let tmp = crate::test_bridge::TempDir::new("tar-cancel");
        let src = tmp.join("src");
        write_tree(&src);
        let dest = tmp.join("c.tar");
        let cancel = AtomicBool::new(true);
        let r = create(
            &[src],
            &dest,
            Format::Tar,
            &CreateOptions::default(),
            &mut rep("create"),
            &cancel,
        );
        assert!(r.is_err(), "取消位为真时应该中断");
    }

    #[test]
    fn strip_root_removes_single_top_dir() {
        let tmp = crate::test_bridge::TempDir::new("tar-strip");
        let src = tmp.join("root");
        write_tree(&src);
        let dest = tmp.join("s.tar");
        let cancel = AtomicBool::new(false);
        create(&[src], &dest, Format::Tar, &CreateOptions::default(), &mut rep("create"), &cancel)
            .unwrap();
        let out = tmp.join("out");
        fs::create_dir_all(&out).unwrap();
        extract(
            &dest,
            Format::Tar,
            &out,
            &ExtractOptions {
                strip_root: true,
                ..Default::default()
            },
            &mut rep("extract"),
            &cancel,
        )
        .unwrap();
        assert!(out.join("a.txt").exists(), "剥壳后 a.txt 应直接在 out 下");
        assert!(!out.join("root").exists());
    }

    #[test]
    fn selection_extracts_only_subtree() {
        let tmp = crate::test_bridge::TempDir::new("tar-sel");
        let src = tmp.join("root");
        write_tree(&src);
        let dest = tmp.join("s.tar");
        let cancel = AtomicBool::new(false);
        create(&[src], &dest, Format::Tar, &CreateOptions::default(), &mut rep("create"), &cancel)
            .unwrap();
        let out = tmp.join("out");
        fs::create_dir_all(&out).unwrap();
        extract(
            &dest,
            Format::Tar,
            &out,
            &ExtractOptions {
                entries: Some(vec!["root/sub".into()]),
                include_children: true,
                ..Default::default()
            },
            &mut rep("extract"),
            &cancel,
        )
        .unwrap();
        assert!(out.join("root/sub/b.bin").exists());
        assert!(!out.join("root/a.txt").exists(), "没勾的不该出来");
    }

    #[test]
    fn malicious_entry_names_cannot_escape() {
        // 手工造一个带 `../` 的 tar：guard 必须拦住，而不是写到目标目录外面
        let tmp = crate::test_bridge::TempDir::new("tar-slip");
        let evil = tmp.join("evil.tar");
        {
            let f = File::create(&evil).unwrap();
            let mut b = tar::Builder::new(f);
            // `new_gnu()` 的头拿不到 ustar 视图（as_ustar_mut 会返回 None），
            // 而 name 字段正好在 ustar 布局的那 100 字节上
            let mut h = tar::Header::new_ustar();
            h.set_entry_type(tar::EntryType::Regular);
            h.set_size(5);
            h.set_mode(0o644);
            // set_path 会拒绝 `..`，所以直接写原始字节段
            let raw = b"../escaped.txt";
            h.as_ustar_mut().unwrap().name[..raw.len()].copy_from_slice(raw);
            h.set_cksum();
            b.append(&h, &b"pwned"[..]).unwrap();
            b.finish().unwrap();
        }
        let out = tmp.join("out");
        fs::create_dir_all(&out).unwrap();
        let cancel = AtomicBool::new(false);
        let r = extract(
            &evil,
            Format::Tar,
            &out,
            &ExtractOptions {
                keep_broken: true,
                ..Default::default()
            },
            &mut rep("extract"),
            &cancel,
        );
        assert!(!tmp.join("escaped.txt").exists(), "越界文件被写出来了");
        assert!(!out.join("escaped.txt").exists());
        if let Err(e) = r {
            assert!(e.contains("越界") || e.contains("../escaped.txt"), "错误信息应指明越界: {}", e);
        }
    }
}
