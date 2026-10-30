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
    /// `cap_llm::ProviderKind::parse_with_preset` 同时接受这些写法，也接受 minimax /
    /// deepseek / qwen / kimi / claude / gemini 等别名 —— 用户把别的产品的配置抄过来
    /// 不会报「未知 provider」。
    ///
    /// 用 `parse_with_preset` 而不是 `parse`：前者会一并解析出**供应商预设身份**，
    /// 于是 `provider: "deepseek"` 这类存量配置在 `base_url` 留空时能自动
    /// 填上 DeepSeek 的地址，不必用户手抄（抄错一个字符就是 404）。
    ///
    /// 放在这里而不是 `ai.rs`：`test_llm_config` 也要用，而它属于本文件。
    /// 统一层落地后，本仓**任何**发请求的地方都从这里拿配置，不再各自翻译一遍。
    pub fn to_cap(&self) -> Result<cap_llm::LlmConfig, String> {
        let (kind, preset) =
            cap_llm::ProviderKind::parse_with_preset(&self.provider).map_err(|e| e.to_string())?;
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
            preset,
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
pub async fn test_llm_config(config: LlmConfig) -> Result<String, LlmFailure> {
    let cap = config.to_cap().map_err(LlmFailure::from)?;
    let elapsed = cap_llm::ping(&cap).await.map_err(LlmFailure::from_error)?;
    Ok(format!(
        "连接成功（{} · {}），耗时 {}ms",
        cap.kind.label(),
        config.model,
        elapsed.as_millis()
    ))
}

/// 给前端的预设视图。
///
/// **为什么不直接序列化 `ProviderPreset`**：那个结构里的 `protocol` / `kind`
/// 是 Rust 枚举，前端拿到 `"OpenAiCompat"` 这种字符串也没有用武之地；而
/// `aliases` / `verified_on` 前端确实要（搜索别名、提示「地址可能过期」）。
/// 所以这里只挑前端真正消费的字段，而不是把内部结构整体推出去 ——
/// 内部字段一改就炸前端，是最不划算的耦合。
#[derive(Debug, Serialize)]
pub struct PresetView {
    /// 稳定机器标识，作为 `provider` 字段写回配置。
    pub id: &'static str,
    /// 展示名（中文）。
    pub label: &'static str,
    /// 已填好的服务地址。
    pub base_url: &'static str,
    /// 分组键（international / domestic / aggregator / selfHosted）。
    pub category: &'static str,
    /// 分组展示名。
    pub category_label: &'static str,
    /// 是否需要 API Key。Ollama 这类本地服务不需要，界面要据此隐藏密钥框。
    pub requires_api_key: bool,
    /// 供搜索的其他写法（英文名、旧称）。用户输 "kimi" 要能搜到「Kimi（月之暗面）」。
    pub aliases: &'static [&'static str],
    /// 地址核对日期。给用户一个「这条预设是不是很老了」的判断依据。
    pub verified_on: &'static str,
}

fn category_key(c: cap_llm::preset::Category) -> &'static str {
    use cap_llm::preset::Category as C;
    match c {
        C::International => "international",
        C::Domestic => "domestic",
        C::Aggregator => "aggregator",
        C::SelfHosted => "selfHosted",
    }
}

/// 列出可选的供应商预设。
///
/// ## 为什么要有这个命令
///
/// 改造前，前端 `SettingsModal.tsx` 里有一张 `PROVIDER_PRESETS` 常量表
/// （4 家，写死 `gpt-4o-mini` / `claude-3-5-sonnet-latest`）。这是**第二份事实源**：
/// Rust 侧 `cap-llm` 已经有同一张表，两边一旦不同步，就会出现
/// 「界面显示 DeepSeek、实际请求打向别处」这类最难查的故障 ——
/// 而模型名那两项在 2026 年早已停服，用户照着填只会拿到 404。
///
/// 现在界面从 Rust 取，单一事实源。加一家厂商只需改 `cap-llm::presets`。
#[tauri::command]
pub fn list_llm_presets() -> Vec<PresetView> {
    cap_llm::preset::PRESETS
        .iter()
        .map(|p| PresetView {
            id: p.id,
            label: p.label,
            base_url: p.base_url,
            category: category_key(p.category),
            category_label: p.category.label(),
            requires_api_key: p.requires_api_key,
            aliases: p.aliases,
            verified_on: p.verified_on,
        })
        .collect()
}

/// 明显不是对话模型的模型名前缀。
///
/// 用户点「获取模型列表」是为了选一个**能聊天**的模型；而 `/models` 通常把
/// 向量、语音、绘图、重排模型全都列出来。让用户在一个 200 项的下拉里
/// 挑出那个能用的，等于把筛选工作推回给人 —— 选错之后拿到的是
/// 「model does not support chat」，一句话都看不出是选错了模型类别。
const NON_CHAT_HINTS: &[&str] = &[
    "embedding",
    "embed",
    "whisper",
    "tts",
    "audio",
    "image",
    "dall-e",
    "rerank",
    "moderation",
    "guard",
    "search-",
    "-search",
    "ocr",
];

