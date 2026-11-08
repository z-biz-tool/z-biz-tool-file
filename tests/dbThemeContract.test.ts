/**
 * 结构性门禁：数据库板块的视觉口径必须跟 file 主壳一致。
 *
 * db 是 2026-11-06 从 z-biz-tool-db 整仓搬进来的，独立 app 时期自带一套
 * #667eea→#764ba2 紫渐变、8/12/16 手写圆角、硬编码语义色，以及一个自己的
 * 深色模式 Switch。搬入后主壳已经统一走 ThemeProvider 的 token
 * （colorPrimary #1677ff / borderRadius 6 / 语义色 / CSS 变量），
 * db 没跟上，于是同一窗口里出现两种主色、三种圆角、两个主题开关。
 *
 * 唯一允许写死颜色的是 report/ChartCard.tsx 的 CHART_COLORS：
 * 图表系列色本来就要多色区分，且 recharts 只吃具体色值，不吃 CSS 变量。
 * 那条数组统一取 antd 预设色板，首色与全站主色一致。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const DB = `${ROOT}/src/apps/db`;
const PALETTE = `${DB}/report/ChartCard.tsx`;

const BANNED: { re: RegExp; why: string }[] = [
  { re: /#667eea|#764ba2|102,\s*126,\s*234|118,\s*75,\s*162/i, why: "独立 app 时期的紫色品牌色" },
  { re: /linear-gradient\(/, why: "板块自带的渐变底色/渐变文字" },
  { re: /borderRadius:\s*["']?(?:8|10|12|14|16|18|20|24)\b/, why: "手写圆角（全站 token 是 6）" },
  {
    re: /["']#(?:1890ff|ff4d4f|faad14|52c41a|f0f0f0|fff|000)["']/i,
    why: "硬编码语义色（应走 var(--ant-color-*)）",
  },
  { re: /rgba?\(\s*0,\s*0,\s*0/, why: "只在亮色下成立的黑色半透明" },
  { re: /checkedChildren="🌙"|unCheckedChildren="☀️"|onChange=\{toggleTheme\}/, why: "板块内的第二个主题开关" },
  { re: /<ConfigProvider/, why: "板块自带的第二套 ConfigProvider" },
];

/** 注释行里提到历史色值是为了说明「为什么不能再写」，不算违规 */
function isComment(line: string) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** CHART_COLORS 的数组元素行：允许写死 antd 预设色板的色值 */
function isPaletteRow(line: string) {
  return /^\s*"#[0-9a-fA-F]{6}",?\s*$/.test(line);
}

function files(): string[] {
  return readdirSync(DB, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && /\.(tsx|ts)$/.test(d.name))
    .map((d) => `${d.parentPath}/${d.name}`);
}

function hits(): string[] {
  const out: string[] = [];
  for (const file of files()) {
    const rel = file.slice(ROOT.length).replace(/^\/+/, "");
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (isComment(line)) return;
        if (file === PALETTE && isPaletteRow(line)) return;
        for (const { re, why } of BANNED) {
          if (re.test(line)) out.push(`${rel}:${i + 1} ${why} → ${line.trim().slice(0, 90)}`);
        }
      });
  }
  return out;
}

describe("数据库板块视觉契约", () => {
  it("扫描本身有效：规则能抓住旧写法、放过注释与图表调色板", () => {
    expect(BANNED.some(({ re }) => re.test('const g = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";'))).toBe(true);
    expect(BANNED.some(({ re }) => re.test("borderRadius: 12,"))).toBe(true);
    expect(BANNED.some(({ re }) => re.test('style={{ color: "#1890ff" }}'))).toBe(true);
    expect(isComment("  // 原来那套 #667eea→#764ba2 紫渐变")).toBe(true);
    expect(isPaletteRow('  "#1677ff",')).toBe(true);
  });

  it("db 目录里没有旧品牌色、手写圆角或第二个主题开关", () => {
    expect(hits()).toEqual([]);
  });

  it(
    "db/index.css 是独立 app 的全局样式，不许被主壳引入",
    { timeout: 30_000 },
    () => {
    // 它含 `* { margin:0 }`、`body`、`#root` 与固定亮色滚动条，
    // 一旦 import 会直接污染整个 file 窗口（其它板块也会被重置）。
    // 只看 db 目录内的相对引用 + 两个入口文件的绝对引用，不必扫全站 4 万行。
    const entries = [`${ROOT}/src/main.tsx`, `${ROOT}/src/App.tsx`].filter((f) => {
      try { readFileSync(f); return true; } catch { return false; }
    });
    const importing = [...files(), ...entries].filter((f) => {
      const text = readFileSync(f, "utf8");
      // 主壳自己的 src/index.css 是正常的，只挡「指向 db 目录那一份」的引用
      return /apps\/db\/index\.css/.test(text)
        || (f.startsWith(DB) && /["']\.\/index\.css["']/.test(text));
    });
    expect(importing.map((f) => f.slice(ROOT.length))).toEqual([]);
    },
  );
});
