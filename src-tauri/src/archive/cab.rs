//! CAB（Microsoft Cabinet）读取后端。
//!
//! 只读。CAB 是 Windows 驱动包 / 老安装包 / DirectX 运行库的载体，用户会碰到，
//! 但 7-Zip 自己也造不出 CAB，所以"替代 7-Zip"不要求写入能力。
//!
//! ## 这个格式的结构性代价，必须先说清楚
//!
//! CAB 把文件分成若干 **folder**（和磁盘目录无关，是一组共享压缩字典的数据块序列）。
//! 同一 folder 里的文件是**首尾相接的一段解压流**，`cab` crate 只公开了
//! `Cabinet::read_file(name)`：它每次都新建一个 folder 解码器，从头解码到目标文件的
//! 偏移量为止（`seek_to_uncompressed_offset` 就是逐块 `load_block` 过去）。
//! 于是"解出 folder 内 n 个文件"的解码量是 `Σ offset_i ≈ n·T/2`（T 为 folder 解压后总大小），
//! **平方级**。crate 没公开 folder 流式读取（`read_folder` 是私有的，`FolderReader`
//! 是 `pub(crate)`），所以没法只解码一遍。
//!
//! 实际影响：folder 里 100 个文件、共 20 MB → 约 1 GB 解码，几秒；
//! 1000 个文件、共 20 MB → 约 10 GB，几分钟。进度条按输出字节走，
//! 所以 seek 阶段会看起来"卡住"——这是真实代价，不是 bug。
//!
//! ## 意外收获：完整性校验是免费的
//!
//! `load_block` 在每个数据块上都验 CAB 自己的 32 位 checksum（非零时）。
//! 所以 `test()` 只要对每个 folder 取**最后一个**文件 `read_file` 再读到尾，
//! 就等于把整个 folder 的每个块解码并校验了一遍——总代价是线性的，不是平方的。
//! 这也是 CAB 的 `caps.test` 能给 true 的原因。
//!
//! ## 多卷
//!
//! CAB 支持 cabinet set（prev/next cabinet 链）。crate 只暴露了
//! `cabinet_set_index()`，所以判据很简单：index > 0 就是后续卷，拒绝并提示找第一卷。
//! 和 RAR 分卷的处理保持一致（`Format::Cab` 的能力表里也没有 create）。

use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use cab::{Cabinet, CompressionType};

use super::guard;
use super::job::Reporter;
use super::select::{map_output, normalize, single_root, Selector};
use super::types::{Entry, ExtractOptions, Stats};
use std::sync::atomic::{AtomicBool, Ordering};

type Ar = Cabinet<BufReader<File>>;

/// CAB 条目元信息。先从 `&Cabinet` 里全量抠出来存成 owned，之后才能拿 `&mut` 去读数据——
/// `read_file` 要 `&mut self`，而 `folder_entries()` 借的是 `&self`，两者不能同时活着。
struct Meta {
    /// CAB 里的**原始**名字。`Cabinet::read_file` 按原始名查表，所以必须原样留着：
    /// CAB 允许 `dir\file.txt` 这种反斜杠名，normalize 之后再去查会找不到。
    raw: String,
    /// 归一化后的名字（'/' 分隔、去掉 '.' 段），选择/落地/前端展示都用这个
    path: String,
    size: u64,
    modified: i64,
    method: String,
    readonly: bool,
    /// 在所属 folder 解压流里的偏移；用来算 test() 的进度
    offset_in_folder: u64,
    folder: usize,
    /// 是不是所在 folder 的最后一个文件：test() 靠它把整个 folder 扫完
    last_in_folder: bool,
}

fn open(path: &Path) -> Result<Ar, String> {
    let f = File::open(path).map_err(|e| format!("打开 {} 失败: {}", path.display(), e))?;
    Cabinet::new(BufReader::with_capacity(256 * 1024, f))
        .map_err(|e| format!("不是有效的 CAB 文件: {}", e))
}

fn method_label(ct: CompressionType) -> String {
    match ct {
        CompressionType::None => "Store".to_string(),
        CompressionType::MsZip => "MSZIP".to_string(),
        CompressionType::Quantum(level, _) => format!("Quantum L{}", level),
        // WindowSize 没有公开取值方法，但它 Debug 出来就是 KB32/MB2 这种，够用
        CompressionType::Lzx(w) => format!("LZX {:?}", w),
    }
}

