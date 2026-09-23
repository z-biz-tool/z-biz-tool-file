import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const confirmMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("antd", () => ({
  Modal: { confirm: (options: unknown) => confirmMock(options) },
  Radio: { Group: () => null },
}));

import {
  askConflictPolicy,
  baseName,
  blocksDisplacement,
  conflictNote,
  occupiedNames,
  placeBatch,
  batchToast,
  type BatchItem,
} from "../src/utils/conflictChoice";

type ConfirmOptions = {
  title: string;
  okText: string;
  cancelText: string;
  onOk: () => void;
  onCancel: () => void;
};
const lastConfirm = (): ConfirmOptions =>
  confirmMock.mock.calls[confirmMock.mock.calls.length - 1][0] as ConfirmOptions;

beforeEach(() => {
  invokeMock.mockReset();
  confirmMock.mockReset();
});

describe("baseName", () => {
  it("拖目录时路径常带尾斜杠，不能切成空串", () => {
    expect(baseName("/Users/me/Downloads")).toBe("Downloads");
    expect(baseName("/Users/me/Downloads/")).toBe("Downloads");
    expect(baseName("C:\\work\\报告.docx")).toBe("报告.docx");
    expect(baseName("C:\\work\\报告.docx\\")).toBe("报告.docx");
  });

  it("退化输入不会抛异常", () => {
    expect(baseName("")).toBe("");
    expect(baseName("/")).toBe("");
    expect(baseName("单个名字")).toBe("单个名字");
  });
});

