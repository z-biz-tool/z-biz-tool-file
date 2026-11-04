/**
 * EPUB 阅读器的纯逻辑层：档位、进度换算、位置记忆、分页计算。
 *
 * 抽出来的原因很具体 —— 这些是阅读器里唯一能在 node 环境下验证的部分
 * （样式要真浏览器、翻页要真布局），而它们恰好也是最容易算错的地方：
 * 全书进度按"章序号"算会让每章末尾的百分比跳得莫名其妙，
 * 按"字符权重"算才跟真实阅读器一致。
 */

// ───────────────────────── 排版档位 ─────────────────────────

/** 字号档位（px）。首尾有边界，所以 A- / A+ 到端点要禁用而不是继续加。 */
export const FONT_STEPS = [13, 14, 15, 16, 17, 18, 20, 22] as const;
export const DEFAULT_FONT = 17;

export function stepFont(current: number, dir: 1 | -1): number {
  const at = FONT_STEPS.indexOf(current as (typeof FONT_STEPS)[number]);
  // 存量设置里可能是任意值（早期版本、手改过的 localStorage），
  // 都不在档位里时从默认档起步，避免卡死在 -1 上不动
  const base = at < 0 ? FONT_STEPS.indexOf(DEFAULT_FONT as (typeof FONT_STEPS)[number]) : at;
  const next = Math.min(FONT_STEPS.length - 1, Math.max(0, base + dir));
  return FONT_STEPS[next];
}

export function canStepFont(current: number, dir: 1 | -1): boolean {
  return stepFont(current, dir) !== current;
}

/** 行距档位：只有三档，够用且不会让人纠结 0.05 的差别 */
export const LINE_STEPS = [1.5, 1.7, 1.9] as const;
export const LINE_LABELS = ["紧凑", "标准", "宽松"] as const;

/** 版心宽度（px）：窄屏读得快、宽屏读得舒服 */
export const MEASURE_STEPS = [560, 660, 780] as const;
export const MEASURE_LABELS = ["窄", "中", "宽"] as const;

export type ReaderMode = "paged" | "scroll";
export type ReaderThemeKey = "paper" | "sepia" | "green" | "night" | "auto";

export const READER_THEMES: ReadonlyArray<{ key: ReaderThemeKey; label: string }> = [
  { key: "auto", label: "跟随应用" },
  { key: "paper", label: "纸白" },
  { key: "sepia", label: "米黄" },
  { key: "green", label: "护眼" },
  { key: "night", label: "夜间" },
];

/** `auto` 不是真的主题，只是"交给应用的明暗" —— 落到具体两边之一 */
export function resolveTheme(theme: ReaderThemeKey, isDarkApp: boolean): Exclude<ReaderThemeKey, "auto"> {
  if (theme === "auto") return isDarkApp ? "night" : "paper";
  return theme;
}

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  measure: number;
  theme: ReaderThemeKey;
  mode: ReaderMode;
  toc: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: DEFAULT_FONT,
  lineHeight: 1.7,
  measure: 660,
  theme: "auto",
  mode: "paged",
  toc: false,
};

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/**
 * 把 localStorage 里可能残缺/越界/类型不对的设置收敛成合法值。
 * 不做这层的话，一条手改的 `{"fontSize": 0}` 会让正文彻底消失，且不报错。
 */
export function normalizeSettings(raw: unknown): ReaderSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const font = typeof r.fontSize === "number" && Number.isFinite(r.fontSize)
    ? oneOf(r.fontSize, FONT_STEPS, DEFAULT_FONT)
    : DEFAULT_FONT;
  const line = typeof r.lineHeight === "number" && Number.isFinite(r.lineHeight)
    ? oneOf(r.lineHeight, LINE_STEPS, DEFAULT_SETTINGS.lineHeight)
    : DEFAULT_SETTINGS.lineHeight;
  const measure = typeof r.measure === "number" && Number.isFinite(r.measure)
    ? oneOf(r.measure, MEASURE_STEPS, DEFAULT_SETTINGS.measure)
    : DEFAULT_SETTINGS.measure;
  return {
    fontSize: font,
    lineHeight: line,
    measure,
    theme: oneOf<ReaderThemeKey>(
      r.theme,
      READER_THEMES.map((t) => t.key),
      DEFAULT_SETTINGS.theme,
    ),
    mode: oneOf<ReaderMode>(r.mode, ["paged", "scroll"], DEFAULT_SETTINGS.mode),
    toc: typeof r.toc === "boolean" ? r.toc : DEFAULT_SETTINGS.toc,
  };
}

// ───────────────────────── 进度 ─────────────────────────

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** 去掉标签与实体后按字符数计权重：粗但足够，且不需要解析 DOM */
export function textWeight(html: string): number {
  if (!html) return 0;
  const plain = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z]+;/gi, "x")
    .trim();
  return plain.length;
}

export function chapterWeights(chapters: ReadonlyArray<{ content: string }>): number[] {
  // 空章给 1 而不是 0：否则它下面所有章的"起点"重合，拖动进度条会跳过它
  return chapters.map((c) => Math.max(1, textWeight(c.content)));
}

/**
 * 全书进度（0..1）：前面各章整章计入 + 当前章按页内比例折算。
 * 用章节等分（(i+ratio)/n）会让 30 章的书在每章末尾都跳 3%，观感很假。
 */
export function progressAt(weights: readonly number[], chapter: number, ratio: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const idx = Math.min(Math.max(0, chapter), Math.max(0, weights.length - 1));
  let before = 0;
  for (let i = 0; i < idx; i += 1) before += weights[i] ?? 0;
  const cur = weights[idx] ?? 0;
  return clamp01((before + cur * clamp01(ratio)) / total);
}

