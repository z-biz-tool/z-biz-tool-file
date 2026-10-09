//! RAR：**只读**。RAR 是专有格式，UnRAR 的许可证明确禁止用它来创建 RAR 归档，
//! 所以 `Caps.create` 永远是 false，前端连"压缩成 RAR"这个选项都不该渲染出来。
//!
//! 走 `unrar` crate（对官方 UnRAR 库的绑定，C++ 编译进二进制，不需要本机装 WinRAR）。
//!
//! ## 路径安全
//!
//! UnRAR 提供 `extract_to(path)`——解压到**我指定的确切路径**，而不是"解压到某目录，
//! 名字由库自己拼"。所以每一条都先过 `guard::safe_join`：`../../evil` 这种条目名
//! 在字节落盘之前就被拒了，不依赖 C 库自己的路径检查（不同版本行为不一致，赌不起）。
//!
//! ## 进度粒度
//!
//! UnRAR 没有数据回调（`RHCM_PROCESSDATA` 没暴露出来），所以**单个条目内部**拿不到
//! 字节进度：一个 7.4 GB 的单文件 RAR 会显示 0% 然后跳到 100%。多条目包按条目计数，
//! 实测 8638 个条目的包进度是平滑的。`read()` 能把内容读进内存从而自己计数，但那样
//! 大文件会直接吃满内存，不能接受。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use unrar::error::Code;
use unrar::{Archive, FileHeader, VolumeInfo};

use super::guard;
use super::job::Reporter;
use super::select::{map_output, normalize, single_root, Selector};
use super::types::{ArchiveMeta, Entry, ExtractOptions, Stats};

/// RAR 的密码是**整个归档**级别的（`RARSetPassword` 设一次管全程），
/// 不像 zip 那样每个条目可以有不同密码。
fn open_list(path: &Path, pw: Option<&str>) -> Result<unrar::OpenArchive<unrar::List, unrar::CursorBeforeHeader>, String> {
    let arc = match pw {
        Some(p) => Archive::with_password(path, p.as_bytes()),
        None => Archive::new(path),
    };
    arc.open_for_listing().map_err(|e| open_err(e, pw.is_some()))
}

fn open_process(
    path: &Path,
    pw: Option<&str>,
) -> Result<unrar::OpenArchive<unrar::Process, unrar::CursorBeforeHeader>, String> {
    let arc = match pw {
        Some(p) => Archive::with_password(path, p.as_bytes()),
        None => Archive::new(path),
    };
    arc.open_for_processing().map_err(|e| open_err(e, pw.is_some()))
}

/// 打开失败的措辞要能区分"包坏了"和"要密码"。缺密码时报"归档损坏"的话，
/// 用户会去重下一遍，白折腾。
fn open_err(e: unrar::error::UnrarError, had_password: bool) -> String {
    if e.code == Code::MissingPassword || e.code == Code::BadPassword {
        return if had_password {
            "密码不正确".to_string()
        } else {
            "此 RAR 已加密，需要密码".to_string()
        };
    }
    format!("打开 RAR 失败: {}", e)
}

fn process_err(e: unrar::error::UnrarError, name: &str) -> String {
    match e.code {
        Code::BadPassword => format!("{}: 密码不正确", name),
        Code::MissingPassword => format!("{}: 需要密码", name),
        Code::BadData => format!("{}: 数据损坏（CRC 校验失败）", name),
        Code::ERead => format!("{}: 读取失败（分卷是否齐全？）", name),
        _ => format!("{}: {}", name, e),
    }
}

/// RAR 用 MS-DOS 时间格式存 `file_time`，和 ZIP 一样是**本地时间**
fn dos_to_unix(v: u32) -> i64 {
    if v == 0 {
        return 0;
    }
    use chrono::TimeZone;
    let sec = ((v & 0x1F) * 2) as u32;
    let min = ((v >> 5) & 0x3F) as u32;
    let hour = ((v >> 11) & 0x1F) as u32;
    let day = ((v >> 16) & 0x1F) as u32;
    let month = ((v >> 21) & 0x0F) as u32;
    let year = 1980 + ((v >> 25) & 0x7F) as i32;
    let (Some(d), Some(t)) = (
        chrono::NaiveDate::from_ymd_opt(year, month, day),
        chrono::NaiveTime::from_hms_opt(hour, min, sec),
    ) else {
        return 0;
    };
    let naive = chrono::NaiveDateTime::new(d, t);
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| chrono::Local.from_local_datetime(&naive).earliest())
        .map(|dt| dt.timestamp())
        .unwrap_or_else(|| naive.and_utc().timestamp())
}

