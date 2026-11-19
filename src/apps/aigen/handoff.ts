/**
 * AI 内容工厂板块的深链交接槽。
 *
 * 合并前 aigen 是独立进程，自己注册一个 `zbiz://` 接收器；并入 file 后不能这样了 ——
 * 共享层的接收器是**取走式**的（`invoke(ZBIZ_TAKE_PENDING)` 会清空整个队列），
 * 两个接收器会互抢，表现为「深链点了没反应」且两边都不报错。
 *
 * 现在只留 file 的 App.tsx 一个接收器，按 `item.product === "aigen"` 分流到这里，
 * 由本板块自己解析成「切到哪个生成模式 / 带什么提示词 / 带哪张参考图」。
 *
 * 板块是 lazy 加载的，深链可能早于挂载；用户已在板块里时 `setActiveApp("aigen")`
 * 又是恒等的、不会重新挂载。所以做成发布订阅：有监听者直接推，没有就先存一条。
 */
import type { Handoff } from "z-biz-tool-shared/protocol";

type Listener = (item: Handoff) => void;

const listeners = new Set<Listener>();
let pending: Handoff | null = null;

/** 投递一条属于 AI 内容工厂板块的深链。板块没挂载时先存着。 */
export function putAigenHandoff(item: Handoff): void {
  if (listeners.size === 0) {
    // 只留最后一条：深链是「现在要看这个」，连按多次时前面的已经过时了
    pending = item;
    return;
  }
  for (const l of listeners) l(item);
}

/** 板块挂载时取走暂存的那条（取不到返回 null）。 */
export function takePendingAigenHandoff(): Handoff | null {
  const p = pending;
  pending = null;
  return p;
}

/** 订阅后续深链，返回取消订阅函数。 */
export function subscribeAigenHandoff(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
