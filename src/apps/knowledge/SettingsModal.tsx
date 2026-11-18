// 设置弹窗：MinerU 解析服务地址 + 语雀接入（API 域名 / 个人访问令牌）。
// token 走后端密文文件，前端只见「已配置 / 未配置」；已配置时留空 = 保持不变。
import { useEffect, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
} from "antd";
import { CheckCircleOutlined } from "@ant-design/icons";
import { kbConfigGet, kbConfigSet, kbYuqueTest, type KbConfigView } from "./api";

const { Text } = Typography;

export default function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { message: msgApi } = AntdApp.useApp();
  const [config, setConfig] = useState<KbConfigView | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [form] = Form.useForm<{
    mineruBaseUrl?: string;
    yuqueApiBase?: string;
    yuqueToken?: string;
  }>();

  useEffect(() => {
    if (!open) return;
    kbConfigGet()
      .then((cfg) => {
        setConfig(cfg);
        form.setFieldsValue({
          mineruBaseUrl: cfg.mineru_base_url ?? "",
          yuqueApiBase: cfg.yuque_api_base ?? "",
          yuqueToken: "",
        });
      })
      .catch((e) => msgApi.error(`读取配置失败: ${e}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const next = await kbConfigSet({
        mineruBaseUrl: values.mineruBaseUrl ?? null,
        yuqueApiBase: values.yuqueApiBase ?? null,
        yuqueToken: values.yuqueToken
          ? values.yuqueToken
          : config?.yuque_token_set
            ? null // 留空且已配置 = 保持不变
            : "", // 留空且未配置过 = 显式空串（无副作用）
      });
      setConfig(next);
      form.setFieldValue("yuqueToken", "");
      msgApi.success("设置已保存");
    } catch (e) {
      msgApi.error(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function testYuque() {
    setTesting(true);
    try {
      const user = await kbYuqueTest();
      msgApi.success(`Token 有效：${user.name}（${user.login}）`);
    } catch (e) {
      msgApi.error(`${e}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal
      title="知识库设置"
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </Space>
      }
      width={560}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="解析默认全本地：文本直读、PDF/Word/PPT 走文本层、表格本地抽取、图片/扫描件走内嵌 OCR（模型首次使用自动下载到 ~/.oar，之后完全离线）。下面的 MinerU 是可选增强，留空即可。"
        />
        <Form.Item
          name="mineruBaseUrl"
          label="MinerU 服务地址（可选增强）"
          help="留空 = 纯本地。填写后图片/扫描件优先走局域网 MinerU（如 http://10.10.20.49:8121），失败自动回落本地 OCR。"
        >
          <Input placeholder="留空即可；内网自建 MinerU 才需要填" allowClear />
        </Form.Item>
        <div style={{ borderTop: "1px solid var(--ant-color-border-secondary)", margin: "8px 0 16px" }} />
        <Form.Item
          name="yuqueToken"
          label={
            <Space size={8}>
              <span>语雀个人访问令牌</span>
              {config?.yuque_token_set ? (
                <Tag color="green" icon={<CheckCircleOutlined />} style={{ marginRight: 0 }}>
                  已配置
                </Tag>
              ) : (
                <Tag style={{ marginRight: 0 }}>未配置</Tag>
              )}
            </Space>
          }
          help="语雀 → 个人设置 → 开发者 → 新建 Token。已配置时留空表示保持不变；输入空格可清除。"
          extra={
            config?.yuque_token_set ? (
              <Button size="small" type="link" loading={testing} onClick={() => void testYuque()}>
                测试当前 Token
              </Button>
            ) : null
          }
        >
          <Input.Password
            placeholder={config?.yuque_token_set ? "留空保持不变，输入新值则覆盖" : "语雀 Token"}
            autoComplete="new-password"
          />
        </Form.Item>
        <Form.Item
          name="yuqueApiBase"
          label="语雀 API 域名"
          help="私有部署 / 租户域名才需要改，留空用官方 https://www.yuque.com/api/v2"
        >
          <Input placeholder="https://www.yuque.com/api/v2" allowClear />
        </Form.Item>
      </Form>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Token 保存在本机密文文件（~/.z-biz-tool/kb/secrets.enc），不会上传，也不会回传到界面。
      </Text>
    </Modal>
  );
}
