/**
 * 画廊（照片馆 / 视频馆 / 音乐馆）的条目归类。
 *
 * 单独成模块只为了能单测：这条归类之前写在 MediaGallery.tsx 里，而 vitest 只收
 * tests 目录下的 .ts，组件文件碰不到 —— 于是它写错了很久也没人发现（见 toMediaItem 注释）。
 */
import { getFileType, type FileEntry } from "../stores/fileStore";

export type MediaType = "image" | "video" | "audio";

export interface MediaItem {
  path: string;
  name: string;
  type: MediaType;
  thumbnail?: string;
  metadata?: {
    duration?: string;
    resolution?: string;
    size?: number;
    date?: string;
  };
}

/**
 * 目录条目 → 画廊条目；不属于这个画廊（或是个目录）就返回 null。
 *
 * getFileType 返回的是**类别**（"image" / "video" / "audio" / "text" …），不是扩展名。
 * 原先这里拿它去 includes(["jpg","png",…]) —— 两个集合永不相交，三个馆于是恒为
 * "该目录下没有图片文件"。改成直接比类别，顺带把口径和全站统一（.ico/.svg 也算图）。
 */
export function toMediaItem(file: FileEntry, type: MediaType): MediaItem | null {
  if (file.is_dir) return null;
  if (getFileType(file.name) !== type) return null;
  return {
    path: file.path,
    name: file.name,
    type,
    metadata: {
      size: file.size,
      date: new Date(file.modified * 1000).toLocaleDateString(),
    },
  };
}

export function toMediaItems(files: FileEntry[], type: MediaType): MediaItem[] {
  return files
    .map((f) => toMediaItem(f, type))
    .filter((f): f is MediaItem => f !== null);
}
