import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  computeHashes,
  countHashFailures,
  formatHashReport,
  type HashTarget,
} from "../src/utils/batchHash";

const files = (n: number): HashTarget[] =>
  Array.from({ length: n }, (_, i) => ({ path: `/dir/f${i}.bin`, name: `f${i}.bin` }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  invokeMock.mockReset();
});

describe("computeHashes", () => {
  it("调用后端真实存在的 calculate_file_hash 命令", async () => {
    // 回归：菜单里曾写成 compute_file_hash，命令不存在 → 每个文件都 reject，
    // 结果被丢弃后还提示"批量哈希完成"
    invokeMock.mockResolvedValue("abc123");
    const rows = await computeHashes([{ path: "/a.bin", name: "a.bin" }], "SHA256");
    expect(invokeMock).toHaveBeenCalledWith("calculate_file_hash", {
      path: "/a.bin",
      algorithm: "SHA256",
    });
    expect(rows[0].hash).toBe("abc123");
    expect(rows[0].error).toBe("");
  });

  it("结果顺序始终跟随输入，即使第一个文件最慢", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const targets = files(6);
    const pending = computeHashes(targets, "md5", undefined, async (path) => {
      if (path === targets[0].path) await gate;
      return `hash:${path}`;
    });
    await sleep(0);
    release();
    const rows = await pending;
    expect(rows.map((r) => r.path)).toEqual(targets.map((t) => t.path));
    expect(rows.map((r) => r.hash)).toEqual(targets.map((t) => `hash:${t.path}`));
  });

  it("单个文件失败只影响那一行，其余结果照常返回", async () => {
    const targets = files(3);
    const rows = await computeHashes(targets, "md5", undefined, async (path) => {
      if (path === targets[1].path) throw "命中系统保护目录，禁止操作: /etc";
      return "ok";
    });
    expect(rows[0].hash).toBe("ok");
    expect(rows[1].hash).toBe("");
    expect(rows[1].error).toContain("系统保护");
    expect(rows[2].hash).toBe("ok");
    expect(countHashFailures(rows)).toBe(1);
  });

  it("并发受限但确实并行", async () => {
    let inFlight = 0;
    let peak = 0;
    const rows = await computeHashes(files(12), "sha1", undefined, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(1);
      inFlight -= 1;
      return "h";
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(rows).toHaveLength(12);
  });

  it("进度逐条上报、严格递增并收敛到总数", async () => {
    const seen: string[] = [];
    await computeHashes(files(9), "md5", (done, total) => {
      seen.push(`${done}/${total}`);
    }, async () => "h");
    expect(seen).toHaveLength(9);
    expect(seen[0]).toBe("1/9");
    expect(seen[8]).toBe("9/9");
    expect(new Set(seen).size).toBe(9);
  });

  it("空选择直接返回空结果且不碰后端", async () => {
    await expect(computeHashes([], "md5")).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("formatHashReport", () => {
  it("成功行对齐 sha256sum 格式，失败行留成注释", () => {
    const text = formatHashReport([
      { path: "/a.bin", name: "a.bin", hash: "deadbeef", error: "" },
      { path: "/b.bin", name: "b.bin", hash: "", error: "文件不存在: /b.bin" },
    ]);
    expect(text).toBe("deadbeef  a.bin\n# b.bin: 文件不存在: /b.bin");
  });
});
