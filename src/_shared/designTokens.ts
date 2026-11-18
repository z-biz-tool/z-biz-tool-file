import { theme as antdTheme, type ThemeConfig } from "antd";

/**
 * 全站设计语言「墨青」的唯一出处：
 *   - 主色：深青绿（light #0f766e / dark #0d9488，白字对比度都过 WCAG AA 大字号）
 *   - 中性底：暖纸灰（冷蓝灰的 #f8fafd 系整体退役）
 *   - 圆角：控件 8 / 容器 12 / 小件 6 三档，禁止手写其它值
 * file 与 terminal 两个入口共用这里，改设计只动这一个文件。
 */
export function zToolTheme(mode: "light" | "dark"): ThemeConfig {
  const isDark = mode === "dark";
  const primary = isDark ? "#0d9488" : "#0f766e";
  const token: ThemeConfig["token"] = {
    colorPrimary: primary,
    colorInfo: primary,
    colorLink: primary,
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    fontSize: 14,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei", "Helvetica Neue", sans-serif',
  };
  if (!isDark) {
    // 暖纸灰布局底；暗色交给 darkAlgorithm 推导，不给固定值
    token.colorBgLayout = "#f4f4f0";
  }
  const components: ThemeConfig["components"] = {
    Button: {
      fontWeight: 500,
      primaryShadow: isDark ? "none" : "0 2px 8px rgba(15, 118, 110, 0.28)",
    },
    Card: { borderRadiusLG: 12 },
    Table: isDark
      ? { headerSplitColor: "transparent" }
      : { headerBg: "#f7f7f3", headerSplitColor: "transparent" },
    Segmented: isDark ? {} : { trackBg: "#e9e9e3" },
  };
  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token,
    components,
  };
}