/// `time::PrimitiveDateTime` 的字段 → Unix 秒。
///
/// 不在这里写死类型名，是为了不把 `time` 提升成本仓的直接依赖（它只是 cab/zip 的传递依赖）。
/// CAB 规范说这个时间"通常按本地时间理解"，所以和 zip/rar 一样走 Local 而不是 UTC——
/// 按 UTC 解释会让本机（Asia/Shanghai）显示的每个时间都早 8 小时。
fn to_unix(y: i32, mo: u8, d: u8, h: u8, mi: u8, s: u8) -> i64 {
    use chrono::TimeZone;
    // CAB 的日期时间字段是一个个 u8/u16 位域，chrono 要的是 u32，只能逐个抬上去
    let Some(naive) = chrono::NaiveDate::from_ymd_opt(y, mo as u32, d as u32).and_then(|date| {
        date.and_hms_opt(h as u32, mi as u32, s as u32)
    }) else {
        return 0;
    };
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| chrono::Local.from_local_datetime(&naive).earliest())
        .map(|dt| dt.timestamp())
        .unwrap_or(0)
}

fn scan(ar: &Ar) -> Result<Vec<Meta>, String> {
    let mut out = Vec::new();
    for (fi, folder) in ar.folder_entries().enumerate() {
        let method = method_label(folder.compression_type());
        let files: Vec<_> = folder.file_entries().collect();
        let mut offset = 0u64;
        let n = files.len();
        for (i, fe) in files.into_iter().enumerate() {
            let size = fe.uncompressed_size() as u64;
            let modified = match fe.datetime() {
                Some(dt) => to_unix(
                    dt.year(),
                    dt.month() as u8,
                    dt.day(),
                    dt.hour(),
                    dt.minute(),
                    dt.second(),
                ),
                None => 0,
            };
            out.push(Meta {
                raw: fe.name().to_string(),
                path: normalize(fe.name()),
                size,
                modified,
                method: method.clone(),
                readonly: fe.is_read_only(),
                offset_in_folder: offset,
                folder: fi,
                last_in_folder: i + 1 == n,
            });
            offset += size;
            if out.len() >= super::MAX_ENTRIES {
                return Ok(out);
            }
        }
    }
    Ok(out)
}

pub fn list(path: &Path) -> Result<Vec<Entry>, String> {
    let ar = open(path)?;
    let metas = scan(&ar)?;
    let mut entries: Vec<Entry> = metas
        .iter()
        .map(|m| Entry {
            // index 由 synthesize_dirs 统一重排成 0..n：合成目录要插进列表，
            // 事先分配的序号必然会错位，不如最后一次性编号
            index: 0,
            path: m.path.clone(),
            name: m.path.rsplit('/').next().unwrap_or("").to_string(),
            is_dir: false,
            size: m.size,
            // CAB 不给单文件的压缩后大小（压缩粒度是数据块，跨文件共享），如实填 0
            packed: 0,
            modified: m.modified,
            method: m.method.clone(),
            encrypted: false,
            crc: 0,
            comment: String::new(),
            symlink_target: String::new(),
        })
        .collect();
    // CAB 没有目录条目，但名字里可以带 '\'（`dir\file.txt`）。前端要树形展示就得有
    // 合成的目录节点，否则这些文件会全部平铺在根上、和 7-Zip 的显示不一致。
    synthesize_dirs(&mut entries);
    Ok(entries)
}