/// 按「能不能聊天」给模型名排序：能聊的在前，其余在后。
///
/// 刻意**不删除**非对话模型：有些代理把自定义模型名起得很随意，
/// 一刀切过滤会把「唯一可用的那个」也滤掉。排序而非过滤，最坏情况
/// 只是用户需要往下滚一点。
fn rank_models(mut models: Vec<String>) -> Vec<String> {
    models.sort_by_key(|m| {
        let lower = m.to_ascii_lowercase();
        let non_chat = NON_CHAT_HINTS.iter().any(|h| lower.contains(h));
        (non_chat, lower.clone())
    });
    models.dedup();
    models
}

/// 列出该配置可用的模型。
///
/// 接受的是**表单里的草稿配置**，不是磁盘上的配置 —— 用户常常是
/// 「填完 key 先点获取模型，满意了才保存」。若这里读磁盘，用户会看到
/// 上一次的旧结果，以为新 key 不能用。
#[tauri::command]
pub async fn list_llm_models(config: LlmConfig) -> Result<Vec<String>, LlmFailure> {
    let cap = config.to_cap().map_err(LlmFailure::from)?;
    let models = cap_llm::list_models(&cap)
        .await
        .map_err(LlmFailure::from_error)?;
    Ok(rank_models(models))
}

/// 给界面的结构化失败。
///
/// ## 为什么不是 `Result<_, String>`
///
/// 字符串错误只能被「读」不能被「判断」。界面要给出的恰恰是判断：
/// 401 该聚焦密钥框、404 该提示地址、429 该说「这不是你的配置问题」。
/// 靠正则去猜 `HTTP 401 — ...` 里的数字，等于把协议塞进文案里，
/// 哪天文案改一个字（比如加个中文破折号），分流就静默失效 ——
/// 而失效的表现是「所有错误都显示同一句话」，没人会当成 bug 报上来。
#[derive(Debug, Serialize)]
pub struct LlmFailure {
    /// 机器可判的类别：notConfigured / network / timeout / http / parse / unsupported / io
    pub kind: &'static str,
    /// HTTP 状态码（仅 kind == "http" 时非空）。
    pub status: Option<u16>,
    /// 原始错误，已脱敏、已按字符截断。给「想知道细节」的用户。
    pub message: String,
    /// 一句话动机 + 一个动作。给「只想让它能用」的用户。
    pub hint: String,
}

fn kind_key(k: cap_llm::ErrorKind) -> &'static str {
    use cap_llm::ErrorKind as E;
    match k {
        E::NotConfigured => "notConfigured",
        E::Network => "network",
        E::Timeout => "timeout",
        E::Http => "http",
        E::Parse => "parse",
        E::Unsupported => "unsupported",
        E::Io => "io",
    }
}

/// 把类别 + 状态码翻译成「用户下一步该做什么」。
///
/// 每一条都必须指向**一个具体动作**，而不是复述错误。
/// 「请求失败，请重试」这种文案的价值是零 —— 用户已经知道失败了。
fn hint_for(kind: cap_llm::ErrorKind, status: Option<u16>) -> String {
    use cap_llm::ErrorKind as E;
    match (kind, status) {
        (E::NotConfigured, _) => "配置还差一项。请补齐上方标红的字段后重试。".into(),
        (E::Network, _) => {
            "连不上这个地址。国内厂商（DeepSeek / 通义 / Kimi / 智谱 / 豆包）一般直连即可，\
             如果你开了代理，先关掉再试；海外厂商（OpenAI / Gemini / Anthropic）相反，需要代理。"
                .into()
        }
        (E::Timeout, _) => "等太久没等到回应。可能是网络到该地区的链路慢，也可能是模型正在排队。\
             可以先换一个更小的模型试，或把超时调大。"
            .into(),
        (E::Http, Some(401)) | (E::Http, Some(403)) => {
            "API Key 无效、已过期，或这个 key 没有该模型的权限。请重新粘贴密钥；\
             若刚续费过，确认用的是新 key。"
                .into()
        }
        (E::Http, Some(404)) => {
            "地址或模型名不存在。最常见的原因是 Base URL 多写／少写了一段路径 —— \
             各家都不完全一样（DeepSeek 带 /v1，智谱是 /api/paas/v4，火山是 /api/v3）。\
             点「恢复默认地址」用该厂商的标准地址最稳。"
                .into()
        }
        (E::Http, Some(429)) => {
            "额度用尽或被限流。这不是配置写错了 —— 换个时段再试，或在服务商后台充值／提额。".into()
        }
        (E::Http, Some(s)) if s >= 500 => {
            "服务商那边出故障了，不是你配置的问题。稍后重试即可。".into()
        }
        (E::Http, _) => "服务端拒绝了这次请求。原始错误见下方详情。".into(),
        (E::Parse, _) => "对方回了内容，但不是预期的格式。多半是这个地址其实不是该协议的服务 —— \
             例如把 Anthropic 的地址填在了 OpenAI 兼容这一档。"
            .into(),
        (E::Unsupported, _) => "这家服务不支持当前操作。换一个厂商，或改用手动填写模型名。".into(),
        (E::Io, _) => "本机读写配置出错。检查配置文件所在目录是否可写。".into(),
    }
}

