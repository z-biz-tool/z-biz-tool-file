import { useMemo, type ReactNode } from "react";
import { Badge, Tooltip, theme } from "antd";
import { MoreOutlined } from "@ant-design/icons";

/**
 * 活动栏（Activity Bar）—— VS Code 那种左侧窄图标栏。
 *
 * 为什么是「窄图标 + 点击展开面板」而不是现在这种 280px 常驻宽侧栏：
 * 宽侧栏里的三块（搜索 / 收藏夹 / 暂存栈）互相挤占空间，而真正占地方的
 * 是它们各自的展开态。活动栏把「有哪些能力」和「当前展开了哪个」拆成两件事：
 * 图标栏常年只占 48px，面板区按需展开，没打开的面板不占任何横向空间。
 *
 * 这也是家族往 file 里合并能力的落点形态 —— 每个新能力（终端、PDF、OCR、
 * 远程、下载…）在活动栏上只是一个图标，不需要再往宽侧栏里塞一整个 CollapsiblePanel。
 */

export interface ActivityBarItem {
  /** 稳定标识，用于受控选中与持久化 */
  key: string;
  /** 无障碍标签与 tooltip 主文案 */
  label: string;
  icon: ReactNode;
  /** 角标（如未完成数、错误数）。不传则不显示 */
  badge?: number;
  /** 点击后要执行的动作。与 panelContent 互斥：二选一 */
  onClick?: () => void;
  /** 点击后在面板区渲染的内容。与 onClick 互斥：二选一 */
  panelContent?: ReactNode;
  /** 禁用态 */
  disabled?: boolean;
  /** 分组归属。相邻同组项之间会画一条分隔线 */
  group?: string;
}

export interface ActivityBarProps {
  items: ActivityBarItem[];
  /** 当前选中的 key。空字符串表示面板区收起 */
  activeKey: string;
  onActiveChange: (key: string) => void;
  /** 底部按钮（如「更多」） */
  footer?: ReactNode;
  /** 宽度，默认 48（VS Code 默认值） */
  width?: number;
}

export default function ActivityBar({
  items,
  activeKey,
  onActiveChange,
  footer,
  width = 48,
}: ActivityBarProps) {
  const { token } = theme.useToken();

  /**
   * 分组：在相邻项的 group 不同时插一条分隔线。
   * 做法是记住上一项的 group，而不是给每一组显式标 separator ——
   * 那样调用方每加一项都得记得维护分隔位置，漏一个就是一个视觉缺口。
   */
  const rendered = useMemo(
    () =>
      items.map((item, i) => {
        const prev = items[i - 1];
        const needsSeparator = i > 0 && prev && prev.group !== item.group;
        return { item, needsSeparator };
      }),
    [items],
  );

  return (
    <div
      role="tablist"
      aria-label="功能入口"
      style={{
        width,
        flexShrink: 0,
        // 撑满整列高度：只用 alignSelf: stretch，不写 height: "100%"。
        // 后者在高度未定的 flex 列里会把整块推到视口下方。
        alignSelf: "stretch",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "8px 0",
        gap: 2,
        background: token.colorBgElevated,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      {rendered.map(({ item, needsSeparator }) => {
        const isActive = item.key === activeKey;
        return (
          <div key={item.key} style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
            {needsSeparator && (
              <div
                aria-hidden
                style={{
                  width: 24,
                  height: 1,
                  margin: "6px 0",
                  background: token.colorBorderSecondary,
                }}
              />
            )}
            <Tooltip title={item.label} placement="right" mouseEnterDelay={0.4}>
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={item.label}
                disabled={item.disabled}
                onClick={() => {
                  // 点已激活的项 = 收起面板区（VS Code 的行为）。
                  // 这样用户永远有一条「关掉侧边面板」的路，不必去按标题栏的折叠按钮。
                  onActiveChange(isActive ? "" : item.key);
                }}
                style={{
                  position: "relative",
                  width: 40,
                  height: 40,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  borderRadius: 8,
                  cursor: item.disabled ? "not-allowed" : "pointer",
                  background: isActive ? token.colorFillTertiary : "transparent",
                  color: isActive ? token.colorText : token.colorTextSecondary,
                  opacity: item.disabled ? 0.4 : 1,
                  fontSize: 18,
                  transition: "background 0.15s, color 0.15s",
                }}
              >
                {/* 激活指示条：VS Code 是靠左侧一根竖条，而不是背景色 */}
                {isActive && (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: -4,
                      top: 8,
                      bottom: 8,
                      width: 3,
                      borderRadius: "0 2px 2px 0",
                      background: token.colorPrimary,
                    }}
                  />
                )}
                {item.badge !== undefined && item.badge > 0 ? (
                  <Badge count={item.badge} size="small" offset={[8, -6]}>
                    <span style={{ display: "inline-flex" }}>{item.icon}</span>
                  </Badge>
                ) : (
                  item.icon
                )}
              </button>
            </Tooltip>
          </div>
        );
      })}

      {/* 底部区域：贴底对齐，多余的入口（比如「更多」）塞这里 */}
      {footer && (
        <div style={{ marginTop: "auto", paddingTop: 8, display: "flex", flexDirection: "column", alignItems: "center" }}>
          {footer}
        </div>
      )}
    </div>
  );
}

/**
 * 活动栏底部的「更多」按钮。
 * 单独抽出来是因为它的样式（贴底、无背景、只有 hover 才有底色）和普通项不一样。
 */
export function ActivityBarMore({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const { token } = theme.useToken();
  return (
    <Tooltip title={label} placement="right" mouseEnterDelay={0.4}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        style={{
          width: 40,
          height: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
          background: "transparent",
          color: token.colorTextSecondary,
          fontSize: 18,
          transition: "background 0.15s, color 0.15s",
        }}
      >
        <MoreOutlined />
      </button>
    </Tooltip>
  );
}
