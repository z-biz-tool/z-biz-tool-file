import { useEffect, type ReactNode } from "react";
import { Layout, Button, Space, Tooltip, theme } from "antd";
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
  /**
   * 不渲染顶部 Header。
   *
   * file 仓走活动栏布局后，Header 左边只剩一个品牌图标、右边是一排窗口级按钮，
   * 而中间那条 48px 的高度什么都放不下 —— 等于用一整条横向空间换 7 个图标。
   * 打开这个开关后，调用方把那些按钮挪进自己的标签条（见 TabsBar 的 actions），
   * 品牌图标挪进活动栏顶部，窗口的"顶栏"就是标签条本身。
   *
   * 默认 false：其它形态（宽侧栏模式）仍然需要 Header 放折叠按钮。
   */
  hideHeader?: boolean;
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
  hideHeader = false,
  children,
  siderWidth = 220,
  collapsedSider = false,
  onToggleSider,
}: AppShellProps) {
  const { mode, toggle } = useTheme();
  const { token } = theme.useToken();

  // 监听系统主题变化（仅在用户未手动覆盖时，这里仅作为提示）
  useEffect(() => {
    // 占位：未来若要支持"跟随系统"可在此实现
  }, [mode]);

  // 键位提示交给 App 的注册表推导：这里自己按平台拼一遍修饰键，既跟 matchSpec 的判定
  // 脱钩（注册表改了这里不会跟），也是全应用第三种书写口径。
  const hint = useShortcutHint();

  // 顶栏背景：两套主题都用同一套，不再区分
  const headerGradient = mode === "dark"
    ? "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)"
    : "linear-gradient(135deg, #ffffff 0%, #f8fafd 100%)";

  return (
    <Layout style={{ height: "100vh" }}>
      {/* hideHeader 时不渲染这一条：file 仓改成「标签条即顶栏」，
          按钮交给 TabsBar.actions，品牌图标交给活动栏顶部 */}
      {!hideHeader && (
      <Header
        role="banner"
        // 应用名不再目视显示，但仍要留给读屏与窗口识别，否则顶栏就成了无标签区域
        aria-label={title}
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
          {/* 品牌图标：只留图标，不放应用名。
              macOS 的标题栏本来就写着窗口名，顶栏再重复一遍是同一个信息说两次，
              还占掉横向空间（右侧的操作按钮反而被挤）。紫渐变底也一并去掉 ——
              全站主色是 #1677ff，那个 #667eea→#764ba2 是另一套色，跟按钮对不上。 */}
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: token.colorFillTertiary,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {icon || <FolderOutlined style={{ color: token.colorPrimary, fontSize: 15 }} />}
          </div>
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
      )}
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
            // 没有 Header 时整条内容区就是满高，不能再减 48px（否则底部会空一条）
            minHeight: hideHeader ? "100vh" : "calc(100vh - 48px)",
          }}
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}