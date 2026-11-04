/**
 * EPUB 阅读器。
 *
 * 形态对齐「正常阅读器」而不是「分章文本框」：
 * - **分页**：正文用 CSS 多列溢流铺开，一列就是一页，翻页靠整条 track 平移，
 *   不再是一章一个长条让人滚到手指发酸。宽屏一屏一页、窄屏一屏也能读。
 * - **排版可调**：字号 8 档 / 行距 3 档 / 版心 3 档，全部即时生效并记住。
 * - **书页主题**：纸白 / 米黄 / 护眼 / 夜间 / 跟随应用 —— 只换 CSS 变量，不动布局。
 * - **读到哪记住哪**：位置按「章 + 章内比例」存，所以改字号后页面重排仍然停在同一处；
 *   比例而不是页码，因为页数会随字号变。
 * - **键盘与热区**：← → PageUp/PageDown 空格翻页，Home/End 跳到首尾，Esc 退全屏；
 *   两侧留白是点击热区（中间留给选中文字）。
 *
 * 分页位移的几何关系（这几个常量必须一起看，改一个就会露白或截字）：
 *   stage 是取景窗口，宽 pageW + 2*GUTTER；正文流宽 pageW，列间距 GAP；
 *   翻一页平移 pageW + GAP。GAP > 2*GUTTER 才能保证窗口里只看得到当前这一列。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Popover, Slider, Tooltip, Typography, theme } from "antd";
import {
  BgColorsOutlined,
  ColumnHeightOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  LeftOutlined,
  MenuOutlined,
  RightOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useTheme, LoadingState, EmptyState, ErrorState } from "../_shared";
import {
  LINE_LABELS,
  LINE_STEPS,
  MEASURE_LABELS,
  MEASURE_STEPS,
  READER_THEMES,
  canStepFont,
  chapterWeights,
  estimatePageCount,
  loadSettings,
  loadSpot,
  locate,
  pageRatio,
  pageTotal,
  progressAt,
  ratioToPage,
  resolveTheme,
  sanitizeChapter,
  saveSettings,
  saveSpot,
  stepFont,
  type ReaderSettings,
  type ReaderThemeKey,
  type ReadingSpot,
} from "./epub/readerModel";
import "./epub/reader.css";

const { Text } = Typography;

interface Chapter {
  title: string;
  content: string;
  index: number;
}

interface EpubBook {
  title: string;
  author: string;
  chapters: Chapter[];
  cover_path: string;
}

/** 取景窗口左右留白。GAP 必须大于 2*GUTTER，否则下一页的边会漏进视口 */
const GUTTER = 22;
const GAP = 48;
const PAD_Y = 22;

interface EpubReaderProps {
  filePath: string;
  fileName: string;
  /** 阅读位置变化（0..1）。图书馆用它回写阅读进度 */
  onProgress?: (progress: number) => void;
}

