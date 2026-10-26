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

impl LlmConfig {
    /// 转成统一接入层 `cap-llm` 的配置。
    ///
    /// `provider` 允许 `"openai" | "anthropic" | "ollama" | "custom"`（本仓历史取值），
    /// `cap_llm::ProviderKind::parse` 同时接受这些写法，也接受 minimax / deepseek /
    /// claude / gemini 等别名 —— 用户把别的产品的配置抄过来不会报「未知 provider」。
    ///
    /// 放在这里而不是 `ai.rs`：`test_llm_config` 也要用，而它属于本文件。
    /// 统一层落地后，本仓**任何**发请求的地方都从这里拿配置，不再各自翻译一遍。
    pub fn to_cap(&self) -> Result<cap_llm::LlmConfig, String> {
        let kind = cap_llm::ProviderKind::parse(&self.provider).map_err(|e| e.to_string())?;
        Ok(cap_llm::LlmConfig {
            kind,
            // 本仓允许 base_url 为空（用默认地址），cap-llm 也是这样处理的
            base_url: self.base_url.clone(),
            api_key: self.api_key.clone(),
            model: self.model.clone(),
            timeout: std::time::Duration::from_secs(self.timeout_secs.max(1) as u64),
            // 0.0 是合法温度，所以不能 `if t > 0.0` 判断，直接透传
            temperature: Some(self.temperature),
            max_tokens: None,
        })
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
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 LLM 配置失败: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析 LLM 配置失败: {}", e))
}

#[tauri::command]
pub fn save_llm_config(app: tauri::AppHandle, config: LlmConfig) -> Result<(), String> {
    let path = config_path(&app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    let content =
        serde_json::to_string_pretty(&config).map_err(|e| format!("序列化 LLM 配置失败: {}", e))?;
    // 写到临时文件再 rename，避免写到一半崩溃留下半截文件
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("写入临时文件失败: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换配置文件失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn get_llm_config_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(config_path(&app).to_string_lossy().to_string())
}

/// 测试 LLM 配置是否可用。
///
/// ## 2026-10-26 改造
///
/// 原来这里自带第三套 `endpoint + 鉴权头 + 请求体` 拼装（和 `ai.rs` 里的那套
/// 几乎逐行重复，只是错误体截断长度从 300 改成了 200）。现在统一走
/// `cap_llm::ping`，它发一个 `max_tokens=1` 的真实对话：
///
/// - **不用 `/models` 探活**：很多自建代理不实现这个接口，用它测会把
///   「服务好的，只是没这个 API」误报成「连不上」。
/// - 能拿到回复 ⇒ key、地址、模型三项全对，这才是用户点「测试连接」想知道的。
#[tauri::command]
pub async fn test_llm_config(config: LlmConfig) -> Result<String, String> {
    let cap = config.to_cap()?;
    let elapsed = cap_llm::ping(&cap).await.map_err(|e| e.to_string())?;
    Ok(format!(
        "连接成功（{} · {}），耗时 {}ms",
        cap.kind.label(),
        config.model,
        elapsed.as_millis()
    ))
}
