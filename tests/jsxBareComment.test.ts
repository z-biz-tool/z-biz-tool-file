/**
 * 静态检查：JSX children 位置不能出现裸 `//` 注释。
 *
 * ## 为什么要这个测试
 *
 * 回归用例是 2026-11-06 那次「窗口顶部飘着一行代码注释」——
 * 截图里那行字是 `App.tsx` 里的一段说明：
 *
 * ```text
 * 子组件（Omnibar / TabsBar / 预览区）通过 useShortcutHint() 取同一份注册表，
 * ```
 *
 * 它的真身是这么写的：
 *
 * ```jsx
 * <UpdateCenterProvider ...>
 * // 子组件（Omnibar / TabsBar / 预览区）通过 useShortcutHint() 取同一份注册表，
 * // 不再各自抄一份 mac 专属文案。
 * <ShortcutHintsProvider specs={shortcutSpecs}>
 * ```
 *
 * ## 机制
 *
 * JSX 的 children 位置里，裸的 `//` **不是注释，是纯文本**。
 * JSX 的注释语法只有一种：花括号里包一个 JSX 注释 —— 形如「左花括号 + 斜杠星 + 内容 + 星斜杠 + 右花括号」。
 *
 * （注意：本文档里刻意不写那个完整写法 —— 块注释里出现「星斜杠」会提前把注释本身截断。）
 *
 * 而在 JS 表达式上下文里（三元 `? (` / `: (`、箭头函数参数、
 * `useCallback(` 的参数位……），`//` 又是正常注释，不会渲染。
 *
 * 两种上下文长得几乎一样，肉眼很难分辨 —— 于是就有了这个静态检查。
 *
 * ## 判定方法
 *
 * 不用正则硬猜 JSX 语义，而是**借 TypeScript 自己的解析器**：
 * 让 `ts.createSourceFile` 解析文件，然后遍历 AST 找 `JsxText` 节点 ——
 * 只要某段「文本」里含有 `//` 开头的行，就说明它是裸注释漏进了 children。
 *
 * 这是编译器视角的判定，不依赖缩进、不依赖「上一行以什么结尾」这类启发式。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(process.cwd(), "src");

/** 递归收集所有 .tsx 文件。 */
function collectTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsx(full));
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 找出被当成文本渲染出来的裸注释。
 *
 * 判据：`JsxText` 节点的文本里出现行首 `//`（允许前面有空白）。
 * JSX 会把 children 之间的空白与注释原样塞进 `JsxText`，
 * 所以只要它含有 `//` 开头的行，就是漏出来的注释。
 */
function findBareJsxComments(source: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Array<{ line: number; text: string }> = [];

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const lines = node.text.split("\n");
      lines.forEach((line, i) => {
        if (/^\s*\/\//.test(line)) {
          const { line: ln } = sf.getLineAndCharacterOfPosition(
            node.getStart(sf) + node.text.indexOf(line),
          );
          hits.push({ line: ln + 1, text: line.trim() });
        }
      });
      // JsxText 的子节点里没有需要继续看的
      if (node.text.length === 0) return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return hits;
}

describe("JSX 不得把裸注释渲染成文本", () => {
  const files = collectTsx(SRC_DIR);
  it("src 下有 .tsx 文件可扫（否则下面的断言是空的，等于没测）", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${file.replace(process.cwd() + "/", "")} 没有裸注释混进 JSX`, () => {
      const hits = findBareJsxComments(readFileSync(file, "utf8"));
      expect(
        hits.map((h) => `${h.line}: ${h.text}`),
        "JSX children 位置出现裸 `//` 注释 —— 它会被当作文本渲染到界面上。\n" +
          "  改法：写成「花括号里包 JSX 注释」—— 即 `{` + `/* ... */` + `}`（JSX 的注释语法只有这一种）。",
      ).toEqual([]);
    });
  }
});
