/**
 * 结构性门禁：设置类界面必须有唯一落点、且不再是一面会顶出屏幕的卡片墙。
 *
 * 起因（2026-11-09 截图）：数据库板块的「AI 助手配置」把共享面板里
 * 18 家厂商的卡片墙塞进 560px 的居中 Modal，下半截厂商和保存按钮
 * 全被裁在屏幕外；设置入口还散在各板块自己的顶栏右上角。
 *
 * 现在的口径：
 * 1. 入口只有一个 —— 主壳活动栏左下角的账户/设置区，切板块不换位置；
 * 2. 弹窗只有一个形态 —— 分组下拉 + 固定高度滚动 + 常驻动作条；
 * 3. 判据仍只有一份 —— 继续调 shared 的 draftNeedsApiKey / draftIsConfigured。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const read = (p: string) => readFileSync(`${ROOT}/${p}`, "utf8");

describe("设置界面与左下角账户区", () => {
  it("数据库板块与设置中心共用紧凑表单，卡片墙已退役", () => {
    const db = read("src/apps/db/DbApp.tsx");
    const settings = read("src/components/SettingsModal.tsx");
    expect(db).toContain("<AiSettingsDialog");
    expect(db).not.toContain("DbAiSettingsPanel");
    expect(db).not.toContain('title="AI 助手配置"');
    expect(settings).toContain("<AiSettingsForm");
    expect(settings).not.toContain("FileAiSettingsPanel");
  });

  it("紧凑表单：内容区可滚动、动作条独立、判据仍走 shared", () => {
    const form = read("src/components/AiSettingsDialog.tsx");
    expect(form).toMatch(/maxHeight: scrollMax/);
    expect(form).toMatch(/overflowY: "auto"/);
    expect(form).toContain("groupPresets(");
    expect(form).toContain("draftNeedsApiKey(");
    expect(form).toContain("draftIsConfigured(");
    expect(form).toContain("applyPresetToDraft(");
    expect(form).not.toContain("zllm-cards");
    expect(form).toContain("配置只保存在本机");
    expect(form).toContain("notifyAiConfigSaved()");
  });

  it("左下角账户区对所有板块常驻，db 顶栏不再放第二个设置入口", () => {
    const app = read("src/App.tsx");
    const dock = read("src/components/AccountDock.tsx");
    const db = read("src/apps/db/DbApp.tsx");
    const footer = app.slice(app.indexOf("footer={"), app.indexOf("railPanel="));
    expect(footer).toContain("<AccountDock");
    expect(app).toContain('{activeApp === "files" && (');
    expect(app).toContain("initialTab={settingsTab}");
    expect(dock).toContain("本地模式 · 未登录");
    expect(dock).toContain("AI 服务设置");
    expect(dock).toContain("variant === \"sidebar\"");
    expect(db).not.toContain('aria-label="打开 AI 服务设置"');
    expect(db).not.toContain("<SettingOutlined />");
  });

  it("配置是整窗一份：保存后广播，db 的就绪状态会跟着重读", () => {
    expect(read("src/components/AiSettingsDialog.tsx")).toContain("aiConfigEvents");
    expect(read("src/apps/db/DbApp.tsx")).toContain("onAiConfigSaved(");
    expect(read("src/App.tsx")).toContain("onAiConfigSaved(read)");
  });
});
