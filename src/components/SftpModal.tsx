import { useState, useEffect, useCallback } from "react";
import {
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Button,
  Table,
  Space,
  Alert,
  App as AntdApp,
} from "antd";
import {
  CloudServerOutlined,
  FolderOutlined,
  ReloadOutlined,
  ArrowLeftOutlined,
  KeyOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { getFileTypeVisual } from "../utils/fileTypeIcon";

interface SshConn {
  host: string;
  port: number;
  user: string;
  auth:
    | { type: "password"; password: string }
    | { type: "key"; key_path: string; key_passphrase?: string };
}

interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

export default function SftpModal({ open, onClose }: Props) {
  const { message } = AntdApp.useApp();
  const [conn, setConn] = useState<SshConn | null>(null);
  const [currentPath, setCurrentPath] = useState("/");
  const [pathStack, setPathStack] = useState<string[]>([]);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [filePreview, setFilePreview] = useState<{
    name: string;
    content: string;
    is_binary: boolean;
    size: number;
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!conn) return;
    setLoading(true);
    try {
      const list = await invoke<SftpEntry[]>("ssh_list_dir", {
        conn,
        path: currentPath,
      });
      setEntries(list);
    } catch (err) {
      message.error("列目录失败: " + err);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [conn, currentPath, message]);

  useEffect(() => {
    if (open && conn) refresh();
  }, [open, conn, currentPath, refresh]);

  const onConnect = (values: {
    host: string;
    port: number;
    user: string;
    authType: "password" | "key";
    password?: string;
    keyPath?: string;
    keyPassphrase?: string;
  }) => {
    const c: SshConn = {
      host: values.host,
      port: values.port,
      user: values.user,
      auth:
        values.authType === "password"
          ? { type: "password", password: values.password || "" }
          : {
              type: "key",
              key_path: values.keyPath || "",
              key_passphrase: values.keyPassphrase,
            },
    };
    setConn(c);
    setCurrentPath("/");
    setPathStack([]);
  };

  const onTest = async (values: {
    host: string;
    port: number;
    user: string;
    authType: "password" | "key";
    password?: string;
    keyPath?: string;
    keyPassphrase?: string;
  }) => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const c: SshConn = {
        host: values.host,
        port: values.port,
        user: values.user,
        auth:
          values.authType === "password"
            ? { type: "password", password: values.password || "" }
            : {
                type: "key",
                key_path: values.keyPath || "",
                key_passphrase: values.keyPassphrase,
              },
      };
      const r = await invoke<string>("ssh_test_connection", { conn: c });
      setTestResult({ ok: true, msg: r });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTestLoading(false);
    }
  };

  const enterDir = (entry: SftpEntry) => {
    setPathStack((s) => [...s, currentPath]);
    setCurrentPath(entry.path);
  };

  const goUp = () => {
    const prev = pathStack[pathStack.length - 1];
    if (prev !== undefined) {
      setPathStack((s) => s.slice(0, -1));
      setCurrentPath(prev);
    }
  };

  const openFile = async (entry: SftpEntry) => {
    if (!conn) return;
    setLoading(true);
    try {
      const r = await invoke<{ content: string; is_binary: boolean; size: number }>(
        "ssh_read_file",
        { conn, path: entry.path },
      );
      setFilePreview({ name: entry.name, ...r });
    } catch (err) {
      message.error("读文件失败: " + err);
    } finally {
      setLoading(false);
    }
  };

  const disconnect = () => {
    setConn(null);
    setEntries([]);
    setPathStack([]);
    setCurrentPath("/");
    setFilePreview(null);
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={920}
      title={
        <Space>
          <CloudServerOutlined />
          <span>SSH / SFTP 远程浏览</span>
          {conn && (
            <span style={{ color: "#888", fontSize: 12, fontWeight: 400 }}>
              ({conn.user}@{conn.host}:{conn.port})
            </span>
          )}
        </Space>
      }
      destroyOnClose
    >
      {!conn ? (
        <SshConnectForm onConnect={onConnect} onTest={onTest} testResult={testResult} testLoading={testLoading} />
      ) : (
        <div>
          {/* 路径栏 */}
          <Space.Compact style={{ width: "100%", marginBottom: 8 }}>
            <Button icon={<ArrowLeftOutlined />} onClick={goUp} disabled={pathStack.length === 0}>
              上级
            </Button>
            <Input
              value={currentPath}
              onChange={(e) => setCurrentPath(e.target.value)}
              onPressEnter={() => refresh()}
              style={{ flex: 1 }}
            />
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
              刷新
            </Button>
            <Button danger onClick={disconnect}>
              断开
            </Button>
          </Space.Compact>

          {filePreview ? (
            <div>
              <Space style={{ marginBottom: 8 }}>
                <Button size="small" onClick={() => setFilePreview(null)}>
                  ← 返回列表
                </Button>
                <span style={{ fontSize: 12, color: "#666" }}>
                  {filePreview.name} · {formatSize(filePreview.size)}
                  {filePreview.is_binary && " · 二进制"}
                </span>
              </Space>
              {filePreview.is_binary ? (
                <Alert
                  type="info"
                  showIcon
                  message="二进制文件，无法文本预览"
                  description={`大小: ${formatSize(filePreview.size)}，如需下载请用 scp 命令`}
                />
              ) : (
                <pre
                  style={{
                    maxHeight: 480,
                    overflow: "auto",
                    background: "#1e1e1e",
                    color: "#d4d4d4",
                    padding: 12,
                    borderRadius: 4,
                    fontSize: 12,
                    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {filePreview.content}
                </pre>
              )}
            </div>
          ) : (
            <Table
              rowKey="path"
              dataSource={entries}
              loading={loading}
              size="small"
              pagination={false}
              scroll={{ y: 380 }}
              columns={[
                {
                  title: "名称",
                  dataIndex: "name",
                  render: (name: string, e) => {
                    const v = getFileTypeVisual(name, e.is_dir);
                    return (
                      <span
                        onClick={() => (e.is_dir ? enterDir(e) : openFile(e))}
                        style={{
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          color: v.color,
                        }}
                      >
                        {e.is_dir ? <FolderOutlined /> : <span style={{ color: v.color }}>{v.icon}</span>}
                        <span style={{ color: "var(--ant-color-text)" }}>{name}</span>
                      </span>
                    );
                  },
                },
                {
                  title: "大小",
                  dataIndex: "size",
                  width: 100,
                  align: "right",
                  render: (s: number) => (s > 0 ? formatSize(s) : ""),
                },
                {
                  title: "修改",
                  dataIndex: "modified",
                  width: 160,
                  render: (m: number) =>
                    m > 0
                      ? new Date(m * 1000).toLocaleString()
                      : "",
                },
              ]}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

function SshConnectForm({
  onConnect,
  onTest,
  testResult,
  testLoading,
}: {
  onConnect: (v: {
    host: string;
    port: number;
    user: string;
    authType: "password" | "key";
    password?: string;
    keyPath?: string;
    keyPassphrase?: string;
  }) => void;
  onTest: (v: {
    host: string;
    port: number;
    user: string;
    authType: "password" | "key";
    password?: string;
    keyPath?: string;
    keyPassphrase?: string;
  }) => void;
  testResult: { ok: boolean; msg: string } | null;
  testLoading: boolean;
}) {
  const [form] = Form.useForm();
  const [authType, setAuthType] = useState<"password" | "key">("password");
  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{ port: 22, authType: "password" }}
      onFinish={(v) => onConnect(v as any)}
    >
      <Form.Item label="主机" name="host" rules={[{ required: true }]}>
        <Input placeholder="example.com 或 192.168.1.1" />
      </Form.Item>
      <Form.Item label="端口" name="port" rules={[{ required: true }]}>
        <InputNumber min={1} max={65535} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item label="用户名" name="user" rules={[{ required: true }]}>
        <Input placeholder="root" />
      </Form.Item>
      <Form.Item label="认证方式" name="authType">
        <Select onChange={(v) => setAuthType(v)}>
          <Select.Option value="password">密码</Select.Option>
          <Select.Option value="key">私钥</Select.Option>
        </Select>
      </Form.Item>
      {authType === "password" ? (
        <Form.Item label="密码" name="password">
          <Input.Password placeholder="留空尝试无密码" autoComplete="off" />
        </Form.Item>
      ) : (
        <>
          <Form.Item
            label={<span><KeyOutlined /> 私钥路径</span>}
            name="keyPath"
            rules={[{ required: true }]}
          >
            <Input placeholder="~/.ssh/id_rsa 或 ~/.ssh/id_ed25519" />
          </Form.Item>
          <Form.Item label="私钥密码（可选）" name="keyPassphrase">
            <Input.Password autoComplete="off" />
          </Form.Item>
        </>
      )}

      {testResult && (
        <Alert
          type={testResult.ok ? "success" : "error"}
          showIcon
          style={{ marginBottom: 12 }}
          message={testResult.ok ? "连接成功" : "连接失败"}
          description={testResult.msg}
        />
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Button
          loading={testLoading}
          onClick={() => form.validateFields().then((v) => onTest(v as any))}
        >
          测试连接
        </Button>
        <div style={{ flex: 1 }} />
        <Button htmlType="submit" type="primary">
          连接并浏览
        </Button>
      </div>
    </Form>
  );
}
