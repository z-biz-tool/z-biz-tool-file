/**
 * 紧凑版 AI 服务设置：表单 + 弹窗外壳。
 *
 * ## 为什么要换掉共享面板那面「卡片墙」
 *
 * 共享面板 `z-biz-tool-shared/ai/settings` 的交互是 CC Switch 式的：
 * 18 家厂商的卡片分组铺开、每组一行三张卡。放在 560px 宽的居中 Modal 里，
 * 内容高度轻松超过一屏 —— 底部厂商被裁掉、动作按钮滚到视口外，
 * 用户只能看见半张设置窗（见 2026-11-09 的截图）。
 *
 * 这里换回「设置该有的样子」：
 * - **一个带分组的下拉**替掉卡片墙：18 家仍能一眼扫到、可搜索，但只占一行；
 * - **固定高度 + 内部滚动**：密钥 / 模型 / 高级永远够得着，底部动作条不随内容滚走；
 * - **状态条常驻**：当前服务商、模型、是否已配置，一进设置就能看见。
 *
 * ## 判据仍然只有一份
 *
 * 要不要密钥、算不算配好、切厂商时地址怎么变，全部调用 shared 的
 * `draftNeedsApiKey` / `draftIsConfigured` / `applyPresetToDraft` —— 它们是
 * Rust `needs_api_key()` 的镜像。本文件一行判据都不重写，只负责排版。
 * 密钥也照旧不回显：留空 = 不修改，删除要点明确的按钮。
 *
 * 颜色、圆角、间距一律取 `theme.useToken()`，亮/深主题自动跟随，
 * 不写死任何色值（db 板块有静态门禁在盯这件事）。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  AutoComplete,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from "antd";
import type { SelectProps } from "antd";
import {
  ApiOutlined,
  CheckCircleFilled,
  DeleteOutlined,
  KeyOutlined,
  ReloadOutlined,
  RobotOutlined,
  SaveOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  applyPresetToDraft,
  draftIsConfigured,
  draftNeedsApiKey,
  emptyDraft,
  findPreset,
  groupPresets,
  toDraft,
} from "z-biz-tool-shared/ai/settings";
import type {
  AiConfigDraft,
  AiSettingsActions,
  LlmFailure,
  PresetView,
} from "z-biz-tool-shared/ai/settings";

import { notifyAiConfigSaved } from "../_shared/aiConfigEvents";

const { Text } = Typography;

/** 后端脱敏视图的最小形状：各仓字段名略有出入，这里只取用得到的几项。 */
export interface AiSettingsView {
  provider?: string;
  preset?: string;
  baseUrl?: string;
  base_url?: string;
  model?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  max_tokens?: number | null;
  timeoutMs?: number | null;
  timeout_ms?: number | null;
  hasApiKey?: boolean;
}

/** 后端回的 `null` 与 shared 判据期望的 `undefined` 之间做一次显式归一。 */
function viewToDraftInput(view: AiSettingsView | null): Parameters<typeof toDraft>[0] {
  if (!view) return {};
  return {
    preset: view.preset ?? view.provider ?? "",
    baseUrl: view.baseUrl ?? view.base_url ?? "",
    model: view.model ?? "",
    temperature: view.temperature ?? undefined,
    maxTokens: (view.maxTokens ?? view.max_tokens) ?? undefined,
    timeoutMs: (view.timeoutMs ?? view.timeout_ms) ?? undefined,
  };
}

/** 把各仓抛出来的错误收敛成结构化失败（与共享面板同口径）。 */
function toFailure(e: unknown): LlmFailure {
  if (e && typeof e === "object") {
    const obj = e as Partial<LlmFailure> & { error?: string; failure?: LlmFailure };
    if (obj.failure && typeof obj.failure === "object") return obj.failure;
    if (typeof obj.message === "string" && obj.message) {
      return {
        kind: obj.kind ?? "unknown",
        status: obj.status ?? null,
        message: obj.message,
        hint: obj.hint ?? "",
        focus: obj.focus ?? "none",
      };
    }
    if (typeof obj.error === "string" && obj.error) {
      return { kind: "unknown", status: null, message: obj.error, hint: "", focus: "none" };
    }
  }
  return {
    kind: "unknown",
    status: null,
    message: typeof e === "string" ? e : "未知错误",
    hint: "",
    focus: "none",
  };
}

