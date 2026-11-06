/**
 * 结构性门禁：不许再写"只在亮色下成立"的颜色字面量。
 *
 * 深色主题是这个 app 的默认态（实测弹窗底色 rgb(31,31,31)），而回收站那条信息栏写死了
 * background:"#fafafa" + color:"#666" —— 深色弹窗里嵌一条亮白横条、上面是深灰文字，
 * 和之前修的"静态 message 弹白底提示条"是同一类分裂。这轮把 16 个文件里 31 处
 * 无条件亮色字面量换成主题变量（var(--ant-color-text-secondary) 等，与全站已有写法一致）。
 *
 * 允许两种写法：走 token（theme.useToken()）或走 CSS 变量；
 * 已经按 isDark 分支的地方（阅读器/预览器那些"深色编辑区/亮色纸面"的选择）不算违规；
 * ImageEditor 单独豁免 —— 它整个工作台是刻意固定的浅色调色板底，改成主题变量会让
 * 画布中性感消失，那是设计决定而不是漏改（要动它得连设计一起重看）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");

const BANNED = [
  /color:\s*"#(?:888|999|777|666|555|444)"/,
  /background:\s*"#(?:fafafa|f5f5f5|f0f0f0)"/,
  /1px solid #(?:e8e8e8|f0f0f0|eee)\b/,
  /linear-gradient\([^)]*#(?:ffffff|fff\b|f8fafd)/,
];
const THEMED = /isDark|===\s*"dark"|themeDark|token\./;
const ALLOW_FILES = new Set<string>([]);

function hits(): string[] {
  const out: string[] = [];
  const files = readdirSync(`${ROOT}/src`, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && /\.(tsx|ts)$/.test(d.name))
    .map((d) => `${d.parentPath}/${d.name}`)
    // 终端板块（src/apps/terminal）是 2026-11-04 从 z-biz-tool-terminal 仓搬入的
    // 冻结模块，它自带一套深色终端配色，个别字面量还没换成主题变量。
    // 搬入期先豁免，等这轮重构收尾再逐处对齐。
    .filter((p) => !p.includes("/apps/terminal/"));
  for (const file of files) {
    // ROOT 没有结尾斜杠，slice 出来会带一个前导 "/" —— 不剥掉的话豁免清单永远对不上
    const rel = file.slice(ROOT.length).replace(/^\/+/, "");
    if (ALLOW_FILES.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // 先判 BANNED 再查上下文：绝大多数行压根不是亮色字面量，
      // 而"往前看两行"的窗口拼接每行都要新分配一个数组 + 一次 join。
      // 全站近 4 万行 × 46 个 worker 并发时，那点分配足以把这条用例拖到超时。
      // 判定等价：最终入列的条件是「命中 BANNED 且本行不是 var(--ant-) 且窗口里没有主题分支」，
      // 调换顺序不影响结果。
      if (!BANNED.some((re) => re.test(line))) return;
      if (line.includes("var(--ant-")) return;
      // 三元分支常常写成 background: mode === "dark" ? … / … "#ffffff" 两行，
      // 只看当前行会把"已经分主题"的那半误判成违规 —— 往前看两行
      const window = lines.slice(Math.max(0, i - 2), i + 1).join(" ");
      if (THEMED.test(window)) return;
      out.push(`${rel}:${i + 1}`);
    });
  }
  return out;
}

describe("亮色字面量", () => {
  it("扫描本身有效：判定规则能抓住样例题、又放过按 isDark 分支的写法", () => {
    // 判定式失配的话"零违规"是假的，所以先自证规则在干活
    expect(BANNED.some((re) => re.test('background: "#fafafa"'))).toBe(true);
    expect(BANNED.some((re) => re.test('color: "#888"'))).toBe(true);
    expect(BANNED.some((re) => re.test("background: 'linear-gradient(135deg, #ffffff 0%, #f8fafd 100%)'"))).toBe(true);
    expect(THEMED.test('const bg = isDark ? "#1a1a1a" : "#ffffff";')).toBe(true);
    expect(THEMED.test("  color: token.colorTextSecondary,")).toBe(true);
  });

  it(
    "全站没有无条件的亮色字面量",
    // 这条要扫全站近 4 万行源码（数据库板块并入后又涨了三分之一），
    // 单独跑实测约 0.9s；但 46 个 worker 并发时调度会抢 CPU，
    // 默认的 5s 超时是踩在边界上随机翻车的 —— 2026-11-06 那轮全量跑
    // 就因为它红了两次（单独跑必过）。给个宽裕的上限，别让门禁变成随机噪音。
    { timeout: 30_000 },
    () => {
      expect(hits()).toEqual([]);
    },
  );

  it("豁免清单保持为空（历史豁免都要还掉）", () => {
    // ImageEditor 那圈曾经是唯一的豁免：右侧面板从 #fafafa/#fff/#666 改成跟主题之后归还，
    // 深色下再不会左边深色画布、右边亮白控制台
    expect([...ALLOW_FILES]).toEqual([]);
  });
});
