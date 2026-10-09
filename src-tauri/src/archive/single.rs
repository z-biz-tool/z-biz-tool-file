//! 单流压缩：`.gz/.bz2/.xz/.zst/.lz4/.br/.lzma`。
//!
//! 这些不是归档，里面就一个文件。7-Zip 对它们的处理是"解出来一个叫 <原名去后缀> 的文件"，
//! 这里保持同样语义，UI 上也当成只有一个条目的归档来展示，好让"解压选中"之类的操作
//! 在两类东西上行为一致。

use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::format::Format;
use super::guard;
use super::io::{CountingReader, CountingWriter};
use super::job::Reporter;
use super::tar::{clamp, default_level, wrap_decoder, Codec, Encoder};
use super::types::{CreateOptions, Entry, ExtractOptions, Stats};

fn codec_of(fmt: Format) -> Option<Codec> {
    Some(match fmt {
        Format::Gz => Codec::Gz,
        Format::Bz2 => Codec::Bz2,
        Format::Xz => Codec::Xz,
        Format::Zst => Codec::Zst,
        Format::Lz4 => Codec::Lz4,
        Format::Br => Codec::Br,
        _ => return None,
    })
}

/// 解出来该叫什么名字。gzip 头里可能带原始文件名（FNAME），有就用它——
/// 很多 Linux 工具打的 `.gz` 里存的才是真名，光靠剥后缀会得到错的。
pub fn inner_name(path: &Path) -> String {
    if let Some(n) = gzip_inner_name(path) {
        return n;
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("data")
        .to_string();
    // 只剥**外层那一个**后缀：`.tar.gz` 解出来的是 `a.tar`，tar 那一层由 tar 模块负责。
    // 早先这里连 `.tar.gz` 一起列进来，结果是单流解出来的文件名直接少了一层，
    // 用户拿到一个叫 `a` 的 tar 包，双击又打不开。
    for suf in [".gz", ".bz2", ".xz", ".zst", ".lz4", ".br", ".lzma"] {
        if let Some(stripped) = strip_suffix_ci(&name, suf) {
            if !stripped.is_empty() {
                return stripped;
            }
        }
    }
    format!("{}.out", name)
}

fn strip_suffix_ci(s: &str, suf: &str) -> Option<String> {
    if s.len() > suf.len() && s[s.len() - suf.len()..].eq_ignore_ascii_case(suf) {
        Some(s[..s.len() - suf.len()].to_string())
    } else {
        None
    }
}

/// 读 gzip 头的 FNAME 字段（FLG bit3）。失败就返回 None，绝不因为读头失败而让整个列举挂掉。
fn gzip_inner_name(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let mut head = [0u8; 4];
    f.read_exact(&mut head).ok()?;
    if head[0] != 0x1F || head[1] != 0x8B {
        return None;
    }
    let flg = head[3];
    if flg & 0x08 == 0 {
        return None;
    }
    // 跳过 MTIME(4) XFL(1) OS(1)
    f.seek(SeekFrom::Start(10)).ok()?;
    // 跳过可能的 FEXTRA
    if flg & 0x04 != 0 {
        let mut xlen = [0u8; 2];
        f.read_exact(&mut xlen).ok()?;
        let n = u16::from_le_bytes(xlen) as u64;
        f.seek(SeekFrom::Current(n as i64)).ok()?;
    }
    let mut bytes = Vec::new();
    loop {
        let mut b = [0u8; 1];
        if f.read_exact(&mut b).is_err() || b[0] == 0 {
            break;
        }
        bytes.push(b[0]);
        if bytes.len() > 512 {
            return None; // 不像正常文件名，放弃
        }
    }
    if bytes.is_empty() {
        return None;
    }
    // gzip 规范里 FNAME 是 Latin-1；实际几乎都是 UTF-8，转换失败时退回 Latin-1 逐字节
    Some(match String::from_utf8(bytes.clone()) {
        Ok(s) => s,
        Err(_) => bytes.iter().map(|b| *b as char).collect(),
    })
    .and_then(|s| {
        // 只取最后一段，防止 FNAME 里带路径把我们引到目标目录外面
        let last = s.replace('\\', "/").rsplit('/').next().unwrap_or("").to_string();
        if last.is_empty() || last == "." || last == ".." {
            None
        } else {
            Some(last)
        }
    })
}

/// gzip 尾部的 ISIZE 是明文长度 mod 2^32，读它很便宜，能让列表直接显示大小
fn gzip_uncompressed_size(path: &Path) -> u64 {
    let Ok(mut f) = File::open(path) else { return 0 };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return 0 };
    if len < 18 {
        return 0;
    }
    if f.seek(SeekFrom::End(-4)).is_err() {
        return 0;
    }
    let mut b = [0u8; 4];
    if f.read_exact(&mut b).is_err() {
        return 0;
    }
    u32::from_le_bytes(b) as u64
}

