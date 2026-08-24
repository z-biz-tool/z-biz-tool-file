import { useState, useEffect } from "react";
import {
  Modal,
  Tabs,
  Form,
  Input,
  Select,
  Slider,
  Button,
  message,
  App as AntdApp,
} from "antd";
import {
  SettingOutlined,
  RobotOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  FolderOpenOutlined,
  KeyOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

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

const DEFAULT_CONFIG: LlmConfig = {
  provider: "openai",
  api_key: "",
  base_url: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  timeout_secs: 60,
  temperature: 0.7,
};

const PROVIDER_PRESETS: Record<string, { base_url: string; model: string; key_label: string }> = {
  openai: {
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    key_label: "OpenAI API Key (sk-...)",
  },
  anthropic: {
    base_url: "https://api.anthropic.com",
    model: "claude-3-5-sonnet-latest",
    key_label: "Anthropic API Key (sk-ant-...)",
  },
  ollama: {
    base_url: "http://localhost:11434",
    model: "llama3.2",
    key_label: "（Ollama 通常不需要 key，留空即可）",
  },
  custom: {
    base_url: "",
    model: "",
    key_label: "API Key（按服务商要求）",
  },
};

export default function SettingsModal({ open, onClose }: Props) {
  const { modal } = AntdApp.useApp();
  const [config, setConfig] = useState<LlmConfig>(DEFAULT_CONFIG);
  const [configPath, setConfigPath] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    invoke<LlmConfig>("load_llm_config")
      .then((c) => setConfig({ ...DEFAULT_CONFIG, ...c }))
      .catch((err) => message.error("加载配置失败: " + err))
      .finally(() => setLoading(false));
    invoke<string>("get_llm_config_path")
      .then(setConfigPath)
      .catch(() => {});
  }, [open]);

  const onProviderChange = (provider: string) => {
    const preset = PROVIDER_PRESETS[provider];
    setConfig((c) => ({
      ...c,
      provider,
      base_url: preset?.base_url ?? c.base_url,
      model: preset?.model ?? c.model,
    }));
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await invoke("save_llm_config", { config });
      message.success("LLM 配置已保存");
    } catch (err) {
      message.error("保存失败: " + err);
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await invoke<string>("test_llm_config", { config });
      setTestResult({ ok: true, msg: "连接成功 — 模型返回响应正常" });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const onReset = () => {
    modal.confirm({
      title: "重置为默认配置？",
      content: "会清空当前 provider/api_key/base_url/model，恢复成 OpenAI 默认。",
      okText: "重置",
      cancelText: "取消",
      onOk: () => setConfig(DEFAULT_CONFIG),
    });
  };

  const preset = PROVIDER_PRESETS[config.provider];
  const showKeyField = config.provider !== "ollama" || config.api_key.length > 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={680}
      title={
        <span>
          <SettingOutlined style={{ marginRight: 8 }} />
          设置
        </span>
      }
      destroyOnClose
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
                <Alert_ provider={config.provider} />

                <Form layout="vertical" style={{ marginTop: 12 }}>
                  <Form.Item label="模型提供商" required>
                    <Select
                      value={config.provider}
                      onChange={onProviderChange}
                      options={[
                        { value: "openai", label: "OpenAI (GPT-4o, GPT-4o-mini, o1, ...)" },
                        { value: "anthropic", label: "Anthropic (Claude 3.5 Sonnet, ...)" },
                        { value: "ollama", label: "Ollama（本地 LLM，免 API key）" },
                        { value: "custom", label: "自定义（OpenAI 兼容 / 第三方代理）" },
                      ]}
                    />
                  </Form.Item>

                  {showKeyField && (
                    <Form.Item
                      label={
                        <span>
                          <KeyOutlined style={{ marginRight: 4 }} />
                          API Key
                        </span>
                      }
                    >
                      <Input.Password
                        value={config.api_key}
                        onChange={(e) => setConfig({ ...config, api_key: e.target.value })}
                        placeholder={preset?.key_label ?? "API Key"}
                        autoComplete="off"
                      />
                      <small style={{ color: "#888" }}>
                        仅存储在你机器上（{configPath || "app config dir"}），不上传任何服务器
                      </small>
                    </Form.Item>
                  )}

                  <Form.Item label="Base URL">
                    <Input
                      value={config.base_url}
                      onChange={(e) => setConfig({ ...config, base_url: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                    />
                  </Form.Item>

                  <Form.Item label="模型">
                    <Input
                      value={config.model}
                      onChange={(e) => setConfig({ ...config, model: e.target.value })}
                      placeholder="gpt-4o-mini"
                    />
                  </Form.Item>

                  <Form.Item label="温度（0 = 精确，2 = 发散）">
                    <Slider
                      min={0}
                      max={2}
                      step={0.1}
                      value={config.temperature}
                      onChange={(t) => setConfig({ ...config, temperature: t })}
                      marks={{ 0: "0", 1: "1", 2: "2" }}
                    />
                  </Form.Item>

                  <Form.Item label="请求超时（秒）">
                    <Slider
                      min={10}
                      max={300}
                      step={10}
                      value={config.timeout_secs}
                      onChange={(t) => setConfig({ ...config, timeout_secs: t })}
                      marks={{ 10: "10s", 60: "60s", 300: "300s" }}
                    />
                  </Form.Item>

                  {testResult && (
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 4,
                        background: testResult.ok ? "#f6ffed" : "#fff1f0",
                        border: `1px solid ${testResult.ok ? "#b7eb8f" : "#ffa39e"}`,
                        marginBottom: 12,
                        fontSize: 12,
                        color: testResult.ok ? "#389e0d" : "#cf1322",
                      }}
                    >
                      {testResult.ok ? (
                        <CheckCircleOutlined style={{ marginRight: 6 }} />
                      ) : (
                        <ExclamationCircleOutlined style={{ marginRight: 6 }} />
                      )}
                      {testResult.msg}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                    <Button
                      type="default"
                      onClick={onTest}
                      loading={testing}
                      icon={<ApiOutlined />}
                    >
                      测试连接
                    </Button>
                    <Button onClick={onReset}>重置</Button>
                    <div style={{ flex: 1 }} />
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" onClick={onSave} loading={saving || loading}>
                      保存
                    </Button>
                  </div>

                  {configPath && (
                    <div
                      style={{
                        marginTop: 16,
                        padding: 8,
                        background: "#fafafa",
                        borderRadius: 4,
                        fontSize: 11,
                        color: "#888",
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
              <div style={{ padding: "16px 0", color: "#666", fontSize: 13, lineHeight: 1.8 }}>
                <p>
                  <strong>z-biz-tool-file</strong> v0.1.0
                </p>
                <p>基于 Tauri 2 + React 19 + Rust 1.97 的桌面文件管理器。</p>
                <p>AI / LLM 功能由用户自定义配置驱动 — 数据全部存在本地。</p>
              </div>
            ),
          },
        ]}
      />
    </Modal>
  );
}

function Alert_({ provider }: { provider: string }) {
  const tips: Record<string, string> = {
    openai: "推荐 GPT-4o-mini（便宜快）或 GPT-4o（更强）。国内访问需代理。",
    anthropic: "Claude 3.5 Sonnet 适合长文本理解与摘要。",
    ollama: "本地运行 LLM（llama3.2 / qwen2.5 / mistral），完全离线、免费。需要先启动 `ollama serve`。",
    custom: "任何 OpenAI 兼容 endpoint：Azure OpenAI / Together AI / OpenRouter / 自建 vLLM。",
  };
  return (
    <div
      style={{
        padding: "8px 12px",
        background: "#f0f5ff",
        border: "1px solid #adc6ff",
        borderRadius: 4,
        fontSize: 12,
        color: "#1d39c4",
      }}
    >
      💡 {tips[provider] ?? "请填入 provider 的接入信息"}
    </div>
  );
}
