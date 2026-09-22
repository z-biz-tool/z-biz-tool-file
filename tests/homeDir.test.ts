import { beforeEach, describe, expect, it, vi } from "vitest";

const homeDirMock = vi.fn();

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: () => homeDirMock(),
}));

/** homeDir 模块持有模块级缓存，每个用例都要重新求值模块才能拿到干净状态 */
async function loadFresh() {
  vi.resetModules();
  return await import("../src/utils/homeDir");
}

describe("homeDir", () => {
  beforeEach(() => {
    homeDirMock.mockReset();
  });

  it("去掉结尾分隔符", async () => {
    homeDirMock.mockResolvedValue("/Users/example/");
    const m = await loadFresh();
    expect(await m.resolveHomeDir()).toBe("/Users/example");
    expect(m.homeDirSync()).toBe("/Users/example");
  });

  it("结果永久缓存，不重复请求 Tauri API", async () => {
    homeDirMock.mockResolvedValue("/Users/example");
    const m = await loadFresh();
    await m.resolveHomeDir();
    await m.resolveHomeDir();
    await m.resolveHomeDir();
    expect(homeDirMock).toHaveBeenCalledTimes(1);
  });

  it("解析完成前 homeDirSync 先回退到根目录", async () => {
    let release: (v: string) => void = () => {};
    homeDirMock.mockReturnValue(new Promise<string>((r) => (release = r)));
    const m = await loadFresh();
    expect(m.homeDirSync()).toBe("/");
    release("/Users/example");
    expect(await m.resolveHomeDir()).toBe("/Users/example");
    expect(m.homeDirSync()).toBe("/Users/example");
  });

  it("Tauri API 抛错时回退到根目录而不是卡住", async () => {
    homeDirMock.mockRejectedValue(new Error("not inside tauri"));
    const m = await loadFresh();
    expect(await m.resolveHomeDir()).toBe("/");
  });
});

describe("shortenHome", () => {
  beforeEach(() => {
    homeDirMock.mockReset();
  });

  const cases: Array<[string, string]> = [
    ["/Users/example", "~"],
    ["/Users/example/Downloads", "~/Downloads"],
    ["/Users/example/a/b/c.txt", "~/a/b/c.txt"],
    ["/Users/examplex", "/Users/examplex"],
    ["/Users/ex", "/Users/ex"],
    ["/tmp/x", "/tmp/x"],
    ["/", "/"],
    ["", ""],
  ];

  for (const [input, expected] of cases) {
    it(`缩写 ${input || "(空)"} -> ${expected || "(空)"}`, async () => {
      homeDirMock.mockResolvedValue("/Users/example");
      const m = await loadFresh();
      await m.resolveHomeDir();
      expect(m.shortenHome(input)).toBe(expected);
    });
  }

  it("主目录未知时原样返回，不伪造 ~ 前缀", async () => {
    homeDirMock.mockRejectedValue(new Error("not inside tauri"));
    const m = await loadFresh();
    await m.resolveHomeDir();
    expect(m.shortenHome("/Users/example")).toBe("/Users/example");
  });
});
