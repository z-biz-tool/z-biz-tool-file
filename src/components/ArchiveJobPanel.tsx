/**
 * 归档任务面板：屏幕右下角那块"下载架"。
 *
 * 为什么是常驻浮层而不是弹窗里的进度条：解压/压缩是后台任务，用户关掉归档浏览窗口它
 * 还在跑。进度只活在弹窗里的话，一关窗就再也看不到"那个 7 GB 的包解到哪了"，也点不到
 * 取消——只能去任务管理器杀进程，而这台机器上杀进程曾经连带触发过 Autodesk 许可锁死
 * （见 [[feedback-never-touch-dcc-app-lifecycle]]）。
 *
 * 不用 Modal / Drawer：那两者会抢 Esc，而 Esc 在这套界面里是"关最上面一层"的全局约定。
 * 一个 fixed 定位的浮层不参与层级栈，弹窗照常能用 Esc 关掉。
 */
import { useState } from "react";
import {
  App as AntdApp,
  Button,
  Progress,
  Space,
  Tooltip,
  theme,
  Typography,
} from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CloseOutlined,
  DownOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  UpOutlined,
} from "@ant-design/icons";

import { useArchiveJobStore } from "../stores/archiveJobStore";
import {
  formatEta,
  formatSpeed,
  isJobRunning,
  jobPercent,
  jobStatus,
  jobTitle,
  phaseLabel,
  type ArchiveProgress,
} from "../utils/archiveModel";

const { Text } = Typography;

export default function ArchiveJobPanel() {
  const { token } = theme.useToken();
  const { message } = AntdApp.useApp();
  const jobs = useArchiveJobStore((s) => s.jobs);
  const cancel = useArchiveJobStore((s) => s.cancel);
  const dismiss = useArchiveJobStore((s) => s.dismiss);
  const clearFinished = useArchiveJobStore((s) => s.clearFinished);
  const [collapsed, setCollapsed] = useState(false);

  // 一个任务都没有时整块不渲染：右下角挂一个空壳只会让人以为哪里坏了
  if (jobs.length === 0) return null;

  const active = jobs.filter(isJobRunning);
  const shown = collapsed ? active.slice(0, 1) : jobs;

  const onCancel = async (p: ArchiveProgress) => {
    const ok = await cancel(p.jobId);
    // false = 后端账本里已经没这个任务了（刚跑完）。说"已结束"比说"取消失败"准确
    if (!ok) message.info("任务已经结束了");
  };

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 1000,
        width: collapsed ? 260 : 380,
        maxHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        boxShadow: token.boxShadowSecondary,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {active.length > 0 ? (
          <LoadingOutlined style={{ color: token.colorPrimary }} />
        ) : (
          <CheckCircleFilled style={{ color: token.colorSuccess }} />
        )}
        <Text strong style={{ fontSize: 13 }}>
          {active.length > 0 ? `${active.length} 个归档任务进行中` : "归档任务已完成"}
        </Text>
        <span style={{ flex: 1 }} />
        {active.length === 0 && (
          <Button type="text" size="small" onClick={clearFinished}>
            清空
          </Button>
        )}
        <Button
          type="text"
          size="small"
          icon={collapsed ? <UpOutlined /> : <DownOutlined />}
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "展开任务列表" : "收起任务列表"}
        />
      </div>

      <div style={{ overflowY: "auto", padding: "4px 0" }}>
        {shown.map((p) => {
          const pct = jobPercent(p);
          const running = isJobRunning(p);
          return (
            <div
              key={p.jobId}
              style={{
                padding: "6px 10px",
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Tooltip title={p.archive} mouseEnterDelay={0.4}>
                  <Text
                    ellipsis
                    style={{ fontSize: 12, maxWidth: collapsed ? 150 : 250 }}
                  >
                    {jobTitle(p)}
                  </Text>
                </Tooltip>
                <span style={{ flex: 1 }} />
                {running ? (
                  <Button size="small" type="text" danger onClick={() => onCancel(p)}>
                    取消
                  </Button>
                ) : (
                  <Button
                    size="small"
                    type="text"
                    icon={<CloseOutlined />}
                    onClick={() => dismiss(p.jobId)}
                    aria-label="从列表移除"
                  />
                )}
              </div>

              {running && pct === null ? (
                <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
                  {phaseLabel(p.phase)}
                  {p.entry ? ` · ${p.entry}` : ""}
                </div>
              ) : (
                <Progress
                  percent={pct ?? 100}
                  size="small"
                  status={jobStatus(p)}
                  format={() =>
                    running
                      ? `${pct === null ? "?" : Math.round(pct)}%`
                      : phaseLabel(p.phase)
                  }
                />
              )}

              <div
                style={{
                  display: "flex",
                  gap: 8,
                  fontSize: 11,
                  color: token.colorTextSecondary,
                }}
              >
                {running && p.speedBps > 0 && <span>{formatSpeed(p.speedBps)}</span>}
                {running && <span>{formatEta(p)}</span>}
                {running && p.entriesTotal > 0 && (
                  <span>
                    {p.entriesDone}/{p.entriesTotal} 项
                  </span>
                )}
                {!running && (
                  <Text
                    type={p.phase === "error" ? "danger" : "secondary"}
                    ellipsis
                    style={{ fontSize: 11, maxWidth: collapsed ? 190 : 320 }}
                  >
                    {p.phase === "error" && <CloseCircleFilled style={{ marginRight: 4 }} />}
                    {p.phase === "cancelled" && <MinusCircleOutlined style={{ marginRight: 4 }} />}
                    {p.message}
                  </Text>
                )}
              </div>
            </div>
          );
        })}
        {collapsed && jobs.length > shown.length && (
          <div style={{ padding: "4px 10px" }}>
            <Space size={4}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                另有 {jobs.length - shown.length} 个已结束的任务
              </Text>
              <Button type="link" size="small" onClick={() => setCollapsed(false)}>
                展开
              </Button>
            </Space>
          </div>
        )}
      </div>
    </div>
  );
}
