/**
 * AI 任务看板板块的深链交接槽。
 *
 * 与终端（`apps/terminal/handoff.ts`）、系统监控（`apps/sys/handoff.ts`）同一个模式：
 *
 * 合并前 file 和 worker 是两个进程，各自注册一个 `zbiz://` 接收器没问题；
 * 合并进同一个 webview 之后就不行了 —— 共享层的接收器是**取走式**的
 * （`invoke(ZBIZ_TAKE_PENDING)` 会把队列整个清空），谁先跑谁拿走全部，
 * 另一个永远等到空数组，表现为「深链点了没反应」，且两条链路都不报错。
 *
 * 所以现在只留**一个**接收器（file 的 App.tsx，它常驻），按 `item.product`
 * 分流：属于 worker 的整条原样投到这里，由本板块自己解析
 * （`apps/worker/_shared/deepLink.ts` 的 `resolveWorkerDeepLink`）
 * 成「切到哪个视图 / 哪个项目 / 定位哪张任务卡」。
 *
 * 做发布订阅而不是读一次：用户已经在看板里时又来一条深链，
 * `setActiveApp("worker")` 是恒等的，React 不会重新挂载组件，
 * 只在挂载时读一次就拿不到这条。
 */
import type { Handoff } from "z-biz-tool-shared/protocol";

type Listener = (item: Handoff) => void;

const listeners = new Set<Listener>();
let pending: Handoff | null = null;

/** 投递一条属于工作台板块的深链。板块没挂载时先存着（只留最后一条）。 */
export function putWorkerHandoff(item: Handoff): void {
  if (listeners.size === 0) {
    pending = item;
    return;
  }
  for (const l of listeners) l(item);
}

/** 板块挂载时取走暂存的那条（取不到返回 null）。 */
export function takePendingWorkerHandoff(): Handoff | null {
  const p = pending;
  pending = null;
  return p;
}

/** 订阅后续深链，返回取消订阅函数。 */
export function subscribeWorkerHandoff(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}