/// 从文件路径反推出目录条目，插到列表里（前端树/面包屑要用）。
/// 目录大小是子树汇总，和其它格式的 `rollup_dir_sizes` 观感一致。
fn synthesize_dirs(entries: &mut Vec<Entry>) {
    use std::collections::HashMap;
    let mut sums: HashMap<String, u64> = HashMap::new();
    for e in entries.iter() {
        let segs: Vec<&str> = e.path.split('/').collect();
        // k 是祖先层数；k == segs.len() 拼出来的是文件自己，不算祖先
        for k in 1..segs.len() {
            *sums.entry(segs[..k].join("/")).or_insert(0) += e.size;
        }
    }
    if sums.is_empty() {
        return;
    }
    let mut dirs: Vec<Entry> = sums
        .into_iter()
        .map(|(p, size)| Entry {
            index: 0,
            name: p.rsplit('/').next().unwrap_or("").to_string(),
            path: p,
            is_dir: true,
            size,
            packed: 0,
            modified: 0,
            method: String::new(),
            encrypted: false,
            crc: 0,
            comment: String::new(),
            symlink_target: String::new(),
        })
        .collect();
    dirs.sort_by(|a, b| a.path.cmp(&b.path));
    // 目录排前面，和 zip/tar 的列表顺序一致（那两种格式归档里本来就有目录条目）
    dirs.append(entries);
    *entries = dirs;
    // 最终 index 必须是 0..n 连续且不重复：前端拿它当 rowKey，撞了会让 React 渲染串行
    for (i, e) in entries.iter_mut().enumerate() {
        e.index = i as u32;
    }
}

/// CAB 是多卷时，这是第几卷（0 起）。第一卷返回 0。
pub fn set_index(path: &Path) -> Result<u16, String> {
    Ok(open(path)?.cabinet_set_index())
}

/// 后续卷不能单独解：前一个 cabinet 的名字 crate 没暴露，只能提示用户去找第一个。
pub fn secondary_cabinet_hint(path: &Path) -> Option<String> {
    match set_index(path) {
        Ok(i) if i > 0 => Some(format!(
            "这是 CAB 卷组的第 {} 卷，不能单独解压。请打开该卷组的第一个 .cab 文件。",
            i + 1
        )),
        _ => None,
    }
}

pub fn extract(
    path: &Path,
    dest: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    if let Some(msg) = secondary_cabinet_hint(path) {
        return Err(msg);
    }
    let mut ar = open(path)?;
    let metas = scan(&ar)?;
    let sel = Selector::new(opts.entries.clone(), opts.include_children);
    let strip_root = if opts.strip_root {
        single_root(metas.iter().map(|m| m.path.as_str()))
    } else {
        None
    };

    let work: Vec<&Meta> = metas.iter().filter(|m| sel.matches(&m.path)).collect();
    let total: u64 = work.iter().map(|m| m.size).sum();
    reporter.set_totals(work.len() as u64, total);
    reporter.set_phase("working");

    // 必须按 (folder, offset) 升序解：同一 folder 内乱序会让解码器反复 rewind 回块 0，
    // 白白多解码；升序至少保证每次都只往前跳。
    let mut work = work;
    work.sort_by_key(|m| (m.folder, m.offset_in_folder));

    let mut stats = Stats::default();
    let started = std::time::Instant::now();
    let mut buf = vec![0u8; 64 * 1024];

    for m in work {
        if cancel.load(Ordering::Relaxed) || reporter.cancelled() {
            stats.elapsed_ms = started.elapsed().as_millis() as u64;
            return Err(super::job::Cancelled.to_string());
        }
        let out_rel = map_output(&m.path, strip_root.as_deref(), opts.flatten);
        if out_rel.is_empty() {
            continue;
        }
        let target = match guard::resolve_target(dest, &out_rel, opts.overwrite) {
            Ok(Some(t)) => t,
            Ok(None) => {
                stats.skipped += 1;
                reporter.entry_done(&m.path, 0);
                continue;
            }
            Err(e) => {
                if opts.keep_broken {
                    stats.errors.push(e.to_string());
                    stats.skipped += 1;
                    continue;
                }
                return Err(e.to_string());
            }
        };
        if let Some(p) = target.parent() {
            fs::create_dir_all(p).map_err(|e| format!("创建目录失败: {}", e))?;
        }
        reporter.set_entry(&m.path);
        // read_file 会在返回前把 folder 从头解码到 m.offset_in_folder，这一步没有回调，
        // 大包上会表现为进度条静止——见模块头的说明。
        let mut reader = match ar.read_file(&m.raw) {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("读取 {} 失败: {}", m.path, e);
                if opts.keep_broken {
                    stats.errors.push(msg);
                    stats.skipped += 1;
                    continue;
                }
                return Err(msg);
            }
        };
        match write_out(&mut reader, &target, &mut buf, cancel, reporter) {
            Ok(n) => {
                if m.readonly {
                    if let Ok(mut perm) = fs::metadata(&target).map(|x| x.permissions()) {
                        perm.set_readonly(true);
                        let _ = fs::set_permissions(&target, perm);
                    }
                }
                if m.modified > 0 {
                    super::io::set_mtime(&target, m.modified as u64);
                }
                stats.entries_done += 1;
                stats.bytes_done += n;
            }
            Err(e) => {
                let _ = fs::remove_file(&target); // 不留半截文件
                if super::io::is_cancelled(&e) || e.kind() == std::io::ErrorKind::Interrupted {
                    stats.elapsed_ms = started.elapsed().as_millis() as u64;
                    return Err(super::job::Cancelled.to_string());
                }
                let msg = format!("写出 {} 失败: {}", target.display(), e);
                if opts.keep_broken {
                    stats.errors.push(msg);
                    stats.skipped += 1;
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

fn write_out(
    r: &mut dyn Read,    target: &Path,
    buf: &mut [u8],
    cancel: &AtomicBool,
    reporter: &mut Reporter,
) -> std::io::Result<u64> {
    use std::io::Write;
    let mut f = File::create(target)?;
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(super::io::cancelled_error());
        }
        let n = r.read(buf)?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n])?;
        total += n as u64;
        reporter.advance_bytes(n as u64);
    }
    f.flush()?;
    Ok(total)
}

