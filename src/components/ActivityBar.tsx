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

/**
 * 活动栏最上面那截的「应用」条目。
 *
 * 和下面的 ActivityBarItem 是两种东西，别混：
 * - **应用**决定主区渲染哪个板块（文件管理、笔记…），永远有且只有一个处于选中态，
 *   点它 = 进入那个板块，不是"展开一个面板"；
 * - **功能项**是板块内部的小功能（搜索/收藏夹/终端…），点它 = 展开一块面板，
 *   再点一次收起。
 * 两者的选中语义不同，所以分成两个接口、两段渲染，不共用一个 items 数组。
 */
export interface ActivityBarApp {
  /** 稳定标识，同时是主区渲染的分支判据 */
  key: string;
  /** 无障碍标签与 tooltip 文案 */
  label: string;
  icon: ReactNode;
  /** 禁用态（比如依赖的服务没起来） */
  disabled?: boolean;
}

export interface ActivityBarProps {
  items: ActivityBarItem[];
  /** 当前选中的 key。空字符串表示面板区收起 */
  activeKey: string;
  onActiveChange: (key: string) => void;
  /** 底部按钮（如「更多」） */
  footer?: ReactNode;
  /**
   * 应用入口（活动栏上半截）。不传则这一截不渲染。
   *
   * 放这里是因为窗口最上面一行是「活动栏 + 标签条」，应用图标在这一截
   * 正好和标签条同一条水平线 —— VS Code / Files 的摆法。
   * 下方一条通栏分隔线把「应用」和「功能」明确切成两段。
   */
  apps?: ActivityBarApp[];
  /** 当前所在应用。默认第一个 */
  activeApp?: string;
  onAppChange?: (key: string) => void;
  /** 宽度，默认 48（VS Code 默认值） */
  width?: number;
}

export default function ActivityBar({
  items,
  activeKey,
  onActiveChange,
  footer,
  apps,
  activeApp,
  onAppChange,
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
      // 整栏是导航区。里面两截语义不同（应用 / 功能项），所以 role 挂在各自的容器上，
      // 而不是整栏一个 tablist —— 应用按钮不是 tab，塞进 tablist 是无效 ARIA。
      role="navigation"
      aria-label="左侧导航栏"
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
      {/* ── 上半截：应用。决定主区进哪个板块 ── */}
      {apps && apps.length > 0 && (
        <div
          role="group"
          aria-label="应用"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            width: "100%",
            // 高度：活动栏 padding-top 8 + 这里 32 = 40，正好等于标签条的高度，
            // 下面那条分隔线才和标签条的下边框在同一条水平线上（写自适应会错开几像素）。
            paddingBottom: 4,
            // 这条是「应用 / 功能」的分界线，比组间那根短线要重一档：
            // 组间分隔是同一类东西的分段（浅色 secondary），这里是两类东西的边界。
            borderBottom: `1px solid ${token.colorBorder}`,
          }}
        >
          {apps.map((app) => {
            // 应用永远"选中一个"：不传 activeApp 时默认第一个，
            // 免得调用方漏传导致一排图标都不亮、看不出自己在哪个板块。
            const isActive = app.key === (activeApp ?? apps[0]?.key);
            return (
              <Tooltip key={app.key} title={app.label} placement="right" mouseEnterDelay={0.4}>
                <button
                  type="button"
                  aria-label={app.label}
                  aria-current={isActive ? "true" : undefined}
                  disabled={app.disabled}
                  onClick={() => onAppChange?.(app.key)}
                  style={{
                    width: 28,
                    height: 28,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "none",
                    borderRadius: 7,
                    cursor: app.disabled ? "not-allowed" : "pointer",
                    // 应用不像功能项那样"能关掉"，所以不用左侧竖条，
                    // 用整块底色表达"我在这个板块里"。
                    background: isActive ? token.colorFillSecondary : "transparent",
                    color: isActive ? token.colorPrimary : token.colorTextSecondary,
                    opacity: app.disabled ? 0.4 : 1,
                    fontSize: 16,
                    transition: "background 0.15s, color 0.15s",
                  }}
                >
                  {app.icon}
                </button>
              </Tooltip>
            );
          })}
        </div>
      )}

      {/* ── 下半截：功能项。点开一块面板，再点收起 ── */}
      <div
        role="tablist"
        aria-label="功能入口"
        style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, width: "100%" }}
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
                  // 两类入口的语义不同，必须分开走（原来只有下面那一行，
                  // 于是「工具箱 / 下载 / 远程 / 回收站」这四个配了 onClick 的
                  // 入口点了完全没反应 —— 它们的动作根本没被调用过）：
                  //
                  // - **弹窗型**（onClick）：工具箱、下载、远程、回收站。点一下
                  //   打开一个弹窗/管理器，栏上不留选中态（弹窗关掉后没有
                  //   「这个入口正开着」这回事）。
                  // - **面板型**（无 onClick）：搜索、收藏夹、暂存栈、终端。
                  //   切换面板区的展开与收起；再点一次收起（VS Code 的行为），
                  //   这样用户永远有一条关掉侧边面板的路。
                  if (item.onClick) {
                    item.onClick();
                    return;
                  }
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
      </div>

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
