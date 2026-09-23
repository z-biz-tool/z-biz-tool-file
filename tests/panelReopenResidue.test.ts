/**
 * 结构性门禁：常驻挂载的面板，换目标或重新打开时必须把上一批的结果清掉。
 *
 * 这些面板都是"App 里一直渲染着、靠 open 显隐"的形态。于是 useState 的初值只在第一次生效，
 * 结果区不清的话就会出现：给 a.jpg 算完哈希关掉，再对 b.png 打开 —— 面板上摆的还是 a.jpg 的摘要，
 * 而且"复制全部计算结果"那颗按钮也在（它只在有结果时渲染）。
 * 实测过一组对照：清结果的 effect 关掉时，重开后的文本里出现"复制全部计算结果"；
 * effect 在时同一动作只剩"文件路径 /data/b.png MD5 计算"。
 *
 * 为什么是静态查：结果区要真渲染才有，node 环境里 vitest 不收 .tsx。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");

function read(p: string): string {
  return readFileSync(`${ROOT}/src/components/${p}`, "utf8");
}

/** 找出所有同时依赖 open 与"目标指纹"的重置 effect */
function resetEffects(src: string): string[] {
  return [...src.matchAll(/useEffect\(\(\) => \{[\s\S]{0,400}?\}, \[[^\]]*\]\)/g)].map((m) => m[0]);
}

describe("面板重开不留上一次的成果", () => {
  it("哈希：open 或目标集合一变就清 rows/result/progress", () => {
    const src = read("HashCalculator.tsx");
    const withOpen = resetEffects(src).filter((e) => /\}, \[[^\]]*\bopen\b[^\]]*\]/.test(e));
    expect(withOpen.length, "找不到跟着 open 走的重置").toBeGreaterThan(0);
    const effect = withOpen.find((e) => /targetKey/.test(e));
    expect(effect, "重置没有把目标变化算进依赖（只跟 open 的话，换文件不清）").toBeTruthy();
    for (const setter of ["setRows([])", 'setResult("")', 'setProgress("")']) {
      expect(effect, `重置少了 ${setter}`).toContain(setter);
    }
    // 目标指纹必须是路径集合本身，不能是长度（长度一样的两个文件也算"换了对象"）
    expect(src).toMatch(/targetKey = targets\.map\(\(t\) => t\.path\)/);
  });

  it("重复文件：开面板时目录/分组/勾选一起重来", () => {
    const src = read("DuplicateFinder.tsx");
    const effect = resetEffects(src).find((e) => /\bopen\b/.test(e));
    expect(effect, "找不到跟着 open 走的重置").toBeTruthy();
    expect(effect).toContain("setDirectory(initialPath || currentPath)");
    expect(effect).toContain("setGroups([])");
    expect(effect).toContain("setSelectedPaths(new Set())");
  });
});
