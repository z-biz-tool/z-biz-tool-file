/**
 * 图书馆 app 的纯逻辑测试。
 *
 * 这些函数决定「书显示成什么状态」和「点侧栏哪一格查什么」，错一个就是整批书
 * 归错类，而界面上看起来一切正常 —— 所以按边界值逐个钉住，而不是靠手点。
 *
 * 注意 LibraryEntry 的构造：后端 serde 不加 rename_all，字段是 snake_case，
 * 这里也按 snake_case 写，任何一处写成 camelCase 都会在类型层被抓到。
 */
import { describe, expect, it } from "vitest";
import type { Collection, LibraryEntry, LibraryFacets } from "../src/apps/library/libraryClient";
import {
  buildFacetSections,
  extOf,
  formatLabel,
  formatSize,
  groupBySeries,
  progressText,
  readStatusOf,
  resolveReaderKind,
  viewKey,
  viewTitle,
  viewToFilter,
  type LibraryView,
} from "../src/apps/library/facets";

function entry(patch: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: "id",
    item_id: "id",
    kind: "book",
    title: "书名",
    path: "/books/a.pdf",
    author: null,
    series: null,
    series_index: null,
    publisher: null,
    publish_year: null,
    isbn: null,
    tags: [],
    rating: null,
    description: null,
    cover_url: null,
    added_at: 0,
    last_read_at: null,
    read_progress: null,
    collections: [],
    favorite: false,
    format: null,
    file_size: 0,
    modified_at: 0,
    ...patch,
  };
}

describe("阅读状态判定", () => {
  it("没进度 / 进度 0 都是未读", () => {
    expect(readStatusOf({ read_progress: null })).toBe("unread");
    expect(readStatusOf({ read_progress: 0 })).toBe("unread");
  });

  it("刚打开（0.01）算在读，不能算未读", () => {
    // 打开一本书就会写 0.01 表示「在读」，若判定成未读，用户点开又关掉，
    // 书仍留在未读里，看起来像没生效
    expect(readStatusOf({ read_progress: 0.01 })).toBe("reading");
    expect(readStatusOf({ read_progress: 0.5 })).toBe("reading");
  });

  it("0.99 起算读完，覆盖分章进度落不到 1.0 的情况", () => {
    expect(readStatusOf({ read_progress: 0.98 })).toBe("reading");
    expect(readStatusOf({ read_progress: 0.99 })).toBe("finished");
    expect(readStatusOf({ read_progress: 1 })).toBe("finished");
  });
});

describe("阅读器分派", () => {
  it("按扩展名选阅读器", () => {
    expect(resolveReaderKind({ path: "/a/b.pdf", format: null })).toBe("pdf");
    expect(resolveReaderKind({ path: "/a/b.PNG", format: null })).toBe("image");
    expect(resolveReaderKind({ path: "/a/b.md", format: null })).toBe("text");
    expect(resolveReaderKind({ path: "/a/b.cbz", format: null })).toBe("comic");
    // 未知扩展名交给系统打开，不要硬塞给某个阅读器
    expect(resolveReaderKind({ path: "/a/b.doc", format: null })).toBe(null);
  });

  it("整条电子书家族都走同一个书本阅读器", () => {
    // 格式差异在后端 parse_ebook 里消化掉了，前端只需认「这是书」
    for (const ext of ["epub", "mobi", "azw", "azw3", "prc", "fb2", "txt"]) {
      expect(resolveReaderKind({ path: `/a/b.${ext}`, format: null }), ext).toBe("book");
    }
  });

  it("TXT 走书本阅读器而不是等宽预格式", () => {
    // TXT 小说要能分章分页、调字号和书页主题；<pre> 不是读书的形态
    expect(resolveReaderKind({ path: "/a/小说.txt", format: null })).toBe("book");
    // 但代码/结构文本仍用等宽显示，排版成书反而更难读
    expect(resolveReaderKind({ path: "/a/conf.json", format: null })).toBe("text");
    expect(resolveReaderKind({ path: "/a/data.csv", format: null })).toBe("text");
  });

  it("CBR 是 rar 容器，没有解码库，不冒充能读", () => {
    expect(resolveReaderKind({ path: "/a/b.cbr", format: null })).toBe(null);
  });

  it("扩展名与 format 字段不一致时以路径为准", () => {
    // 用户在 Finder 里把 a.txt 改名成 a.epub，扫描时记下的 format 还停在 txt。
    // 这时必须按 .epub 走书本阅读器，否则会拿文本阅读器去解一本真 EPUB
    expect(resolveReaderKind({ path: "/a/x.epub", format: "txt" })).toBe("book");
  });

  it("没有扩展名的路径不崩", () => {
    expect(extOf("/a/Makefile")).toBe("");
    expect(resolveReaderKind({ path: "/a/Makefile", format: null })).toBe(null);
  });

  it("隐藏文件的点号不算扩展名分隔", () => {
    // ".env" 的末位点在开头：那是隐藏标记，不是后缀。当成扩展名会让
    // ".env" 被判定成格式 "env" 出现在侧栏的格式维度里
    expect(extOf("/a/.env")).toBe("");
    expect(extOf("/a/.gitignore")).toBe("");
    expect(extOf("/a/archive.tar.gz")).toBe("gz");
  });
});