impl LlmFailure {
    fn from_error(e: cap_llm::LlmError) -> Self {
        let hint = hint_for(e.kind, e.status);
        Self {
            kind: kind_key(e.kind),
            status: e.status,
            message: e.to_string(),
            hint,
        }
    }
}

impl From<String> for LlmFailure {
    /// `to_cap()` 之类的本地校验失败：没有类别可判，但同样要能显示。
    fn from(message: String) -> Self {
        Self {
            kind: "notConfigured",
            status: None,
            hint: hint_for(cap_llm::ErrorKind::NotConfigured, None),
            message,
        }
    }
}
#[cfg(test)]
mod interaction_tests {
    use super::*;

    #[test]
    fn presets_expose_every_field_the_ui_needs() {
        let all = list_llm_presets();
        assert!(all.len() >= 16, "预设不应少于 16 条，实际 {}", all.len());
        for p in &all {
            // 每一条都必须有可用地址 —— 这正是预设存在的理由，
            // 空地址等于把「手抄 URL」的活推回给用户。
            assert!(!p.base_url.is_empty(), "{} 缺地址", p.id);
            assert!(!p.label.is_empty(), "{} 缺展示名", p.id);
            assert!(!p.category_label.is_empty(), "{} 缺分组名", p.id);
            assert!(!p.verified_on.is_empty(), "{} 缺核对日期", p.id);
        }
        // 国内厂商必须覆盖到：这是本仓用户最可能买的几家
        for id in [
            "deepseek",
            "qwen",
            "moonshot",
            "zhipu",
            "volcengine",
            "minimax",
        ] {
            assert!(all.iter().any(|p| p.id == id), "缺国内预设 {}", id);
        }
        // Ollama 不需要 key，界面要靠这个字段隐藏密钥框
        let ollama = all.iter().find(|p| p.id == "ollama").unwrap();
        assert!(!ollama.requires_api_key);
    }

    #[test]
    fn every_preset_id_is_writable_back_as_provider() {
        // 界面把 p.id 写进 config.provider，下次启动要能再解析出来。
        // 解析不了 = 用户存完就报「未知提供商」。
        for p in list_llm_presets() {
            let (_kind, preset) = cap_llm::ProviderKind::parse_with_preset(p.id)
                .unwrap_or_else(|e| panic!("预设 {} 无法写回：{}", p.id, e));
            assert_eq!(preset, Some(p.id), "预设 {} 写回后身份丢了", p.id);
        }
    }

    #[test]
    fn chat_models_are_ranked_before_embedding_and_speech() {
        let ranked = rank_models(vec![
            "text-embedding-3-small".into(),
            "gpt-4o".into(),
            "whisper-1".into(),
            "dall-e-3".into(),
            "deepseek-chat".into(),
        ]);
        assert_eq!(ranked[0], "deepseek-chat");
        assert_eq!(ranked[1], "gpt-4o");
        // 非对话模型仍在列表里，只是排到后面 —— 宁可让用户多滚一下，
        // 也不要把「代理上唯一可用的怪名字模型」滤掉
        assert!(ranked.contains(&"text-embedding-3-small".to_string()));
        assert!(ranked.contains(&"whisper-1".to_string()));
    }

    #[test]
    fn duplicate_models_collapse() {
        let ranked = rank_models(vec!["a".into(), "a".into(), "b".into()]);
        assert_eq!(ranked, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn every_failure_kind_carries_an_actionable_hint() {
        use cap_llm::ErrorKind as E;
        // 这是本层存在的理由：界面不该复述错误，要给出下一步。
        let cases = [
            (E::NotConfigured, None, "补齐"),
            (E::Network, None, "代理"),
            (E::Timeout, None, "超时"),
            (E::Http, Some(401), "密钥"),
            (E::Http, Some(403), "权限"),
            (E::Http, Some(404), "Base URL"),
            (E::Http, Some(429), "限流"),
            (E::Http, Some(502), "故障"),
            (E::Parse, None, "协议"),
            (E::Unsupported, None, "不支持"),
            (E::Io, None, "配置"),
        ];
        for (kind, status, must_mention) in cases {
            let hint = hint_for(kind, status);
            assert!(
                hint.contains(must_mention),
                "{:?}/{:?} 的提示里没提到「{}」，实际：{}",
                kind,
                status,
                must_mention,
                hint
            );
            // 「请重试」这类空话不构成动作；提示必须有实质长度
            assert!(hint.chars().count() >= 12, "提示过短：{}", hint);
        }
    }

    #[test]
    fn hint_does_not_leak_the_api_key() {
        // 提示是给人看的，可能被截图发群。密钥绝不能出现在这里。
        for (kind, status) in [
            (cap_llm::ErrorKind::Network, None),
            (cap_llm::ErrorKind::Http, Some(401)),
            (cap_llm::ErrorKind::Parse, None),
        ] {
            let hint = hint_for(kind, status);
            assert!(!hint.contains("sk-"), "提示里出现了疑似密钥：{}", hint);
        }
    }
}
