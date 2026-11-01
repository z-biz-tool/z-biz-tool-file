//! AI 配置：家族统一落点接入。
//!
//! ## 2026-11-01 改造
//!
//! 本仓原来自己存 `app_config_dir()/llm.json`，密钥**明文**落盘且权限跟
//! umask 走（本机实测 0644）—— 同机任何能读用户目录的进程都拿得到。
//! 现在改为读写家族统一落点（`cap-llm-config`）：
//!
//! ```text
//! 配置（非敏感）：~/.z-biz-tool/llm/config.json
//! 密钥（敏感）：  OS 密钥库 service="z-biz-tool" / account="llm.apikey"
//! ```
//!
//! 于是：在 terminal 配好的 DeepSeek，file 直接能用；密钥进 OS 密钥库，
//! 不再有任何明文落盘。旧的 `llm.json` 由启动时的幂等迁移器搬进统一落点
//! 并抹掉明文密钥（`cap_llm_config::migrate_legacy_configs` 已按本仓的
//! 历史路径登记）。
//!
//! ## 命令名对齐
//!
//! 统一为家族基准五命令（terminal 也是这一套）：
//!
//! | 命令 | 作用 |
//! |---|---|
//! | `get_ai_config` | 读配置（**脱敏视图**：apiKey 恒空串，hasApiKey 表达有无） |
//! | `save_ai_config` | 写配置（apiKey 空串 = 继承已保存的密钥） |
//! | `list_llm_presets` | 供应商预设目录 |
//! | `list_llm_models` | 列模型（接受草稿覆盖） |
//! | `test_ai_config` | 连通性探测（接受草稿覆盖） |
//!
//! `load_llm_config` / `save_llm_config` / `test_llm_config` / `get_llm_config_path`
//! 四个旧命令名随旧落点一并退役 —— 前端同步换到新命令。

use serde::{Deserialize, Serialize};

use cap_llm_config::{
    migrate_legacy_configs, shared_secret_store, LlmConfigFile, LlmSecret, StoreError,
};

/// 本仓对外的 AI 配置形状（脱敏视图）。
///
/// `api_key` 恒为空串 —— 明文密钥**不出 Rust**。前端设置表单显示
/// 「已保存」占位，留空表示保持不变，录入/修改时才随 `save_ai_config`
/// 过一次 IPC（用户本来就在输入框里敲它，这次传输躲不掉）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigView {
    /// 预设 id（cap-llm 的 preset id），空串表示自定义服务。
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    /// 恒为空串。
    pub api_key: String,
    /// 是否已保存密钥。
    pub has_api_key: bool,
}

/// 草稿配置（前端设置表单送来的形状）。
///
/// 与 [`AiConfigView`] 的差别只有 `api_key`：草稿里它**非空才生效**，
/// 空串表示「继承已保存的密钥」—— 统一面板不回显密钥，用户改个模型名
/// 再点「测试」是常态，那种情况下密钥框本来就是空的。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigDraft {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// 本仓历史的超时单位是**秒**；统一落点是毫秒。草稿保持秒（前端
    /// 表单一直按秒填），写统一落点时换算。
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

fn err_msg(e: StoreError) -> String {
    e.to_string()
}

/// 统一落点配置 → cap-llm 配置（+ 独立取出的明文密钥）。
///
/// 谁真正发请求，谁就该从这里拿配置 —— 本仓**任何**发请求的地方都走
/// 这一个函数，不再各自翻译一遍。
///
/// 旧配置的 `provider` 允许 `"openai" | "anthropic" | "ollama" | "custom"`
/// 等历史取值；`cap_llm::ProviderKind::parse_with_preset` 同时接受别名
/// （minimax / deepseek / qwen / kimi / claude / gemini…），用户把别的
/// 产品的配置抄过来不会报「未知 provider」。
pub fn to_cap(cfg: &LlmConfigFile, api_key: &str) -> Result<cap_llm::LlmConfig, String> {
    let provider = if cfg.preset.is_empty() {
        cfg.provider.as_str()
    } else {
        cfg.preset.as_str()
    };
    let (kind, preset) =
        cap_llm::ProviderKind::parse_with_preset(provider).map_err(|e| e.to_string())?;
    Ok(cap_llm::LlmConfig {
        kind,
        // 统一落点允许 base_url 为空（用预设默认地址），cap-llm 也是这样处理的
        base_url: cfg.base_url.clone(),
        api_key: api_key.to_string(),
        model: cfg.model.clone(),
        timeout: std::time::Duration::from_millis(cfg.timeout_ms.unwrap_or(60_000).max(1_000)),
        // 0.0 是合法温度，所以不能 `if t > 0.0` 判断，直接透传
        temperature: cfg.temperature,
        max_tokens: cfg.max_tokens,
        preset,
    })
}

