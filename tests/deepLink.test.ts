/**
 * file 仓深链语义层的单测。
 *
 * 语义层是纯函数，所以这里不碰 Tauri、不碰 store，只喂 Handoff 看结果。
 */
import { describe, expect, it } from "vitest";
import { resolveFileDeepLink } from "../src/_shared/deepLink";
import type { Handoff } from "z-biz-tool-shared/protocol";

function handoff(action: string, params: Record<string, string> = {}): Handoff {
  return { product: "file", action, params };
}

describe("file 深链语义", () => {
  it("open 带 file：定位到该文件并承诺打开", () => {
    const out = resolveFileDeepLink(handoff("open", { file: "/tmp/a.md" }));
    expect(out.problem).toBeNull();
    expect(out.path).toBe("/tmp/a.md");
    expect(out.shouldOpen).toBe(true);
  });

  it("reveal 只保证看得见，不承诺打开", () => {
    const out = resolveFileDeepLink(handoff("reveal", { file: "/tmp/a.md" }));
    expect(out.problem).toBeNull();
    expect(out.path).toBe("/tmp/a.md");
    expect(out.shouldOpen).toBe(false);
  });

  it("action 缺省按 open 处理", () => {
    const out = resolveFileDeepLink(handoff("", { file: "/tmp/a.md" }));
    expect(out.shouldOpen).toBe(true);
    expect(out.path).toBe("/tmp/a.md");
  });

  it("dir 参数直接定位到目录", () => {
    const out = resolveFileDeepLink(handoff("open", { dir: "/tmp" }));
    expect(out.problem).toBeNull();
    expect(out.path).toBe("/tmp");
    expect(out.shouldOpen).toBe(false);
  });

  it("file 与 dir 同时给，file 优先（更具体）", () => {
    const out = resolveFileDeepLink(handoff("open", { file: "/tmp/a.md", dir: "/tmp" }));
    expect(out.path).toBe("/tmp/a.md");
  });

  it("既没有 file 也没有 dir：接不住并说明原因", () => {
    const out = resolveFileDeepLink(handoff("open"));
    expect(out.path).toBeNull();
    expect(out.problem).toMatch(/file|dir/);
  });

  it("不认识的动作：接不住并说明是哪个动作", () => {
    const out = resolveFileDeepLink(handoff("delete", { file: "/tmp/a.md" }));
    expect(out.path).toBeNull();
    expect(out.problem).toMatch(/delete/);
  });

  it("from 参数透传出来（用于提示与日志）", () => {
    const out = resolveFileDeepLink(handoff("open", { file: "/tmp/a.md", from: "box" }));
    expect(out.from).toBe("box");
  });

  it("路径前后空格被裁掉（深链解析容易带上）", () => {
    const out = resolveFileDeepLink(handoff("open", { file: "  /tmp/a.md  " }));
    expect(out.path).toBe("/tmp/a.md");
  });

  it("空字符串路径等同于没有路径", () => {
    const out = resolveFileDeepLink(handoff("open", { file: "   " }));
    expect(out.path).toBeNull();
    expect(out.problem).toBeTruthy();
  });
});