/// 校验：对每个 folder 只解最后一个文件并读到尾，就把该 folder 的**所有**数据块
/// 解码 + 验 checksum 了一遍（`load_block` 里做校验）。总代价线性。
pub fn test(
    path: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let _ = opts; // CAB 不加密，没有密码可用
    let mut ar = open(path)?;
    let metas = scan(&ar)?;
    let total: u64 = metas.iter().map(|m| m.size).sum();
    reporter.set_totals(metas.len() as u64, total);
    reporter.set_phase("working");

    let mut stats = Stats::default();
    let started = std::time::Instant::now();
    let mut buf = vec![0u8; 256 * 1024];

    for m in metas.iter().filter(|m| m.last_in_folder) {
        if cancel.load(Ordering::Relaxed) || reporter.cancelled() {
            stats.elapsed_ms = started.elapsed().as_millis() as u64;
            return Err(super::job::Cancelled.to_string());
        }
        reporter.set_entry(&m.path);
        let mut reader = ar
            .read_file(&m.raw)
            .map_err(|e| format!("读取 {} 失败: {}", m.path, e))?;
        // 从头到这里的所有块都已解码校验过，把这段字节数一次性计入进度，
        // 否则"读了 100 个文件却只推进最后一个的字节数"，进度条会长时间停在低位
        reporter.advance_bytes(m.offset_in_folder);
        loop {
            if cancel.load(Ordering::Relaxed) {
                stats.elapsed_ms = started.elapsed().as_millis() as u64;
                return Err(super::job::Cancelled.to_string());
            }
            let n = reader
                .read(&mut buf)
                .map_err(|e| format!("校验 {} 失败: {}", m.path, e))?;
            if n == 0 {
                break;
            }
            reporter.advance_bytes(n as u64);
        }
        stats.bytes_done += m.offset_in_folder + m.size;
    }

    stats.entries_done = metas.len() as u64;
    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(stats)
}

/// 供 mod.rs 组装 ArchiveInfo 用：CAB 没有 solid / 加密 / 注释，卷信息来自 cabinet set。
pub fn archive_meta(path: &Path) -> super::types::ArchiveMeta {
    let mut meta = super::types::ArchiveMeta::default();
    if let Ok(ar) = open(path) {
        let idx = ar.cabinet_set_index();
        meta.multipart = idx > 0 || has_sibling(path);
        if meta.multipart {
            meta.volumes = sibling_volumes(path);
        }
    }
    meta
}

/// 卷组里是否还有别的卷：crate 不暴露 prev/next 名字，只能扫同目录的 .cab。
/// 判据放宽到"同目录存在其它 .cab 且 set_id 相同"。
fn has_sibling(path: &Path) -> bool {
    sibling_volumes(path).len() > 1
}

