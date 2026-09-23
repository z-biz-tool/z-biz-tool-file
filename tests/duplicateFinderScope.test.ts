/**
 * 结构性门禁：右键"在这个目录查找重复文件"必须把那个目录带进面板。
 *
 * DuplicateFinder 常驻挂载（靠 open 显隐），而 directory 是 useState(currentPath) 初始化的，
 * 只在 afterOpenChange 里重置 —— 结果是两件不对的事：
 *   1) 右键某个目录打开时，面板里显示的仍是浏览器当前目录，扫描发的是错的 directory；
 *   2) 重置要等开合动画走完才发生，动画那一帧用户看到的是上一次的目录与上一次的分组。
 * 改成开面板的那一刻按 initialPath || currentPath 重置。
 *
 * 这条只能静态查：右键菜单要真实渲染才有行，而隐藏视口里 rc-trigger 的弹层不进帧
 * （.ant-dropdown 停在 slide-up-appear、items 数为 0），驱动不出菜单项，
 * 所以不敢声称"已真机点过"。其余部分（扫描发的 IPC、结果分组）在 dev 页另测。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const PANEL = readFileSync(`${ROOT}/src/components/DuplicateFinder.tsx`, "utf8");
const APP = readFileSync(`${ROOT}/src/App.tsx`, "utf8");

describe("查找重复文件的作用域", () => {
  it("面板收 initialPath，并在 open 那一刻就重置目录/结果/勾选", () => {
    expect(PANEL).toMatch(/initialPath\?:\s*string \| null;/);
    const effect = PANEL.match(/useEffect\(\(\) => \{[\s\S]{0,420}?\}, \[[^\]]*open[^\]]*\]\)/);
    expect(effect, "找不到跟着 open 走的重置 effect").toBeTruthy();
    const body = effect![0];
    expect(body).toContain("setDirectory(initialPath || currentPath)");
    expect(body).toContain("setGroups([])");
    expect(body).toContain("setSelectedPaths(new Set())");
  });

  it("重置不再挂在 afterOpenChange 上（那要等动画结束）", () => {
    expect(PANEL).not.toMatch(/afterOpenChange=\{/);
  });

  it("关面板时把带进来的目录一起清掉", () => {
    expect(APP).toMatch(/setDuplicateFinderOpen\(false\);\s*setDuplicateRoot\(null\)/);
  });
});

/**
 * 右键菜单读的是 selectedFile（`selectedFile ? contextMenuItems(selectedFile) : []`），
 * 而行上原来只挂 onClick/onDoubleClick —— 没点过的行右键弹出来是个 0 项空壳。
 * 实测对照：修之前 .ant-dropdown 里 items=0、textContent 空；修之后 16 项，
 * 点「查找重复文件」开出来的面板目录格就是被右键的那个目录。
 */
describe("右键即选中", () => {
  it("表行与网格/分栏两条视图都把右键接到选中上", () => {
    const row = APP.match(/onRow=\{\(record\) => \(\{[\s\S]{0,320}?\}\)\}/);
    expect(row, "找不到表行的 onRow").toBeTruthy();
    expect(row![0]).toContain("onContextMenu: () => selectForContextMenu(record)");
    const at = APP.indexOf("<GridView");
    expect(at, "找不到 GridView 的用法").toBeGreaterThan(-1);
    expect(APP.slice(at, at + 1500)).toContain("onContextMenu={(entry) => {");
  });

  it("网格那条不许动 selectedRowKeys（目录不该被塞进批量选择）", () => {
    const at = APP.indexOf("onContextMenu={(entry) => {");
    expect(at, "找不到网格的右键处理").toBeGreaterThan(-1);
    expect(APP.slice(at, at + 260)).not.toContain("setSelectedRowKeys");
  });
});