/// RAR4 的 method 是 0x30(Store)..0x35(Best)；RAR5 的编码不同，UnRAR 库把它归一到
/// 同一个字段。认不出就显示原始值，别猜。
fn method_label(m: u32) -> String {
    match m {
        0x30 => "Store".to_string(),
        0x31 => "Fastest".to_string(),
        0x32 => "Fast".to_string(),
        0x33 => "Normal".to_string(),
        0x34 => "Good".to_string(),
        0x35 => "Best".to_string(),
        0 => "RAR5".to_string(),
        other => format!("0x{:02X}", other),
    }
}

/// 分卷文件清单：从第 1 卷开始探到第一个不存在的为止。
///
/// 只按文件名推（`nth_part` 是纯字符串运算，不碰文件系统），再逐个 `exists()`。
/// 存在的列出来，缺的那一卷在 UI 上要能看出来——用户最常遇到的就是"下载少了 part3"。
fn volumes_of(path: &Path) -> Vec<String> {
    let arc = Archive::new(path);
    if !arc.is_multipart() {
        return vec![path.to_string_lossy().to_string()];
    }
    let mut out = Vec::new();
    for n in 1..1000 {
        match arc.nth_part(n) {
            Some(p) if p.exists() => out.push(p.to_string_lossy().to_string()),
            Some(_) => break,
            None => break,
        }
    }
    if out.is_empty() {
        out.push(path.to_string_lossy().to_string());
    }
    out
}

/// 这个文件是不是分卷的非首卷。
///
/// 非首卷不能直接解：它缺前半截数据。这里明确告诉用户第一卷在哪，
/// 而不是丢一个 `ERAR_BAD_DATA` 让他自己猜。
pub fn secondary_volume_hint(path: &Path) -> Option<PathBuf> {
    let arc = Archive::new(path);
    if !arc.is_multipart() {
        return None;
    }
    match arc.first_part_option() {
        Some(first) if first != path => Some(first),
        _ => None,
    }
}

fn secondary_volume_error(path: &Path) -> Option<String> {
    secondary_volume_hint(path).map(|first| {
        format!(
            "这是分卷归档的后续卷，不能单独解压。请打开第一卷: {}",
            first.display()
        )
    })
}

/// 打开并归类失败原因。mod.rs 靠这个决定"弹密码框"还是"报错"——
/// 匹配中文错误措辞来分类是不行的，措辞一改前端就瞎了。
///
/// 列举阶段就要密码 ⇒ RAR 加密了**文件头**（UnRAR 只在读加密头时报 MissingPassword），
/// 所以这里可以直接把 `encrypted_headers` 定成 true。只加密内容的包能正常列出文件名，
/// 条目上的 `encrypted` 标志会告诉前端每条要不要密码。
pub fn open_status(path: &Path, pw: Option<&str>) -> super::OpenStatus {
    use super::OpenStatus;
    if let Some(m) = secondary_volume_error(path) {
        return OpenStatus::Failed { message: m };
    }
    let arc = match pw {
        Some(p) => Archive::with_password(path, p.as_bytes()),
        None => Archive::new(path),
    };
    let had_password = pw.is_some();
    match arc.open_for_listing() {
        Ok(_) => OpenStatus::Ok,
        Err(e) if e.code == Code::MissingPassword => OpenStatus::NeedPassword {
            message: open_err(e, had_password),
            encrypted_headers: true,
        },
        Err(e) if e.code == Code::BadPassword => OpenStatus::BadPassword {
            message: open_err(e, had_password),
        },
        Err(e) => OpenStatus::Failed {
            message: open_err(e, had_password),
        },
    }
}

// ============================================================================
// 列举
// ============================================================================

