/**
 * 应用级更新中心 —— 角落入口 / 「有更新」标记 / 一键自我更新。
 *
 * ## 为什么重写而不是再叠一层
 *
 * 这个仓此前有**两套互不同步**的更新：
 *   1. `App.tsx` 顶栏那个 `hasUpdate` 红点按钮 → 打开 `Updater.tsx`
 *      （走 GitHub Releases，下载到 ~/Downloads，让用户**手动双击**安装包）；
 *   2. `UpdaterGate.tsx`（从 terminal 搬来）→ 启动延时 check()，有新版就
 *      **自己弹窗**，走 Tauri 官方 updater 的 downloadAndInstall + relaunch。
 *
 * 结果就是：角标说「有更新」的依据来自 1，真正能自己装完的能力在 2，
 * 点角标却落到「手动下载」。用户看到的是「看起来能更新，但不会自己更新掉」。
 *
 * 现在收敛成一条：**唯一状态源 = Tauri 官方 updater 的 check()**。
 *   - 有更新只在角落挂标记，不弹窗打扰；
 *   - 点入口直接 downloadAndInstall → 装完自动 relaunch（留 3 秒可取消）；
 *   - 老的下载面板降级为浮层里的「手动下载安装包」兜底，主路径不再经过它。
 *
 * 发布侧 endpoint / pubkey 见 src-tauri/tauri.conf.json 的 plugins.updater。
 * 本地 `--no-sign` 打的包没有 updater 签名，check() 会失败 —— 静默降级，不误报。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Modal,
  Progress,
  Space,
  Tooltip,
  Typography,
  theme,
} from "antd";
import {
  ArrowUpOutlined,
  CheckCircleFilled,
  CloudDownloadOutlined,
  LoadingOutlined,
  RocketOutlined,
} from "@ant-design/icons";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const { Text, Paragraph } = Typography;

// 纯判据独立成模块：不拖 React / antd / Tauri，测试才 import 得动
import { badgeOf, isNewerVersion, type UpdatePhase } from "./updateBadge";
export {
  badgeOf,
  isNewerVersion,
  parseVersion,
  type BadgeView,
  type UpdatePhase,
} from "./updateBadge";

const formatSize = (b: number) => {
  if (!b) return "0 B";
  const k = 1024;
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), u.length - 1);
  return `${(b / Math.pow(k, i)).toFixed(1)} ${u[i]}`;
};

interface UpdateCenterValue {
  hasUpdate: boolean;
  phase: UpdatePhase;
  latestVersion: string | null;
  currentVersion: string | null;
  releaseNotes: string | null;
  received: number;
  total: number;
  error: string | null;
  /** 还剩几秒自动重启；null 表示不在倒计时（未安装 / 已取消） */
  restartIn: number | null;
  /** 有更新 → 立刻下载安装并自动重启；无更新 → 重新检查 */
  startUpdate: () => void;
  recheck: () => void;
  cancelRestart: () => void;
  restartNow: () => void;
  openPanel: () => void;
  closePanel: () => void;
  panelOpen: boolean;
}

const FALLBACK: UpdateCenterValue = {
  hasUpdate: false,
  phase: "idle",
  latestVersion: null,
  currentVersion: null,
  releaseNotes: null,
  received: 0,
  total: 0,
  error: null,
  restartIn: null,
  startUpdate: () => {},
  recheck: () => {},
  cancelRestart: () => {},
  restartNow: () => {},
  openPanel: () => {},
  closePanel: () => {},
  panelOpen: false,
};

const UpdateCenterContext = createContext<UpdateCenterValue | null>(null);

/** Provider 之外（预览 / 单测）也能安全调用，不会白屏。 */
export function useUpdateCenter(): UpdateCenterValue {
  return useContext(UpdateCenterContext) ?? FALLBACK;
}

