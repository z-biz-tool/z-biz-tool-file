/**
 * 结构性门禁：只有图标、没有文字的按钮必须有可及名称。
 *
 * Tooltip 的标题只是视觉提示，屏幕阅读器念不出按钮；键盘/读屏用户碰到
 * 「一个放大镜图标 + 没名字」就只能点了看。全站扫下来有 44 处这样（PdfViewer 的
 * 放大/缩小/旋转/打印、VideoPlayer 的播放/截帧/全屏、LibraryView 的收藏心形、
 * ImageEditor 的撤销/重做/裁剪应用……），这轮全部补上并把规则钉住。
 *
 * 判定要点（都是踩过的坑）：
 * - 必须区分自闭合 `<Button …/>`（图标唯一）与 `<Button …>文字</Button>`（名字在 children 里）；
 * - 注释与字符串先剥掉，否则文档里写的「用 <Button icon=…> 举例」会被当成违规；
 * - `aria-label={变量}`、条件式、模板串都算有名 —— 名字在调用处给，不在这一行写死。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");

function stripComments(s: string): string {
  const out = s.split("");
  let i = 0;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < s.length) {
    const two = s.slice(i, i + 2);
    if (two === "//") {
      let j = s.indexOf("\n", i);
      if (j === -1) j = s.length;
      blank(i, j);
      i = j;
      continue;
    }
    if (two === "/*") {
      const e = s.indexOf("*/", i + 2);
      const j = e === -1 ? s.length : e + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (s[i] === '"' || s[i] === "'" || s[i] === "`") {
      const q = s[i];
      let j = i + 1;
      while (j < s.length && s[j] !== q) j += s[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** 开区间标签的结束 '>'（花括号深度 0 上）；同时给出是否自闭合 */
function tagEnd(src: string, i: number): [number, boolean] {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === ">" && depth === 0) return [i, src[i - 1] === "/"];
    i += 1;
  }
  return [src.length, true];
}

/** children 去掉嵌套标签后是否还有可见文字 */
function textChild(src: string, close: number): boolean {
  const end = src.indexOf("</Button>", close);
  if (end === -1) return false;
  let inner = src.slice(close + 1, end).replace(/<[^>]*>/g, " ");
  // {cond ? "预览" : "源码"} 这种表达式里显示的就是文字，算有名字；
  // 但 {activeDots.map(...)} 这种纯代码不算 —— 先取出字符串字面量再挖掉表达式
  if (/["'`][^"'`]+["'`]/.test(inner)) return true;
  // {a.name} 这种"就是一个表达式"渲染出来的也是文字
  if (/\{\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}/.test(inner)) return true;
  for (;;) {
    const before = inner;
    inner = inner.replace(/\{[^{}]*\}/g, " ");
    if (inner === before) break;
  }
  return /[一-鿿]|\p{L}{2,}|\d/.test(inner);
}

/** 图标唯一（没有可见文字）的按钮总数与被判违规的清单 */
function scanTsxs(dir = "src"): { total: number; bad: string[] } {
  const bad: string[] = [];
  let total = 0;
  const files = readdirSync(`${ROOT}/${dir}`, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && d.name.endsWith(".tsx"))
    .map((d) => `${d.parentPath}/${d.name}`);
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/<(?:Button|button)\b/g)) {
      const start = m.index ?? 0;
      const tag = m[0];
      const [close, selfClosed] = tagEnd(src, start + tag.length);
      const attrs = src.slice(start + tag.length, close);
      // 原生 <button> 没有 icon 属性，图标就是它唯一的 children；
      // antd 的 <Button icon=…> 两种写法都可能出现，所以"没有可见文字"才是唯一判据
      if (!/\bicon=/.test(attrs) && !/<[A-Z][\w.]*\s*\/?><\/button>|<[A-Z][\w.]*\s*\/>/.test(src.slice(close + 1, src.indexOf("</button>", close) === -1 ? close + 40 : src.indexOf("</button>", close)))) {
        if (!/\bicon=/.test(attrs)) continue;
      }
      if (!selfClosed && textChild(src, close)) continue;
      total += 1;
      // aria-label="" 或只写空白等于没有名字；有值（字面量、条件式、变量）都算有名
      const empty = /\baria-label=\{?\s*(""|''|\{""\}|\{''\})/.test(attrs);
      if (!/\baria-label=/.test(attrs) || empty) {
        bad.push(`${file.slice(ROOT.length)}:${src.slice(0, start).split("\n").length}`);
      }
    }
  }
  return { total, bad };
}

/** 全站"只有图标"的按钮数（补完可及名称那轮量出来的）；改这个数要连理由一起说 */
const TOTAL_ICON_ONLY = 84;

describe("图标按钮的可及名称", () => {
  it("确实扫到了全站绝大多数 tsx 与足够多的图标按钮", () => {
    const files = readdirSync(`${ROOT}/src`, { withFileTypes: true, recursive: true })
      .filter((d) => d.isFile() && d.name.endsWith(".tsx")).length;
    expect(files).toBeGreaterThanOrEqual(40);
    const src = stripComments(readFileSync(`${ROOT}/src/components/PdfViewer.tsx`, "utf8"));
    expect(src.match(/<Button\b/g)?.length).toBeGreaterThanOrEqual(5);
    const { total, bad } = scanTsxs();
    // 存在性守卫：图标按钮整体要被扫到（正则失配、少扫一个文件都会让"零违规"变成假绿）
    // 钉住实际扫到的数量：漏扫任何一个文件（正则失配、路径写错、filter 加错）都会让它掉下来
    expect(total, "扫到的图标按钮数变了：要么扫描失配，要么新增/删除了图标按钮（后者要连阈值一起改）").toBe(TOTAL_ICON_ONLY);
    expect(bad).toEqual([]);
  });

  it("每一个只有图标的按钮都带 aria-label", () => {
    expect(scanTsxs().bad).toEqual([]);
  });

  it("解析：自闭合才算图标唯一，children 有文字或 aria-label={变量} 都算有名", () => {
    const cases = [
      // [源码, 期望违规]
      [`<Button size="small" icon={<ZoomInOutlined />} onClick={zoomIn} />`, true],
      [`<Button size="small" icon={<X />} aria-label="放大" onClick={zoomIn} />`, false],
      [`<Button icon={icon} aria-label={tooltip} />`, false],
      [`<Button icon={<PlusOutlined />} onClick={onNew}>新建</Button>`, false],
      [`<Button icon={<PlusOutlined />} onClick={onNew}>{"新建"}</Button>`, false],
      // 注释里举例不该算违规（这条是真实踩过的：文档注释里写 JSX 例子）
      [`// <Button icon={<X />} /> 这样是不行的\nconst a = 1;`, false],
      // 有 children 但都是嵌套标签、没有文字 → 仍然是图标唯一，要名字
      [`<Button icon={<X />}><span /></Button>`, true],
    ] as const;
    for (const [code, expectBad] of cases) {
      const src = stripComments(code);
      const m = /<Button\b/g.exec(src);
      if (!m) {
        expect(expectBad, code).toBe(false);
        continue;
      }
      const [close, selfClosed] = tagEnd(src, (m.index ?? 0) + "<Button".length);
      const attrs = src.slice((m.index ?? 0) + "<Button".length, close);
      const isIconOnly = /\bicon=/.test(attrs);
      const bad = isIconOnly && (selfClosed || !textChild(src, close)) && !/\baria-label=/.test(attrs);
      expect(bad, code).toBe(expectBad);
    }
  });
});