pub fn list(path: &Path, fmt: Format) -> Result<Vec<Entry>, String> {
    let name = inner_name(path);
    let size = if fmt == Format::Gz {
        gzip_uncompressed_size(path)
    } else {
        0
    };
    let mtime = fs::metadata(path)
        .and_then(|m| {
            m.modified().map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0)
            })
        })
        .unwrap_or(0);
    Ok(vec![Entry {
        index: 0,
        path: name.clone(),
        name,
        is_dir: false,
        size,
        packed: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        modified: mtime,
        method: fmt.label().to_string(),
        encrypted: false,
        crc: 0,
        comment: String::new(),
        symlink_target: String::new(),
    }])
}

pub fn extract(
    path: &Path,
    fmt: Format,
    dest: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    if fmt == Format::LzmaAlone {
        return extract_lzma_alone(path, dest, opts, reporter, cancel);
    }
    let codec = codec_of(fmt).ok_or_else(|| format!("不是单流压缩格式: {}", fmt.id()))?;
    let total = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    reporter.set_totals(1, total);
    reporter.set_phase("working");

    let out_name = inner_name(path);
    let target = match guard::resolve_target(dest, &out_name, opts.overwrite).map_err(|e| e.to_string())? {
        Some(t) => t,
        None => {
            return Ok(Stats {
                skipped: 1,
                ..Default::default()
            })
        }
    };
    if let Some(p) = target.parent() {
        fs::create_dir_all(p).map_err(|e| format!("创建父目录失败: {}", e))?;
    }

    let f = File::open(path).map_err(|e| format!("打开失败: {}", e))?;
    let (counting, counter) = CountingReader::new(BufReader::with_capacity(256 * 1024, f));
    let mut decoder = wrap_decoder(counting, codec).map_err(|e| format!("初始化解压失败: {}", e))?;
    let mut out = BufWriter::with_capacity(256 * 1024, File::create(&target).map_err(|e| format!("创建文件失败: {}", e))?);
    reporter.set_entry(&out_name);

    let mut stats = Stats::default();
    match super::io::copy_with_cancel(&mut decoder, &mut out, cancel, |_| {
        // 进度按"从压缩包读走了多少字节"算：明文总量事先不知道，压缩包大小是已知的
        reporter.set_bytes(counter.load(Ordering::Relaxed));
    }) {
        Ok(n) => {
            stats.bytes_done = n;
            stats.entries_done = 1;
        }
        Err(e) => {
            let _ = fs::remove_file(&target); // 半截文件留着比不留更危险：用户会以为解压成功了
            if cancel.load(Ordering::Relaxed) {
                return Err(super::job::Cancelled.to_string());
            }
            return Err(format!("解压失败: {}", e));
        }
    }
    out.flush().map_err(|e| format!("刷盘失败: {}", e))?;
    drop(out);
    if fmt == Format::Gz {
        // gzip 头里的 MTIME 是原始文件的修改时间，还原回去，否则解出来的东西
        // 全部顶着"今天"，按时间排序的目录里就找不到它了
        if let Some(mt) = gzip_mtime(path) {
            super::io::set_mtime(&target, mt);
        }
    }
    reporter.set_bytes(counter.load(Ordering::Relaxed));
    // 0 而不是 stats.bytes_done：上面 set_bytes 已经按压缩包字节设过绝对值了，
    // 这里再累加明文字节等于把两种单位混在一起，进度会直接冲到 100% 以上
    reporter.entry_done(&out_name, 0);
    Ok(stats)
}

fn gzip_mtime(path: &Path) -> Option<u64> {
    let mut f = File::open(path).ok()?;
    let mut b = [0u8; 8];
    f.read_exact(&mut b).ok()?;
    if b[0] != 0x1F || b[1] != 0x8B {
        return None;
    }
    let v = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
    if v == 0 {
        None
    } else {
        Some(v as u64)
    }
}

