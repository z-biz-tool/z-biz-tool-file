//! 动手之前的落位检查：哪些名字已经被占了，以及目标目录是不是就在源自己肚子里。
//!
//! `move_file` / `copy_file` 早就支持 `conflict` 策略（保留两者 / 替换 / 跳过），
//! 但要给用户选择，得先知道会不会撞名 —— 不能让前端猜。
//!
//! 占用判定与 commands.rs 的 `dest_occupied` 同口径：用 `symlink_metadata` 而不是
//! `exists()`。指向丢失文件的悬空符号链接 `exists()` 会说"没有"，随后按同名写进去
//! 就会顺着那条链接把内容写到链接指向的真实位置 —— 那是另一次覆盖，只不过用户没同意。
//! 两处规则必须一起改，否则"探测说没有、写入说有"会让对话框形同虚设。

use std::fs;
use std::path::Path;

/// 单条文件名的形状检查：只要一个路径分量，别让探测越出目标目录。
/// 传进来的都是 `file_name()` 级别的字符串，出现分隔符就说明调用方拼错了，
/// 而一条能被拼成 `../../etc/passwd` 的只读探测接口，等于给外面留了一个存在性探针。
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("文件名不能为空".to_string());
    }
    if name.contains('\0') {
        return Err(format!("文件名不合法: {:?}", name));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!("只接受单个文件名，不接受路径: {:?}", name));
    }
    if name == "." || name == ".." {
        return Err(format!("只接受单个文件名，不接受 {:?}", name));
    }
    Ok(())
}

fn occupied(dir: &Path, name: &str) -> bool {
    fs::symlink_metadata(dir.join(name)).is_ok()
}

/// 源自己的子树能不能当落点 —— 不能，一律拦下。
///
/// 把目录挪进它自己的子目录时 `rename` 会失败（macOS 上是 EINVAL），`move_file` 于是
/// 走进"跨卷回退"：先 `copy_dir_recursive` 再 `remove_dir_all(源)`。而回退的目的地就在
/// 源里面，递归每下一层都会看见上一层刚建出来的那份，实测 2 条目的夹具到 13 层还没收敛
/// （Rust 里再深就是栈溢出），并且回退分支最后会把源删掉 —— 半份副本 + 原件没了。
///
/// 两个入参必须是 `path_guard::validate` 出来的 canonical 路径：`..` 和软链接都能骗过
/// 字符串前缀比较，只有解析到同一个坐标系里 `starts_with` 才等价于"在内部"。
pub(crate) fn displacement_guard(src: &Path, dest_dir: &Path, verb: &str) -> Result<(), String> {
    if dest_dir.starts_with(src) {
        return Err(format!(
            "{}的目标目录在源{}内部（{} → {}）",
            verb,
            if src.is_dir() { "目录" } else { "路径" },
            src.display(),
            dest_dir.display()
        ));
    }
    Ok(())
}

/// 返回 `names` 里在 `dest_dir` 下已被占用的那些，顺序与入参一致。
/// 纯只读：不建、不改、不删任何东西。
#[tauri::command]
pub fn occupied_names(dest_dir: String, names: Vec<String>) -> Result<Vec<String>, String> {
    let dir = crate::path_guard::readable(&dest_dir)?;
    if !dir.is_dir() {
        return Err(format!("目标不是目录: {}", dest_dir));
    }
    for name in &names {
        check_name(name)?;
    }
    Ok(names
        .into_iter()
        .filter(|name| occupied(&dir, name))
        .collect())
}

