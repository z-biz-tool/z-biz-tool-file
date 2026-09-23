/**
 * 结构性门禁：右键"图片编辑"必须真的把编辑器开起来。
 *
 * 之前这一项只是弹一句 message.info("请使用工具栏 [OCR] 进入图片编辑")：
 * OCR 面板里没有图片编辑，而默认的表格视图 + 右侧预览也没有任何进编辑态的按钮
 * （只有分栏视图的 tab 栏有）。ImageEditor 本身是完整的（裁剪/旋转/滤镜/导出，
 * 后端 get_image_info / save_image_data / export_image 等也都注册着），缺的只是入口。
 *
 * 静态查的原因：编辑器要在 img 真能加载时才建 canvas，而 dev 浏览器里 convertFileSrc
 * 给的是 asset: 地址（只有 Tauri 壳里解得开），画布这条链在浏览器里驱动不了；
 * 已实测到的部分是"右键 → 编辑器挂起来、顶栏有文件名与导出按钮"（dev 页 + stub invoke）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const APP = readFileSync(`${ROOT}/src/App.tsx`, "utf8");
const PREVIEW = readFileSync(`${ROOT}/src/components/FileContentPreview.tsx`, "utf8");
const PANE = readFileSync(`${ROOT}/src/components/PreviewPane.tsx`, "utf8");

describe("图片编辑的入口", () => {
  it("右键项不再只弹提示，而是选中该图并把预览推进编辑态", () => {
    const entry = APP.match(/key: "image-editor"[\s\S]{0,600}?\}\]/);
    expect(entry, "找不到图片编辑入口").toBeTruthy();
    const body = entry![0];
    expect(body).not.toContain("message.info");
    for (const call of ["setSelectedFile(record)", "setPreviewVisible(true)", "setPreviewEditImage(true)"]) {
      expect(body, `入口少了 ${call}`).toContain(call);
    }
  });

  it("预览面板的编辑态由 App 持有，且换选中项会退出编辑", () => {
    expect(APP).toMatch(/const \[previewEditImage, setPreviewEditImage\] = useState\(false\)/);
    expect(APP).toMatch(/editingImage=\{previewEditImage\}/);
    expect(APP).toMatch(/useEffect\(\(\) => \{\s*setPreviewEditImage\(false\);\s*\}, \[selectedFile\?\.path\]\)/);
  });

  it("预览顶栏自己有「编辑图片」按钮（默认视图不再只有分栏能编辑）", () => {
    expect(PREVIEW).toMatch(/fileType === "image" && !editingImage/);
    expect(PREVIEW).toMatch(/aria-label="编辑图片"/);
    expect(PREVIEW).toContain("setEditingImage(true)");
  });

  it("PreviewPane 把三个口子透到 FileContentPreview，而不是吞掉", () => {
    expect(PANE).toMatch(/editingImage=\{editingImage\}/);
    expect(PANE).toMatch(/onEditImage=\{onEditImage\}/);
    expect(PANE).toMatch(/onExitEditImage=\{onExitEditImage\}/);
  });
});
