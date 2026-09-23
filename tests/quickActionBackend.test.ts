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

/**
 * 解析 `list_allowed_programs` 内部的 `META` 表 [(path, description), ...]。
 *
 * 真实前端不会读这个 —— 走 invoke。但门禁要保证"后端告诉前端能用什么" =
 * "后端真能执行什么"，两张表都得挂在同一份源码上才会同步漂移。
 */
function allowedProgramsMeta(): { path: string; description: string }[] {
  const idx = COMMANDS.indexOf("const META:");
  if (idx < 0) return [];
  const block = COMMANDS.slice(idx);
  const end = block.indexOf("];");
  if (end < 0) return [];
  const inner = block.slice(0, end);
  const matches = [...inner.matchAll(/\("(\/[^"]+)",\s*"([^"]+)"\)/g)];
  return matches.map((m) => ({ path: m[1], description: m[2] }));
}

describe("快速操作与后端能力对齐", () => {
  it("扫描本身有效：白名单和注册表都真的读到了", () => {
    const list = allowedPrograms();
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list).toContain("/usr/bin/open");
    expect(LIB.match(/(commands|image_utils|search|indexer)::\w+/g)!.length).toBeGreaterThan(30);
  });

  it("内置项不许再走 shell 程序（一一律具名命令或剪贴板）", () => {
    const shellOnes = DEFAULT_QUICK_ACTIONS.filter((a) => !a.command && !a.copyPath);
    expect(shellOnes.map((a) => a.id)).toEqual([]);
  });

  it("内置项用的具名命令必须注册在 invoke_handler 里", () => {
    const used = DEFAULT_QUICK_ACTIONS.map((a) => a.command).filter(Boolean) as string[];
    expect(used.length).toBeGreaterThanOrEqual(3);
    const missing = used.filter((cmd) => !new RegExp(`::${cmd},`).test(LIB));
    expect(missing, "这些命令后端没注册，点了就是报错").toEqual([]);
  });

  it("list_allowed_programs 必须注册到 invoke_handler", () => {
    expect(LIB).toMatch(/commands::list_allowed_programs,/);
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

  it("后端 META 表的每条程序必须：(a) 在白名单内 (b) 描述非空 (c) 前端 FALLBACK 里也有", () => {
    const meta = allowedProgramsMeta();
    expect(meta.length, "META 表里至少要有一项").toBeGreaterThan(0);
    const allowed = new Set(allowedPrograms());
    const qaSrc = QA_SRC;
    const missingInAllow = meta.filter((m) => !allowed.has(m.path));
    expect(missingInAllow, "META 里写了但白名单没收的程序会被后端拒").toEqual([]);
    const emptyDesc = meta.filter((m) => !m.description.trim());
    expect(emptyDesc.map((m) => m.path), "描述不能空 —— AutoComplete 选完用户不知道是干嘛的").toEqual([]);
    // 前端 FALLBACK 兜底必须涵盖后端 META；否则非 Tauri 环境下用户看到的下拉跟
    // 实际能跑的对不上，点了又是 "程序未在白名单内"。
    const fbMatches = [...qaSrc.matchAll(/path:\s*"(\/[^"]+)"/g)].map((m) => m[1]);
    expect(fbMatches.length, "前端 FALLBACK 不能为空").toBeGreaterThan(0);
    const missingInFb = meta.map((m) => m.path).filter((p) => !fbMatches.includes(p));
    expect(missingInFb, "FALLBACK 没列出来的程序，invoke 失败时用户就看不见").toEqual([]);
  });

  it("前端 META 描述不能是空壳或自打脸", () => {
    // 只扫 FALLBACK_ALLOWED_PROGRAMS 里 description: "..." 字面量，注释里的
    // "shell 形式" 不能误伤。
    const descs = [...QA_SRC.matchAll(/description:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(descs.length, "至少要有一条描述").toBeGreaterThan(0);
    const banned = ["任意命令", "任意代码", "未限制"];
    const hits = descs.filter((d) => banned.some((w) => d.includes(w)));
    expect(hits, "FALLBACK 描述禁止自打脸").toEqual([]);
    // description 不能等于 path —— 那就是没填描述
    const fbPairs = [...QA_SRC.matchAll(/path:\s*"(\/[^"]+)",\s*description:\s*"([^"]+)"/g)].map((m) => ({
      path: m[1],
      description: m[2],
    }));
    expect(fbPairs.filter((p) => p.path === p.description).map((p) => p.path), "描述不能直接复述路径").toEqual([]);
  });
});
