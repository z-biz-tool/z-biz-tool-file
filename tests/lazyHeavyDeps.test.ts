/**
 * 结构性门禁：重依赖不许被静态 import 进首屏。
 *
 * ## 为什么有这条门禁
 *
 * 2026-11-06 那轮性能排查实测到：应用启动时 WebContent 进程要烧掉 6.6 秒 CPU
 * （`sample` 抓到的热点是 JSC 的 DFG 编译 `ByteCodeParser` / `B3 优化` +
 * 首屏布局绘制 `RenderBlock::layout` / `paint`）。根因是主 bundle 一度 1.7MB，
 * 里面 antd 独占 1445KB、icons 367KB、rc-component 约 800KB ——
 * 而首屏真正要用的只是 Layout/Button/Input 那一小撮。
 *
 * 下载+解析+JIT 编译那一大坨首屏用不到的代码，就是风扇呼呼响的来源。
 *
 * ## 规则
 *
 * 三个只在**特定板块/弹窗**里才需要的重依赖，必须走 `import()` 动态加载：
 *
 * - `@codemirror/*` —— SQL 编辑器，只有切到数据库板块才需要（378KB）
 * - `recharts` —— 图表，只有报表看板真的画图时才需要（414KB）
 * - `@xterm/xterm` —— 终端模拟器，只有切到终端板块才需要（394KB）
 *
 * 两条：
 * 1. **不许出现在首屏可达的文件里** —— 首屏一定会下载它；
 * 2. **装着它的文件只许被 lazy 引用** —— 否则切到那个板块时会同步下载一大坨。
 *
 * ## 路径模型
 *
 * 全部用「相对 src/ 的路径」（如 `apps/db/DbApp.tsx`）作键。
 * 早期版本混用过「带 src/ 前缀」和「不带」两套键，导致匹配静默落空 ——
 * 规则看着绿，其实一次都没真匹配上。这类假绿比没有门禁更危险，
 * 所以这里每条规则都配了反例自证。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const SRC = `${ROOT}/src`;

/** 只在特定板块才需要的重依赖 */
const HEAVY_DEPS = [
  { pkg: "@codemirror", hint: "SQL 编辑器（切到数据库板块才需要）" },
  { pkg: "recharts", hint: "图表（报表看板画图时才需要）" },
  { pkg: "@xterm/xterm", hint: "终端模拟器（切到终端板块才需要）" },
];

/**
 * 去掉**注释**内容（长度不变，用空格占位），避免文档里的包名被当成违规。
 *
 * 只剥注释、**不剥字符串** —— 包名本身就住在 import 语句的字符串里
 * （`from "@xterm/xterm"`），把字符串抹了这条规则就永远抓不到东西，
 * "零违规"会变成假绿。（这正是本门禁第一版踩的坑：反例自证用例直接
 * 把规则打回原形 —— 静态 import 竟然没被抓到。）
 */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = src.length;
      blank(i, j);
      i = j;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? src.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    // 字符串整体跳过：里面的 "//" 不是注释
    if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) j += src[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** 全部源文件，键是「相对 src/ 的路径」 */
function sourceFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${d.name}`;
      if (d.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(d.name)) {
        out.set(full.slice(SRC.length + 1), full);
      }
    }
  };
  walk(SRC);
  return out;
}

const FILES = sourceFiles();

/** 解析相对路径引用（./ 与 ../），返回「相对 src/ 的路径」，解析不出来返回 null */
function resolveRel(fromRel: string, spec: string): string | null {
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const parts = (dir ? dir.split("/") : []).concat(spec.split("/"));
  const stack: string[] = [];
  // 退过头（`..` 比目录层级还多）就是非法路径，不能悄悄夹在 src/ 根上 ——
  // 否则 "../../../_shared/X" 会解析成 src/_shared/X，与 "../../_shared/X" 同路径，
  // 明明是不同的文件却看成同一个，匹配就会出假结果。
  let escaped = false;
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") {
      if (stack.length === 0) escaped = true;
      else stack.pop();
    } else stack.push(p);
  }
  if (escaped) return null;
  const joined = stack.join("/");
  const cands = [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`, `${joined}/index.tsx`];
  return cands.find((c) => FILES.has(c)) ?? null;
}

interface Hit {
  file: string;
  line: number;
  stmt: string;
}

interface ImportHit extends Hit {
  spec: string;
  /** 裸的 `import(...)` —— 动态加载 */
  dynamic: boolean;
  /** 被 `lazy(() => import(...))` 包着 —— 动态加载（React 专属形态） */
  lazyWrapped: boolean;
}

