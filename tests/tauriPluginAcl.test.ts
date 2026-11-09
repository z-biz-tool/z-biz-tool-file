/**
 * Tauri 插件 ↔ capabilities 的对应门禁。
 *
 * 2026-11-09 踩的坑：`tauri_plugin_notification::init()` 注册之后，插件会往
 * webview 注入一段启动脚本，页面加载就调
 * `plugin:notification|is_permission_granted`。但 capabilities 里只给了
 * core/clipboard/dialog/updater/process，没有 notification —— Tauri 直接按
 * ACL 拒绝，抛出的还是个未处理的 Promise 拒绝，启动守卫接住后整屏刷红：
 *
 *   Command plugin:notification|is_permission_granted not allowed by ACL
 *
 * 这个错误只有真跑打包产物才看得见：`cargo check` / `tsc` / 单测全绿，
 * 因为 ACL 是运行时判的、注入脚本也不在前端 bundle 里。
 *
 * 门禁思路：从 lib.rs 抽出所有 `tauri_plugin_xxx::init()` 的插件名，凡是
 * 会往 webview 注脚本、需要前端权限的，capabilities 必须给对应的 `xxx:default`。
 * 新增插件时如果忘了配权限，这条测试先红，不用等到打完包启动才发现。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(`${ROOT}${p}`, "utf-8");

/**
 * Cargo 包名 → capabilities 里的权限前缀。只列**前端会调**的插件。
 *
 * `tauri_plugin_opener` 不在此列：SSO 授权页由 Rust 侧 `opener::open_url`
 * 打开，不经过 webview IPC，给了权限反而是多余的攻击面。
 */
const ACL_REQUIRED: Record<string, string> = {
  tauri_plugin_clipboard_manager: "clipboard-manager",
  tauri_plugin_dialog: "dialog",
  tauri_plugin_updater: "updater",
  tauri_plugin_process: "process",
  tauri_plugin_notification: "notification",
};

describe("Tauri 插件权限", () => {
  const libRs = read("src-tauri/src/lib.rs");
  const caps = JSON.parse(read("src-tauri/capabilities/default.json")) as {
    permissions: unknown[];
  };
  /** 权限项既可能是字符串，也可能是 { identifier, allow } 对象。 */
  const identifiers = caps.permissions.map((p) =>
    typeof p === "string" ? p : String((p as { identifier?: unknown }).identifier ?? "")
  );

  it("lib.rs 里注册了哪个插件，capabilities 就得有对应权限", () => {
    const missing: string[] = [];
    for (const [crate, prefix] of Object.entries(ACL_REQUIRED)) {
      const registered = new RegExp(`${crate}::init\\(`).test(libRs);
      if (!registered) continue;
      const granted = identifiers.some(
        (id) => id === `${prefix}:default` || id.startsWith(`${prefix}:allow-`)
      );
      if (!granted) missing.push(`${crate} → 缺 ${prefix}:default`);
    }
    expect(missing).toEqual([]);
  });

  it("通知插件的注入脚本依赖 is_permission_granted，必须给 notification:default", () => {
    // 这条单独钉死：默认权限集里才包含 allow-is-permission-granted，
    // 只给某个 allow-* 子项容易漏。
    expect(libRs).toMatch(/tauri_plugin_notification::init\(\)/);
    expect(identifiers).toContain("notification:default");
  });

  it("acl-manifests 里确实存在 notification 的默认权限集（版本升级别悄悄改名）", () => {
    const manifest = JSON.parse(
      read("src-tauri/gen/schemas/acl-manifests.json")
    ) as Record<string, { default_permission?: { permissions?: string[] } }>;
    const perms = manifest.notification?.default_permission?.permissions ?? [];
    expect(perms).toContain("allow-is-permission-granted");
  });
});
