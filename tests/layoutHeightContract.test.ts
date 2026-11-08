/**
 * 结构性门禁：思维导图板块的「主区高度链」不许再断。
 *
 * 2026-11-08 把 mind 从独立窗口搬进 file 之后，画布只占窗口上面一小条，
 * 下面露出主壳的渐变背景，看起来像凭空多出一大块白色。
 *
 * 根因不是画布，而是百分比高度链上有两层没有「确定高度」：
 *   1. file 主壳的 <Content> 只给了 min-height:100vh，没给 height —— 父级
 *      仍算 auto，子元素的 height:100% 解析不了；
 *   2. mind 自带的 antd <App> 会插一层 .ant-app div，默认 height:auto，
 *      .zm-shell 的 100% 就在这一层被掐断。
 * 结果画布塌到 MindCanvas 自己的 min-height(200px)，状态栏被顶到半屏，
 * 剩下的空间全是主壳背景。
 *
 * 修法分布在三个文件里，靠人记不住，做成静态门禁：谁把任意一层的
 * 显式高度删掉，这条就红。浏览器里的实测对照（去掉 .ant-app 的 100%）：
 *   shell 713px → 345px、画布 606px → 238px，与故障截图一致。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(`${ROOT}${p}`, "utf-8");

/** CSS 注释里也会写 height:100%，断言前必须清掉，否则会被文档骗过去。 */
const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBlock(css: string, selector: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = stripCssComments(css).match(re);
  return m?.[1] ?? "";
}

describe("主区高度链", () => {
  it("file 主壳的 Content 必须有显式 height，不能只有 min-height", () => {
    const src = read("src/_shared/AppShell.tsx");
    // 只盯 <Content> 的 style 块：别处写 height 不算数
    const content = src.match(/<Content[\s\S]*?>\s*\{?[\s\S]*?<\/Content>/)?.[0] ?? "";
    const styleBlock = content.match(/style=\{\{[\s\S]*?\}\}/)?.[0] ?? "";
    expect(styleBlock).toMatch(/height:\s*hideHeader\s*\?/);
    expect(styleBlock).toMatch(/minHeight:\s*hideHeader\s*\?/);
  });

  it("mind 的 antd App 容器必须带 100% 高度", () => {
    const src = read("src/apps/mind/App.tsx");
    expect(src).toMatch(/<AntdApp[^>]*style=\{\{\s*height:\s*["']100%["']\s*\}\}\s*>/);
  });

  it("mind 的外壳与主体两层都要有 height:100%", () => {
    const css = read("src/apps/mind/shared-style.css");
    expect(ruleBlock(css, ".zm-shell")).toMatch(/height:\s*100%/);
    expect(ruleBlock(css, ".zm-main")).toMatch(/height:\s*100%/);
  });
});
