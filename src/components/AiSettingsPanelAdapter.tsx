/**
 * 统一 AI 配置面板的本仓适配层（照抄 terminal 样板）。
 *
 * ## 这一层只做三件事
 *
 * 1. 把本仓的 Tauri IPC 包成共享面板认得的 `actions` 接口；
 * 2. 把共享面板的草稿结构翻译成本仓后端认的形状（camelCase，含
 *    `timeoutSecs` 换算 —— 本仓草稿单位是秒，统一落点存毫秒）；
 * 3. 把后端的结构化失败原样透传 —— **不重新翻译错误文案**。
 *
 * ## 为什么第③条重要
 *
 * 错误文案是后端给的（`LlmFailure.hint` 与 `focus` 必须一致）。
 * 前端再翻译一遍就会漂移，而漂移的表现是「提示说去改密钥，
 * 光标却跳到地址栏」—— 用户按提示操作但没用。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  AiSettingsPanel,
  type AiConfigDraft,
  type AiSettingsActions,
  type AiSettingsPanelProps,
  type LlmFailure,
  type PresetView,
} from "z-biz-tool-shared/ai/settings";

/**
 * 本仓后端的草稿形状（`llm_config.rs::AiConfigDraft`）。
 *
 * ⚠️ 字段名是 **camelCase**，不是 snake_case —— 嵌套结构体走 serde，
 * 键名以结构体上的 `#[serde(rename_all = "camelCase")]` 为准；
 * Tauri 只对**顶层命令参数**做 snake→camel 映射。写 snake_case 的后果
 * 不是报错，而是 serde **静默丢弃** ⇒ base_url / api_key 全变空串 ⇒
 * 用户填了密钥却存不进去，且没有任何报错能暴露它。
 * （2026-11-01 在 db 仓实测嵌套 camel/snake 差异后修正。）
 */
interface FileAiConfigDraft {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number | null;
  maxTokens: number | null;
  timeoutSecs: number | null;
}

/** 草稿 → 本仓配置形状（送 IPC 用）。`apiKey` 透传：留空表示继承已保存的。 */
function draftToConfig(draft: AiConfigDraft): FileAiConfigDraft {
  return {
    provider: draft.preset,
    baseUrl: draft.baseUrl,
    model: draft.model,
    apiKey: draft.apiKey,
    temperature: draft.temperature ?? null,
    maxTokens: draft.maxTokens ?? null,
    timeoutSecs: draft.timeoutMs != null ? Math.round(draft.timeoutMs / 1000) : null,
  };
}

/** 后端失败 → 共享面板的失败结构。字段名一致，直接透传。 */
function toPanelFailure(raw: unknown): LlmFailure {
  const f = (raw ?? {}) as Partial<LlmFailure> & {
    error?: string;
    message?: string;
  };
  return {
    kind: f.kind ?? "unknown",
    status: f.status ?? null,
    message: f.message ?? f.error ?? "未知错误",
    hint: f.hint ?? "",
    focus: (f.focus as LlmFailure["focus"]) ?? "none",
  };
}

/**
 * 本仓的 actions 实现。
 *
 * 每个方法都**不吞异常**：异常必须冒到面板，由面板统一渲染成
 * 结构化失败。吞掉异常 = 用户看到「操作没反应」。
 */
export function createAiSettingsActions(): AiSettingsActions {
  return {
    async listPresets(): Promise<PresetView[]> {
      const list = await invoke<PresetView[]>("list_llm_presets");
      return Array.isArray(list) ? list : [];
    },

    async listModels(draft: AiConfigDraft): Promise<string[]> {
      try {
        const models = await invoke<string[]>("list_llm_models", {
          overrideConfig: draftToConfig(draft),
        });
        return Array.isArray(models) ? models : [];
      } catch (e) {
        throw toPanelFailure(e);
      }
    },

    async testConnection(draft: AiConfigDraft) {
      try {
        const detail = await invoke<string>("test_ai_config", {
          overrideConfig: draftToConfig(draft),
        });
        return { ok: true, detail };
      } catch (e) {
        return { ok: false, failure: toPanelFailure(e) };
      }
    },

    async save(draft: AiConfigDraft): Promise<boolean> {
      await invoke("save_ai_config", { config: draftToConfig(draft) });
      return true;
    },
  };
}

/** 后端脱敏视图（`llm_config.rs::AiConfigView`）。 */
export interface FileAiConfigView {
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  /** 恒为空串。 */
  apiKey: string;
  hasApiKey: boolean;
}

/** 读已保存的配置（脱敏视图）。 */
export function loadAiConfigView(): Promise<FileAiConfigView> {
  return invoke<FileAiConfigView>("get_ai_config");
}

/**
 * 本仓的 AI 配置面板（直接复用共享面板）。
 */
export function FileAiSettingsPanel({
  view,
  onSaved,
}: {
  view: FileAiConfigView | null;
  onSaved?: () => void;
}) {
  const props: AiSettingsPanelProps = {
    value: view
      ? {
          preset: view.provider,
          baseUrl: view.baseUrl,
          model: view.model,
          temperature: view.temperature ?? undefined,
          maxTokens: view.maxTokens ?? undefined,
        }
      : undefined,
    hasApiKey: view?.hasApiKey === true,
    actions: createAiSettingsActions(),
    onSaved,
  };
  return <AiSettingsPanel {...props} />;
}
