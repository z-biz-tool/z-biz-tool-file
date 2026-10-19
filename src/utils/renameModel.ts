/**
 * 批量重命名的**预览**规则。
 *
 * 为什么要抽成独立模块：这段逻辑必须与后端 `src-tauri/src/commands.rs::compute_renamed_name`
 * 算出**同一个**结果。批量重命名是「带预览」的功能——预览写「文件01.txt」，
 * 点下去真变成「文件1.txt」，用户就没法相信这个预览了。
 *
 * 两侧共用 `tests/fixtures/rename-cases.json` 这一份夹具：
 * Rust 侧见 `src-tauri/src/commands.rs` 的 `rename_contract_tests`，
 * TS 侧见 `tests/renameContract.test.ts`。谁改了规则而另一侧没跟上，先红的一定是错的那一侧。
 *
 * 规则（与界面上的说明一一对应）：
 * - `find_replace`：只在**主名**里替换，扩展名原样保留；默认忽略大小写。
 * - `prefix_suffix`：前缀加在主名前，后缀加在主名后、**扩展名前**。
 * - `auto_number`：编号 = 起始 + 序号 * 步长，不足位数用 0 补齐，插在主名后、扩展名前。
 */

export type RenameMode = "find_replace" | "prefix_suffix" | "auto_number";

export interface RenameOptions {
  mode: RenameMode;
  findText: string;
  replaceText: string;
  caseSensitive: boolean;
  prefix: string;
  suffix: string;
  startNumber: number;
  step: number;
  digits: number;
}

/**
 * 将文件名拆分为名称部分和扩展名部分。
 *
 * 扩展名**带点**（".txt"）—— 与后端 `compute_renamed_name` 的入参约定一致。
 * 点在开头（".gitignore"）或没有点时，扩展名为空串。
 */
export function splitFileName(fileName: string): [string, string] {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return [fileName, ""];
  return [fileName.slice(0, dotIndex), fileName.slice(dotIndex)];
}

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 按参数算出新文件名。`original` 是原始文件名（含扩展名）。
 *
 * 与后端 `compute_renamed_name` 逐字对应 —— 改这里必须同步改那边，
 * 否则夹具会红。
 */
export function computeNewName(
  original: string,
  index: number,
  opts: RenameOptions
): string {
  const [name, ext] = splitFileName(original);

  switch (opts.mode) {
    case "find_replace": {
      if (!opts.findText) return original;
      const flags = opts.caseSensitive ? "g" : "gi";
      try {
        const regex = new RegExp(escapeRegExp(opts.findText), flags);
        return name.replace(regex, opts.replaceText) + ext;
      } catch {
        return original;
      }
    }
    case "prefix_suffix": {
      return opts.prefix + name + opts.suffix + ext;
    }
    case "auto_number": {
      const num = opts.startNumber + index * opts.step;
      const numStr = String(num).padStart(opts.digits, "0");
      return name + numStr + ext;
    }
    default:
      return original;
  }
}
