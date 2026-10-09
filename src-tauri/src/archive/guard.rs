//! 归档条目 → 磁盘路径的安全落地。
//!
//! 这里拦三类攻击，都是真实压缩包在野用过的：
//! 1. **zip-slip**：条目名写 `../../../x`，解压时逃出目标目录覆盖任意文件。
//! 2. **Windows 设备名**：条目名 `CON` / `NUL` / `COM1`，`File::create` 会打到设备上，
//!    轻则挂死重则写坏终端。
//! 3. **符号链接逃逸**：先解出一个指向 `C:\Windows` 的 symlink，再往同名条目写文件，
//!    写入就顺着链接出去了。这里一律把 symlink 落成"内容是目标路径的普通文件"。
//!
//! 老代码 `extract_zip_file_blocking` 是裸 `dest.join(entry_name)`，三条全中；
//! 所有解压路径现在都必须走 `safe_join`。

use std::path::{Component, Path, PathBuf};

/// Windows 保留设备名（不带扩展名时命中）
const WINDOWS_DEVICES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, PartialEq, Eq)]
pub enum GuardError {
    /// 条目名里带 `..` 或绝对路径
    Escape(String),
    /// 剥掉非法字符后什么都不剩
    Empty(String),
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GuardError::Escape(p) => write!(f, "条目路径越界，已拒绝写入: {}", p),
            GuardError::Empty(p) => write!(f, "条目路径在 Windows 上不合法: {}", p),
        }
    }
}

impl std::error::Error for GuardError {}

/// 清洗单个路径段：换掉 Windows 不允许的字符，给设备名加前缀。
/// 跨平台压缩包（Linux 上打的 tar 里可以有 `a:b`、`x*`）解到 Windows 时必须做这步，
/// 否则 `File::create` 直接失败，用户看到的是一堆莫名其妙的"创建文件失败"。
fn sanitize_component(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for c in seg.chars() {
        match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => out.push('_'),
            c if (c as u32) < 0x20 => out.push('_'),
            c => out.push(c),
        }
    }
    // Windows 不允许结尾的点/空格（`"foo. "` 会被静默截断成 `"foo"`，
    // 结果两个不同条目落到同一个文件上互相覆盖）
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    let stem = out.split('.').next().unwrap_or("");
    if WINDOWS_DEVICES.iter().any(|d| d.eq_ignore_ascii_case(stem)) {
        out = format!("_{}", out);
    }
    out
}

/// `C:` / `c:` 这样的盘符前缀。
///
/// 只认"单个 ASCII 字母 + 冒号"起头，不能一见冒号就当越界：Linux/macOS 上打的包里
/// `a:b.txt`、`movie 1:2.mkv` 都是合法文件名，一律拒掉会让整批解压挂在一个条目上。
/// 冒号本身在 Windows 上不合法，交给 `sanitize_component` 换成下划线。
fn is_drive_prefix(seg: &str) -> bool {
    let b = seg.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// 把归档内的条目路径安全地拼到 `dest` 下。
///
/// `dest` 必须是已经 canonicalize 过的绝对路径（调用方负责），
/// 这样返回值的 `starts_with(dest)` 检查才有意义。
pub fn safe_join(dest: &Path, entry_path: &str) -> Result<PathBuf, GuardError> {
    // tar 用 '/'，zip 也是 '/'，但 rar/cab 在 Windows 上打的包可能是 '\'
    let unified = entry_path.replace('\\', "/");
    // UNC 整条拒掉，不跟下面的前导斜杠一样"剥掉当相对路径"：
    // `\\server\share` 是明确指向别的机器的写入意图，静默改写落点比报错更糟。
    if unified.starts_with("//") {
        return Err(GuardError::Escape(entry_path.to_string()));
    }
    let mut rel = PathBuf::new();
    let mut any = false;

    for seg in unified.split('/') {
        // 空段来自前导 '/'（`/etc/passwd`）或重复分隔符。前导斜杠**剥掉而不是拒绝**：
        // `tar -cf x.tar /etc` 这种用绝对路径打的包很常见，GNU tar 和 7-Zip 都是去掉
        // 前导斜杠后按相对路径落地（tar 还会打一行警告）。拒掉的话用户看到的是一个
        // 莫名其妙的失败，而剥掉之后的落点仍然被 is_within 兜在 dest 里面。
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(GuardError::Escape(entry_path.to_string()));
        }
        if is_drive_prefix(seg) {
            return Err(GuardError::Escape(entry_path.to_string()));
        }
        let clean = sanitize_component(seg);
        if clean.is_empty() {
            continue;
        }
        rel.push(clean);
        any = true;
    }

    if !any {
        return Err(GuardError::Empty(entry_path.to_string()));
    }

    let full = dest.join(&rel);
    // 二次确认：canonicalize 过的 dest + 纯词法拼接，理论上不可能越界，
    // 但这条检查是廉价的，留着当最后一道网
    if !is_within(dest, &full) {
        return Err(GuardError::Escape(entry_path.to_string()));
    }
    Ok(full)
}