/// `.lzma`（LZMA alone，没有 xz 的头尾）走裸 LZMA1 解码器
fn extract_lzma_alone(
    path: &Path,
    dest: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let total = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    reporter.set_totals(1, total);
    reporter.set_phase("working");
    let out_name = inner_name(path);
    let target = match guard::resolve_target(dest, &out_name, opts.overwrite).map_err(|e| e.to_string())? {
        Some(t) => t,
        None => return Ok(Stats { skipped: 1, ..Default::default() }),
    };
    if let Some(p) = target.parent() {
        fs::create_dir_all(p).map_err(|e| format!("创建父目录失败: {}", e))?;
    }
    let f = File::open(path).map_err(|e| format!("打开失败: {}", e))?;
    let (counting, counter) = CountingReader::new(BufReader::with_capacity(256 * 1024, f));
    let stream = xz2::stream::Stream::new_lzma_decoder(u64::MAX)
        .map_err(|e| format!("初始化 LZMA 解码器失败: {}", e))?;
    let mut decoder = xz2::read::XzDecoder::new_stream(counting, stream);
    let mut out = BufWriter::with_capacity(256 * 1024, File::create(&target).map_err(|e| format!("创建文件失败: {}", e))?);
    reporter.set_entry(&out_name);
    let mut stats = Stats::default();
    match super::io::copy_with_cancel(&mut decoder, &mut out, cancel, |_| {
        reporter.set_bytes(counter.load(Ordering::Relaxed));
    }) {
        Ok(n) => {
            stats.bytes_done = n;
            stats.entries_done = 1;
        }
        Err(e) => {
            let _ = fs::remove_file(&target);
            if cancel.load(Ordering::Relaxed) {
                return Err(super::job::Cancelled.to_string());
            }
            return Err(format!("解压 LZMA 失败: {}", e));
        }
    }
    out.flush().map_err(|e| format!("刷盘失败: {}", e))?;
    reporter.set_bytes(counter.load(Ordering::Relaxed));
    reporter.entry_done(&out_name, 0);
    Ok(stats)
}

// ============================================================================
// 校验
// ============================================================================

/// 测试单流压缩文件：解到底，一个字节也不落盘。
///
/// 校验是解码器顺带做的，不用自己再算一遍：gzip 在流末尾比对 CRC32 和 ISIZE，
/// xz 比对 CRC64，bzip2 逐块比对 CRC，zstd 带 frame checksum 时会比对。
/// **没下载完的 `.gz` 就是在这里现形的**，所以这个功能对单流格式不是摆设。
/// 例外是 brotli：格式本身没有校验字段，`.br` 只能验"能不能解完"，验不出静默的位翻转。
pub fn test(
    path: &Path,
    fmt: Format,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let total = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    reporter.set_totals(1, total);
    reporter.set_phase("working");

    let name = inner_name(path);
    reporter.set_entry(&name);
    let f = File::open(path).map_err(|e| format!("打开失败: {}", e))?;
    // 计数器贴在磁盘文件外面（见 io.rs 顶部）：进度按"读走了压缩包的多少字节"算，
    // 明文总量事先不知道，但压缩包大小是已知的，这样百分比才准
    let (counting, counter) = CountingReader::new(BufReader::with_capacity(256 * 1024, f));
    let mut decoder: Box<dyn Read> = if fmt == Format::LzmaAlone {
        let stream = xz2::stream::Stream::new_lzma_decoder(u64::MAX)
            .map_err(|e| format!("初始化 LZMA 解码器失败: {}", e))?;
        Box::new(xz2::read::XzDecoder::new_stream(counting, stream))
    } else {
        let codec = codec_of(fmt).ok_or_else(|| format!("不是单流压缩格式: {}", fmt.id()))?;
        wrap_decoder(counting, codec).map_err(|e| format!("初始化解压失败: {}", e))?
    };

    let mut stats = Stats::default();
    match super::io::copy_with_cancel(&mut decoder, &mut io::sink(), cancel, |_| {
        reporter.set_bytes(counter.load(Ordering::Relaxed));
    }) {
        Ok(n) => {
            stats.bytes_done = n;
            stats.entries_done = 1;
            reporter.set_bytes(counter.load(Ordering::Relaxed));
            // 传 0：上面 set_bytes 已经按压缩包字节设过绝对值了，这里再累加明文字节
            // 等于把两种单位混在一起，进度会直接冲到 100% 以上（和 extract 同理）
            reporter.entry_done(&name, 0);
        }
        Err(e) => {
            if cancel.load(Ordering::Relaxed) {
                return Err(super::job::Cancelled.to_string());
            }
            return Err(format!("校验失败，文件很可能已损坏或没下载完整: {}", e));
        }
    }
    Ok(stats)
}

// ============================================================================
// 创建
// ============================================================================

