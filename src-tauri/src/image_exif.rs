//! EXIF 读取 —— 能力层薄封装。
//!
//! 全部实现已在 cap-img 0.4.0（EXIF 全量读写）：类型化值、按 IFD 分桶、
//! GPS DMS→十进制度、写回保留未知 tag、字节级复制不动像素。
//! 本仓不再私藏一份解析器。
//!
//! 保留的是 file 仓自己的**展示语义**（把散落在各 IFD 的字段组合成一个
//! `ExifInfo` 平铺结构，给预览面板直接渲染）。映射逻辑属于本仓业务层，
//! 不下沉能力层 —— 能力层只负责「把 EXIF 完整、忠实地读出来」。

use serde::{Deserialize, Serialize};

/// EXIF 提取结果（按常见字段映射，给预览面板直接渲染）
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ExifInfo {
    pub make: Option<String>,          // 相机制造商
    pub model: Option<String>,         // 相机型号
    pub date_time: Option<String>,     // 拍摄时间
    pub orientation: Option<String>,   // 方向
    pub exposure_time: Option<String>, // 曝光时间
    pub f_number: Option<String>,      // 光圈
    pub iso: Option<String>,           // ISO
    pub focal_length: Option<String>,  // 焦距
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
    let p = crate::path_guard::readable(&path)?;
    read_exif_at(&p)
}

/// 内部实现：不做路径守卫（守卫属于命令层），供测试与其他模块复用。
pub fn read_exif_at(path: &std::path::Path) -> Result<ExifInfo, String> {
    // 「没有 EXIF」不是错误 —— 大量普通图片本就没有，返回全 None。
    let data = cap_img::exif::read(path)?.unwrap_or_default();

    // Rational 承载为 "num/den" 字符串，直接展示（1/250 这类快门值正是人类读法）。
    // 旧实现走 display_value().with_unit()，会带出 " sec" 之类的单位尾巴；
    // 现在前端自己负责语境（快门/光圈标签已经说明了单位），取纯值更干净。
    let disp = |name: &str| data.display(name).map(|s| s.to_string());

    let dimension = |name: &str| -> Option<u32> {
        data.value(name)
            .and_then(|v| v.split_whitespace().next().and_then(|s| s.parse().ok()))
    };

    Ok(ExifInfo {
        make: disp("Make"),
        model: disp("Model"),
        date_time: disp("DateTimeOriginal").or_else(|| disp("DateTime")),
        orientation: disp("Orientation"),
        exposure_time: disp("ExposureTime"),
        f_number: disp("FNumber"),
        iso: disp("ISOSpeed").or_else(|| disp("ISO")),
        focal_length: disp("FocalLength"),
        white_balance: disp("WhiteBalance"),
        flash: disp("Flash"),
        pixel_x_dimension: dimension("PixelXDimension"),
        pixel_y_dimension: dimension("PixelYDimension"),
        latitude: data.gps_coordinates().map(|(lat, _)| lat),
        longitude: data.gps_coordinates().map(|(_, lon)| lon),
        altitude: disp("GPSAltitude").and_then(|v| {
            // "12/1 m" 或 "12 m" 这类展示值里取数字；Rational 值兜底
            v.split_whitespace().next().and_then(|s| {
                s.split_once('/')
                    .map(|(n, d)| {
                        let n: f64 = n.parse().ok()?;
                        let d: f64 = d.parse().ok()?;
                        if d == 0.0 {
                            None
                        } else {
                            Some(n / d)
                        }
                    })
                    .unwrap_or_else(|| s.parse().ok())
            })
        }),
        software: disp("Software"),
        lens_make: disp("LensMake"),
        lens_model: disp("LensModel"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_img::exif::{ExifEdit, ExifField, ExifValue, ExifValueKind};

    /// 造一张带 EXIF 的 JPEG：用 cap-img 自己的 `write` 注入 —— 自洽闭环，
    /// 不给本仓加 kamadak-exif 依赖（解析器在能力层，测试桩也走能力层）。
    fn jpeg_with_exif(dir: &std::path::Path) -> std::path::PathBuf {
        let src = dir.join("shot.jpg");
        let dest = dir.join("with_exif.jpg");
        image::DynamicImage::new_rgb8(2, 2)
            .to_rgb8()
            .save_with_format(&src, image::ImageFormat::Jpeg)
            .unwrap();

        let field =
            |name: &str, tag: u32, kind: ExifValueKind, display: &str, values: Vec<ExifValue>| {
                ExifField {
                    name: name.to_string(),
                    tag,
                    kind,
                    display: display.to_string(),
                    values,
                }
            };
        let edit = ExifEdit {
            set: vec![
                field(
                    "Make",
                    0x010f,
                    ExifValueKind::Ascii,
                    "TestMake",
                    vec![ExifValue::Text("TestMake".into())],
                ),
                field(
                    "Model",
                    0x0110,
                    ExifValueKind::Ascii,
                    "TestModel",
                    vec![ExifValue::Text("TestModel".into())],
                ),
                // GPS 纬度 DMS 三段：39°54'0" N（Ref 缺省按北纬处理）
                field(
                    "GPSLatitude",
                    0x0002,
                    ExifValueKind::Rational,
                    "39/1 54/1 0/1",
                    vec![
                        ExifValue::Rational("39/1".into()),
                        ExifValue::Rational("54/1".into()),
                        ExifValue::Rational("0/1".into()),
                    ],
                ),
                // 经纬度必须成对：gps_coordinates() 单边返回 None（语义如此）
                field(
                    "GPSLongitude",
                    0x0004,
                    ExifValueKind::Rational,
                    "116/1 23/1 0/1",
                    vec![
                        ExifValue::Rational("116/1".into()),
                        ExifValue::Rational("23/1".into()),
                        ExifValue::Rational("0/1".into()),
                    ],
                ),
            ],
            remove: vec![],
        };
        cap_img::exif::write(&src, &dest, &edit).unwrap();
        dest
    }

    #[test]
    fn 读取相机与型号() {
        let dir = std::env::temp_dir().join(format!("file-exif-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = jpeg_with_exif(&dir);
        let info = read_exif_at(&path).unwrap();
        assert_eq!(info.make.as_deref(), Some("TestMake"));
        assert_eq!(info.model.as_deref(), Some("TestModel"));
        // GPS DMS → 十进制度：39°54' = 39.9，116°23' ≈ 116.383333
        let (lat, lon) = info.latitude.zip(info.longitude).expect("应解析出经纬度");
        assert!((lat - 39.9).abs() < 1e-9, "纬度应为 39.9，实际 {lat}");
        assert!(
            (lon - 116.3833).abs() < 1e-3,
            "经度应为 116.3833，实际 {lon}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 普通图片返回全_none_而不是错误() {
        let dir = std::env::temp_dir().join(format!("file-exif-plain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("plain.jpg");
        image::DynamicImage::new_rgb8(2, 2)
            .to_rgb8()
            .save_with_format(&path, image::ImageFormat::Jpeg)
            .unwrap();
        let info = read_exif_at(&path).unwrap();
        assert_eq!(info, ExifInfo::default());
        std::fs::remove_dir_all(&dir).ok();
    }
}
