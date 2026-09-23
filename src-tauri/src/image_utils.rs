use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// 图片信息
#[derive(Debug, Serialize, Deserialize)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub size: u64,
    pub has_alpha: bool,
    pub exif: Option<std::collections::HashMap<String, String>>,
}

/// 获取图片信息
#[tauri::command]
pub fn get_image_info(path: &str) -> Result<ImageInfo, String> {
    let file_path = &crate::path_guard::readable(path)?;

    let metadata = fs::metadata(file_path).map_err(|e| format!("读取元数据失败: {}", e))?;
    let size = metadata.len();

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let (width, height) = img.dimensions();
    let has_alpha = img.color().has_alpha();

    let format = detect_image_format(file_path);

    // 尝试读取 EXIF（JPEG / TIFF）。注意 detect_image_format 返回的是小写扩展名，
    // 早先这里比的是 "JPEG"/"TIFF"，分支永远走不到 —— 属性面板因此从不显示 EXIF。
    let exif = if matches!(format.as_str(), "jpg" | "tiff") {
        read_basic_exif(file_path)
    } else {
        None
    };

    Ok(ImageInfo {
        width,
        height,
        format,
        size,
        has_alpha,
        exif,
    })
}

/// 简单 EXIF 解析（只取几个常用 tag）
fn read_basic_exif(path: &Path) -> Option<std::collections::HashMap<String, String>> {
    let bytes = fs::read(path).ok()?;
    // JPEG: APP1 段 (0xFFE1) + "Exif\0\0" 签名
    if bytes.len() < 14 || &bytes[0..2] != b"\xff\xd8" {
        return None;
    }
    let mut i = 2;
    while i + 4 < bytes.len() {
        if bytes[i] != 0xff {
            return None;
        }
        let marker = bytes[i + 1];
        let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if marker == 0xe1 && &bytes[i + 4..i + 10] == b"Exif\0\0" {
            // 找到 EXIF 段
            return Some(parse_exif_minimal(&bytes[i + 10..i + 2 + seg_len]));
        }
        if marker == 0xda {
            // 图像数据开始，停止
            return None;
        }
        i += 2 + seg_len;
    }
    None
}

fn parse_exif_minimal(data: &[u8]) -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    let mut map = HashMap::new();
    if data.len() < 8 {
        return map;
    }
    let little_endian = matches!(data[0], b'I');
    let read_u16 = |d: &[u8]| -> u16 {
        if little_endian {
            u16::from_le_bytes([d[0], d[1]])
        } else {
            u16::from_be_bytes([d[0], d[1]])
        }
    };
    let read_u32 = |d: &[u8]| -> u32 {
        if little_endian {
            u32::from_le_bytes([d[0], d[1], d[2], d[3]])
        } else {
            u32::from_be_bytes([d[0], d[1], d[2], d[3]])
        }
    };

    let ifd0_offset = read_u32(&data[4..8]) as usize;
    if ifd0_offset >= data.len() {
        return map;
    }
    let ifd0_count = read_u16(&data[ifd0_offset..ifd0_offset + 2]) as usize;
    for i in 0..ifd0_count {
        let entry = ifd0_offset + 2 + i * 12;
        if entry + 12 > data.len() {
            break;
        }
        let tag = read_u16(&data[entry..entry + 2]);
        // 0x010F Make, 0x0110 Model, 0x0131 Software, 0x0132 DateTime, 0x8825 GPS
        let (name, val_offset) = match tag {
            0x010F => ("Make", read_u32(&data[entry + 8..entry + 12]) as usize),
            0x0110 => ("Model", read_u32(&data[entry + 8..entry + 12]) as usize),
            0x0131 => ("Software", read_u32(&data[entry + 8..entry + 12]) as usize),
            0x0132 => ("DateTime", read_u32(&data[entry + 8..entry + 12]) as usize),
            0x8298 => ("Copyright", read_u32(&data[entry + 8..entry + 12]) as usize),
            _ => continue,
        };
        // 简化：直接当 ASCII 字符串读
        if val_offset + 8 < data.len() {
            let s: String = data[val_offset..]
                .iter()
                .take_while(|&&b| b != 0)
                .map(|&b| b as char)
                .collect();
            map.insert(name.to_string(), s.trim().to_string());
        }
    }
    map
}