pub fn create(
    sources: &[PathBuf],
    dest: &Path,
    fmt: Format,
    opts: &CreateOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    // 单流格式天生只能装一个文件。多个源时不能报错也不能只压第一个（用户会以为全压进去了），
    // 退回 tar 家族：这是 7-Zip 的行为，也是最不可能造成数据误解的选择。
    if sources.len() != 1 {
        let tar_fmt = match fmt {
            Format::Gz => Format::TarGz,
            Format::Bz2 => Format::TarBz2,
            Format::Xz => Format::TarXz,
            Format::Zst => Format::TarZst,
            Format::Lz4 => Format::TarLz4,
            Format::Br => Format::TarBr,
            _ => Format::Tar,
        };
        let fixed = dest.with_extension("");
        let fixed = match tar_fmt.extension() {
            ".tar.gz" => fixed.with_extension("tar.gz"),
            ".tar.bz2" => fixed.with_extension("tar.bz2"),
            ".tar.xz" => fixed.with_extension("tar.xz"),
            ".tar.zst" => fixed.with_extension("tar.zst"),
            ".tar.lz4" => fixed.with_extension("tar.lz4"),
            ".tar.br" => fixed.with_extension("tar.br"),
            _ => fixed.with_extension("tar"),
        };
        return super::tar::create(sources, &fixed, tar_fmt, opts, reporter, cancel);
    }

    let src = &sources[0];
    if src.is_dir() {
        return Err(format!(
            "{} 只能压单个文件，{} 是目录（请改用 tar 或 7z）",
            fmt.label(),
            src.display()
        ));
    }

    if let Some(p) = dest.parent() {
        fs::create_dir_all(p).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }
    let level = opts.level.unwrap_or_else(|| {
        codec_of(fmt).map(default_level).unwrap_or(6)
    });

    let meta = fs::metadata(src).map_err(|e| format!("读取源文件失败: {}", e))?;
    reporter.set_totals(1, meta.len());
    reporter.set_phase("working");
    reporter.set_entry(&src.to_string_lossy());

    let file = File::create(dest).map_err(|e| format!("创建目标文件失败: {}", e))?;
    let (sink, written) = CountingWriter::new(BufWriter::with_capacity(256 * 1024, file));

    let mut stats = Stats::default();
    if fmt == Format::LzmaAlone {
        let opts_lzma = xz2::stream::LzmaOptions::new_preset(clamp(level, 0, 9) as u32)
            .map_err(|e| format!("初始化 LZMA 编码器失败: {}", e))?;
        let stream = xz2::stream::Stream::new_lzma_encoder(&opts_lzma)
            .map_err(|e| format!("初始化 LZMA 编码器失败: {}", e))?;
        let mut enc = xz2::write::XzEncoder::new_stream(sink, stream);
        copy_src_with_cancel(src, &mut enc, cancel, reporter)?;
        let sink = enc.finish().map_err(|e| format!("收尾失败: {}", e))?;
        // 和下面那条普通路径一样，必须显式 flush：BufWriter 的 Drop 也会刷，
        // 但它把错误吞掉，写满盘时就会静默产出一个截断的 .lzma
        let mut buf = sink.into_inner();
        buf.flush().map_err(|e| format!("刷盘失败: {}", e))?;
        stats.bytes_done = written.load(Ordering::Relaxed);
        stats.entries_done = 1;
        return Ok(stats);
    }

    let codec = codec_of(fmt).ok_or_else(|| format!("不是单流压缩格式: {}", fmt.id()))?;
    let encoder = Encoder::new(sink, codec, level).map_err(|e| format!("初始化压缩器失败: {}", e))?;
    let mut encoder = SingleEncoder(encoder);
    copy_src_with_cancel(src, &mut encoder, cancel, reporter)?;
    let sink = encoder.0.finish().map_err(|e| format!("收尾压缩流失败: {}", e))?;
    let mut buf = sink.into_inner();
    buf.flush().map_err(|e| format!("刷盘失败: {}", e))?;
    stats.bytes_done = written.load(Ordering::Relaxed);
    stats.entries_done = 1;
    Ok(stats)
}

