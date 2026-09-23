/**
 * 结构性门禁：App.tsx 里"建文件名"与"返回上级"两处必须走单一真源。
 *
 * 背景缺陷：
 *   - handleCreate 原先 trim 后直接 invoke create_file/create_directory，
 *     名字含 "/" 被静默当子目录建，错误报"无效路径"那种用户看不懂的话。
 *     修复后必须走 validateFileName.checkFileNameForCreate，违规即时报 issue.message。
 *   - goUp 原先 parts.pop() 手写一套，Windows 盘符根 "C:\\" 会拼出 "C:/"，
 *     看起来像切到了另一个目录。修复后必须走 parentOfPath —— 同一份逻辑
 *     还服务右键"加入图片库"那条入口，单一来源。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const APP = readFileSync(`${ROOT}/src/App.tsx`, "utf8");

describe("建文件名与返回上级：走单一真源", () => {
  it("handleCreate 必须用 checkFileNameForCreate 而不是只 trim", () => {
    // 1) 引入
    expect(APP).toMatch(/import\s*\{[\s\S]*?checkFileNameForCreate[\s\S]*?\}\s*from\s*["']\.\/utils\/validateFileName["']/);
    // 2) 函数体里出现 checkFileNameForCreate(createName) 并按 ok 走分支
    const block = APP.match(/const handleCreate\s*=[\s\S]*?setCreateModal\(\{ visible: false/);
    expect(block, "找不到 handleCreate 函数体").not.toBeNull();
    expect(block![0]).toMatch(/const check\s*=\s*checkFileNameForCreate\(createName\)/);
    expect(block![0]).toMatch(/if\s*\(!check\.ok\)\s*\{/);
    expect(block![0]).toMatch(/check\.issue\.message/);
  });

  it("新建弹窗的输入框必须实时清洗（吞 / 与 \\）并显示错误状态", () => {
    const modal = APP.match(/\{?\/\* 新建文件\/文件夹弹窗 \*\/\}[\s\S]*?<\/ModalWrap>/);
    expect(modal, "找不到新建文件/文件夹弹窗").not.toBeNull();
    expect(modal![0]).toMatch(/sanitizeFileNameInput\(e\.target\.value\)/);
    expect(modal![0]).toMatch(/status=\{createName\s*&&\s*!checkFileNameForCreate/);
    expect(modal![0]).toMatch(/okButtonProps=\{\{\s*disabled:\s*!checkFileNameForCreate/);
  });

  it("goUp 必须用 parentOfPath，禁止再写 parts.pop()", () => {
    // useCallback 的 deps 数组里有 [], 跟函数体冲突 —— 用 indexOf 截范围：
    // 从 `const goUp =` 起截到行尾第一个 "}, ["（close brace + deps）。
    const start = APP.indexOf("const goUp =");
    expect(start, "找不到 const goUp").toBeGreaterThan(-1);
    const tail = APP.slice(start);
    const end = tail.indexOf("}, [");
    expect(end, "找不到 useCallback 收尾").toBeGreaterThan(-1);
    const block = tail.slice(0, end);
    expect(block).toMatch(/parentOfPath\(currentPath\)/);
    expect(block).not.toMatch(/parts\.pop\(\)/);
  });

  it("goUp 不能再去'/'当终点（已是根时该 noop）", () => {
    const start = APP.indexOf("const goUp =");
    const tail = APP.slice(start);
    const end = tail.indexOf("}, [");
    const block = tail.slice(0, end);
    expect(block).toMatch(/if\s*\(!parent\s*\|\|\s*parent\s*===\s*currentPath\)\s*return/);
  });
});