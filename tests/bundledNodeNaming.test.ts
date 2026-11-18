/**
 * 捆绑 node 可执行文件名的**四处契约**：打包脚本、Tauri 资源声明、Rust 运行时、JS 包装器
 * 必须对「Windows 叫 node.exe、其它平台叫 node」达成一致。
 *
 * ## 为什么这道门必须有（v0.2.3~v0.2.5 Windows 构建真实踩坑）
 *
 * 2026-11-18 之前，Windows 构建一直失败，日志报
 *   `resource path 'runtime\bin\node' doesn't exist`
 * 当时被误判为「OCR 的 ONNX Runtime 预编译库不支持 Windows」，于是把 Windows
 * 构建腿整个砍掉、只发 macOS-ARM。但真实根因与 ONNX 无关：
 *
 *   - Rust `node_exe_name()`（cfg(windows)）找的是 `node.exe`
 *   - pi.js `bundledNode()`（win32）找的是 `node.exe`
 *   - 但 `prepare-runtime.sh` 写死拷成无扩展名的 `node`
 *   - `tauri.conf.json` 也写死 `runtime/bin/node`
 *
 * Windows 上 node 真实文件就是 `node.exe`，无扩展名的 `node` 在 Tauri build.rs
 * 校验 resources 时不存在 ⇒ 打包失败。macOS 上 node 本就无扩展名，所以一直没暴露。
 *
 * 这类不一致是**静默的跨平台漂移**：在主力机型（macOS）上全绿，只在次要平台炸。
 * 所以必须把四处的约定从源码抽出来逐字比对，改任何一处而漏改其余就立刻红。
 *
 * 变异对照：把 prepare-runtime.sh 的 `node.exe` 改成 `node` ⇒ 第 1 条立刻红；
 * 把 tauri.conf 的 glob 改回 `runtime/bin/node` ⇒ 第 2 条立刻红。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(`${ROOT}${p}`, "utf-8");

describe("捆绑 node 命名：四处契约一致", () => {
  const script = read("scripts/prepare-runtime.sh");
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    bundle: { resources: Record<string, string> };
  };
  const rust = read("src-tauri/src/worker_app/agent_proxy.rs");
  const pi = read("src-tauri/agent-proxy-dist/wrappers/pi.js");

  it("prepare-runtime.sh 在 Windows 分支产出 node.exe、其它平台产出 node", () => {
    // case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) NODE_FILENAME="node.exe" ;; *) NODE_FILENAME="node" ;;
    const winBranch = /MINGW\*\|MSYS\*\|CYGWIN\*\)\s*NODE_FILENAME="node\.exe"/.test(script);
    const unixBranch = /\)\s*NODE_FILENAME="node"/.test(script);
    expect(winBranch, "Windows 分支应设 NODE_FILENAME=node.exe").toBe(true);
    expect(unixBranch, "默认分支应设 NODE_FILENAME=node").toBe(true);
    // 拷贝目标必须用变量，不能写死 node（那正是踩过的坑）
    expect(script).toMatch(/cp "\$NODE_BIN" "\$RT\/bin\/\$NODE_FILENAME"/);
  });

  it("tauri.conf 用 runtime/bin/* glob 覆盖 node 与 node.exe 两种文件名", () => {
    const resources = conf.bundle.resources;
    expect(Object.keys(resources), "resources 必须用 glob 才能同时覆盖 node/node.exe").toContain(
      "runtime/bin/*"
    );
    expect(resources["runtime/bin/*"]).toBe("runtime/bin/");
    // 不能再有写死的单文件条目，否则 Windows 上 node.exe 与它并存会混淆
    expect(Object.keys(resources)).not.toContain("runtime/bin/node");
    // 另外两块运行时资源不能被误删
    expect(resources["runtime/lib/pi"]).toBe("runtime/lib/pi");
    expect(resources["runtime/agent-proxy/dist"]).toBe("runtime/agent-proxy/dist");
  });

  it("Rust node_exe_name() 在 cfg(windows) 返回 node.exe、否则 node", () => {
    // #[cfg(windows)] fn node_exe_name() -> &'static str { "node.exe" }
    // #[cfg(not(windows))] fn node_exe_name() -> &'static str { "node" }
    expect(rust).toMatch(
      /#\[cfg\(windows\)\]\s*fn node_exe_name\(\)\s*->\s*&'static str\s*\{\s*"node\.exe"\s*\}/
    );
    expect(rust).toMatch(
      /#\[cfg\(not\(windows\)\)\]\s*fn node_exe_name\(\)\s*->\s*&'static str\s*\{\s*"node"\s*\}/
    );
  });

  it("pi.js bundledNode() 在 win32 用 node.exe、否则 node", () => {
    // process.platform === "win32" ? path.join(runtime, "bin", "node.exe") : path.join(runtime, "bin", "node")
    expect(pi).toMatch(/process\.platform\s*===\s*"win32"/);
    expect(pi).toMatch(/path\.join\(runtime,\s*"bin",\s*"node\.exe"\)/);
    expect(pi).toMatch(/path\.join\(runtime,\s*"bin",\s*"node"\)/);
  });
});
