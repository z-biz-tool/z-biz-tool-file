import { homeDir } from "@tauri-apps/api/path";

let cached: string | null = null;
let pending: Promise<string> | null = null;

function normalize(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  return trimmed.length ? trimmed : "/";
}

/** 解析当前用户主目录（跨平台），结果永久缓存，并发调用共享同一个 Promise */
export function resolveHomeDir(): Promise<string> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = homeDir()
      .then((p) => {
        cached = normalize(p);
        return cached;
      })
      .catch(() => {
        cached = "/";
        return cached;
      });
  }
  return pending;
}

/** 同步读取已缓存的主目录；尚未解析完成时回退到根目录 */
export function homeDirSync(): string {
  return cached ?? "/";
}

/** 把绝对路径缩写为 ~ / ~/xxx，用于标签标题与面包屑 */
export function shortenHome(path: string): string {
  const home = cached;
  if (!home || home === "/" || !path) return path;
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~/" + path.slice(home.length + 1) : path;
}

// 导入即预热，让同步调用方尽早拿到真实主目录
resolveHomeDir();