/// 保存 base64 编码的图像数据到文件
#[tauri::command]
pub fn save_image_data(data: String, dest_path: String, format: String) -> Result<u64, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("Base64 解码失败: {}", e))?;

    // 这是一条"任意字节写到任意路径"的通道：必须过黑名单，否则整个 path_guard
    // 层等于给渲染进程留了后门（~/.ssh/authorized_keys、~/Library/LaunchAgents 等）
    let dest = crate::path_guard::writable(&dest_path)?;
    // 前端按所选格式编码后再拼扩展名；两边不一致时写出来的文件是"名字说谎"
    let want = match format.to_ascii_lowercase().as_str() {
        "jpeg" => vec![".jpg".to_string(), ".jpeg".to_string()],
        other => vec![format!(".{}", other)],
    };
    let ext = dest
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default();
    if !want.contains(&ext) {
        return Err(format!(
            "目标扩展名与所选格式不符: {} vs {}",
            dest_path, format
        ));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&dest, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(bytes.len() as u64)
}

/// 缩略图结果（base64 编码的 PNG）
#[derive(Debug, Serialize, Deserialize)]
pub struct ImageThumbnail {
    pub data: String,    // base64 编码的 PNG
    pub width: u32,
    pub height: u32,
}

/// 生成图片缩略图，返回 base64 编码的 PNG
#[tauri::command]
pub fn get_image_thumbnail(path: &str, max_size: u32) -> Result<ImageThumbnail, String> {
    let file_path = &crate::path_guard::readable(path)?;

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;

    // 缩放图片以适应 max_size
    let size = if max_size == 0 { 200 } else { max_size };
    let thumb = img.thumbnail(size, size);

    let (width, height) = thumb.dimensions();

    // 编码为 PNG 到内存
    let mut buf: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    thumb
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| format!("编码缩略图失败: {}", e))?;

    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(&buf);

    Ok(ImageThumbnail { data, width, height })
}

/// 导出图片为指定格式
#[tauri::command]
pub fn export_image(
    path: &str,
    dest_path: &str,
    format: &str,
    quality: u8,
) -> Result<(), String> {
    let file_path = &crate::path_guard::readable(path)?;

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    // 先校验再建目录：反过来会替调用方把 .ssh 这类敏感目录凭空创建出来
    let dest = &crate::path_guard::writable(dest_path)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let image_format = parse_image_format(format)?;
    let quality = quality.clamp(1, 100);

    match image_format {
        ImageFormat::Jpeg => {
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
                fs::File::create(dest).map_err(|e| format!("创建文件失败: {}", e))?,
                quality,
            );
            encoder
                .encode(
                    img.to_rgb8().as_raw(),
                    img.width(),
                    img.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|e| format!("编码JPEG失败: {}", e))?;
        }
        _ => {
            img.save_with_format(dest, image_format)
                .map_err(|e| format!("保存图片失败: {}", e))?;
        }
    }

    Ok(())
}

/// 缩放图片
#[tauri::command]
pub fn resize_image(path: &str, dest_path: &str, width: u32, height: u32) -> Result<(), String> {
    let file_path = &crate::path_guard::readable(path)?;

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let resized = img.resize(width, height, image::imageops::FilterType::Lanczos3);

    // 先校验再建目录：反过来会替调用方把 .ssh 这类敏感目录凭空创建出来
    let dest = &crate::path_guard::writable(dest_path)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let format = detect_image_format(file_path);
    let image_format = parse_image_format(&format).unwrap_or(ImageFormat::Png);
    resized
        .save_with_format(dest, image_format)
        .map_err(|e| format!("保存图片失败: {}", e))?;

    Ok(())
}