export default function EpubReader({ filePath, fileName, onProgress }: EpubReaderProps) {
  const { mode: appMode } = useTheme();
  const { token } = theme.useToken();

  const [book, setBook] = useState<EpubBook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);

  const [chapter, setChapter] = useState(0);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(1);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [instant, setInstant] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [immersive, setImmersive] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 待落位的位置：分页总数要等布局量出来才知道，所以先记下来，测完再套 */
  const pendingSpot = useRef<ReadingSpot | null>(null);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  const chapters = book?.chapters ?? [];
  const weights = useMemo(() => chapterWeights(chapters), [chapters]);

  // ── 载入 ────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setBook(null);
    setChapter(0);
    setPage(0);
    setTotal(1);
    pendingSpot.current = null;

    invoke<EpubBook>("parse_epub", { path: filePath })
      .then((b) => {
        if (!alive) return;
        setBook(b);
        const spot = loadSpot(filePath);
        if (spot && b.chapters.length > 0) {
          // 书可能被替换/重排过，章号越界就退回开头，别停在一片空白上
          const at = Math.min(spot.chapter, b.chapters.length - 1);
          pendingSpot.current = { chapter: at, ratio: spot.ratio };
          setChapter(at);
          if (at > 0) setInstant(true);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError("解析 EPUB 失败：" + (typeof err === "string" ? err : JSON.stringify(err)));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filePath]);

  // ── 设置持久化 ──────────────────────────────────────────
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // ── 视口尺寸 ────────────────────────────────────────────
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const read = (w: number, h: number) => {
      setVp((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    const r = el.getBoundingClientRect();
    read(r.width, r.height);
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) read(box.width, box.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, settings.mode]);

  const ready = vp.w > 0 && vp.h > 0;
  const stageW = ready ? Math.max(120, Math.min(vp.w, settings.measure + GUTTER * 2)) : 0;
  const pageW = Math.max(80, stageW - GUTTER * 2);
  const pageH = ready ? Math.max(120, vp.h - PAD_Y * 2) : 0;
  const step = pageW + GAP;

  const chapterHtml = useMemo(
    () => sanitizeChapter(chapters[chapter]?.content ?? ""),
    [chapters, chapter],
  );
  /** 书里正文常自己带 h1；带了就不再重复渲染章节名 */
  const chapterHasHeading = useMemo(() => /<h[1-3][\s>]/i.test(chapterHtml), [chapterHtml]);

  // ── 量页数 ──────────────────────────────────────────────
  useLayoutEffect(() => {
    if (settings.mode !== "paged" || !ready) return;
    const flow = flowRef.current;
    if (!flow) return;
    const measured = pageTotal(flow.scrollWidth, pageW, GAP);
    // 少数引擎对 overflow:visible 的多列容器不给 scrollWidth（返回 clientWidth），
    // 这时按每页能放多少字反推一个页数，翻页至少还能走，只是页数是个估计值
    const next =
      measured <= 1 && flow.scrollWidth <= pageW + 1
        ? Math.max(1, estimatePageCount(chapters[chapter]?.content ?? "", pageW, pageH, settings.fontSize, settings.lineHeight))
        : measured;
    setTotal(next);
  }, [
    chapter,
    chapterHtml,
    pageW,
    pageH,
    ready,
    settings.mode,
    settings.fontSize,
    settings.lineHeight,
    settings.measure,
    chapters,
  ]);

  // 总数变了就夹住当前页，防止字号调大后停在越界页上（会是一片空白）
  useEffect(() => {
    setPage((p) => (p > total - 1 ? Math.max(0, total - 1) : p));
  }, [total]);

  // ── 落位 ────────────────────────────────────────────────
  useEffect(() => {
    const spot = pendingSpot.current;
    if (!spot || spot.chapter !== chapter) return;
    pendingSpot.current = null;
    if (settings.mode === "paged") {
      setInstant(true);
      setPage(ratioToPage(spot.ratio, total));
    }
  }, [total, chapter, settings.mode]);

  // 瞬时跳转只生效一帧：这一帧不播滑动动画，下一帧恢复
  useLayoutEffect(() => {
    if (!instant) return;
    const id = requestAnimationFrame(() => setInstant(false));
    return () => cancelAnimationFrame(id);
  }, [instant]);

  // ── 进度上报 / 位置记忆 ─────────────────────────────────
  const ratio = pageRatio(page, total);
  useEffect(() => {
    if (!book) return;
    const id = window.setTimeout(() => {
      saveSpot(filePath, { chapter, ratio });
      onProgressRef.current?.(progressAt(weights, chapter, ratio));
    }, 350);
    return () => window.clearTimeout(id);
  }, [book, filePath, chapter, ratio, weights]);

  // ── 翻页/跳转 ───────────────────────────────────────────
  const goChapter = useCallback(
    (idx: number, r: number) => {
      if (idx < 0 || idx >= chapters.length) return;
      setInstant(true);
      pendingSpot.current = { chapter: idx, ratio: r };
      setChapter(idx);
      setPage(0);
      scrollRef.current?.scrollTo({ top: 0 });
    },
    [chapters.length],
  );

  const turn = useCallback(
    (dir: 1 | -1) => {
      if (settings.mode !== "paged") {
        scrollRef.current?.scrollBy({ top: dir * (vp.h || 400) * 0.86, behavior: "smooth" });
        return;
      }
      if (dir === 1) {
        if (page < total - 1) setPage(page + 1);
        else if (chapter < chapters.length - 1) goChapter(chapter + 1, 0);
      } else {
        if (page > 0) setPage(page - 1);
        else if (chapter > 0) goChapter(chapter - 1, 1);
      }
    },
    [settings.mode, page, total, chapter, chapters.length, goChapter, vp.h],
  );

  const patch = useCallback((p: Partial<ReaderSettings>) => {
    setSettings((s) => ({ ...s, ...p }));
  }, []);

  const bumpFont = useCallback((dir: 1 | -1) => {
    setSettings((s) => ({ ...s, fontSize: stepFont(s.fontSize, dir) }));
  }, []);

  // 沉浸模式用「覆盖整个窗口」而不是浏览器 Fullscreen API：
  // Tauri 的 WKWebView 对 element.requestFullscreen 支持很不稳，被拒绝时
  // 按钮点下去毫无反应，比没有这个按钮更让人困惑。position:fixed 一定生效。
  const toggleImmersive = useCallback(() => {
    setImmersive((v) => !v);
  }, []);

  // ── 键盘 ────────────────────────────────────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          bumpFont(1);
        } else if (e.key === "-") {
          e.preventDefault();
          bumpFont(-1);
        }
        return;
      }
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
          e.preventDefault();
          turn(1);
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          turn(-1);
          break;
        case " ":
          // 分页模式才把空格当翻页；滚动模式留给浏览器做"向下翻一屏"
          if (settings.mode === "paged") {
            e.preventDefault();
            turn(e.shiftKey ? -1 : 1);
          }
          break;
        case "ArrowDown":
          if (settings.mode === "paged") {
            e.preventDefault();
            turn(1);
          }
          break;
        case "ArrowUp":
          if (settings.mode === "paged") {
            e.preventDefault();
            turn(-1);
          }
          break;
        case "Home":
          e.preventDefault();
          goChapter(0, 0);
          break;
        case "End":
          e.preventDefault();
          goChapter(chapters.length - 1, 1);
          break;
        case "Escape":
          if (immersive) toggleImmersive();
          break;
        default:
          break;
      }
    },
    [bumpFont, turn, goChapter, chapters.length, settings.mode, immersive, toggleImmersive],
  );

  // 挂载后把焦点放到阅读区，键盘翻页才生效；又不抢全局快捷键（只有焦点在内时才响应）
  useEffect(() => {
    if (!loading && book) viewportRef.current?.focus({ preventScroll: true });
  }, [loading, book, chapter]);

  // ── 渲染 ────────────────────────────────────────────────
  if (loading) return <LoadingState tip="正在解析 EPUB…" minHeight={300} />;

  if (error) {
    return (
      <div className="epub-fallback">
        <ErrorState message={error} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {fileName}
        </Text>
      </div>
    );
  }

  if (!book || chapters.length === 0) {
    return <EmptyState title="这本书没有内容" description="没能从 EPUB 里提取到正文" />;
  }

  const resolvedTheme = resolveTheme(settings.theme, appMode === "dark");
  const progress = scrub !== null ? scrub : progressAt(weights, chapter, ratio);
  const currentTitle = chapters[chapter]?.title || `第 ${chapter + 1} 章`;

  const themePanel = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, width: 168 }}>
      {READER_THEMES.map((t) => {
        const active = settings.theme === t.key;
        return (
          <button
            key={t.key}
            type="button"
            aria-label={`书页主题：${t.label}`}
            aria-pressed={active}
            onClick={() => patch({ theme: t.key as ReaderThemeKey })}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              padding: 4,
              borderRadius: 6,
              cursor: "pointer",
              background: active ? token.colorPrimaryBg : "transparent",
              border: `1px solid ${active ? token.colorPrimary : token.colorBorderSecondary}`,
            }}
          >
            <span
              data-swatch={t.key}
              className="epub-swatch"
              style={{ width: 44, height: 26, borderRadius: 4, display: "block" }}
            />
            <span style={{ fontSize: 11, color: token.colorTextSecondary }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );

  const typePanel = (
    <div style={{ width: 196 }}>
      <div style={{ fontSize: 11, color: token.colorTextSecondary, marginBottom: 4 }}>版心宽度</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {MEASURE_STEPS.map((m, i) => {
          const label = MEASURE_LABELS[i];
          return (
            <Button
              key={m}
              size="small"
              type={settings.measure === m ? "primary" : "default"}
              onClick={() => patch({ measure: m })}
              style={{ flex: 1, fontSize: 11 }}
            >
              {label}
            </Button>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: token.colorTextSecondary, marginBottom: 4 }}>行距</div>
      <div style={{ display: "flex", gap: 6 }}>
        {LINE_STEPS.map((l, i) => {
          const label = LINE_LABELS[i];
          return (
            <Button
              key={l}
              size="small"
              type={settings.lineHeight === l ? "primary" : "default"}
              onClick={() => patch({ lineHeight: l })}
              style={{ flex: 1, fontSize: 11 }}
            >
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div
      className={immersive ? "epub-reader epub-reader--immersive" : "epub-reader"}
      data-theme={resolvedTheme}
      onKeyDown={onKeyDown}
    >
      {/* 工具条 */}
      <div className="epub-bar">
        <div className="epub-bar__group">
          <Tooltip title={`目录（${chapters.length} 章）`}>
            <Button
              className="epub-icon-btn"
              type="text"
              size="small"
              aria-label="切换目录"
              aria-pressed={settings.toc}
              icon={<MenuOutlined />}
              onClick={() => patch({ toc: !settings.toc })}
            />
          </Tooltip>
        </div>

        <div className="epub-bar__title">
          <strong title={book.title || fileName}>{book.title || fileName}</strong>
          <span>{book.author || "未知作者"}</span>
        </div>

        <div className="epub-bar__group">
          <Button
            type="text"
            size="small"
            aria-label="缩小字号"
            disabled={!canStepFont(settings.fontSize, -1)}
            onClick={() => bumpFont(-1)}
            style={{ fontSize: 11, padding: "0 4px" }}
          >
            A-
          </Button>
          <span className="epub-fontsize">{settings.fontSize}</span>
          <Button
            type="text"
            size="small"
            aria-label="放大字号"
            disabled={!canStepFont(settings.fontSize, 1)}
            onClick={() => bumpFont(1)}
            style={{ fontSize: 13, padding: "0 4px" }}
          >
            A+
          </Button>
          <Popover content={typePanel} trigger="click" placement="bottomRight">
            <Button
              className="epub-icon-btn"
              type="text"
              size="small"
              aria-label="排版设置"
              icon={<ColumnHeightOutlined />}
            />
          </Popover>
          <Popover content={themePanel} trigger="click" placement="bottomRight">
            <Button
              className="epub-icon-btn"
              type="text"
              size="small"
              aria-label="书页主题"
              icon={<BgColorsOutlined />}
            />
          </Popover>
          <Tooltip title={settings.mode === "paged" ? "切换为滚动阅读" : "切换为翻页阅读"}>
            <Button
              className="epub-icon-btn"
              type="text"
              size="small"
              aria-label={settings.mode === "paged" ? "切换为滚动阅读" : "切换为翻页阅读"}
              icon={<SwapOutlined />}
              onClick={() => patch({ mode: settings.mode === "paged" ? "scroll" : "paged" })}
            />
          </Tooltip>
          <Tooltip title={immersive ? "退出沉浸阅读" : "沉浸阅读"}>
            <Button
              className="epub-icon-btn"
              type="text"
              size="small"
              aria-label={immersive ? "退出沉浸阅读" : "沉浸阅读"}
              icon={immersive ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={toggleImmersive}
            />
          </Tooltip>
        </div>
      </div>

      <div className="epub-body">
        {settings.toc && (
          <nav className="epub-toc" aria-label="目录">
            <div className="epub-toc__head">目录 · {chapters.length} 章</div>
            {chapters.map((ch, i) => (
              <button
                key={`${i}-${ch.title}`}
                type="button"
                className={`epub-toc__item${i === chapter ? " epub-toc__item--active" : ""}`}
                title={ch.title}
                onClick={() => goChapter(i, 0)}
              >
                {ch.title || `第 ${i + 1} 章`}
              </button>
            ))}
          </nav>
        )}

        <div className="epub-main">
          {settings.mode === "paged" ? (
            <div
              className="epub-viewport"
              ref={viewportRef}
              tabIndex={0}
              role="group"
              aria-label="正文"
            >
              <button
                type="button"
                className="epub-hit epub-hit--l"
                aria-label="上一页"
                disabled={page === 0 && chapter === 0}
                onClick={() => turn(-1)}
              />
              <button
                type="button"
                className="epub-hit epub-hit--r"
                aria-label="下一页"
                disabled={page >= total - 1 && chapter >= chapters.length - 1}
                onClick={() => turn(1)}
              />

              {ready && (
                <div className="epub-stage" style={{ width: stageW, height: pageH }}>
                  <div
                    className={`epub-track${instant ? " epub-track--instant" : ""}`}
                    style={{ transform: `translateX(${-page * step}px)` }}
                  >
                    <div
                      ref={flowRef}
                      className="epub-flow"
                      style={{
                        width: pageW,
                        height: pageH,
                        columnWidth: pageW,
                        columnGap: GAP,
                        fontSize: settings.fontSize,
                        lineHeight: settings.lineHeight,
                      }}
                    >
                      {!chapterHasHeading && (
                        <div className="epub-chapter-mark">{currentTitle}</div>
                      )}
                      {/* 正文来自用户本地 EPUB：已剥掉 <style>/<link>/<script>/on* 属性，
                          否则书里一条 body{background} 会把整个 app 染黑（innerHTML 里的
                          <style> 是作用于整篇文档的）。 */}
                      <div dangerouslySetInnerHTML={{ __html: chapterHtml }} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="epub-scroll" ref={scrollRef} tabIndex={0} role="group" aria-label="正文">
              <article
                className="epub-flow"
                style={{
                  maxWidth: settings.measure,
                  fontSize: settings.fontSize,
                  lineHeight: settings.lineHeight,
                }}
              >
                {!chapterHasHeading && <div className="epub-chapter-mark">{currentTitle}</div>}
                <div dangerouslySetInnerHTML={{ __html: chapterHtml }} />
              </article>
            </div>
          )}

          {/* 页脚：上一页/下一页 + 全书进度 + 页码 */}
          <div className="epub-foot">
            <Tooltip title="上一页（←）">
              <Button
                className="epub-icon-btn"
                type="text"
                size="small"
                aria-label="上一页"
                disabled={settings.mode === "paged" ? page === 0 && chapter === 0 : chapter === 0}
                icon={<LeftOutlined />}
                onClick={() => (settings.mode === "paged" ? turn(-1) : goChapter(chapter - 1, 0))}
              />
            </Tooltip>
            <Slider
              min={0}
              max={1000}
              value={Math.round(progress * 1000)}
              onChange={(v) => setScrub(v / 1000)}
              onChangeComplete={(v) => {
                const at = locate(weights, v / 1000);
                goChapter(at.chapter, at.ratio);
                setScrub(null);
              }}
              tooltip={{ formatter: () => `${(progress * 100).toFixed(1)}%` }}
              style={{ flex: 1, minWidth: 60 }}
            />
            <Tooltip title="下一页（→）">
              <Button
                className="epub-icon-btn"
                type="text"
                size="small"
                aria-label="下一页"
                disabled={
                  settings.mode === "paged"
                    ? page >= total - 1 && chapter >= chapters.length - 1
                    : chapter >= chapters.length - 1
                }
                icon={<RightOutlined />}
                onClick={() => (settings.mode === "paged" ? turn(1) : goChapter(chapter + 1, 0))}
              />
            </Tooltip>
            <span className="epub-foot__label">
              {settings.mode === "paged"
                ? `${page + 1}/${total} · ${(progress * 100).toFixed(1)}%`
                : `${chapter + 1}/${chapters.length} 章 · ${(progress * 100).toFixed(1)}%`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
