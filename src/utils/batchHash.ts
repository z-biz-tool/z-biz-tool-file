import { invoke } from "@tauri-apps/api/core";

export interface HashTarget {
  path: string;
  name: string;
}

export interface HashRow extends HashTarget {
  hash: string;
  error: string;
}

/**
 * 哈希要把整个文件读一遍，全选上千个文件时一次性发出去只会把磁盘打满、
 * 进度条变成噪声；4 路并发已经能吃满顺序读带宽。
 */
export const HASH_CONCURRENCY = 4;

const defaultHashOne = (path: string, algorithm: string) =>
  invoke<string>("calculate_file_hash", { path, algorithm });

/**
 * 批量算哈希：结果始终按传入顺序返回，单个文件失败只记在那一行，
 * 不会像 Promise.all 那样把整批结果一起带走。
 */
export async function computeHashes(
  targets: HashTarget[],
  algorithm: string,
  onProgress?: (done: number, total: number) => void,
  hashOne: (path: string, algorithm: string) => Promise<string> = defaultHashOne,
): Promise<HashRow[]> {
  const rows: HashRow[] = targets.map((t) => ({ ...t, hash: "", error: "" }));
  let next = 0;
  let done = 0;
  const lane = async () => {
    while (next < rows.length) {
      const i = next++;
      try {
        rows[i].hash = await hashOne(rows[i].path, algorithm);
      } catch (err) {
        rows[i].error = String(err);
      }
      done += 1;
      onProgress?.(done, rows.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HASH_CONCURRENCY, rows.length) }, lane),
  );
  return rows;
}

/// 复制出去的文本对齐 `sha256sum` 的 `哈希␣␣文件名` 格式，方便直接粘进校验脚本；
/// 失败的文件以注释行保留，免得用户以为它没有参与计算。
export function formatHashReport(rows: HashRow[]): string {
  return rows
    .map((r) => (r.error ? `# ${r.name}: ${r.error}` : `${r.hash}  ${r.name}`))
    .join("\n");
}

export function countHashFailures(rows: HashRow[]): number {
  return rows.filter((r) => r.error).length;
}
