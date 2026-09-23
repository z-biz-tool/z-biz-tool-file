/**
 * 结构性门禁：store 里不许有"没人读的 state"和"没人调的 setter"。
 *
 * 这一轮的三个缺陷都是这么找出来的：mediaViewMode / mediaGallerySize 存着没人读，
 * 于是媒体库那组版式控件是按了没反应的装饰；aiEnabled / aiModel / aiEndpoint 只有一个
 * 从未挂载的 AISettingPanel 在读；searchQuery / searchResults / isSearching / searchRoot /
 * aiLastSearch / aiSearchResults 连同五个 setter 整簇零引用（SearchBar 用的是自己的局部 state）。
 * 幽灵 state 的代价不是"多几行"，而是下一个人照着它写 UI 会以为后端通好了。
 *
 * typecheck 抓不到整簇：字段在 interface 里声明、初始值也在，只有"外部读没读"这个事实
 * 需要跨文件看，所以做成门禁。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// fileURLToPath 对目录 URL 会留下结尾斜杠，拼出来的路径带 //，
// 于是"把自己这个文件排除掉"的比较失效——store 自己被当成读者，幽灵字段全都算"有人读"。
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const STORE = `${ROOT}/src/stores/fileStore.ts`;

function sourceFiles(): string[] {
  return readdirSync(`${ROOT}/src`, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && /\.(ts|tsx)$/.test(d.name))
    .map((d) => `${d.parentPath}/${d.name}`.replace(/\/+/g, "/"))
    .filter((p) => p !== STORE);
}

/** FileStore 接口体里声明的成员名（字段 + setter） */
function storeMembers(): string[] {
  const src = readFileSync(STORE, "utf8");
  const start = src.indexOf("interface FileStore");
  expect(start, "找不到 interface FileStore").toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  const names: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s{2}(?:readonly )?([a-zA-Z][\w$]*)\??:\s/);
    if (m) names.push(m[1]);
  }
  return names;
}

describe("fileStore 的成员都要有人用", () => {
  const members = storeMembers();
  const others = sourceFiles().map((f) => ({ file: f, src: readFileSync(f, "utf8") }));

  it("确实扫到了 store 的绝大多数成员与全站组件", () => {
    expect(members.length).toBeGreaterThanOrEqual(30);
    expect(others.length).toBeGreaterThanOrEqual(30);
  });

  it("没有零引用的字段，也没有没人调的 setter", () => {
    const dead = members.filter((name) => {
      const isSetter = /^set[A-Z]/.test(name);
      // setter 必须真的被调用；字段必须真的被读（解构、传参都算）
      const re = isSetter ? new RegExp(`\\b${name}\\s*\\(`) : new RegExp(`\\b${name}\\b`);
      return !others.some((o) => re.test(o.src));
    });
    expect(dead).toEqual([]);
  });

  it("setter 改的键必须真的是 state 里的键（set({...}) 打错字是静默的）", () => {
    const src = readFileSync(STORE, "utf8");
    const declared = new Set(members);
    const bad: string[] = [];
    for (const m of src.matchAll(/^\s{2}(set[A-Z][\w$]*):[^=]*=>\s*set\(\{\s*([\w$]+)/gm)) {
      if (!declared.has(m[2])) bad.push(`${m[1]} → ${m[2]}`);
    }
    // 只在 set() 里出现、却没在 interface 里声明的名字 = 手写出来的野字段
    expect(bad).toEqual([]);
  });
});
