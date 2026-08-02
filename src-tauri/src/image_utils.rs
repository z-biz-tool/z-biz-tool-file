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
}

/// 获取图片信息
#[tauri::command]
pub fn get_image_info(path: &str) -> Result<ImageInfo, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let metadata = fs::metadata(file_path).map_err(|e| format!("读取元数据失败: {}", e))?;
    let size = metadata.len();

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let (width, height) = img.dimensions();

    let format = detect_image_format(file_path);

    Ok(ImageInfo {
        width,
        height,
        format,
        size,
    })
}

/// 导出图片为指定格式
#[tauri::command]
pub fn export_image(
    path: &str,
    dest_path: &str,
    format: &str,
    quality: u8,
) -> Result<(), String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("源文件不存在: {}", path));
    }

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let dest = Path::new(dest_path);

    // 确保目标目录存在
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
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("源文件不存在: {}", path));
    }

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let resized = img.resize(width, height, image::imageops::FilterType::Lanczos3);

    let dest = Path::new(dest_path);
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
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("源文件不存在: {}", path));
    }

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let rotated = match degrees {
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => return Err(format!("不支持的角度: {}，仅支持 90/180/270", degrees)),
    };

    let dest = Path::new(dest_path);
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
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("源文件不存在: {}", path));
    }

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let flipped = if horizontal {
        img.fliph()
    } else {
        img.flipv()
    };

    let dest = Path::new(dest_path);
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
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("源文件不存在: {}", path));
    }

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

    let dest = Path::new(dest_path);
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
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("源文件不存在: {}", path));
    }

    let img = image::open(file_path).map_err(|e| format!("打开图片失败: {}", e))?;
    let filtered = apply_filter_impl(&img, filter_name)?;

    let dest = Path::new(dest_path);
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
