//! 第 5 轮 check：端到端命令函数 path_guard 横向覆盖
//!
//! 前端调用链路 audit 发现：原 P0-2 只给 delete_file + move_to_trash 加了 path_guard，
//! 但 copy_file / move_file / rename_file / create_file 完全无校验——
//! 这是横向的 P0 安全漏洞。
//!
//! 本测试验证真实命令函数在收到攻击路径时返回 Err，绝不执行破坏性操作。

use std::fs;
use std::io::Write;
use std::os::unix::fs::symlink;
use z_biz_tool_file_lib::test_bridge::{
    call_copy_file, call_create_file, call_delete_file, call_move_file, call_rename_file, TempDir,
};

/// 作用域结束即回收，不再往临时目录里堆垃圾
fn tempdir() -> TempDir {
    TempDir::new("commands")
}

#[test]
fn delete_file_rejects_etc() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let res = call_delete_file("/etc/passwd");
    let err = res.expect_err("delete_file /etc 应被拦截");
    eprintln!("actual err: {}", err);
    assert!(
        err.contains("系统保护") || err.contains("Blocked") || err.contains("拒绝"),
        "错误信息应表明被拦截，实际: {}",
        err
    );
}

#[test]
fn delete_file_rejects_symlink_to_etc() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let dir = tempdir();
    let link = dir.join("evil_link");
    symlink("/etc/passwd", &link).unwrap();

    let res = call_delete_file(link.to_str().unwrap());
    assert!(res.is_err(), "symlink → /etc/passwd 应被拦截");

}

#[test]
fn copy_file_rejects_blacklist_src() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let dir = tempdir();
    let dest = dir.join("dump");
    fs::create_dir_all(&dest).unwrap();

    let res = call_copy_file("/etc/passwd", dest.to_str().unwrap());
    assert!(
        res.is_err(),
        "copy_file 源为 /etc/passwd 应被拦截，但 got {:?}",
        res
    );
    assert!(!dest.join("passwd").exists(), "绝不能在 dest 下产生副本");

}

#[test]
fn move_file_rejects_blacklist_src() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let dir = tempdir();
    fs::create_dir_all(&dir).unwrap();

    let res = call_move_file("/etc/hosts", dir.to_str().unwrap());
    assert!(
        res.is_err(),
        "move_file 源为 /etc/hosts 应被拦截，但 got {:?}",
        res
    );
    assert!(std::path::Path::new("/etc/hosts").exists(), "/etc/hosts 必须原封不动");

}

#[test]
fn rename_file_rejects_blacklist() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let res = call_rename_file("/etc/hosts", "evil_hosts");
    assert!(
        res.is_err(),
        "rename_file /etc/hosts 应被拦截，但 got {:?}",
        res
    );
    assert!(
        std::path::Path::new("/etc/hosts").exists(),
        "/etc/hosts 必须原封不动"
    );
}

#[test]
fn create_file_rejects_blacklist_parent() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let res = call_create_file("/etc/pwned", Some("malicious".to_string()));
    assert!(
        res.is_err(),
        "create_file 到 /etc 应被拦截，但 got {:?}",
        res
    );
    assert!(!std::path::Path::new("/etc/pwned").exists());
}

#[test]
fn normal_paths_still_work() {
    let dir = tempdir();
    // 所有命令都走 path_guard canonicalize，必须用 canonical 路径，
    // 否则 macOS 上 /var/... -> /private/var/... 路径不一致导致 flake
    let canonical_dir = fs::canonicalize(&dir).unwrap();
    let f = canonical_dir.join("hello.txt");

    // create_file
    let res = call_create_file(f.to_str().unwrap(), Some("hi".to_string()));
    assert!(res.is_ok(), "合法路径 create_file 应正常执行：{:?}", res);
    assert_eq!(fs::read_to_string(&f).unwrap(), "hi");

    // copy_file
    let res2 = call_copy_file(f.to_str().unwrap(), canonical_dir.to_str().unwrap());
    assert!(res2.is_ok(), "合法路径 copy_file 应正常执行：{:?}", res2);
    // copy_file 返回 canonical 路径，断言返回值存在即可
    let ret = res2.unwrap();
    assert!(
        std::path::Path::new(&ret).exists(),
        "copy_file 返回路径应存在: {}",
        ret
    );

    // rename_file
    let res3 = call_rename_file(f.to_str().unwrap(), "renamed.txt");
    assert!(res3.is_ok(), "合法路径 rename_file 应正常执行：{:?}", res3);
    let ret = res3.unwrap();
    assert!(
        std::path::Path::new(&ret).exists(),
        "rename_file 返回路径应存在: {}",
        ret
    );

}