export function UpdateCenterProvider({
  children,
  delayMs = 5000,
  onOpenManualDownload,
}: {
  children: ReactNode;
  delayMs?: number;
  /** 老版「手动下载安装包」面板的兜底入口 */
  onOpenManualDownload?: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [update, setUpdate] = useState<Update | null>(null);
  // check() 拿到的 Update 在 Rust 侧持有资源；用 ref 避免回调闭包读到旧值
  const updateRef = useRef<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [restartIn, setRestartIn] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const releaseUpdate = useCallback(async () => {
    const held = updateRef.current;
    updateRef.current = null;
    if (held) {
      await held.close().catch((e) => console.debug("[updater] 释放更新句柄失败", e));
    }
  }, []);

  /** 返回真正可用的 Update；失败一律静默（离线 / 无 manifest / 非 Tauri / 签名不匹配）。 */
  const obtainUpdate = useCallback(async (): Promise<Update | null> => {
    try {
      const found = await check();
      await releaseUpdate();
      updateRef.current = found;
      setUpdate(found);
      return found;
    } catch (e) {
      console.warn("[updater] 检查更新失败（已静默）:", e);
      return null;
    }
  }, [releaseUpdate]);

  const recheck = useCallback(() => {
    void (async () => {
      setPhase("checking");
      setError(null);
      const found = await obtainUpdate();
      setPhase("idle");
      if (found) {
        message.success(`发现新版本 v${found.version}`);
      } else {
        message.info("已是最新版本");
      }
    })();
  }, [message, obtainUpdate]);

  // 启动后延时静默检查：只点亮角标，不弹窗
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const found = await obtainUpdate();
        if (cancelled) return;
        // check() 内部已比版本；这里再挡一层 manifest 倒退
        if (found && !isNewerVersion(found.version, found.currentVersion)) {
          await releaseUpdate();
          setUpdate(null);
        }
      })();
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [delayMs, obtainUpdate, releaseUpdate]);

  const doRelaunch = useCallback(async () => {
    try {
      await relaunch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      message.error("重启失败，请手动重启应用: " + msg);
      setRestartIn(null);
    }
  }, [message]);

  // 安装完成后 3 秒倒计时自动重启 —— 默认「自己更新掉」，但留一个取消窗口，
  // 免得正在传文件时被无声打断。
  useEffect(() => {
    if (phase !== "installed" || restartIn === null) return;
    if (restartIn <= 0) {
      void doRelaunch();
      return;
    }
    const t = window.setTimeout(() => {
      setRestartIn((n) => (n === null ? null : n - 1));
    }, 1000);
    return () => window.clearTimeout(t);
  }, [phase, restartIn, doRelaunch]);

  const startUpdate = useCallback(() => {
    void (async () => {
      if (phase === "downloading" || phase === "installed") {
        setPanelOpen(true);
        return;
      }
      // 角标没亮（还没检查 / 检查失败）时先补一次检查，别让用户点了没反应
      const target = updateRef.current ?? (await obtainUpdate());
      if (!target) {
        message.info("当前已是最新版本");
        return;
      }
      setPanelOpen(true);
      setPhase("downloading");
      setError(null);
      setReceived(0);
      setTotal(0);
      try {
        await target.downloadAndInstall((event) => {
          if (event.event === "Started") {
            setTotal(event.data.contentLength ?? 0);
          } else if (event.event === "Progress") {
            setReceived((prev) => prev + event.data.chunkLength);
          }
        });
        updateRef.current = null;
        setUpdate(null);
        setPhase("installed");
        setRestartIn(3);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPhase("error");
      }
    })();
  }, [message, obtainUpdate, phase]);

  const value = useMemo<UpdateCenterValue>(() => {
    const found = update;
    // 不绑 phase：下载中 / 已装好时入口要继续显示，不能中途消失
    const hasUpdate = !!found && isNewerVersion(found.version, found.currentVersion);
    return {
      hasUpdate,
      phase,
      latestVersion: found?.version ?? null,
      currentVersion: found?.currentVersion ?? null,
      releaseNotes: found?.body ?? null,
      received,
      total,
      error,
      restartIn,
      startUpdate,
      recheck,
      cancelRestart: () => setRestartIn(null),
      restartNow: () => void doRelaunch(),
      openPanel: () => setPanelOpen(true),
      closePanel: () => setPanelOpen(false),
      panelOpen,
    };
  }, [update, phase, received, total, error, restartIn, startUpdate, recheck, doRelaunch, panelOpen]);

  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
  const showPanel =
    panelOpen && (phase === "downloading" || phase === "installed" || phase === "error");

  return (
    <UpdateCenterContext.Provider value={value}>
      {children}
      <Modal
        title={
          <Space>
            <RocketOutlined />
            <span>自动更新</span>
          </Space>
        }
        open={showPanel}
        onCancel={() => setPanelOpen(false)}
        closable={phase !== "downloading"}
        mask={{ closable: phase !== "downloading" }}
        width={520}
        footer={null}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: "100%" }} size={14}>
          {value.currentVersion && value.latestVersion && (
            <Text type="secondary">
              v{value.currentVersion} → <Text strong>v{value.latestVersion}</Text>
            </Text>
          )}

          {value.releaseNotes && (
            <Paragraph
              style={{ whiteSpace: "pre-wrap", marginBottom: 0, fontSize: 12, maxHeight: 160, overflow: "auto" }}
            >
              {value.releaseNotes}
            </Paragraph>
          )}

          {phase === "downloading" && (
            <>
              <Text>
                正在下载并安装… {formatSize(received)}
                {total > 0 ? ` / ${formatSize(total)}` : ""}
              </Text>
              <Progress percent={percent} status="active" />
              <Text type="secondary" style={{ fontSize: 12 }}>
                安装完成后会自动重启，无需手动操作。
              </Text>
            </>
          )}

          {phase === "installed" && (
            <Alert
              type="success"
              showIcon
              icon={<CheckCircleFilled />}
              title="更新已装好"
              description={
                restartIn === null
                  ? "下次重启应用后生效。"
                  : `将在 ${restartIn} 秒后自动重启，正在进行的任务请先保存。`
              }
              action={
                <Space>
                  {restartIn !== null ? (
                    <Button size="small" onClick={() => setRestartIn(null)}>
                      稍后重启
                    </Button>
                  ) : (
                    <Button size="small" type="primary" onClick={() => void doRelaunch()}>
                      立即重启
                    </Button>
                  )}
                </Space>
              }
            />
          )}

          {phase === "error" && (
            <Alert
              type="error"
              showIcon
              title="更新下载失败"
              description={error ?? "未知错误"}
              action={
                <Space>
                  <Button size="small" type="primary" onClick={startUpdate}>
                    重试
                  </Button>
                  {onOpenManualDownload && (
                    <Button size="small" onClick={onOpenManualDownload}>
                      手动下载安装包
                    </Button>
                  )}
                </Space>
              }
            />
          )}
        </Space>
      </Modal>
    </UpdateCenterContext.Provider>
  );
}

