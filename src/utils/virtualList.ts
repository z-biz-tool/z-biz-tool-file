/**
 * 列表/网格虚拟化的纯计算部分 —— 与 DOM 无关，可单测（tests/virtualList.test.ts）。
 *
 * 一个目录动辄上万条，整表渲染会把几千个 DOM 节点一次性建出来；
 * 这里只回答"这一屏该渲染哪几行"。
 */

export interface WindowRequest {
  /** 条目总数 */
  itemCount: number;
  /** 每行几列（列表模式恒为 1） */
  columns: number;
  /** 单行像素高度（固定行高是窗口计算的前提） */
  rowHeight: number;
  /** 当前滚动偏移 */
  scrollTop: number;
  /** 可视区高度 */
  viewportHeight: number;
  /** 上下各多渲染几行，滚动时不至于露白 */
  bufferRows?: number;
}

export interface WindowResult {
  /** 首行行号（含） */
  firstRow: number;
  /** 末行行号（不含） */
  lastRow: number;
  /** 总行数 */
  totalRows: number;
  /** 窗口前需要顶开的像素 */
  padTop: number;
  /** 窗口后需要垫上的像素 */
  padBottom: number;
  /** 首条目下标（含） */
  firstIndex: number;
  /** 末条目下标（不含） */
  lastIndex: number;
}

export function computeWindow(req: WindowRequest): WindowResult {
  const columns = Math.max(1, Math.floor(req.columns) || 1);
  const rowHeight = Math.max(1, req.rowHeight);
  const totalRows = Math.ceil(req.itemCount / columns);
  const viewport = Math.max(0, req.viewportHeight) || rowHeight * 10;
  const buffer = Math.max(0, req.bufferRows ?? 4);

  if (req.itemCount === 0) {
    return { firstRow: 0, lastRow: 0, totalRows: 0, padTop: 0, padBottom: 0, firstIndex: 0, lastIndex: 0 };
  }

  const rawFirst = Math.floor(req.scrollTop / rowHeight) - buffer;
  const visibleRows = Math.ceil(viewport / rowHeight) + buffer * 2;
  const firstRow = clamp(rawFirst, 0, Math.max(0, totalRows - 1));
  const lastRow = clamp(firstRow + visibleRows, firstRow, totalRows);

  return {
    firstRow,
    lastRow,
    totalRows,
    padTop: firstRow * rowHeight,
    padBottom: Math.max(0, (totalRows - lastRow) * rowHeight),
    firstIndex: firstRow * columns,
    lastIndex: Math.min(req.itemCount, lastRow * columns),
  };
}

/** 让 index 这一行落进视口，返回该用的 scrollTop（不直接碰 DOM，便于单测） */
export function scrollIndexIntoView(
  index: number,
  req: WindowRequest & { currentScrollTop: number }
): number {
  if (index < 0) return req.currentScrollTop;
  const columns = Math.max(1, Math.floor(req.columns) || 1);
  const rowHeight = Math.max(1, req.rowHeight);
  const row = Math.floor(index / columns);
  const top = row * rowHeight;
  const bottom = top + rowHeight;
  const viewport = Math.max(0, req.viewportHeight);
  if (top < req.currentScrollTop) return top;
  if (bottom > req.currentScrollTop + viewport) return bottom - viewport;
  return req.currentScrollTop;
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** 按列数把一维条目切成整行（末行可能不满） */
export function chunkRows<T>(items: T[], columns: number): T[][] {
  const cols = Math.max(1, Math.floor(columns) || 1);
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return rows;
}

/**
 * 定长 LRU：缩略图是 base64 字符串，一个几千张图的目录能把 JS 堆吃空。
 * Map 保留插入顺序，命中就 delete+set 把它挪到队尾。
 */
export function createLru<V>(maxEntries: number) {
  const cap = Math.max(1, Math.floor(maxEntries) || 1);
  const store = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const hit = store.get(key);
      if (hit === undefined) return undefined;
      store.delete(key);
      store.set(key, hit);
      return hit;
    },
    set(key: string, value: V): void {
      store.delete(key);
      store.set(key, value);
      while (store.size > cap) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    get size(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
  };
}

/** 选择集：每行都要判"选中了吗"，O(rows × selected) 的 includes 换成 Set 查表 */
export function toKeySet(keys: readonly (string | number | bigint)[]): Set<string> {
  const set = new Set<string>();
  for (const k of keys) set.add(String(k));
  return set;
}

/** 区间选择：anchor → target（含两端），按列表顺序，反向也正确 */
export function selectRange(
  paths: readonly string[],
  anchor: string | null,
  target: string
): string[] {
  const to = paths.indexOf(target);
  if (to < 0) return [target];
  const from = anchor ? paths.indexOf(anchor) : to;
  if (from < 0) return [target];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return paths.slice(lo, hi + 1);
}
