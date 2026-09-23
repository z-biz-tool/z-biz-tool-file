/**
 * 新建文件/文件夹名字校验。
 *
 * 之前 handleCreate 是"拿到名字就 invoke，后端报错再 message.error"。两个坏处：
 *   1) 用户敲 "a/b" 会变成 "currentPath/a/b"，后端默默把它当目录创建，
 *      文件名错乱但界面看起来"成功了"。
 *   2) 错误是后端透出来的"无效路径"，用户不知道是名字里有 / 还是盘符卷的问题。
 *
 * 把校验前移，违规即时报"这个名字不能用，因为 X"——后端只负责落盘。
 */
import { describe, expect, it } from "vitest";
import {
  checkFileNameForCreate,
  sanitizeFileNameInput,
  validateFileName,
} from "../src/utils/validateFileName";

describe("validateFileName —— 哪条规则命中哪条", () => {
  it("空字符串报 empty", () => {
    expect(validateFileName("")?.rule).toBe("empty");
  });

  it("只有空白字符报 whitespace（trim 前先判）", () => {
    expect(validateFileName("   ")?.rule).toBe("whitespace");
    expect(validateFileName("\t\n ")?.rule).toBe("whitespace");
  });

  it("含 / 报 slash", () => {
    expect(validateFileName("a/b")?.rule).toBe("slash");
    expect(validateFileName("/a")?.rule).toBe("slash");
    expect(validateFileName("a/")?.rule).toBe("slash");
  });

  it("含 \\ 报 backslash", () => {
    expect(validateFileName("a\\b")?.rule).toBe("backslash");
  });

  it("控制字符（含 \\0）报 control", () => {
    expect(validateFileName("a\u0000b")?.rule).toBe("control");
    expect(validateFileName("a\nb")?.rule).toBe("control");
    expect(validateFileName("a\rb")?.rule).toBe("control");
  });

  it("\".\" 与 \"..\" 报 dot / dotdot", () => {
    expect(validateFileName(".")?.rule).toBe("dot");
    expect(validateFileName("..")?.rule).toBe("dotdot");
    // 形如 ".a" / "a." 的 . 不算 . 自身——但 "a." 是 trailing-dot，下一条单测断言
    expect(validateFileName(".a")?.rule).toBeUndefined();
  });

  it("末尾空格与末尾点都要拒，否则 macOS 会悄悄建出 \"a\"", () => {
    expect(validateFileName("a ")?.rule).toBe("trailing-space");
    expect(validateFileName("a." )?.rule).toBe("trailing-dot");
  });

  it("正常名字应该通过", () => {
    expect(validateFileName("a")).toBeNull();
    expect(validateFileName("a.txt")).toBeNull();
    expect(validateFileName("中文名.pdf")).toBeNull();
    expect(validateFileName(".hidden")).toBeNull(); // 隐藏文件是合法的
  });
});

describe("sanitizeFileNameInput —— 实时输入清洗", () => {
  it("吞掉 / 与 \\，不留下", () => {
    expect(sanitizeFileNameInput("a/b")).toBe("ab");
    expect(sanitizeFileNameInput("a\\b")).toBe("ab");
    expect(sanitizeFileNameInput("/")).toBe("");
  });

  it("吞掉控制字符", () => {
    expect(sanitizeFileNameInput("a\u0000b")).toBe("ab");
    expect(sanitizeFileNameInput("a\nb")).toBe("ab");
  });

  it("去掉末尾的点（mac 静默剥离的元凶）", () => {
    expect(sanitizeFileNameInput("a.")).toBe("a");
    expect(sanitizeFileNameInput("a...")).toBe("a");
    // 中间的点要保留（"a.b.c"）
    expect(sanitizeFileNameInput("a.b.c")).toBe("a.b.c");
    // 只去末尾；"a.b." 是 "a.b" 去掉一个尾点
    expect(sanitizeFileNameInput("a.b.")).toBe("a.b");
  });

  it("空白字符保留（不能在用户敲字时吞掉空格，让他知道刚才敲了）", () => {
    expect(sanitizeFileNameInput("a b")).toBe("a b");
  });
});

describe("checkFileNameForCreate —— 提交时最终兜底", () => {
  it("合法名字 trim 后返回 ok", () => {
    expect(checkFileNameForCreate("  hello.txt  ")).toEqual({ ok: true, name: "hello.txt" });
  });

  it("非法名字返回 issue 描述（含中文，方便 UI 直接用）", () => {
    const r = checkFileNameForCreate("a/b");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue.rule).toBe("slash");
      expect(r.issue.message).toMatch(/子目录/);
    }
  });

  it("仅空白 trim 后变空，按 empty 处理", () => {
    const r = checkFileNameForCreate("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.rule).toBe("whitespace");
  });

  it("末尾空格的合法名字 trim 后是合法名字（前后空白不算违规）", () => {
    expect(checkFileNameForCreate("  a.txt  ")).toEqual({ ok: true, name: "a.txt" });
  });
});