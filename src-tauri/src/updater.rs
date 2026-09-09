// 应用自动更新模块
// 检测 GitHub Releases → 下载新版本 → 替换本地 app
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const GITHUB_REPO: &str = "z-biz-tool/z-biz-tool-file";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseInfo {
    pub tag_name: String,
    pub name: String,
    pub body: String,
    pub published_at: String,
    pub html_url: String,
    pub prerelease: bool,
    pub draft: bool,
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub release: Option<ReleaseInfo>,
    pub matched_asset: Option<ReleaseAsset>,
}

/// 检测平台对应的 asset 名称关键字
fn get_platform_keyword() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "aarch64-apple-darwin" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "x86_64-apple-darwin" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "x86_64-pc-windows" }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    { "aarch64-pc-windows" }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { "x86_64-unknown-linux" }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { "aarch64-unknown-linux" }
}

fn get_file_extension() -> &'static str {
    #[cfg(target_os = "macos")]
    { "dmg" }
    #[cfg(target_os = "windows")]
    { "msi.zip" }  // 通常 zip 打包
    #[cfg(target_os = "linux")]
    { "AppImage" }  // 或 deb
}

/// 获取当前版本
#[tauri::command]
pub fn updater_current_version() -> String {
    CURRENT_VERSION.to_string()
}

/// 检查 GitHub 最新 release
#[tauri::command]
pub async fn updater_check() -> Result<UpdateStatus, String> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let resp = ureq::get(&url)
        .set("User-Agent", "z-biz-tool-file-updater")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("查询 GitHub 失败: {}（请检查网络）", e))?
        .into_string()
        .map_err(|e| format!("读取响应失败: {}", e))?;

    let release: ReleaseInfo = serde_json::from_str(&resp)
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let latest = release.tag_name.trim_start_matches('v').to_string();
    let current = CURRENT_VERSION.to_string();
    let has_update = is_newer_version(&latest, &current);

    // 找到匹配当前平台的 asset
    let kw = get_platform_keyword();
    let ext = get_file_extension();
    let matched = release.assets.iter().find(|a| {
        let n = a.name.to_lowercase();
        n.contains(kw) || n.ends_with(ext)
    }).cloned();

    Ok(UpdateStatus {
        current_version: current,
        latest_version: Some(latest),
        has_update,
        release: Some(release),
        matched_asset: matched,
    })
}

/// 比较版本号（a.b.c 格式）
fn is_newer_version(new: &str, old: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.split('.').filter_map(|s| s.parse::<u32>().ok()).collect()
    };
    let n = parse(new);
    let o = parse(old);
    for i in 0..n.len().max(o.len()) {
        let a = *n.get(i).unwrap_or(&0);
        let b = *o.get(i).unwrap_or(&0);
        if a > b { return true; }
        if a < b { return false; }
    }
    false
}

/// 下载指定 URL 到目标路径
#[tauri::command]
pub async fn updater_download(url: String, dest: String) -> Result<String, String> {
    let dest_path = PathBuf::from(&dest);
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let resp = ureq::get(&url)
        .set("User-Agent", "z-biz-tool-file-updater")
        .call()
        .map_err(|e| format!("下载失败: {}", e))?;

    let mut reader = resp.into_reader();
    let mut file = fs::File::create(&dest_path).map_err(|e| format!("创建文件失败: {}", e))?;
    std::io::copy(&mut reader, &mut file).map_err(|e| format!("写入失败: {}", e))?;

    Ok(dest_path.to_string_lossy().to_string())
}

/// 下载最新版本到 Downloads 目录
#[tauri::command]
pub async fn updater_download_latest() -> Result<DownloadResult, String> {
    let status = updater_check().await?;
    let asset = status.matched_asset.ok_or_else(|| {
        format!("未找到匹配平台 {} 的安装包", get_platform_keyword())
    })?;

    let home = dirs::home_dir().ok_or("找不到主目录")?;
    let downloads = home.join("Downloads");
    fs::create_dir_all(&downloads).map_err(|e| format!("创建 Downloads 失败: {}", e))?;

    let dest = downloads.join(&asset.name);
    let final_path = updater_download(asset.browser_download_url.clone(), dest.to_string_lossy().to_string()).await?;

    Ok(DownloadResult {
        file_path: final_path,
        file_size: asset.size,
        version: status.latest_version.unwrap_or_default(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadResult {
    pub file_path: String,
    pub file_size: u64,
    pub version: String,
}

/// 尝试替换本地 app（macOS/Windows 特定）
/// 注意：当前 app 正在运行时无法直接替换，需要退出后由用户/脚本完成
/// 这里只是打开下载目录或启动安装程序
#[tauri::command]
pub fn updater_open_install_guide() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // macOS: 打开 Finder 到 ~/Downloads
        Command::new("open")
            .arg(dirs::home_dir().unwrap_or_default().join("Downloads"))
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {}", e))?;
        Ok("已打开下载目录，请双击 .dmg 文件并拖拽到 Applications 替换".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(dirs::home_dir().unwrap_or_default().join("Downloads"))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {}", e))?;
        Ok("已打开下载目录，请双击安装包完成更新".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(dirs::home_dir().unwrap_or_default().join("Downloads"))
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
        Ok("已打开下载目录，请双击 .AppImage 或 .deb 完成更新".to_string())
    }
}

/// 后台静默检查更新（启动时调用），有更新则通知前端
#[tauri::command]
pub async fn updater_silent_check() -> Option<UpdateStatus> {
    match updater_check().await {
        Ok(status) if status.has_update => Some(status),
        _ => None,
    }
}
