/**
 * 结构性门禁：编辑表单里"程序"字段必须是 AutoComplete，
 * 数据源必须 = programOptions（由 allowedPrograms 派生）。
 *
 * 为什么不做运行时渲染：antd v6 在 happy-dom 下有几个图标 + 全局 ResizeObserver
 * 缺失的副作用，绕一圈装 jsdom 不划算。这里只钉"换控件 + 喂数据"两件事：
 * 渲染行为由浏览器面板实测（auto-complete 选完一项，input.value = path）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const MODAL = readFileSync(`${ROOT}/src/components/QuickActionsModal.tsx`, "utf8");

describe("快速操作编辑表单的程序下拉", () => {
  it("编辑 Modal 里『程序』字段必须是 AutoComplete，不能再是 Input", () => {
    // 抓 <Form.Item label="程序"> ... </Form.Item> 块，再断言里头没 <Input
    const blockMatch = MODAL.match(/<Form\.Item\s+label="程序">[\s\S]*?<\/Form\.Item>/);
    expect(blockMatch, "编辑表单里要能找到「程序」字段").not.toBeNull();
    const block = blockMatch![0];
    expect(block).toMatch(/<AutoComplete\b/);
    expect(block).not.toMatch(/<Input\b/);
  });

  it("AutoComplete 的 options 必须来自 programOptions", () => {
    expect(MODAL).toMatch(/options=\{programOptions\}/);
  });

  it("programOptions 必须由 allowedPrograms 派生（不能写死数组）", () => {
    const decl = MODAL.match(/const programOptions\s*=[\s\S]*?\[allowedPrograms\]/);
    expect(decl, "programOptions 必须 useMemo 派生自 allowedPrograms").not.toBeNull();
  });

  it("useEffect 打开面板时必须拉一次后端白名单", () => {
    expect(MODAL).toMatch(/loadAllowedPrograms\(\)\.then\(setAllowedPrograms\)/);
  });

  it("打开时清空旧缓存，避免拖死", () => {
    // 一旦用户切了 Tauri 通道/版本，缓存是脏的；打开面板时强制重拉
    expect(MODAL).toMatch(/resetAllowedProgramsCache\(\)/);
  });

  it("AutoComplete 必须保留手输能力（backfill），兼容旧 localStorage", () => {
    const block = MODAL.match(/<AutoComplete\b[\s\S]*?\/>/);
    expect(block, "必须能找到 AutoComplete 标签").not.toBeNull();
    expect(block![0]).toMatch(/\bbackfill\b/);
  });
});