//! 路径校验模块：统一拦截路径穿越、符号链接逃逸、关键系统目录删除。
//!
//! 用法：所有接受 `path` 参数的 `#[tauri::command]` 在入口处调用
//! `path_guard::validate(path)`，把用户提供的字符串解析为 canonical 路径，
//! 并验证它在允许范围内。返回 `Err(PathError)` 时上层直接中断操作。

use std::fmt;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum PathError {
    Empty,
    RelativePath,
    Blocked(String),
    Invalid(String),
}

impl fmt::Display for PathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathError::Empty => write!(f, "路径为空"),
            PathError::RelativePath => write!(f, "不允许相对路径或包含 .. 的相对段"),
            PathError::Blocked(p) => write!(f, "命中系统保护目录，禁止操作: {}", p),
            PathError::Invalid(p) => write!(f, "解析失败: {}", p),
        }
    }
}

impl std::error::Error for PathError {}

/// 默认黑名单：用户态应用不应改写这些位置。
/// macOS / Linux 上影响最大；Windows 上多数不存在，由 canonicalize 直接拒绝。
const BLOCKED_PREFIXES: &[&str] = &[
    "/", "/etc", "/usr", "/bin", "/sbin", "/var", "/System",
    "/Library", "/dev", "/proc", "/sys", "/boot",
    "/root", "/run",
];

/// macOS 上 `/private` 是 `/` 的别名，会被 canonicalize 加到所有系统路径前；
/// 但 `/private/var` `/private/tmp` 是用户可写的运行时目录，必须放行。
/// 显式列出真正需要屏蔽的 `/private` 子树。
const BLOCKED_PRIVATE_SUFFIXES: &[&str] = &[
    "/private/etc", "/private/usr", "/private/bin", "/private/sbin",
    "/private/System", "/private/Library", "/private/var/db",
    "/private/var/root", "/private/var/log", "/private/var/audit",
    "/private/var/at", "/private/var/audit", "/private/var/cron",
];

/// 拒绝任何祖先段等于这些名字的路径（用于阻断对 `~/.ssh`、`~/.gnupg` 的访问）。
const BLOCKED_ANCESTORS: &[&str] = &[
    ".ssh", ".gnupg", ".aws", ".kube", ".docker",
];

/// 校验 `raw_path`，返回 canonical 化的绝对路径。
///
/// 设计目标：
/// - 拒绝空字符串与相对路径（含 `..`）。
/// - 不要求路径必须存在（写入场景），但如果存在就 canonicalize 解析符号链接。
/// - 检查黑名单前缀与祖先段。
pub fn validate(raw_path: &str) -> Result<PathBuf, PathError> {
    if raw_path.is_empty() {
        return Err(PathError::Empty);
    }
    let p = Path::new(raw_path);
    if !p.is_absolute() {
        return Err(PathError::RelativePath);
    }
    // 任何 `..` 段说明用户在做路径穿越；统一拒绝
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(PathError::RelativePath);
    }

    // 父目录必须存在（canonicalize 要求全部父目录存在）；不存在时直接报 NotFound。
    // 对尚未创建的写入场景，调用方应使用 `validate_parent_dir`。
    let canonical = p.canonicalize().map_err(|e| {
        PathError::Invalid(format!("{} ({})", raw_path, e))
    })?;

    check_blocked(&canonical)?;
    Ok(canonical)
}

fn check_blocked(canonical: &Path) -> Result<(), PathError> {
    let s = canonical.to_string_lossy();
    for blocked in BLOCKED_PREFIXES {
        // 必须以 blocked 起头，且下一字符是路径分隔符（避免误判 /usr-local 这种合法目录）
        if s == *blocked {
            return Err(PathError::Blocked(blocked.to_string()));
        }
        if let Some(rest) = s.strip_prefix(blocked) {
            if rest.starts_with('/') {
                return Err(PathError::Blocked(blocked.to_string()));
            }
        }
    }
    // /private/<受保护子树> 额外屏蔽（macOS 别名层）
    if s.starts_with("/private/") {
        for blocked in BLOCKED_PRIVATE_SUFFIXES {
            if s == *blocked || s.starts_with(&format!("{}/", blocked)) {
                return Err(PathError::Blocked(blocked.to_string()));
            }
        }
    }
    // 按路径组件逐个精确比对。早先是拿 "/.ssh" 做子串匹配，
    // 会把 "~/.ssh-keys"、"~/.aws-tools" 这类正常目录一起误杀。
    for comp in canonical.components() {
        if let Component::Normal(name) = comp {
            let n = name.to_string_lossy();
            if BLOCKED_ANCESTORS.iter().any(|b| *b == n) {
                return Err(PathError::Blocked(format!("/{}", n)));
            }
        }
    }
    Ok(())
}

/// 校验"落点可能还不存在"的写入路径（新建文件、从回收站恢复等）。
///
/// `validate` 要求路径存在才能 canonicalize；若因此退化成"只校验最近的已存在祖先"，
/// `~/.ssh/config` 在 `.ssh` 还没被创建出来时就会被放行，紧接着的 `create_dir_all`
/// 反而替攻击者把敏感目录建好。这里把已存在前缀 canonicalize（照样拆穿符号链接），
/// 再拼回尚未存在的词法尾部，整体补一次黑名单检查。
pub fn validate_new_path(raw_path: &str) -> Result<PathBuf, PathError> {
    if raw_path.is_empty() {
        return Err(PathError::Empty);
    }
    let p = Path::new(raw_path);
    if !p.is_absolute() {
        return Err(PathError::RelativePath);
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(PathError::RelativePath);
    }
    // ancestors() 由深到浅：自身、父、祖父……
    let chain: Vec<&Path> = p.ancestors().collect();
    let idx = chain
        .iter()
        .position(|a| a.exists())
        .ok_or_else(|| PathError::Invalid(format!("{} (找不到已存在的上级目录)", raw_path)))?;
    let mut result = validate(&chain[idx].to_string_lossy())?;
    for seg in chain[..idx].iter().rev() {
        let name = seg
            .file_name()
            .ok_or_else(|| PathError::Invalid(format!("{}", seg.display())))?;
        result.push(name);
    }
    check_blocked(&result)?;
    Ok(result)
}