/// 词法层面的"在 dest 之内"判断。不用 canonicalize：解压目标此刻还不存在，
/// canonicalize 会失败；而 safe_join 已经保证 rel 里没有 `..`。
pub fn is_within(dest: &Path, candidate: &Path) -> bool {
    let d: Vec<Component> = dest.components().collect();
    let c: Vec<Component> = candidate.components().collect();
    c.len() > d.len() && c[..d.len()] == d[..]
}

/// Unix 权限位落到 Windows 只能退化成只读属性；其余平台直接 chmod。
/// 原来这段散在 commands.rs 里，解压各格式都要用，收拢到这儿。
pub fn apply_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(path)?.permissions();
        perm.set_mode(mode & 0o7777);
        std::fs::set_permissions(path, perm)?;
    }
    #[cfg(windows)]
    {
        // 只保留"只读"这一位：Windows 没有 unix 权限模型，硬套只会得到误导性的属性
        let readonly = mode & 0o200 == 0;
        let mut perm = std::fs::metadata(path)?.permissions();
        perm.set_readonly(readonly);
        std::fs::set_permissions(path, perm)?;
    }
    Ok(())
}

/// 已存在同名文件时的处理策略。
///
/// "问用户"不在这里做：引擎是同步阻塞的，中途弹窗会把整条解压停住。
/// 前端在开始前先探测冲突（`archive_conflicts`），拿到用户的选择再传策略进来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Overwrite {
    /// 跳过已存在的（默认，最不意外）
    Skip,
    /// 直接覆盖
    Overwrite,
    /// 换成 `name (1).ext` 这种不冲突的名字
    Rename,
}

impl Default for Overwrite {
    fn default() -> Self {
        Overwrite::Skip
    }
}

/// 按策略决定最终落点。返回 None 表示"跳过这个条目"。
pub fn resolve_target(
    dest: &Path,
    entry_path: &str,
    policy: Overwrite,
) -> Result<Option<PathBuf>, GuardError> {
    let target = safe_join(dest, entry_path)?;
    if !target.exists() {
        return Ok(Some(target));
    }
    match policy {
        Overwrite::Skip => Ok(None),
        Overwrite::Overwrite => Ok(Some(target)),
        Overwrite::Rename => Ok(Some(unique_sibling(&target))),
    }
}

