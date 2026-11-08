/**
 * 左下角「账户 / 登录态 + 设置」区。
 *
 * ## 为什么要有这一块
 *
 * 设置入口原先散在各板块自己的顶栏右上角：数据库板块一个齿轮、
 * 文件板块又一个齿轮，切板块就换位置；而登录态 / 服务状态根本没有
 * 一个常驻的落点。用户截了那张超长的 AI 配置弹窗后提的是：
 * 「设置性质的东西能不能放左下角，专门一个相当于登录态 + setting 的地方」。
 *
 * 这就是 VS Code 活动栏底部那一组（账户 + 管理）的形态：
 * - **常驻在左下角**，切到任何板块都在同一个位置；
 * - **状态可读**：本机账户、是否登录、AI 服务、连接、主题；
 * - **设置只有这一个入口**：AI 服务设置 / 主题 / 全局设置 / 关于都从这里进。
 *
 * ## 关于「登录态」
 *
 * 现在这套应用没有云账号，不能画一个假头像假用户名。这里如实写
 * 「本机工作区 · 本地模式 · 未登录」，把状态点留给真正会变的东西
 * （AI 是否配好、有没有连上库）。将来接了 SSO，只要换掉头部那一块，
 * 下面整张状态/设置菜单不用动。
 *
 * 两种形态共用一个菜单：
 * - `rail`：48px 活动栏底部，两枚 40px 图标（账户 / 设置）；
 * - `sidebar`：宽侧栏底部，一条整宽的状态条（没有活动栏的独立 app 用）。
 */

import { useState, type ReactNode } from "react";
import { Avatar, Badge, Button, Divider, Popover, Space, Typography, theme } from "antd";
import {
  BulbOutlined,
  InfoCircleOutlined,
  RightOutlined,
  RobotOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons";

const { Text } = Typography;

export interface AccountDockProps {
  variant?: "rail" | "sidebar";
  /** AI 服务是否已就绪（后端判，不由界面猜）。 */
  aiConfigured?: boolean;
  /** 连接态文案，如「已连 prod-db」。不传则不显示这一行（没进数据库板块时）。 */
  connectionLabel?: string;
  /** 当前外观，如「亮色」/「深色」。 */
  themeLabel?: string;
  onOpenAiSettings: () => void;
  onOpenGeneralSettings?: () => void;
  onToggleTheme?: () => void;
  onAbout?: () => void;
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "muted";
}) {
  const { token } = theme.useToken();
  const color =
    tone === "ok"
      ? token.colorSuccess
      : tone === "warn"
        ? token.colorWarning
        : token.colorTextTertiary;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "3px 0",
        fontSize: 12,
      }}
    >
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            color: token.colorText,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {value}
        </span>
      </span>
    </div>
  );
}