pub fn list(path: &Path, pw: Option<&str>) -> Result<(Vec<Entry>, ArchiveMeta), String> {
    // 非首卷：直接指路，别让用户对着一个解不开的包发懵
    if let Some(m) = secondary_volume_error(path) {
        return Err(m);
    }

    let arc = open_list(path, pw)?;
    let solid = arc.is_solid();
    let encrypted_headers = arc.has_encrypted_headers();
    let vol = arc.volume_info();
    let comment = String::new(); // UnRAR 库明确说注释还不支持（set_comments 是空实现）

    let mut entries = Vec::new();
    let mut idx = 0u32;
    let mut any_encrypted = false;
    for item in arc {
        let h = item.map_err(|e| format!("读取 RAR 目录失败: {}", e))?;
        let raw = h.filename.to_string_lossy().replace('\\', "/");
        let p = normalize(&raw);
        any_encrypted |= h.is_encrypted();
        entries.push(Entry {
            index: idx,
            name: p.rsplit('/').next().unwrap_or("").to_string(),
            is_dir: h.is_directory(),
            size: h.unpacked_size,
            // 压缩后大小**拿不到**：`unrar::FileHeader` 只暴露 `unpacked_size`，
            // 官方 UnRAR 的 `RARHeaderDataEx.PackSize` 没有被这个绑定透出来。
            // 这里原先写的是 `if solid { 0 } else { h.unpacked_size }` —— 非 solid 包
            // 于是把未压缩大小当成了压缩后大小，8638 条目的真实 RAR5 上
            // `total_packed == total_size`，界面算出"压缩率 100%"，而 7-Zip 同一个包
            // 显示的是 7.38 GB / 9.46 GiB。填一个看着像样的错数字比填 0 糟得多：
            // 0 至少能让前端认出"这个格式没给"并显示 '-'（cab / tar 也是这么办的）。
            packed: 0,
            modified: dos_to_unix(h.file_time),
            method: method_label(h.method),
            encrypted: h.is_encrypted(),
            crc: h.file_crc,
            comment: String::new(),
            symlink_target: String::new(),
            path: p,
        });
        idx += 1;
        if entries.len() >= super::MAX_ENTRIES {
            break;
        }
    }
    // 目录大小汇总统一在 mod.rs::info() 的出口处做，六个后端共用一份

    let meta = ArchiveMeta {
        solid,
        encrypted_headers,
        multipart: vol != VolumeInfo::None,
        volumes: volumes_of(path),
        comment,
        needs_password: any_encrypted || encrypted_headers,
    };
    Ok((entries, meta))
}

// ============================================================================
// 解压
// ============================================================================

/// `FileHeader` 不实现 Clone，而 `extract_to` 会消费掉持有它的 `OpenArchive`。
/// 所以先把要用的字段抄出来。
struct Snap {
    path: String,
    is_dir: bool,
    encrypted: bool,
    size: u64,
    modified: i64,
    attr: u32,
    split_before: bool,
}

fn snap(h: &FileHeader) -> Snap {
    Snap {
        path: h.filename.to_string_lossy().replace('\\', "/"),
        is_dir: h.is_directory(),
        encrypted: h.is_encrypted(),
        size: h.unpacked_size,
        modified: dos_to_unix(h.file_time),
        attr: h.file_attr,
        split_before: h.is_split_before(),
    }
}

