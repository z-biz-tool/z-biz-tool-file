/**
 * 设置面板。
 *
 * ## 2026-11-01 改造：AI 配置接入家族统一落点 + 统一面板
 *
 * LLM 设置整页换成共享面板 `z-biz-tool-shared/ai/settings`：
 *
 * - 18 家厂商预设、模型列表拉取、结构化失败（kind + hint + focus）、
 *   「已保存密钥」占位 —— 判据与交互都收口在 shared 一处；
 * - 配置真源改为家族统一落点（`~/.z-biz-tool/llm/config.json` + OS 密钥库），
 *   本仓原来的明文 `llm.json` 由启动迁移器搬入并抹掉密钥；
 * - 本仓只留适配层（见 `AiSettingsPanelAdapter.tsx`）：IPC 命令名、
 *   字段名翻译、失败透传。渲染判据一行不写。
 *
 * 旧的自绘表单（约 600 行：预设下拉 / 密钥框 / 模型 AutoComplete /
 * 高级折叠 / FailureAlert）全部退役 —— 它们的每一项判据在共享面板里
 * 都有对应的、经过家族测试的实现。
 */

import { useState } from "react";
import { Modal, Tabs } from "antd";
import { SettingOutlined } from "@ant-design/icons";

import { FileAiSettingsPanel, loadAiConfigView, type FileAiConfigView } from "./AiSettingsPanelAdapter";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const [view, setView] = useState<FileAiConfigView | null>(null);

  // 面板打开时读一次已保存配置（脱敏视图）。读失败不挡填表 ——
  // 用户可以当没配过从头填，保存会覆盖。
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && view === null) {
      loadAiConfigView()
        .then(setView)
        .catch(() => setView(null));
    }
  };

  return (
    <Modal
      open={open}
      afterOpenChange={handleOpenChange}
      onCancel={onClose}
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
            label: <span>AI / LLM</span>,
            children: (
              <div style={{ padding: "8px 0" }}>
                <FileAiSettingsPanel
                  view={view}
                  onSaved={() => {
                    // 保存后刷新脱敏视图（hasApiKey 可能从无到有）
                    loadAiConfigView()
                      .then(setView)
                      .catch(() => {});
                  }}
                />
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
