import { useState, useEffect, useCallback } from "react";
import {
  Modal,
  Button,
  Space,
  Input,
  Typography,
  message,
  Table,
  Tag,
  Card,
  Row,
  Col,
  Statistic,
  Alert,
  Progress,
  Popconfirm,
} from "antd";
import {
  PauseOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  CloudDownloadOutlined,
  GlobalOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

const { Text } = Typography;

interface Aria2Task {
  gid: string;
  status: string;
  total_length: number;
  completed_length: number;
  download_speed: number;
  upload_speed: number;
  files: any[];
  dir: string;
}

interface Aria2GlobalStat {
  download_speed: number;
  upload_speed: number;
  num_active: number;
  num_waiting: number;
  num_stopped: number;
}

interface Aria2ManagerProps {
  open: boolean;
  onClose: () => void;
}

const formatBytes = (b: number) => {
  if (b === 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
};

const formatSpeed = (b: number) => `${formatBytes(b)}/s`;

const statusColors: Record<string, string> = {
  active: "blue",
  waiting: "default",
  paused: "orange",
  error: "red",
  complete: "green",
};

export default function Aria2Manager({ open, onClose }: Aria2ManagerProps) {
  const [msgApi, msgContext] = message.useMessage();
  const [tasks, setTasks] = useState<Aria2Task[]>([]);
  const [stat, setStat] = useState<Aria2GlobalStat | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    if (!online) return;
    try {
      const [t, s] = await Promise.all([
        invoke<Aria2Task[]>("aria2_get_tasks"),
        invoke<Aria2GlobalStat>("aria2_global_stat"),
      ]);
      setTasks(t);
      setStat(s);
    } catch (e: any) {
      msgApi.error("刷新失败: " + e);
    }
  }, [online, msgApi]);

  const checkPing = useCallback(async () => {
    try {
      const ok = await invoke<boolean>("aria2_ping");
      setOnline(ok);
      if (!ok) {
        msgApi.warning("aria2 RPC 未响应");
      }
    } catch {
      setOnline(false);
    }
  }, [msgApi]);

  useEffect(() => {
    if (open) {
      checkPing();
    }
  }, [open, checkPing]);

  useEffect(() => {
    if (!open || !online) return;
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [open, online, refresh]);

  const startDaemon = async () => {
    try {
      await invoke("start_aria2_daemon", { downloadDir: "~/Downloads" });
      msgApi.success("已尝试启动 aria2c");
      setTimeout(checkPing, 2000);
    } catch (e: any) {
      msgApi.warning("启动失败: " + e);
    }
  };

  const addTask = async () => {
    if (!newUrl.trim()) {
      msgApi.warning("请输入 URL 或 magnet");
      return;
    }
    setAdding(true);
    try {
      const gid = await invoke<string>("aria2_add_uri", { uri: newUrl });
      msgApi.success(`已添加任务: ${gid}`);
      setNewUrl("");
      refresh();
    } catch (e: any) {
      msgApi.error("添加失败: " + e);
    } finally {
      setAdding(false);
    }
  };

  const pauseTask = async (gid: string) => {
    try {
      await invoke("aria2_pause", { gid });
      msgApi.success("已暂停");
      refresh();
    } catch (e: any) {
      msgApi.error("暂停失败: " + e);
    }
  };

  const removeTask = async (gid: string) => {
    try {
      await invoke("aria2_remove", { gid });
      msgApi.success("已删除");
      refresh();
    } catch (e: any) {
      msgApi.error("删除失败: " + e);
    }
  };

  return (
    <Modal
      title={
        <Space>
          <CloudDownloadOutlined style={{ color: "#722ed1" }} />
          <span>离线下载 (Aria2)</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={900}
      footer={null}
      destroyOnClose
    >
      {msgContext}

      {online === false && (
        <Alert
          type="warning"
          showIcon
          message="aria2 RPC 未连接"
          description={
            <div>
              <div>Aria2 离线下载需要 aria2c daemon 启用 RPC：</div>
              <ol style={{ marginBottom: 4 }}>
                <li><code>brew install aria2</code> (macOS) 或 <code>sudo apt install aria2</code> (Ubuntu)</li>
                <li>运行: <code>aria2c --enable-rpc --rpc-allow-origin-all</code></li>
                <li>或点击下方"启动 aria2c"尝试自动启动</li>
              </ol>
              <Button type="primary" size="small" icon={<GlobalOutlined />} onClick={startDaemon}>
                启动 aria2c
              </Button>
            </div>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        {/* 添加任务 */}
        <Card size="small" title="添加下载任务">
          <Space.Compact style={{ width: "100%" }}>
            <Input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="支持 HTTP/FTP/magnet/BT 链接..."
              onPressEnter={addTask}
              style={{ width: "calc(100% - 100px)" }}
            />
            <Button
              type="primary" icon={<PlusOutlined />}
              onClick={addTask}
              loading={adding}
              disabled={!online}
            >
              添加
            </Button>
          </Space.Compact>
        </Card>

        {/* 状态 */}
        {stat && (
          <Row gutter={12}>
            <Col span={6}>
              <Card size="small">
                <Statistic
                  title="下载速度"
                  value={formatSpeed(stat.download_speed)}
                  valueStyle={{ color: "#1890ff", fontSize: 16 }}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic
                  title="上传速度"
                  value={formatSpeed(stat.upload_speed)}
                  valueStyle={{ fontSize: 16 }}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title="活跃" value={stat.num_active} />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title="等待中" value={stat.num_waiting} />
              </Card>
            </Col>
          </Row>
        )}

        {/* 任务列表 */}
        <Card
          size="small"
          title={`任务列表 (${tasks.length})`}
          extra={
            <Button size="small" icon={<ReloadOutlined />} onClick={refresh}>
              刷新
            </Button>
          }
        >
          {tasks.length === 0 ? (
            <Text type="secondary">暂无任务</Text>
          ) : (
            <Table
              size="small"
              rowKey="gid"
              pagination={false}
              dataSource={tasks}
              columns={[
                {
                  title: "状态",
                  dataIndex: "status",
                  width: 100,
                  render: (s: string) => <Tag color={statusColors[s] || "default"}>{s}</Tag>,
                },
                {
                  title: "进度",
                  width: 250,
                  render: (_, r: Aria2Task) => {
                    const pct = r.total_length > 0
                      ? Math.round((r.completed_length / r.total_length) * 100)
                      : 0;
                    return (
                      <Space direction="vertical" size={2} style={{ width: "100%" }}>
                        <Progress percent={pct} size="small" showInfo={false} />
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {formatBytes(r.completed_length)} / {formatBytes(r.total_length)}
                        </Text>
                      </Space>
                    );
                  },
                },
                {
                  title: "下载速度",
                  dataIndex: "download_speed",
                  width: 110,
                  render: (s: number) => formatSpeed(s),
                },
                {
                  title: "GID",
                  dataIndex: "gid",
                  ellipsis: true,
                  render: (g: string) => <Text code style={{ fontSize: 11 }}>{g.slice(0, 16)}...</Text>,
                },
                {
                  title: "操作",
                  width: 120,
                  render: (_, r: Aria2Task) => (
                    <Space size="small">
                      {r.status === "active" && (
                        <Button size="small" icon={<PauseOutlined />} onClick={() => pauseTask(r.gid)} />
                      )}
                      <Popconfirm title="删除此任务？" onConfirm={() => removeTask(r.gid)}>
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </Space>
    </Modal>
  );
}