/**
 * 结构性门禁：快速操作能发的东西，后端必须真的收。
 *
 * 这一族缺陷的原始形态就是"内置项写 program:"chmod"" 而后端白名单只收绝对路径 ——
 * 六个内置动作点了必然被"程序未在白名单内"打回（`953d613` 修的那轮）。
 * 前后端之间没有编译期联系，所以这里跨语言钉住两件事：
 *   1) 内置项走的具名命令必须注册在 invoke_handler 里（否则点了就是 "command not found"）；
 *   2) 源码里出现的 shell 程序路径必须是后端白名单里的（含"新建动作"的默认程序与输入框 placeholder ——
 *      提示语写着一个跑不通的程序，比没提示更坏）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_QUICK_ACTIONS } from "../src/utils/quickActions";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const LIB = readFileSync(`${ROOT}/src-tauri/src/lib.rs`, "utf8");
const COMMANDS = readFileSync(`${ROOT}/src-tauri/src/commands.rs`, "utf8");
const QA_SRC = readFileSync(`${ROOT}/src/utils/quickActions.ts`, "utf8");
const MODAL_SRC = readFileSync(`${ROOT}/src/components/QuickActionsModal.tsx`, "utf8");

function allowedPrograms(): string[] {
  const block = COMMANDS.slice(COMMANDS.indexOf("const ALLOWED_PROGRAMS"));
  return [...block.slice(0, block.indexOf("];")).matchAll(/"((?:\/[^"]+)+)"/g)].map((m) => m[1]);
}

describe("快速操作与后端能力对齐", () => {
  it("扫描本身有效：白名单和注册表都真的读到了", () => {
    const list = allowedPrograms();
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list).toContain("/usr/bin/open");
    expect(LIB.match(/(commands|image_utils|search|indexer)::\w+/g)!.length).toBeGreaterThan(30);
  });

  it("内置项不许再走 shell 程序（一律具名命令或剪贴板）", () => {
    const shellOnes = DEFAULT_QUICK_ACTIONS.filter((a) => !a.command && !a.copyPath);
    expect(shellOnes.map((a) => a.id)).toEqual([]);
  });

  it("内置项用的具名命令必须注册在 invoke_handler 里", () => {
    const used = DEFAULT_QUICK_ACTIONS.map((a) => a.command).filter(Boolean) as string[];
    expect(used.length).toBeGreaterThanOrEqual(3);
    const missing = used.filter((cmd) => !new RegExp(`::${cmd},`).test(LIB));
    expect(missing, "这些命令后端没注册，点了就是报错").toEqual([]);
  });

  it("源码里出现的 shell 程序路径必须在后端白名单内", () => {
    const allowed = new Set(allowedPrograms());
    const src = `${QA_SRC}\n${MODAL_SRC}`;
    // 只查"像绝对路径程序"的字符串（/bin/*、/usr/bin/*），注释里的中文不算
    const mentioned = [...src.matchAll(/"(\/(?:usr\/)?bin\/[\w.]+)"/g)].map((m) => m[1]);
    expect(mentioned.length).toBeGreaterThanOrEqual(1);
    const bad = mentioned.filter((p) => !allowed.has(p));
    expect(bad, `这些程序会被后端拒绝: ${bad.join(", ")}`).toEqual([]);
  });
});