pub fn extract(
    path: &Path,
    dest: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    if let Some(m) = secondary_volume_error(path) {
        return Err(m);
    }

    let pw = opts.password.as_deref();
    let sel = Selector::new(opts.entries.clone(), opts.include_children);
    // strip_root 需要先知道顶层目录是谁，而 RAR 的 List 模式和 Process 模式是两个
    // 独立句柄，所以先扫一遍名字（List 模式很快，不解压）
    let strip_root = if opts.strip_root {
        let names = list_names(path, pw)?;
        single_root(names.iter().map(|s| s.as_str()))
    } else {
        None
    };

    let arc = open_process(path, pw)?;
    fs::create_dir_all(dest).map_err(|e| format!("创建目标目录失败: {}", e))?;
    reporter.set_phase("working");

    let mut stats = Stats::default();
    let started = std::time::Instant::now();
    let mut cursor = arc;
    // keep_broken 时出错要重开句柄从头扫（UnRAR 出错后句柄状态不可信）。
    // 重开后同一条会再错一次，不记住"已经失败过谁"就是死循环。
    let mut failed: std::collections::HashSet<String> = std::collections::HashSet::new();

    loop {
        if cancel.load(Ordering::Relaxed) || reporter.cancelled() {
            stats.elapsed_ms = started.elapsed().as_millis() as u64;
            return Err(super::job::Cancelled.to_string());
        }
        let Some(before_file) = cursor.read_header().map_err(|e| e.to_string())? else {
            break;
        };
        let s = snap(before_file.entry());

        let out_rel = map_output(&s.path, strip_root.as_deref(), opts.flatten);
        let selected = !out_rel.is_empty() && sel.matches(&s.path) && !failed.contains(&s.path);
        reporter.set_entry(&s.path);

        if !selected {
            // 没选中也要走一遍 skip：游标必须前进，否则下一次 read_header 还是同一条。
            // solid 包里 skip 由 UnRAR 内部处理，不会破坏后续条目的解码。
            cursor = before_file.skip().map_err(|e| process_err(e, &s.path))?;
            continue;
        }
        if s.encrypted && pw.is_none() {
            let msg = format!("{}: 已加密，需要密码", s.path);
            if opts.keep_broken {
                stats.errors.push(msg);
                stats.skipped += 1;
                cursor = before_file.skip().map_err(|e| process_err(e, &s.path))?;
                continue;
            }
            return Err(msg);
        }
        // 跨卷续接的条目：本卷里没有它的开头，解出来必然是残缺的
        if s.split_before {
            let msg = format!("{}: 该条目从上一卷延续，当前卷里没有它的数据", s.path);
            if opts.keep_broken {
                stats.errors.push(msg);
                stats.skipped += 1;
                failed.insert(s.path.clone());
                cursor = before_file.skip().map_err(|e| process_err(e, &s.path))?;
                continue;
            }
            return Err(msg);
        }

        let target = match guard::resolve_target(dest, &out_rel, opts.overwrite).map_err(|e| e.to_string())? {
            Some(t) => t,
            None => {
                stats.skipped += 1;
                cursor = before_file.skip().map_err(|e| process_err(e, &s.path))?;
                continue;
            }
        };

        if s.is_dir {
            fs::create_dir_all(&target).map_err(|e| format!("建目录失败: {}", e))?;
            stats.entries_done += 1;
            reporter.entry_done(&s.path, 0);
            cursor = before_file.skip().map_err(|e| process_err(e, &s.path))?;
            continue;
        }

        if let Some(p) = target.parent() {
            fs::create_dir_all(p).map_err(|e| format!("建上级目录失败: {}", e))?;
        }
        match before_file.extract_to(&target) {
            Ok(next) => {
                cursor = next;
                apply_attr(&target, s.attr);
                super::io::set_mtime(&target, s.modified.max(0) as u64);
                stats.entries_done += 1;
                stats.bytes_done += s.size;
                reporter.entry_done(&s.path, s.size);
            }
            Err(e) => {
                let _ = fs::remove_file(&target); // 不留半截文件
                let msg = process_err(e, &s.path);
                if opts.keep_broken {
                    stats.errors.push(msg);
                    failed.insert(s.path);
                    // 出错后句柄状态不可信，重开。代价是前面成功的条目会再走一遍，
                    // 但 Overwrite::Skip 会把它们跳掉，只有时间成本。
                    cursor = open_process(path, pw)?;
                    continue;
                }
                stats.elapsed_ms = started.elapsed().as_millis() as u64;
                return Err(msg);
            }
        }
    }

    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(stats)
}

/// 只取名字，给 strip_root 判断用（List 模式不解压，比 Process 模式轻）
fn list_names(path: &Path, pw: Option<&str>) -> Result<Vec<String>, String> {
    let (entries, _) = list(path, pw)?;
    Ok(entries.into_iter().map(|e| e.path).collect())
}

/// RAR 的 `file_attr` 在 Windows 上是 DOS 属性位、在 Unix 上是高 16 位存 mode。
/// Windows 侧只还原**只读位**：隐藏位和系统位一改，用户在资源管理器里就找不到
/// 自己刚解出来的文件了——那是比"属性没还原"严重得多的体验问题。
fn apply_attr(target: &Path, attr: u32) {
    #[cfg(windows)]
    {
        const FILE_ATTRIBUTE_READONLY: u32 = 0x1;
        if attr & FILE_ATTRIBUTE_READONLY != 0 {
            if let Ok(mut perms) = fs::metadata(target).map(|m| m.permissions()) {
                perms.set_readonly(true);
                let _ = fs::set_permissions(target, perms);
            }
        }
    }
    #[cfg(unix)]
    {
        let mode = attr >> 16;
        if mode != 0 {
            let _ = guard::apply_mode(target, mode);
        }
    }
}

