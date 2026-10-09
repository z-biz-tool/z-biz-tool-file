/**
 * 归档任务的进度账本。
 *
 * 为什么单独一个 store 而不是塞进 ArchiveExplorer 的局部 state：解压/压缩是**后台任务**，
 * 关掉浏览窗口它还在跑。进度如果只活在弹窗里，用户一关窗就再也看不到"那个 7 GB 的包解到
 * 哪了"，也点不到取消——只能去任务管理器杀进程，而这台机器上杀进程曾经连带触发过
 * Autodesk 许可锁死。所以进度挂在应用级，弹窗只是它的一个观察者。
 *
 * 事件订阅放在这里而不是组件里，也是同一个理由：订阅要活得比任何一个组件都久。
 */
import { create } from "zustand";

import { isJobRunning, type ArchiveProgress } from "../utils/archiveModel";

/** 与 `src-tauri/src/archive/job.rs::PROGRESS_EVENT` 同名 */
const PROGRESS_EVENT = "archive-progress";

/**
 * 账本上限。撞上限时先扔**最旧的已结束**任务；全都还在跑就一个不扔——
 * 扔掉一个活跃任务，它的后续进度就再也没人收了，取消按钮也会跟着消失。
 */
const MAX_JOBS = 50;

type Unlisten = () => void;

// 这三个都放在模块级而不是 state 里：它们是句柄和计数器，不是"界面要渲染的数据"。
// 进 state 只会让每次 upsert 都产生一份看起来变了其实没变的快照，订阅方跟着白重渲染。
let unlisten: Unlisten | null = null;
let starting: Promise<void> | null = null;
let generation = 0;

interface ArchiveJobStore {
  /** 新的在前。任务列表直接渲染这个数组，不再排序。 */
  jobs: ArchiveProgress[];
  listening: boolean;
  upsert: (p: ArchiveProgress) => void;
  dismiss: (jobId: string) => void;
  clearFinished: () => void;
  startListening: () => Promise<void>;
  stopListening: () => void;
  cancel: (jobId: string) => Promise<boolean>;
}

export const useArchiveJobStore = create<ArchiveJobStore>((set, get) => ({
  jobs: [],
  listening: false,

  upsert: (p) =>
    set((s) => {
      const i = s.jobs.findIndex((j) => j.jobId === p.jobId);
      let jobs: ArchiveProgress[];
      if (i < 0) {
        jobs = [p, ...s.jobs];
      } else {
        const prev = s.jobs[i];
        // 终态是最终的。进度事件是节流发的，极端情况下会先收到 done 再收到一个在途快照，
        // 让它盖回去的话列表里就留了一个永远转圈、点取消也停不下来的任务
        if (!isJobRunning(prev) && isJobRunning(p)) return s;
        jobs = s.jobs.slice();
        jobs[i] = p;
      }
      if (jobs.length > MAX_JOBS) {
        for (let k = jobs.length - 1; k >= 0 && jobs.length > MAX_JOBS; k -= 1) {
          if (!isJobRunning(jobs[k])) jobs.splice(k, 1);
        }
      }
      return { jobs };
    }),

  dismiss: (jobId) => set((s) => ({ jobs: s.jobs.filter((j) => j.jobId !== jobId) })),

  clearFinished: () => set((s) => ({ jobs: s.jobs.filter(isJobRunning) })),

  startListening: async () => {
    // 并发调用只订阅一次：App 挂载和 ArchiveExplorer 挂载可能同时触发，
    // 订两遍的后果是每个事件被处理两次
    if (unlisten || starting) {
      await starting;
      return;
    }
    const gen = ++generation;
    starting = (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<ArchiveProgress>(PROGRESS_EVENT, (evt) => {
          get().upsert(evt.payload);
        });
        // await 期间被 stopListening 打断了：句柄刚拿到就得退掉，否则漏一个永不清理的订阅
        if (gen !== generation) {
          off();
          return;
        }
        unlisten = off;
        set({ listening: true });
      } catch (err) {
        console.error("订阅 archive-progress 失败:", err);
      } finally {
        starting = null;
      }
    })();
    await starting;
  },

  stopListening: () => {
    generation += 1;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    set({ listening: false });
  },

  cancel: async (jobId) => {
    const { invoke } = await import("@tauri-apps/api/core");
    // 返回 false = 后端账本里没这个任务（已经结束并被清掉了）。这不是错误，
    // 界面上该显示的是"任务已经结束"，而不是一句失败提示
    return await invoke<boolean>("archive_cancel", { jobId });
  },
}));

/** 活跃任务数。工具栏角标用它，抽成函数省得每个调用方各写一遍 filter。 */
export function selectActiveCount(jobs: ArchiveProgress[]): number {
  return jobs.filter(isJobRunning).length;
}
