/**
 * worker 板块的提示通道桥（message 实例注入点）。
 *
 * 为什么需要它：file 的门禁要求全站提示条走 `<AntdApp>` context（静态
 * `message.xxx` 吃不到主题/locale，会弹成白底黑字）。但 worker 有一个
 * **不是组件**的模块 —— `stores/workerStore.ts` —— 它不能调用 React hook
 * （`App.useApp()` 只在组件/自定义 hook 里合法），却会发 message。
 *
 * 于是这里放一个模块级变量：组件在 `App.useApp()` 拿到实例后，通过
 * `bindMessage()` 塞进来；store（以及任何非组件代码）通过 `wm()` 读。
 * 组件内部仍建议直接用 `App.useApp()` 的局部实例，这个桥只服务 store。
 *
 * 使用顺序保证：App 挂载时 bind 之后，store 的方法才会被用户触发，
 * 所以不会出现「store 先 fire、桥还是 null」的窗口。
 */
import type { MessageInstance } from "antd/es/message/interface";

let bound: MessageInstance | null = null;

/** WorkerApp 挂载时调用一次：把 context 实例交给 store 用。 */
export function bindWorkerMessage(instance: MessageInstance): void {
  bound = instance;
}

/** store / 非组件代码的提示入口。桥未绑定时静默（按组件不会先于 App 跑的约定）。 */
export function wm(): MessageInstance {
  // 兜底：如果真在 bind 之前 fire，退回一个"什么都不做"的桩，而不是炸掉
  if (!bound) {
    return new Proxy({} as MessageInstance, {
      get: () => () => undefined,
    });
  }
  return bound;
}