/// 旋转图片
#[tauri::command]
pub fn rotate_image(path: &str, dest_path: &str, degrees: u32) -> Result<(), String> {
    let file_path = &crate::path_guard::readable(path)?;

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let rotated = match degrees {
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => return Err(format!("不支持的角度: {}，仅支持 90/180/270", degrees)),
    };

    // 先校验再建目录：反过来会替调用方把 .ssh 这类敏感目录凭空创建出来
    let dest = &crate::path_guard::writable(dest_path)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let format = detect_image_format(file_path);
    let image_format = parse_image_format(&format).unwrap_or(ImageFormat::Png);
    rotated
        .save_with_format(dest, image_format)
        .map_err(|e| format!("保存图片失败: {}", e))?;

    Ok(())
}

/// 翻转图片
#[tauri::command]
pub fn flip_image(path: &str, dest_path: &str, horizontal: bool) -> Result<(), String> {
    let file_path = &crate::path_guard::readable(path)?;

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let flipped = if horizontal {
        img.fliph()
    } else {
        img.flipv()
    };

    // 先校验再建目录：反过来会替调用方把 .ssh 这类敏感目录凭空创建出来
    let dest = &crate::path_guard::writable(dest_path)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let format = detect_image_format(file_path);
    let image_format = parse_image_format(&format).unwrap_or(ImageFormat::Png);
    flipped
        .save_with_format(dest, image_format)
        .map_err(|e| format!("保存图片失败: {}", e))?;

    Ok(())
}

/// 裁剪图片
#[tauri::command]
pub fn crop_image(
    path: &str,
    dest_path: &str,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    let file_path = &crate::path_guard::readable(path)?;

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;

    // 验证裁剪区域
    if x + w > img.width() || y + h > img.height() {
        return Err(format!(
            "裁剪区域超出图片范围: 图片{}x{}, 裁剪({},{})+{}x{}",
            img.width(),
            img.height(),
            x,
            y,
            w,
            h
        ));
    }

    let cropped = img.crop_imm(x, y, w, h);

    // 先校验再建目录：反过来会替调用方把 .ssh 这类敏感目录凭空创建出来
    let dest = &crate::path_guard::writable(dest_path)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let format = detect_image_format(file_path);
    let image_format = parse_image_format(&format).unwrap_or(ImageFormat::Png);
    cropped
        .save_with_format(dest, image_format)
        .map_err(|e| format!("保存图片失败: {}", e))?;

    Ok(())
}

/// 应用滤镜
#[tauri::command]
pub fn apply_filter(path: &str, dest_path: &str, filter_name: &str) -> Result<(), String> {
    let file_path = &crate::path_guard::readable(path)?;

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let filtered = apply_filter_impl(&img, filter_name)?;

    // 先校验再建目录：反过来会替调用方把 .ssh 这类敏感目录凭空创建出来
    let dest = &crate::path_guard::writable(dest_path)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let format = detect_image_format(file_path);
    let image_format = parse_image_format(&format).unwrap_or(ImageFormat::Png);
    filtered
        .save_with_format(dest, image_format)
        .map_err(|e| format!("保存图片失败: {}", e))?;

    Ok(())
}

