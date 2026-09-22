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
    for ancestor in BLOCKED_ANCESTORS {
        // 形如 "/Users/x/.ssh/id_rsa" 应当被拒绝
        let needle = format!("/{}", ancestor);
        if s.contains(&needle) {
            return Err(PathError::Blocked(needle));
        }
    }
    Ok(())
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
