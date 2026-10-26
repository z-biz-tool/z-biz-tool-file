//! 文件 AI 能力：摘要与通用问答。
//!
//! ## 2026-10-26 改造：接入层已迁到 `cap-llm`
//!
//! 本文件原来自带一套完整的 HTTP 实现（`llm_endpoint` / `chat_request_body` /
//! `parse_response` / `call_llm`，约 110 行）。它和 aigen / pet / db / note / kb
//! 里的同类代码是同一件事的第六次重写，且带着三个真 bug：
//!
//! | 原代码 | 后果 |
//! |---|---|
//! | `&text[..text.len().min(300)]` | 错误体是中文时切在字符中间 → **panic**，报错误的过程自己崩了 |
//! | `format!("无法从响应中提取文本: {}", body)` | 解析失败时把**整个响应体**写进错误串（可能含用户原文） |
//! | Ollama 分支用 OpenAI 请求体 | `/api/chat` 不认 `max_tokens`，静默按默认长度截断 |
//!
//! 现在只保留「产品差异」：提示词、文件读取、结果结构。协议与传输全在 `cap-llm`。
//!
//! ## 保留不动的东西
//!
//! - 两个命令的名字与签名（`ai_summarize_file` / `ai_chat`）—— 前端不用改
//! - 配置文件格式（`llm.json`）与存放位置 —— 用户不用重填 key
//! - `read_text_preview` 的 20KB 截断 —— 这是产品策略（防超上下文），不是基础设施

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
    ///
    /// 归并前这里恒为 `None`（旧实现从不解析 usage）。现在由 `cap-llm`
    /// 统一从各家响应里抽出来，能拿到就填。
    pub tokens_used: Option<u32>,
}

/// 调 LLM（单轮 chat completion）。
///
/// 保留这个函数名：本仓的 live test 与未来可能的调用点都用它。
/// 内部只做「配置转换 + 调 cap-llm」，不再有任何协议代码。
async fn call_llm(cfg: &LlmConfig, system: &str, user: &str) -> Result<cap_llm::ChatReply, String> {
    // 配置翻译在 llm_config.rs（test_llm_config 也要用同一份）
    let cap_cfg = cfg.to_cap()?;
    let messages = [
        cap_llm::Message::system(system),
        cap_llm::Message::user(user),
    ];
    cap_llm::chat(&cap_cfg, &messages)
        .await
        .map_err(|e| e.to_string())
}

