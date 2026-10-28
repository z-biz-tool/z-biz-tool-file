/**
 * 设置面板。
 *
 * ## 2026-10-28 交互改造
 *
 * 改造前这里的问题，按用户走一遍配置流程的顺序排：
 *
 * 1. **只有 4 个服务商可选**（OpenAI / Anthropic / Ollama / 自定义）。
 *    买 DeepSeek、通义、Kimi、智谱、豆包的用户只能选「自定义」，然后
 *    **手抄** base_url。抄错一个字符就是 404，而 404 的报错里不会说
 *    「你地址写错了」—— 用户只会觉得「这软件连不上」。
 *
 * 2. **前端有一张自己的预设表**（`PROVIDER_PRESETS` 常量），和 Rust 侧
 *    `cap-llm::presets` 是两份会漂移的数据。而且那张表里的模型名
 *    （`gpt-4o-mini` / `claude-3-5-sonnet-latest`）在 2026 年早已停服，
 *    用户照着填只会拿到「模型不存在」。
 *    → 现在预设一律从 Rust 取（`list_llm_presets`），单一事实源。
 *
 * 3. **模型名靠盲填**。用户知道自己买了 DeepSeek，但不知道模型叫什么。
 *    → 加了「获取模型列表」，从该 key 实际可用的模型里选。
 *
 * 4. **切换服务商会静默清掉已填的地址**。用户手填了公司代理地址，
 *    切一下服务商就被覆盖成官方地址，且没有任何提示。
 *    → 现在区分「跟着预设走的地址」和「用户自己改过的地址」，后者不覆盖。
 *
 * 5. **测试失败只显示一句英文/URL**。用户不知道下一步做什么。
 *    → 后端返回结构化失败（kind + status + hint），界面按类别给动作按钮。
 *
 * 6. **9 处硬编码浅色**（#f6ffed / #fff1f0 / #f0f5ff …），暗色模式下
 *    深底浅字刺眼或读不出来。→ 全部换成 AntD 令牌。
 */

import { useState, useEffect, useMemo, useRef } from "react";
import type { InputRef } from "antd";
import {
  Alert,
  AutoComplete,
  Button,
  Collapse,
  Form,
  Input,
  Modal,
  Select,
  Slider,
  Space,
  Tabs,
  Tag,
  Typography,
  App as AntdApp,
} from "antd";
import {
  SettingOutlined,
  RobotOutlined,
  ApiOutlined,
  FolderOpenOutlined,
  KeyOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

const { Text } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
}

interface LlmConfig {
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
  timeout_secs: number;
  temperature: number;
}

/** 后端 `PresetView` 的镜像。字段名与 Rust serde 输出一致，不要自行改名。 */
interface PresetView {
  id: string;
  label: string;
  base_url: string;
  category: string;
  category_label: string;
  requires_api_key: boolean;
  aliases: string[];
  verified_on: string;
}

/**
 * 后端 `LlmFailure` 的镜像。
 *
 * `kind` 是**机器可判**的类别，界面靠它决定给什么动作；
 * `hint` 是给用户的一句话 + 一个动作。两者分工明确：
 * 需要分支时读 `kind`，需要显示时读 `hint` —— 绝不靠正则去解析 `message`。
 */
interface LlmFailure {
  kind: string;
  status?: number | null;
  message: string;
  hint: string;
}

const DEFAULT_CONFIG: LlmConfig = {
  provider: "openai",
  api_key: "",
  base_url: "",
  model: "",
  timeout_secs: 60,
  temperature: 0.7,
};

/** 「自定义」是伪预设：它不属于任何厂商，地址必须用户自己填。 */
const CUSTOM_ID = "custom";

/** 分组顺序：把国内厂商放前面 —— 本仓的主要用户在这里。 */
const CATEGORY_ORDER = ["domestic", "international", "aggregator", "selfHosted"] as const;

