import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";

type ThemeMode = "light" | "dark";

interface ThemeContextValue {
  mode: ThemeMode;
  toggle: () => void;
  setMode: (m: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "light",
  toggle: () => {},
  setMode: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

const STORAGE_KEY = "z-tool-theme";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const toggle = () => setMode((m) => (m === "light" ? "dark" : "light"));

  // 全站文案的中文半边一直缺着：手写的都是中文，antd 自带的却是英文（Table 空态
  // "No data"、分页 "10 / page"、排序 tooltip "Asc"，以及没写 okText 的弹窗按钮
  // "OK/Cancel"）。在这里补一次 locale 比在 26 个 Modal 上各写一遍 okText 可靠 ——
  // 以后新加的组件不会再漏。
  //
  // 它管不到的两类，各自单独处理：组件里写死的字面量（实测 aria-label="Close" 和
  // 标签页关闭按钮的 "remove" 加了 locale 后仍是英文），以及不吃 context 的静态
  // Modal.confirm() —— 那条路走的是模块级默认配置，主题和 locale 都读不到。
  return (
    <ThemeContext.Provider value={{ mode, toggle, setMode }}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: mode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: { colorPrimary: "#1677ff", borderRadius: 6, fontSize: 14 },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}
