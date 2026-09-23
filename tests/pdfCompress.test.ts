import { describe, expect, it } from "vitest";
import {
  compressPercent,
  compressSummary,
  countImageSkips,
  defaultCompressPath,
  docReverted,
  formatSize,
  isDocReverted,
  isImageSkip,
  type CompressReport,
} from "../src/utils/pdfCompress";

const IMAGE_SKIPS = [
  "第 1 页 /Im0：带 /SMask，换掉会丢透明度",
  "第 2 页 /Im1：重编码后没有更小，已保留原图",
];
const REVERTED = "整体重排后反而变大（591 → 595），已按原样输出副本";

const report = (over: Partial<CompressReport> = {}): CompressReport => ({
  original_size: 1000,
  new_size: 500,
  rewritten: 1,
  flated: 2,
  skipped: [],
  ...over,
});

describe("defaultCompressPath", () => {
  it("只替换结尾的 pdf 后缀，大小写都认", () => {
    expect(defaultCompressPath("/a/b/report.pdf")).toBe("/a/b/report-compressed.pdf");
    expect(defaultCompressPath("/a/b/REPORT.PDF")).toBe("/a/b/REPORT-compressed.pdf");
  });

  it("结尾不是 pdf 时不截断原名，只在后面追加", () => {
    expect(defaultCompressPath("/a/report.pdf.bak")).toBe("/a/report.pdf.bak-compressed.pdf");
  });
});

describe("skipped 的两种条目", () => {
  it("整份退回的说明单独归类，其余按张计", () => {
    const skipped = [...IMAGE_SKIPS, REVERTED];
    expect(docReverted({ skipped })).toBe(true);
    expect(countImageSkips({ skipped })).toBe(2);
  });

  it("没有整份说明时一条算一张", () => {
    expect(docReverted({ skipped: IMAGE_SKIPS })).toBe(false);
    expect(countImageSkips({ skipped: IMAGE_SKIPS })).toBe(2);
    expect(countImageSkips({ skipped: [] })).toBe(0);
  });

  it("判断只看整份说明这一条特例，图的原因改字也不会算错", () => {
    expect(isImageSkip("第 9 页 /ImAny：随便改的措辞")).toBe(true);
    expect(isImageSkip(REVERTED)).toBe(false);
    expect(isDocReverted("……已按原样输出副本")).toBe(true);
  });
});

describe("compressPercent", () => {
  it("按实际字节算，四舍五入成整数", () => {
    expect(compressPercent(report())).toBe(50);
    expect(compressPercent({ original_size: 1000, new_size: 966 })).toBe(3);
    expect(compressPercent({ original_size: 1000, new_size: 1000 })).toBe(0);
  });

  it("原大小为 0 时不出现除零", () => {
    expect(compressPercent({ original_size: 0, new_size: 0 })).toBe(0);
  });
});

describe("formatSize", () => {
  it("跨单位边界", () => {
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.00 GB");
  });
});

describe("compressSummary", () => {
  it("整份退回时报 info，并把副本大小说清楚", () => {
    const summary = compressSummary(
      report({ original_size: 591, new_size: 591, rewritten: 0, flated: 0, skipped: [REVERTED] })
    );
    expect(summary.kind).toBe("info");
    expect(summary.text).toContain("已按原样输出副本");
    expect(summary.text).toContain(formatSize(591));
    expect(summary.text).not.toContain("压缩完成");
  });

  it("压动了才报百分比，保持原样的张数跟着 skipped 变", () => {
    const withSkips = compressSummary(
      report({ original_size: 2000, new_size: 1000, skipped: IMAGE_SKIPS })
    );
    expect(withSkips.kind).toBe("success");
    expect(withSkips.text).toContain("50.0%");
    expect(withSkips.text).toContain("2 张保持原样");
    expect(withSkips.text).toContain(formatSize(2000));
    expect(withSkips.text).toContain(formatSize(1000));

    // 数字必须来自报告本身，不能是写死的文案
    const oneLess = compressSummary(report({ original_size: 2000, new_size: 1000 }));
    expect(oneLess.text).not.toBe(withSkips.text);
    expect(oneLess.text).not.toContain("张保持原样");
    expect(compressSummary(report({ original_size: 2000, new_size: 1800 })).text).toContain("10.0%");
  });
});