// ============================================================================
// 完整性测试
// ============================================================================

/// `test()` 让 UnRAR 库解一遍并校验 CRC，不写任何文件。
pub fn test(
    path: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let pw = opts.password.as_deref();
    let mut cursor = open_process(path, pw)?;
    let mut stats = Stats::default();
    let started = std::time::Instant::now();
    reporter.set_phase("working");

    loop {
        if cancel.load(Ordering::Relaxed) || reporter.cancelled() {
            return Err(super::job::Cancelled.to_string());
        }
        let Some(before_file) = cursor.read_header().map_err(|e| e.to_string())? else {
            break;
        };
        let s = snap(before_file.entry());
        if entries_full(&mut stats) {
            break;
        }
        reporter.set_entry(&s.path);
        if s.is_dir {
            cursor = before_file.skip().map_err(|e| process_err(e, &s.path))?;
            continue;
        }
        if s.encrypted && pw.is_none() {
            stats.skipped += 1;
            stats.errors.push(format!("{}: 已加密，未提供密码", s.path));
            cursor = before_file.skip().map_err(|e| process_err(e, &s.path))?;
            continue;
        }
        match before_file.test() {
            Ok(next) => {
                cursor = next;
                stats.entries_done += 1;
                stats.bytes_done += s.size;
                reporter.entry_done(&s.path, s.size);
            }
            Err(e) => {
                stats.errors.push(process_err(e, &s.path));
                cursor = open_process(path, pw)?;
            }
        }
    }
    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(stats)
}

fn entries_full(stats: &Stats) -> bool {
    stats.entries_done as usize >= super::MAX_ENTRIES
}

// ============================================================================
// 测试
// ============================================================================
//
// 真 RAR 包没法在单元测试里现造（UnRAR 许可证禁止创建），所以这里只测纯函数。
// 端到端验证放在 `tests/integration_commands.rs`，用仓库里带的小样本 rar。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dos_time_decodes_to_local_wall_clock() {
        // 2024-03-05 14:30:00 的 MS-DOS 编码
        let v: u32 = ((2024 - 1980) << 25)
            | (3 << 21)
            | (5 << 16)
            | (14 << 11)
            | (30 << 5)
            | (0 / 2);
        let got = dos_to_unix(v);
        use chrono::TimeZone;
        let want = chrono::Local
            .from_local_datetime(&chrono::NaiveDateTime::new(
                chrono::NaiveDate::from_ymd_opt(2024, 3, 5).unwrap(),
                chrono::NaiveTime::from_hms_opt(14, 30, 0).unwrap(),
            ))
            .single()
            .unwrap()
            .timestamp();
        assert!(
            (got - want).abs() <= 2,
            "RAR 时间是 DOS 本地时间，按 UTC 解释会差一个时区: {} vs {}",
            got,
            want
        );
        assert_eq!(dos_to_unix(0), 0, "0 表示没有时间，不能翻译成 1970");
    }

    #[test]
    fn method_labels_are_readable() {
        assert_eq!(method_label(0x30), "Store");
        assert_eq!(method_label(0x33), "Normal");
        assert_eq!(method_label(0x35), "Best");
        // 认不出的值要显示原始数字，不能瞎编一个名字
        assert_eq!(method_label(0x99), "0x99");
    }

    #[test]
    fn non_rar_path_reports_cleanly() {
        let tmp = crate::test_bridge::TempDir::new("rar-none");
        let not_rar = tmp.join("nope.rar");
        fs::write(&not_rar, b"this is not a rar archive at all").unwrap();
        let err = list(&not_rar, None).unwrap_err();
        assert!(
            !err.is_empty(),
            "坏包要给出可读的错误，不是 panic"
        );
    }

    #[test]
    fn volume_hint_is_none_for_single_file() {
        let tmp = crate::test_bridge::TempDir::new("rar-vol");
        let single = tmp.join("one.rar");
        fs::write(&single, b"Rar!\x1a\x07\x01\x00").unwrap();
        assert_eq!(secondary_volume_hint(&single), None);
        assert_eq!(volumes_of(&single), vec![single.to_string_lossy().to_string()]);
    }
}
