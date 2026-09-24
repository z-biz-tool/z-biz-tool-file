//! 图片命令薄壳：安全策略（path_guard）留在本仓，图像处理委托 `cap-img`。
//!
//! 矩阵规划 03 §4.3/§8 第 2 步：实现已整体搬进 z-biz-tool-capability，
//! 本文件只剩"先过闸、再委托"这一层；行为与前端 invoke 契约保持不变。

use cap_img::{ImageInfo, ImageThumbnail};

/// 图片信息（字段与 cap_img::ImageInfo 一致，前端契约不变）
#[tauri::command]
pub fn get_image_info(path: &str) -> Result<ImageInfo, String> {
    let file_path = crate::path_guard::readable(path)?;
    cap_img::info(file_path)
}

/// 保存 base64 编码的数据到文件
#[tauri::command]
pub fn save_image_data(data: String, dest_path: String, format: String) -> Result<u64, String> {
    // 这是一条"任意字节写到任意路径"的通道：必须过黑名单，否则整个 path_guard
    // 层等于给渲染进程留了后门（~/.ssh/authorized_keys、~/Library/LaunchAgents 等）
    let dest = crate::path_guard::writable(&dest_path)?;
    cap_img::save_bytes(&data, dest, &format)
}

/// 生成图片缩略图，返回 base64 编码的 PNG
#[tauri::command]
pub fn get_image_thumbnail(path: &str, max_size: u32) -> Result<ImageThumbnail, String> {
    let file_path = crate::path_guard::readable(path)?;
    cap_img::thumbnail(file_path, max_size)
}

/// 导出图片为指定格式
#[tauri::command]
pub fn export_image(
    path: &str,
    dest_path: &str,
    format: &str,
    quality: u8,
) -> Result<(), String> {
    let file_path = crate::path_guard::readable(path)?;
    // 先校验再建目录：反过来会替调用方把 .ssh 这类敏感目录凭空创建出来
    let dest = crate::path_guard::writable(dest_path)?;
    cap_img::export(file_path, dest, format, quality)
}

/// 缩放图片
#[tauri::command]
pub fn resize_image(path: &str, dest_path: &str, width: u32, height: u32) -> Result<(), String> {
    let file_path = crate::path_guard::readable(path)?;
    let dest = crate::path_guard::writable(dest_path)?;
    cap_img::resize(file_path, dest, width, height)
}

/// 旋转图片
#[tauri::command]
pub fn rotate_image(path: &str, dest_path: &str, degrees: u32) -> Result<(), String> {
    let file_path = crate::path_guard::readable(path)?;
    let dest = crate::path_guard::writable(dest_path)?;
    cap_img::rotate(file_path, dest, degrees)
}

/// 翻转图片
#[tauri::command]
pub fn flip_image(path: &str, dest_path: &str, horizontal: bool) -> Result<(), String> {
    let file_path = crate::path_guard::readable(path)?;
    let dest = crate::path_guard::writable(dest_path)?;
    cap_img::flip(file_path, dest, horizontal)
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
    let file_path = crate::path_guard::readable(path)?;
    let dest = crate::path_guard::writable(dest_path)?;
    cap_img::crop(file_path, dest, x, y, w, h)
}

/// 应用滤镜
#[tauri::command]
pub fn apply_filter(path: &str, dest_path: &str, filter_name: &str) -> Result<(), String> {
    let file_path = crate::path_guard::readable(path)?;
    let dest = crate::path_guard::writable(dest_path)?;
    cap_img::apply_filter(file_path, dest, filter_name)
}