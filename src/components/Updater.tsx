import { useState, useEffect } from "react";
import {
  Modal,
  Button,
  Space,
  Typography,
  message,
  Progress,
  Alert,
  Card,
  Tag,
  Statistic,
  Row,
  Col,
} from "antd";
import {
  CloudDownloadOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  RocketOutlined,
  GlobalOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

const { Text, Paragraph } = Typography;

interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  content_type: string;
}

interface ReleaseInfo {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  assets: ReleaseAsset[];
}

interface UpdateStatus {
  current_version: string;
  latest_version: string | null;
  has_update: boolean;
  release: ReleaseInfo | null;
  matched_asset: ReleaseAsset | null;
}

interface UpdaterProps {
  open: boolean;
  onClose: () => void;
}

const formatSize = (b: number) => {
  if (!b) return "0";
  const k = 1024;
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), u.length - 1);
  return `${(b / Math.pow(k, i)).toFixed(1)} ${u[i]}`;
};

export default function Updater({ open, onClose }: UpdaterProps) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [msgApi, msgContext] = message.useMessage();

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const s = await invoke<UpdateStatus>("updater_check");
      setStatus(s);
      if (s.has_update) {
        msgApi.success(`发现新版本 v${s.latest_version}`);
      } else {
        msgApi.info("已是最新版本");
      }
    } catch (e: any) {
      msgApi.error("检查更新失败: " + e);
    } finally {
      setChecking(false);
    }
  };

  const downloadUpdate = async () => {
    if (!status?.matched_asset) {
      msgApi.warning("未找到匹配当前平台的安装包");
      return;
    }
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadedPath(null);
    try {
      // 模拟进度（实际 ureq 不支持流式进度，这里用定时器近似）
      const interval = setInterval(() => {
        setDownloadProgress((p) => Math.min(p + 10, 90));
      }, 300);

      const result = await invoke<{ file_path: string; file_size: number; version: string }>(
        "updater_download_latest"
      );

      clearInterval(interval);
      setDownloadProgress(100);
      setDownloadedPath(result.file_path);
      msgApi.success(`已下载 v${result.version}，大小 ${formatSize(result.file_size)}`);
    } catch (e: any) {
      msgApi.error("下载失败: " + e);
    } finally {
      setDownloading(false);
    }
  };

  const openInstaller = async () => {
    try {
      const msg = await invoke<string>("updater_open_install_guide");
      msgApi.info(msg);
    } catch (e: any) {
      msgApi.error("打开失败: " + e);
    }
  };

  useEffect(() => {
    if (open) {
      checkUpdate();
    }
  }, [open]);

  return (
    <Modal
      title={
        <Space>
          <CloudDownloadOutlined style={{ color: "#1890ff" }} />
          <span>检查更新</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={720}
      footer={null}
      destroyOnClose
    >
      {msgContext}
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        {/* 当前版本 vs 最新版本 */}
        {status && (
          <Row gutter={12}>
            <Col span={12}>
              <Card size="small">
                <Statistic
                  title="当前版本"
                  value={`v${status.current_version}`}
                  prefix={<RocketOutlined />}
                />
              </Card>
            </Col>
            <Col span={12}>
              <Card size="small">
                <Statistic
                  title="最新版本"
                  value={status.latest_version ? `v${status.latest_version}` : "-"}
                  valueStyle={{
                    color: status.has_update ? "#52c41a" : "#8c8c8c",
                  }}
                  prefix={status.has_update ? <CheckCircleOutlined /> : <CloudDownloadOutlined />}
                />
              </Card>
            </Col>
          </Row>
        )}

        {/* 操作按钮 */}
        <Space>
          <Button
            type="primary" icon={<ReloadOutlined />}
            onClick={checkUpdate}
            loading={checking}
          >
            重新检查
          </Button>
          {status?.has_update && (
            <Button
              type="primary" icon={<CloudDownloadOutlined />}
              onClick={downloadUpdate}
              loading={downloading}
              disabled={!status.matched_asset}
            >
              下载最新版本
            </Button>
          )}
          {downloadedPath && (
            <Button
              icon={<RocketOutlined />}
              onClick={openInstaller}
              type="primary"
              ghost
            >
              打开安装包
            </Button>
          )}
        </Space>

        {/* 平台匹配情况 */}
        {status && !status.matched_asset && status.has_update && (
          <Alert
            type="warning"
            showIcon
            message="未找到匹配当前平台的安装包"
            description="请联系开发者发布对应平台的资产"
          />
        )}

        {/* 下载进度 */}
        {downloading && (
          <Card size="small">
            <Space direction="vertical" style={{ width: "100%" }}>
              <Text>正在下载...</Text>
              <Progress percent={downloadProgress} />
            </Space>
          </Card>
        )}

        {/* 下载完成 */}
        {downloadedPath && (
          <Alert
            type="success"
            showIcon
            message="下载完成"
            description={
              <Space direction="vertical">
                <Text code style={{ fontSize: 11 }}>{downloadedPath}</Text>
                <Text type="secondary">点击"打开安装包"按钮查看下载目录</Text>
              </Space>
            }
          />
        )}

        {/* 发行说明 */}
        {status?.release && (
          <Card size="small" title={
            <Space>
              <GlobalOutlined />
              <span>发行说明</span>
              <Tag color="blue">{status.release.tag_name}</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {dayjs(status.release.published_at).format("YYYY-MM-DD HH:mm")}
              </Text>
            </Space>
          }>
            <Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0, fontSize: 12, maxHeight: 300, overflow: "auto" }}>
              {status.release.body || "暂无发行说明"}
            </Paragraph>
          </Card>
        )}

        {/* 未匹配时的资源列表 */}
        {status?.release?.assets && (
          <Card size="small" title="所有安装包">
            <Space wrap>
              {status.release.assets.map((a) => (
                <Tag key={a.name} color={a.name === status.matched_asset?.name ? "green" : "default"}>
                  {a.name} ({formatSize(a.size)})
                </Tag>
              ))}
            </Space>
          </Card>
        )}

        {/* 操作提示 */}
        <Alert
          type="info"
          showIcon
          message="更新流程"
          description={
            <ol style={{ marginBottom: 0, paddingLeft: 20 }}>
              <li>push 代码 → GitHub Actions 自动打包</li>
              <li>发布 GitHub Release</li>
              <li>App 检测到新版本（启动时静默检查）</li>
              <li>下载安装包到 ~/Downloads</li>
              <li>手动双击安装包覆盖当前版本</li>
            </ol>
          }
        />
      </Space>
    </Modal>
  );
}

// dayjs 外部 import
import dayjs from "dayjs";