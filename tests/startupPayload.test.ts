/**
 * 结构性门禁：首屏同步加载的体积不许反弹。
 *
 * ## 为什么有这条门禁
 *
 * 2026-11-06 那轮性能排查实测到：应用启动时 WebContent 进程烧掉 6.6 秒 CPU，
 * 用户抱怨「电脑会呼啦呼啦响」。`sample` 抓到的热点是 JSC 的 DFG 编译
 * （`ByteCodeParser` / `B3 优化`）与首屏布局绘制（`RenderBlock::layout` / `paint`）——
 * 根因就是首屏要下载 + 解析 + JIT 一大坨用不到的代码。
 *
 * 那轮排查里最反直觉的一条：**拆 chunk 本身不省首屏**。
 * 逐文件 sourcemap 归因后发现，主 chunk 里排第一的不是 antd 本体，
 * 而是 App.tsx 静态 import 的 30+ 个功能组件（归档浏览器、PDF 工具、OCR、
 * 差异对比…）—— 全是 `open=false` 时根本不显示的东西。
 * 只改 `manualChunks` 的话，首屏体积纹丝不动（1722KB → 1760KB，反而涨了）。
 *
 * 真正的解法是**让这些组件压根不在首屏可达集里**。
 *
 * ## 规则
 *
 * 1. **首屏可达集** = 从 `main.tsx` 出发、沿**静态** import 走到的文件闭包。
 *    不跟 `lazy(() => import(...))` 走 —— 那正是要它断开的边。
 * 2. 首屏可达集里**不许**出现「只有 open=true 时才显示」的重型功能组件。
 *    这里盯的是具体那几个体积大户（其余的交给 lazyHeavyDeps 那条门禁）。
 * 3. 首屏总体积不许超过上限。
 *
 * ## 为什么用"构建产物 + 静态 import 图"而不是"扫源码"
 *
 * 源码扫不出真实体积：antd 组件的实际字节数只有打包后才知道，
 * 而"某个组件拖进来多少字节"取决于 rollup 怎么切 chunk。
 * 直接量 dist/ 里的静态 import 闭包，才是用户真正要下载的那部分。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const DIST = `${ROOT}/dist`;

/**
 * 首屏体积上限（字节，含 index.html 里的入口 + modulepreload 的静态闭包）。
 *
 * 2026-11-06 优化前：1,764,000 字节（1722 KB，单文件）
 * 2026-11-06 优化后：1,441,000 字节（1407 KB，三文件）
 *
 * 留 2% 余量：图标集、antd 版本升级都可能带来几 KB 的正常波动，
 * 不该因为这种波动就让人来改这条阈值。但结构性反弹（比如有人把
 * ArchiveExplorer 改回静态 import）会一次性涨 100KB+，必然撞线。
 */
const MAX_STARTUP_BYTES = 1_470_000;

/**
 * 这些组件是「点开才用」的重型功能组件，不许出现在首屏可达集里。
 *
 * 选取标准：单文件超过 5KB，且必须有 open 语义（关着时根本不显示）。
 * 列表与 tests/lazyHeavyDeps.test.ts 里的重依赖清单互补 ——
 * 那条管"重依赖库"，这条管"重型功能组件"。
 *
 * 每项记的是「谁在引用它」—— 不同组件的引用方不一样：
 * 弹窗类在 App.tsx，阅读器类在 FileContentPreview.tsx。
 */