/// 滤镜实现
fn apply_filter_impl(img: &DynamicImage, filter_name: &str) -> Result<DynamicImage, String> {
    match filter_name {
        "grayscale" => Ok(DynamicImage::ImageLuma8(img.to_luma8())),
        "sepia" => {
            let mut rgba = img.to_rgba8();
            for pixel in rgba.pixels_mut() {
                let r = pixel[0] as f32;
                let g = pixel[1] as f32;
                let b = pixel[2] as f32;
                // Sepia矩阵
                let new_r = (r * 0.393 + g * 0.769 + b * 0.189).min(255.0) as u8;
                let new_g = (r * 0.349 + g * 0.686 + b * 0.168).min(255.0) as u8;
                let new_b = (r * 0.272 + g * 0.534 + b * 0.131).min(255.0) as u8;
                pixel[0] = new_r;
                pixel[1] = new_g;
                pixel[2] = new_b;
            }
            Ok(DynamicImage::ImageRgba8(rgba))
        }
        "invert" => {
            let mut rgba = img.to_rgba8();
            for pixel in rgba.pixels_mut() {
                pixel[0] = 255 - pixel[0];
                pixel[1] = 255 - pixel[1];
                pixel[2] = 255 - pixel[2];
            }
            Ok(DynamicImage::ImageRgba8(rgba))
        }
        "brightness" => {
            let mut rgba = img.to_rgba8();
            for pixel in rgba.pixels_mut() {
                pixel[0] = (pixel[0] as f32 * 1.3).min(255.0) as u8;
                pixel[1] = (pixel[1] as f32 * 1.3).min(255.0) as u8;
                pixel[2] = (pixel[2] as f32 * 1.3).min(255.0) as u8;
            }
            Ok(DynamicImage::ImageRgba8(rgba))
        }
        "contrast" => {
            let mut rgba = img.to_rgba8();
            let factor: f32 = 1.5; // 对比度因子
            for pixel in rgba.pixels_mut() {
                pixel[0] = (factor * (pixel[0] as f32 - 128.0) + 128.0)
                    .clamp(0.0, 255.0) as u8;
                pixel[1] = (factor * (pixel[1] as f32 - 128.0) + 128.0)
                    .clamp(0.0, 255.0) as u8;
                pixel[2] = (factor * (pixel[2] as f32 - 128.0) + 128.0)
                    .clamp(0.0, 255.0) as u8;
            }
            Ok(DynamicImage::ImageRgba8(rgba))
        }
        "blur" => Ok(img.blur(3.0)),
        "sharpen" => {
            // 简单锐化: 先模糊再与原图混合
            let blurred = img.blur(1.0);
            let mut result = img.to_rgba8();
            let blurred_rgba = blurred.to_rgba8();
            let blurred_vec: Vec<_> = blurred_rgba.pixels().collect();
            for (i, pixel) in result.pixels_mut().enumerate() {
                if let Some(blurred_pixel) = blurred_vec.get(i) {
                    // Unsharp mask: original + (original - blurred) * amount
                    let amount: f32 = 1.5;
                    pixel[0] = (pixel[0] as f32 + (pixel[0] as f32 - blurred_pixel[0] as f32) * amount)
                        .clamp(0.0, 255.0) as u8;
                    pixel[1] = (pixel[1] as f32 + (pixel[1] as f32 - blurred_pixel[1] as f32) * amount)
                        .clamp(0.0, 255.0) as u8;
                    pixel[2] = (pixel[2] as f32 + (pixel[2] as f32 - blurred_pixel[2] as f32) * amount)
                        .clamp(0.0, 255.0) as u8;
                }
            }
            Ok(DynamicImage::ImageRgba8(result))
        }
        _ => Err(format!(
            "不支持的滤镜: {}，支持: grayscale/sepia/invert/brightness/contrast/blur/sharpen",
            filter_name
        )),
    }
}

/// 检测图片格式
fn detect_image_format(path: &Path) -> String {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "jpg" | "jpeg" => "jpg".to_string(),
        "png" => "png".to_string(),
        "gif" => "gif".to_string(),
        "bmp" => "bmp".to_string(),
        "webp" => "webp".to_string(),
        "ico" => "ico".to_string(),
        "tiff" | "tif" => "tiff".to_string(),
        _ => "png".to_string(), // 默认
    }
}

/// 解析图片格式字符串
fn parse_image_format(format: &str) -> Result<ImageFormat, String> {
    match format.to_lowercase().as_str() {
        "jpg" | "jpeg" => Ok(ImageFormat::Jpeg),
        "png" => Ok(ImageFormat::Png),
        "gif" => Ok(ImageFormat::Gif),
        "bmp" => Ok(ImageFormat::Bmp),
        "webp" => Ok(ImageFormat::WebP),
        "ico" => Ok(ImageFormat::Ico),
        "tiff" | "tif" => Ok(ImageFormat::Tiff),
        _ => Err(format!(
            "不支持的图片格式: {}，支持: jpg/png/gif/bmp/webp",
            format
        )),
    }
}

#[cfg(test)]
mod guard_tests {
    use super::*;
    use crate::test_bridge::TempDir;
    use std::path::PathBuf;