/// 读统一配置（脱敏视图）。
pub fn read_shared_config() -> Result<AiConfigView, String> {
    let cfg = cap_llm_config::load_config().map_err(err_msg)?;
    let Some(cfg) = cfg else {
        return Ok(AiConfigView {
            provider: String::new(),
            base_url: String::new(),
            model: String::new(),
            temperature: None,
            max_tokens: None,
            api_key: String::new(),
            has_api_key: false,
        });
    };

    // 密钥在 OS 密钥库里，不在配置文件里 —— 「有没有」要问密钥库。
    let has_api_key = shared_secret_store()
        .get()
        .map_err(err_msg)?
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false);

    Ok(AiConfigView {
        provider: if cfg.preset.is_empty() {
            cfg.provider.clone()
        } else {
            cfg.preset.clone()
        },
        base_url: cfg.base_url.clone(),
        model: cfg.model.clone(),
        temperature: cfg.temperature.map(|t| t as f64),
        max_tokens: cfg.max_tokens,
        api_key: String::new(),
        has_api_key,
    })
}

/// 读统一配置 + 明文密钥（**仅供后端发请求用**，绝不回传前端）。
pub fn read_shared_config_with_key() -> Result<(LlmConfigFile, String), String> {
    let cfg = cap_llm_config::load_config()
        .map_err(err_msg)?
        .ok_or_else(|| "尚未配置 AI 服务商".to_string())?;
    let key = shared_secret_store()
        .get()
        .map_err(err_msg)?
        .unwrap_or_default();
    Ok((cfg, key))
}

/// 写统一配置。
///
/// `api_key` 为空串 ⇒ **继承已保存的密钥**（编辑其它字段时表单里没有明文
/// key，留空是常态而不是「清除」）。
pub fn write_shared_config(draft: &AiConfigDraft) -> Result<(), String> {
    let store = shared_secret_store();

    // 先落配置（不含密钥），再落密钥 —— 配置落盘失败时不会有「有配置没密钥」的半截状态。
    let file = LlmConfigFile {
        preset: draft.provider.clone(),
        provider: draft.provider.clone(),
        base_url: draft.base_url.clone(),
        model: draft.model.clone(),
        temperature: draft.temperature.map(|t| t as f32),
        max_tokens: draft.max_tokens,
        timeout_ms: draft.timeout_secs.map(|s| s * 1_000),
        updated_at_ms: now_ms(),
    };
    cap_llm_config::save_config(&file).map_err(err_msg)?;

    if !draft.api_key.trim().is_empty() {
        store.set(&draft.api_key).map_err(err_msg)?;
    }
    Ok(())
}

/// 迁移一次历史配置（幂等；统一落点已有配置时什么都不做）。
///
/// 本仓旧落点是明文 `llm.json`，`cap_llm_config::migrate_legacy_configs`
/// 已按 `app_config_dir()/llm.json` 的三平台路径登记，迁移时会把明文
/// 密钥搬进 OS 密钥库并**抹掉旧文件里的密钥字段**。
pub fn migrate_legacy() -> Result<Option<String>, String> {
    let report = migrate_legacy_configs().map_err(err_msg)?;
    Ok(if report.migrated { report.from } else { None })
}

/// 当前时刻（毫秒时间戳）。写失败不影响主流程 —— 时间戳只是诊断辅助。
fn now_ms() -> Option<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

// ==================== Tauri 命令 ====================

/// 读 AI 配置（脱敏视图：apiKey 恒空串）。
#[tauri::command]
pub fn get_ai_config() -> Result<AiConfigView, String> {
    read_shared_config()
}

/// 保存 AI 配置（密钥进 OS 密钥库，配置落统一目录）。
#[tauri::command]
pub fn save_ai_config(config: AiConfigDraft) -> Result<(), String> {
    write_shared_config(&config)
}