/**
 * 找出所有 import 语句（静态与动态都算），stmt 是原文。
 *
 * `import X from "p"` / `import { a } from "p"` / `import "p"` / `import("p")`
 */
function allImports(): ImportHit[] {
  const out: ImportHit[] = [];
  const re = /import\s*(?:\(\s*)?(?:[\w*{}\s,]+?\s+from\s+)?["']([^"']+)["']/g;
  for (const [rel, abs] of FILES) {
    const raw = readFileSync(abs, "utf8");
    const clean = stripComments(raw);
    for (const m of clean.matchAll(re)) {
      const stmt = m[0];
      const at = m.index ?? 0;
      // 动态 import：import 后面紧跟 (
      const dynamic = /^\s*import\s*\(/.test(stmt);
      /**
       * lazy 包装：`const X = lazy(() => import("./X"))`
       *
       * 正则只能匹配到 `import(` 开头那截，`lazy(` 在它**前面**，
       * 所以必须回看 import 之前的那一小段文本。
       * 只看同一行、且必须是行尾的 `lazy(` —— 否则 `foo(lazy(() => import(...)))`
       * 之类的写法会漏判。
       */
      const before = clean.slice(Math.max(0, at - 40), at);
      const lazyWrapped = /lazy\s*\(\s*\(?\s*$/.test(before);
      out.push({
        file: rel,
        line: raw.slice(0, at).split("\n").length,
        stmt,
        spec: m[1],
        dynamic,
        lazyWrapped,
      });
    }
  }
  return out;
}

const IMPORTS = allImports();

/** 找出「静态 import 了某个包」的所有位置 */
function staticImportsOf(pkg: string): Hit[] {
  return IMPORTS.filter((i) => {
    if (i.dynamic) return false;
    if (!i.spec.startsWith(pkg)) return false;
    // 类型导入：编译后整条消失，不占首屏体积
    if (/^import\s+type\b/.test(i.stmt)) return false;
    // CSS 副作用导入：CSS 不该异步加载
    if (/\.css["']/.test(i.stmt)) return false;
    return true;
  }).map((i) => ({ file: i.file, line: i.line, stmt: i.stmt }));
}

/**
 * 从「首屏入口」出发做可达性分析，找出**首屏一定会加载**的文件集合。
 *
 * 为什么要算可达性：`SqlEditor.tsx` 与 `ChartCard.tsx` 内部是静态 import
 * CodeMirror / recharts 的，但这两个文件**本身**是通过 `lazy()` 加载的
 * —— 它们的依赖不在首屏。规则若只看"有没有静态 import"，就会把
 * 这两个文件判成违规，而修法（把 CodeMirror 改成动态 import）毫无意义。
 *
 * 这里的可达性按「静态 import 图」走：
 * - 入口：`main.tsx`（应用挂载点）；
 * - 边：静态 `import … from "./相对路径"`；
 * - **不跟** `lazy(() => import("./x"))` 走 —— 那正是我们要它断开的边。
 */
function firstScreenFiles(): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = FILES.has("main.tsx") ? ["main.tsx"] : [];
  while (queue.length) {
    const cur = queue.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const imp of IMPORTS) {
      if (imp.file !== cur) continue;
      if (imp.dynamic) continue; // 刻意断开的那条边
      if (!imp.spec.startsWith(".")) continue;
      const target = resolveRel(cur, imp.spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

/** 找出「引用了目标文件的 import 语句」 */
function importersOf(target: string): ImportHit[] {
  const out: ImportHit[] = [];
  for (const imp of IMPORTS) {
    if (!imp.spec.startsWith(".")) continue;
    if (resolveRel(imp.file, imp.spec) !== target) continue;
    out.push(imp);
  }
  return out;
}

describe("重依赖的加载方式", () => {
  const firstScreen = firstScreenFiles();

  it("扫描本身有效：抓得到 import 语句，也分得清静态与动态", () => {
    expect(FILES.size).toBeGreaterThanOrEqual(80);
    expect(IMPORTS.length).toBeGreaterThan(100);
    // 动态 import 必须能被认出来（否则 lazy 全被当成静态）
    const dyn = IMPORTS.filter((i) => i.dynamic);
    expect(dyn.length).toBeGreaterThan(0);
    // 静态 import 也必须能被认出来
    const stat = IMPORTS.filter((i) => !i.dynamic);
    expect(stat.length).toBeGreaterThan(0);
  });

  it("首屏可达集非空，且不含 lazy 出来的重组件文件", () => {
    // 可达集为空 → 规则会永远"零违规"（假绿）；
    // 可达集里混进了 SqlEditor / ChartCard → 断边规则失配。
    expect(firstScreen.size).toBeGreaterThan(5);
    expect(firstScreen.has("App.tsx")).toBe(true);
    expect(firstScreen.has("apps/db/components/SqlEditor.tsx")).toBe(false);
    expect(firstScreen.has("apps/db/report/ChartCard.tsx")).toBe(false);
  });

  for (const { pkg, hint } of HEAVY_DEPS) {
    it(`${pkg} 不许被首屏静态 import（${hint}）`, () => {
      // 只看首屏可达的文件 —— lazy 子树里的静态 import 无害
      const hits = staticImportsOf(pkg).filter((h) => firstScreen.has(h.file));
      expect(hits).toEqual([]);
    });
  }

  /**
   * 更强的一条：装着重依赖的那个文件，**引用它的人**必须走 lazy。
   *
   * 上面那条只管"首屏"。但 lazy 板块内部还有一层：
   * 数据库板块（DbApp）本身是 lazy 的，可它内部若静态 import 了
   * SqlEditor（CodeMirror 378KB），那么"点开数据库板块"的那一刻
   * 就要同步下载 + 解析 + JIT 这一整坨 —— 切板块会顿一下。
   *
   * 所以规矩是：**重依赖文件只能被 `lazy(() => import(...))` 引用**。
   */
  for (const { pkg, hint } of HEAVY_DEPS) {
    it(`${pkg} 所在文件只许被 lazy 引用（${hint}）`, () => {
      // 找所有静态 import 了该包的文件
      const holders = [...new Set(staticImportsOf(pkg).map((h) => h.file))];
      expect(holders.length).toBeGreaterThan(0); // 反例自证：得真找到过
      const bad: string[] = [];
      for (const holder of holders) {
        for (const imp of importersOf(holder)) {
          /**
           * 引用方式有两种动态形态，都算数：
           * - `lazy(() => import("./X"))` —— React 的标准拆包写法；
           * - 裸 `import("./X")` —— 直接异步加载。
           *
           * 判断依据是 **import 之前的那段文本**（`lazy(` 在 `import(` 前面，
           * 只看 import 语句本身是看不到的 —— 这正是本门禁第一版把
           * 「DbApp → SqlEditor（明明是 lazy）」判成违规的原因）。
           */
          if (!imp.dynamic && !imp.lazyWrapped) {
            bad.push(`${imp.file}:${imp.line}  → ${holder}`);
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }

  it("反例自证：静态 import 会被抓出来，动态 import 不会（规则没失配）", () => {
    // 这一条是本门禁的命门：规则抓不到东西的话，"零违规"就是假绿。
    const statRe = /import\s+(?:[\w*{}\s,]+?\s+from\s+)?["']@xterm\/xterm[^"']*["']/g;
    const statSrc = 'import { Terminal } from "@xterm/xterm";';
    expect(stripComments(statSrc).match(statRe)).not.toBeNull();

    // 动态 import 不该被抓（它的形态是 import( 后面跟引号，不是 from）
    const dynSrc = 'const t = await import("@xterm/xterm");';
    expect(stripComments(dynSrc).match(statRe)).toBeNull();
  });

  it("路径解析：./ 与 ../ 都能解析到真实文件", () => {
    // 同目录
    expect(resolveRel("apps/db/DbApp.tsx", "./components/SqlEditor")).toBe(
      "apps/db/components/SqlEditor.tsx",
    );
    // 上跳两级：从 apps/db/ 退到 src/ 根，再进 _shared
    // （真实代码里 DbApp.tsx 就是这么引 ThemeContext 的）
    expect(resolveRel("apps/db/DbApp.tsx", "../../_shared/ThemeContext")).toBe(
      "_shared/ThemeContext.tsx",
    );
    // 上跳一级：从 apps/db/components/ 退到 apps/db/
    expect(resolveRel("apps/db/components/SqlEditor.tsx", "../_shared/deepLink")).toBe(
      "apps/db/_shared/deepLink.ts",
    );
    // 目录 index（apps/db/agent/ 下有 index.ts）
    expect(resolveRel("apps/db/DbApp.tsx", "./agent")).toBe("apps/db/agent/index.ts");
    // 没有 index 的目录解析不出来 —— 不能凭空猜一个
    expect(resolveRel("apps/db/DbApp.tsx", "./report")).toBeNull();
  });

  it("路径解析：上跳过头时不能凭空造出路径", () => {
    // `..` 退到 src/ 根之后再退 —— 应该解析不出来，而不是凭空猜一个
    expect(resolveRel("apps/db/DbApp.tsx", "../../../_shared/ThemeContext")).toBeNull();
    // 指到一个不存在的文件
    expect(resolveRel("apps/db/DbApp.tsx", "./components/DoesNotExist")).toBeNull();
  });
});