#[test]
fn extract_zip_rejects_blacklist_dest() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let dir = tempdir();
    let canonical_dir = fs::canonicalize(&dir).unwrap();
    let zip = canonical_dir.join("dummy.zip");
    // 构造一个合法 zip
    {
        let f = fs::File::create(&zip).unwrap();
        let mut zip_writer = zip::ZipWriter::new(f);
        zip_writer
            .start_file("hi.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip_writer.write_all(b"hello").unwrap();
        zip_writer.finish().unwrap();
    }

    let res = z_biz_tool_file_lib::test_bridge::call_extract_zip(
        zip.to_str().unwrap(),
        "/etc",
    );
    let err = res.expect_err("extract_zip 到 /etc 应被拦截");
    assert!(
        err.contains("系统保护") || err.contains("拒绝") || err.contains("Blocked"),
        "错误应表明拦截，实际: {}",
        err
    );
}

#[test]
fn extract_archive_rejects_blacklist_dest() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let dir = tempdir();
    // 用合法 zip 格式（而不是假 tar），确保 path_guard 拦截先于格式错误
    let zip = dir.join("dummy.zip");
    {
        let f = fs::File::create(&zip).unwrap();
        let mut zip_writer = zip::ZipWriter::new(f);
        zip_writer
            .start_file("hi.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip_writer.write_all(b"hello").unwrap();
        zip_writer.finish().unwrap();
    }

    let res = z_biz_tool_file_lib::test_bridge::call_extract_archive(
        zip.to_str().unwrap(),
        "/etc",
    );
    let err = res.expect_err("extract_archive 到 /etc 应被拦截");
    assert!(
        err.contains("系统保护") || err.contains("拒绝") || err.contains("Blocked"),
        "错误应表明拦截，实际: {}",
        err
    );

}

#[test]
fn secure_delete_file_rejects_blacklist() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let res = z_biz_tool_file_lib::test_bridge::call_secure_delete_file("/etc/passwd", Some(1));
    let err = res.expect_err("secure_delete_file /etc/passwd 应被拦截");
    assert!(
        err.contains("系统保护") || err.contains("拒绝") || err.contains("Blocked"),
        "实际: {}",
        err
    );
}

#[test]
fn set_file_permissions_rejects_blacklist() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let res = z_biz_tool_file_lib::test_bridge::call_set_file_permissions("/etc/passwd", 0o644);
    let err = res.expect_err("set_file_permissions /etc/passwd 应被拦截");
    assert!(
        err.contains("系统保护") || err.contains("拒绝") || err.contains("Blocked"),
        "实际: {}",
        err
    );
}

#[test]
fn read_file_content_rejects_blacklist() {
    if !std::path::Path::new("/etc/passwd").exists() {
        return;
    }
    let res = z_biz_tool_file_lib::test_bridge::call_read_file_content("/etc/passwd");
    let err = res.expect_err("read_file_content /etc/passwd 应被拦截");
    assert!(
        err.contains("系统保护") || err.contains("拒绝") || err.contains("Blocked"),
        "实际: {}",
        err
    );
}

#[test]
fn search_files_rejects_blacklist() {
    if !std::path::Path::new("/etc").exists() {
        return;
    }
    let res = z_biz_tool_file_lib::test_bridge::call_search_files("/etc", "passwd");
    let err = res.expect_err("search_files /etc 应被拦截");
    assert!(
        err.contains("系统保护") || err.contains("拒绝") || err.contains("Blocked"),
        "实际: {}",
        err
    );
}