/// 返回 `paths` 里仍然存在的那些（保持原顺序）。
///
/// 粘贴前要做这一步：剪贴板里的源在外部可能被删/挪走，挨个 `get_file_info` 一次一 IPC
/// 浪费，所以塞一条批量版；前端用它把"已经不在磁盘上"的源在真正动手之前剔掉，
/// 留下一两条原本就没了的，至少要给用户一句人话，而不是后端 `No such file or directory`。
///
/// 不走 path_guard：用户给的本来是"我之前看过的"，可能在外部消失了；探测接口对单条
/// 失败必须静默跳过（用 symlink_metadata，和 occupied_names 的存在性口径保持一致），
/// 整批不是事务。
#[tauri::command]
pub fn existing_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    Ok(paths
        .into_iter()
        .filter(|p| !p.is_empty() && fs::symlink_metadata(p).is_ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(dir: &Path, names: &[&str]) -> Result<Vec<String>, String> {
        occupied_names(
            dir.to_str().unwrap().to_string(),
            names.iter().map(|s| s.to_string()).collect(),
        )
    }

    #[test]
    fn reports_only_taken_names_in_input_order() {
        let dir = crate::test_bridge::TempDir::new("conflict-probe");
        fs::write(dir.join("a.txt"), b"x").unwrap();
        fs::write(dir.join("b.txt"), b"x").unwrap();
        fs::create_dir(dir.join("sub")).unwrap();

        // 目录同样算被占用：往里挪同名目录会撞，往它上面写更不行
        assert_eq!(
            probe(&dir, &["b.txt", "missing.txt", "sub", "a.txt"]).unwrap(),
            vec!["b.txt", "sub", "a.txt"]
        );
        assert_eq!(probe(&dir, &["none.txt"]).unwrap(), Vec::<String>::new());
        // 探测不该改变任何东西
        assert_eq!(fs::read(dir.join("a.txt")).unwrap(), b"x");
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_still_blocks_the_name() {
        let dir = crate::test_bridge::TempDir::new("conflict-sym");
        std::os::unix::fs::symlink(dir.join("nowhere"), dir.join("link")).unwrap();
        let link = dir.join("link");
        assert!(fs::metadata(&link).is_err(), "夹具得是悬空的才测得出差别");
        assert_eq!(probe(&dir, &["link"]).unwrap(), vec!["link"]);
    }

    #[test]
    fn names_that_carry_a_path_are_refused() {
        let dir = crate::test_bridge::TempDir::new("conflict-bad");
        fs::write(dir.join("a.txt"), b"x").unwrap();
        let outside = crate::test_bridge::TempDir::new("conflict-outside");
        fs::write(outside.join("secret"), b"x").unwrap();

        for bad in [
            "../conflict-bad/a.txt",
            "sub/a.txt",
            "sub\\a.txt",
            "/etc/passwd",
            "",
            ".",
            "..",
            "a\0b",
        ] {
            let err = probe(&dir, &[bad]).unwrap_err();
            assert!(
                err.contains("文件名") || err.contains("路径"),
                "{:?} 的错误说不通: {}",
                bad,
                err
            );
        }
        // 越界写法必须整体失败，而不是被悄悄丢掉后给出"没有冲突"的假答案
        assert!(probe(&dir, &["a.txt", "../../etc/passwd"]).is_err());
    }

    #[test]
    fn missing_or_sensitive_directory_is_refused() {
        let dir = crate::test_bridge::TempDir::new("conflict-dir");
        let missing = dir.join("nope");
        assert!(probe(&missing, &["a.txt"]).is_err());
        assert!(
            occupied_names("/Users/zifang/.ssh".to_string(), vec!["id_rsa".to_string()]).is_err(),
            "只读探测也要走黑名单，否则这就是个存在性探针"
        );
    }

    /// 前端 `src/utils/conflictChoice.tsx` 是把策略当**字符串**送进 `conflict` 参数的，
    /// 这条断言钉的是两侧共用的那个 JSON 形状：任何一侧改拼写、改大小写都会在这里炸，
    /// 而不是等到用户点「替换」结果悄悄走了默认的「保留两者」。
    #[test]
    fn the_json_the_frontend_sends_is_the_policy_the_backend_reads() {
        use crate::commands::ConflictPolicy;
        for (raw, want) in [
            ("\"rename\"", ConflictPolicy::Rename),
            ("\"overwrite\"", ConflictPolicy::Overwrite),
            ("\"skip\"", ConflictPolicy::Skip),
        ] {
            assert_eq!(serde_json::from_str::<ConflictPolicy>(raw).unwrap(), want);
        }
        assert!(serde_json::from_str::<ConflictPolicy>("\"Rename\"").is_err());
        assert!(serde_json::from_str::<ConflictPolicy>("\"keep_both\"").is_err());
    }

    /// 把目录挪进它自己的子树 —— 命令层必须直接拒绝，而且一个字节都不许动。
    ///
    /// 这条以前没有闸：`rename` 失败后落进"复制+删除"回退，回退的目的地又在源里面，
    /// 于是 `copy_dir_recursive` 无限自我递归；`move_file` 走到最后还会 `remove_dir_all(源)`。
    #[test]
    fn moving_into_your_own_subtree_is_refused_and_changes_nothing() {
        use crate::commands::{copy_file, move_file};
        let root = crate::test_bridge::TempDir::new("displace");
        let top = root.join("top");
        let mid = top.join("a");
        let deep = mid.join("b");
        fs::create_dir_all(deep.join("c")).unwrap();
        fs::write(mid.join("keep.txt"), b"keep me").unwrap();

        let src = top.to_str().unwrap().to_string();
        for dest_dir in [
            top.to_str().unwrap(),  // 挪进自己
            mid.to_str().unwrap(),  // 挪进直接子目录
            deep.to_str().unwrap(), // 挪进孙目录
        ] {
            let err = move_file(&src, dest_dir, None).unwrap_err();
            assert!(
                err.contains("移动") && err.contains("内部"),
                "移动 → {} 没被拦住: {}",
                dest_dir,
                err
            );
            let err = copy_file(&src, dest_dir, None).unwrap_err();
            assert!(
                err.contains("复制") && err.contains("内部"),
                "复制 → {} 没被拦住: {}",
                dest_dir,
                err
            );
        }
        // 拦下来不是"事后清理"：整棵子树必须原封不动
        assert_eq!(fs::read(mid.join("keep.txt")).unwrap(), b"keep me");
        assert_eq!(fs::read_dir(&deep).unwrap().count(), 1);
        assert!(deep.join("c").is_dir());
    }

    /// 闸不能顺手把正常操作也拦掉：挪到无关目录、以及"原地"操作自己所在的目录，
    /// 这两种情况在真实使用中都会出现（后者由同名策略负责，不该报"在源内部"）。
    #[test]
    fn legitimate_destinations_still_pass() {
        use crate::commands::{copy_file, move_file, ConflictPolicy};
        let root = crate::test_bridge::TempDir::new("displace-ok");
        let a = root.join("a");
        let b = root.join("b");
        let nested = a.join("inner");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(nested.join("x.txt"), b"x").unwrap();
        fs::write(a.join("f.txt"), b"f").unwrap();

        // 目录 → 完全无关的目录
        move_file(
            nested.to_str().unwrap(),
            b.to_str().unwrap(),
            Some(ConflictPolicy::Rename),
        )
        .unwrap();
        assert!(b.join("inner").join("x.txt").is_file());
        assert!(!nested.exists());

        // 文件挪进它自己所在的目录：不是"在源内部"，交给同名策略处理成副本
        let dup = copy_file(
            a.join("f.txt").to_str().unwrap(),
            a.to_str().unwrap(),
            Some(ConflictPolicy::Rename),
        )
        .unwrap();
        assert_eq!(Path::new(&dup).file_name().unwrap(), "f 副本.txt");
        assert_eq!(fs::read(a.join("f.txt")).unwrap(), b"f");
    }

    /// 粘贴前的源存在性探测：返回已存在的子集，顺序与入参一致，
    /// 删除/不存在的项必须被静默跳过（接口对单条失败不该炸整批）。
    #[test]
    fn existing_paths_returns_only_what_is_still_there() {
        let dir = crate::test_bridge::TempDir::new("existing-paths");
        let keep1 = dir.join("keep1.txt");
        let keep2 = dir.join("keep2.txt");
        let gone = dir.join("gone.txt");
        fs::write(&keep1, b"x").unwrap();
        fs::write(&keep2, b"x").unwrap();
        fs::write(&gone, b"x").unwrap();
        // 模拟"复制完后在外面删了 gone"
        fs::remove_file(&gone).unwrap();

        let res = existing_paths(vec![
            keep1.to_string_lossy().to_string(),
            gone.to_string_lossy().to_string(),
            keep2.to_string_lossy().to_string(),
        ])
        .unwrap();
        // 顺序保持：keep1 在前，gone 跳过，keep2 紧随其后
        assert_eq!(
            res,
            vec![keep1.to_string_lossy().to_string(), keep2.to_string_lossy().to_string()]
        );
    }

    #[test]
    fn existing_paths_skips_empty_and_does_not_explode() {
        // 空串不是路径，挪到 normPath 会变成 "/"（frontend 那一道闸），
        // 后端这里直接当作不存在跳过
        let res = existing_paths(vec!["".to_string(), "/nonexistent/a".to_string()]).unwrap();
        assert!(res.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn existing_paths_treats_dangling_symlinks_as_existing() {
        // 口径必须和 occupied_names 一致：悬空符号链接 symlink_metadata 仍返回 Ok，
        // 算"存在"，前端才能决定要不要让用户去覆盖它，而不是把它当成已删
        let dir = crate::test_bridge::TempDir::new("existing-sym");
        let link = dir.join("dangling");
        std::os::unix::fs::symlink(dir.join("nowhere"), &link).unwrap();
        let res = existing_paths(vec![link.to_string_lossy().to_string()]).unwrap();
        assert_eq!(res, vec![link.to_string_lossy().to_string()]);
    }
}
