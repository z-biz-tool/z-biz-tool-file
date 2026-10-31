// file 仓前端「要不要 API Key」判据的契约回归。
//
// ## 为什么要有这条
//
// 后端 cap-llm 的 `LlmConfig::needs_api_key()` 已经统一了免密钥判定。
// 前端也得判同一件事（密钥框要不要露、能不能保存），否则出现**判据分裂**：
// 后端放行、前端拦下 ⇒ 用户看到「本地网关配了却用不了」，
// 而**没有任何编译错误**能暴露它。
//
// 金标：Rust `cap_llm::is_private_endpoint()` 与 `LlmConfig::needs_api_key()`。
// 共享层 `z-biz-tool-shared/ai` 的 `needsApiKey()` 是它的逐条镜像。
//
// ## 契约
//
// 1. 选了「免 Key」的预设（zbiz-local / ollama）→ 免；
// 2. 选了「要 Key」的预设 → 要，**哪怕地址被改成本机代理**
//    （用户显式选的厂商优先于地址猜测）；
// 3. 没匹配到预设（自定义服务）→ 看地址：私网免、公网要。
//
// 第 2 条最容易被写反：只判「预设说不免」而不判「预设说要」，
// 会让「选了 DeepSeek 但地址指向本机代理」被私网规则救掉，
// 于是请求没带鉴权头发出去、拿到 401，而用户完全不知道为什么。
import { describe, expect, it } from "vitest";
import {
  findPreset,
  llmNeedsApiKey,
  type PresetLike,
} from "../src/lib/llmNeedsKey";

const preset = (
  id: string,
  requiresApiKey: boolean,
  aliases: string[] = [],
): PresetLike => ({
  id,
  base_url: "http://127.0.0.1:8200/v1",
  requires_api_key: requiresApiKey,
  aliases,
});

const PRESETS: PresetLike[] = [
  preset("zbiz-local", false, ["zbiz", "本地网关", "智工栈"]),
  preset("ollama", false, []),
  preset("deepseek", true, []),
];

describe("预设查找：认 id 也认别名", () => {
  it("按 id 认得出", () => {
    expect(findPreset(PRESETS, "zbiz-local")?.id).toBe("zbiz-local");
  });

  it("按别名认得出（后端 parse_with_preset 认别名，前端也得认）", () => {
    // 后端 `to_cap` 用 `ProviderKind::parse_with_preset(&provider)`，
    // 它认别名。前端只按 id 找 ⇒ 同一个 provider 两边得出不同结论。
    expect(findPreset(PRESETS, "本地网关")?.id).toBe("zbiz-local");
    expect(findPreset(PRESETS, "智工栈")?.id).toBe("zbiz-local");
  });

  it("没登记过的 provider 认不出（不得当成已知厂商）", () => {
    expect(findPreset(PRESETS, "some-unknown-llm")).toBeUndefined();
  });

  it("空 provider 认不出", () => {
    expect(findPreset(PRESETS, "")).toBeUndefined();
  });
});

describe("要不要 Key —— 与后端 needs_api_key 同序", () => {
  it("免 Key 预设：免", () => {
    expect(llmNeedsApiKey(PRESETS, "zbiz-local", "http://127.0.0.1:8200/v1")).toBe(
      false,
    );
  });

  it("免 Key 预设按别名选中：一样免", () => {
    expect(llmNeedsApiKey(PRESETS, "本地网关", "http://127.0.0.1:8200/v1")).toBe(
      false,
    );
  });

  it("自定义私网地址：免（用户直接粘 mini 的地址，没选预设）", () => {
    // 这是本次修的核心缺口：此前一律要 Key ⇒ 用户被逼填一个无处可用的密钥。
    expect(
      llmNeedsApiKey(PRESETS, "custom", "http://192.168.31.249:8200/v1"),
    ).toBe(false);
  });

  it("自定义公网地址：要", () => {
    expect(
      llmNeedsApiKey(PRESETS, "custom", "https://api.openai.com/v1"),
    ).toBe(true);
  });

  it("选了要 Key 的云厂商：即便地址是本机代理也要", () => {
    // 契约第 2 条的反向约束 —— 放行的话请求会没带鉴权头发出去、拿到 401。
    expect(
      llmNeedsApiKey(PRESETS, "deepseek", "http://127.0.0.1:8200/v1"),
    ).toBe(true);
  });

  it("阴性对照：同一判据对私网与公网必须给出相反结论", () => {
    // 判据被改成永真时这条立刻红。而恒真的判据会让本地网关用户被静默放行、
    // 公网用户被静默拦下 —— 两种故障都不会有人来报。
    const priv = llmNeedsApiKey(PRESETS, "custom", "http://192.168.31.249:8200/v1");
    const pub = llmNeedsApiKey(PRESETS, "custom", "https://api.openai.com/v1");
    expect(priv).not.toBe(pub);
    expect(priv).toBe(false);
    expect(pub).toBe(true);
  });
});
