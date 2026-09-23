/**
 * Esc 关层的判定与"不许漏面板"的漂移检查。
 *
 * App 里那段 Escape handler 原来是手写 if/else，23 个弹窗状态只列了 12 个：
 * 照片馆、回收站、设置、快速操作、归档、PDF、对比、OCR、离线下载、更新、存储分析、
 * SFTP、标签编辑都得靠 antd Modal 自己的键盘行为兜底，非 Modal 的那些（比如后面的新面板）
 * 就会变成"按 Esc 没反应"。现在顺序与状态成表，缺谁由这条门禁判红。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { topmostLayer } from "../src/utils/layerStack";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const APP = readFileSync(`${ROOT}/src/App.tsx`, "utf8");

describe("topmostLayer", () => {
  it("按给定顺序返回第一个开着的层", () => {
    const order = ["rename", "settings", "terminal"] as const;
    expect(topmostLayer(order, { terminal: true, settings: true })).toBe("settings");
    expect(topmostLayer(order, { terminal: true })).toBe("terminal");
    expect(topmostLayer(order, {})).toBeNull();
    // 全 false 也不算开着
    expect(topmostLayer(order, { rename: false, settings: false })).toBeNull();
  });

  it("表里没有的键不许影响结果", () => {
    expect(topmostLayer(["a"], { b: true })).toBeNull();
  });
});

describe("App 的弹窗状态不许漏出 Esc 表", () => {
  /** 形如 const [settingsOpen, setSettingsOpen] = useState(false) / [terminalVisible, ...] */
  const panelStates = [...APP.matchAll(/const \[(\w+(?:Open|Visible)), set\w+\] = useState/g)].map((m) => m[1]);

  it("确实扫到了全站这些面板状态", () => {
    expect(panelStates.length).toBeGreaterThanOrEqual(20);
  });

  it("每一个面板状态都在 openLayers 里有一格", () => {
    // 与本文件另一条存在性守卫同口径：扫不到状态就不许"零缺漏"地绿
    expect(panelStates.length).toBeGreaterThanOrEqual(20);
    const block = APP.slice(APP.indexOf("const openLayers: LayerState = {"));
    const keys = [...block.slice(0, block.indexOf("};")).matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(20);
    // 面板状态名去掉 Open/Visible 后必须就是那一格的键（settingsOpen → settings）
    const missing = panelStates.filter((n) => !keys.includes(n.replace(/(Open|Visible)$/, "")));
    expect(missing, "这些面板没进 Esc 表，按 Esc 会没反应").toEqual([]);
  });

  it("openLayers 里的每一层都要有真正的关闭动作", () => {
    const block = APP.slice(APP.indexOf("const openLayers: LayerState = {"));
    const keys = [...block.slice(0, block.indexOf("};")).matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    const closeBlock = APP.slice(APP.indexOf("const close: Record<string, () => void> = {"));
    const handled = [...closeBlock.slice(0, closeBlock.indexOf("};")).matchAll(/^\s{8}(\w+):/gm)].map((m) => m[1]);
    const orphan = keys.filter((k) => !handled.includes(k));
    expect(orphan, "这些层在表里但没人关它：Esc 会一直空转").toEqual([]);
  });

  it("顺序与状态必须是同一份表，且真的交给 topmostLayer", () => {
    // 两处都是"接线"检查：把 ESC_LAYERS 换成空数组或另起一张表，Esc 就会安静地什么都不关
    expect(APP).toMatch(/const ESC_LAYERS = Object\.keys\(openLayers\);/);
    expect(APP).toMatch(/topmostLayer\(ESC_LAYERS, openLayers\)/);
  });
});
