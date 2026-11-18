import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

// 最外层必须有边界：任何一处渲染异常原本会把整棵树卸载成白屏，只能重启应用
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// 标记「应用已挂载」：boot-guard 只该在**启动期**兜底（模块加载失败、顶层抛错、
// #root 空白）。挂载之后的运行期故障由 ErrorBoundary / 各自的 catch 负责 ——
// 否则任意一个运行期未处理的 Promise 拒绝都会把整个窗口糊成一张错误页
// （2026-11-18 踩过：antd v6 的 modal.confirm 在 onOk 被拒时会重新抛出该拒绝）。
requestAnimationFrame(() => {
  (window as unknown as { __APP_MOUNTED__?: boolean }).__APP_MOUNTED__ = true;
});
