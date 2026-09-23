/**
 * 画廊归类门禁：toMediaItem 必须按 getFileType 的**类别**分馆。
 *
 * 之前 MediaGallery 里写的是 `["jpg","png",…].includes(getFileType(name))`，
 * 而 getFileType 返回 image/video/… —— 恒 false，照片馆/视频馆/音乐馆三个馆
 * 在任何真实目录下都只显示"该目录下没有图片文件"。这条断言按文件名把三个馆钉死。
 *
 * 用动态 import：fileStore 在模块初始化时就读 localStorage（书签持久化），
 * node 环境没有它，静态 import 会直接 ReferenceError。
 */
// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

type FileEntry = { name: string; path: string; is_dir: boolean; size: number; modified: number };
type MediaType = "image" | "video" | "audio";

let toMediaItem: (file: FileEntry, type: MediaType) => unknown;
let toMediaItems: (files: FileEntry[], type: MediaType) => { name: string; type: MediaType }[];
let mediaDate: (epochSeconds: number) => string;

beforeAll(async () => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  } as unknown as Storage;
  const mod = await import("../src/utils/mediaType");
  toMediaItem = mod.toMediaItem;
  toMediaItems = mod.toMediaItems;
  mediaDate = mod.mediaDate;
});

/** 取本地正午：跨时区不会翻到前一天/后一天，日期断言才是确定的 */
const localNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime() / 1000;

const entry = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `/data/${name}`,
  is_dir: false,
  size: 1024,
  modified: localNoon(2023, 11, 15),
  ...over,
});

describe("mediaDate", () => {
  // 关键不是格式好看，而是不跟宿主 locale 跑：原来 toLocaleDateString() 在
  // 同一个时间戳在中文 locale 下是 2023/11/15、英文 locale 下是 11/15/2023。
  it("固定 YYYY/MM/DD 并补零", () => {
    expect(mediaDate(localNoon(2023, 11, 5))).toBe("2023/11/05");
    expect(mediaDate(localNoon(2024, 1, 1))).toBe("2024/01/01");
  });

  it("坏时间戳不吐出 Invalid Date", () => {
    expect(mediaDate(Number.NaN)).toBe("");
  });
});

describe("toMediaItem", () => {
  it("图片进照片馆，且带得出体积与日期", () => {
    expect(toMediaItem(entry("a.jpg"), "image")).toEqual({
      path: "/data/a.jpg",
      name: "a.jpg",
      type: "image",
      metadata: { size: 1024, date: "2023/11/15" },
    });
  });

  it("三个馆各自收各自的文件", () => {
    expect(toMediaItem(entry("clip.mp4"), "video")).toMatchObject({ type: "video" });
    expect(toMediaItem(entry("song.mp3"), "audio")).toMatchObject({ type: "audio" });
    expect(toMediaItem(entry("song.FLAC"), "audio")).toMatchObject({ type: "audio" });
  });

  // 跨馆必须是 null：照片馆里冒出视频，点开的打开方式与缩略图都是错的
  it("别的馆的文件不收", () => {
    expect(toMediaItem(entry("a.jpg"), "video")).toBeNull();
    expect(toMediaItem(entry("clip.mp4"), "image")).toBeNull();
    expect(toMediaItem(entry("note.txt"), "image")).toBeNull();
    expect(toMediaItem(entry("archive.zip"), "audio")).toBeNull();
  });

  it("目录不收，不看扩展名", () => {
    expect(toMediaItem(entry("photos.jpg", { is_dir: true }), "image")).toBeNull();
  });
});

describe("toMediaItems", () => {
  it("混排目录一次筛干净", () => {
    const files = [entry("photos.jpg", { is_dir: true }), entry("a.jpg"), entry("b.png"), entry("c.txt")];
    expect(toMediaItems(files, "image").map((i) => i.name)).toEqual(["a.jpg", "b.png"]);
  });

  // 口径必须和全站一致：fileStore 认 svg/ico 是图片，画廊就不能偷偷少收两类
  // （少收只会让用户以为文件不在，且没有任何报错）
  it("扩展名口径与 getFileType 一致，不多不少", () => {
    const imageExt = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico"];
    const videoExt = ["mp4", "webm", "ogg", "mov", "avi", "mkv", "m4v"];
    const audioExt = ["mp3", "wav", "flac", "aac", "m4a", "wma"];
    for (const ext of imageExt) expect(toMediaItem(entry(`x.${ext}`), "image"), ext).toMatchObject({ type: "image" });
    for (const ext of videoExt) expect(toMediaItem(entry(`x.${ext}`), "video"), ext).toMatchObject({ type: "video" });
    for (const ext of audioExt) {
      // .ogg 在 fileStore 里先命中视频表，画廊跟着它走，不再自己造一套优先级
      const expectType = ext === "ogg" ? null : "audio";
      const got = toMediaItem(entry(`x.${ext}`), "audio");
      if (expectType) expect(got, ext).toMatchObject({ type: "audio" });
      else expect(got, ext).toBeNull();
    }
  });
});