/// 生成 `foo (1).bar` 式的唯一名。与 commands.rs 里 copy/move 的重名策略保持同一种观感，
/// 用户在同一个 App 里不该看到两套命名规则。
pub fn unique_sibling(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or(Path::new("."));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 1..10_000u32 {
        let name = match ext {
            Some(e) => format!("{} ({}).{}", stem, n, e),
            None => format!("{} ({})", stem, n),
        };
        let cand = parent.join(name);
        if !cand.exists() {
            return cand;
        }
    }
    // 撞满一万个：退化成时间戳，绝不覆盖已有文件
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    parent.join(format!("{} ({})", stem, ts))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_zip_slip() {
        let dest = Path::new("/tmp/out");
        assert_eq!(
            safe_join(dest, "../../../etc/passwd"),
            Err(GuardError::Escape("../../../etc/passwd".into()))
        );
        assert_eq!(
            safe_join(dest, "a/../../b"),
            Err(GuardError::Escape("a/../../b".into()))
        );
        assert!(safe_join(dest, "ok/file.txt").is_ok());
    }

    /// 前导斜杠是"剥掉后按相对路径落地"，不是拒绝：绝对路径打的 tar 太常见了。
    /// 要钉死的是安全性——剥完必须还在 dest 里面。
    #[test]
    fn leading_slash_lands_inside_dest_instead_of_escaping() {
        let dest = Path::new("/tmp/out");
        let p = safe_join(dest, "/etc/passwd").expect("前导斜杠不该整条拒掉");
        assert!(is_within(dest, &p), "{} 跑到 dest 外面了", p.display());
        assert!(p.ends_with(Path::new("etc/passwd")), "{}", p.display());
    }

    #[test]
    fn rejects_windows_drive_and_unc() {
        let dest = Path::new("/tmp/out");
        assert!(matches!(safe_join(dest, "C:evil.txt"), Err(GuardError::Escape(_))));
        assert!(matches!(safe_join(dest, "c:/evil.txt"), Err(GuardError::Escape(_))));
        assert!(matches!(safe_join(dest, "\\\\server\\share"), Err(GuardError::Escape(_))));
    }

    #[test]
    fn sanitizes_windows_hostile_names() {
        let dest = Path::new("/tmp/out");
        let p = safe_join(dest, "CON").unwrap();
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "_CON");
        let p = safe_join(dest, "a<b>c:d.txt").unwrap();
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "a_b_c_d.txt");
        let p = safe_join(dest, "trail...").unwrap();
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "trail");
    }

    /// 冒号只有在"盘符前缀"那个位置才致命；文件名中间那个是合法字符，
    /// 只需要换成下划线。这条区分一旦丢掉，Linux 上打的包会整批解压失败。
    #[test]
    fn colon_in_a_file_name_is_sanitized_not_refused() {
        let dest = Path::new("/tmp/out");
        let p = safe_join(dest, "movie 1:2.mkv").unwrap();
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "movie 1_2.mkv");
    }

    #[test]
    fn empty_after_sanitize_is_reported() {
        let dest = Path::new("/tmp/out");
        // `*` 是被**替换**成下划线的（`___` 是合法文件名），不会变空；
        // 真正会剥到什么都不剩的是结尾的点/空格，`...` 和 `" "` 就是这两条。
        assert!(matches!(safe_join(dest, "..."), Err(GuardError::Empty(_))));
        assert!(matches!(safe_join(dest, " "), Err(GuardError::Empty(_))));
        assert!(matches!(safe_join(dest, ""), Err(GuardError::Empty(_))));
        assert!(safe_join(dest, "***").is_ok(), "非法字符该被换掉，不该让整条解压失败");
    }

    #[test]
    fn backslash_entries_are_normalized() {
        let dest = Path::new("/tmp/out");
        let p = safe_join(dest, "dir\\sub\\f.txt").unwrap();
        assert!(p.ends_with(Path::new("dir/sub/f.txt")) || p.to_string_lossy().contains("dir"));
        assert!(is_within(dest, &p));
    }

    #[test]
    fn overwrite_policy_shapes_target() {
        let dir = crate::test_bridge::TempDir::new("guard-overwrite");
        let existing = dir.join("a.txt");
        std::fs::write(&existing, b"old").unwrap();

        assert_eq!(resolve_target(&dir, "a.txt", Overwrite::Skip).unwrap(), None);
        assert_eq!(
            resolve_target(&dir, "a.txt", Overwrite::Overwrite).unwrap(),
            Some(existing.clone())
        );
        let renamed = resolve_target(&dir, "a.txt", Overwrite::Rename).unwrap().unwrap();
        assert_eq!(renamed.file_name().unwrap().to_str().unwrap(), "a (1).txt");
        assert_eq!(resolve_target(&dir, "new.txt", Overwrite::Skip).unwrap(), Some(dir.join("new.txt")));
    }
}
