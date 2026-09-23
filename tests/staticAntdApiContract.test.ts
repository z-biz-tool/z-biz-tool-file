/**
 * 结构性门禁：antd 的"模块级静态 API"不能再被用回提示条和确认框。
 *
 * 起因是深色主题下同屏两种配色：走 ConfigProvider 的提示条是 bg rgb(31,31,31)，
 * 而静态 message.error(...) 起的是模块级默认配置，弹出来是 bg rgb(255,255,255) +
 * rgba(0,0,0,0.88) 的白底黑字，locale 也一起读不到。2026-09-23 分两轮把 22 个组件
 * 改成 App.useApp() 之后，全站静态 message 引入归零、静态确认框弹窗只剩
 * utils/conflictChoice（改成由调用方注入 modal）。这种"全站归零"的状态靠人记是记不住的，
 * 所以做成门禁：谁再写回静态 API，测试就红。
 *
 * 三条规则都必须先过注释与字符串，否则会被自己的文档骗：
 * 全站有若干注释在解释"为什么不能用 Modal.confirm"，按字符串一搜就全是假违规
 * （这个教训来自 Modal 关闭入口那条门禁，它当初也差点把 onCancel={onClose} 当成 onClose）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(`${ROOT}/src`, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && /\.(ts|tsx)$/.test(d.name))
    .map((d) => `${d.parentPath}/${d.name}`);
}

/**
 * 去掉注释内容（长度不变，用空格占位，`\n` 留着以便对回行号）。
 * 必须先把注释清掉再谈违规：全站有若干注释在解释"为什么不能用 Modal.confirm"。
 */
export function stripComments(src: string): string {
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
    if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      // 字符串整体跳过：里面的 "//" 不是注释
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

/** 再把字符串字面量的内容抹成空格：`const s = "Modal.confirm("` 不算调用 */
function blankStrings(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < src.length && src[j] !== q) j += src[j] === "\\" ? 2 : 1;
      for (let k = i; k < Math.min(j + 1, src.length); k += 1) if (out[k] !== "\n") out[k] = " ";
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** import 语句里的具名绑定（跨行写法必须算进来：全站 12 个面板就是换行写的） */
function antdNamedImports(noComments: string): string[] {
  const names: string[] = [];
  for (const m of noComments.matchAll(/import\s+([\s\S]*?)\s+from\s+["']antd["']/g)) {
    const clause = m[1];
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (!braces) continue;
    for (const part of braces[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

const at = (file: string, src: string, idx: number) =>
  `${file.slice(ROOT.length)}:${src.slice(0, idx).split("\n").length}`;

const files = sourceFiles();
const parsed = files.map((f) => {
  const src = readFileSync(f, "utf8");
  const noComments = stripComments(src);
  return { file: f, src, noComments, clean: blankStrings(noComments) };
});

describe("antd 静态 API 的使用", () => {
  // 门禁自身的存在性：目录走错、解析失配都会让"零违规"变成假绿
  it("确实扫到了全站源码里的 antd 引入与 useApp 调用", () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
    const withAntd = parsed.filter((p) => /from ["']antd["']/.test(p.noComments)).length;
    expect(withAntd).toBeGreaterThanOrEqual(25);
    const withUseApp = parsed.filter((p) => /AntdApp\.useApp\(\)/.test(p.clean)).length;
    expect(withUseApp).toBeGreaterThanOrEqual(30);
  });

  it("不许从 antd 静态引入 message：提示条必须带主题", () => {
    const bad = parsed
      .filter((p) => antdNamedImports(p.noComments).includes("message"))
      .map((p) => p.file.slice(ROOT.length));
    expect(bad).toEqual([]);
  });

  it("不许写 Modal.confirm 这类模块级静态确认框", () => {
    // 只管 Modal：迁移之后 `message.error(...)` 里的 message 是各组件从 App.useApp()
    // 解构出来的**局部实例**，那是正确写法；静态 message 通道的回归由上面那条
    // "不许从 antd 引入 message" 来堵，两条例子各管一段，别把它们混成一个正则。
    const bad: string[] = [];
    for (const p of parsed) {
      for (const m of p.clean.matchAll(/(?<![\w.$])\bModal\s*\.\s*(confirm|error|warning|info|success|destroy)\b/g)) {
        bad.push(at(p.file, p.src, m.index ?? 0));
      }
    }
    expect(bad).toEqual([]);
  });

  it("不许再给某个面板单独搭一套 useMessage holder（提示通道全站一条）", () => {
    const bad: string[] = [];
    for (const p of parsed) {
      for (const m of p.clean.matchAll(/\.use(Message|Notification)\(/g)) bad.push(at(p.file, p.src, m.index ?? 0));
    }
    expect(bad).toEqual([]);
  });

  it("确认框要的 modal 必须由调用方注入，别在 util 里摸全局", () => {
    // conflictChoice 曾经直接 Modal.confirm(...)：非组件文件拿不到 hook，
    // 所以它的弹窗实例由 placeBatch 的调用方传进来。这里钉住这个形状。
    const src = readFileSync(`${ROOT}/src/utils/conflictChoice.tsx`, "utf8");
    expect(src).toMatch(/function askConflictPolicy\([\s\S]*?modal: ModalApi/);
    expect(src).toMatch(/function placeBatch\([\s\S]*?modal: ModalApi/);
    expect(blankStrings(stripComments(src))).toMatch(/modal\.confirm\(/);
  });

  // 判定函数自己的正反例：注释里那句"静态 Modal.confirm 走模块级默认配置"不能被算成违规
  it("解析：注释与字符串里的关键字不算违规，跨行 import 要认", () => {
    const doc = `// Modal.confirm( 这种写法不要了
/** message.error("x") 同样不要 */
const why = "notification.open 只是文档里的字符串";
import { Modal } from "antd";
export const ok = 1;`;
    const noComments = stripComments(doc);
    const clean = blankStrings(noComments);
    expect(clean.match(/(Modal|message|notification)\s*\.\s*\w+/g)).toBeNull();
    // 注释与字符串都不能把 import 说明符本身一起抹掉 —— 抹掉了，规则一就永远"零违规"
    expect(antdNamedImports(noComments)).toEqual(["Modal"]);
    expect(clean.split("\n").length).toBe(doc.split("\n").length);

    // 只有 import 里的花括号跨行也要能抓到绑定名
    expect(antdNamedImports(`import {
  Button,
  message,
} from "antd";`)).toEqual(["Button", "message"]);
    expect(antdNamedImports(`import { message } from 'antd';`)).toEqual(["message"]);
    // 不是来自 antd 的同名绑定不该进来
    expect(antdNamedImports(`import { message } from "./myMessage";`)).toEqual([]);
  });
});
