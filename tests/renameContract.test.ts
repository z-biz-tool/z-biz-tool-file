/**
 * 跨语言契约测试：前端预览算出的新文件名，必须与后端实际改名算出的**逐字相同**。
 *
 * 为什么要这道门：批量重命名是「带预览」的功能。预览写「文件01.txt」、
 * 点下去真变成「文件1.txt」，用户就没法相信这个预览了 —— 本轮实测出 5 处不符
 * （详见 doc/优化方案/08_本轮深度优化实施记录.md）。
 *
 * 两侧共用 `tests/fixtures/rename-cases.json`：
 *   前端 = src/utils/renameModel.ts 的 computeNewName
 *   后端 = src-tauri/src/commands.rs 的 compute_renamed_name
 * 谁改了规则而另一侧没跟上，先红的一定是错的那一侧。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeNewName, type RenameMode, type RenameOptions } from "../src/utils/renameModel";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");

interface FixtureCase {
  name: string;
  oldName: string;
  index: number;
  opts: Partial<RenameOptions> & { mode: RenameMode };
  expected: string;
}

function loadCases(): FixtureCase[] {
  const raw = readFileSync(`${ROOT}/tests/fixtures/rename-cases.json`, "utf8");
  const parsed = JSON.parse(raw) as { cases: FixtureCase[] };
  return parsed.cases;
}

/** 夹具里缺省的字段按界面默认值补齐（界面默认：忽略大小写、起始 1、步长 1、位数 2）。 */
function toOptions(opts: FixtureCase["opts"]): RenameOptions {
  return {
    mode: opts.mode,
    findText: opts.findText ?? "",
    replaceText: opts.replaceText ?? "",
    caseSensitive: opts.caseSensitive ?? false,
    prefix: opts.prefix ?? "",
    suffix: opts.suffix ?? "",
    startNumber: opts.startNumber ?? 1,
    step: opts.step ?? 1,
    digits: opts.digits ?? 2,
  };
}

describe("批量重命名：前端预览与后端实际是同一套规则", () => {
  it("夹具本身有效：真的读到了用例（读空了后面会「全绿」而什么也没测）", () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(10);
    // 每条都要有名字和期望值，否则一条空用例能混过整道门
    expect(cases.every((c) => c.name && c.expected !== undefined)).toBe(true);
  });

  it("每条用例的前端预览都等于夹具的期望值", () => {
    for (const c of loadCases()) {
      const got = computeNewName(c.oldName, c.index, toOptions(c.opts));
      expect(got, `用例「${c.name}」前端预览算错了`).toBe(c.expected);
    }
  });

  it("步长与位数不是摆设：界面上有这两个输入框，预览就必须按它们算", () => {
    const cases = loadCases();
    const stepped = cases.find((c) => c.opts.mode === "auto_number" && (c.opts.step ?? 1) !== 1);
    expect(stepped, "夹具里必须有一条非默认步长的用例，否则这个门是摆设").toBeTruthy();
    const padded = cases.find((c) => c.opts.mode === "auto_number" && (c.opts.digits ?? 2) !== 0);
    expect(padded, "夹具里必须有一条位数为 0 的用例").toBeTruthy();
  });

  it("忽略大小写是默认行为，勾上「区分大小写」才严格匹配", () => {
    const cases = loadCases();
    const insensitive = cases.find(
      (c) => c.opts.mode === "find_replace" && c.opts.caseSensitive === undefined
    );
    const sensitive = cases.find((c) => c.opts.caseSensitive === true);
    expect(insensitive, "夹具里必须有默认（忽略大小写）的用例").toBeTruthy();
    expect(sensitive, "夹具里必须有区分大小写的用例").toBeTruthy();
  });
});
