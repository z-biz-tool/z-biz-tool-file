import type { ReactNode } from "react";
import { Button, Tooltip, theme } from "antd";
import { CloseOutlined } from "@ant-design/icons";

/**
 * 活动栏右侧的面板容器。
 *
 * 与原先宽侧栏里的 CollapsiblePanel 相比，这里是「一次只开一个」的抽屉：
 * 面板区整体只有一个标题栏 + 一块内容，切换入口时整块内容换掉。
 *
 * 为什么不保留 CollapsiblePanel 的多块并存：
 * 那三块（搜索 / 收藏夹 / 暂存栈）加起来要 280px，而在 13 寸屏上留给
 * 文件列表的宽度比这三块内容本身还值钱。收成抽屉后，没打开的面板不占任何
 * 横向空间 —— 想看哪个点哪个。
 */
export default function SidebarPanel({
  title,
  icon,
  children,
  onClose,
  extra,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /** 标题栏右侧的额外操作 */
  extra?: ReactNode;
}) {
  const { token } = theme.useToken();

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: token.colorBgContainer,
        overflow: "hidden",
      }}
    >      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 8px 10px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
        }}
      >
        {icon && <span style={{ color: token.colorTextSecondary, fontSize: 15, display: "inline-flex" }}>{icon}</span>}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: token.colorTextSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        {extra}
        <Tooltip title="关闭侧栏" placement="left" mouseEnterDelay={0.4}>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined style={{ fontSize: 12 }} />}
            onClick={onClose}
            aria-label="关闭侧栏"
            style={{ color: token.colorTextSecondary }}
          />
        </Tooltip>
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children}</div>
    </div>
  );
}
