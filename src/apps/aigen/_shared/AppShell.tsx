import type { ReactNode } from "react";
import { Layout, Button, Space, Typography, theme } from "antd";
import { BulbOutlined, BulbFilled } from "@ant-design/icons";
import { useTheme } from "./ThemeContext";

const { Header, Sider, Content } = Layout;

interface AppShellProps {
  title: string;
  icon?: ReactNode;
  sidebar: ReactNode;
  headerExtra?: ReactNode;
  children: ReactNode;
  siderWidth?: number;
}

export function AppShell({
  title,
  icon,
  sidebar,
  headerExtra,
  children,
  siderWidth = 220,
}: AppShellProps) {
  const { mode, toggle } = useTheme();
  const { token } = theme.useToken();
  return (
    // 并入 file 后本壳嵌在主区里，再写 100vh 会顶出滚动条；改成 100% 吃满父容器
    <Layout style={{ height: "100%" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          height: 48,
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Space size={8}>
          {icon}
          <Typography.Text strong style={{ fontSize: 15 }}>
            {title}
          </Typography.Text>
        </Space>
        <Space>
          {headerExtra}
          <Button
            type="text"
            icon={mode === "dark" ? <BulbFilled /> : <BulbOutlined />}
            onClick={toggle}
            aria-label={mode === "dark" ? "切换到亮色" : "切换到暗色"}
            title={mode === "dark" ? "切换到亮色" : "切换到暗色"}
          />
        </Space>
      </Header>
      <Layout>
        <Sider
          width={siderWidth}
          style={{
            background: token.colorBgContainer,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            overflow: "auto",
          }}
        >
          {sidebar}
        </Sider>
        <Content style={{ overflow: "auto", background: token.colorBgLayout }}>{children}</Content>
      </Layout>
    </Layout>
  );
}
