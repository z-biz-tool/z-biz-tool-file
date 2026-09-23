/**
 * "一次 Esc 只关最上面那一层"的判定。
 *
 * 原来 App 里是一串手写 if/else，23 个弹窗状态里只列了 12 个：
 * 剩下的（照片馆、回收站、设置、快速操作、归档、PDF、对比、OCR、离线下载、更新、
 * 存储分析、SFTP、标签编辑）全靠 antd Modal 自己的键盘行为兜底，
 * 于是新加一个面板很容易就变成"Esc 没反应"或者"一次 Esc 关掉两层"。
 * 把顺序与"当前开着谁"分开成数据， closers 只管动手。
 */
export type LayerState = Record<string, boolean>;

/** 按给定优先级返回当前开着的最上面一层；都没开返回 null */
export function topmostLayer(order: readonly string[], open: LayerState): string | null {
  for (const name of order) {
    if (open[name]) return name;
  }
  return null;
}
