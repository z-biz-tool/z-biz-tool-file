/**
 * fileStore 标签页单测：tab 的 kind 是"主内容区渲染什么"的唯一依据。
 *
 * 回归用例是 openTab 把签名里声明的 kind/meta 整个丢掉那一条 —— 实现只 push
 * `{ id, path }`，而 App.tsx 的 activeTabKind、switchTab 的 currentPath 恢复、
 * TabsBar 的标题/图标、TabsBar 的 onSwitchTo 全都在读 tab.kind。字段缺失不报错，
 * 于是"图书馆"按钮点出来的 tab 被当成目录 tab，标签标题变成 library://main，
 * 切回目录 tab 时路径也不再恢复。只有跑到真 store 上才看得出来。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// store 在模块顶层就 JSON.parse(localStorage.getItem(...)) 初始化书签，
// node 环境没有 localStorage → 必须先桩后 import（顶层 await 保证这个顺序）
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

const { useFileStore } = await import("../src/stores/fileStore");

const store = () => useFileStore.getState();
const activeTab = () => store().tabs.find((t) => t.id === store().activeTabId) ?? null;
// App.tsx 里 activeTabKind 就是这个表达式，抄一份在这儿：测试与页面判据同源才有意义
const activeTabKind = () => activeTab()?.kind ?? "directory";

beforeEach(() => {
  useFileStore.setState({
    tabs: [],
    activeTabId: null,
    currentPath: "/Users/zifang/Downloads",
  });
});

describe("openTab：签名里声明的 kind / meta 必须真的进 store", () => {
  it("不传 kind 时默认是目录 tab，且带上请求的路径", () => {
    const id = store().openTab("/Users/zifang/Downloads");
    expect(store().activeTabId).toBe(id);
    expect(activeTab()).toEqual({ id, path: "/Users/zifang/Downloads", kind: "directory" });
  });

  it("图书馆 tab 保持 library —— 主内容区靠这个值才渲染 LibraryView", () => {
    store().openTab("library://main", "library");
    expect(activeTabKind()).toBe("library");
  });

  it("meta 一并落盘，且不会污染先开着的 tab", () => {
    const dirId = store().openTab("/Users/zifang/Pictures");
    const libId = store().openTab("library://main", "library", { libraryKind: "book" });
    expect(store().tabs.find((t) => t.id === dirId)).toEqual({
      id: dirId,
      path: "/Users/zifang/Pictures",
      kind: "directory",
    });
    expect(store().tabs.find((t) => t.id === libId)?.meta).toEqual({ libraryKind: "book" });
  });
});

describe("switchTab：切 tab 要跟着换目录，但伪路径不能进 currentPath", () => {
  it("目录 tab 切回去恢复它自己的路径；library tab 不碰 currentPath", () => {
    const dirId = store().openTab("/Users/zifang/Downloads");
    store().openTab("library://main", "library");

    // 打开图书馆后仍显示原目录，不能被 "library://main" 触发一次注定失败的目录加载
    store().switchTab(store().tabs[1].id);
    expect(store().currentPath).toBe("/Users/zifang/Downloads");

    // 中途去了别处，再点回目录 tab —— 这一条在改前是坏的：kind 缺失 ⇒ 永远走 else 臂
    store().setCurrentPath("/tmp");
    store().switchTab(dirId);
    expect(store().currentPath).toBe("/Users/zifang/Downloads");
    expect(activeTabKind()).toBe("directory");
  });
});

describe("closeTab / updateActiveTabPath：其余两处写 tabs 的地方不能漏 kind", () => {
  it("关掉最后一个 tab 后顶上来的 home tab 是目录 tab", () => {
    store().setCurrentPath("/Users/zifang/Movies");
    const libId = store().openTab("library://main", "library");
    store().closeTab(libId);
    expect(store().tabs).toHaveLength(1);
    // 断言 store 里的字段本身，不能只断言 activeTabKind()：App 那边写的是
    // tab?.kind ?? "directory"，缺字段的 tab 也会读出 "directory"，正好把 bug 盖住。
    expect(activeTab()?.kind).toBe("directory");
    expect(activeTabKind()).toBe("directory");
    expect(activeTab()?.path).toBe("/Users/zifang/Movies");
  });

  it("目录 tab 改路径只改 path，kind 原样留着", () => {
    store().openTab("/Users/zifang/Downloads");
    store().updateActiveTabPath("/Users/zifang/Desktop");
    expect(activeTab()).toEqual({
      id: expect.any(String),
      path: "/Users/zifang/Desktop",
      kind: "directory",
    });
  });

  it("图书馆 tab 不接目录路径 —— 否则标签改名、切回去的行为也跟着变", () => {
    const lib = store().openTab("library://main", "library", { libraryKind: "book" });
    store().updateActiveTabPath("/Users/zifang/Desktop");
    expect(store().tabs.find((t) => t.id === lib)).toEqual({
      id: lib,
      path: "library://main",
      kind: "library",
      meta: { libraryKind: "book" },
    });
  });

  it("关中间那个 tab 时，幸存 tab 的 kind 不受影响", () => {
    const a = store().openTab("/Users/zifang/a");
    const lib = store().openTab("library://main", "library");
    const b = store().openTab("/Users/zifang/b");
    store().closeTab(lib);
    expect(store().tabs.map((t) => [t.id, t.kind])).toEqual([
      [a, "directory"],
      [b, "directory"],
    ]);
    // 关的是非激活 tab ⇒ 激活的仍是 b，邻居切换逻辑不该插手
    expect(store().activeTabId).toBe(b);
  });
});

describe("closeTab：关掉当前 tab 后 currentPath 必须跟上邻居", () => {
  // 新建文件 / 粘贴 / 压缩 / ⌘T 的目标目录都是 currentPath。只换 activeTabId 不换
  // currentPath，等于让用户往一个他已经关掉的文件夹里写文件。
  it("关掉激活的目录 tab ⇒ 视图落到邻居目录", () => {
    store().openTab("/Users/zifang/keep");
    const dying = store().openTab("/Users/zifang/dying");
    store().setCurrentPath("/Users/zifang/dying"); // 此刻用户确实在 dying 里
    store().closeTab(dying);
    expect(activeTab()?.path).toBe("/Users/zifang/keep");
    expect(store().currentPath).toBe("/Users/zifang/keep");
  });

  it("邻居是图书馆 tab ⇒ 保留原目录，不能把伪路径写进 currentPath", () => {
    store().openTab("library://main", "library");
    const dl = store().openTab("/Users/zifang/Downloads");
    store().setCurrentPath("/tmp"); // 用户在那个目录 tab 里又去了别处
    store().closeTab(dl);
    expect(activeTabKind()).toBe("library");
    expect(store().currentPath).toBe("/tmp");
  });

  it("关的是别的 tab ⇒ 视图一步都不该动，哪怕剩下的 tab 里有目录", () => {
    const a = store().openTab("/Users/zifang/a");
    const lib = store().openTab("library://main", "library");
    store().openTab("/Users/zifang/b");
    store().switchTab(lib); // 激活图书馆，视图仍停在打开它之前的那个目录
    expect(store().currentPath).toBe("/Users/zifang/Downloads");
    store().closeTab(a); // 关掉的不是当前 tab
    expect(store().activeTabId).toBe(lib);
    expect(store().currentPath).toBe("/Users/zifang/Downloads");
  });
});
