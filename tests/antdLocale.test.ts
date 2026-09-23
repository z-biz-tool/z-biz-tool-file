/**
 * 全站 locale 的端到端门禁：不是测 antd 自己的 zh_CN 内容，而是测**本应用**的
 * ConfigProvider 有没有把它接上。
 *
 * 为什么走 SSR：vitest 是 node 环境（没有 jsdom），而 renderToStaticMarkup 恰好
 * 会跑完整个 context 树（ConfigProvider → 组件），组件自带的英文文案（"No data"）
 * 就直接出现在返回的 HTML 里 —— 不接 locale 时它是英文，接上是中文。
 * ThemeProvider 里的 localStorage / matchMedia 都有 typeof window 守卫，SSR 下可用。
 */
import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Empty, Pagination } from "antd";
import { ThemeProvider } from "../src/_shared/ThemeContext";

/** 把节点装进应用自己的 ThemeProvider（它内含那个 ConfigProvider）再渲染成 HTML */
const render = (node: ReactNode) =>
  renderToStaticMarkup(createElement(ThemeProvider, null, node));

describe("ThemeProvider 必须把 antd 自带文案接到 zh_CN", () => {
  it("空状态：暂无数据，而不是 antd 默认的 No data", () => {
    const html = render(createElement(Empty));
    expect(html).toContain("暂无数据");
    expect(html).not.toMatch(/No data/i);
  });

  it("分页的每页条数选择器同样走中文 locale", () => {
    const html = render(
      createElement(Pagination, { total: 500, pageSize: 10, showSizeChanger: true })
    );
    expect(html).toContain("条/页");
    expect(html).not.toMatch(/\/ page/i);
  });
});
