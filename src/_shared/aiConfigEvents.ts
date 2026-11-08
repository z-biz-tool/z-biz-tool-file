/**
 * AI 配置是整窗一份（Rust `llm_config`），但读它的板块有好几个。
 *
 * 保存动作可能发生在设置中心、数据库板块自己的弹窗、以后还会有别的入口。
 * 与其让每个板块互相 import，不如用一枚窗口级事件广播「配置刚被改过」：
 * 谁关心「现在能不能发请求」谁自己监听刷新。
 *
 * 这个文件刻意零依赖、零 React —— 活动栏底部那个常驻状态点要读它，
 * 不能因为顺手 import 就把整个设置弹窗拖进首屏 bundle。
 */

export const AI_CONFIG_SAVED_EVENT = "zbiz:ai-config-saved";

export function notifyAiConfigSaved() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AI_CONFIG_SAVED_EVENT));
}

export function onAiConfigSaved(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(AI_CONFIG_SAVED_EVENT, handler);
  return () => window.removeEventListener(AI_CONFIG_SAVED_EVENT, handler);
}

/**
 * 数据库连接态由 db 板块自己知道，账户区只负责显示。
 * 同样走窗口事件：主壳不必 import 数据库板块的内部状态。
 */
export const DB_CONNECTION_EVENT = "zbiz:db-connection";

export function notifyDbConnection(label: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<string>(DB_CONNECTION_EVENT, { detail: label }));
  }
}

export function onDbConnection(handler: (label: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<string>).detail || "未连接");
  window.addEventListener(DB_CONNECTION_EVENT, listener);
  return () => window.removeEventListener(DB_CONNECTION_EVENT, listener);
}
