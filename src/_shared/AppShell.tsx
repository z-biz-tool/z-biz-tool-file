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

const { Header, Sider, Content } = Layout;

interface AppShellProps {
  title: string;
  icon?: ReactNode;
  sidebar: ReactNode;
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

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl";

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
            <Tooltip title={`${modKey}+B 折叠侧栏`} placement="bottom">
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
          <Tooltip title={`${modKey}+Shift+L 切换主题`} placement="bottom">
            <Button
              type="text"
              size="small"
              icon={mode === "dark" ? <BulbFilled /> : <BulbOutlined />}
              onClick={toggle}
              aria-label={mode === "dark" ? "切换到亮色" : "切换到暗色"}
              title={mode === "dark" ? "切换到亮色" : "切换到暗色"}
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
      <Layout>
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