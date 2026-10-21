use serde::{Deserialize, Serialize};

use std::path::Path;
use tauri::AppHandle;

use crate::llm_config::{load_llm_config, LlmConfig};

/// AI 摘要结果
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiSummaryResult {
    /// 摘要文本
    pub summary: String,
    /// 摘要耗时（毫秒）
    pub elapsed_ms: u64,
    /// 实际使用的 token 数（如果 LLM 返回了）
    pub tokens_used: Option<u32>,
}

/// 构造 LLM chat completions 端点
fn llm_endpoint(cfg: &LlmConfig) -> Result<String, String> {
    match cfg.provider.as_str() {
        "openai" | "custom" => {
            let base = cfg.base_url.trim_end_matches('/');
            Ok(format!("{}/chat/completions", base))
        }
        "anthropic" => {
            // Anthropic 走 /v1/messages
            let base = cfg.base_url.trim_end_matches('/');
            Ok(format!("{}/v1/messages", base))
        }
        "ollama" => {
            // Ollama 走 /api/chat
            let base = cfg.base_url.trim_end_matches('/');
            Ok(format!("{}/api/chat", base))
        }
        other => Err(format!("未知 provider: {}", other)),
    }
}

/// 构造 chat 请求体（OpenAI 兼容格式）
fn chat_request_body(cfg: &LlmConfig, system: &str, user: &str) -> serde_json::Value {
    match cfg.provider.as_str() {
        "anthropic" => serde_json::json!({
            "model": cfg.model,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
            "max_tokens": 1024,
            "temperature": cfg.temperature,
        }),
        // openai / ollama(custom) 都用 OpenAI 兼容 chat completions
        _ => serde_json::json!({
            "model": cfg.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
            "max_tokens": 1024,
            "temperature": cfg.temperature,
        }),
    }
}

/// 解析响应（提取 assistant 文本）
fn parse_response(provider: &str, body: &serde_json::Value) -> Result<String, String> {
    let text = match provider {
        "anthropic" => body
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|item| item.get("text"))
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        _ => body
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|msg| msg.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string()),
    };
    text.ok_or_else(|| format!("无法从响应中提取文本: {}", body))
}

/// 调 LLM（单轮 chat completion）
pub async fn call_llm(cfg: &LlmConfig, system: &str, user: &str) -> Result<String, String> {
    if cfg.api_key.is_empty() && cfg.provider != "ollama" {
        return Err("API Key 未配置，请先到 设置 → AI/LLM 配置".to_string());
    }
    let endpoint = llm_endpoint(cfg)?;
    let body = chat_request_body(cfg, system, user);
    let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(cfg.timeout_secs as u64))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let mut req = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .body(body_str);
    if !cfg.api_key.is_empty() {
        match cfg.provider.as_str() {
            "anthropic" => {
                req = req
                    .header("x-api-key", &cfg.api_key)
                    .header("anthropic-version", "2023-06-01");
            }
            _ => {
                req = req.header("Authorization", format!("Bearer {}", cfg.api_key));
            }
        }
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {} — {}",
            status.as_u16(),
            &text[..text.len().min(300)]
        ));
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {}", e))?;
    parse_response(&cfg.provider, &json)
}

/// 读取文件内容（截断到 20KB 以避免超 LLM 上下文）
fn read_text_preview(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    let s = String::from_utf8_lossy(&bytes).to_string();
    const MAX: usize = 20_000;
    if s.len() > MAX {
        Ok(format!(
            "{}\n\n... (文件过长，截断到前 {} 字)",
            &s[..MAX],
            MAX
        ))
    } else {
        Ok(s)
    }
}

/// 总结一个文本文件（带 LLM 配置）
#[tauri::command]
pub async fn ai_summarize_file(
    app: AppHandle,
    path: String,
    custom_prompt: Option<String>,
) -> Result<AiSummaryResult, String> {
    let start = std::time::Instant::now();
    let cfg = load_llm_config(app)?;

    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if p.is_dir() {
        return Err("不支持对目录做 AI 摘要".to_string());
    }
    let preview = read_text_preview(p)?;

    let system = "你是一个简洁的文件摘要助手。用 1-3 句中文总结用户提供的文件内容的关键信息。";
    let user =
        custom_prompt.unwrap_or_else(|| format!("请总结这个文件：\n\n```\n{}\n```", preview));

    let summary = call_llm(&cfg, system, &user).await?;
    Ok(AiSummaryResult {
        summary,
        elapsed_ms: start.elapsed().as_millis() as u64,
        tokens_used: None,
    })
}

/// 通用 chat：用户给 system + user 消息，返回助手回复
#[tauri::command]
pub async fn ai_chat(app: AppHandle, system: String, user: String) -> Result<String, String> {
    let cfg = load_llm_config(app)?;
    call_llm(&cfg, &system, &user).await
}

#[cfg(test)]
mod minimax_live_tests {
    use super::call_llm;
    use crate::llm_config::LlmConfig;

    /// **真实 API 实测**：用真的 MiniMax 端点跑一遍本仓自己的 `call_llm`。
    ///
    /// 本仓的 provider 取值是 `"openai" | "anthropic" | "ollama" | "custom"`
    /// —— MiniMax 是 OpenAI 兼容的，填 `provider = "openai"` + MiniMax 的
    /// base_url 即可（"custom" 同为 OpenAI 兼容路径）。
    /// 2026-10-20 实测 `https://api.minimaxi.com/v1/chat/completions` 返回 200。
    ///
    /// 跑法：`MINIMAX_API_KEY=<key> cargo test --lib minimax`
    /// 没设 key 时**显式打印跳过原因**。
    #[tokio::test]
    async fn minimax_live_call_llm() {
        let Ok(key) = std::env::var("MINIMAX_API_KEY") else {
            eprintln!("[LIVE] 跳过 minimax 真实 API 实测：未设置 MINIMAX_API_KEY（这是「没跑」，不是「跑过了」）");
            return;
        };
        let cfg = LlmConfig {
            provider: "openai".to_string(),
            api_key: key,
            base_url: std::env::var("MINIMAX_BASE_URL")
                .unwrap_or_else(|_| "https://api.minimaxi.com/v1".to_string()),
            model: std::env::var("MINIMAX_MODEL")
                .unwrap_or_else(|_| "MiniMax-M3.1-Flash".to_string()),
            timeout_secs: 60,
            temperature: 0.2,
        };
        let out = call_llm(&cfg, "你是助手", "只回两个字：收到")
            .await
            .expect("真实调用应成功");
        assert!(!out.trim().is_empty(), "返回内容为空");
        eprintln!(
            "[LIVE] file call_llm 真实调用成功：{}",
            out.chars().take(40).collect::<String>()
        );
    }

    /// 反向钉：假 key 必须被服务端拒。
    #[tokio::test]
    async fn minimax_live_rejects_bad_key() {
        let Ok(_key) = std::env::var("MINIMAX_API_KEY") else {
            eprintln!("[LIVE] 跳过（未设置 MINIMAX_API_KEY）");
            return;
        };
        let cfg = LlmConfig {
            provider: "openai".to_string(),
            api_key: "sk-cp-definitely-invalid-key".to_string(),
            base_url: "https://api.minimaxi.com/v1".to_string(),
            model: "MiniMax-M3.1-Flash".to_string(),
            timeout_secs: 60,
            temperature: 0.2,
        };
        let err = call_llm(&cfg, "你是助手", "hi")
            .await
            .expect_err("假 key 必须被拒");
        assert!(
            err.contains("401") || err.contains("403"),
            "期望 401/403，实际：{err}"
        );
    }
}
