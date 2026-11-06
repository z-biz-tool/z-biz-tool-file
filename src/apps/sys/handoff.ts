/**
 * 系统监控板块的深链交接槽。
 *
 * ## 为什么需要这个文件
 *
 * 和终端板块（`apps/terminal/handoff.ts`）是同一个问题：合并前 file 和 sys
 * 是两个进程，各自注册一个 `zbiz://` 接收器没问题；合并进同一个 webview 之后
 * 就不行了 —— 共享层的接收器是**取走式**的（`invoke(ZBIZ_TAKE_PENDING)` 会把
 * 队列整个清空），谁先跑谁拿走全部，另一个永远等到空数组，表现为
 * 「深链点了没反应」，而且两条链路都不会报错。
 *
 * 所以现在只留**一个**接收器（file 的 App.tsx，它常驻），按 `item.product` 分流：
 * 属于 sys 的整条原样投到这里，由系统板块自己解析成「切哪个 tab / 按哪个 pid 过滤」。
 *
 * ## 为什么要订阅而不是读一次
 *
 * 用户已经在系统板块时又来一条深链，此时 `setActiveApp("sys")` 是恒等的，
 * React 不会重新挂载组件，只在挂载时读一次就拿不到这条。所以做成发布订阅：
 * 有监听者就直接推，没有（板块还没加载）就先存着，等挂载时取。
 */
import type { Handoff } from "z-biz-tool-shared/protocol";

type Listener = (item: Handoff) => void;

const listeners = new Set<Listener>();
let pending: Handoff | null = null;

/** 投递一条属于系统板块的深链。板块没挂载时先存着。 */
export function putSysHandoff(item: Handoff): void {
  if (listeners.size === 0) {
    // 只留最后一条：深链是「现在要看这个」，连按多次时前面的已经过时了
    pending = item;
    return;
  }
  for (const l of listeners) l(item);
}

/** 板块挂载时取走暂存的那条（取不到返回 null）。 */
export function takePendingSysHandoff(): Handoff | null {
  const p = pending;
  pending = null;
  return p;
}

/** 订阅后续深链，返回取消订阅函数。 */
export function subscribeSysHandoff(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
