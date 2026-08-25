use serde::{Deserialize, Serialize};
use std::path::Path;

/// EXIF 提取结果（精简版，按常见字段映射）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExifInfo {
    pub make: Option<String>,            // 相机制造商
    pub model: Option<String>,           // 相机型号
    pub date_time: Option<String>,       // 拍摄时间
    pub orientation: Option<String>,    // 方向
    pub exposure_time: Option<String>,  // 曝光时间
    pub f_number: Option<String>,        // 光圈
    pub iso: Option<String>,            // ISO
    pub focal_length: Option<String>,   // 焦距
    pub white_balance: Option<String>,
    pub flash: Option<String>,
    pub pixel_x_dimension: Option<u32>,
    pub pixel_y_dimension: Option<u32>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub altitude: Option<f64>,
    pub software: Option<String>,
    pub lens_make: Option<String>,
    pub lens_model: Option<String>,
}

/// 读取图片 EXIF
#[tauri::command]
pub fn read_exif(path: String) -> Result<ExifInfo, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["jpg", "jpeg", "tiff", "tif"].contains(&ext.as_str()) {
        return Err(format!("EXIF 主要存在于 JPEG/TIFF，.{} 不支持", ext));
    }

    let file = std::fs::File::open(p).map_err(|e| format!("打开失败: {}", e))?;
    let mut bufreader = std::io::BufReader::new(&file);
    let exifreader = exif::Reader::new();
    let exif = exifreader
        .read_from_container(&mut bufreader)
        .map_err(|e| format!("解析 EXIF 失败: {}", e))?;

    let field = |tag: exif::Tag| -> Option<String> {
        exif.get_field(tag, exif::In::PRIMARY)
            .map(|f| f.display_value().with_unit(&exif).to_string())
    };

    let str_field = |tag: exif::Tag| -> Option<String> {
        exif.get_field(tag, exif::In::PRIMARY)
            .and_then(|f| f.display_value().to_string().into())
    };

    let gps_lat = exif
        .get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)
        .and_then(|f| parse_gps_dms(f));
    let gps_lon = exif
        .get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY)
        .and_then(|f| parse_gps_dms(f));
    let gps_alt = exif
        .get_field(exif::Tag::GPSAltitude, exif::In::PRIMARY)
        .and_then(|f| match &f.value {
            exif::Value::Rational(v) => v.first().map(|r| r.num as f64 / r.denom as f64),
            exif::Value::Short(v) => v.first().map(|x| *x as f64),
            exif::Value::Long(v) => v.first().map(|x| *x as f64),
            _ => None,
        });

    Ok(ExifInfo {
        make: str_field(exif::Tag::Make),
        model: str_field(exif::Tag::Model),
        date_time: str_field(exif::Tag::DateTimeOriginal)
            .or_else(|| str_field(exif::Tag::DateTime)),
        orientation: str_field(exif::Tag::Orientation),
        exposure_time: field(exif::Tag::ExposureTime),
        f_number: field(exif::Tag::FNumber),
        iso: str_field(exif::Tag::PhotographicSensitivity),
        focal_length: field(exif::Tag::FocalLength),
        white_balance: str_field(exif::Tag::WhiteBalance),
        flash: str_field(exif::Tag::Flash),
        pixel_x_dimension: exif
            .get_field(exif::Tag::PixelXDimension, exif::In::PRIMARY)
            .and_then(|f| f.display_value().to_string().parse().ok()),
        pixel_y_dimension: exif
            .get_field(exif::Tag::PixelYDimension, exif::In::PRIMARY)
            .and_then(|f| f.display_value().to_string().parse().ok()),
        latitude: gps_lat,
        longitude: gps_lon,
        altitude: gps_alt,
        software: str_field(exif::Tag::Software),
        lens_make: str_field(exif::Tag::LensMake),
        lens_model: str_field(exif::Tag::LensModel),
    })
}

/// 把 EXIF 的 GPS DMS（度/分/秒）格式解析为十进制度
fn parse_gps_dms(field: &exif::Field) -> Option<f64> {
    // EXIF GPS 字段通常是 3 个 rational：[deg, min, sec]
    let parts: Vec<f64> = match &field.value {
        exif::Value::Rational(v) => v
            .iter()
            .take(3)
            .map(|r| r.num as f64 / r.denom as f64)
            .collect(),
        _ => return None,
    };
    if parts.len() < 3 {
        return None;
    }
    Some(parts[0] + parts[1] / 60.0 + parts[2] / 3600.0)
}