const MUST_NOT_BE_FIRST_SCREEN: { file: string; declaredIn: string }[] = [
  // ── App.tsx 里的弹窗/面板 ──
  { file: "components/ArchiveExplorer.tsx", declaredIn: "src/App.tsx" },
  { file: "components/ArchiveCreateDialog.tsx", declaredIn: "src/App.tsx" },
  { file: "components/PdfTools.tsx", declaredIn: "src/App.tsx" },
  { file: "components/DiffViewer.tsx", declaredIn: "src/App.tsx" },
  { file: "components/OcrTool.tsx", declaredIn: "src/App.tsx" },
  { file: "components/Aria2Manager.tsx", declaredIn: "src/App.tsx" },
  { file: "components/DuplicateFinder.tsx", declaredIn: "src/App.tsx" },
  { file: "components/HashCalculator.tsx", declaredIn: "src/App.tsx" },
  { file: "components/DirectorySync.tsx", declaredIn: "src/App.tsx" },
  { file: "components/StorageAnalyzerModal.tsx", declaredIn: "src/App.tsx" },
  { file: "components/QuickActionsModal.tsx", declaredIn: "src/App.tsx" },
  { file: "components/SftpModal.tsx", declaredIn: "src/App.tsx" },
  { file: "components/BatchRename.tsx", declaredIn: "src/App.tsx" },
  { file: "components/FileProperties.tsx", declaredIn: "src/App.tsx" },
  { file: "components/NewFileTemplate.tsx", declaredIn: "src/App.tsx" },
  { file: "components/TrashModal.tsx", declaredIn: "src/App.tsx" },
  { file: "components/ShortcutHelp.tsx", declaredIn: "src/App.tsx" },
  { file: "components/TagEditModal.tsx", declaredIn: "src/App.tsx" },
  { file: "components/LibraryView.tsx", declaredIn: "src/App.tsx" },
  { file: "components/MediaGallery.tsx", declaredIn: "src/App.tsx" },
  { file: "components/Updater.tsx", declaredIn: "src/App.tsx" },
  { file: "components/SettingsModal.tsx", declaredIn: "src/App.tsx" },
  // ── FileContentPreview.tsx 里的阅读器（每种文件类型一个）──
  { file: "components/ImageEditor.tsx", declaredIn: "src/components/FileContentPreview.tsx" },
  { file: "components/EpubReader.tsx", declaredIn: "src/components/FileContentPreview.tsx" },
  { file: "components/PdfViewer.tsx", declaredIn: "src/components/FileContentPreview.tsx" },
  { file: "components/MarkdownPreview.tsx", declaredIn: "src/components/FileContentPreview.tsx" },
  { file: "components/CsvPreview.tsx", declaredIn: "src/components/FileContentPreview.tsx" },
  { file: "components/JsonPreview.tsx", declaredIn: "src/components/FileContentPreview.tsx" },
  { file: "components/YamlPreview.tsx", declaredIn: "src/components/FileContentPreview.tsx" },
  { file: "components/TextConverter.tsx", declaredIn: "src/components/FileContentPreview.tsx" },
];

function readDistIndexHtml(): string | null {
  const p = `${DIST}/index.html`;
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** 收集首屏入口：<script type=module src> + <link rel=modulepreload href> */
function entryPoints(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script type="module"[^>]*src="\/([^"]+)"/g)) out.add(m[1]);
  for (const m of html.matchAll(/<link rel="modulepreload"[^>]*href="\/([^"]+)"/g)) out.add(m[1]);
  return [...out];
}

/**
 * 静态 import 闭包。
 *
 * 只跟 `import ... from "./x"` / `export ... from "./x"` 这类**静态**写法；
 * `import("./x")` 不跟 —— 那是懒加载，本就该在首屏之外。
 */
function staticClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const cur = queue.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const abs = resolve(DIST, cur.replace(/^\//, ""));
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    // 行首或分隔符后的 import/export，后跟模块说明符
    const re = /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]*?\s+from\s*)?["'](\.\/[^"']+)["']/g;
    for (const m of src.matchAll(re)) {
      const target = resolve(dirname(abs), m[1]).replace(/.*\/dist\//, "");
      if (!seen.has(target)) queue.push(target);
    }
  }
  return [...seen];
}