/// 测试 AI 配置是否可用（接受草稿覆盖 —— 用户填完 Key 不用先保存就能测试）。
///
/// 草稿里的 `api_key` 为空时**继承已保存的密钥**。
///
/// 走 `cap_llm::ping`，发一个 `max_tokens=1` 的真实对话：
/// - **不用 `/models` 探活**：很多自建代理不实现这个接口，用它测会把
///   「服务好的，只是没这个 API」误报成「连不上」。
/// - 能拿到回复 ⇒ key、地址、模型三项全对，这才是用户点「测试连接」想知道的。
#[tauri::command]
pub async fn test_ai_config(override_config: Option<AiConfigDraft>) -> Result<String, LlmFailure> {
    let cap = build_cap_for_draft(override_config).map_err(LlmFailure::from)?;
    let elapsed = cap_llm::ping(&cap).await.map_err(LlmFailure::from_error)?;
    Ok(format!(
        "连接成功（{} · {}），耗时 {}ms",
        cap.kind.label(),
        cap.model,
        elapsed.as_millis()
    ))
}

/// 给界面的预设视图。
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

/// 列出可选的供应商预设（单一事实源在 `cap-llm::presets`）。
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

/// 列出该配置可用的模型（接受草稿覆盖）。
#[tauri::command]
pub async fn list_llm_models(
    override_config: Option<AiConfigDraft>,
) -> Result<Vec<String>, LlmFailure> {
    let cap = build_cap_for_draft(override_config).map_err(LlmFailure::from)?;
    let models = cap_llm::list_models(&cap)
        .await
        .map_err(LlmFailure::from_error)?;
    Ok(rank_models(models))
}

/// 给界面的结构化失败。
///
/// 判据（分类 / 动作 / 落点）已下沉到 `cap_llm::failure` —— 家族里五个仓
/// 各抄了一份 `hint_for`，抄到第 5 遍时已经开始漂移（本仓曾缺 `focus`
/// 字段，同一个 401 在 note 会跳密钥框、在这里光标不动）。
/// 此处只做**转发**，不再维护副本。
pub use cap_llm::LlmFailure;

/// 草稿 → cap 配置；草稿没填的项从统一落点继承。
fn build_cap_for_draft(draft: Option<AiConfigDraft>) -> Result<cap_llm::LlmConfig, String> {
    let draft = draft.unwrap_or_default();
    let has_draft_key = !draft.api_key.trim().is_empty();
    let has_any_draft = has_draft_key
        || !draft.provider.trim().is_empty()
        || !draft.base_url.trim().is_empty()
        || !draft.model.trim().is_empty()
        || draft.temperature.is_some()
        || draft.max_tokens.is_some();
    if !has_any_draft {
        // 没有任何草稿 → 完全用已保存的配置
        let (cfg, key) = read_shared_config_with_key()?;
        return to_cap(&cfg, &key);
    }
    let mut file = LlmConfigFile {
        preset: draft.provider.clone(),
        provider: draft.provider.clone(),
        base_url: draft.base_url.clone(),
        model: draft.model.clone(),
        temperature: draft.temperature.map(|t| t as f32),
        max_tokens: draft.max_tokens,
        timeout_ms: draft.timeout_secs.map(|s| s * 1_000),
        updated_at_ms: None,
    };
    // 草稿没填的项从统一落点补齐（继承）
    if let Ok(Some(saved)) = cap_llm_config::load_config() {
        if file.preset.is_empty() && file.provider.is_empty() {
            file.preset = saved.preset.clone();
            file.provider = saved.provider.clone();
        }
        if file.base_url.trim().is_empty() {
            file.base_url = saved.base_url.clone();
        }
        if file.model.trim().is_empty() {
            file.model = saved.model.clone();
        }
        if file.temperature.is_none() {
            file.temperature = saved.temperature;
        }
        if file.max_tokens.is_none() {
            file.max_tokens = saved.max_tokens;
        }
    }
    let key = if has_draft_key {
        draft.api_key
    } else {
        // 草稿没填密钥 → 用统一落点里已存的那份
        shared_secret_store()
            .get()
            .map_err(err_msg)?
            .unwrap_or_default()
    };
    to_cap(&file, &key)
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

    // 注：失败提示的判据测试（每个错误类别都有可执行的下一步、
    // 提示里不泄露密钥）已下沉到 `cap_llm::failure`，家族五仓共用一份。
}