describe("occupiedNames", () => {
  it("没有名字要问时不发 IPC", async () => {
    await expect(occupiedNames("/tmp/x", [])).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("按 Tauri 的 camelCase 约定传参", async () => {
    invokeMock.mockResolvedValue(["a.pdf"]);
    await expect(occupiedNames("/tmp/x", ["a.pdf", "b.pdf"])).resolves.toEqual(["a.pdf"]);
    expect(invokeMock).toHaveBeenCalledWith("occupied_names", {
      destDir: "/tmp/x",
      names: ["a.pdf", "b.pdf"],
    });
  });
});

describe("askConflictPolicy", () => {
  it("不撞名就不打扰用户", async () => {
    await expect(askConflictPolicy("/tmp/x", [])).resolves.toBe("rename");
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("三个选项都得在，默认落在最安全的「保留两者」", () => {
    askConflictPolicy("/tmp/x", ["a.pdf"]);
    const options = lastConfirm();
    const wrap = options as unknown as { content: { props: { children: unknown[] } } };
    const radio = (wrap.content.props.children as Array<{ props?: { options?: unknown } }>).find(
      (child) => child?.props?.options
    );
    expect(radio).toBeTruthy();
    const group = radio!.props! as { defaultValue: string; options: { label: string }[] };
    expect(group.options.map((o) => o.label)).toEqual(["保留两者", "替换", "跳过"]);
    expect(group.defaultValue).toBe("rename");
  });

  it("撞名时弹一次，默认保留两者，取消则整批不动", async () => {
    const pending = askConflictPolicy("/tmp/x", ["a.pdf", "b.pdf"]);
    const options = lastConfirm();
    expect(options.title).toContain("2");
    expect(options.okText).toBe("应用");
    expect(options.cancelText).toBe("取消");

    options.onOk();
    expect(await pending).toBe("rename");

    const cancelled = askConflictPolicy("/tmp/x", ["a.pdf"]);
    lastConfirm().onCancel();
    expect(await cancelled).toBeNull();
  });
});

describe("conflictNote", () => {
  it("没撞名就不该出现同名说明", () => {
    expect(conflictNote("rename", 0)).toBe("");
  });

  it("说明里的数量与策略都跟着入参变", () => {
    expect(conflictNote("overwrite", 3)).toContain("3 项同名");
    expect(conflictNote("overwrite", 3)).toContain("替换");
    expect(conflictNote("skip", 1)).toContain("跳过");
    expect(conflictNote("rename", 2)).not.toBe(conflictNote("overwrite", 2));
  });
});

/** 让探测按给定答案回，并记录真正发生的写入 */
function stubBackend(taken: string[]) {
  const writes: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "occupied_names") return Promise.resolve(taken);
    writes.push({ cmd, args });
    return Promise.resolve("/tmp/dest/x");
  });
  return writes;
}

const items = (...srcs: Array<[string, "copy" | "move"]>): BatchItem[] =>
  srcs.map(([src, mode]) => ({ src, mode }));

/** 复刻用户操作：在单选里选一项，再点「应用」 */
async function answer(choice: "rename" | "overwrite" | "skip"): Promise<void> {
  await vi.waitFor(() => expect(confirmMock).toHaveBeenCalled());
  const options = lastConfirm() as unknown as {
    content: { props: { children: Array<{ props?: { onChange?: (e: unknown) => void } }> } };
    onOk: () => void;
  };
  const radio = options.content.props.children.find((c) => c?.props?.onChange);
  radio!.props!.onChange!({ target: { value: choice } });
  options.onOk();
}

describe("batchToast", () => {
  it("落了地才报成功，并把同名处理一起说清", () => {
    const toast = batchToast(
      { placed: 2, note: conflictNote("rename", 1), selfSkipped: 0 },
      "已移动",
      "下载"
    );
    expect(toast!.kind).toBe("success");
    expect(toast!.refresh).toBe(true);
    expect(toast!.text).toContain("已移动 2 项到 下载");
    expect(toast!.text).toContain("1 项同名");
  });

  it("剔掉了自我包含的项就要有一句话说明，不能只报个数字", () => {
    const partial = batchToast({ placed: 1, note: "", selfSkipped: 1 }, "已移动", "下载");
    expect(partial!.kind).toBe("success");
    expect(partial!.refresh).toBe(true);
    expect(partial!.text).toContain("1 项会搬进自己的子目录，已跳过");

    const allSkipped = batchToast({ placed: 0, note: "", selfSkipped: 1 }, "已移动", "下载");
    expect(allSkipped!.kind).toBe("warning");
    expect(allSkipped!.refresh).toBe(false);
    expect(allSkipped!.text).toContain("子目录");
  });

  it("既没落地也没被剔，就不该弹任何提示", () => {
    expect(batchToast({ placed: 0, note: "", selfSkipped: 0 }, "已移动", "下载")).toBeNull();
  });
});

describe("blocksDisplacement", () => {
  it("自身与祖先关系要拦住，各种分隔符写法算同一个目录", () => {
    expect(blocksDisplacement("/tmp/dest", "/tmp/dest")).toBe(true);
    expect(blocksDisplacement("/tmp/dest/", "/tmp/dest")).toBe(true);
    expect(blocksDisplacement("/tmp/dest", "/tmp/dest/")).toBe(true);
    expect(blocksDisplacement("C:\\work", "C:/work/sub/deep")).toBe(true);
    expect(blocksDisplacement("/tmp/dest", "/tmp/dest/sub")).toBe(true);
    expect(blocksDisplacement("/tmp/dest", "/tmp/dest/sub/deep")).toBe(true);
  });

  it("名字只是前缀的兄弟目录不能误判成子目录", () => {
    // 纯字符串 startsWith 的经典坑："/tmp/dest2" 并不在 "/tmp/dest" 里面
    expect(blocksDisplacement("/tmp/dest", "/tmp/dest2")).toBe(false);
    expect(blocksDisplacement("/tmp/dest", "/tmp/dest.backup/sub")).toBe(false);
    expect(blocksDisplacement("/tmp/dest", "/other/dest/sub")).toBe(false);
    // 反向也不是包含关系
    expect(blocksDisplacement("/tmp/dest/sub", "/tmp/dest")).toBe(false);
  });

  it("文件挪进自己所在的目录不算自我包含，那是同名策略的事", () => {
    expect(blocksDisplacement("/tmp/dest/a.txt", "/tmp/dest")).toBe(false);
  });

  it("空路径不参与判断，不抛异常", () => {
    expect(blocksDisplacement("", "/tmp/dest")).toBe(false);
    expect(blocksDisplacement("/tmp/dest", "")).toBe(false);
  });

  it("根目录是所有绝对路径的祖先", () => {
    expect(blocksDisplacement("/", "/tmp/dest")).toBe(true);
    // 但 "/" 自己作落点时，比较的仍是"是不是同一个根"，不该把任何东西都放行
    expect(blocksDisplacement("/tmp", "/")).toBe(false);
  });
});

describe("placeBatch", () => {
  it("取消之后一个文件都不许动", async () => {
    const writes = stubBackend(["a.pdf"]);
    const pending = placeBatch("/tmp/dest", items(["/src/a.pdf", "move"]));
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalled());
    lastConfirm().onCancel();
    expect(await pending).toBeNull();
    expect(writes).toEqual([]);
  });

  it("不撞名就不该弹框，并且照原名落地", async () => {
    const writes = stubBackend([]);
    const done = await placeBatch(
      "/tmp/dest",
      items(["/src/a.pdf", "move"], ["/src/b.txt", "copy"])
    );
    expect(confirmMock).not.toHaveBeenCalled();
    expect(done).toEqual({ placed: 2, note: "", selfSkipped: 0 });
    expect(writes.map((w) => w.cmd)).toEqual(["move_file", "copy_file"]);
    expect(writes[0].args).toEqual({
      srcPath: "/src/a.pdf",
      destDir: "/tmp/dest",
      conflict: "rename",
    });
  });

  it("选「替换」就要真的把 overwrite 传给后端", async () => {
    const writes = stubBackend(["a.pdf"]);
    const pending = placeBatch("/tmp/dest", items(["/src/a.pdf", "move"]));
    await answer("overwrite");
    const done = await pending;
    expect(writes[0].args.conflict).toBe("overwrite");
    expect(done).toEqual({ placed: 1, note: conflictNote("overwrite", 1), selfSkipped: 0 });
    expect(done!.note).toContain("替换");
  });

  it("选「跳过」时同名的几项不计进已移动", async () => {
    const writes = stubBackend(["a.pdf", "b.pdf"]);
    const pending = placeBatch(
      "/tmp/dest",
      items(["/src/a.pdf", "move"], ["/src/b.pdf", "move"], ["/src/c.pdf", "move"])
    );
    await answer("skip");
    const done = await pending;
    expect(writes).toHaveLength(3);
    expect(done!.placed).toBe(1);
    expect(done!.selfSkipped).toBe(0);
    expect(done!.note).toContain("2 项同名");
  });

  it("往自己身上或自己的子目录里拖，直接不受理", async () => {
    const writes = stubBackend(["whatever"]);
    const done = await placeBatch(
      "/tmp/dest/sub",
      items(["/tmp/dest", "move"], ["/tmp/dest/sub", "copy"])
    );
    expect(done).toEqual({ placed: 0, note: "", selfSkipped: 2 });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("目录尾斜杠也要认成同一个目录，不能当成没冲突", async () => {
    stubBackend([]);
    const done = await placeBatch("/tmp/dest", items(["/tmp/dest/", "move"]));
    expect(done).toEqual({ placed: 0, note: "", selfSkipped: 1 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("一批里剔掉自我包含的那条，其余照搬，并且数得出来", async () => {
    const writes = stubBackend([]);
    const done = await placeBatch(
      "/tmp/dest/sub",
      items(["/src/a.pdf", "move"], ["/tmp/dest", "move"], ["/src/b.txt", "copy"])
    );
    expect(done).toEqual({ placed: 2, note: "", selfSkipped: 1 });
    // 被剔掉的那条不能只是"不计数"，必须真的没发命令
    expect(writes.map((w) => w.args.srcPath)).toEqual(["/src/a.pdf", "/src/b.txt"]);
  });
});
