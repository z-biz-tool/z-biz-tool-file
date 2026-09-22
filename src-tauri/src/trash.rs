use chrono::{Local, TimeZone};
// dir_size / copy_dir_recursive 复用 commands 里那一份：这两处逻辑此前各写一遍，
// 修符号链接跟随问题时要改两处，很容易漏。
use crate::commands::{copy_dir_recursive, dir_size};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use uuid::Uuid;

/// 回收站里的一项
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrashEntry {
    /// 回收站里的实际路径（不要直接操作！通过 API 操作）
    pub trash_path: String,
    /// 原始路径（删除前在哪）
    pub original_path: String,
    /// 原始文件名
    pub name: String,
    /// 是否目录
    pub is_dir: bool,
    /// 大小（字节）
    pub size: u64,
    /// 删除时间（RFC3339 字符串）
    pub deleted_at: String,
    /// 距今多少秒
    pub age_secs: i64,
}

fn trash_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?;
    let trash = base.join("trash");
    fs::create_dir_all(&trash).map_err(|e| format!("创建回收站目录失败: {}", e))?;
    Ok(trash)
}

/// 回收站里的路径都以字符串形式往返于前端，回传时可能已被改写。
/// 这里要求目标确实落在 trash 根目录内，否则拒绝——`remove_dir_all` 不可逆。
fn is_inside_trash(root: &Path, p: &Path) -> bool {
    match (root.canonicalize(), p.canonicalize()) {
        (Ok(r), Ok(c)) => c.starts_with(&r),
        _ => false,
    }
}

fn ensure_inside_trash(root: &Path, p: &Path) -> Result<PathBuf, String> {
    let canon = p
        .canonicalize()
        .map_err(|_| format!("回收站项不存在: {}", p.display()))?;
    if !is_inside_trash(root, &canon) {
        return Err(format!("拒绝操作：路径不在回收站目录内: {}", p.display()));
    }
    Ok(canon)
}

/// 恢复目标往往还不存在，用 `validate_new_path`：它 canonicalize 已存在的前缀，
/// 并对尚不存在的尾部补做黑名单检查。
///
/// 只校验"最近的已存在祖先"是不够的——`~/.ssh/config` 在 `.ssh` 还没建出来时
/// 会被放行，紧接着下面的 `create_dir_all` 正好把敏感目录替攻击者建好。
fn validate_restore_target(target: &Path) -> Result<(), String> {
    crate::path_guard::validate_new_path(&target.to_string_lossy())
        .map(|_| ())
        .map_err(|e| format!("拒绝恢复到该路径: {}", e))
}

fn path_to_trash(
    src: &Path,
    trash_root: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    // 布局：<trash_root>/<YYYY-MM-DD>/<uuid>/original_path.txt + <原文件名>
    let date = Local::now().format("%Y-%m-%d").to_string();
    let day_dir = trash_root.join(&date);
    fs::create_dir_all(&day_dir).map_err(|e| format!("创建日期目录失败: {}", e))?;
    let id = Uuid::new_v4().to_string()[..8].to_string();
    let uuid_dir = day_dir.join(&id);
    fs::create_dir_all(&uuid_dir).map_err(|e| format!("创建回收站子目录失败: {}", e))?;
    let file_name = src
        .file_name()
        .ok_or_else(|| "无法获取文件名".to_string())?;
    let final_dest = uuid_dir.join(file_name);
    Ok((final_dest, uuid_dir))
}