    /// 每个用例独享一个目录，作用域结束自动删除
    fn case(name: &str) -> TempDir {
        TempDir::new(&format!("img-{}", name))
    }

    /// 4x4 纯色 PNG，够小且 image crate 能真的解码
    fn png(dir: &Path, rel: &str) -> PathBuf {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        image::DynamicImage::new_rgb8(4, 4).save(&p).unwrap();
        p
    }

    #[test]
    fn image_info_still_reads_an_ordinary_file() {
        let dir = case("ok");
        let src = png(&dir, "a.png");
        let info = get_image_info(&src.to_string_lossy()).unwrap();
        assert_eq!((info.width, info.height), (4, 4));
        assert_eq!(info.format, "png");
    }

    /// 在一张真 JPEG 的段链里插一段 APP1/EXIF。
    /// 必须基于真图：`get_image_info` 会先用 image crate 解码，手搓的假 SOI 直接
    /// 在解码那步就报错，永远走不到 EXIF 分支。
    fn jpeg_with_exif(dir: &Path, rel: &str) -> PathBuf {
        let base_path = dir.join("base.jpg");
        image::DynamicImage::new_rgb8(4, 4).save(&base_path).unwrap();
        let base = fs::read(&base_path).unwrap();

        // IFD0 一条记录：Model(0x0110) -> 偏移 26 处的 "TEST"
        let mut tiff: Vec<u8> = Vec::new();
        tiff.extend_from_slice(b"MM"); // 大端
        tiff.extend_from_slice(&0x002Au16.to_be_bytes());
        tiff.extend_from_slice(&8u32.to_be_bytes()); // IFD0 从偏移 8 开始
        tiff.extend_from_slice(&1u16.to_be_bytes()); // 1 条记录
        tiff.extend_from_slice(&0x0110u16.to_be_bytes()); // tag = Model
        tiff.extend_from_slice(&2u16.to_be_bytes()); // type = ASCII
        tiff.extend_from_slice(&5u32.to_be_bytes()); // count
        tiff.extend_from_slice(&26u32.to_be_bytes()); // 值所在偏移
        tiff.extend_from_slice(&0u32.to_be_bytes()); // 下一个 IFD = 无
        tiff.extend_from_slice(b"TEST\0");
        while tiff.len() < 40 {
            tiff.push(0);
        }
        let mut body: Vec<u8> = Vec::new();
        body.extend_from_slice(b"Exif\0\0");
        body.extend_from_slice(&tiff);
        // 段长把自身两字节算在内
        let seg = (body.len() + 2) as u16;

        // 跳过编码器自带的 APP0/APPn，插到它们之后、SOF 之前
        let mut pos = 2;
        while pos + 4 <= base.len()
            && base[pos] == 0xFF
            && (0xE0..=0xEF).contains(&base[pos + 1])
        {
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

    #[test]
    fn image_info_actually_reads_exif_from_a_jpeg() {
        let dir = case("exif");
        let src = jpeg_with_exif(&dir, "a.jpg");
        let info = get_image_info(&src.to_string_lossy()).unwrap();
        let exif = info.exif.expect("JPEG 里的 EXIF 必须被读出来");
        assert_eq!(exif.get("Model").map(|s| s.as_str()), Some("TEST"));
    }

    #[test]
    fn image_info_refuses_blocked_source() {
        let dir = case("blocked-src");
        let secret = dir.join(".ssh").join("id.png");
        png(&dir, ".ssh/id.png");
        let err = get_image_info(&secret.to_string_lossy())
            .expect_err("黑名单内的图片不该被读出尺寸");
        assert!(err.contains("禁止操作"), "实得 {}", err);
    }

    #[test]
    fn resize_still_writes_and_creates_parent() {
        let dir = case("resize-ok");
        let src = png(&dir, "a.png");
        let dest = dir.join("out").join("small.png");
        resize_image(&src.to_string_lossy(), &dest.to_string_lossy(), 2, 2).unwrap();
        assert!(dest.exists());
        assert!(fs::metadata(&dest).unwrap().len() > 0);
    }

    #[test]
    fn resize_refuses_sensitive_destination() {
        let dir = case("resize-blocked");
        let src = png(&dir, "a.png");
        let dest = dir.join(".ssh").join("authorized_keys.png");
        let err = resize_image(&src.to_string_lossy(), &dest.to_string_lossy(), 2, 2)
            .expect_err("不该允许往 .ssh 里写");
        assert!(err.contains("禁止操作"), "实得 {}", err);
        // 关键：拒绝必须发生在 create_dir_all 之前，否则敏感目录被凭空建出来
        assert!(!dir.join(".ssh").exists());
    }

    #[test]
    fn every_write_command_rejects_a_relative_destination() {
        let dir = case("relative");
        let src = png(&dir, "a.png");
        let s = src.to_string_lossy().to_string();
        for (label, res) in [
            ("resize", resize_image(&s, "out.png", 2, 2).map(|_| ())),
            ("rotate", rotate_image(&s, "out.png", 90)),
            ("flip", flip_image(&s, "out.png", true)),
            ("crop", crop_image(&s, "out.png", 0, 0, 2, 2)),
            ("filter", apply_filter(&s, "out.png", "grayscale")),
            ("export", export_image(&s, "out.png", "png", 90)),
        ] {
            let err = res.expect_err(&format!("{} 不该接受相对路径", label));
            assert!(err.contains("相对路径"), "{}: 实得 {}", label, err);
        }
        assert!(!dir.join("out.png").exists());
    }

    #[test]
    fn save_image_data_still_writes_bytes() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let dir = case("save-ok");
        let dest = dir.join("sub").join("blob.bin");
        let n = save_image_data(
            STANDARD.encode(b"payload").to_string(),
            dest.to_string_lossy().to_string(),
            "bin".to_string(),
        )
        .unwrap();
        assert_eq!(n, 7);
        assert_eq!(fs::read(&dest).unwrap(), b"payload");
    }

    #[test]
    fn save_image_data_refuses_extension_format_mismatch() {
        // format 这个参数以前是被丢掉的：调用方说自己是 png、扩展名写 .jpg 也照写，
        // 于是磁盘上出现一个"名字说谎"的文件，双击打不开还不知道为什么
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let dir = case("save-format");
        let dest = dir.join("lie.jpg");
        let err = save_image_data(
            STANDARD.encode(b"pngbytes").to_string(),
            dest.to_string_lossy().to_string(),
            "png".to_string(),
        )
        .expect_err("扩展名与格式不符时必须拒绝");
        assert!(err.contains("格式不符"), "实得 {}", err);
        assert!(!dest.exists());
        // 大小写与 jpeg 别名不能把这条闸拦掉
        let ok = dir.join("real.jpeg");
        save_image_data(
            STANDARD.encode(b"pngbytes").to_string(),
            ok.to_string_lossy().to_string(),
            "JPEG".to_string(),
        )
        .unwrap();
        assert!(ok.exists());
    }

    #[test]
    fn save_image_data_refuses_sensitive_destination() {
        // 这条是"任意字节 → 任意路径"的通道，一旦放开就等于给渲染进程留后门：
        // ~/.ssh/authorized_keys、~/Library/LaunchAgents/*.plist 都能被写穿
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let dir = case("save-blocked");
        let dest = dir.join(".ssh").join("authorized_keys");
        let err = save_image_data(
            STANDARD.encode(b"ssh-rsa AAAA").to_string(),
            dest.to_string_lossy().to_string(),
            "bin".to_string(),
        )
        .expect_err("必须拒绝写进 .ssh");
        assert!(err.contains("禁止操作"), "实得 {}", err);
        assert!(!dir.join(".ssh").exists());
    }

    #[test]
    fn thumbnail_refuses_blocked_source() {
        let dir = case("thumb");
        let secret = png(&dir, ".gnupg/x.png");
        let err = get_image_thumbnail(&secret.to_string_lossy(), 64)
            .expect_err("缩略图不该读 .gnupg");
        assert!(err.contains("禁止操作"), "实得 {}", err);
    }
}
