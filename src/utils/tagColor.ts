/**
 * 标签色板 —— 单独成文件，不与 TagEditModal 放一起。
 *
 * 2026-11-06 性能优化：TagEditModal 整个拆出启动包（只有点开标签编辑才需要），
 * 但 App.tsx 还有一处要**同步**读标签颜色（列表里渲染彩色 Tag）。
 * 如果 `getTagColor` 继续留在 TagEditModal.tsx 里，App.tsx 就得静态 import
 * 那个文件 —— 于是整个弹窗（连它拖进来的 antd Form / Select）又回到首屏包里，
 * 拆包等于白做。
 *
 * 所以把纯函数挪到这儿：它不带任何 React / antd 依赖，
 * 静态 import 的代价只有几百字节。
 */

/** 标签可选的颜色名（与 TagEditModal 里的选择项保持一致） */
export const TAG_COLORS = [
  { value: "", label: "无" },
  { value: "red", label: "红", color: "#f5222d" },
  { value: "orange", label: "橙", color: "#fa8c16" },
  { value: "yellow", label: "黄", color: "#fadb14" },
  { value: "green", label: "绿", color: "#52c41a" },
  { value: "blue", label: "蓝", color: "#1677ff" },
  { value: "purple", label: "紫", color: "#722ed1" },
  { value: "gray", label: "灰", color: "#8c8c8c" },
] as const;

const COLOR_HEX: Record<string, string> = {
  red: "#f5222d",
  orange: "#fa8c16",
  yellow: "#fadb14",
  green: "#52c41a",
  blue: "#1677ff",
  purple: "#722ed1",
  gray: "#8c8c8c",
};

/** 取标签颜色的十六进制值；未知颜色名返回 undefined（交给 antd Tag 用默认色） */
export function getTagColor(name: string): string | undefined {
  return COLOR_HEX[name];
}