/// 读取文件内容（截断到 20KB 以避免超 LLM 上下文）
fn read_text_preview(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    let s = String::from_utf8_lossy(&bytes).to_string();
    const MAX: usize = 20_000;
    if s.len() > MAX {
        // 旧实现这里也是按字节切，同样会在中文中间 panic。
        // 明确按字符边界截断：先找最近的边界再切。
        let mut cut = MAX;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        Ok(format!(
            "{}\n\n... (文件过长，截断到前 {} 字)",
            &s[..cut], MAX
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

    let reply = call_llm(&cfg, system, &user).await?;
    Ok(AiSummaryResult {
        summary: reply.content,
        elapsed_ms: start.elapsed().as_millis() as u64,
        tokens_used: reply.usage.and_then(|u| u.total_tokens),
    })
}

/// 通用 chat：用户给 system + user 消息，返回助手回复
#[tauri::command]
pub async fn ai_chat(app: AppHandle, system: String, user: String) -> Result<String, String> {
    let cfg = load_llm_config(app)?;
    let reply = call_llm(&cfg, &system, &user).await?;
    Ok(reply.content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(provider: &str) -> LlmConfig {
        LlmConfig {
            provider: provider.to_string(),
            api_key: "sk-test-1234567890".to_string(),
            base_url: String::new(),
            model: "m".to_string(),
            timeout_secs: 30,
            temperature: 0.2,
        }
    }

    #[test]
    fn maps_all_legacy_provider_names() {
        // 本仓历史只写过这四个，一个都不能报「未知 provider」
        for p in ["openai", "anthropic", "ollama", "custom"] {
            assert!(cfg(p).to_cap().is_ok(), "provider={p} 转换失败");
        }
    }

    #[test]
    fn maps_other_products_provider_names_too() {
        // 用户把配置从 pet/mind 抄过来时会出现这些值
        for p in ["minimax", "deepseek", "claude", "gemini"] {
            assert!(cfg(p).to_cap().is_ok(), "provider={p} 转换失败");
        }
    }

    #[test]
    fn unknown_provider_is_rejected_not_silently_openai() {
        let err = cfg("some-typo").to_cap().unwrap_err();
        assert!(err.contains("some-typo"));
    }

    #[test]
    fn zero_temperature_is_passed_through() {
        let mut c = cfg("openai");
        c.temperature = 0.0;
        assert_eq!(c.to_cap().unwrap().temperature, Some(0.0));
    }

    #[test]
    fn zero_timeout_is_clamped_to_one_second() {
        let mut c = cfg("openai");
        c.timeout_secs = 0;
        assert_eq!(c.to_cap().unwrap().timeout.as_secs(), 1);
    }

    #[test]
    fn preview_truncates_on_char_boundary() {
        // 造一个超过 20KB 的中文文件，旧实现会在切点 panic
        let dir = std::env::temp_dir().join(format!("zbiz-ai-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.md");
        std::fs::write(&path, "中".repeat(20_000)).unwrap();

        let out = read_text_preview(&path).expect("截断不该 panic");
        assert!(out.contains("文件过长"));
        // 截断点之后的部分是提示语，前缀必须是合法 UTF-8
        assert!(out.starts_with('中'));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_keeps_small_file_intact() {
        let dir = std::env::temp_dir().join(format!("zbiz-ai-small-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("small.md");
        std::fs::write(&path, "短内容").unwrap();
        assert_eq!(read_text_preview(&path).unwrap(), "短内容");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod minimax_live_tests {
    use super::call_llm;
    use crate::llm_config::LlmConfig;

    /// **真实 API 实测**：用真的 MiniMax 端点跑一遍本仓的接入链路
    /// （本仓 `LlmConfig::to_cap` → `cap_llm::chat` → MiniMax）。
    ///
    /// 跑法：`MINIMAX_API_KEY=<key> cargo test --lib minimax`
    /// 没设 key 时**显式打印跳过原因** —— 「没跑」和「跑过了」必须能区分。
    #[tokio::test]
    async fn minimax_live_call_llm() {
        let Ok(key) = std::env::var("MINIMAX_API_KEY") else {
            eprintln!("[LIVE] 跳过 minimax 真实 API 实测：未设置 MINIMAX_API_KEY（这是「没跑」，不是「跑过了」）");
            return;
        };
        let cfg = LlmConfig {
            provider: "minimax".to_string(),
            api_key: key,
            base_url: std::env::var("MINIMAX_BASE_URL")
                .unwrap_or_else(|_| "https://api.minimaxi.com/v1".to_string()),
            model: std::env::var("MINIMAX_MODEL")
                .unwrap_or_else(|_| "MiniMax-M3.1-Flash".to_string()),
            timeout_secs: 60,
            temperature: 0.2,
        };
        let reply = call_llm(&cfg, "你是助手", "只回两个字：收到")
            .await
            .expect("真实调用应成功");
        assert!(!reply.content.trim().is_empty(), "返回内容为空");
        eprintln!(
            "[LIVE] file→cap-llm 真实调用成功：{} | tokens={:?} | {}ms",
            reply.content.chars().take(40).collect::<String>(),
            reply.usage.as_ref().and_then(|u| u.total_tokens),
            reply.latency.as_millis()
        );
    }

    /// 反向钉：假 key 必须被服务端拒，且错误分类要是 Http(401/403)，
    /// 而不是被吞成「网络错误」。
    #[tokio::test]
    async fn minimax_live_rejects_bad_key() {
        let Ok(_key) = std::env::var("MINIMAX_API_KEY") else {
            eprintln!("[LIVE] 跳过（未设置 MINIMAX_API_KEY）");
            return;
        };
        let cfg = LlmConfig {
            provider: "minimax".to_string(),
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
        // 关键：错误串里不能出现 key 本身
        assert!(!err.contains("sk-cp-definitely-invalid-key"), "错误串泄露了 key");
    }
}
