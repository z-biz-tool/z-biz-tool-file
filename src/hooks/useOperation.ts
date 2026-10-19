/**
 * `useOperation` —— 批量操作（重命名 / 删除 / 移到回收站）的**进度 + 取消**。
 *
 * 台账 T4-07 的原话是「无该 hook；`src/hooks/` 下不存在」。这个 hook 就是那条的落点。
 *
 * 为什么是 hook 而不是又一个 store：批量重命名是**弹窗里的短命操作** ——
 * 关掉弹窗它就没意义了（不像 `archiveJobStore` 里的解压任务是应用级的后台任务，
 * 关掉窗口还在跑，那才该挂在 store 上）。短命操作的状态跟着组件走最省事。
 *
 * 状态机的规则全在 `src/utils/operationModel.ts`（纯逻辑，可单测）；
 * 这里只做两件事：把后端事件喂进去、把命令发出去。
 */
import { useCallback, useEffect, useReducer, useRef } from "react";

import {
  initialOperationState,
  isTerminal,
  reduceOperationState,
  type OperationProgress,
  type OperationState,
} from "../utils/operationModel";

/** 后端 `operation.rs` 的 `Kind` 取值 */
export type OperationKind = "rename" | "delete" | "trash";

/** 重命名参数（`operation.rs::RenameOptions` 的线上格式，camelCase） */
export interface RenameOptionsPayload {
  mode: string;
  findText?: string | null;
  replaceText?: string | null;
  prefix?: string | null;
  suffix?: string | null;
  startNumber?: number | null;
  step?: number | null;
  digits?: number | null;
  caseSensitive?: boolean | null;
}

export interface UseOperationResult {
  /** 当前进度；没有在跑的任务时为 null */
  progress: OperationProgress | null;
  /** 是否正在跑 */
  running: boolean;
  /** 启动失败时的错误信息 */
  error: string | null;
  /** 启动一个批量操作，返回任务 id；启动失败返回 null */
  start: (
    kind: OperationKind,
    paths: string[],
    rename?: RenameOptionsPayload
  ) => Promise<string | null>;
  /** 取消进行中的操作。返回 false = 后端账本里已经没有这个任务了 */
  cancel: () => Promise<boolean>;
  /** 清空状态（下次 start 之前调用） */
  reset: () => void;
}

export function useOperation(): UseOperationResult {
  const [state, dispatch] = useReducer(reduceOperationState, initialOperationState);

  // 订阅句柄放 ref 而不是 state：它是句柄不是"界面要渲染的数据"，
  // 进 state 只会让每次事件都产生一份看起来变了其实没变的快照。
  const unlistenRef = useRef<(() => void) | null>(null);
  // 订阅建立期间可能有事件早到：先记下来，等订阅就绪再补上
  const pendingRef = useRef<OperationProgress[]>([]);
  const operationIdRef = useRef<string | null>(null);

  const handleProgress = useCallback((p: OperationProgress) => {
    // 任务 id 还没拿到（订阅早于 start 返回）时先攒着
    if (!operationIdRef.current) {
      pendingRef.current.push(p);
      return;
    }
    dispatch({ type: "progress", progress: p });
  }, []);

  // 订阅只建一次，且在有任务时才建 —— 没有任务时订阅进度事件没有意义。
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const { OPERATION_PROGRESS_EVENT } = await import("../utils/operationModel");
        const un = await listen<OperationProgress>(OPERATION_PROGRESS_EVENT, (evt) => {
          if (!disposed) handleProgress(evt.payload);
        });
        // await 期间被清理了：句柄刚拿到就得退掉，否则漏一个永不清理的订阅
        if (disposed) {
          un();
          return;
        }
        off = un;
        unlistenRef.current = un;
      } catch (err) {
        console.error("订阅 operation-progress 失败:", err);
      }
    })();

    return () => {
      disposed = true;
      off?.();
      unlistenRef.current = null;
    };
  }, [handleProgress]);

  const start = useCallback(
    async (
      kind: OperationKind,
      paths: string[],
      rename?: RenameOptionsPayload
    ): Promise<string | null> => {
      if (operationIdRef.current) {
        return null;
      }
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const operationId = await invoke<string>("batch_operation", {
          kind,
          paths,
          rename: rename ?? null,
        });
        operationIdRef.current = operationId;
        dispatch({ type: "started", operationId });
        // 订阅建立前收到的进度，这时补上
        const pending = pendingRef.current;
        pendingRef.current = [];
        for (const p of pending) {
          dispatch({ type: "progress", progress: p });
        }
        return operationId;
      } catch (err) {
        dispatch({ type: "failed", error: String(err) });
        return null;
      }
    },
    []
  );

  const cancel = useCallback(async (): Promise<boolean> => {
    const operationId = operationIdRef.current;
    if (!operationId) return false;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const ok = await invoke<boolean>("cancel_operation", { operationId });
      return ok;
    } catch (err) {
      console.error("取消批量操作失败:", err);
      return false;
    }
  }, []);

  const reset = useCallback(() => {
    operationIdRef.current = null;
    pendingRef.current = [];
    dispatch({ type: "reset" });
  }, []);

  // 任务到终态后把"当前任务"清掉：用户可以接着再跑一个。
  // 用终态判定而不是"收到一个事件就清"，否则会漏掉最后一条进度。
  useEffect(() => {
    if (state.progress && isTerminal(state.progress.phase)) {
      operationIdRef.current = null;
    }
  }, [state.progress]);

  return {
    progress: state.progress,
    running: state.operationId !== null && !(state.progress && isTerminal(state.progress.phase)),
    error: state.error,
    start,
    cancel,
    reset,
  };
}

export type { OperationProgress, OperationState };