/** 把 Tauri 的 reject 值归一成 LlmFailure。 */
function asFailure(e: unknown): LlmFailure {
  if (e && typeof e === "object" && "hint" in e && "kind" in e) {
    return e as LlmFailure;
  }
  // 其它命令仍可能以字符串报错。如实显示原话，不编一个假的 hint ——
  // 「显示得不好看」远好于「显示得像模像样但是错的」。
  const message = typeof e === "string" ? e : String((e as { message?: string })?.message ?? e);
  return { kind: "unknown", status: null, message, hint: message };
}

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; text: string }
  | { status: "fail"; failure: LlmFailure };

/** 下拉里的一个服务商。`searchText` 只服务于搜索，不显示。 */
interface ProviderOption {
  value: string;
  label: string;
  searchText: string;
}

interface ProviderGroup {
  label: string;
  options: ProviderOption[];
}

export default function SettingsModal({ open, onClose }: Props) {
  const { message, modal } = AntdApp.useApp();
  const [config, setConfig] = useState<LlmConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState<LlmConfig>(DEFAULT_CONFIG);
  const [presets, setPresets] = useState<PresetView[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [showAdvanced, setShowAdvanced] = useState<string[]>([]);
  const keyRef = useRef<InputRef>(null);

  // ── 载入 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setTest({ status: "idle" });
    setModels([]);

    // 预设表并发取：它决定下拉里有什么，取失败也不该挡住用户填表
    invoke<PresetView[]>("list_llm_presets")
      .then(setPresets)
      .catch((e) => {
        // 这条失败会让界面退化成只剩「自定义」，必须留痕而不是静默
        console.error("[settings] 预设表加载失败，将退化为仅自定义：", e);
      });

    invoke<LlmConfig>("load_llm_config")
      .then((c) => {
        const merged = { ...DEFAULT_CONFIG, ...c };
        setConfig(merged);
        setSaved(merged);
      })
      .catch((err) => message.error("加载配置失败: " + err))
      .finally(() => setLoading(false));

    invoke<string>("get_llm_config_path")
      .then(setConfigPath)
      .catch((e) => {
        console.warn("[settings] 读不到配置文件路径:", e);
      });
  }, [open]);

  const preset = useMemo(
    () => presets.find((p) => p.id === config.provider),
    [presets, config.provider],
  );

  // ── 地址归属判断 ────────────────────────────────────────────────────
  //
  // 「这个地址是用户自己填的，还是我们按预设帮他填的？」
  // 只用于**界面提示**（告诉他这个地址是他自己的，以及给一条恢复入口）。
  // 不用于决定「切换服务商时要不要覆盖」—— 见 onProviderChange 里的说明。
  const baseIsUserOwned = useMemo(() => {
    if (!preset) return false; // 自定义模式下地址本来就全是用户填的，提示是噪音
    const v = config.base_url.trim();
    if (!v) return false;
    return v !== preset.base_url;
  }, [config.base_url, preset]);

  const needsKey = preset ? preset.requires_api_key : true;
  const hasKey = config.api_key.trim().length > 0;
  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(saved),
    [config, saved],
  );

  // ── 服务商切换 ──────────────────────────────────────────────────────
  //
  // 规则只有一条，但要能背下来：
  //   **切到某家厂商 ⇒ 用该厂商的标准地址；切到「自定义」⇒ 保留现有地址让他改。**
  //
  // 为什么不保留「用户手改过的地址」：用户把 DeepSeek 的地址改成公司代理，
  // 再切到智谱时，那个代理地址对新厂商毫无意义。留着它 = 请求打向一个
  // 不知道自己被用来问智谱的代理，最后拿到 404 或更糟的错答案。
  // 「切谁用谁的地址」是可预期的，用户看到地址变了也知道发生了什么。
  const onProviderChange = (id: string) => {
    const next = presets.find((p) => p.id === id);
    setConfig((c) => ({
      ...c,
      provider: id,
      base_url: next ? next.base_url : c.base_url,
    }));
    // 上一家的模型列表对新厂商无意义，必须清掉；
    // 否则下拉里会摆着「deepseek-chat」而用户已经切到智谱
    setModels([]);
    setTest({ status: "idle" });
  };

  // ── 测试连接 ────────────────────────────────────────────────────────
  const onTest = async () => {
    setTesting(true);
    setTest({ status: "testing" });
    try {
      const text = await invoke<string>("test_llm_config", { config });
      setTest({ status: "ok", text });
    } catch (e) {
      setTest({ status: "fail", failure: asFailure(e) });
    } finally {
      setTesting(false);
    }
  };

  // ── 获取模型列表 ────────────────────────────────────────────────────
  const onFetchModels = async () => {
    setFetchingModels(true);
    try {
      const list = await invoke<string[]>("list_llm_models", { config });
      setModels(list);
      if (list.length === 0) {
        message.warning("该服务返回了空模型列表，请手动填写模型名");
      } else {
        // 用户还没填模型时，直接替他选第一个（列表已按「能聊天」排序）
        if (!config.model.trim()) {
          setConfig((c) => ({ ...c, model: list[0] }));
        }
        message.success(`取到 ${list.length} 个模型`);
      }
    } catch (e) {
      const f = asFailure(e);
      // 这里不复用测试结果的 Alert：用户点的是「获取模型列表」，
      // 失败原因要贴着这个按钮说，否则他会以为是「测试连接」失败了
      modal.error({
        title: "获取模型列表失败",
        content: (
          <div style={{ fontSize: 13 }}>
            <p style={{ marginBottom: 8 }}>{f.hint}</p>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {f.message}
            </Text>
          </div>
        ),
      });
    } finally {
      setFetchingModels(false);
    }
  };

  // ── 保存 ────────────────────────────────────────────────────────────
  const onSave = async () => {
    if (!config.provider.trim()) {
      message.warning("请选择服务商");
      return;
    }
    if (!config.base_url.trim()) {
      message.warning("请填写 Base URL");
      return;
    }
    if (!config.model.trim()) {
      message.warning("请填写模型名，或点「获取模型列表」选择");
      return;
    }
    if (needsKey && !hasKey) {
      message.warning("请填写 API Key");
      return;
    }
    setSaving(true);
    try {
      await invoke("save_llm_config", { config });
      setSaved(config);
      message.success("已保存");
    } catch (err) {
      message.error("保存失败: " + err);
    } finally {
      setSaving(false);
    }
  };

  // ── 关闭：有未保存改动先问 ──────────────────────────────────────────
  //
  // 用户可能刚粘了一个长密钥、或刚手抄完一段地址。直接关掉就白填了，
  // 而这类输入恰恰是最难重来的。
  const requestClose = () => {
    if (!dirty) {
      onClose();
      return;
    }
    modal.confirm({
      title: "放弃未保存的修改？",
      content: "刚填的服务商、密钥或模型名会丢失。",
      okText: "放弃修改",
      okButtonProps: { danger: true },
      cancelText: "继续编辑",
      onOk: onClose,
    });
  };

  // 选「自定义」时自动展开地址区 —— 这时地址是必填的，
  // 折起来等于让用户对着「测试失败」自己猜哪里没填。
  // 用函数式更新，避免把 showAdvanced 写进依赖（否则用户手动折叠会被弹回来）。
  useEffect(() => {
    if (config.provider !== CUSTOM_ID) return;
    setShowAdvanced((v) => (v.includes("adv") ? v : [...v, "adv"]));
  }, [config.provider]);

  // ── 下拉选项 ────────────────────────────────────────────────────────
  const providerOptions = useMemo<ProviderGroup[]>(() => {
    const groups: ProviderGroup[] = [];
    for (const cat of CATEGORY_ORDER) {
      const items: ProviderOption[] = presets
        .filter((p) => p.category === cat)
        .map((p) => ({
          value: p.id,
          label: p.label,
          // 搜索字段：中文名、英文名、别名、地址都能命中。
          // 用户记得「kimi」但界面写的是「Kimi（月之暗面）」，
          // 只按 label 匹配会让他以为什么都没有。
          searchText: [p.id, p.label, ...p.aliases, p.base_url].join(" ").toLowerCase(),
        }));
      if (!items.length) continue;
      groups.push({
        label: presets.find((p) => p.category === cat)?.category_label ?? cat,
        options: items,
      });
    }

    // 「自定义」不归任何分组：它是兜底，不是一家厂商
    groups.push({
      label: "其他",
      options: [
        {
          value: CUSTOM_ID,
          label: "自定义（OpenAI 兼容 / 自建代理）",
          searchText: "custom 自定义 自建 代理 openai 兼容",
        },
      ],
    });
    return groups;
  }, [presets]);

  const modelOptions = useMemo(
    () => models.map((m) => ({ value: m })),
    [models],
  );

  // 模型名可能在切换厂商后失效。这不是我们能离线判断的，
  // 但可以提醒 —— 比让用户自己撞 404 强。
  const modelStaleHint =
    preset && config.model.trim()
      ? `模型名若不属于 ${preset.label}，请点右侧「获取模型列表」重选；否则请求会报「模型不存在」。`
      : undefined;

  return (
    <Modal
      open={open}
      onCancel={requestClose}
      footer={null}
      width={720}
      title={
        <span>
          <SettingOutlined style={{ marginRight: 8 }} />
          设置
        </span>
      }
      destroyOnHidden
    >
      <Tabs
        defaultActiveKey="llm"
        items={[
          {
            key: "llm",
            label: (
              <span>
                <RobotOutlined /> AI / LLM
              </span>
            ),
            children: (
              <div style={{ padding: "8px 0" }}>
                <Form layout="vertical" style={{ marginTop: 4 }}>
                  {/* ① 服务商 */}
                  <Form.Item
                    label="服务商"
                    required
                    extra={
                      preset ? (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          地址已按 {preset.label} 标准值填好（核对于 {preset.verified_on}）
                          {baseIsUserOwned && "；当前用的是你自己填的地址"}
                          {!preset.requires_api_key && "；本地服务无需 API Key"}
                        </Text>
                      ) : (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          自定义服务需要你自己填写兼容 OpenAI 协议的完整地址。
                        </Text>
                      )
                    }
                  >
                    <Select
                      value={config.provider}
                      onChange={onProviderChange}
                      loading={loading}
                      showSearch
                      // 自定义过滤：按 searchText 匹配，这样才能用别名搜到
                      filterOption={(input, option) => {
                        const needle = input.trim().toLowerCase();
                        if (!needle) return true;
                        const hay = (option as { searchText?: string } | undefined)?.searchText;
                        return typeof hay === "string" && hay.includes(needle);
                      }}
                      options={providerOptions}
                      placeholder={presets.length ? "选择你的服务商" : "正在读取服务商列表…"}
                      notFoundContent={
                        presets.length ? "没有匹配的服务商" : "预设表读取失败，只能选「自定义」"
                      }
                    />
                  </Form.Item>

                  {/* ② 密钥 */}
                  {needsKey && (
                    <Form.Item
                      label={
                        <span>
                          <KeyOutlined style={{ marginRight: 4 }} />
                          API Key
                        </span>
                      }
                      required
                      extra={
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          仅保存在本机
                          {configPath ? `（${configPath}）` : ""}，不会上传到任何服务器
                        </Text>
                      }
                    >
                      <Input.Password
                        ref={keyRef}
                        value={config.api_key}
                        onChange={(e) => setConfig({ ...config, api_key: e.target.value })}
                        placeholder="粘贴服务商后台生成的 API Key"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Form.Item>
                  )}

                  {/* ③ 模型 */}
                  <Form.Item label="模型" required extra={
                    modelStaleHint ? (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {modelStaleHint}
                      </Text>
                    ) : undefined
                  }>
                    <Space.Compact style={{ width: "100%" }}>
                      <AutoComplete
                        style={{ flex: 1 }}
                        value={config.model}
                        options={modelOptions}
                        onChange={(v) => setConfig({ ...config, model: v })}
                        placeholder="选择或直接输入模型名"
                        // 允许自由输入：自建代理常常不实现 /models，
                        // 强行只让选会把这类用户彻底挡在门外
                        filterOption={(input, option) =>
                          String(option?.value ?? "")
                            .toLowerCase()
                            .includes(input.trim().toLowerCase())
                        }
                      />
                      <Button
                        icon={<ReloadOutlined />}
                        loading={fetchingModels}
                        disabled={needsKey && !hasKey}
                        title={
                          needsKey && !hasKey
                            ? "先填写 API Key 才能获取该服务商的模型列表"
                            : "从服务商读取可用模型"
                        }
                        onClick={() => void onFetchModels()}
                      >
                        获取模型列表
                      </Button>
                    </Space.Compact>
                  </Form.Item>

                  {/* ④ 高级：地址 / 温度 / 超时 */}
                  <Collapse
                    activeKey={showAdvanced}
                    onChange={(k) => setShowAdvanced(k as string[])}
                    size="small"
                    items={[
                      {
                        key: "adv",
                        label: "高级设置（地址、温度、超时）",
                        children: (
                          <Space direction="vertical" style={{ width: "100%" }} size="middle">
                            <Form.Item
                              label="Base URL"
                              style={{ marginBottom: 0 }}
                              extra={
                                baseIsUserOwned ? (
                                  <Space size={6}>
                                    <Text type="secondary" style={{ fontSize: 12 }}>
                                      这是你自己填的地址，切换服务商不会被覆盖。
                                    </Text>
                                    <Button
                                      type="link"
                                      size="small"
                                      style={{ padding: 0, fontSize: 12 }}
                                      onClick={() =>
                                        setConfig((c) => ({
                                          ...c,
                                          base_url: preset?.base_url ?? "",
                                        }))
                                      }
                                    >
                                      恢复为 {preset?.label ?? "默认"} 官方地址
                                    </Button>
                                  </Space>
                                ) : undefined
                              }
                            >
                              <Input
                                value={config.base_url}
                                onChange={(e) => setConfig({ ...config, base_url: e.target.value })}
                                placeholder="https://api.deepseek.com/v1"
                                spellCheck={false}
                              />
                            </Form.Item>

                            <Form.Item
                              label="温度（0 = 稳定，2 = 发散）"
                              style={{ marginBottom: 0 }}
                            >
                              <Slider
                                min={0}
                                max={2}
                                step={0.1}
                                value={config.temperature}
                                onChange={(t) => setConfig({ ...config, temperature: t })}
                                marks={{ 0: "0", 0.7: "0.7", 2: "2" }}
                              />
                            </Form.Item>

                            <Form.Item label="请求超时（秒）" style={{ marginBottom: 0 }}>
                              <Slider
                                min={10}
                                max={300}
                                step={10}
                                value={config.timeout_secs}
                                onChange={(t) => setConfig({ ...config, timeout_secs: t })}
                                marks={{ 10: "10s", 60: "60s", 300: "300s" }}
                              />
                            </Form.Item>
                          </Space>
                        ),
                      },
                    ]}
                  />

                  {/* ⑤ 测试结果 */}
                  <div style={{ marginTop: 16 }}>
                    {test.status === "ok" && (
                      <Alert type="success" showIcon message={test.text} />
                    )}
                    {test.status === "fail" && (
                      <FailureAlert
                        failure={test.failure}
                        onRefillKey={() => keyRef.current?.focus()}
                        onRestoreBase={() =>
                          setConfig((c) => ({ ...c, base_url: preset?.base_url ?? "" }))
                        }
                        canRestoreBase={Boolean(preset) && baseIsUserOwned}
                      />
                    )}
                  </div>

                  {/* ⑥ 动作区 */}
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginTop: 16,
                      alignItems: "center",
                    }}
                  >
                    <Button
                      onClick={() => void onTest()}
                      loading={testing}
                      // 缺密钥时点它只会得到 401，先挡住并说清楚为什么
                      disabled={(needsKey && !hasKey) || !config.model.trim()}
                      title={
                        needsKey && !hasKey
                          ? "先填写 API Key"
                          : !config.model.trim()
                            ? "先填写模型名"
                            : "发一条最小请求，验证地址 / 密钥 / 模型三项是否都对"
                      }
                      icon={<ApiOutlined />}
                    >
                      测试连接
                    </Button>
                    <div style={{ flex: 1 }} />
                    <Button onClick={requestClose}>取消</Button>
                    <Button type="primary" onClick={() => void onSave()} loading={saving || loading}>
                      保存
                    </Button>
                  </div>

                  {configPath && (
                    <div
                      style={{
                        marginTop: 16,
                        padding: 8,
                        background: "var(--ant-color-bg-layout)",
                        borderRadius: 4,
                        fontSize: 11,
                        color: "var(--ant-color-text-tertiary)",
                        wordBreak: "break-all",
                      }}
                    >
                      <FolderOpenOutlined style={{ marginRight: 4 }} />
                      配置文件: {configPath}
                    </div>
                  )}
                </Form>
              </div>
            ),
          },
          {
            key: "about",
            label: <span>关于</span>,
            children: (
              <div
                style={{
                  padding: "16px 0",
                  color: "var(--ant-color-text-secondary)",
                  fontSize: 13,
                  lineHeight: 1.8,
                }}
              >
                <p>
                  <strong>z-biz-tool-file</strong> v0.2.1
                </p>
                <p>基于 Tauri 2 + React 19 + Rust 的桌面文件管理器。</p>
                <p>AI / LLM 功能由用户自定义配置驱动 — 数据全部存在本地。</p>
              </div>
            ),
          },
        ]}
      />
    </Modal>
  );
}

