//! 图片命令的**消费方侧**回归钉：本仓依赖的 cap-img 版本必须含那两条修复。
//!
//! 背景：本仓此前锁在 `cap-img = "0.1.0"`（crates.io 上的正式版），而那个版本有
//! 两条**外部输入直达**的崩溃：
//!
//! 1. **crop 的坐标 u32 溢出**
//!    旧判据是 `if x + w > img.width()`。`x` 来自调用方（本仓 `crop_image`
//!    把前端传的 x/y/w/h **原样透传**），不是内部常量。
//!    `x = u32::MAX、w = 4` ⇒ `x + w` 在 debug 下直接 panic
//!    （attempt to add with overflow），在 release 下回绕成 3 ⇒
//!    `3 > width` 为假 ⇒ **越界检查被绕过**。
//!
//! 2. **EXIF 的 IFD0 越界切片**
//!    旧判据只比了**起点** `if ifd0_offset >= data.len()`，没比要读的整个区间
//!    ⇒ `offset == len - 1` 时 `data[offset..offset + 2]` 越界 panic。
//!    而这个 offset 是**图片文件里的字节** ⇒ 任何人都能手搓一个 JPEG 触发；
//!    `get_image_info` 直接调 `cap_img::info`，调用方只当它是个坏文件。
//!
//! 两条都在 cap-img 0.3.0 修掉了（`checked_add` + 区间长度检查）。
//! 本文件在**消费方这一侧**把它们钉住：若有人把依赖降回 0.1.0/0.2.0，
//! 这两条会立刻红 —— 而不是等到某个用户拿畸形图片把进程带崩。
//!
//! 走的是**真实命令函数**（含 path_guard），不是直接调 cap-img：
//! 要钉的是「前端输入 → 命令层 → cap-img」这条完整路径。

use std::fs;
use z_biz_tool_file_lib::test_bridge::{call_crop_image, call_get_image_info, TempDir};

/// 造一张真 PNG。
fn png(dir: &TempDir, rel: &str) -> std::path::PathBuf {
    let p = dir.join(rel);
    image::DynamicImage::new_rgb8(8, 8).save(&p).unwrap();
    p
}

/// 在一张**真 JPEG** 里插一段给定的 TIFF 体（EXIF 段）。
///
/// 必须基于真图：`info` 会先用 image crate 解码，手搓的假 SOI 在解码那步
/// 就报错了，永远走不到 EXIF 分支 —— 那样这条用例就变成了「测解码失败」，
/// 看着绿，其实没碰到 EXIF 那段代码。
fn jpeg_with_tiff(dir: &TempDir, rel: &str, tiff: &[u8]) -> std::path::PathBuf {
    let base_path = dir.join("base.jpg");
    image::DynamicImage::new_rgb8(4, 4)
        .save(&base_path)
        .unwrap();
    let base = fs::read(&base_path).unwrap();

    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(b"Exif\0\0");
    body.extend_from_slice(tiff);
    // 段长把自身两字节算在内
    let seg = (body.len() + 2) as u16;

    // 跳过编码器自带的 APP0/APPn，插到它们之后、SOF 之前
    let mut pos = 2;
    while pos + 4 <= base.len() && base[pos] == 0xFF && (0xE0..=0xEF).contains(&base[pos + 1]) {
        let l = u16::from_be_bytes([base[pos + 2], base[pos + 3]]) as usize;
        pos += 2 + l;
    }
    let mut out = base[..pos].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&seg.to_be_bytes());
    out.extend_from_slice(&body);
    out.extend_from_slice(&base[pos..]);

    let p = dir.join(rel);
    fs::write(&p, out).unwrap();
    p
}

/// 裁剪坐标溢出必须**返回 Err**，不能 panic、也不能悄悄放行。
///
/// 回归锚点：cap-img 0.1.0/0.2.0 的判据是 `x + w > img.width()`。
/// `x = u32::MAX、w = 4` ⇒ debug 构建直接 panic（attempt to add with overflow），
/// release 构建回绕成 3 ⇒ `3 > 8` 为假 ⇒ **越界检查被绕过**。
/// 0.3.0 改用 `checked_add`，溢出与超范围走同一条错误出口。
///
/// 本仓 `crop_image` 把前端传的 x/y/w/h 原样透传给 cap-img，
/// 所以这条路径是**外部输入直达**的。
#[test]
fn crop_with_overflowing_coordinates_returns_error_instead_of_panicking() {
    let dir = TempDir::new("img-crop-ovf");
    let src = png(&dir, "a.png");
    let dest = dir.join("out.png");

    let res = call_crop_image(
        src.to_str().unwrap(),
        dest.to_str().unwrap(),
        u32::MAX,
        0,
        4,
        4,
    );

    assert!(
        res.is_err(),
        "坐标溢出必须返回 Err（而不是 panic / 悄悄放行），实得 {:?}",
        res
    );
    assert!(
        !dest.exists(),
        "失败时不能留下半成品文件，实得存在：{}",
        dest.display()
    );
}

/// 越界的 EXIF IFD0 偏移必须**读成空表**，不能 panic。
///
/// 回归锚点：cap-img 0.1.0/0.2.0 只判 `ifd0_offset >= data.len()`，
/// 于是 offset == len-1 时 `data[offset..offset+2]` 切片越界 panic ——
/// 一个畸形图片就能让 `get_image_info` 崩掉。
/// 0.3.0 改判 `ifd0_offset + 2 > data.len()`。
///
/// 「不 panic」本身就是断言：越界切片会直接把测试线程带崩。
#[test]
fn image_info_survives_exif_with_out_of_range_ifd_offset() {
    let dir = TempDir::new("img-exif-oob");
    // TIFF 体：MM + 0x002A + IFD0偏移(=8) + 1 字节 ⇒ 长度 9
    // offset(8) < len(9) 通过了旧检查，但 offset+2 = 10 > 9 ⇒ 越界
    let mut tiff: Vec<u8> = Vec::new();
    tiff.extend_from_slice(b"MM");
    tiff.extend_from_slice(&0x002Au16.to_be_bytes());
    tiff.extend_from_slice(&8u32.to_be_bytes());
    tiff.resize(9, 0);

    let src = jpeg_with_tiff(&dir, "a.jpg", &tiff);

    let res = call_get_image_info(src.to_str().unwrap());
    assert!(
        res.is_ok(),
        "越界 EXIF 必须读成空表而不是崩掉，实得 {:?}",
        res
    );
}

/// 正常图片仍要能读出信息 —— 钉住「上面的用例不是因为命令层坏了才通过的」。
#[test]
fn image_info_still_works_for_an_ordinary_png() {
    let dir = TempDir::new("img-info-ok");
    let src = png(&dir, "a.png");
    let res = call_get_image_info(src.to_str().unwrap());
    assert!(res.is_ok(), "正常 PNG 必须能读出信息，实得 {:?}", res);
}