/** progressAt 的反函数：拖动进度条 → 落到哪一章的哪个比例 */
export function locate(weights: readonly number[], progress: number): { chapter: number; ratio: number } {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || weights.length === 0) return { chapter: 0, ratio: 0 };
  const target = clamp01(progress) * total;
  let acc = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i];
    const end = acc + w;
    if (target < end || i === weights.length - 1) {
      return { chapter: i, ratio: w > 0 ? clamp01((target - acc) / w) : 0 };
    }
    acc = end;
  }
  return { chapter: weights.length - 1, ratio: 1 };
}

// ───────────────────────── 正文清洗 ─────────────────────────

/**
 * 只留 <body> 里的正文，并把会逃出容器作用域的东西剥掉。
 *
 * 这不是"防君子"式的净化，是修一个真实事故路径：`dangerouslySetInnerHTML` 里的
 * `<style>` 是插入到**当前文档**的，一本 EPUB 只要写了 `body { background:#000 }`，
 * 整个文件管理器会跟着变黑，而且刷新前不会恢复。`<script>` 和 `on*=` 内联事件
 * 同理，所以一并去掉；内联 `style="..."` 保留 —— 它作用在元素自己身上，
 * 大量 EPUB 靠它做首行缩进，删了排版会明显变差。
 */
export function sanitizeChapter(html: string): string {
  if (!html) return "";
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  const body = out.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (body) out = body[1];
  // 头部残留（<head> 被解析器丢弃但内容会留下，比如 <title> 会变成一段裸文字）
  out = out.replace(/<head[\s\S]*?<\/head>/gi, "");
  out = out.replace(/<title[\s\S]*?<\/title>/gi, "");
  return out.trim();
}

// ───────────────────────── 分页 ─────────────────────────

/**
 * 页数兜底估计：给拿不到 scrollWidth 的引擎用。
 *
 * 中文全角字约等于一个字号宽，所以每行字数 ≈ 版心宽 / 字号；
 * 行数 ≈ 版心高 / (字号 × 行距)；乘 0.92 留出段间距与标题的余量。
 * 只在精确测量失效时才走这条路，页数是个估计值（翻页仍可用）。
 */
export function estimatePageCount(
  html: string,
  pageWidth: number,
  pageHeight: number,
  fontSize: number,
  lineHeight: number,
): number {
  // 布局还没量出来（或参数异常）时不能按面积算 —— 除出来的每页容量会退化成 1 个字，
  // 于是 10 万字的书"估计"出 10 万页，进度条和页码全乱。这种情况直接给 1 页。
  if (!(pageWidth > 0) || !(pageHeight > 0) || !(fontSize > 0) || !(lineHeight > 0)) return 1;
  const chars = textWeight(html);
  const perLine = Math.max(1, Math.floor(pageWidth / fontSize));
  const lines = Math.max(1, Math.floor(pageHeight / (fontSize * lineHeight)));
  const perPage = Math.max(1, Math.floor(perLine * lines * 0.92));
  return Math.max(1, Math.ceil(chars / perPage));
}

/**
 * 多列溢流的列数 = 页数。
 *
 * 为什么是 `+gap`：n 列时总宽 = n*pageW + (n-1)*gap，
 * 反过来解 n 就是 (scrollWidth + gap) / (pageW + gap)。用 round 而不是 ceil ——
 * 浏览器给 scrollWidth 的亚像素误差会让正常 n 页算出 n+1，末尾凭空多一页空白。
 */
export function pageTotal(scrollWidth: number, pageWidth: number, gap: number): number {
  if (!(pageWidth > 0) || !(scrollWidth > 0)) return 1;
  return Math.max(1, Math.round((scrollWidth + gap) / (pageWidth + gap)));
}

/** 页序号 → 章内比例；total 为 1 时恒为 0（否则会除以 0 得到 NaN） */
export function pageRatio(page: number, total: number): number {
  if (total <= 1) return 0;
  return clamp01(page / (total - 1));
}

/** 章内比例 → 页序号，用于字号/窗口变化后仍停在同一处 */
export function ratioToPage(ratio: number, total: number): number {
  if (total <= 1) return 0;
  return Math.min(total - 1, Math.max(0, Math.round(clamp01(ratio) * (total - 1))));
}

// ───────────────────────── 位置记忆 ─────────────────────────

export interface ReadingSpot {
  chapter: number;
  ratio: number;
}

export function normalizeSpot(raw: unknown): ReadingSpot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const chapter = typeof r.chapter === "number" && Number.isInteger(r.chapter) && r.chapter >= 0
    ? r.chapter
    : null;
  const ratio = typeof r.ratio === "number" && Number.isFinite(r.ratio) ? clamp01(r.ratio) : null;
  if (chapter === null) return null;
  return { chapter, ratio: ratio ?? 0 };
}

const SETTINGS_KEY = "z-epub-reader-settings";
const spotKey = (path: string) => `z-epub-reader-spot:${path}`;

const canStore = () => typeof localStorage !== "undefined";

export function loadSettings(): ReaderSettings {
  if (!canStore()) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: ReaderSettings): void {
  if (!canStore()) return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // 隐私模式 / 配额满：记不住排版不影响读，静默放弃
  }
}

export function loadSpot(path: string): ReadingSpot | null {
  if (!canStore() || !path) return null;
  try {
    return normalizeSpot(JSON.parse(localStorage.getItem(spotKey(path)) ?? "null"));
  } catch {
    return null;
  }
}

export function saveSpot(path: string, spot: ReadingSpot): void {
  if (!canStore() || !path) return;
  try {
    localStorage.setItem(spotKey(path), JSON.stringify(spot));
  } catch {
    // 同上
  }
}
