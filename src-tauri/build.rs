fn main() {
    tauri_build::build();
    expose_manifest_to_tests();
}

/// 把 Windows manifest 资源也送到**测试**二进制里。
///
/// `tauri-build` 底层走 `embed-resource`，它只发 `cargo:rustc-link-arg-bins=`，所以
/// `cargo test` 生成的 exe 里没有 manifest。没有 manifest 就加载 System32 的
/// comctl32 v5，而 muda / rfd 静态导入的 `TaskDialogIndirect` 只有 WinSxS 里的 v6 才导出，
/// 测试进程一个用例都跑不起来就以 0xc0000139（STATUS_ENTRYPOINT_NOT_FOUND）退出。
/// 正式的 app exe 有 manifest，不受影响——这也是为什么"能打包能跑，但 cargo test 全灭"。
///
/// 判断的是 **target** 而不是 `#[cfg(windows)]`：build script 跑在 host 上，
/// 用 cfg 会在"host 是 Windows、target 不是"的交叉编译里发出一条无效的链接参数。
///
/// 为什么不能图省事发一条全局 `cargo:rustc-link-arg=`：build script 的输出在同一个
/// (package, features, profile, target) 下是**共享**的，`cargo build` 和 `cargo test`
/// 拿到的是同一份，没法按命令区分。全局参数会同时打到 bin 上，而 bin 已经从
/// tauri-build 那儿收过一次 `resource.lib`，同一个文件被链两遍 →
/// `CVT1100 资源重复（VERSION, 1）` / `LNK1123`，连正常打包都编不过。
///
/// 于是分两条路：
/// - `tests/` 下的集成测试是 `TargetKind::Test`，`rustc-link-arg-tests` 正好覆盖；
/// - `cargo test --lib` 那个二进制在 cargo 眼里仍是 `TargetKind::Lib`（它按 kind 判定，
///   不看 `target.tested()`），`-tests` 到不了它。这里只把 OUT_DIR 放进搜索路径，
///   真正那句 `#[link(name = "resource")]` 写在 `lib.rs` 的 `cfg(test)` 里，
///   由单元测试构建自己带上——bin 编译的是 `cfg(test)` 关掉的 lib，收不到，也就不会重复。
fn expose_manifest_to_tests() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("windows") {
        return;
    }
    let Ok(out) = std::env::var("OUT_DIR") else {
        return;
    };
    let out = std::path::Path::new(&out);
    let res = out.join("resource.lib");
    if res.exists() {
        println!("cargo:rustc-link-arg-tests={}", res.display());
        println!("cargo:rustc-link-search=native={}", out.display());
    }
}
