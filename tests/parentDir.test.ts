/**
 * parentOfPath：右键"加入图片库/加入音乐库"要靠它把文件换成所在目录。
 *
 * 传错成文件自身路径时的症状很隐蔽：画廊去 list_directory 一个文件，拿不到条目，
 * 于是弹出一座空馆写着"该目录下没有图片文件"，没有任何报错指向真正的原因。
 */
import { describe, expect, it } from "vitest";
import { parentOfPath } from "../src/utils/parentDir";

describe("父目录", () => {
  it("与 goUp 同一口径：切分去空段再拼绝对路径", () => {
    expect(parentOfPath("/Users/me/Downloads/a.jpg")).toBe("/Users/me/Downloads");
    expect(parentOfPath("/a.jpg")).toBe("/");
    expect(parentOfPath("/")).toBe("/");
    expect(parentOfPath("")).toBe("/");
  });

  it("尾部分隔符不算一层", () => {
    // "/a/b/" 的父目录是 /a；当成"没有尾斜杠"就会得到 /a/b（把目录自己当父目录）
    expect(parentOfPath("/a/b/")).toBe("/a");
    expect(parentOfPath("/a/b//")).toBe("/a");
  });

  it("Windows 反斜杠也认，盘符算根不算一层目录", () => {
    expect(parentOfPath("C:\\work\\报告.docx")).toBe("C:/work");
    expect(parentOfPath("C:\\a.jpg")).toBe("C:/");
    expect(parentOfPath("C:\\")).toBe("C:/");
  });

  it("结果总是一个目录形状（不是文件自身），且不以斜杠结尾", () => {
    for (const p of ["/a/b/c.jpg", "/a/b", "/x"]) {
      const parent = parentOfPath(p);
      const under = parent.endsWith("/") ? parent : parent + "/";
      expect(p.startsWith(parent) && (p === parent || p.startsWith(under)), p).toBe(true);
      if (parent !== "/") expect(parent.endsWith("/"), parent).toBe(false);
    }
  });
});