describe("格式与体量展示", () => {
  it("格式标签优先用扫描结果，缺失时回落到扩展名并大写", () => {
    expect(formatLabel({ path: "/a/x.pdf", format: "pdf" })).toBe("PDF");
    expect(formatLabel({ path: "/a/x.epub", format: null })).toBe("EPUB");
    expect(formatLabel({ path: "/a/Makefile", format: null })).toBe("未知");
  });

  it("0 与非法值显示成破折号，不显示 0.0 KB", () => {
    expect(formatSize(0)).toBe("—");
    expect(formatSize(Number.NaN)).toBe("—");
    expect(formatSize(-1)).toBe("—");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(12.3 * 1024 * 1024)).toBe("12.3 MB");
  });

  it("进度文案：未开始 / 百分比 / 已读完", () => {
    expect(progressText({ read_progress: null })).toBe("未开始");
    expect(progressText({ read_progress: 0 })).toBe("未开始");
    expect(progressText({ read_progress: 0.456 })).toBe("46%");
    expect(progressText({ read_progress: 0.995 })).toBe("已读完");
  });
});

describe("系列分组", () => {
  it("系列内按卷号升序，缺卷号的排在有卷号的后面", () => {
    const got = groupBySeries([
      entry({ id: "3", title: "第三卷", series: "三体", series_index: 3 }),
      entry({ id: "x", title: "外传", series: "三体", series_index: null }),
      entry({ id: "1", title: "第一卷", series: "三体", series_index: 1 }),
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].items.map((i) => i.id)).toEqual(["1", "3", "x"]);
  });

  it("没有系列的书单独成组排在最后", () => {
    const got = groupBySeries([
      entry({ id: "s", title: "A", series: "某系列", series_index: 1 }),
      entry({ id: "n", title: "散书" }),
    ]);
    expect(got.map((g) => g.series)).toEqual(["某系列", null]);
    expect(got[1].items[0].id).toBe("n");
  });

  it("系列名只有空白等于没有系列", () => {
    const got = groupBySeries([entry({ id: "w", series: "   " })]);
    expect(got).toHaveLength(1);
    expect(got[0].series).toBe(null);
  });

  it("空输入返回空数组", () => {
    expect(groupBySeries([])).toEqual([]);
  });
});

describe("侧栏导航", () => {
  const facets: LibraryFacets = {
    total: 3,
    unread: 1,
    reading: 1,
    finished: 1,
    favorites: 0,
    authors: [{ value: "未标注", count: 2 }],
    publishers: [],
    years: [{ value: "2024", count: 1 }],
    series: [],
    tags: [],
    formats: [{ value: "pdf", count: 3 }],
    collections: [],
  };

  it("空维度不出现在侧栏（作者/出版社这类没有就是没有）", () => {
    const keys = buildFacetSections(facets).map((s) => s.key);
    expect(keys).toEqual(["authors", "years", "formats"]);
    expect(keys).not.toContain("publishers");
  });

  it("浏览位置 → 查询条件", () => {
    expect(viewToFilter({ kind: "all" })).toEqual({});
    expect(viewToFilter({ kind: "status", value: "reading" })).toEqual({ status: "reading" });
    expect(viewToFilter({ kind: "favorites" })).toEqual({ favoritesOnly: true });
    expect(viewToFilter({ kind: "collection", id: "c1" })).toEqual({ collectionId: "c1" });
    expect(viewToFilter({ kind: "facet", field: "author", value: "张三" })).toEqual({
      author: "张三",
    });
  });

  it("搜索词两端空白要丢掉，全空白等于没搜", () => {
    expect(viewToFilter({ kind: "all" }, { search: "  三体  " })).toEqual({ search: "三体" });
    expect(viewToFilter({ kind: "all" }, { search: "   " })).toEqual({});
  });

  it("排序与筛选可以叠加", () => {
    expect(
      viewToFilter({ kind: "status", value: "unread" }, { search: "a", sort: "title" }),
    ).toEqual({ search: "a", sort: "title", status: "unread" });
  });

  it("每个位置的 key 唯一且稳定（Menu 的选中态靠它）", () => {
    const views: LibraryView[] = [
      { kind: "all" },
      { kind: "status", value: "unread" },
      { kind: "favorites" },
      { kind: "collection", id: "c1" },
      { kind: "facet", field: "tag", value: "t" },
    ];
    const keys = views.map(viewKey);
    expect(new Set(keys).size).toBe(views.length);
    expect(keys[0]).toBe("all");
  });

  it("标题能取到图书集名字", () => {
    const cols: Collection[] = [
      { id: "c1", name: "技术书", description: null, color: null, created_at: 0, sort: 0 },
    ];
    expect(viewTitle({ kind: "collection", id: "c1" }, cols)).toBe("技术书");
    expect(viewTitle({ kind: "collection", id: "gone" }, cols)).toBe("图书集");
    expect(viewTitle({ kind: "status", value: "finished" })).toBe("已读");
    expect(viewTitle({ kind: "facet", field: "publisher", value: "某社" })).toBe(
      "出版社 · 某社",
    );
  });
});
