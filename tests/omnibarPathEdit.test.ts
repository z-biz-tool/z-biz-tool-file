/**
 * 结构性门禁：Omnibar 路径编辑必须走"草稿-提交"两段式，并提供复制/Reveal 两颗捷径按钮。
 *
 * 背景缺陷：
 *   1) Input.onChange 直接调 handlePathSubmit —— 敲一个字就提交一次，最后
 *      落到完全打错的路径。这是 UX 上最坏的"按错键跳到鬼地方"。
 *   2) "我现在站在哪里"的两个最常用操作（复制路径 / 在 Finder 里打开）原来
 *      只能通过选中一个文件 + 右键菜单才能用。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const OMNI = readFileSync(`${ROOT}/src/_shared/Omnibar.tsx`, "utf8");

describe("Omnibar 路径编辑的提交时机", () => {
  it("必须有 pathDraft 草稿状态，Input 的 onChange 不能直接调用 onNavigate", () => {
    expect(OMNI).toMatch(/const\s+\[pathDraft,\s*setPathDraft\]\s*=\s*useState\(currentPath\)/);
    // Input 的 value 必须绑草稿，不能绑 currentPath（绑 currentPath 会出现
    // "onNavigate 改了 currentPath → Input.value 被覆盖 → 用户敲字被吃掉"）
    expect(OMNI).toMatch(/value=\{pathDraft\}/);
    // onChange 只更新草稿，不调用 onNavigate
    const onChange = OMNI.match(/onChange=\{\(e\) => setPathDraft\(e\.target\.value\)\}/);
    expect(onChange, "Input.onChange 应当只更新 pathDraft").not.toBeNull();
    // onChange 里不能再调 onNavigate / handlePathSubmit
    const bad = OMNI.match(/onChange=\{\(e\) => handlePathSubmit\(/);
    expect(bad, "onChange 不许直接提交").toBeNull();
  });

  it("提交入口只剩 onPressEnter 与 onBlur，两者都基于 pathDraft", () => {
    expect(OMNI).toMatch(/onPressEnter=\{\(\) => handlePathSubmit\(pathDraft\)\}/);
    expect(OMNI).toMatch(/onBlur=\{\(\) => handlePathSubmit\(pathDraft\)\}/);
  });

  it("currentPath 变化（导航到别处）后草稿要同步，否则下次编辑显示旧路径", () => {
    expect(OMNI).toMatch(/useEffect\(\(\) =>\s*\{\s*setPathDraft\(currentPath\)/);
  });

  it("handlePathSubmit 必须 trim，空串时拒绝提交", () => {
    const fn = OMNI.match(/const handlePathSubmit\s*=[\s\S]*?setPathEditing\(false\);?\s*\}/);
    expect(fn, "找不到 handlePathSubmit").not.toBeNull();
    expect(fn![0]).toMatch(/value\.trim\(\)/);
    expect(fn![0]).toMatch(/if\s*\(trimmed\)\s*\{/);
  });
});

describe("Omnibar 路径栏的两颗捷径按钮", () => {
  it("必须出现「复制当前路径」按钮", () => {
    expect(OMNI).toMatch(/aria-label="复制当前路径"/);
    expect(OMNI).toMatch(/handleCopyCurrentPath/);
    expect(OMNI).toMatch(/navigator\.clipboard\.writeText\(currentPath\)/);
  });

  it("必须出现「在 Finder 中显示当前目录」按钮", () => {
    expect(OMNI).toMatch(/aria-label="在 Finder 中显示当前目录"/);
    expect(OMNI).toMatch(/handleRevealCurrent/);
    expect(OMNI).toMatch(/reveal_in_finder/);
  });

  it("两条捷径的消息必须走 App context（不能用全局 message.error）", () => {
    const fn1 = OMNI.match(/const handleCopyCurrentPath\s*=[\s\S]*?\}\s*catch[\s\S]*?\}\s*;/);
    expect(fn1, "找不到 handleCopyCurrentPath").not.toBeNull();
    expect(fn1![0]).toMatch(/message\.success\("已复制当前路径"\)/);
    const fn2 = OMNI.match(/const handleRevealCurrent\s*=[\s\S]*?\}\s*;/);
    expect(fn2, "找不到 handleRevealCurrent").not.toBeNull();
    expect(fn2![0]).toMatch(/message\.error\("打开 Finder 失败/);
  });
});