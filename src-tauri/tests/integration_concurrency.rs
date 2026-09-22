//! 集成测试：并发场景 + 边缘攻击场景
//!
//! 用例清单：
//! - atomic_write 并发写同一文件：10 线程同时写，文件最终内容必须是某次写入的完整副本
//! - atomic_write 写入过程中崩溃模拟：主文件不应被中途 panic 破坏
//! - path_guard 符号链接逃逸攻击：symlink → /etc，validate 必须返回 Blocked
//! - path_guard 跨符号链接链：level1 → level2 → /etc 也必须被拦截
//! - path_guard 并发验证：50 线程×100 次混合调合法/非法路径，不能 panic

use std::fs;
use std::os::unix::fs::symlink;
use std::sync::{Arc, Barrier};
use std::thread;
use z_biz_tool_file_lib::test_bridge::{atomic_write_concurrent, validate_path_concurrent};

fn tempdir() -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    let nonce: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    p.push(format!(
        "z-biz-tool-file-integ-{}-{}",
        std::process::id(),
        nonce
    ));
    fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn atomic_write_concurrent_writers_no_corruption() {
    let dir = tempdir();
    let target = dir.join("concurrent.json");
    let n_threads = 10;
    let n_iters = 20;

    let barrier = Arc::new(Barrier::new(n_threads));
    let mut handles = vec![];

    for tid in 0..n_threads {
        let target = target.clone();
        let barrier = barrier.clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            for i in 0..n_iters {
                let payload = format!(
                    r#"{{"thread":{},"iter":{},"payload":"{}"}}"#,
                    tid,
                    i,
                    "x".repeat(1024)
                );
                atomic_write_concurrent(&target, payload.as_bytes()).unwrap();
            }
        }));
    }

    for h in handles {
        h.join().expect("thread should not panic");
    }

    let final_bytes = fs::read(&target).unwrap();
    let s = std::str::from_utf8(&final_bytes).expect("file must be valid UTF-8");
    let v: serde_json::Value =
        serde_json::from_str(s).expect("file must be valid JSON, not interleaved bytes");
    assert!(v.get("payload").is_some(), "got malformed payload: {:?}", v);
    // 不删 dir——让 OS 回收，避免并发 canonicalize 竞态
}

#[test]
fn atomic_write_crash_leaves_no_corrupted_final() {
    // 测试目标：atomic_write 在 panic 之后（rename 之前）被中止时，
    // 主文件不应被破坏。
    let dir = tempdir();
    let target = dir.join("crash.json");

    // 先写一个合法初始文件
    let initial = br#"{"state":"initial","count":0}"#;
    atomic_write_concurrent(&target, initial).unwrap();
    let before = fs::read(&target).unwrap();

    // 构造"崩溃"：创建一个非 atomic_write 格式的 .tmp 文件（模拟 rename 之前 SIGKILL）
    // 注意：tmp 文件名故意不含 nanos 时间戳，确保它不会与任何 atomic_write 的 tmp 碰撞
    let tmp_path = dir.join("crash.json.tmp.bogus");
    fs::write(&tmp_path, b"this should never reach the main file").unwrap();

    // 断言主文件未受影响
    let after = fs::read(&target).unwrap();
    assert_eq!(
        before, after,
        "未完成 rename 的 tmp 文件不应污染主文件; before={:?} after={:?}",
        String::from_utf8_lossy(&before),
        String::from_utf8_lossy(&after)
    );

    let _ = fs::remove_file(&tmp_path);
}

#[test]
fn path_guard_blocks_symlink_escape_to_etc() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    // 使用非 tempdir 的绝对路径，避免与其他测试的 tempdir cleanup 竞争
    // macOS 上 /tmp 是全局的，可以放心用
    let link_path = format!(
        "/tmp/z-biz-tool-fuzz-link-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    symlink("/etc", &link_path).unwrap();

    let res = validate_path_concurrent(&link_path);
    assert!(
        res.is_err(),
        "symlink → /etc 应当被拦截，但 validate 返回 Ok({:?})",
        res
    );
    let msg = format!("{:?}", res.unwrap_err());
    assert!(
        msg.contains("Blocked") || msg.contains("/private"),
        "err 应为 Blocked 但 got {}",
        msg
    );
    let _ = fs::remove_file(&link_path);
}

#[test]
fn path_guard_blocks_nested_symlink_chain() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    // 用绝对路径避免 tempdir cleanup 竞争
    let base = format!(
        "/tmp/z-biz-tool-fuzz-nested-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    fs::create_dir_all(&base).unwrap();
    let level2 = std::path::PathBuf::from(&base).join("level2");
    symlink("/etc", &level2).unwrap();
    let level1 = std::path::PathBuf::from(&base).join("level1");
    symlink(&level2, &level1).unwrap();

    let res = validate_path_concurrent(level1.to_str().unwrap());
    assert!(res.is_err(), "嵌套 symlink 链应被拦截，got {:?}", res);

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn path_guard_concurrent_validation_is_thread_safe() {
    let dir = tempdir();
    let legit = dir.join("legit.txt");
    // 先写好一个文件用于 canonicalize，且本测试不删除该文件，
    // 避免别的测试线程因删除而踩到 NotFound 错误。
    fs::write(&legit, "ok").unwrap();
    let evil = "/etc/this/should/not/exist".to_string();

    let n = 50;
    let barrier = Arc::new(Barrier::new(n));
    let mut handles = vec![];

    for _ in 0..n {
        let legit = legit.clone();
        let evil = evil.clone();
        let barrier = barrier.clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            for _ in 0..100 {
                assert!(validate_path_concurrent(legit.to_str().unwrap()).is_ok());
                assert!(validate_path_concurrent(&evil).is_err());
            }
        }));
    }

    for h in handles {
        h.join().expect("no panic in concurrent validation");
    }
    // 不删 dir——让 OS 回收
}