import { useEffect, type ReactNode } from "react";
import { Layout, Button, Space, Typography, Tooltip } from "antd";
import {
  BulbOutlined,
  BulbFilled,
  MenuUnfoldOutlined,
  MenuFoldOutlined,
  FolderOutlined,
} from "@ant-design/icons";
import { useTheme } from "./ThemeContext";
import { useShortcutHint } from "./ShortcutHints";

const { Header, Sider, Content } = Layout;

interface AppShellProps {
  title: string;
  icon?: ReactNode;
  /** 旧模式：常驻宽侧栏内容。与 rail 二选一 */
  sidebar?: ReactNode;
  /**
   * 新模式：活动栏（窄图标栏，VS Code 那种）。
   * 给了 rail 就走「活动栏 + 可展开面板」布局，sidebar 被忽略。
   */
  rail?: ReactNode;
  /** 活动栏右侧展开的面板。null / undefined 表示面板收起 */
  railPanel?: ReactNode;
  /** 面板区宽度，默认 280 */
  railPanelWidth?: number;
  headerExtra?: ReactNode;
  children: ReactNode;
  siderWidth?: number;
  collapsedSider?: boolean;
  onToggleSider?: () => void;
}

export function AppShell({
  title,
  icon,
  sidebar,
  rail,
  railPanel,
  railPanelWidth = 280,
  headerExtra,
  children,
  siderWidth = 220,
  collapsedSider = false,
  onToggleSider,
}: AppShellProps) {
  const { mode, toggle } = useTheme();

  // 监听系统主题变化（仅在用户未手动覆盖时，这里仅作为提示）
  useEffect(() => {
    // 占位：未来若要支持"跟随系统"可在此实现
  }, [mode]);

  // 键位提示交给 App 的注册表推导：这里自己按平台拼一遍修饰键，既跟 matchSpec 的判定
  // 脱钩（注册表改了这里不会跟），也是全应用第三种书写口径。
  const hint = useShortcutHint();

  // 渐变色主题
  const headerGradient = mode === "dark"
    ? "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)"
    : "linear-gradient(135deg, #ffffff 0%, #f8fafd 100%)";
  
  const brandGradient = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";

  return (
    <Layout style={{ height: "100vh" }}>
      <Header
        role="banner"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px 0 12px",
          height: 48,
          background: headerGradient,
          boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
          borderBottom: `1px solid ${mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)"}`,
          transition: "background 0.3s ease",
        }}
      >
        <Space size={8} align="center">
          {onToggleSider && (
            <Tooltip
              title={`${collapsedSider ? "展开侧栏" : "折叠侧栏"}${hint("折叠/展开侧栏")}`}
              placement="bottom"
            >
              <Button
                type="text"
                size="small"
                icon={collapsedSider ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={onToggleSider}
                aria-label={collapsedSider ? "展开侧栏" : "折叠侧栏"}
                style={{
                  borderRadius: 8,
                  transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = mode === "dark" 
                    ? "rgba(255,255,255,0.1)"
                    : "rgba(0,0,0,0.04)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              />
            </Tooltip>
          )}
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: mode === "dark" 
                ? "linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
                : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 4px 12px rgba(102,126,234,0.25)",
              transition: "transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.transform = "scale(1.05) rotate(5deg)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.transform = "scale(1) rotate(0deg)";
            }}
          >
            {icon || <FolderOutlined style={{ color: "white", fontSize: 16 }} />}
          </div>
          <Typography.Text
            strong
            style={{
              fontSize: 15,
              fontWeight: 600,
              background: brandGradient,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            {title}
          </Typography.Text>
        </Space>
        <Space size={4}>
          {headerExtra}
          <Tooltip
            title={`${mode === "dark" ? "切换到亮色" : "切换到暗色"}${hint("切换主题")}`}
            placement="bottom"
          >
            <Button
              type="text"
              size="small"
              icon={mode === "dark" ? <BulbFilled /> : <BulbOutlined />}
              onClick={toggle}
              aria-label={mode === "dark" ? "切换到亮色" : "切换到暗色"}
              style={{
                borderRadius: 8,
                transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = mode === "dark" 
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(0,0,0,0.04)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
            />
          </Tooltip>
        </Space>
      </Header>
      {/*
        hasSider 是必须的：antd 的 Layout 默认 flex-direction: column，
        只有当它认得出来"这一行里有侧栏"时才切成 row。
        旧代码里有 <Sider>，antd 自己推断得出；换成活动栏的裸 div 之后，
        推断失效 —— 整行被竖着排，活动栏和面板上下叠起来（面板浮在窗口下半截）。
        这里显式声明，不依赖 antd 的隐式推断。
      */}
      <Layout hasSider>
        {/*
          活动栏模式：窄图标栏（rail）+ 可展开面板（railPanel）。
          rail 常驻只占 48px；面板按需展开，没打开时完全不占横向空间。
          旧模式（只给 sidebar）走下面的 Sider 分支，两种布局互不影响。
        */}
        {rail ? (
          <>
            {rail}
            {railPanel && (
              <div
                role="complementary"
                aria-label="侧栏面板"
                style={{
                  width: railPanelWidth,
                  flexShrink: 0,
                  // 只用 alignSelf: stretch 让这一列撑满行高。
                  // 不能同时写 height: "100%" —— 那一列在 flex 容器里高度未定，
                  // 百分比会按"父高度"解算，结果整块被推到视口下方（top=900）。
                  alignSelf: "stretch",
                  overflow: "hidden",
                  background: mode === "dark"
                    ? "linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)"
                    : "linear-gradient(180deg, #ffffff 0%, #f8fafd 100%)",
                  borderRight: `1px solid ${mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)"}`,
                  boxShadow: "2px 0 8px rgba(0,0,0,0.03)",
                }}
              >
                {railPanel}
              </div>
            )}
          </>
        ) : (
          <Sider
            width={siderWidth}
            collapsedWidth={0}
            collapsed={collapsedSider}
            trigger={null}
            collapsible={false}
            role="navigation"
            aria-label="侧栏导航"
            style={{
              background: mode === "dark"
                ? "linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)"
                : "linear-gradient(180deg, #ffffff 0%, #f8fafd 100%)",
              borderRight: `1px solid ${mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)"}`,
              overflow: "hidden",
              transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
              flexShrink: 0,
              boxShadow: collapsedSider ? "none" : "2px 0 8px rgba(0,0,0,0.03)",
            }}
          >
            <div
              style={{
                width: siderWidth,
                height: "100%",
                overflow: "auto",
                padding: "12px 8px",
              }}
            >
              {sidebar}
            </div>
          </Sider>
        )}
        <Content
          role="main"
          style={{
            overflow: "auto",
            background: mode === "dark"
              ? "linear-gradient(180deg, #0f0f23 0%, #1a1a2e 100%)"
              : "linear-gradient(180deg, #f8fafd 0%, #eef2f7 100%)",
            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            minHeight: "calc(100vh - 48px)",
          }}
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}