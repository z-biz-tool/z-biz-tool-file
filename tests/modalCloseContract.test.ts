/**
 * 结构性门禁：antd `<Modal>` 的关闭入口不能被写错。
 *
 * 起因是照片馆/视频馆/音乐馆那个弹窗（提交 c53eebb）：它写的是 `onClose`，而 antd
 * Modal 只有 `onCancel` —— X、遮罩、Esc 三条关闭路径全挂在 onCancel 上，加上全站没有
 * 第二处把 mediaLibraryOpen 置回 false，弹窗一打开就只能 ⌘R。
 *
 * 这条规则在运行时没法逐条测（21 个弹窗里多数要有数据才进得去），所以做成静态门禁：
 * 扫源码里每个 <Modal> 开始标签的**顶层属性**，要求
 *   1) 不许出现 onClose（写了也不响，是伪装成关闭入口的死属性）；
 *   2) 受控弹窗（写了 open）必须给 onCancel，除非它显式 closable={false}。
 * 顶层属性这件事必须真解析：全站 21 处写的是 onCancel={onClose}，把 onClose 当**值**用；
 * 只要按字符串一搜就当违规，门禁会一口气报出 21 条假违规，然后被人整个 skip 掉。
 * 所以配套断言里既有"扫到足够多标签"，也有判定函数自己的正反例。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && d.name.endsWith(".tsx"))
    .map((d) => `${d.parentPath}/${d.name}`);
}

/**
 * <Modal 开始标签的文本（不含 '<'，不含收尾的 '>'）。
 * 大括号要配平 —— title/footer 里嵌的 JSX 带着 '>'，按第一个 '>' 切会切出半截标签。
 */
function openingTag(src: string, start: number): string {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "{" || c === "(") depth += 1;
    else if (c === "}" || c === ")") depth -= 1;
    else if (c === ">" && depth === 0) break;
    i += 1;
  }
  return src.slice(start, i);
}

/** 只取大括号深度 0 上的属性名：嵌套 JSX 里的 onClick / 值里的同名变量都进不来 */
function topLevelAttrs(tag: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (let i = 0; i < tag.length; i += 1) {
    const c = tag[i];
    if (c === "{" || c === "(") depth += 1;
    else if (c === "}" || c === ")") depth -= 1;
    if (depth !== 0 || !/[A-Za-z_$]/.test(c)) continue;
    if (i !== 0 && !/[\s\n\r]/.test(tag[i - 1])) continue;
    let j = i;
    while (j < tag.length && /[A-Za-z0-9_$]/.test(tag[j])) j += 1;
    if (/^\s*=[^=]/.test(tag.slice(j, j + 4))) names.push(tag.slice(i, j));
    i = j - 1;
  }
  return names;
}

interface ModalTag {
  file: string;
  line: number;
  attrs: string[];
}

function collectModalTags(): ModalTag[] {
  const out: ModalTag[] = [];
  for (const file of tsxFiles(`${ROOT}/src`)) {
    const src = readFileSync(file, "utf8");
    // (?=[\s>]) 把 <Modal.confirm(...) 这种静态调用排除掉：它不是 JSX 标签
    for (const m of src.matchAll(/<Modal(?=[\s>])/g)) {
      const start = (m.index ?? 0) + "<Modal".length;
      out.push({
        file: file.slice(ROOT.length),
        line: src.slice(0, m.index ?? 0).split("\n").length,
        attrs: topLevelAttrs(openingTag(src, start)),
      });
    }
  }
  return out;
}

const at = (name: string) => (t: ModalTag) => t.attrs.includes(name);
const where = (t: ModalTag) => `${t.file}:${t.line}`;

describe("antd <Modal> 的关闭入口", () => {
  const tags = collectModalTags();

  // 门禁自身的存在性：目录走错、正则失配都会让"零违规"变成假绿
  it("确实扫到了全站绝大多数 Modal", () => {
    expect(tags.length).toBeGreaterThanOrEqual(20);
    expect(tags.filter(at("open")).length).toBeGreaterThanOrEqual(15);
  });

  it("不许写 onClose（antd Modal 只认 onCancel，那是个不会响的死属性）", () => {
    expect(tags.filter(at("onClose")).map(where)).toEqual([]);
  });

  it("受控弹窗必须给 onCancel，否则 X / 遮罩 / Esc 三条路都关不掉", () => {
    const bad = tags
      .filter((t) => t.attrs.includes("open") && !t.attrs.includes("closable") && !t.attrs.includes("onCancel"))
      .map(where);
    expect(bad).toEqual([]);
  });

  it("属性解析：onCancel={onClose} 是把 onClose 当值用，不能算违规", () => {
    expect(topLevelAttrs(`Modal
      open={open}
      onCancel={onClose}
      footer={null}
    `)).toEqual(["open", "onCancel", "footer"]);

    expect(topLevelAttrs(`Modal open={true} onClose={() => setX(false)} >`)).toEqual([
      "open",
      "onClose",
    ]);

    // 嵌套 JSX 的属性、以及 '>' 出现在大括号里（三元比较）都不能冒出来
    expect(
      topLevelAttrs(
        `Modal title={<div onClick={() => f()} style={{ zIndex: n > 1 ? 2 : 3 }}>t</div>} onCancel={close} open`
      )
    ).toEqual(["title", "onCancel"]);
  });
});