export interface AiSettingsFormProps {
  view: AiSettingsView | null;
  actions: AiSettingsActions;
  /** 保存成功。调用方负责刷新状态和关窗。 */
  onSaved?: () => void;
  /** 给了才显示「取消」按钮。 */
  onCancel?: () => void;
  /** 内容区最大高度。嵌在别的 Modal 里时可以调小。 */
  scrollMax?: string;
}

/** 紧凑表单。弹窗与全局设置中心共用同一份实现，避免两套设置长得不一样。 */
export function AiSettingsForm({
  view,
  actions,
  onSaved,
  onCancel,
  scrollMax = "min(68vh, 560px)",
}: AiSettingsFormProps) {
  const { token } = theme.useToken();

  const [draft, setDraft] = useState<AiConfigDraft>(() => ({
    ...emptyDraft(),
    ...toDraft(viewToDraftInput(view)),
  }));
  const [presets, setPresets] = useState<PresetView[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loadingPresets, setLoadingPresets] = useState(true);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<LlmFailure | null>(null);
  const [okText, setOkText] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [keyCleared, setKeyCleared] = useState(false);

  // 外部回读的配置变化时同步（保存成功后调用方会刷新 view）。
  useEffect(() => {
    if (view) setDraft((d) => ({ ...d, ...toDraft(viewToDraftInput(view)) }));
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    setLoadingPresets(true);
    actions
      .listPresets()
      .then((list) => {
        if (!cancelled) setPresets(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        // 拿不到预设就退回「自定义」手填地址，不假装一家都没有。
        if (!cancelled) setPresets([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingPresets(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actions]);

  const groups = useMemo(() => groupPresets(presets), [presets]);
  const currentPreset = useMemo(
    () => findPreset(presets, draft.preset, draft.baseUrl),
    [presets, draft.preset, draft.baseUrl],
  );
  const needsKey = useMemo(() => draftNeedsApiKey(presets, draft), [presets, draft]);
  const configured = useMemo(
    () => draftIsConfigured(presets, draft, view?.hasApiKey === true && !keyCleared),
    [presets, draft, view?.hasApiKey, keyCleared],
  );
  const hasSavedKey = view?.hasApiKey === true && !keyCleared;

  const providerOptions: NonNullable<SelectProps["options"]> = useMemo(
    () => [
      { value: "", label: "自定义（OpenAI 兼容 / 自建代理）" },
      ...groups.map((g) => ({
        label: g.label,
        options: g.items.map((p) => ({ value: p.id, label: p.label })),
      })),
    ],
    [groups],
  );

  const patch = (p: Partial<AiConfigDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setFailure(null);
    setOkText(null);
  };

  const pick = (presetId: string) => {
    patch(applyPresetToDraft(draft, presets, presetId));
    setModels([]);
    // 选了厂商就不必看地址；自定义才自动展开。
    setAdvancedOpen(!presetId);
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    setFailure(null);
    try {
      const list = await actions.listModels(draft);
      const arr = Array.isArray(list) ? list : [];
      setModels(arr);
      if (!arr.length) {
        setFailure({
          kind: "notConfigured",
          message: "服务端没有返回任何模型",
          hint: "该服务可能不实现 /models 接口，请手动填写模型名",
          focus: "model",
        });
      }
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setFetchingModels(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setFailure(null);
    setOkText(null);
    try {
      const res = await actions.testConnection(draft);
      if (res.ok) setOkText(res.detail || "连接正常，服务可用");
      else setFailure(res.failure ?? toFailure(res));
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setFailure(null);
    setOkText(null);
    try {
      await actions.save(draft);
      notifyAiConfigSaved();
      onSaved?.();
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setSaving(false);
    }
  };

  const sectionLabel: ReactNode = (
    <span style={{ fontSize: 12, color: token.colorTextTertiary }}>
      {currentPreset
        ? `已按 ${currentPreset.label} 的标准地址填好，密钥只存本机`
        : "自定义服务需要填兼容 OpenAI 协议的完整地址"}
    </span>
  );

  return (
    <div
      data-testid="ai-settings-compact"
      style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
    >
      <div
        style={{
          maxHeight: scrollMax,
          overflowY: "auto",
          padding: "16px 20px 20px",
        }}
      >
        {/* 状态条：进来先看清「现在用的是谁、能不能用」 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "10px 12px",
            marginBottom: 16,
            borderRadius: token.borderRadius,
            background: token.colorFillQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Tag
            color={configured ? "success" : "warning"}
            icon={configured ? <CheckCircleFilled /> : undefined}
            style={{ margin: 0 }}
          >
            {configured ? "已就绪" : "待配置"}
          </Tag>
          <Text style={{ fontSize: 13 }}>
            {currentPreset?.label ?? (draft.baseUrl ? "自定义服务" : "未选择服务商")}
            {draft.model ? ` · ${draft.model}` : ""}
          </Text>
          {!configured && (
            <Text type="secondary" style={{ fontSize: 12, marginLeft: "auto" }}>
              {needsKey && !hasSavedKey && !draft.apiKey.trim() ? "还缺 API Key" : "还缺模型名"}
            </Text>
          )}
        </div>

        <Form layout="vertical" size="middle">
          <Form.Item
            label="服务商"
            extra={sectionLabel}
            style={{ marginBottom: 16 }}
          >
            <Space.Compact style={{ width: "100%" }}>
              <Select
                style={{ flex: 1 }}
                value={draft.preset}
                options={providerOptions}
                showSearch
                optionFilterProp="label"
                placeholder="选择服务商，或自定义"
                loading={loadingPresets}
                onChange={pick}
              />
              <Tooltip title="重新读取服务商列表">
                <Button
                  icon={<ReloadOutlined />}
                  aria-label="重新读取服务商列表"
                  loading={loadingPresets}
                  onClick={() => {
                    setLoadingPresets(true);
                    actions
                      .listPresets()
                      .then((list) => setPresets(Array.isArray(list) ? list : []))
                      .catch(() => setPresets([]))
                      .finally(() => setLoadingPresets(false));
                  }}
                />
              </Tooltip>
            </Space.Compact>
          </Form.Item>

          {needsKey ? (
            <Form.Item
              label={
                <Space size={6}>
                  <KeyOutlined />
                  <span>API Key</span>
                  {hasSavedKey && (
                    <Tag color="success" style={{ margin: 0 }}>
                      已保存（不回显）
                    </Tag>
                  )}
                </Space>
              }
              extra={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {hasSavedKey
                    ? "留空表示保持原密钥不变；密钥只保存在本机系统密钥库，不会上传到任何服务器"
                    : "密钥只保存在本机系统密钥库，不会上传到任何服务器"}
                </Text>
              }
              style={{ marginBottom: 16 }}
            >
              <Space.Compact style={{ width: "100%" }}>
                <Input.Password
                  value={draft.apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={hasSavedKey ? "留空则保持原密钥不变" : "粘贴服务商后台生成的 API Key"}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                />
                {hasSavedKey && (
                  <Tooltip title="清空后保存即可删除已保存的密钥">
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      aria-label="删除已保存的密钥"
                      onClick={() => {
                        patch({ apiKey: "" });
                        setKeyCleared(true);
                        setOkText("已清空，保存后即删除本机保存的密钥");
                      }}
                    />
                  </Tooltip>
                )}
              </Space.Compact>
            </Form.Item>
          ) : (
            <Alert
              type="success"
              showIcon
              title="该服务无需 API Key"
              description="本地或内网服务，直接用即可 —— 不会有密钥框。"
              style={{ marginBottom: 16 }}
            />
          )}

          <Form.Item
            label="模型"
            extra={
              <Text type="secondary" style={{ fontSize: 12 }}>
                模型名各家半年一换，可从服务端拉取，也可以直接手填。
              </Text>
            }
            style={{ marginBottom: 16 }}
          >
            <Space.Compact style={{ width: "100%" }}>
              <AutoComplete
                style={{ flex: 1 }}
                value={draft.model}
                options={models.map((m) => ({ value: m }))}
                placeholder="选择或直接输入模型名"
                onChange={(v) => patch({ model: v })}
                filterOption={(input, option) =>
                  String(option?.value ?? "").toLowerCase().includes(input.trim().toLowerCase())
                }
              />
              <Button
                icon={<ReloadOutlined />}
                loading={fetchingModels}
                disabled={needsKey && !draft.apiKey.trim() && !hasSavedKey}
                onClick={() => void fetchModels()}
              >
                {fetchingModels ? "获取中…" : "获取模型"}
              </Button>
            </Space.Compact>
          </Form.Item>

          <Collapse
            size="small"
            activeKey={advancedOpen ? ["adv"] : []}
            onChange={(k) => setAdvancedOpen((k as string[]).length > 0)}
            items={[
              {
                key: "adv",
                label: "高级设置（地址与采样参数）",
                children: (
                  <Form layout="vertical">
                    <Form.Item label="Base URL" style={{ marginBottom: 12 }}>
                      <Input
                        value={draft.baseUrl}
                        placeholder="https://api.openai.com/v1"
                        onChange={(e) => patch({ baseUrl: e.target.value })}
                      />
                    </Form.Item>
                    <Space size={12} wrap>
                      <Form.Item label="温度" style={{ marginBottom: 0 }}>
                        <InputNumber
                          min={0}
                          max={2}
                          step={0.1}
                          value={draft.temperature}
                          onChange={(v) => patch({ temperature: v ?? undefined })}
                        />
                      </Form.Item>
                      <Form.Item label="最大 Token" style={{ marginBottom: 0 }}>
                        <InputNumber
                          min={1}
                          value={draft.maxTokens}
                          onChange={(v) => patch({ maxTokens: v ?? undefined })}
                        />
                      </Form.Item>
                      <Form.Item label="超时（毫秒）" style={{ marginBottom: 0 }}>
                        <InputNumber
                          min={1000}
                          step={1000}
                          value={draft.timeoutMs}
                          onChange={(v) => patch({ timeoutMs: v ?? undefined })}
                        />
                      </Form.Item>
                    </Space>
                  </Form>
                ),
              },
            ]}
          />
        </Form>

        {failure && (
          <Alert
            type="error"
            showIcon
            title={failure.message}
            description={
              <Space orientation="vertical" size={2}>
                {failure.hint && <span>{failure.hint}</span>}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {failure.status ? `HTTP ${failure.status} · ${failure.kind}` : failure.kind}
                </Text>
              </Space>
            }
            style={{ marginTop: 16 }}
          />
        )}
        {okText && (
          <Alert type="success" showIcon title={okText} style={{ marginTop: 16 }} />
        )}
      </div>

      {/* 动作条不跟着内容滚走：长表单也能随时保存 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 20px",
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          配置只保存在本机
        </Text>
        <Space size={8}>
          {onCancel && <Button onClick={onCancel}>取消</Button>}
          <Button
            icon={<ApiOutlined />}
            loading={testing}
            disabled={!configured}
            onClick={() => void testConnection()}
          >
            测试连接
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!draft.model.trim()}
            onClick={() => void save()}
          >
            保存
          </Button>
        </Space>
      </div>
    </div>
  );
}

export interface AiSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** 读脱敏视图。传稳定的函数引用（各仓的 loadAiConfigView 即可）。 */
  loadView: () => Promise<AiSettingsView>;
  /** 动作工厂：只在首次渲染时调用一次，避免每次渲染都换引用触发重拉预设。 */
  createActions: () => AiSettingsActions;
  onSaved?: () => void;
  title?: string;
  subtitle?: string;
}

/** 独立的设置弹窗。外壳负责取数与固定宽度，排版全交给 AiSettingsForm。 */
export default function AiSettingsDialog({
  open,
  onClose,
  loadView,
  createActions,
  onSaved,
  title = "AI 服务设置",
  subtitle = "一次配置，所有板块共用",
}: AiSettingsDialogProps) {
  const { token } = theme.useToken();
  const actionsRef = useRef<AiSettingsActions | null>(null);
  if (!actionsRef.current) actionsRef.current = createActions();

  const [view, setView] = useState<AiSettingsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    loadView()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        // 读不出来不挡填表：当没配过从头填，保存会覆盖。
        if (!cancelled) setView(null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          // 每次打开都重挂表单，免得上一次未保存的草稿留到这一轮。
          setNonce((n) => n + 1);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, loadView]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
      centered
      destroyOnHidden
      styles={{
        body: { padding: 0 },
        header: {
          marginBottom: 0,
          padding: "14px 20px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        },
      }}
      title={
        <Space size={12} align="center">
          <span
            style={{
              width: 32,
              height: 32,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: token.borderRadius,
              background: token.colorPrimaryBg,
              color: token.colorPrimary,
              fontSize: 16,
            }}
          >
            <RobotOutlined />
          </span>
          <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.35 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{title}</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: token.colorTextTertiary }}>
              {subtitle}
            </span>
          </span>
        </Space>
      }
    >
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spin description="正在读取本机配置…" />
        </div>
      ) : (
        <AiSettingsForm
          key={nonce}
          view={view}
          actions={actionsRef.current!}
          onCancel={onClose}
          onSaved={onSaved}
          scrollMax="min(70vh, 620px)"
        />
      )}
    </Modal>
  );
}

/** 给全局设置中心用的小图标（避免出现第二种设置图标口径）。 */
export function AiSettingsIcon() {
  return <SettingOutlined />;
}
