/**
 * 批量操作的进度状态机（T2-05 / T2-06 / T4-07 的前端一半）。
 *
 * 为什么单独一个纯逻辑模块，而不是把状态写在 hook 里：
 * 状态机是**最容易出错又最难测**的部分（终态被在途快照盖回去、不同任务的进度串台、
 * 取消后还在涨的百分比），而 React hook 在本仓的 vitest 配置下**测不了**
 * （`environment: "node"`，没有 DOM，也没有 @testing-library/react）。
 * 所以规则全放这里，hook 只做「把事件喂进来、把命令发出去」这一层薄适配。
 */

/**
 * 与 `src-tauri/src/operation.rs::Progress` 一一对应（Rust 侧挂了 `rename_all = "camelCase"`）。
 */
export interface OperationProgress {
  operationId: string;
  /** rename / delete / trash */
  kind: string;
  /** running / done / cancelled / error */
  phase: string;
  /** 一共要处理多少项 */
  total: number;
  /** 已经处理过多少项（取消后剩下的项不算） */
  processed: number;
  succeeded: number;
  failed: number;
  /** 当前正在处理的文件名 */
  current: string;
  /** 0..100 */
  percent: number;
  message: string;
  errors: string[];
}

/** 与 `src-tauri/src/operation.rs::PROGRESS_EVENT` 同名。 */
export const OPERATION_PROGRESS_EVENT = "operation-progress";

/** 终态是最终的：到了就别再被在途快照盖回去。 */
export function isTerminal(phase: string): boolean {
  return phase === "done" || phase === "cancelled" || phase === "error";
}

export function isRunning(phase: string): boolean {
  return !isTerminal(phase);
}

/** 后端保证 0..100，但前端不该假设收到的数一定合法。 */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  if (percent < 0) return 0;
  if (percent > 100) return 100;
  return percent;
}

export interface OperationState {
  /** 当前任务 id；null = 没在跑任务 */
  operationId: string | null;
  progress: OperationProgress | null;
  error: string | null;
}

export const initialOperationState: OperationState = {
  operationId: null,
  progress: null,
  error: null,
};

export type OperationAction =
  | { type: "started"; operationId: string }
  | { type: "progress"; progress: OperationProgress }
  | { type: "failed"; error: string }
  | { type: "reset" };

/**
 * 状态机的全部规则都在这里。hook 只是 `dispatch` 的调用方。
 *
 * 三条规则，每条都对应一类真实踩过的坑：
 * 1. **不同任务的进度不串台**：`operationId` 对不上就整条丢掉。
 *    否则并发起两个批量操作时，A 的进度会盖到 B 的界面上。
 * 2. **终态不被在途快照盖回去**：进度事件是节流发的，终态之后可能还收到一个在途快照。
 *    让它盖回去，界面就永远转圈、取消按钮也点不动（这与 `archiveJobStore` 是同一个坑）。
 * 3. **percent 一律夹到 0..100**：界面上写死宽度，数字越界就是布局崩掉。
 */
export function reduceOperationState(
  state: OperationState,
  action: OperationAction
): OperationState {
  switch (action.type) {
    case "started":
      return { operationId: action.operationId, progress: null, error: null };

    case "progress": {
      const next = action.progress;
      // 规则 1：不是当前任务的进度，整条丢掉。
      if (!state.operationId || next.operationId !== state.operationId) {
        return state;
      }
      // 规则 2：已经终态就别被在途快照盖回去。
      if (state.progress && isTerminal(state.progress.phase) && !isTerminal(next.phase)) {
        return state;
      }
      return {
        ...state,
        progress: { ...next, percent: clampPercent(next.percent) },
      };
    }

    case "failed":
      return { ...state, error: action.error };

    case "reset":
      return { ...initialOperationState };

    default:
      return state;
  }
}

/**
 * 给界面用的一行话。`current` 有值时把它带上——用户要知道**现在动的是哪个文件**。
 */
export function describeProgress(progress: OperationProgress | null): string {
  if (!progress) return "";
  if (progress.phase === "done") {
    const failed = progress.failed > 0 ? `，失败 ${progress.failed} 项` : "";
    return `已完成 ${progress.processed} 项${failed}`;
  }
  if (progress.phase === "cancelled") {
    return `已取消（处理了 ${progress.processed} / ${progress.total} 项）`;
  }
  if (progress.phase === "error") {
    return progress.message || "操作失败";
  }
  const current = progress.current ? `：${progress.current}` : "";
  return `处理中 ${progress.processed} / ${progress.total}${current}`;
}