describe("首屏加载的体积", () => {
  const html = readDistIndexHtml();

  it.skipIf(!html)("构建产物存在（先 npm run build）", () => {
    expect(html).not.toBeNull();
  });

  it.skipIf(!html)("首屏总体积不超上限", () => {
    const files = staticClosure(entryPoints(html as string));
    let total = 0;
    for (const f of files) {
      const abs = resolve(DIST, f);
      if (existsSync(abs)) total += readFileSync(abs).length;
    }
    expect(
      total,
      `首屏同步加载 ${(total / 1024).toFixed(0)}KB，超过上限 ${(MAX_STARTUP_BYTES / 1024).toFixed(0)}KB。` +
        `多半是有「点开才用」的组件被改回静态 import 了 —— 查 App.tsx 的 lazyModal 清单。`,
    ).toBeLessThanOrEqual(MAX_STARTUP_BYTES);
  });

  it.skipIf(!html)("首屏只加载少量文件（不是把整个应用打成一坨）", () => {
    const files = staticClosure(entryPoints(html as string));
    // 入口 + 共享核心 + 图标集 —— 超过这个数说明拆分策略失效了
    expect(files.length).toBeLessThanOrEqual(6);
  });
});

/**
 * 源码侧的门禁：这些组件必须走 lazy / lazyModal。
 *
 * 放在这里而不是只靠上面的体积门禁，是因为体积门禁只在**构建后**才跑，
 * 而「有人把某个组件改回静态 import」这件事应该在**提交时**就被拦住。
 */
describe("点开才用的组件不许回到首屏", () => {
  it("这些组件必须是动态引用（lazy / lazyModal）", () => {
    // 按「声明所在的文件」分组，避免同一个文件被读 N 遍
    const byFile = new Map<string, string[]>();
    for (const { file, declaredIn } of MUST_NOT_BE_FIRST_SCREEN) {
      const list = byFile.get(declaredIn) ?? [];
      list.push(file);
      byFile.set(declaredIn, list);
    }

    const missing: string[] = [];
    for (const [declaredIn, list] of byFile) {
      const src = readFileSync(`${ROOT}/${declaredIn}`, "utf8");
      for (const f of list) {
        const name = f.split("/").pop()!.replace(/\.tsx$/, "");
        // 必须是 `const X = lazy(...)` 或 `const X = lazyModal(...)` 之一。
        // 裸 `lazy(...)` 的分量在 FileContentPreview 里；lazyModal 的在 App.tsx 里。
        const re = new RegExp(`const\\s+${name}\\s*=\\s*lazy(Modal)?\\s*\\(`);
        if (!re.test(src)) missing.push(`${f}（应在 ${declaredIn} 里用 lazy/lazyModal）`);
      }
    }
    expect(
      missing,
      `这些组件应该用 lazyModal/lazy 从首屏拆出去：\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("App.tsx 里的弹窗一律走 lazyModal（open 语义）", () => {
    // lazyModal 比裸 lazy 多一层「open 为假就不挂载」——
    // 而这些弹窗全是「无条件渲染 + 靠 open 显隐」的写法，
    // 只用裸 lazy() 的话，React 在首帧就会发起 import，等于白拆。
    const src = readFileSync(`${ROOT}/src/App.tsx`, "utf8");
    const bareLazy: string[] = [];
    /**
     * 允许裸 lazy 的白名单 —— 这几个由**外层的条件渲染**兜住，
     * 组件在条件为假时压根不渲染，所以 React 不会发起 import。
     */
    const BARE_LAZY_OK = new Set([
      "MediaGallery",      // {mediaLibraryOpen && ...}
      "TagEditModal",      // 纯函数/类型同文件，default 导出单独取
      "ArchiveCreateDialog",
      // 四个「板块 app」：活动栏点哪个才渲染哪个
      "TerminalApp",
      "LibraryApp",
      "GalleryApp",
      "DbApp",
      "SysApp",
      "WorkerApp",
      "FileManagerApp",
    ]);
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*lazy\s*\(/g)) {
      if (BARE_LAZY_OK.has(m[1])) continue;
      bareLazy.push(m[1]);
    }
    expect(
      bareLazy,
      `App.tsx 里这些组件应该用 lazyModal：${bareLazy.join(", ")}`,
    ).toEqual([]);
  });
});