/**
 * 左下角活动栏的常驻入口。
 *
 * 平时安静（一个灰色箭头），有新版才挂红点；**点一下就直接开始自我更新**，
 * 不再先弹「立即更新 / 稍后」再弹「立即重启」。样式与 ActivityBarMore 同口径，
 * 放进 ActivityBar 的 footer 里正好贴底。
 */
export function UpdateLauncher() {
  const { hasUpdate, phase, latestVersion, startUpdate, recheck, openPanel } = useUpdateCenter();
  const { token } = theme.useToken();
  const badge = badgeOf({ hasUpdate, phase, latestVersion });

  const busy = phase === "checking" || phase === "downloading";
  const onClick = () => {
    if (phase === "installed" || phase === "error") {
      openPanel();
      return;
    }
    if (hasUpdate) {
      startUpdate();
      return;
    }
    if (!busy) recheck();
  };

  return (
    <Tooltip title={badge.label} placement="right" mouseEnterDelay={0.4}>
      <Badge dot={badge.show} offset={[-7, 7]}>
        <button
          type="button"
          aria-label={badge.label}
          data-update-tone={badge.tone}
          onClick={onClick}
          style={{
            width: 40,
            height: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: token.borderRadius,
            background: "transparent",
            color:
              badge.tone === "update"
                ? token.colorPrimary
                : badge.tone === "error"
                  ? token.colorError
                  : token.colorTextTertiary,
            cursor: busy ? "progress" : "pointer",
            fontSize: 17,
          }}
        >
          {phase === "checking" || phase === "downloading" ? (
            <LoadingOutlined />
          ) : phase === "installed" ? (
            <CheckCircleFilled />
          ) : hasUpdate ? (
            <ArrowUpOutlined />
          ) : (
            <CloudDownloadOutlined />
          )}
        </button>
      </Badge>
    </Tooltip>
  );
}

/** 顶栏那个文字按钮：与左下角入口读同一份状态，点下去同样是自我更新。 */
export function UpdateTopButton() {
  const { hasUpdate, phase, latestVersion, startUpdate } = useUpdateCenter();
  if (!hasUpdate) return null;
  return (
    <Tooltip title={phase === "checking" ? "正在检查…" : "点击后自动下载、安装并重启"}>
      <Badge dot>
        <Button
          size="small"
          type="primary"
          icon={phase === "downloading" ? <LoadingOutlined /> : <ArrowUpOutlined />}
          onClick={startUpdate}
          aria-label="更新可用"
        >
          {latestVersion ? `有更新 v${latestVersion}` : "有更新"}
        </Button>
      </Badge>
    </Tooltip>
  );
}
