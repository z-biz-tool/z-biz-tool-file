//! 语雀 token 的密文存取。
//!
//! 与 db 板块（db_app/secrets/encfile.rs）同一套原语：cap-llm-config 的
//! `MultiSecretFile`（AES-256-GCM），落点 `~/.z-biz-tool/kb/secrets.enc`，
//! 主密钥同目录 `master.key`（0600）。
//!
//! 为什么不用 keyring / 明文 config.json，见 encfile.rs 的头部注释：
//! macOS 钥匙串授权绑 adhoc 签名的 cdhash，每次重打包都弹授权框；
//! 明文则违反家族的凭证落点惯例。token 永不回传前端 —— 前端只问「配没配」。

use cap_llm_config::encrypted_file::MultiSecretFile;
use cap_llm_config::{FAMILY_DIR, MULTI_SECRET_FILE};

/// 语雀 token 在密文文件里的条目 id（固定值，覆盖写入即可换 token）。
const YUQUE_TOKEN_ID: &str = "yuque_token";

/// 密文文件在家族目录下的子目录。
const KB_SUBDIR: &str = "kb";

fn secret_file() -> MultiSecretFile {
    let dir = match dirs::home_dir() {
        Some(home) => home.join(FAMILY_DIR).join(KB_SUBDIR),
        None => dirs::config_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("z-biz-tool-file")
            .join(KB_SUBDIR),
    };
    let _ = std::fs::create_dir_all(&dir);
    MultiSecretFile::new(dir.join(MULTI_SECRET_FILE))
}

/// 写入（覆盖）语雀 token。
pub fn set_yuque_token(token: &str) -> Result<(), String> {
    secret_file()
        .put(YUQUE_TOKEN_ID, token)
        .map_err(|e| format!("保存语雀 Token 失败: {}", e))
}

/// 读取语雀 token；未配置时返回 None。
pub fn get_yuque_token() -> Option<String> {
    match secret_file().get(YUQUE_TOKEN_ID) {
        Ok(Some(v)) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

/// 删除语雀 token（幂等）。
pub fn clear_yuque_token() -> Result<(), String> {
    secret_file()
        .remove(YUQUE_TOKEN_ID)
        .map_err(|e| format!("清除语雀 Token 失败: {}", e))
}