#[test]
fn path_guard_blocks_url_encoded_paths() {
    // URL 编码 %2F = /，%70 = p，%77 = w — 验证 canonicalize 后仍被拦
    let cases = vec![
        "/etc/%70asswd",
        "/etc/pass%77d",
        "%2Fetc%2Fpasswd",
    ];
    for c in cases {
        let res = z_biz_tool_file_lib::test_bridge::validate_path_concurrent(c);
        assert!(
            res.is_err(),
            "URL 编码路径 '{}' 应被拦截，但 got Ok",
            c
        );
    }
}

#[test]
fn path_guard_blocks_null_byte_attack() {
    let cases = vec![
        "/etc/passwd\0",
        "/etc/passwd\0/etc",
    ];
    for c in cases {
        let res = z_biz_tool_file_lib::test_bridge::validate_path_concurrent(c);
        assert!(
            res.is_err(),
            "含空字节路径应被拦截，但 got Ok: {:?}",
            c
        );
    }
}

#[test]
fn path_guard_blocks_dot_traversal() {
    let cases = vec![
        "/etc/./passwd",
        "/etc/../etc/passwd",
        "/etc///passwd",
        "....//....//etc/passwd",
    ];
    for c in cases {
        let res = z_biz_tool_file_lib::test_bridge::validate_path_concurrent(c);
        assert!(
            res.is_err(),
            "路径穿越变种应被拦截，但 got Ok: {:?}",
            c
        );
    }
}

#[test]
fn path_guard_blocks_home_env_expand() {
    let cases = vec!["$HOME/../../etc/passwd", "~/.ssh/id_rsa"];
    for c in cases {
        let res = z_biz_tool_file_lib::test_bridge::validate_path_concurrent(c);
        assert!(
            res.is_err(),
            "环境变量展开路径应被拦截，但 got Ok: {:?}",
            c
        );
    }
}

#[test]
fn path_guard_blocks_extremely_long_path() {
    let long_path = "/a".repeat(10000);
    let res = z_biz_tool_file_lib::test_bridge::validate_path_concurrent(&long_path);
    assert!(
        res.is_err(),
        "超长路径应被拦截（文件系统无法创建），但 got Ok"
    );
}

#[test]
fn path_guard_blocks_file_protocol() {
    let res = z_biz_tool_file_lib::test_bridge::validate_path_concurrent("file:///etc/passwd");
    assert!(
        res.is_err(),
        "file:// URI 应被拦截，但 got Ok"
    );
}

/// copy_file 复制一个含自引用符号链接的目录：修复前 is_dir() 会跟随链接一路递归，
/// 测试进程直接栈溢出被 SIGSEGV 打挂；现在必须正常返回并把链接按链接还原。
#[test]
fn copy_dir_with_self_referential_symlink_terminates() {
    let dir = tempdir();
    let src = dir.join("pkg");
    fs::create_dir_all(src.join("nested")).unwrap();
    fs::write(src.join("a.txt"), b"hello").unwrap();
    symlink("..", src.join("nested").join("up")).unwrap();
    symlink(&src, src.join("self")).unwrap();

    let out = dir.join("out");
    fs::create_dir_all(&out).unwrap();
    let res = call_copy_file(src.to_str().unwrap(), out.to_str().unwrap());
    assert!(res.is_ok(), "复制应正常结束而不是递归爆栈: {:?}", res);

    let copied = out.join("pkg");
    assert_eq!(fs::read(copied.join("a.txt")).unwrap(), b"hello");
    let up = copied.join("nested").join("up");
    let meta = fs::symlink_metadata(&up).expect("链接应还原为链接，而不是被展开成真实目录");
    assert!(meta.file_type().is_symlink(), "up 必须仍然是符号链接");
    assert_eq!(fs::read_link(&up).unwrap(), std::path::Path::new(".."));
}
