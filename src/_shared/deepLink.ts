/**
 * zbiz:// 深链接的 **file 语义层**。
 *
 * ## 分工
 *
 * | 层 | 在哪 | 管什么 |
 * |----|----|--------|
 * | 协议 | `z-biz-tool-shared/protocol/deeplink` | 字节级编解码（金标 = Rust `cap-hub`） |
 * | 机制 | `z-biz-tool-shared/protocol/deeplinkReceiver` | 冷启动补取、事件监听、不静默吞掉 |
 * | **语义** | **本文件** | **收到深链后 file 该做什么** |
 *
 * ## file 支持的动作
 *
 * | action | 含义 | 参数 |
 * |--------|------|------|
 * | `open` | 定位一个文件 | `file`（绝对路径）、可选 `dir`（直接定位到目录） |
 * | `reveal` | 只定位到文件所在目录并选中它 | `file` |
 *
 * `open` 与 `reveal` 的区别：
 * - `open` 是用户明确说「我要打开这个文件」⇒ 切到父目录 + 选中该文件，
 *   由调用方决定是否真的打开预览。
 * - `reveal` 是「我只想让它出现在眼前」⇒ 同样切到父目录，但语义上不承诺打开。
 *
 * 之所以分成两个动作而不是一个，是因为**打开文件在 file 仓有副作用**
 * （大文件会触发解析、图片会触发解码、媒体会起播放），
 * 而「从 box 递过来一个文件」这种场景大多数只是想让用户看到它在哪。
 */

import type { Handoff } from "z-biz-tool-shared/protocol";

/**
 * Rust 侧 `cap_hub::Handoff` 的镜像。
 *
 * 名字叫 `HandoffItem` 是为了在本仓内部读起来更顺（本仓此前一直用这个名字），
 * 实质就是共享层的 `Handoff`。
 */
export type { Handoff as HandoffItem } from "z-biz-tool-shared/protocol";

/**
 * file 的深链结果。
 *
 * `path` 非 null 表示要定位到某个路径；
 * `problem` 非 null 表示接不住 —— 前端必须给可见提示（不静默吞掉）。
 */
export interface FileDeepLinkOutcome {
  /** 要定位的路径（文件或目录）；null 表示不带定位意图 */
  path: string | null;
  /** 是否要把这个文件真的打开（`reveal` 为 false） */
  shouldOpen: boolean;
  /** 发送方（from），仅用于提示与日志 */
  from: string | null;
  /** 无法适配时的原因 */
  problem: string | null;
}

/**
 * 把一条深链翻译成 file 内的动作。
 *
 * 纯函数 —— 不碰 store、不碰 Tauri，所以可以直接单测。
 *
 * @param item 深链
 */
export function resolveFileDeepLink(item: Handoff): FileDeepLinkOutcome {
  const outcome: FileDeepLinkOutcome = {
    path: null,
    shouldOpen: false,
    from: item.params.from ?? null,
    problem: null,
  };

  const action = item.action.trim() || "open";

  // `dir` 允许直接定位到一个目录（不经过父目录推导）。
  // 先取 file 再取 dir：file 更具体，优先级更高。
  const file = item.params.file?.trim() ?? "";
  const dir = item.params.dir?.trim() ?? "";

  if (dir && !file) {
    outcome.path = dir;
    outcome.shouldOpen = false;
    return outcome;
  }

  if (!file) {
    outcome.problem = "深链里没有 file 或 dir 参数";
    return outcome;
  }

  if (action === "open" || action === "reveal") {
    outcome.path = file;
    // 只有 `open` 才承诺打开；`reveal` 只保证「看得见」。
    outcome.shouldOpen = action === "open";
    return outcome;
  }

  outcome.problem = `不认识的动作 ${action}`;
  return outcome;
}
