//! 图片命令薄壳：安全策略（path_guard）留在本仓，图像处理委托 `cap-img`。
//!
//! 矩阵规划 03 §4.3/§8 第 2 步：实现已整体搬进 z-biz-tool-capability，
//! 本文件只剩"先过闸、再委托"这一层；行为与前端 invoke 契约保持不变。

use cap_img::{ImageInfo, ImageThumbnail};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

/// 缩略图缓存条目上限（张）
const MAX_THUMB_ENTRIES: usize = 512;
/// 缩略图缓存总量上限（字节，按序列化后的 base64 长度估算）
const MAX_THUMB_BYTES: usize = 24 * 1024 * 1024;
/// 超过这个体积的原图不做缩略图：一次 miss 的解码缓冲不可控
const MAX_THUMB_SOURCE_BYTES: u64 = 64 * 1024 * 1024;

fn estimated_size(value: &serde_json::Value) -> usize {
    value.to_string().len()
}

/// 手写定长 LRU：HashMap + 访问顺序队列 + 顺序戳（不引第三方 crate）。
/// 队列里会残留"已被更晚一次访问作废"的旧项，出队时按顺序戳跳过，
/// 所以淘汰循环同时负责清队列 —— 否则 order 只增不减，等于换个地方漏。
struct LruCache {
    entries: HashMap<String, (u64, serde_json::Value)>,
    order: VecDeque<(u64, String)>,
    stamp: u64,
    bytes: usize,
}

impl LruCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            stamp: 0,
            bytes: 0,
        }
    }

    fn get(&mut self, key: &str) -> Option<serde_json::Value> {
        let value = self.entries.get(key).map(|(_, v)| v.clone())?;
        self.touch(key);
        Some(value)
    }

    fn put(&mut self, key: &str, value: serde_json::Value) {
        if let Some((_, old)) = self.entries.get(key) {
            self.bytes = self.bytes.saturating_sub(estimated_size(old));
        }
        self.bytes += estimated_size(&value);
        self.entries.insert(key.to_string(), (0, value));
        self.touch(key);
        self.evict();
    }

    /// 顺序戳 +1 并把键挂到队尾：命中与写入都算"最近用过"
    fn touch(&mut self, key: &str) {
        self.stamp += 1;
        if let Some(slot) = self.entries.get_mut(key) {
            slot.0 = self.stamp;
        }
        self.order.push_back((self.stamp, key.to_string()));
        // 队列里堆积的全是被更晚访问作废的旧项；纯读负载下它们永远排不到队首，
        // 所以越过 2× 条目数就按新鲜度重建一次，order 才不会只增不减。
        if self.order.len() > self.entries.len() * 2 {
            let mut live: Vec<(u64, String)> = self
                .entries
                .iter()
                .map(|(k, (s, _))| (*s, k.clone()))
                .collect();
            live.sort_by_key(|(s, _)| *s);
            self.order = live.into_iter().collect();
        }
    }

    fn evict(&mut self) {
        while let Some((stamp, key)) = self.order.front().cloned() {
            let stale = self
                .entries
                .get(&key)
                .map(|(current, _)| *current != stamp)
                .unwrap_or(true);
            self.order.pop_front();
            if stale {
                continue;
            }
            if self.entries.len() <= MAX_THUMB_ENTRIES && self.bytes <= MAX_THUMB_BYTES {
                self.order.push_front((stamp, key));
                break;
            }
            if let Some((_, value)) = self.entries.remove(&key) {
                self.bytes = self.bytes.saturating_sub(estimated_size(&value));
            }
        }
    }

}

fn thumb_cache() -> &'static Mutex<LruCache> {
    static CACHE: OnceLock<Mutex<LruCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new()))
}

#[cfg(test)]
mod lru_tests {
    use super::*;

    fn payload(times: usize) -> serde_json::Value {
        serde_json::json!({ "data": "x".repeat(times) })
    }

    #[test]
    fn hit_and_miss() {
        let mut cache = LruCache::new();
        cache.put("a", payload(8));
        assert!(cache.get("a").is_some());
        assert!(cache.get("b").is_none());
    }