/// Encoder 的 finish 要消费 self，但 io::copy 需要 &mut；包一层把它藏起来
struct SingleEncoder(Encoder);
impl Write for SingleEncoder {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

fn copy_src_with_cancel<W: Write>(
    src: &Path,
    w: &mut W,
    cancel: &AtomicBool,
    reporter: &mut Reporter,
) -> Result<u64, String> {
    let f = File::open(src).map_err(|e| format!("打开源文件失败: {}", e))?;
    let mut r = BufReader::with_capacity(256 * 1024, f);
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(super::job::Cancelled.to_string());
        }
        let n = r.read(&mut buf).map_err(|e| format!("读取源文件失败: {}", e))?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n]).map_err(|e| format!("写入失败: {}", e))?;
        total += n as u64;
        reporter.advance_bytes(n as u64);
    }
    // 这里**故意不 flush**：`w` 是压缩流，对它来说 flush 是 sync-flush，
    // 而 xz2 的 easy encoder 不支持——`XzEncoder::flush` 内部直接 `unwrap()`，
    // 一调就 panic，`.xz` / `.lzma` 一个都产不出来。数据全部由调用方紧接着的
    // `finish()` 吐出，中途没有"必须先落盘"的需求。
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::job::{new_job_id, Kind};

    fn rep(tag: &str) -> Reporter {
        Reporter::detached(new_job_id(Kind::Create), Kind::Create, tag.into(), tag.into())
    }

    fn roundtrip(fmt: Format, ext: &str) {
        let tmp = crate::test_bridge::TempDir::new("single");
        let src = tmp.join("payload.bin");
        let data: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&src, &data).unwrap();
        // 落点必须叫 `payload.bin.<ext>`：单流格式里只有 gzip 有地方存原名（FNAME），
        // bz2/xz/zst/lz4/br/lzma 都没有，内层名只能从归档文件名反推。这也是
        // `gzip`/`7z` 命令行默认的命名方式。
        let dest = tmp.join(format!("payload.bin{}", ext));
        let cancel = AtomicBool::new(false);
        create(
            &[src.clone()],
            &dest,
            fmt,
            &CreateOptions { format: fmt.id().into(), ..Default::default() },
            &mut rep("create"),
            &cancel,
        )
        .unwrap_or_else(|e| panic!("{} 压缩失败: {}", fmt.id(), e));
        assert!(dest.exists(), "{} 没产出", fmt.id());

        let entries = list(&dest, fmt).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "payload.bin", "{} 的内层名不对", fmt.id());

        let out = tmp.join("out");
        fs::create_dir_all(&out).unwrap();
        extract(&dest, fmt, &out, &ExtractOptions::default(), &mut rep("extract"), &cancel)
            .unwrap_or_else(|e| panic!("{} 解压失败: {}", fmt.id(), e));
        assert_eq!(fs::read(out.join("payload.bin")).unwrap(), data, "{} 内容不一致", fmt.id());
    }

    #[test]
    fn all_single_stream_codecs_roundtrip() {
        roundtrip(Format::Gz, ".gz");
        roundtrip(Format::Bz2, ".bz2");
        roundtrip(Format::Xz, ".xz");
        roundtrip(Format::Zst, ".zst");
        roundtrip(Format::Lz4, ".lz4");
        roundtrip(Format::Br, ".br");
        roundtrip(Format::LzmaAlone, ".lzma");
    }

    #[test]
    fn gzip_size_and_mtime_come_from_header() {
        let tmp = crate::test_bridge::TempDir::new("gz-meta");
        let src = tmp.join("report.txt");
        fs::write(&src, b"hello world").unwrap();
        let dest = tmp.join("report.txt.gz");
        let cancel = AtomicBool::new(false);
        create(&[src], &dest, Format::Gz, &CreateOptions::default(), &mut rep("c"), &cancel).unwrap();
        // ISIZE 是明文长度 mod 2^32；原来写 `>= 0`，对 u64 恒真，等于什么都没验
        assert_eq!(gzip_uncompressed_size(&dest), 11);
        let e = list(&dest, Format::Gz).unwrap();
        assert_eq!(e[0].name, "report.txt");
    }

    #[test]
    fn multiple_sources_fall_back_to_tar() {
        let tmp = crate::test_bridge::TempDir::new("single-multi");
        let a = tmp.join("a.txt");
        let b = tmp.join("b.txt");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let dest = tmp.join("multi.gz");
        let cancel = AtomicBool::new(false);
        create(&[a, b], &dest, Format::Gz, &CreateOptions::default(), &mut rep("c"), &cancel).unwrap();
        // 单流装不下两个文件，应该改产出 .tar.gz 而不是只压第一个
        assert!(tmp.join("multi.tar.gz").exists(), "多源时应回退成 tar.gz");
        let entries = super::super::tar::list(&tmp.join("multi.tar.gz"), Format::TarGz).unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn inner_name_strips_only_known_suffixes() {
        assert_eq!(inner_name(Path::new("/x/a.tar.gz")), "a.tar");
        assert_eq!(inner_name(Path::new("/x/a.gz")), "a");
        assert_eq!(inner_name(Path::new("/x/.gz")), ".gz.out");
        assert_eq!(inner_name(Path::new("/x/noext")), "noext.out");
    }
}
