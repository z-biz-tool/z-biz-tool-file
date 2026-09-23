/**
 * 内置快速操作必须落在后端真的收得下的通道上。
 *
 * 之前六个内置项全是 shell 形式、program 写裸名字（"open" / "chmod" / "md5"），
 * 而 src-tauri 的 run_shell_command 只放行白名单里的**绝对路径**程序
 * （/usr/bin/open、/usr/bin/pbcopy、/usr/bin/mdls…）—— 于是每一个内置动作点下去
 * 都必然被"程序未在白名单内"打回。而 Rust 那边早有 path_guard 校验过的具名命令
 * 干同一件事（reveal_in_finder / set_file_permissions / calculate_file_hash）。
 * 这组断言把两件事钉住：内置项不许再走裸名 shell，以及 mode 必须是权限位本身。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_QUICK_ACTIONS,
  actionResultText,
  actionSummary,
  isStaleBuiltin,
  resolveActionCall,
  type QuickAction,
} from "../src/utils/quickActions";

const byId = (id: string): QuickAction => {
  const found = DEFAULT_QUICK_ACTIONS.find((a) => a.id === id);
  if (!found) throw new Error(`内置项不在了: ${id}`);
  return found;
};

describe("内置快速动作发什么", () => {
  it("没有任何内置项走裸名 shell（那种一定被白名单拒）", () => {
    const shellOnes = DEFAULT_QUICK_ACTIONS.filter((a) => !a.command && !a.copyPath);
    expect(shellOnes.map((a) => a.id)).toEqual([]);
    for (const a of DEFAULT_QUICK_ACTIONS) {
      // 具名命令的 program 留空，避免有人以为它会作为回退被调用
      expect(a.program, a.id).toBe("");
    }
  });

  it("在 Finder 中显示走 reveal_in_finder，并带上目标路径", () => {
    expect(resolveActionCall(byId("builtin-reveal"), "/tmp/a.txt")).toEqual({
      kind: "command",
      command: "reveal_in_finder",
      args: { path: "/tmp/a.txt" },
    });
  });

  it("权限那两条发的是权限位，不是把八进制当十进制", () => {
    const ro = resolveActionCall(byId("builtin-chmod-readonly"), "/x/y") as {
      args: { mode: number };
    };
    const rw = resolveActionCall(byId("builtin-chmod-writable"), "/x/y") as {
      args: { mode: number };
    };
    expect(ro.args.mode).toBe(0o444);
    expect(rw.args.mode).toBe(0o644);
    // 写错的后果是静默改错权限：444 会被当成 0o674
    expect(ro.args.mode.toString(8)).toBe("444");
    expect((444).toString(8)).toBe("674");
  });

  it("复制路径不起进程，只写剪贴板", () => {
    expect(resolveActionCall(byId("builtin-cp-clipboard"), "/a b/c.txt")).toEqual({
      kind: "clipboard",
      text: "/a b/c.txt",
    });
  });

  it("MD5 走 calculate_file_hash，algorithm 必须给", () => {
    expect(resolveActionCall(byId("builtin-md5"), "/f.bin")).toEqual({
      kind: "command",
      command: "calculate_file_hash",
      args: { path: "/f.bin", algorithm: "md5" },
    });
  });

  it("没有后端能力的 touch -m 已经摘掉", () => {
    expect(DEFAULT_QUICK_ACTIONS.some((a) => a.id === "builtin-touch-mtime")).toBe(false);
  });
});

describe("resolveActionCall 的通用形状", () => {
  it("用户自定义的 shell 动作照旧发 run_shell_command，{path} 全部替换", () => {
    const user: QuickAction = {
      id: "user-1",
      name: "自定义",
      program: "/usr/bin/open",
      args: ["-R", "{path}", "前 {path} 后 {path}"],
    };
    expect(resolveActionCall(user, "/p/q")).toEqual({
      kind: "shell",
      program: "/usr/bin/open",
      args: ["-R", "/p/q", "前 /p/q 后 /p/q"],
    });
  });

  it("数字参数不被当模板处理", () => {
    const a: QuickAction = {
      id: "u2",
      name: "n",
      program: "",
      args: [],
      command: "set_file_permissions",
      commandArgs: { path: "{path}", mode: 0o600 },
    };
    expect(resolveActionCall(a, "/z").args).toEqual({ path: "/z", mode: 0o600 });
  });
});

describe("结果文案与管理列表标签", () => {
  it("hash 命令的返回值直接就是正文，权限回显八进制", () => {
    const hash = resolveActionCall(byId("builtin-md5"), "/f");
    expect(actionResultText(hash, "  d41d8cd98f00b204e9800998ecf8427e  ")).toBe(
      "d41d8cd98f00b204e9800998ecf8427e"
    );
    const perm = resolveActionCall(byId("builtin-chmod-readonly"), "/f");
    expect(actionResultText(perm, null)).toBe("权限已设为 444");
    expect(actionResultText({ kind: "clipboard", text: "/f" }, null)).toBe("路径已复制到剪贴板");
  });

  it("内置项在管理列表里也要有可读的标签（program 现在是空的）", () => {
    expect(actionSummary(byId("builtin-reveal"))).toEqual({
      head: "reveal_in_finder",
      detail: "path={path}",
    });
    expect(actionSummary(byId("builtin-cp-clipboard")).head).toBe("剪贴板");
  });
});

describe("localStorage 里的旧内置项", () => {
  beforeAll(() => {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage;
  });

  it("被摘掉的内置项不能从缓存里复活，用户自己的要留下", async () => {
    const stale: QuickAction = {
      id: "builtin-touch-mtime",
      name: "更新修改时间为现在 (touch -m)",
      program: "touch",
      args: ["-m", "{path}"],
      builtin: true,
    };
    expect(isStaleBuiltin(stale)).toBe(true);
    expect(isStaleBuiltin(byId("builtin-reveal"))).toBe(false);
    expect(isStaleBuiltin({ id: "user-9", name: "n", program: "/usr/bin/open", args: [] })).toBe(
      false
    );

    // loadQuickActions 开头是 typeof window === "undefined" 直接返回默认表（给 SSR 用的），
    // node 环境里必须把 window 也补上，否则这条测的是守卫而不是合并逻辑
    (globalThis as { window: unknown }).window = {};
    const mine: QuickAction = { id: "user-9", name: "我自己的", program: "/usr/bin/open", args: [] };
    (globalThis as { localStorage: unknown }).localStorage = {
      getItem: () => JSON.stringify([stale, mine]),
      setItem: () => {},
      removeItem: () => {},
    };
    const { loadQuickActions } = await import("../src/utils/quickActions");
    const ids = loadQuickActions().map((a) => a.id);
    expect(ids).not.toContain("builtin-touch-mtime");
    expect(ids).toContain("user-9");
    // 默认表永远在前，且不会因为缓存里有旧副本就重复一份
    expect(ids.filter((i) => i === "builtin-reveal")).toHaveLength(1);
  });
});
