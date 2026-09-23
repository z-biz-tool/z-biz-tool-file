import { invoke } from "@tauri-apps/api/core";
import { Radio } from "antd";
import type { App as AntdApp } from "antd";

/**
 * 弹窗必须由调用方把 `App.useApp()` 的 modal 递进来：静态 `Modal.confirm` 走模块级默认配置，
 * 深色主题下弹出白底黑字的一层，locale 也读不到 —— 和全站其他确认框不是同一个样子。
 */
type ModalApi = ReturnType<typeof AntdApp.useApp>["modal"];

/** 与后端 commands.rs 的 ConflictPolicy 一字不差（serde rename_all = lowercase） */
export type ConflictPolicy = "rename" | "overwrite" | "skip";

const POLISH: Record<ConflictPolicy, string> = {
  rename: "保留两者",
  overwrite: "替换",
  skip: "跳过",
};

/**
 * 源路径落到目标目录里会用的文件名。
 * 拖拽的是目录时路径常带尾斜杠（"/a/b/"），直接 split 会得到空串，
 * 于是探测永远报"无冲突"，同名目录照样被盖。
 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

export async function occupiedNames(destDir: string, names: string[]): Promise<string[]> {
  if (!names.length) return [];
  return invoke<string[]>("occupied_names", { destDir, names });
}

/**
 * 撞名时才打扰用户；取消返回 null，调用方整批不动。
 * 默认「保留两者」—— 和后端默认一致：悄悄盖掉用户已有的文件是文件管理器里最贵的意外。
 */
export function askConflictPolicy(
  destDir: string,
  taken: string[],
  modal: ModalApi
): Promise<ConflictPolicy | null> {
  return new Promise((resolve) => {
    if (!taken.length) {
      resolve("rename");
      return;
    }
    let picked: ConflictPolicy = "rename";
    const shown = taken
      .slice(0, 5)
      .map((n) => `· ${n}`)
      .join("\n");
    modal.confirm({
      title: `目标目录里有 ${taken.length} 个同名文件`,
      content: (
        <div>
          <pre style={{ whiteSpace: "pre-wrap", margin: "0 0 8px", fontSize: 12 }}>{shown}</pre>
          <Radio.Group
            defaultValue="rename"
            onChange={(e) => {
              picked = e.target.value as ConflictPolicy;
            }}
            options={(["rename", "overwrite", "skip"] as ConflictPolicy[]).map((v) => ({
              label: POLISH[v],
              value: v,
            }))}
          />
          {/* 拖到文件夹行时目标不在眼前，落点必须写出来 */}
          <div style={{ marginTop: 8, fontSize: 12, color: "#888" }}>目标：{destDir}</div>
        </div>
      ),
      okText: "应用",
      cancelText: "取消",
      onOk: () => resolve(picked),
      onCancel: () => resolve(null),
    });
  });
}

/** 这批落位之后该告诉用户什么；数字必须来自真撞名的那些，不拿总数凑数 */
export function conflictNote(policy: ConflictPolicy, takenCount: number): string {
  if (!takenCount) return "";
  return `其中 ${takenCount} 项同名，已按「${POLISH[policy]}」处理`;
}

export type BatchItem = { src: string; mode: "copy" | "move" };

export interface BatchResult {
  placed: number;
  note: string;
  /** 因为"搬进自己肚子里"被剔掉的条数；调用方要为此给一句解释，不能默默吞掉 */
  selfSkipped: number;
}

/**
 * 一批落位之后该说的那句话。返回 null 表示没话可说（既没落地也没被剔）。
 *
 * 只算文案、不弹提示，是为了两件事：
 * - 各调用方用的是自己那套 `message` 实例（`App.useApp()` 拿到的能带上主题，
 *   静态 `message.xxx` 在暗色主题下会弹出一个没配色的小条）。
 * - 文案能在 node 环境里直接断言，不必伪造 antd。
 *
 * 更重要的是**剔掉了东西就必须吭声**：用户把文件夹拖进它的子目录时，
 * 静默无反应只会被当成"这个应用不好使"，然后再试一次更危险的位置。
 */
export interface BatchToast {
  kind: "success" | "warning";
  text: string;
  /** 有没有真的改变磁盘 —— 决定要不要刷新列表、要不要清剪贴板 */
  refresh: boolean;
}

export function batchToast(done: BatchResult, verb: string, target: string): BatchToast | null {
  if (done.placed > 0) {
    const extra = done.selfSkipped ? `，另有 ${done.selfSkipped} 项会搬进自己的子目录，已跳过` : "";
    return {
      kind: "success",
      text: `${verb} ${done.placed} 项到 ${target}${done.note ? "，" + done.note : ""}${extra}`,
      refresh: true,
    };
  }
  if (done.selfSkipped > 0) {
    return { kind: "warning", text: "不能把一个文件夹放进它自己的子目录里", refresh: false };
  }
  return null;
}

/** 去掉尾部分隔符并统一斜杠："/a/b/"、"\\a\\b" 和 "/a/b" 指的是同一个目录 */
function normPath(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  const trimmed = slashed.replace(/\/+$/, "");
  return trimmed || "/"; // 只有根目录会被削成空串，它得留在 "/"
}

/**
 * src 搬进 destDir 会不会把自己搬空：src 就是落点，或者是落点的祖先目录。
 *
 * 后端 conflict.rs::displacement_guard 现在有同一道闸，这里先拦是为了两件事：
 * 给用户一句人话（而不是"移动的目标目录在源目录内部"这种带绝对路径的技术报错），
 * 以及不给"复制+删除"回退任何起跑的机会。
 */
export function blocksDisplacement(src: string, destDir: string): boolean {
  if (!src || !destDir) return false; // 空串不是路径，别把它归一成根目录后"谁的祖先都是它"
  const a = normPath(src);
  const b = normPath(destDir);
  // 根目录（"/"、Windows 的 "C:/"）是所有绝对路径的祖先，比较时不能再补一个斜杠
  const prefix = a.endsWith("/") ? a : `${a}/`;
  return a === b || b.startsWith(prefix);
}

/**
 * 一次拖拽算一批：动手前探一次同名，撞了才问一次，然后把选择原样交给后端。
 * 返回 null 表示用户取消 —— 这时一个文件都不该动。
 */
export async function placeBatch(
  destDir: string,
  items: BatchItem[],
  modal: ModalApi
): Promise<BatchResult | null> {
  // 拖到自己身上、或拖进自己的子目录，都会把自己搬空，先剔掉
  const eligible = items.filter(({ src }) => !blocksDisplacement(src, destDir));
  const selfSkipped = items.length - eligible.length;
  if (!eligible.length) return { placed: 0, note: "", selfSkipped };
  const names = eligible.map(({ src }) => baseName(src)).filter((n) => n.length > 0);
  const taken = await occupiedNames(destDir, names);
  const policy: ConflictPolicy | null = taken.length
    ? await askConflictPolicy(destDir, taken, modal)
    : "rename";
  if (!policy) return null;
  let placed = 0;
  for (const { src, mode } of eligible) {
    await invoke(mode === "copy" ? "copy_file" : "move_file", {
      srcPath: src,
      destDir,
      conflict: policy,
    });
    // 「跳过」下同名那几项其实原地没动，不能报成"已移动"
    if (!(policy === "skip" && taken.includes(baseName(src)))) placed += 1;
  }
  return { placed, note: conflictNote(policy, taken.length), selfSkipped };
}