#[cfg(test)]
mod shared_store_tests {
    use super::*;

    /// 环境变量是进程级的：并行测试会互相覆盖隔离目录。
    /// 所有碰统一落点的测试先拿这把锁（terminal 样板同一做法）。
    static LLM_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_llm_env() -> std::sync::MutexGuard<'static, ()> {
        LLM_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn get_ai_config_never_returns_the_plaintext_key() {
        let _guard = lock_llm_env();
        let _iso = cap_llm_config::testing::IsolatedLlm::new("file-view");
        write_shared_config(&AiConfigDraft {
            provider: "deepseek".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            model: "deepseek-chat".into(),
            api_key: "sk-secret-123".into(),
            temperature: Some(0.5),
            max_tokens: None,
            timeout_secs: Some(30),
        })
        .expect("保存应成功");

        let view = read_shared_config().expect("读取应成功");
        assert_eq!(view.api_key, "", "明文密钥绝不能回传前端");
        assert!(view.has_api_key, "有密钥要用布尔表达");
        assert_eq!(view.provider, "deepseek");
        assert_eq!(view.model, "deepseek-chat");
    }

    #[test]
    fn saved_config_file_on_disk_has_no_api_key_field() {
        let _guard = lock_llm_env();
        let _iso = cap_llm_config::testing::IsolatedLlm::new("file-disk");
        write_shared_config(&AiConfigDraft {
            provider: "deepseek".into(),
            base_url: String::new(),
            model: "deepseek-chat".into(),
            api_key: "sk-secret-456".into(),
            temperature: None,
            max_tokens: None,
            timeout_secs: None,
        })
        .expect("保存应成功");

        let path = cap_llm_config::config_path().expect("应能取到路径");
        let content = std::fs::read_to_string(&path).expect("配置文件应存在");
        assert!(
            !content.contains("sk-secret-456"),
            "密钥明文落盘了！配置文件里不该有任何密钥"
        );
        assert!(
            !content.to_lowercase().contains("apikey"),
            "配置文件里不该有 apiKey 字段"
        );
    }

    #[test]
    fn save_with_empty_api_key_keeps_the_saved_key() {
        let _guard = lock_llm_env();
        let _iso = cap_llm_config::testing::IsolatedLlm::new("file-inherit");
        write_shared_config(&AiConfigDraft {
            provider: "deepseek".into(),
            base_url: String::new(),
            model: "deepseek-chat".into(),
            api_key: "sk-first-key".into(),
            temperature: None,
            max_tokens: None,
            timeout_secs: None,
        })
        .expect("首次保存应成功");

        // 改模型名，密钥框留空（面板不回显密钥时的常态）
        write_shared_config(&AiConfigDraft {
            provider: "deepseek".into(),
            base_url: String::new(),
            model: "deepseek-reasoner".into(),
            api_key: String::new(),
            temperature: None,
            max_tokens: None,
            timeout_secs: None,
        })
        .expect("二次保存应成功");

        let (_, key) = read_shared_config_with_key().expect("应能读到配置");
        assert_eq!(key, "sk-first-key", "空串密钥应继承，而不是清除");
    }

    #[test]
    fn draft_overrides_saved_config_for_test_and_models() {
        let _guard = lock_llm_env();
        let _iso = cap_llm_config::testing::IsolatedLlm::new("file-draft");
        write_shared_config(&AiConfigDraft {
            provider: "deepseek".into(),
            base_url: String::new(),
            model: "deepseek-chat".into(),
            api_key: "sk-saved".into(),
            temperature: None,
            max_tokens: None,
            timeout_secs: None,
        })
        .expect("保存应成功");

        // 用户在面板里把模型改成别的，还没保存就点测试：
        // 草稿的 model 应生效，密钥应继承已保存的。
        let cap = build_cap_for_draft(Some(AiConfigDraft {
            provider: String::new(),
            base_url: String::new(),
            model: "deepseek-reasoner".into(),
            api_key: String::new(),
            temperature: None,
            max_tokens: None,
            timeout_secs: None,
        }))
        .expect("草稿转换应成功");
        assert_eq!(cap.model, "deepseek-reasoner", "草稿的模型应生效");
        assert_eq!(cap.api_key, "sk-saved", "密钥应继承已保存的");
    }
}