/// 把文件/目录移到回收站
///
/// 行为：
/// - 整个 mv 到 `app_data_dir/trash/YYYY-MM-DD/{uuid}/原名`
/// - 旁边写一个 `original_path.txt` 记录原始路径（恢复用）
/// - 返回移入后的路径（前端展示用）
/// - 跨设备/跨卷 mv 自动 fallback 到 copy + delete
#[tauri::command]
pub fn move_to_trash(
    app: tauri::AppHandle,
    src_path: String,
) -> Result<String, String> {
    // 复用 path_guard 的更严格校验（黑名单前缀 + .ssh/.gnupg 祖先拦截）
    if let Err(e) = crate::path_guard::validate(&src_path) {
        return Err(format!("拒绝移入回收站: {}", e));
    }
    let src = Path::new(&src_path);
    if !src.exists() {
        return Err(format!("文件不存在: {}", src_path));
    }
    let root = trash_root(&app)?;
    let (dest, uuid_dir) = path_to_trash(src, &root)?;
    // 写 original_path.txt（恢复时找原路径用）
    fs::write(uuid_dir.join("original_path.txt"), src_path.as_bytes())
        .map_err(|e| format!("写元数据失败: {}", e))?;
    // 先尝试 rename（同卷下最快），失败再 copy + remove
    if fs::rename(src, &dest).is_err() {
        if src.is_dir() {
            // 跨卷回退：复制走 commands 里那份统一实现（不跟随符号链接）
            copy_dir_recursive(src, &dest).map_err(|e| e.to_string())?;
            fs::remove_dir_all(src).map_err(|e| format!("删除原目录失败: {}", e))?;
        } else {
            fs::copy(src, &dest).map_err(|e| format!("复制文件失败: {}", e))?;
            fs::remove_file(src).map_err(|e| format!("删除原文件失败: {}", e))?;
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

/// 列出回收站所有项
#[tauri::command]
pub fn list_trash(app: tauri::AppHandle) -> Result<Vec<TrashEntry>, String> {
    let root = trash_root(&app)?;
    let mut entries = Vec::new();
    if !root.exists() {
        return Ok(entries);
    }
    walk_trash(&root, &mut entries)?;
    // 倒序：最近删除在前
    entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(entries)
}

/// 删除时间以日期目录名 `YYYY-MM-DD` 为准。
///
/// 旧实现读 `metadata().created()`，Linux 上多数文件系统拿不到创建时间，
/// `unwrap_or(0)` 会把删除时间算成 1970 年，`age_secs` 约等于当前时间戳——
/// 一旦按"超过 N 天自动清理"处理就会清空整个回收站。
fn date_dir_to_secs(date_str: &str) -> Option<i64> {
    let naive = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok()?;
    let midnight = naive.and_hms_opt(0, 0, 0)?;
    Some(Local.from_local_datetime(&midnight).single()?.timestamp())
}

fn mtime_secs(p: &Path) -> Option<i64> {
    fs::metadata(p)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

/// 日期目录给出当天 0 点，同一天内再用 uuid 目录 mtime 精化（mtime 跨平台可靠）
fn deleted_secs_of(date_str: &str, uuid_dir: &Path) -> i64 {
    let day = date_dir_to_secs(date_str);
    let mtime = mtime_secs(uuid_dir);
    match (day, mtime) {
        (Some(d), Some(m)) if m >= d => m,
        (Some(d), _) => d,
        (None, Some(m)) => m,
        (None, None) => 0,
    }
}

/// 判定"是否过保留期"用的时间，刻意不使用 mtime 精化。
///
/// 取该条目删除日的**次日 0 点**，即"它最多只可能这么新"：
/// mtime 会被恢复失败、杀毒软件、手工挪动等情况刷新，一旦参与判定，
/// 老条目就可能永远清不掉；而按整天对齐，最多只让保留期长一天，
/// 不会提前删掉任何文件。
fn expiry_secs_of(date_str: &str, uuid_dir: &Path) -> i64 {
    match date_dir_to_secs(date_str) {
        Some(d) => d + 86_400,
        None => mtime_secs(uuid_dir).unwrap_or(0),
    }
}

fn walk_trash(dir: &Path, out: &mut Vec<TrashEntry>) -> Result<(), String> {
    // 回收站结构：trash/YYYY-MM-DD/{uuid}/original_path.txt + {原名}
    // 入口 dir 通常是 trash 根目录，遍历两层
    if !dir.is_dir() {
        return Ok(());
    }
    for date_entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let date_entry = date_entry.map_err(|e| e.to_string())?;
        let date_path = date_entry.path();
        if !date_path.is_dir() {
            continue;
        }
        let date_str = date_entry.file_name().to_string_lossy().to_string();
        // 每个日期目录里有多个 uuid 目录
        for uuid_entry in fs::read_dir(&date_path).map_err(|e| e.to_string())? {
            let uuid_entry = uuid_entry.map_err(|e| e.to_string())?;
            let uuid_path = uuid_entry.path();
            if !uuid_path.is_dir() {
                continue;
            }
            let meta_file = uuid_path.join("original_path.txt");
            if !meta_file.exists() {
                continue;
            }
            // 在 uuid 目录里找"原文件"（不是 meta_file 那个）
            for file_entry in fs::read_dir(&uuid_path).map_err(|e| e.to_string())? {
                let file_entry = file_entry.map_err(|e| e.to_string())?;
                let file_path = file_entry.path();
                if file_path == meta_file {
                    continue;
                }
                // 这就是原文件
                let deleted_secs = deleted_secs_of(&date_str, &uuid_path);
                let now_secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let original_path = fs::read_to_string(&meta_file)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let name = file_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let size = dir_size(&file_path);
                let deleted_at = chrono::DateTime::from_timestamp(deleted_secs, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default();
                out.push(TrashEntry {
                    trash_path: file_path.to_string_lossy().to_string(),
                    original_path,
                    name,
                    is_dir: file_path.is_dir(),
                    size,
                    deleted_at,
                    // 时间不可知用 -1，而不是"距今 50 多年"——
                    // 否则 UI 和按天数的清理都会把它当成最老的条目
                    age_secs: if deleted_secs == 0 { -1 } else { now_secs - deleted_secs },
                });
            }
        }
    }
    Ok(())
}

/// 从回收站恢复某项到原位置（或新位置）
#[tauri::command]
pub fn restore_from_trash(
    app: tauri::AppHandle,
    trash_path: String,
    target_path: Option<String>,
) -> Result<String, String> {
    let root = trash_root(&app)?;
    let src_buf = ensure_inside_trash(&root, Path::new(&trash_path))?;
    let src: &Path = &src_buf;
    // src 是 "原文件" 路径，其父目录是 uuid 目录，uuid 目录里有 original_path.txt
    let uuid_dir = src.parent().ok_or_else(|| "无效的回收站路径".to_string())?;
    // 默认恢复到原路径
    let target = match target_path {
        Some(p) => PathBuf::from(p),
        None => {
            let meta_file = uuid_dir.join("original_path.txt");
            if meta_file.exists() {
                PathBuf::from(fs::read_to_string(&meta_file).map_err(|e| e.to_string())?.trim())
            } else {
                return Err("未提供目标路径且没有 original_path.txt 元信息".to_string());
            }
        }
    };
    validate_restore_target(&target)?;
    if target.exists() {
        return Err(format!("目标位置已存在文件: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::rename(src, &target).is_err() {
        if src.is_dir() {
            copy_dir_recursive(src, &target).map_err(|e| e.to_string())?;
            fs::remove_dir_all(src).map_err(|e| e.to_string())?;
        } else {
            fs::copy(src, &target).map_err(|e| e.to_string())?;
            fs::remove_file(src).map_err(|e| e.to_string())?;
        }
    }
    // 删掉整个 uuid 目录（含 original_path.txt）
    if is_inside_trash(&root, uuid_dir) {
        fs::remove_dir_all(uuid_dir).map_err(|e| e.to_string())?;
    }
    Ok(target.to_string_lossy().to_string())
}

/// 永久删除回收站里某项
#[tauri::command]
pub fn permanent_delete(
    app: tauri::AppHandle,
    trash_path: String,
) -> Result<(), String> {
    let root = trash_root(&app)?;
    let target = ensure_inside_trash(&root, Path::new(&trash_path))?;
    let uuid_dir = target.parent().map(Path::to_path_buf);
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("永久删除失败: {}", e))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("永久删除失败: {}", e))?;
    }
    // 顺带收掉装元数据的 uuid 目录；必须仍在回收站内，绝不碰日期目录或 root
    if let Some(uuid_dir) = uuid_dir {
        if uuid_dir != root && is_inside_trash(&root, &uuid_dir) {
            let _ = fs::remove_dir_all(&uuid_dir);
        }
    }
    Ok(())
}

/// 清空整个回收站
#[tauri::command]
pub fn empty_trash(app: tauri::AppHandle) -> Result<u64, String> {
    let root = trash_root(&app)?;
    if !root.exists() {
        return Ok(0);
    }
    let mut bytes = 0u64;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_dir() {
            bytes += dir_size(&p);
            fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
        } else if p.is_file() {
            if let Ok(m) = fs::metadata(&p) {
                bytes += m.len();
            }
            fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(bytes)
}

/// 获取回收站总大小（用于 UI 展示）
#[tauri::command]
pub fn get_trash_size(app: tauri::AppHandle) -> Result<u64, String> {
    let root = trash_root(&app)?;
    if !root.exists() {
        return Ok(0);
    }
    Ok(dir_size(&root))
}

/// 获取回收站根目录路径
#[tauri::command]
pub fn get_trash_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(trash_root(&app)?.to_string_lossy().to_string())
}

/// 回收站默认保留天数
pub const DEFAULT_TRASH_RETAIN_DAYS: i64 = 30;

/// 超期清理的结果统计
#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct TrashCleanupReport {
    /// 被永久删除的条目数
    pub removed: usize,
    /// 释放的字节数
    pub bytes_freed: u64,
    /// 因为拿不到可靠删除时间而**保留**的条目数
    pub kept_unknown_age: usize,
    /// 生效的保留天数
    pub retain_days: i64,
}

/// 回收站按天数保留。核心逻辑不依赖 AppHandle，便于单测。
///
/// 拿不到可靠删除时间的条目一律保留——宁可多留，也不能因为时间算错
/// 把用户还在指望能恢复的文件删掉。
fn cleanup_expired_in(
    root: &Path,
    now_secs: i64,
    retain_days: i64,
) -> Result<TrashCleanupReport, String> {
    let days = retain_days.max(1);
    let cutoff = now_secs - days * 86_400;
    let mut report = TrashCleanupReport {
        retain_days: days,
        ..Default::default()
    };
    if !root.exists() {
        return Ok(report);
    }
    for date_entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let date_entry = date_entry.map_err(|e| e.to_string())?;
        let date_path = date_entry.path();
        if !date_path.is_dir() {
            continue;
        }
        let date_str = date_entry.file_name().to_string_lossy().to_string();
        for uuid_entry in fs::read_dir(&date_path).map_err(|e| e.to_string())? {
            let uuid_entry = uuid_entry.map_err(|e| e.to_string())?;
            let uuid_path = uuid_entry.path();
            if !uuid_path.is_dir() {
                continue;
            }
            // 没有元信息说明不是回收站条目目录，不碰
            if !uuid_path.join("original_path.txt").exists() {
                continue;
            }
            let deleted = expiry_secs_of(&date_str, &uuid_path);
            if deleted <= 0 {
                report.kept_unknown_age += 1;
                continue;
            }
            if deleted >= cutoff {
                continue;
            }
            let size = dir_size(&uuid_path);
            fs::remove_dir_all(&uuid_path).map_err(|e| e.to_string())?;
            report.removed += 1;
            report.bytes_freed += size;
        }
        // 日期目录空了就顺手收掉
        let now_empty = fs::read_dir(&date_path)
            .map(|mut r| r.next().is_none())
            .unwrap_or(false);
        if now_empty {
            let _ = fs::remove_dir(&date_path);
        }
    }
    Ok(report)
}

/// 清理超过保留期的回收站条目（默认 30 天）
#[tauri::command]
pub fn cleanup_expired_trash(
    app: tauri::AppHandle,
    retain_days: Option<i64>,
) -> Result<TrashCleanupReport, String> {
    let root = trash_root(&app)?;
    let days = retain_days.unwrap_or(DEFAULT_TRASH_RETAIN_DAYS);
    let now_secs = Local::now().timestamp();
    cleanup_expired_in(&root, now_secs, days)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建出 <tmp>/<case>/trash 与 <tmp>/<case>/outside 两棵树
    fn fixture(case: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("z-biz-tool-file-trash-{}", case));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("trash");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        // 回收站真实布局：root/<日期>/<uuid>/<原名>
        let item = root.join("2026-09-22").join("abcd1234");
        fs::create_dir_all(&item).unwrap();
        fs::write(item.join("report.txt"), b"hi").unwrap();
        fs::write(item.join("original_path.txt"), b"/some/where").unwrap();
        (root, outside)
    }

    #[test]
    fn inside_trash_accepts_real_item() {
        let (root, _o) = fixture("accept");
        let item = root.join("2026-09-22").join("abcd1234").join("report.txt");
        assert!(is_inside_trash(&root, &item));
        assert!(ensure_inside_trash(&root, &item).is_ok());
        fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn inside_trash_rejects_outside_dir() {
        // 复现漏洞：把回收站外的目录传进来会被 remove_dir_all 连带删掉父级
        let (root, outside) = fixture("outside");
        fs::write(outside.join("precious.txt"), b"data").unwrap();
        assert!(!is_inside_trash(&root, &outside));
        let err = ensure_inside_trash(&root, &outside).unwrap_err();
        assert!(err.contains("不在回收站目录内"), "{}", err);
        assert!(outside.exists(), "校验必须在删除之前拦下");
        fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn inside_trash_rejects_dotdot_escape() {
        let (root, outside) = fixture("dotdot");
        let sneaky = root.join("2026-09-22").join("..").join("..").join("..").join("outside");
        // 纯词法判断会被 .. 骗过去，只有 canonicalize 之后才能识破
        assert!(
            sneaky.starts_with(&root),
            "词法前缀检查对 .. 无效，这正是必须 canonicalize 的原因"
        );
        assert!(!is_inside_trash(&root, &sneaky));
        assert!(ensure_inside_trash(&root, &sneaky).is_err());
        assert!(outside.exists());
        fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[cfg(unix)]
    #[test]
    fn inside_trash_rejects_symlink_escape() {
        let (root, outside) = fixture("symlink");
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let via_link = root.join("link").join("precious.txt");
        fs::write(outside.join("precious.txt"), b"data").unwrap();
        assert!(via_link.exists(), "软链应当可解析");
        assert!(!is_inside_trash(&root, &via_link));
        assert!(ensure_inside_trash(&root, &via_link).is_err());
        fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn inside_trash_rejects_missing_item() {
        let (root, _o) = fixture("missing");
        let gone = root.join("2026-09-22").join("abcd1234").join("gone.txt");
        assert!(ensure_inside_trash(&root, &gone).is_err());
        fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    /// 造一个回收站条目目录：<root>/<date>/<id>/{original_path.txt, file.bin}
    fn make_entry(root: &Path, date: &str, id: &str, payload_len: usize) -> PathBuf {
        let dir = root.join(date).join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("original_path.txt"), b"/orig").unwrap();
        fs::write(dir.join("file.bin"), vec![b'x'; payload_len]).unwrap();
        dir
    }

    fn temp_root(case: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("z-biz-tool-file-trash-{}", case));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("trash");
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn cleanup_removes_only_expired_entries() {
        let root = temp_root("cleanup-expire");
        let now = Local::now().timestamp();
        let old = (Local::now() - chrono::Duration::days(45))
            .format("%Y-%m-%d")
            .to_string();
        let recent = Local::now().format("%Y-%m-%d").to_string();
        let gone = make_entry(&root, &old, "aaaa1111", 4096);
        let kept = make_entry(&root, &recent, "bbbb2222", 1024);

        let report = cleanup_expired_in(&root, now, 30).unwrap();

        assert_eq!(report.removed, 1, "只应清掉超期的那一条");
        assert!(report.bytes_freed >= 4096);
        assert_eq!(report.retain_days, 30);
        assert!(!gone.exists(), "45 天前的条目应被永久删除");
        assert!(kept.exists(), "30 天内的条目必须保留");
        assert!(
            !root.join(&old).exists(),
            "空掉的日期目录应被收掉，避免留下垃圾壳"
        );
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn cleanup_never_wipes_everything_when_retain_days_is_zero() {
        let root = temp_root("cleanup-zero");
        let now = Local::now().timestamp();
        let recent = Local::now().format("%Y-%m-%d").to_string();
        let kept = make_entry(&root, &recent, "cccc3333", 64);

        // 传 0 / 负数不该等价于"立刻清空"，最少按 1 天保留
        let report = cleanup_expired_in(&root, now, 0).unwrap();
        assert_eq!(report.retain_days, 1);
        assert_eq!(report.removed, 0);
        assert!(kept.exists());
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn unknown_age_is_the_only_case_we_refuse_to_clean() {
        // 日期目录名非法且拿不到 mtime -> 0，代表"不知道"，绝不能当成 1970 年清理
        let root = temp_root("cleanup-unknown");
        let missing = root.join("not-a-date").join("dddd4444");
        assert_eq!(deleted_secs_of("not-a-date", &missing), 0);
        assert_eq!(deleted_secs_of("2026-02-30", &missing), 0);
        assert!(deleted_secs_of("2026-02-01", &missing) > 0);
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn restore_target_rejects_sensitive_dir_that_does_not_exist_yet() {
        // 这就是干净 Linux runner 上暴露的那条：~/.ssh 还没建出来时，
        // 只校验"最近的已存在祖先"会放行，随后的 create_dir_all 再把它建出来
        let fake_home = std::env::temp_dir().join("z-biz-tool-file-trash-fakehome");
        let _ = fs::remove_dir_all(&fake_home);
        fs::create_dir_all(&fake_home).unwrap();
        for name in [".ssh/authorized_keys", ".aws/credentials", ".kube/config"] {
            let target = fake_home.join(name);
            let err = validate_restore_target(&target).unwrap_err();
            assert!(err.contains("禁止操作"), "{} 应被拦下，实际: {}", name, err);
            assert!(
                !target.parent().unwrap().exists(),
                "校验失败时绝不能已经把敏感目录建出来"
            );
        }
        let _ = fs::remove_dir_all(&fake_home);
    }

    #[test]
    fn date_dir_name_is_the_source_of_truth() {
        // 40 天前的日期目录必须算出 ~40 天的年龄；旧实现用 created()，
        // 在拿不到创建时间的文件系统上会退化成"1970 年删除"（约 2 万天）
        let old = Local::now() - chrono::Duration::days(40);
        let day = old.format("%Y-%m-%d").to_string();
        let secs = date_dir_to_secs(&day).expect("应能解析 YYYY-MM-DD");
        let age = Local::now().timestamp() - secs;
        let forty_days = 40 * 86_400;
        assert!(
            (forty_days - 86_400..forty_days + 86_400).contains(&age),
            "年龄应约 40 天，实际 {} 秒",
            age
        );
    }

    #[test]
    fn junk_date_dir_falls_back_instead_of_claiming_1970() {
        let (_root, outside) = fixture("junkdate");
        let bogus = _root.join("not-a-date");
        fs::create_dir_all(&bogus).unwrap();
        assert!(date_dir_to_secs("not-a-date").is_none());
        // 目录名解析不了时退回 mtime，绝不能再退回 0（=1970）
        let secs = deleted_secs_of("not-a-date", &bogus);
        assert!(secs > 0, "应有可用的时间，实际 {}", secs);
        assert!(
            Local::now().timestamp() - secs < 86_400,
            "刚建的目录不该被判成远古"
        );
        fs::remove_dir_all(outside.parent().unwrap()).ok();
    }

    #[test]
    fn same_day_entries_use_mtime_refinement() {
        let (root, _o) = fixture("samday");
        let today = Local::now().format("%Y-%m-%d").to_string();
        let uuid_dir = root.join(&today);
        fs::create_dir_all(&uuid_dir).unwrap();
        // 当天 0 点 < 现在，应当被 uuid 目录的 mtime 精化到"刚刚"
        let secs = deleted_secs_of(&today, &uuid_dir);
        assert!(Local::now().timestamp() - secs < 120, "应精化到最近 2 分钟");
        fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn restore_target_rejects_system_paths() {
        assert!(validate_restore_target(Path::new("/etc/passwd")).is_err());
        let home = dirs::home_dir().unwrap();
        assert!(validate_restore_target(&home.join(".ssh/config")).is_err());
    }

    #[test]
    fn restore_target_allows_missing_file_in_existing_dir() {
        let dir = std::env::temp_dir().join("z-biz-tool-file-trash-restore");
        fs::create_dir_all(&dir).unwrap();
        // 恢复目标通常还不存在，中间层目录也可以还不存在
        assert!(validate_restore_target(&dir.join("sub").join("report.txt")).is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    /// 回收站里只要有一个目录含 `link -> ..`，跟随符号链接的 dir_size 就会一路递归到栈溢出。
    #[cfg(unix)]
    #[test]
    fn dir_size_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let root = temp_root("dirsize-loop");
        let dir = root.join("2026-01-01").join("uuid-loop");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("real.bin"), vec![7u8; 1000]).unwrap();
        symlink("..", dir.join("up")).unwrap();
        symlink(&dir, dir.join("self")).unwrap();

        assert_eq!(dir_size(&dir), 1000, "只应统计真实普通文件，链接指向的内容不算");
        fs::remove_dir_all(root.parent().unwrap()).ok();
    }
}
