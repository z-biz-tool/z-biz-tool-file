/**
 * 结构性门禁：diff 能力的三条线不许在接线处断掉。
 *
 * 这三条都是"看起来做了、其实没通"的活：
 * 1. 目录 diff 点条目要能下钻到文件级 diff —— 断在这里的表现是"点了没反应"；
 * 2. diff 结果要能应用到另一侧 —— 断在这里的表现是"只能看不能改"；
 * 3. 双栏对比要真的是并排 diff —— 断在这里的表现是两个浏览器并排放着，
 *    看起来像双栏，其实一行都没对齐。
 *
 * 为什么走静态检查：这些都是组件里的接线，node 环境里 vitest 收不到 .tsx，
 * 真渲染要 jsdom（这个仓库的 vitest 是 node 环境）。静态扫能钉住"调用还在不在"，
 * 后端的行为另有 Rust 单测兜着。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");

const read = (p: string) => readFileSync(`${ROOT}/src/${p}`, "utf8");

const DIFF_VIEWER = read("components/DiffViewer.tsx");
const DUAL_PANEL = read("components/DualPanelView.tsx");
const SIDE_BY_SIDE = read("components/SideBySideDiff.tsx");
const SIDE_BY_SIDE_UTIL = read("utils/diffSideBySide.ts");

describe("目录 diff 点条目要能下钻", () => {
  it("前端拿的是带左右绝对路径的条目结构", () => {
    // 后端 DirDiffEntry 的形状：相对路径 + 左右绝对路径 + 状态
    expect(DIFF_VIEWER).toMatch(/left_path:\s*string \| null/);
    expect(DIFF_VIEWER).toMatch(/right_path:\s*string \| null/);
    expect(DIFF_VIEWER).toMatch(/rel_path:\s*string/);
  });

  it("目录 diff 的结果类型是条目数组，不是字符串数组", () => {
    // 字符串数组是旧结构：只有文件名，前端没法还原绝对路径，也就点不进去
    expect(DIFF_VIEWER).not.toMatch(/added_files:\s*string\[\]/);
    expect(DIFF_VIEWER).not.toMatch(/removed_files:\s*string\[\]/);
    expect(DIFF_VIEWER).not.toMatch(/modified_files:\s*string\[\]/);
  });

  it("点条目会设置左右文件、切到文件对比页并真的调 diff_files", () => {
    const drill = DIFF_VIEWER.slice(DIFF_VIEWER.indexOf("drillIntoFile"));
    expect(drill).toMatch(/setLeftFile\(entry\.left_path\)/);
    expect(drill).toMatch(/setRightFile\(entry\.right_path\)/);
    expect(drill).toMatch(/setTab\("file"\)/);
    expect(drill).toMatch(/runFileDiff\(entry\.left_path, entry\.right_path\)/);
  });

  it("文件名的点击事件真的挂在渲染上", () => {
    expect(DIFF_VIEWER).toMatch(/onClick=\{\(\) => drillIntoFile\(row\)\}/);
  });

  it("后端命令名没写错", () => {
    expect(DIFF_VIEWER).toMatch(/invoke<DirDiffSummary>\("quick_diff_dirs"/);
    expect(DIFF_VIEWER).toMatch(/invoke<DiffResult>\("diff_files"/);
  });
});

describe("diff 结果要能应用到另一侧", () => {
  it("后端命令名是 apply_diff_side，mode 与后端 serde 一致", () => {
    expect(DIFF_VIEWER).toMatch(/invoke\("apply_diff_side"/);
    expect(DIFF_VIEWER).toMatch(/mode:\s*desc\.mode/);
  });

  it("三个动作都在：用左覆盖右 / 用右覆盖左 / 互换", () => {
    expect(DIFF_VIEWER).toMatch(/applySide\("left_to_right"\)/);
    expect(DIFF_VIEWER).toMatch(/applySide\("right_to_left"\)/);
    expect(DIFF_VIEWER).toMatch(/applySide\("swap"\)/);
  });

  it("写操作之前必须过一道 danger 确认框", () => {
    for (const src of [DIFF_VIEWER, DUAL_PANEL]) {
      const at = src.indexOf('"apply_diff_side"');
      expect(at, "找不到 apply_diff_side 调用").toBeGreaterThan(-1);
      const before = src.slice(0, at);
      const gate = before.lastIndexOf("modal.confirm(");
      expect(gate, "确认框被删了").toBeGreaterThan(-1);
      expect(before.slice(gate)).toMatch(/okType: "danger"/);
    }
  });

  it("确认框走 App context 的 modal，不是静态 Modal.confirm", () => {
    for (const src of [DIFF_VIEWER, DUAL_PANEL]) {
      expect(src).toMatch(/const \{ message, modal \} = AntdApp\.useApp\(\);/);
      expect(src).not.toMatch(/Modal\.confirm\(/);
      expect(src).not.toMatch(/window\.confirm\(/);
    }
  });

  it("确认文案里必须带目标路径", () => {
    // 只写"确定要覆盖吗"等于没确认
    expect(DIFF_VIEWER).toMatch(/applyConfirmText\(desc\)/);
    expect(DUAL_PANEL).toMatch(/applyConfirmText\(desc\)/);
  });
});

describe("双栏对比要真的是并排 diff", () => {
  it("双面板里有并排 diff 组件，而不是两个浏览器就完事", () => {
    expect(DUAL_PANEL).toMatch(/import SideBySideDiff from "\.\/SideBySideDiff"/);
    expect(DUAL_PANEL).toMatch(/<SideBySideDiff/);
  });

  it("并排视图走的是后端 diff_files 的 lines，并做行号对齐", () => {
    expect(DUAL_PANEL).toMatch(/invoke<DiffResult>\("diff_files"/);
    expect(SIDE_BY_SIDE).toMatch(/buildSideBySide\(lines\)/);
    // 两侧行号都要渲染出来 —— 没有行号的对齐只是"看着像"
    expect(SIDE_BY_SIDE).toMatch(/cell\?\.lineNo/);
  });

  it("并排视图按变更块把删除与新增两两对应上", () => {
    // 配对逻辑住在 util 里（组件只负责渲染），所以这条断言看 util 那一层
    expect(SIDE_BY_SIDE_UTIL).toMatch(/pairChangeBlock/);
    expect(SIDE_BY_SIDE_UTIL).toMatch(/buildSideBySide/);
  });

  it("双栏对比也有把一侧应用到另一侧的入口", () => {
    expect(DUAL_PANEL).toMatch(/applySide\("left_to_right"\)/);
    expect(DUAL_PANEL).toMatch(/applySide\("right_to_left"\)/);
    expect(DUAL_PANEL).toMatch(/applySide\("swap"\)/);
  });

  it("对比模式下点文件只选中，不该顺手打开系统程序", () => {
    // selectOnly 时只 setState，不走 onFileOpen
    expect(DUAL_PANEL).toMatch(/selectOnly=\{mode === "compare"\}/);
    expect(DUAL_PANEL).toMatch(/else if \(!selectOnly\)/);
  });
});
