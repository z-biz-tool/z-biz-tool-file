/**
 * 构建信息注入点。
 *
 * 这三个常量由 vite.config.ts 在**构建时**用 `define` 替换成真实值，所以：
 * - `npm run dev` 下是 "dev"（本地热改没法给一个诚实的时间戳）；
 * - `npm run tauri build` 打包时才是"打包那一刻"的版本号 / 时间 / git 哈希。
 *
 * 用途：顶部透出版本信息，让用户（和开发者自己）一眼能看出"这个包是什么
 * 时候打的、对应哪个 commit"——否则分不清手里这份是不是最新的。
 */
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
declare const __GIT_HASH__: string;

/** 语义版本号，如 "0.2.2"；dev 态为 "dev"。 */
export const APP_VERSION: string = __APP_VERSION__;

/** 本地可读的构建时刻，如 "2026-11-07 08:21"；dev 态为 "—"。 */
export const BUILD_TIME: string = __BUILD_TIME__;

/** 触发本次构建的 git 短哈希（7 位）；dev 态为 "—"。 */
export const GIT_HASH: string = __GIT_HASH__;