/**
 * EPUB 阅读器的纯逻辑测试。
 *
 * 这些函数在真机上出错时几乎不报错、只表现为"怪"：页数是 n+1 就多一页空白，
 * 进度按章等分就每章末尾跳一下，位置存了页码而不是比例就改完字号跳回开头。
 * 所以每条都按"会怎么错"来写，而不是只测正常路径。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT,
  FONT_STEPS,
  LINE_STEPS,
  MEASURE_STEPS,
  canStepFont,
  chapterWeights,
  estimatePageCount,
  locate,
  normalizeSettings,
  normalizeSpot,
  pageRatio,
  pageTotal,
  progressAt,
  ratioToPage,
  resolveTheme,
  sanitizeChapter,
  stepFont,
  textWeight,
} from "../src/components/epub/readerModel";

describe("字号档位", () => {
  it("逐档升降，走到端点就停住", () => {
    expect(stepFont(16, 1)).toBe(17);
    expect(stepFont(17, -1)).toBe(16);
    expect(stepFont(FONT_STEPS[0], -1)).toBe(FONT_STEPS[0]);
    expect(stepFont(FONT_STEPS[FONT_STEPS.length - 1], 1)).toBe(FONT_STEPS[FONT_STEPS.length - 1]);
  });

  it("档位外的值（手改过的 localStorage）从默认档起步", () => {
    // 不是"原地不动"：否则用户在旧版本里存过 19，A+ 就永远点不动
    expect(stepFont(19, 1)).toBe(stepFont(DEFAULT_FONT, 1));
    expect(stepFont(19, -1)).toBe(stepFont(DEFAULT_FONT, -1));
    expect(stepFont(0, 1)).toBe(stepFont(DEFAULT_FONT, 1));
  });

  it("canStepFont 与 stepFont 结论一致，按钮禁用态才不会骗人", () => {
    expect(canStepFont(FONT_STEPS[0], -1)).toBe(false);
    expect(canStepFont(FONT_STEPS[FONT_STEPS.length - 1], 1)).toBe(false);
    expect(canStepFont(17, 1)).toBe(true);
  });
});

describe("分页计算", () => {
  it("一页就是 pageWidth，不是 pageWidth+gap", () => {
    expect(pageTotal(560, 560, 48)).toBe(1);
  });

  it("n 列时总宽含 n-1 个 gap，反解回来要正好是 n", () => {
    const w = 560;
    const gap = 48;
    for (const n of [1, 2, 3, 7, 20]) {
      const scrollWidth = n * w + (n - 1) * gap;
      expect(pageTotal(scrollWidth, w, gap)).toBe(n);
    }
  });

  it("亚像素误差不能让末尾凭空多一页空白", () => {
    // 浏览器给 scrollWidth 时常有 ±0.5 的偏差，用 ceil 会算出 n+1
    const w = 560;
    const gap = 48;
    expect(pageTotal(3 * w + 2 * gap + 0.4, w, gap)).toBe(3);
    expect(pageTotal(3 * w + 2 * gap - 0.4, w, gap)).toBe(3);
  });

  it("尺寸还没量出来时给 1 页，而不是 0 或 NaN", () => {
    expect(pageTotal(0, 0, 48)).toBe(1);
    expect(pageTotal(100, 0, 48)).toBe(1);
    expect(pageTotal(Number.NaN, 560, 48)).toBe(1);
  });
});

describe("章内页码与比例互转", () => {
  it("单页章节比例恒为 0，不出现 NaN", () => {
    expect(pageRatio(0, 1)).toBe(0);
    expect(ratioToPage(0.7, 1)).toBe(0);
  });

  it("首尾对齐：第 0 页 0%，最后一页 100%", () => {
    expect(pageRatio(0, 10)).toBe(0);
    expect(pageRatio(9, 10)).toBe(1);
    expect(ratioToPage(0, 10)).toBe(0);
    expect(ratioToPage(1, 10)).toBe(9);
  });

  it("往返稳定：换字号重排后仍停在同一处", () => {
    for (const total of [1, 2, 5, 33]) {
      for (const page of [0, 1, Math.floor(total / 2), total - 1]) {
        const ratio = pageRatio(page, total);
        expect(ratioToPage(ratio, total)).toBe(Math.min(page, total - 1));
      }
    }
  });

  it("越界的比例会被夹住，不会算出负页或超末页", () => {
    expect(ratioToPage(-1, 10)).toBe(0);
    expect(ratioToPage(2, 10)).toBe(9);
  });
});

describe("全书进度", () => {
  const weights = [100, 300, 600]; // 共 1000：真实书里每章长短差很多

  it("按字符权重而不是章序号 —— 短章节不会占掉一半进度条", () => {
    // 第 0 章（100/1000）读完只该是 10%
    expect(progressAt(weights, 0, 1)).toBeCloseTo(0.1, 6);
    // 第 1 章读完（100+300）是 40%，不是 2/3
    expect(progressAt(weights, 1, 1)).toBeCloseTo(0.4, 6);
  });

  it("章内按页比例折算", () => {
    expect(progressAt(weights, 2, 0)).toBeCloseTo(0.4, 6);
    expect(progressAt(weights, 2, 0.5)).toBeCloseTo(0.7, 6);
    expect(progressAt(weights, 2, 1)).toBeCloseTo(1, 6);
  });

  it("越界参数夹住，不返回负数或大于 1", () => {
    expect(progressAt(weights, -3, 0)).toBe(0);
    expect(progressAt(weights, 99, 1)).toBe(1);
    expect(progressAt(weights, 0, 5)).toBeCloseTo(0.1, 6);
  });

  it("空书返回 0，不是 NaN", () => {
    expect(progressAt([], 0, 0)).toBe(0);
  });

  it("locate 是 progressAt 的反函数，拖动进度条不会跳章", () => {
    for (const p of [0, 0.05, 0.1, 0.25, 0.4, 0.55, 0.99, 1]) {
      const at = locate(weights, p);
      expect(progressAt(weights, at.chapter, at.ratio)).toBeCloseTo(p, 6);
    }
  });

  it("locate 落点：第 0 章末尾与第 1 章开头相邻而不重叠", () => {
    expect(locate(weights, 0.1)).toEqual({ chapter: 1, ratio: 0 });
    expect(locate(weights, 0.09).chapter).toBe(0);
    expect(locate(weights, 0)).toEqual({ chapter: 0, ratio: 0 });
    expect(locate(weights, 1)).toEqual({ chapter: 2, ratio: 1 });
  });
});

describe("章权重", () => {
  it("剥掉标签再数，标签长度不参与权重", () => {
    expect(textWeight("<p>abc</p>")).toBe(3);
    expect(textWeight("<p class='very-long-class-name'>abc</p>")).toBe(3);
    expect(textWeight("&nbsp;&nbsp;")).toBe(0); // 全空白 trim 成 0
  });

  it("script/style 里的内容不算正文", () => {
    expect(textWeight("<style>p{color:red}</style><p>hi</p>")).toBe(2);
    expect(textWeight("<script>var a=1</script>")).toBe(0);
  });

  it("空章给最小权重 1，否则拖动进度条会跳过它", () => {
    const w = chapterWeights([{ content: "" }, { content: "<p>abc</p>" }]);
    expect(w[0]).toBe(1);
    expect(w[1]).toBe(3);
    expect(locate(w, 0).chapter).toBe(0);
  });
});

describe("正文清洗", () => {
  it("剥掉 <style>：书里一条 body{background} 会染黑整个 app", () => {
    const out = sanitizeChapter("<html><head><style>body{background:#000}</style></head><body><p>hi</p></body></html>");
    expect(out).toBe("<p>hi</p>");
    expect(out).not.toContain("background");
  });

  it("剥掉 script 与内联事件", () => {
    const out = sanitizeChapter('<div><script>alert(1)</script><p onclick="x()">t</p></div>');
    expect(out).not.toContain("script");
    expect(out).not.toContain("onclick");
    expect(out).toContain("<p>t</p>");
  });

  it("只取 body 内部，<title> 不会变成正文里的一行裸文字", () => {
    const out = sanitizeChapter("<html><head><title>第一章</title></head><body><p>x</p></body></html>");
    expect(out).toBe("<p>x</p>");
  });

  it("保留内联 style 属性 —— 大量 EPUB 靠它做首行缩进", () => {
    const out = sanitizeChapter('<p style="text-indent:2em">t</p>');
    expect(out).toContain('style="text-indent:2em"');
  });

  it("空输入返回空串", () => {
    expect(sanitizeChapter("")).toBe("");
  });
});

describe("页数兜底估计", () => {
  it("字越多页越多，且至少 1 页", () => {
    const w = 560;
    const h = 700;
    expect(estimatePageCount("", w, h, 17, 1.7)).toBe(1);
    const one = estimatePageCount("字".repeat(200), w, h, 17, 1.7);
    const two = estimatePageCount("字".repeat(20000), w, h, 17, 1.7);
    expect(two).toBeGreaterThan(one);
  });

  it("字号变大页数变多 —— 兜底也不能给出反向的趋势", () => {
    const text = "字".repeat(20000);
    const small = estimatePageCount(text, 560, 700, 14, 1.7);
    const big = estimatePageCount(text, 560, 700, 22, 1.7);
    expect(big).toBeGreaterThan(small);
  });

  it("尺寸为 0 时返回 1，不抛也不除零", () => {
    expect(estimatePageCount("字".repeat(100), 0, 0, 17, 1.7)).toBe(1);
  });
});

describe("设置归一化", () => {
  it("全空给默认值", () => {
    expect(normalizeSettings(null)).toMatchObject({ fontSize: DEFAULT_FONT, mode: "paged" });
    expect(normalizeSettings(undefined).theme).toBe("auto");
  });

  it("fontSize 为 0 之类的手改值会被拉回合法档位，正文不会消失", () => {
    expect(normalizeSettings({ fontSize: 0 }).fontSize).toBe(DEFAULT_FONT);
    expect(normalizeSettings({ fontSize: 999 }).fontSize).toBe(DEFAULT_FONT);
    expect(normalizeSettings({ fontSize: "18" }).fontSize).toBe(DEFAULT_FONT);
  });

  it("非法主题/模式回落，不把 data-theme 写成 CSS 里不存在的值", () => {
    expect(normalizeSettings({ theme: "purple" }).theme).toBe("auto");
    expect(normalizeSettings({ mode: "pagedx" }).mode).toBe("paged");
  });

  it("合法值原样保留，不会被默认值覆盖", () => {
    const s = normalizeSettings({
      fontSize: 20,
      lineHeight: LINE_STEPS[2],
      measure: MEASURE_STEPS[0],
      theme: "sepia",
      mode: "scroll",
      toc: true,
    });
    expect(s).toEqual({
      fontSize: 20,
      lineHeight: LINE_STEPS[2],
      measure: MEASURE_STEPS[0],
      theme: "sepia",
      mode: "scroll",
      toc: true,
    });
  });
});

describe("阅读位置归一化", () => {
  it("脏数据一律当没用过，回到开头而不是崩", () => {
    expect(normalizeSpot(null)).toBeNull();
    expect(normalizeSpot("x")).toBeNull();
    expect(normalizeSpot({})).toBeNull();
    expect(normalizeSpot({ chapter: -1 })).toBeNull();
    expect(normalizeSpot({ chapter: 1.5 })).toBeNull();
  });

  it("ratio 越界夹住；缺 ratio 当 0（章首），缺 chapter 才作废", () => {
    expect(normalizeSpot({ chapter: 3, ratio: 5 })).toEqual({ chapter: 3, ratio: 1 });
    expect(normalizeSpot({ chapter: 3, ratio: -2 })).toEqual({ chapter: 3, ratio: 0 });
    expect(normalizeSpot({ chapter: 3 })).toEqual({ chapter: 3, ratio: 0 });
  });
});

describe("主题解析", () => {
  it("auto 跟着应用明暗走，落到具体一边", () => {
    expect(resolveTheme("auto", true)).toBe("night");
    expect(resolveTheme("auto", false)).toBe("paper");
  });

  it("手动选的主题不受应用明暗影响", () => {
    expect(resolveTheme("sepia", true)).toBe("sepia");
    expect(resolveTheme("night", false)).toBe("night");
  });
});
