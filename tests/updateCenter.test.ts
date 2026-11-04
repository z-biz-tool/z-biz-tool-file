/**
 * 更新角标 + 自我更新的判据门禁。
 *
 * ⚠️ 本仓跑的是 `vitest run`（见 package.json / vitest.config.ts），
 * import 必须写 `from "vitest"`。2026-11-04 刚踩过：从 db 仓照搬
 * `node:test` 的门禁文件，vitest 报 "No test suite found"，5 条断言
 * 连续三天一次都没执行过。别再抄错。
 *
 * 两层判据：
 *   1. 纯函数：什么情况才亮「有更新」红点（含 manifest 版本倒退的阴性对照）；
 *   2. 源码契约：入口点下去必须走 downloadAndInstall + relaunch，
 *      而不是打开「手动下载到 ~/Downloads」的老面板 —— 这正是本次需求的判据。
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  badgeOf,
  isNewerVersion,
  parseVersion,
} from "../src/components/updateBadge";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// ---------- 1. 版本判据 ----------

test("新版比当前高才判为更新（数值比较，不是字符串比较）", () => {
  assert.equal(isNewerVersion("0.2.3", "0.2.2"), true);
  assert.equal(isNewerVersion("0.3.0", "0.2.9"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  // 字符串比较会在这里翻车：'0.2.10' < '0.2.9'
  assert.equal(isNewerVersion("0.2.10", "0.2.9"), true);
  assert.equal(isNewerVersion("0.2.2.1", "0.2.2"), true);
});

test("相等、倒退、空串都不算更新 —— manifest 配错时宁可不亮红点", () => {
  assert.equal(isNewerVersion("0.2.2", "0.2.2"), false);
  assert.equal(isNewerVersion("0.2.1", "0.2.2"), false);
  assert.equal(isNewerVersion("v0.2.2", "0.2.2"), false);
  assert.equal(isNewerVersion("", "0.2.2"), false);
});

test("带 v 前缀 / 预发布后缀都能解析；同号预发布不算更新", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("0.2.3-beta.1"), [0, 2, 3]);
  assert.equal(isNewerVersion("v0.2.3", "0.2.2"), true);
  assert.equal(isNewerVersion("0.2.3-beta.1", "0.2.3"), false);
});

// ---------- 2. 红点判据 ----------

test("只有「有新版且空闲」才亮红点，并明确告诉用户可以自动更新", () => {
  const b = badgeOf({ hasUpdate: true, phase: "idle", latestVersion: "0.2.3" });
  assert.equal(b.show, true);
  assert.equal(b.tone, "update");
  assert.match(b.label, /有更新/);
  assert.match(b.label, /v0\.2\.3/);
  assert.match(b.label, /点击自动更新/);
});

test("没有新版不亮红点；检查/下载/装好各阶段也不误亮", () => {
  const none = badgeOf({ hasUpdate: false, phase: "idle", latestVersion: null });
  assert.equal(none.show, false);
  assert.equal(none.tone, "none");
  for (const phase of ["checking", "downloading"] as const) {
    const b = badgeOf({ hasUpdate: true, phase, latestVersion: "0.2.3" });
    assert.equal(b.show, false, `${phase} 阶段不该再挂红点`);
    assert.equal(b.tone, "busy");
  }
  assert.equal(badgeOf({ hasUpdate: false, phase: "installed", latestVersion: null }).tone, "done");
  assert.equal(badgeOf({ hasUpdate: false, phase: "error", latestVersion: null }).show, true);
});

// ---------- 3. 源码契约：入口必须真的能自我更新 ----------

test("顶栏与左下角两个入口都挂在 App 上，且不再由旧的静默检查驱动红点", () => {
  const app = read("src/App.tsx");
  assert.match(app, /<UpdateLauncher\s*\/>/, "左下角常驻入口没了");
  assert.match(app, /<UpdateTopButton\s*\/>/, "顶栏文字标记没了");
  assert.doesNotMatch(app, /updater_silent_check/, "角标又回退到 GitHub Releases 那套状态了");
  // 注意 setUpdaterOpen(true) 本身是合法的：手动下载面板要留作失败兜底。
  // 禁止的是「更新按钮点下去 = 打开手动下载面板」这个回退。
  assert.doesNotMatch(
    app,
    /onClick=\{\(\) => setUpdaterOpen\(true\)\}/,
    "顶栏按钮又变成打开手动下载面板了"
  );
  assert.match(
    app,
    /onOpenManualDownload=\{\(\) => setUpdaterOpen\(true\)\}/,
    "手动下载应只挂在浮层的兜底回调上"
  );
  assert.doesNotMatch(app, /<UpdaterGate\s*\/>/, "两套更新闸门又并存了");
});

test("点一下就 downloadAndInstall + 自动 relaunch，不再要求用户手动装", () => {
  const center = read("src/components/UpdateCenter.tsx");
  assert.match(center, /downloadAndInstall/, "没有真正安装更新");
  assert.match(center, /relaunch\(\)/, "装完没有自动重启");
  assert.match(
    center,
    /if \(hasUpdate\) \{\s*startUpdate\(\);/,
    "有更新时点击入口没有直接开始自我更新"
  );
  assert.match(center, /restartIn/, "缺自动重启倒计时 / 取消窗口");
  assert.match(center, /onOpenManualDownload/, "手动下载应降级为失败时的兜底，不是主路径");
});

test("判据模块不依赖 UI 运行时，测试才不会静默失效", () => {
  const pure = read("src/components/updateBadge.ts");
  assert.doesNotMatch(pure, /from ["']react["']/);
  assert.doesNotMatch(pure, /from ["']antd["']/);
  assert.doesNotMatch(pure, /@tauri-apps/);
});
