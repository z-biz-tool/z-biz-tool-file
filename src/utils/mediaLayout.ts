/**
 * 媒体库的版式参数：网格最小列宽与列表视图的列宽。
 *
 * 原来这些数字直接写在 MediaGallery 的 style 里（图片 200px、视频 300px），
 * store 里那对 mediaViewMode / mediaGallerySize 因此无处可接 ——
 * 设置存在了，画面却永远是同一档。抽出来当纯函数之后，尺寸这一档才真的能调，
 * 也才能在 node 环境里直接断言（渲染要 DOM，版式数字不用）。
 */
import type { MediaType } from "./mediaType";

export type MediaViewMode = "gallery" | "list";
export type MediaGallerySize = "small" | "medium" | "large";

/** 尺寸档位只作用于网格；音频的"画廊"是单列行，没有可变的列宽 */
const MIN_COLUMN_WIDTH: Record<Exclude<MediaType, "audio">, Record<MediaGallerySize, number>> = {
  image: { small: 120, medium: 200, large: 320 },
  video: { small: 200, medium: 300, large: 440 },
};

/** 档位之间必须真的拉开，否则"小/中/大"是个按了没反应的开关 */
export function gridMinWidth(type: Exclude<MediaType, "audio">, size: MediaGallerySize): number {
  return MIN_COLUMN_WIDTH[type][size];
}

export function gridStyle(type: Exclude<MediaType, "audio">, size: MediaGallerySize) {
  return {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fill, minmax(${gridMinWidth(type, size)}px, 1fr))`,
    gap: 16,
    padding: 16,
  } as const;
}

/** 列表视图的三列：名字吃剩下的宽度，数字列右对齐所以给固定宽 */
export const LIST_COLUMN_WIDTH = { name: "minmax(0, 1fr)", size: 96, date: 112 } as const;

export function listGridStyle() {
  return {
    display: "grid",
    gridTemplateColumns: `${LIST_COLUMN_WIDTH.name} ${LIST_COLUMN_WIDTH.size}px ${LIST_COLUMN_WIDTH.date}px`,
    alignItems: "center" as const,
    gap: 12,
  };
}

/**
 * 尺寸档位什么时候真的有用：只有网格版式才有"列宽"可言 ——
 * 列表三列是按内容排的，音乐馆的画廊本来就是单列行。
 * 开关的禁用态跟着这条判断走，免得出现"按了没反应"的档位。
 */
export function sizeControlEnabled(viewMode: MediaViewMode, type: MediaType): boolean {
  return viewMode === "gallery" && type !== "audio";
}