/// 命令入口用：读一个应当已经存在的路径。
///
/// 与直接 `validate` 相比省掉调用方各写一遍的 `exists()` 检查，也避免某个模块
/// 只记得校验存在性、忘了黑名单，导致 blocklist 形同虚设。
pub fn readable(raw: &str) -> Result<PathBuf, String> {
    let p = validate(raw).map_err(|e| e.to_string())?;
    if !p.exists() {
        return Err(format!("路径不存在: {}", raw));
    }
    Ok(p)
}

/// 命令入口用：写一个可能还不存在的落点（另存为、导出、生成缩略图…）。
pub fn writable(raw: &str) -> Result<PathBuf, String> {
    validate_new_path(raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reject_empty() {
        assert_eq!(validate(""), Err(PathError::Empty));
    }

    #[test]
    fn reject_relative() {
        assert_eq!(validate("foo/bar"), Err(PathError::RelativePath));
        assert_eq!(validate("./foo"), Err(PathError::RelativePath));
        assert_eq!(validate("../etc/passwd"), Err(PathError::RelativePath));
        assert_eq!(validate("/foo/../../etc"), Err(PathError::RelativePath));
    }

    #[test]
    fn reject_root() {
        // 在测试环境 / 必然存在
        let res = validate("/");
        assert!(matches!(res, Err(PathError::Blocked(_))), "got {:?}", res);
    }

    #[test]
    fn reject_etc_if_exists() {
        if Path::new("/etc").exists() {
            let res = validate("/etc/passwd");
            assert!(matches!(res, Err(PathError::Blocked(_))), "got {:?}", res);
        }
    }

    #[test]
    fn reject_new_path_through_missing_sensitive_dir() {
        // 敏感目录本身还不存在（干净 CI runner 上的 ~/.ssh）时也必须拦住，
        // 否则放行后紧跟的 create_dir_all 会替攻击者把目录建出来
        let fake_home = std::env::temp_dir().join("z-biz-tool-file-pg-home");
        let _ = fs::remove_dir_all(&fake_home);
        fs::create_dir_all(&fake_home).unwrap();
        assert!(!fake_home.join(".ssh").exists());
        for name in [".ssh/id_ed25519", ".aws/credentials", ".kube/config", ".docker/config.json"] {
            let bad = fake_home.join(name);
            let res = validate_new_path(&bad.to_string_lossy());
            assert!(
                matches!(res, Err(PathError::Blocked(_))),
                "{} 应被拒绝，实际 {:?}",
                name,
                res
            );
        }
        // 老实现用 "/.ssh" 做子串匹配，会把这种同前缀的正常目录一起误杀
        let ok = fake_home.join(".ssh-keys/id.pub");
        let res = validate_new_path(&ok.to_string_lossy());
        assert!(res.is_ok(), "同前缀的正常目录不该被拦，实际 {:?}", res);
        let _ = fs::remove_dir_all(&fake_home);
    }

    #[test]
    fn allow_new_path_with_missing_intermediate_dirs() {
        let dir = std::env::temp_dir().join("z-biz-tool-file-pg-new");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("a/b/new.txt");
        let res = validate_new_path(target.to_str().unwrap());
        assert!(res.is_ok(), "got {:?}", res);
        assert!(
            res.unwrap().to_string_lossy().ends_with("a/b/new.txt"),
            "未存在的尾部应原样接在 canonical 前缀之后"
        );
        // 相对路径与 .. 依旧一律拒绝
        assert_eq!(validate_new_path("a/b.txt"), Err(PathError::RelativePath));
        assert_eq!(validate_new_path("/tmp/a/../../etc"), Err(PathError::RelativePath));
        assert_eq!(validate_new_path(""), Err(PathError::Empty));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn validate_new_path_still_resolves_symlinked_prefix() {
        let dir = std::env::temp_dir().join("z-biz-tool-file-pg-link");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink("/etc", dir.join("link")).unwrap();
        let probe = dir.join("link").join("passwd");
        let res = validate_new_path(&probe.to_string_lossy());
        let _ = fs::remove_dir_all(&dir);
        assert!(
            matches!(res, Err(PathError::Blocked(_))),
            "已存在前缀里的符号链接必须被 canonicalize 拆穿，实际 {:?}",
            res
        );
    }

    #[test]
    fn allow_normal_tmp() {
        let dir = std::env::temp_dir();
        let f = dir.join("z-biz-tool-file-test.txt");
        let _ = fs::write(&f, "ok");
        let res = validate(f.to_str().unwrap());
        let _ = fs::remove_file(&f);
        assert!(res.is_ok(), "got {:?}", res);
    }

    #[test]
    fn reject_ssh_ancestor() {
        // 即便根路径本身合法，~/.ssh 也必须被拦
        if let Some(home) = dirs::home_dir() {
            let ssh_dir = home.join(".ssh");
            if ssh_dir.exists() {
                let target = ssh_dir.join("id_rsa");
                if target.exists() {
                    let res = validate(target.to_str().unwrap());
                    assert!(matches!(res, Err(PathError::Blocked(_))), "got {:?}", res);
                }
            }
        }
    }
}
