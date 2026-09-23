/**
 * resolveOpen / resolveRenameTarget 单测。
 *
 * 钉的是"双击/Enter 到底作用在谁身上"这条规则。它此前散落在四处 JSX 里，
 * 其中三处写成了 `record.is_dir && navigateTo(...)` —— 于是双击文件什么都不发生，
 * 而双面板视图却是正确的。规则收进来之后，改错一次就会被这里炸到。
 */
import { describe, expect, it } from "vitest";
import {
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

describe("resolveOpen", () => {
  it("目录是进入，不是交给系统 open", () => {
    expect(resolveOpen([dir()])).toEqual({ kind: "navigate", path: "/tmp/sub" });
  });

  it("文件交给默认应用 —— 这条以前在主表格里根本不存在", () => {
    expect(resolveOpen([file()])).toEqual({ kind: "open-app", path: "/tmp/a.pdf" });
  });

  it("没选中要给原因，而不是静默无反应", () => {
    expect(resolveOpen([])).toEqual({ kind: "none", reason: "empty" });
    expect(openRejectText("empty")).toContain("选中");
  });

  it("多选不去逐个打开（一次 Enter 弹几十个外部应用窗口是事故）", () => {
    expect(resolveOpen([file(), dir(), file("/tmp/b.txt", "b.txt")])).toEqual({
      kind: "none",
      reason: "multi",
    });
    expect(openRejectText("multi")).toContain("一次只能打开一项");
  });

  it("多选里含目录也不能误判成进入目录", () => {
    // 早先的写法是 entries.find(is_dir)，选中最多的时候会"看起来能打开"却跳错地方
    expect(resolveOpen([dir(), file()]).kind).toBe("none");
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
