/**
 * 漫画阅读器（CBZ）。
 *
 * 与书本阅读器的根本差别：**没有文本**。所以不需要字号/行距/版心，取而代之的是
 * 「单页」和「竖向连续」两种模式 —— 单页适合逐格看，连续模式适合快速翻过去找位置。
 *
 * 图片不内联走 IPC：`extract_comic` 把 zip 解到应用数据目录，这里只拿路径，
 * 用 asset 协议交给 WebView 自己加载。一部漫画几十页、单页几百 KB，
 * base64 内联会让一次 invoke 传出几十 MB，界面会直接僵住。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Slider, Tooltip, Typography, theme } from "antd";
import {
  FullscreenExitOutlined,
  FullscreenOutlined,
  LeftOutlined,
  MenuOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ErrorState, LoadingState, useTheme } from "../_shared";

const { Text } = Typography;

interface Props {
  filePath: string;
  fileName: string;
}

type Mode = "paged" | "scroll";

export default function ComicReader({ filePath, fileName }: Props) {
  const { token } = theme.useToken();
  // 主题的 mode 和下面「单页/连续」的 mode 会撞名，取别名
  const { mode: themeMode } = useTheme();
  const isDark = themeMode === "dark";

  const [pages, setPages] = useState<string[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("paged");
  const [immersive, setImmersive] = useState(false);
  const [showBar, setShowBar] = useState(true);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  // ── 加载 ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setPages([]);
    setIndex(0);

    invoke<string[]>("extract_comic", { path: filePath })
      .then((list) => {
        if (cancelled) return;
        setPages(list.map((p) => convertFileSrc(p)));
        setPhase("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setPhase("error");
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const total = pages.length;

  const go = useCallback(
    (next: number) => {
      if (total === 0) return;
      setIndex(Math.max(0, Math.min(total - 1, next)));
    },
    [total],
  );

  // 连续模式里页号由滚动位置反推：图片高度不一致，没法按 total*clientHeight 算
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 2;
    const imgs = el.querySelectorAll<HTMLImageElement>("img[data-page]");
    let found = 0;
    imgs.forEach((img, i) => {
      if (img.offsetTop <= mid) found = i;
    });
    setIndex(found);
  }, []);

  // ── 键盘 ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // 焦点在输入框里时不抢键（图书馆有搜索框）
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        go(index + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        go(index - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        go(0);
      } else if (e.key === "End") {
        e.preventDefault();
        go(total - 1);
      } else if (e.key === "Escape" && immersive) {
        e.preventDefault();
        setImmersive(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, total, immersive]);

  // 单页模式翻页时把图片滚回顶部（长图缩放后可能停在半截）
  useEffect(() => {
    if (mode === "paged") scrollRef.current?.scrollTo({ top: 0 });
  }, [index, mode]);

  // 沉浸模式下 2 秒不动鼠标就把工具条收起来，看着像真阅读器
  const poke = useCallback(() => {
    setShowBar(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShowBar(false), 2000);
  }, []);

  useEffect(() => {
    if (!immersive) {
      setShowBar(true);
      return;
    }
    poke();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [immersive, poke]);

  const percent = total <= 1 ? 0 : Math.round((index / (total - 1)) * 100);
  const pageLabel = useMemo(() => `${index + 1} / ${total}`, [index, total]);

  if (phase === "loading") {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <LoadingState tip={`正在解压 ${fileName}`} />
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <ErrorState message={`这本漫画打不开：${error}`} />
      </div>
    );
  }

  const barVisible = showBar || !immersive;

  return (
    <div
      ref={rootRef}
      onMouseMove={immersive ? poke : undefined}
      style={{
        position: immersive ? "fixed" : "relative",
        inset: immersive ? 0 : undefined,
        zIndex: immersive ? 900 : undefined,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        // 漫画底色用「比正文更暗一档」：亮背景会让人眼被白边吸走
        background: isDark ? token.colorBgContainer : token.colorFillQuaternary,
      }}
    >
      {/* 顶部工具条 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          flexShrink: 0,
          opacity: barVisible ? 1 : 0,
          transition: "opacity 0.2s",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <Text ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }} title={fileName}>
          {fileName}
        </Text>
        <Button
          size="small"
          type={mode === "paged" ? "primary" : "default"}
          onClick={() => setMode("paged")}
          aria-label="单页模式"
        >
          单页
        </Button>
        <Button
          size="small"
          type={mode === "scroll" ? "primary" : "default"}
          onClick={() => setMode("scroll")}
          aria-label="连续模式"
        >
          连续
        </Button>
        <Tooltip title="上一页">
          <Button
            size="small"
            type="text"
            icon={<LeftOutlined />}
            aria-label="上一页"
            disabled={index <= 0}
            onClick={() => go(index - 1)}
          />
        </Tooltip>
        <Text style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", minWidth: 64, textAlign: "center" }}>
          {pageLabel}
        </Text>
        <Tooltip title="下一页">
          <Button
            size="small"
            type="text"
            icon={<RightOutlined />}
            aria-label="下一页"
            disabled={index >= total - 1}
            onClick={() => go(index + 1)}
          />
        </Tooltip>
        <Tooltip title={immersive ? "退出沉浸阅读" : "沉浸阅读"}>
          <Button
            size="small"
            type="text"
            icon={immersive ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            aria-label={immersive ? "退出沉浸阅读" : "沉浸阅读"}
            onClick={() => setImmersive((v) => !v)}
          />
        </Tooltip>
      </div>

      {/* 画面区 */}
      {mode === "paged" ? (
        <div
          ref={scrollRef}
          style={{ flex: 1, minHeight: 0, overflow: "auto", display: "grid", placeItems: "center", padding: 8 }}
        >
          {pages[index] && (
            <img
              key={pages[index]}
              src={pages[index]}
              alt={`第 ${index + 1} 页`}
              data-page={index}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
            />
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 0" }}
        >
          {pages.map((src, i) => (
            <img
              key={src}
              src={src}
              alt={`第 ${i + 1} 页`}
              data-page={i}
              loading={i < 3 ? "eager" : "lazy"}
              style={{ width: "100%", display: "block", marginBottom: 4 }}
            />
          ))}
        </div>
      )}

      {/* 底部进度条：拖动跳页 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "2px 14px 6px",
          flexShrink: 0,
          opacity: barVisible ? 1 : 0,
          transition: "opacity 0.2s",
          background: token.colorBgContainer,
        }}
      >
        <Slider
          style={{ flex: 1, margin: 0 }}
          min={0}
          max={Math.max(total - 1, 0)}
          value={index}
          onChange={go}
          tooltip={{ formatter: (v) => `第 ${(v ?? 0) + 1} 页` }}
        />
        <Text type="secondary" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 34, textAlign: "right" }}>
          {percent}%
        </Text>
      </div>

      {/* 沉浸模式下藏起来的提示：鼠标移上去就回来 */}
      {immersive && !barVisible && (
        <div
          onMouseEnter={() => setShowBar(true)}
          style={{ position: "absolute", top: 0, left: 0, right: 0, height: 28, cursor: "default" }}
        >
          <MenuOutlined style={{ position: "absolute", top: 6, left: 10, fontSize: 12, opacity: 0.35 }} />
        </div>
      )}
    </div>
  );
}
