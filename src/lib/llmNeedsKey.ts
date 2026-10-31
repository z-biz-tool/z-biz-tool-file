/**
 * 「这份 LLM 配置要不要 API Key」—— 前端侧判据。
 *
 * ## 为什么要有这个文件
 *
 * 后端 cap-llm 的 `LlmConfig::needs_api_key()` 已经统一了免密钥判定：
 * ① 选了登记「免 Key」的预设（zbiz-local / ollama）；
 * ② 地址落在本机 / 局域网（自建服务没有鉴权层）。
 *
 * 前端也得判同一件事 —— 否则出现**判据分裂**：后端放行、前端却把用户
 * 弹回设置页要一个无处可用的密钥，而**没有任何编译错误**能暴露它。
 * 表现就是「本地网关配了却用不了」。
 *
 * ## 为什么放在 lib 而不是组件里
 *
 * 判据必须有牙齿。写在 `.tsx` 里就没法单测，只能靠人肉回归 ——
 * 而这类判据最容易被"顺手改成永真"（`return true`）而无人察觉。
 * 抽出来才能进 vitest。
 *
 * ## 金标
 *
 * Rust 侧 `z-biz-tool-capability/crates/cap-llm/src/config.rs` 的
 * `is_private_endpoint()` 与 `LlmConfig::needs_api_key()`。
 * 共享层 `z-biz-tool-shared/ai` 的 `needsApiKey()` 是它的逐条镜像。
 */
// 从 `./ai/endpoint` 而不是 `./ai` 导入：
// `ai` 的 barrel 会拉进 AIManager → zustand，而本仓只需要一个纯函数判据，
// 为此引入状态库是不该有的耦合。
import { needsApiKey } from "z-biz-tool-shared/ai/endpoint";

/**
 * 预设的界面视图（与 Rust 侧 `PresetView` 同形）。
 *
 * 这里只列判据真正用到的字段，多余字段（label / verified_on …）保持可选，
 * 这样调用方传完整的 `PresetView` 也能用。
 */
export interface PresetLike {
  id: string;
  base_url: string;
  requires_api_key: boolean;
  aliases: string[];
  label?: string;
  verified_on?: string;
}

/**
 * 按 id 或别名认出当前配置对应的预设。
 *
 * 后端 `LlmConfig::to_cap` 用 `ProviderKind::parse_with_preset(&self.provider)`，
 * 它认别名（"kimi" / "智谱" / "月之暗面" 都能解析成预设身份）。
 * 前端此前只按 id 找，于是「后端认出是预设、前端认不出」——
 * 判据分裂的第二个来源：后端按预设的 `requires_api_key` 判，前端拿不到预设，
 * 只能退回地址猜测。
 */
export function findPreset<T extends PresetLike>(
  presets: T[],
  provider: string,
): T | undefined {
  if (!provider) return undefined;
  return presets.find(
    (p) => p.id === provider || p.aliases.includes(provider),
  );
}

/**
 * 这份配置要不要 API Key。
 *
 * 与后端 `LlmConfig::needs_api_key()` 严格同序：
 *
 * 1. 匹配到预设 → 按预设的 `requires_api_key`（用户显式选的厂商优先于地址猜测；
 *    哪怕地址被改成本机代理，只要预设登记了「要 Key」就仍然要）；
 * 2. 没匹配到预设（自定义服务）→ 看地址：私网免、公网要。
 *
 * @param presets 预设列表（来自 Rust `list_llm_presets`）。
 * @param provider 配置里的 provider 字段。
 * @param baseUrl 服务地址。
 */
export function llmNeedsApiKey(
  presets: PresetLike[],
  provider: string,
  baseUrl: string,
): boolean {
  const preset = findPreset(presets, provider);
  return needsApiKey(
    preset ? preset.requires_api_key : undefined,
    baseUrl,
  );
}
