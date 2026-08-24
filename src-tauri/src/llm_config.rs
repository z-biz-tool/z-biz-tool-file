use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// 用户自定义的 LLM 配置 — 存在 OS 标准的 app config 目录
/// macOS: ~/Library/Application Support/com.zifang.z-biz-tool-file/llm.json
/// Linux: ~/.config/com.zifang.z-biz-tool-file/llm.json
/// Windows: %APPDATA%/com.zifang.z-biz-tool-file/llm.json
///
/// 持久化在 app config dir（而不是 localStorage），原因：
/// - api_key 是敏感数据，app config dir 权限更严
/// - 跨平台一致（不依赖 webview 存储）
/// - 升级 / 卸载时不会遗留在 webview profile
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmConfig {
    /// 提供商: "openai" | "anthropic" | "ollama" | "custom"
    #[serde(default)]
    pub provider: String,
    /// API key（敏感 — 不应通过 invoke 返回给前端以外的地方）
    #[serde(default)]
    pub api_key: String,
    /// 自定义 base URL（OpenAI 兼容 / Ollama / 自建代理）
    #[serde(default)]
    pub base_url: String,
    /// 模型名
    #[serde(default)]
    pub model: String,
    /// 请求超时（秒）
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
    /// 温度（0.0 - 2.0）
    #[serde(default = "default_temperature")]
    pub temperature: f32,
}

fn default_timeout() -> u32 {
    60
}
fn default_temperature() -> f32 {
    0.7
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: "openai".to_string(),
            api_key: String::new(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            timeout_secs: default_timeout(),
            temperature: default_temperature(),
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("llm.json")
}

#[tauri::command]
pub fn load_llm_config(app: tauri::AppHandle) -> Result<LlmConfig, String> {
    let path = config_path(&app);
    if !path.exists() {
        return Ok(LlmConfig::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 LLM 配置失败: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析 LLM 配置失败: {}", e))
}

#[tauri::command]
pub fn save_llm_config(
    app: tauri::AppHandle,
    config: LlmConfig,
) -> Result<(), String> {
    let path = config_path(&app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化 LLM 配置失败: {}", e))?;
    // 写到临时文件再 rename，避免写到一半崩溃留下半截文件
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content)
        .map_err(|e| format!("写入临时文件失败: {}", e))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("替换配置文件失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn get_llm_config_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(config_path(&app).to_string_lossy().to_string())
}

/// 测试 LLM 配置是否可用：发一个最小请求（chat completions 的 1 token 输出）
#[tauri::command]
pub async fn test_llm_config(app: tauri::AppHandle, config: LlmConfig) -> Result<String, String> {
    // 动态构建 endpoint
    let endpoint = match config.provider.as_str() {
        "openai" | "custom" => {
            let base = config.base_url.trim_end_matches('/');
            format!("{}/chat/completions", base)
        }
        "anthropic" => {
            let base = config.base_url.trim_end_matches('/');
            format!("{}/v1/messages", base)
        }
        "ollama" => {
            let base = config.base_url.trim_end_matches('/');
            format!("{}/api/chat", base)
        }
        other => return Err(format!("未知 provider: {}", other)),
    };

    // 构造极简请求
    let body = serde_json::json!({
        "model": config.model,
        "messages": [
            { "role": "user", "content": "hi" }
        ],
        "max_tokens": 1,
        "temperature": 0.0,
    });
    let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    // 用 reqwest 阻塞发送（小测试，无感延迟）
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(config.timeout_secs as u64))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut req = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .body(body_str);
    if !config.api_key.is_empty() {
        match config.provider.as_str() {
            "anthropic" => {
                req = req
                    .header("x-api-key", &config.api_key)
                    .header("anthropic-version", "2023-06-01");
            }
            _ => {
                req = req.header("Authorization", format!("Bearer {}", config.api_key));
            }
        }
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {} — {}", status.as_u16(), &text[..text.len().min(200)]));
    }
    Ok(text)
}
