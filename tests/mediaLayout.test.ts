/**
 * 媒体库版式参数：store 里那对 viewMode / size 必须真的能改变画面。
 *
 * 之前 200px / 300px 是写死在 MediaGallery 的 style 里的，所以
 * mediaViewMode、mediaGallerySize 连同它们的 setter 全都在 store 里存着却无人读 ——
 * 一个"设置了但永远一个像素都不变"的开关。抽成纯函数之后，这一层可以单独断言：
 * 档位要拉开（否则开关是假的）、尺寸要真的进 gridTemplateColumns（否则是装饰）。
 */
import { describe, expect, it } from "vitest";
import {
  LIST_COLUMN_WIDTH,
  gridMinWidth,
  gridStyle,
  listGridStyle,
  sizeControlEnabled,
  type MediaGallerySize,
} from "../src/utils/mediaLayout";

const SIZES: MediaGallerySize[] = ["small", "medium", "large"];

describe("网格列宽", () => {
  it("三种档位在图片和视频上都必须拉开", () => {
    for (const type of ["image", "video"] as const) {
      const widths = SIZES.map((s) => gridMinWidth(type, s));
      expect(widths[0]).toBeLessThan(widths[1]);
      expect(widths[1]).toBeLessThan(widths[2]);
      // 拉开得够明显，"小/中"在 90vw 的弹窗里才看得出差别
      expect(widths[1] - widths[0]).toBeGreaterThanOrEqual(60);
      expect(widths[2] - widths[1]).toBeGreaterThanOrEqual(60);
    }
  });

  it("钉住默认档，别让人顺手把中档改成 0 宽度", () => {
    expect(gridMinWidth("image", "medium")).toBe(200);
    expect(gridMinWidth("video", "medium")).toBe(300);
  });

  it("档位要真的落到 gridTemplateColumns 上", () => {
    for (const s of SIZES) {
      expect(gridStyle("image", s).gridTemplateColumns).toContain(
        `minmax(${gridMinWidth("image", s)}px, 1fr)`
      );
    }
    // 缺省档必须是 medium —— MediaGallery 的 size 默认值与主列表口径一致
    expect(gridStyle("image", "medium").gridTemplateColumns).toBe(
      "repeat(auto-fill, minmax(200px, 1fr))"
    );
  });
});

describe("列表视图与尺寸开关", () => {
  it("三列：名字吃剩余宽度，数字列固定宽且右对齐", () => {
    expect(LIST_COLUMN_WIDTH.name).toBe("minmax(0, 1fr)");
    expect(LIST_COLUMN_WIDTH.size).toBeGreaterThan(0);
    expect(LIST_COLUMN_WIDTH.date).toBeGreaterThan(0);
    const style = listGridStyle();
    expect(style.gridTemplateColumns).toBe(
      `minmax(0, 1fr) ${LIST_COLUMN_WIDTH.size}px ${LIST_COLUMN_WIDTH.date}px`
    );
  });

  it("尺寸开关只在有网格可调的时候亮着", () => {
    expect(sizeControlEnabled("gallery", "image")).toBe(true);
    expect(sizeControlEnabled("gallery", "video")).toBe(true);
    // 音乐馆的画廊是单列行，没有列宽可言
    expect(sizeControlEnabled("gallery", "audio")).toBe(false);
    // 列表三列按内容排，档位同样无意义
    expect(sizeControlEnabled("list", "image")).toBe(false);
    expect(sizeControlEnabled("list", "audio")).toBe(false);
  });
});