fn sibling_volumes(path: &Path) -> Vec<String> {
    let Some(dir) = path.parent() else {
        return vec![path.to_string_lossy().to_string()];
    };
    let Ok(id) = open(path).map(|a| a.cabinet_set_id()) else {
        return vec![path.to_string_lossy().to_string()];
    };
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p: PathBuf = e.path();
            let is_cab = p
                .extension()
                .map(|x| x.eq_ignore_ascii_case("cab"))
                .unwrap_or(false);
            if !is_cab {
                continue;
            }
            if let Ok(a) = open(&p) {
                if a.cabinet_set_id() == id {
                    out.push(p.to_string_lossy().to_string());
                }
            }
        }
    }
    if out.is_empty() {
        out.push(path.to_string_lossy().to_string());
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::super::job::Kind;
    use super::*;
    use cab::CabinetBuilder;
    use std::io::Write;

    /// 造一个 CAB，测试不依赖仓库外的样本文件。
    /// `next_file()` 的顺序就是 `add_file()` 的顺序，所以两个循环必须同序。
    fn build_cab(path: &Path, ct: CompressionType, files: &[(&str, &[u8])]) {
        let mut b = CabinetBuilder::new();
        {
            let folder = b.add_folder(ct);
            for (name, _) in files {
                folder.add_file(*name);
            }
        }
        let f = File::create(path).unwrap();
        let mut cw = b.build(f).unwrap();
        for (_, data) in files {
            let mut w = cw.next_file().unwrap().expect("builder 承诺了这个文件");
            w.write_all(data).unwrap();
        }
        cw.finish().unwrap();
    }

    fn rep(kind: Kind) -> Reporter {
        Reporter::detached("t".into(), kind, "t.cab".into(), String::new())
    }

    #[test]
    fn cab_roundtrip_lists_and_extracts() {
        let dir = crate::test_bridge::TempDir::new("cab-roundtrip");
        let cab_path = dir.join("t.cab");
        build_cab(
            &cab_path,
            CompressionType::None,
            &[("a.txt", &b"hello"[..]), ("sub/b.bin", &b"world!!"[..])],
        );

        let entries = list(&cab_path).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert!(names.contains(&"a.txt"), "{:?}", names);
        assert!(names.contains(&"sub/b.bin"), "{:?}", names);
        // 目录条目是合成出来的，必须有，否则前端树里 sub/b.bin 会挂空
        let dir_entry = entries
            .iter()
            .find(|e| e.is_dir && e.path == "sub")
            .unwrap_or_else(|| panic!("缺合成目录条目: {:?}", names));
        assert_eq!(dir_entry.size, 7, "目录大小要汇总子文件");
        // index 必须连续唯一，前端拿它当 rowKey
        let mut idx: Vec<u32> = entries.iter().map(|e| e.index).collect();
        idx.sort_unstable();
        assert_eq!(idx, (0..entries.len() as u32).collect::<Vec<_>>());

        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let cancel = AtomicBool::new(false);
        let stats = extract(
            &cab_path,
            &out,
            &ExtractOptions::default(),
            &mut rep(Kind::Extract),
            &cancel,
        )
        .unwrap();
        assert_eq!(stats.entries_done, 2);
        assert_eq!(fs::read(out.join("a.txt")).unwrap(), b"hello");
        assert_eq!(fs::read(out.join("sub/b.bin")).unwrap(), b"world!!");
    }

    #[test]
    fn cab_test_passes_on_intact_cabinet() {
        let dir = crate::test_bridge::TempDir::new("cab-test");
        let cab_path = dir.join("t.cab");
        build_cab(
            &cab_path,
            CompressionType::None,
            &[("a.txt", &b"hello"[..]), ("b.txt", &b"world"[..])],
        );
        let cancel = AtomicBool::new(false);
        let stats = test(
            &cab_path,
            &ExtractOptions::default(),
            &mut rep(Kind::Test),
            &cancel,
        )
        .unwrap();
        assert_eq!(stats.entries_done, 2);
        assert!(stats.errors.is_empty());
        assert_eq!(stats.bytes_done, 10);
    }

    #[test]
    fn cab_test_flags_bit_rot() {
        let dir = crate::test_bridge::TempDir::new("cab-rot");
        let cab_path = dir.join("t.cab");
        build_cab(
            &cab_path,
            CompressionType::None,
            &[("a.txt", &b"hello world, this is some payload"[..])],
        );
        // 翻最后一个字节（数据区），load_block 的 checksum 对不上就该报错
        let mut bytes = fs::read(&cab_path).unwrap();
        let n = bytes.len();
        bytes[n - 1] ^= 0xFF;
        fs::write(&cab_path, &bytes).unwrap();
        let cancel = AtomicBool::new(false);
        let err = test(
            &cab_path,
            &ExtractOptions::default(),
            &mut rep(Kind::Test),
            &cancel,
        )
        .unwrap_err();
        assert!(
            err.contains("校验") || err.to_lowercase().contains("checksum"),
            "坏块必须报出来，实际: {}",
            err
        );
    }

    #[test]
    fn cab_rejects_non_cab() {
        let dir = crate::test_bridge::TempDir::new("cab-bad");
        let p = dir.join("x.cab");
        fs::write(&p, b"definitely not a cabinet").unwrap();
        let err = list(&p).unwrap_err();
        assert!(err.contains("CAB"), "{}", err);
    }

    #[test]
    fn single_file_cab_has_no_secondary_hint() {
        let dir = crate::test_bridge::TempDir::new("cab-vol");
        let cab_path = dir.join("only.cab");
        build_cab(&cab_path, CompressionType::None, &[("a.txt", &b"x"[..])]);
        assert_eq!(set_index(&cab_path).unwrap(), 0);
        assert!(secondary_cabinet_hint(&cab_path).is_none());
        assert!(!archive_meta(&cab_path).multipart);
    }

    #[test]
    fn malicious_cab_names_cannot_escape() {
        let dir = crate::test_bridge::TempDir::new("cab-slip");
        let cab_path = dir.join("evil.cab");
        build_cab(
            &cab_path,
            CompressionType::None,
            &[("../escaped.txt", &b"pwned"[..])],
        );
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let cancel = AtomicBool::new(false);
        // normalize 保留 `..` 段，guard::safe_join 直接判 Escape 拒写
        let err = extract(
            &cab_path,
            &out,
            &ExtractOptions::default(),
            &mut rep(Kind::Extract),
            &cancel,
        )
        .unwrap_err();
        assert!(err.contains("越界"), "{}", err);
        assert!(!dir.join("escaped.txt").exists(), "越界写成功了，guard 失效");
    }

    #[test]
    fn mszip_cab_roundtrips() {
        let dir = crate::test_bridge::TempDir::new("cab-mszip");
        let cab_path = dir.join("z.cab");
        let payload = b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".repeat(40);
        build_cab(&cab_path, CompressionType::MsZip, &[("z.txt", &payload)]);

        let entries = list(&cab_path).unwrap();
        assert_eq!(
            entries.iter().find(|e| e.path == "z.txt").unwrap().method,
            "MSZIP"
        );
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let cancel = AtomicBool::new(false);
        extract(
            &cab_path,
            &out,
            &ExtractOptions::default(),
            &mut rep(Kind::Extract),
            &cancel,
        )
        .unwrap();
        assert_eq!(fs::read(out.join("z.txt")).unwrap(), payload);
    }

    #[test]
    fn dos_datetime_becomes_local_unix_seconds() {
        // 1997-03-12 11:13:52，本机 Asia/Shanghai → 该本地时刻对应的 Unix 秒。
        // 关键不是具体数值，而是"不能按 UTC 解释"：那样会整整差 8 小时。
        let secs = to_unix(1997, 3, 12, 11, 13, 52);
        let back = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
            .unwrap()
            .with_timezone(&chrono::Local);
        assert_eq!(back.format("%Y-%m-%d %H:%M:%S").to_string(), "1997-03-12 11:13:52");
        assert_eq!(to_unix(1997, 2, 30, 1, 1, 1), 0, "非法日期要退化成 0");
    }

    #[test]
    fn cancel_stops_extract() {
        let dir = crate::test_bridge::TempDir::new("cab-cancel");
        let cab_path = dir.join("t.cab");
        build_cab(
            &cab_path,
            CompressionType::None,
            &[("a.txt", &b"hello"[..]), ("b.txt", &b"world"[..])],
        );
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let cancel = AtomicBool::new(true);
        let err = extract(
            &cab_path,
            &out,
            &ExtractOptions::default(),
            &mut rep(Kind::Extract),
            &cancel,
        )
        .unwrap_err();
        assert!(err.contains("已取消"), "{}", err);
        assert!(!out.join("a.txt").exists(), "取消后不该留下文件");
    }
}