function MenuRow({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  const { token } = theme.useToken();
  return (
    <Button
      type="text"
      block
      onClick={onClick}
      style={{
        height: 38,
        padding: "0 10px",
        borderRadius: token.borderRadius,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <Space size={10}>
        <span style={{ color: token.colorPrimary, fontSize: 15, display: "inline-flex" }}>
          {icon}
        </span>
        <span style={{ fontSize: 13 }}>{label}</span>
      </Space>
      <Space size={4}>
        {hint && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {hint}
          </Text>
        )}
        <RightOutlined style={{ fontSize: 10, color: token.colorTextTertiary }} />
      </Space>
    </Button>
  );
}

export default function AccountDock({
  variant = "rail",
  aiConfigured = false,
  connectionLabel,
  themeLabel,
  onOpenAiSettings,
  onOpenGeneralSettings,
  onToggleTheme,
  onAbout,
}: AccountDockProps) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const connected = !!connectionLabel && connectionLabel !== "未连接";

  const close = () => setOpen(false);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const card = (
    <div style={{ width: 268 }} data-testid="account-dock-card">
      {/* 账户 / 登录态 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px" }}>
        <Badge dot color={aiConfigured ? token.colorSuccess : token.colorWarning}>
          <Avatar
            size={36}
            icon={<UserOutlined />}
            style={{ background: token.colorPrimaryBg, color: token.colorPrimary }}
          />
        </Badge>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: token.colorText }}>
            本机工作区
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            本地模式 · 未登录
          </Text>
        </div>
        <Button
          type="text"
          size="small"
          aria-label="打开设置"
          icon={<SettingOutlined />}
          onClick={run(onOpenGeneralSettings ?? onOpenAiSettings)}
        />
      </div>

      <Divider style={{ margin: 0 }} />

      <div style={{ padding: "8px 16px" }}>
        <StatusRow
          label="AI 服务"
          value={aiConfigured ? "已就绪" : "未配置"}
          tone={aiConfigured ? "ok" : "warn"}
        />
        {connectionLabel !== undefined && (
          <StatusRow
            label="数据库连接"
            value={connectionLabel}
            tone={connected ? "ok" : "muted"}
          />
        )}
        {themeLabel && <StatusRow label="外观" value={themeLabel} tone="muted" />}
      </div>

      <Divider style={{ margin: 0 }} />

      <div style={{ padding: "6px 8px" }}>
        <MenuRow
          icon={<RobotOutlined />}
          label="AI 服务设置"
          hint="模型 / 密钥"
          onClick={run(onOpenAiSettings)}
        />
        {onToggleTheme && (
          <MenuRow
            icon={<BulbOutlined />}
            label="切换外观"
            hint={themeLabel}
            onClick={run(onToggleTheme)}
          />
        )}
        {onOpenGeneralSettings && (
          <MenuRow
            icon={<SettingOutlined />}
            label="全局设置"
            onClick={run(onOpenGeneralSettings)}
          />
        )}
        {onAbout && <MenuRow icon={<InfoCircleOutlined />} label="关于" onClick={run(onAbout)} />}
      </div>

      <div
        style={{
          padding: "10px 16px",
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          fontSize: 11,
          color: token.colorTextTertiary,
        }}
      >
        密钥只保存在本机系统密钥库，不会上传
      </div>
    </div>
  );

  const avatar = (
    <Badge dot color={aiConfigured ? token.colorSuccess : token.colorWarning}>
      <Avatar
        size={variant === "rail" ? 24 : 32}
        icon={<UserOutlined />}
        style={{
          background: token.colorPrimaryBg,
          color: token.colorPrimary,
          fontSize: variant === "rail" ? 13 : 16,
        }}
      />
    </Badge>
  );

  if (variant === "sidebar") {
    return (
      <Popover
        content={card}
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement="topLeft"
        styles={{ content: { padding: 0 } }}
      >
        <button
          type="button"
          aria-label="账户与设置"
          data-testid="account-dock-trigger"
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            border: "none",
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            background: "transparent",
            color: token.colorText,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          {avatar}
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>本机工作区</span>
            <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
              本地模式 · 未登录 · {aiConfigured ? "AI 已就绪" : "AI 未配置"}
            </span>
          </span>
          <SettingOutlined style={{ color: token.colorTextTertiary }} />
        </button>
      </Popover>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <Popover
        content={card}
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement="rightTop"
        styles={{ content: { padding: 0 } }}
      >
        <button
          type="button"
          aria-label="账户与状态"
          title="账户与状态"
          data-testid="account-dock-trigger"
          style={{
            width: 40,
            height: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: 8,
            background: open ? token.colorFillTertiary : "transparent",
            cursor: "pointer",
          }}
        >
          {avatar}
        </button>
      </Popover>
      <button
        type="button"
        aria-label="设置"
        title="设置"
        style={{
          width: 40,
          height: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          borderRadius: 8,
          background: "transparent",
          color: token.colorTextSecondary,
          fontSize: 18,
          cursor: "pointer",
        }}
        onClick={onOpenGeneralSettings ?? onOpenAiSettings}
      >
        <SettingOutlined />
      </button>
    </div>
  );
}