    /// 淘汰必须真发生：塞到超预算，最久未用的要出局、账目要落回预算内
    fn evicts_to(unit: usize, keys: usize, expect_kept: usize) {
        let mut cache = LruCache::new();
        for i in 0..keys {
            cache.put(&format!("k{}", i), payload(unit));
        }
        assert_eq!(cache.entries.len(), expect_kept, "留存条数不对");
        assert!(cache.bytes <= MAX_THUMB_BYTES, "字节账目越界: {}", cache.bytes);
        assert!(cache.get("k0").is_none(), "最早的条目该被淘汰");
        assert!(cache.get(&format!("k{}", keys - 1)).is_some());
    }

    #[test]
    fn byte_budget_evicts() {
        // 单条约 64 KB：预算先于 512 条的上限触顶
        let unit = 1 << 16;
        let width = format!("{}", "x".repeat(unit)).len();
        let size = format!("{{\"data\":\"{}\"}}", "x".repeat(unit)).len();
        assert_eq!(width, unit);
        evicts_to(unit, 900, MAX_THUMB_BYTES / size);
    }

    #[test]
    fn entry_cap_evicts() {
        // 小载荷：条数上限（512）先于字节预算生效
        evicts_to(32, MAX_THUMB_ENTRIES + 60, MAX_THUMB_ENTRIES);
    }

    #[test]
    fn hot_key_survives_and_queue_stays_bounded() {
        let mut cache = LruCache::new();
        for i in 0..MAX_THUMB_ENTRIES {
            cache.put(&format!("k{}", i), payload(1));
        }
        assert!(cache.get("k0").is_some(), "k0 命中即刷新新鲜度");
        cache.put("fresh", payload(1));
        assert!(cache.get("k0").is_some(), "热条目不该被淘汰");
        assert!(cache.get("k1").is_none(), "出局的是次旧条目");
        // 反复读写同一个键：作废项要随 evict 清掉，否则 order 只增不减
        for _ in 0..3_000 {
            cache.get("fresh");
        }
        assert!(cache.order.len() < MAX_THUMB_ENTRIES * 4, "队列失控");
    }
}

/// 缓存键：路径 + mtime + 请求尺寸。文件被改过就不复用旧图。
fn thumb_key(path: &str, max_size: u32) -> String {
    let mtime = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}|{}|{}", path, mtime, max_size)
}

/// 图片信息（字段与 cap_img::ImageInfo 一致，前端契约不变）
#[tauri::command]
pub async fn get_image_info(path: String) -> Result<ImageInfo, String> {
    // 同步体挪到 blocking 线程：命令跑在 IPC 线程上会把整条 invoke 往返堵住
    tauri::async_runtime::spawn_blocking(move || get_image_info_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

pub fn get_image_info_blocking(path: &str) -> Result<ImageInfo, String> {
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

/// 生成图片缩略图，返回 base64 编码的 PNG（字段与 ImageThumbnail 一致，前端契约不变）
#[tauri::command]
pub async fn get_image_thumbnail(path: String, max_size: u32) -> Result<serde_json::Value, String> {
    // 一屏几十张缩略图绝不该压在 IPC 线程上串行解码
    tauri::async_runtime::spawn_blocking(move || get_image_thumbnail_blocking(&path, max_size))
        .await
        .map_err(|e| e.to_string())?
}

pub fn get_image_thumbnail_blocking(
    path: &str,
    max_size: u32,
) -> Result<serde_json::Value, String> {
    let file_path = crate::path_guard::readable(path)?;
    let source_bytes = std::fs::metadata(&file_path)
        .map_err(|e| format!("读取元数据失败: {}", e))?
        .len();
    if source_bytes > MAX_THUMB_SOURCE_BYTES {
        return Err(format!(
            "图片过大（{} MB），不生成缩略图",
            source_bytes / 1024 / 1024
        ));
    }

    let key = thumb_key(&file_path.to_string_lossy(), max_size);
    if let Some(hit) = thumb_cache().lock().ok().and_then(|mut c| c.get(&key)) {
        return Ok(hit);
    }

    let thumb: ImageThumbnail = cap_img::thumbnail(file_path, max_size)?;
    let value = serde_json::to_value(thumb).map_err(|e| e.to_string())?;
    if let Ok(mut cache) = thumb_cache().lock() {
        cache.put(&key, value.clone());
    }
    Ok(value)
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