/**
 * resolveOpen / resolveRenameTarget 单测。
 *
 * 钉的是"双击/Enter 到底作用在谁身上"这条规则。它此前散落在四处 JSX 里，
 * 其中三处写成了 `record.is_dir && navigateTo(...)` —— 于是双击文件什么都不发生，
 * 而双面板视图却是正确的。规则收进来之后，改错一次就会被这里炸到。
 */
import { describe, expect, it } from "vitest";
import {
  lastExtension,
  openRejectText,
  resolveOpen,
  resolveRenameTarget,
  type OpenableEntry,
} from "../src/utils/openBehavior";

const file = (path = "/tmp/a.pdf", name = "a.pdf"): OpenableEntry => ({
  path,
  name,
  is_dir: false,
});
const dir = (path = "/tmp/sub", name = "sub"): OpenableEntry => ({ path, name, is_dir: true });

/** 后端 `archive_open_extensions` 的一个代表性切片。真实清单只存在于 format.rs 里。 */
const ARCHIVE_EXTS = ["zip", "7z", "rar", "tar", "gz", "bz2", "xz", "zst", "cab", "001"];

describe("resolveOpen", () => {
  it("目录是进入，不是交给系统 open", () => {
    expect(resolveOpen([dir()], ARCHIVE_EXTS)).toEqual({ kind: "navigate", path: "/tmp/sub" });
  });

  it("文件交给默认应用 —— 这条以前在主表格里根本不存在", () => {
    expect(resolveOpen([file()], ARCHIVE_EXTS)).toEqual({ kind: "open-app", path: "/tmp/a.pdf" });
  });

  it("压缩包进归档浏览器，不再交给系统（那通常等于用 7-Zip 打开）", () => {
    expect(resolveOpen([file("/d/movie.rar", "movie.rar")], ARCHIVE_EXTS)).toEqual({
      kind: "open-archive",
      path: "/d/movie.rar",
    });
  });

  it("复合后缀靠最后一段命中，不必穷举 .tar.gz / .zip.001", () => {
    expect(resolveOpen([file("/d/x.tar.gz", "x.tar.gz")], ARCHIVE_EXTS).kind).toBe("open-archive");
    expect(resolveOpen([file("/d/x.zip.001", "x.zip.001")], ARCHIVE_EXTS).kind).toBe("open-archive");
    expect(resolveOpen([file("/d/X.ZIP", "X.ZIP")], ARCHIVE_EXTS).kind).toBe("open-archive");
  });

  it("扩展名表是调用方传的：漏传就等于没有压缩包路由，所以不给默认值", () => {
    expect(resolveOpen([file("/d/movie.rar", "movie.rar")], []).kind).toBe("open-app");
  });

  it("目录永远优先于扩展名：名叫 photos.zip 的文件夹该进去，不该被当成压缩包", () => {
    expect(resolveOpen([dir("/d/photos.zip", "photos.zip")], ARCHIVE_EXTS).kind).toBe("navigate");
  });

  it("没选中要给原因，而不是静默无反应", () => {
    expect(resolveOpen([], ARCHIVE_EXTS)).toEqual({ kind: "none", reason: "empty" });
    expect(openRejectText("empty")).toContain("选中");
  });

  it("多选不去逐个打开（一次 Enter 弹几十个外部应用窗口是事故）", () => {
    expect(
      resolveOpen([file(), dir(), file("/tmp/b.txt", "b.txt")], ARCHIVE_EXTS),
    ).toEqual({
      kind: "none",
      reason: "multi",
    });
    expect(openRejectText("multi")).toContain("一次只能打开一项");
  });

  it("多选里含目录也不能误判成进入目录", () => {
    // 早先的写法是 entries.find(is_dir)，选中最多的时候会"看起来能打开"却跳错地方
    expect(resolveOpen([dir(), file()], ARCHIVE_EXTS).kind).toBe("none");
  });

  it("多选里全是压缩包也一样拒绝：一次 Enter 开出十几个浏览窗口同样是事故", () => {
    expect(
      resolveOpen([file("/d/a.zip", "a.zip"), file("/d/b.7z", "b.7z")], ARCHIVE_EXTS).kind,
    ).toBe("none");
  });
});

describe("lastExtension", () => {
  it("取最后一段并转小写", () => {
    expect(lastExtension("movie.TAR.GZ")).toBe("gz");
    expect(lastExtension("a.zip")).toBe("zip");
  });

  it("没有点、或点是首字符时返回空串", () => {
    expect(lastExtension("Makefile")).toBe("");
    // ".gitignore" 整个是文件名，当成扩展名 "gitignore" 会让它撞上任何同名后缀规则
    expect(lastExtension(".gitignore")).toBe("");
    expect(lastExtension("")).toBe("");
  });
});

describe("resolveRenameTarget", () => {
  it("目录同样可以重命名（旧的 Enter 分支用 !is_dir 把文件夹排除了）", () => {
    expect(resolveRenameTarget([dir()])).toEqual(dir());
  });

  it("恰好一项才给目标", () => {
    expect(resolveRenameTarget([])).toBeNull();
    expect(resolveRenameTarget([file(), file("/tmp/b.txt", "b.txt")])).toBeNull();
  });

  it("返回的是那一项本身，路径与名字都取自选中项", () => {
    const target = resolveRenameTarget([file("/srv/report.xlsx", "report.xlsx")]);
    expect(target).toMatchObject({ path: "/srv/report.xlsx", name: "report.xlsx" });
  });
});
