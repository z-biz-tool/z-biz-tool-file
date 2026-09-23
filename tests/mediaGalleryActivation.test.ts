/**
 * 结构性门禁：画廊卡片的"打开"必须由双击触发，单击只负责选中。
 *
 * 主列表（onRow.onDoubleClick）、文件树、分栏视图都是"双击才打开"，唯独媒体库的三张卡片
 * 把 onOpen 绑在 onClick 上 —— 在文件管理器里，一次误点就起了外部程序，而且原来那个
 * 处理函数就叫 handleItemDoubleClick（意图是双击，绑定写成了单击）。
 *
 * 这条规则本身在 node 环境里跑不起来（vitest 只收 tests 目录下的 .test.ts，且渲染需要 DOM），
 * 所以做成静态门禁：按卡片组件的函数体逐个查绑定。实测部分是 dev 页 + stub invoke
 * 那一轮：单击 a.jpg 之后 open_with_default_app 计数为 0 且选中环出现，
 * 双击 b.png 才发出一次 {path:"/photos/b.png"}。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = readFileSync(`${ROOT}/src/components/MediaGallery.tsx`, "utf8");

const CARDS = ["ImageItem", "VideoItem", "AudioItem", "ListRow"];

/** 卡片组件自己的函数体（到下一个顶层 const 为止） */
function bodyOf(name: string): string {
  const start = SRC.indexOf(`const ${name}`);
  expect(start, `找不到 ${name}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  const next = rest.slice(1).search(/^const |^\/\/ |^export /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("媒体库卡片的激活方式", () => {
  it("三张卡片都存在（改动漏掉某一张时，这条先红）", () => {
    for (const c of CARDS) expect(SRC).toContain(`const ${c}`);
  });

  it("单击走 onSelect，打开走 onDoubleClick", () => {
    for (const c of CARDS) {
      const body = bodyOf(c);
      expect(body.includes('onClick={() => onSelect(item)}'), `${c} 单击没接 onSelect`).toBe(true);
      expect(body.includes('onDoubleClick={() => onOpen(item)}'), `${c} 没有双击打开`).toBe(true);
    }
  });

  it("onClick 里不许出现 onOpen —— 误点就起外部程序", () => {
    const offenders: string[] = [];
    for (const c of CARDS) {
      const body = bodyOf(c);
      for (const m of body.matchAll(/onClick=\{\(\)\s*=>\s*([^}]*)\}/g)) {
        if (m[1].includes("onOpen")) offenders.push(`${c}: ${m[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("两种版式的每一项都过 withMenu —— 列表视图不能悄悄没有右键菜单", () => {
    const uses = SRC.match(/withMenu\(/g) ?? [];
    // 网格三种类型 + 列表一种：定义处写成 `withMenu = (`，不计入
    expect(uses.length).toBe(4);
    const list = bodyOf("renderList");
    expect(list).toContain("withMenu(item, <ListRow");
  });

  it("选中态要跟着列表走：删掉当前选中的那一张时把环摘掉", () => {
    // 只删列表项不摘选中，会出现"指着不存在的路径的选中环"
    expect(SRC).toMatch(/setSelectedPath\(\(cur\) => \(?cur === item\.path \? null : cur\)?\)/);
    // 换目录/换馆也要清，否则上一馆的选中会落到这一馆同名路径上
    expect(SRC).toMatch(/useEffect\(\(\) => \{\s*setSelectedPath\(null\)/);
  });
});

describe("媒体库键盘导航：上下方向键按列走", () => {
  it("listbox 容器必须挂上 ref，否则 ResizeObserver 找不到元素", () => {
    expect(SRC).toMatch(/<div\s+ref=\{containerRef\}[\s\S]*?role="listbox"/);
  });

  it("必须用 ResizeObserver 实时算列数（不能猜步长）", () => {
    expect(SRC).toMatch(/new ResizeObserver\(compute\)/);
    expect(SRC).toMatch(/ro\.observe\(el\)/);
    // 卸载时要 disconnect，否则切馆后旧的 observer 还在监听没用的元素
    expect(SRC).toMatch(/return\s*\(\)\s*=>\s*ro\.disconnect\(\)/);
  });

  it("nextSelectedIndex 调用必须传 columns 参数", () => {
    expect(SRC).toMatch(/nextSelectedIndex\(selectedIndex, mediaFiles\.length, action, columns\)/);
  });

  it("列数只有画廊 + image/video 才算；音频和列表视图固定 1", () => {
    // viewMode !== "gallery" 或 mediaType === "audio" 时直接 setColumns(1)
    expect(SRC).toMatch(/if\s*\(viewMode\s*!==\s*"gallery"\s*\|\|\s*mediaType\s*===\s*"audio"\)/);
    expect(SRC).toMatch(/setColumns\(1\)/);
  });

  it("键盘动作映射必须支持 ArrowUp / ArrowDown", () => {
    // MediaGallery 路径里没有 Arrow 字面值（走的是 mediaKeyAction 纯函数），
    // 但这条规则两件事必须钉住：(a) 纯函数映射的源文件支持 ↑/↓ (b) 调用方没把它过滤掉。
    const KEYS = readFileSync(`${ROOT}/src/utils/mediaKeys.ts`, "utf8");
    // 形如 if (e.key === "ArrowUp") return "up";
    expect(KEYS).toMatch(/e\.key\s*===\s*"ArrowUp"[\s\S]{0,40}return\s+"up"/);
    expect(KEYS).toMatch(/e\.key\s*===\s*"ArrowDown"[\s\S]{0,40}return\s+"down"/);
    // 组件侧 onKeyDown 必须把 action 透传给 nextSelectedIndex（不能再写"只接 prev/next"）
    expect(SRC).toMatch(/nextSelectedIndex\(selectedIndex, mediaFiles\.length, action, columns\)/);
  });
});
