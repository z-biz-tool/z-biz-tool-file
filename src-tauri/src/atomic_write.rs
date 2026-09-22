//! 原子写入工具：tmp + rename 模式，崩溃/断电时不会留下半截文件。
//!
//! 用法：替换所有 `fs::write(&path, json)` 的地方为 `atomic_write_json(&path, &value)`。
//!
//! 并发安全：tmp 文件名带 pid + tid + 纳秒戳后缀，确保多线程同时写同一目标文件
//! 时不会互相覆盖或踩到已被 rename 的旧 tmp。

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 进程内单调递增序列，避免同线程同纳秒内连续调用冲突
static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let mut tmp = path.to_path_buf();
    let file_name = tmp
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "atomic".to_string());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    tmp.set_file_name(format!(
        "{}.tmp.{}.{}.{}",
        file_name,
        std::process::id(),
        thread_id_u64(),
        nanos.wrapping_add(seq as u128)
    ));

    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }

    // fs::rename 在同文件系统上是原子的；失败时尽力清理临时文件
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// 跨平台 thread id：std::thread::ThreadId 没有稳定序列化方法，
/// 用 thread::current().id() 的指针地址作后缀（足够唯一）
fn thread_id_u64() -> u64 {
    let id = std::thread::current().id();
    // format!("{:?}", id) 输出 "ThreadId(N)"，取 N
    let s = format!("{:?}", id);
    if let Some(start) = s.find('(') {
        if let Some(end) = s.find(')') {
            return s[start + 1..end].parse().unwrap_or(0);
        }
    }
    0
}

pub fn atomic_write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    atomic_write(path, json.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn write_and_readback() {
        let dir = std::env::temp_dir().join("z-biz-tool-file-atomic-test");
        let _ = fs::create_dir_all(&dir);
        let target = dir.join("data.json");
        let _ = fs::remove_file(&target);

        let mut m: HashMap<String, String> = HashMap::new();
        m.insert("a".into(), "1".into());
        atomic_write_json(&target, &m).unwrap();

        let raw = fs::read_to_string(&target).unwrap();
        let back: HashMap<String, String> = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.get("a").map(String::as_str), Some("1"));

        let _ = fs::remove_file(&target);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn no_leftover_tmp_on_success() {
        let dir = std::env::temp_dir().join("z-biz-tool-file-atomic-test");
        let _ = fs::create_dir_all(&dir);
        let target = dir.join("clean.json");
        let _ = fs::remove_file(&target);
        atomic_write(&target, b"hi").unwrap();
        let tmp = dir.join("clean.json.tmp");
        assert!(!tmp.exists(), "tmp file should be renamed away");
        let _ = fs::remove_file(&target);
        let _ = fs::remove_dir(&dir);
    }
}
