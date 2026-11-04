/**
 * 终端板块的深链交接槽。
 *
 * ## 为什么需要这个文件
 *
 * 合并前 file 和 terminal 是两个进程，各自注册一个 `zbiz://` 接收器没问题。
 * 合并进同一个 webview 之后就不行了：共享层的接收器是**取走式**的
 * （`invoke(ZBIZ_TAKE_PENDING)` 会把队列整个清空），谁先跑谁拿走全部，
 * 另一个永远等到空数组 —— 表现为「深链点了没反应」，且两条链路都不会报错。
 *
 * 所以现在只留**一个**接收器（file 的 App.tsx），它按 `item.product` 分流：
 * 属于 terminal 的整条原样投到这里，由终端板块自己解析成「连哪台服务器」。
 *
 * ## 为什么要订阅而不是读一次
 *
 * 用户已经在终端板块时又来一条深链，此时 `setActiveApp("terminal")` 是恒等的，
 * React 不会重新挂载组件，只在挂载时读一次就拿不到这条。所以做成发布订阅：
 * 有监听者就直接推，没有（板块还没加载）就先存着，等挂载时取。
 */
import type { Handoff } from "z-biz-tool-shared/protocol";

type Listener = (item: Handoff) => void;

const listeners = new Set<Listener>();
let pending: Handoff | null = null;

/** 投递一条属于终端的深链。板块没挂载时先存着。 */
export function putTerminalHandoff(item: Handoff): void {
  if (listeners.size === 0) {
    // 只留最后一条：深链是「现在要连这台」，连按多次时前面的已经过时了
    pending = item;
    return;
  }
  for (const l of listeners) l(item);
}

/** 板块挂载时取走暂存的那条（取不到返回 null）。 */
export function takePendingTerminalHandoff(): Handoff | null {
  const p = pending;
  pending = null;
  return p;
}

/** 订阅后续深链，返回取消订阅函数。 */
export function subscribeTerminalHandoff(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