/** 失败卡片：一句动机 + 一个动作 + 可折叠的原始错误。 */
function FailureAlert({
  failure,
  onRefillKey,
  onRestoreBase,
  canRestoreBase,
}: {
  failure: LlmFailure;
  onRefillKey: () => void;
  onRestoreBase: () => void;
  canRestoreBase: boolean;
}) {
  const authIssue =
    failure.kind === "http" && (failure.status === 401 || failure.status === 403);
  const addrIssue = failure.kind === "http" && failure.status === 404;
  const rateIssue = failure.kind === "http" && failure.status === 429;

  // 只有能给出「有用动作」的失败才配按钮。
  // 429 / 5xx / 超时都不是用户改配置能解决的，给按钮等于诱导他乱改。
  const action = authIssue ? (
    <Button size="small" onClick={onRefillKey}>
      重新填写密钥
    </Button>
  ) : addrIssue && canRestoreBase ? (
    <Button size="small" onClick={onRestoreBase}>
      恢复默认地址
    </Button>
  ) : rateIssue ? null : undefined;

  return (
    <Alert
      type="error"
      showIcon
      message={failure.hint}
      action={action}
      description={
        <div style={{ fontSize: 12 }}>
          <Text type="secondary" style={{ wordBreak: "break-all" }}>
            {failure.message}
          </Text>
          {failure.status ? (
            <Tag style={{ marginLeft: 8 }} color="default">
              HTTP {failure.status}
            </Tag>
          ) : null}
        </div>
      }
    />
  );
}
