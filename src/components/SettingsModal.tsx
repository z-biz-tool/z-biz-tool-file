/**
 * 设置中心。
 *
 * ## 2026-11-09 改造：和数据库板块共用同一份紧凑表单
 *
 * 之前这里直接挂共享面板 `z-biz-tool-shared/ai/settings`：18 家厂商的
 * 卡片墙铺在 720px 的 Modal 里，数据库板块又在自己的 560px Modal 里
 * 再挂一遍同样的卡片墙 —— 同一份配置，两处长得不一样，而且都超出一屏。
 *
 * 现在两边都渲染 `AiSettingsForm`：分组下拉 + 密钥 / 模型 / 高级折叠 +
 * 固定高度滚动区 + 不随内容滚走的动作条。判据仍然只有 shared 一份
 * （要不要密钥、算不算配好、切厂商时地址怎么变），本文件只负责壳。
 *
 * 配置真源是家族统一落点（Rust `llm_config`），密钥不回显、只存本机。
 */

import { useRef, useState } from "react";
import { Modal, Tabs, theme } from "antd";
import { SettingOutlined } from "@ant-design/icons";

import {
  createAiSettingsActions,
  loadAiConfigView,
  type FileAiConfigView,
} from "./AiSettingsPanelAdapter";
import { AiSettingsForm } from "./AiSettingsDialog";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 左下角账户区「关于」直接落到关于页。 */
  initialTab?: "llm" | "about";
}

export default function SettingsModal({ open, onClose, initialTab = "llm" }: Props) {
  const { token } = theme.useToken();
  const [view, setView] = useState<FileAiConfigView | null>(null);
  // 动作对象必须稳定：表单拿它当 effect 依赖，每次渲染换引用会重复拉预设。
  const actionsRef = useRef<ReturnType<typeof createAiSettingsActions> | null>(null);
  if (!actionsRef.current) actionsRef.current = createAiSettingsActions();

  const refresh = () => {
    loadAiConfigView()
      .then(setView)
      .catch(() => setView(null));
  };

  return (
    <Modal
      open={open}
      afterOpenChange={(nextOpen) => {
        if (nextOpen) refresh();
      }}
      onCancel={onClose}
      footer={null}
      width={560}
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <SettingOutlined style={{ color: token.colorPrimary }} />
          设置
        </span>
      }
    >
      <Tabs
        defaultActiveKey={initialTab}
        tabBarStyle={{ padding: "0 20px", margin: 0 }}
        items={[
          {
            key: "llm",
            label: "AI 服务",
            children: (
              <AiSettingsForm
                view={view}
                actions={actionsRef.current!}
                onSaved={refresh}
                scrollMax="min(60vh, 480px)"
              />
            ),
          },
          {
            key: "about",
            label: "关于",
            children: (
              <div
                style={{
                  padding: "16px 20px 24px",
                  color: token.colorTextSecondary,
                  fontSize: 13,
                  lineHeight: 1.8,
                }}
              >
                <p style={{ margin: 0 }}>
                  <strong>z-biz-tool-file</strong> v0.2.2
                </p>
                <p style={{ margin: 0 }}>基于 Tauri 2 + React 19 + Rust 的本地工作台。</p>
                <p style={{ margin: 0 }}>
                  AI 服务由你自己配置，密钥保存在本机系统密钥库，不会上传到服务器。
                </p>
              </div>
            ),
          },
        ]}
      />
    </Modal>
  );
}
