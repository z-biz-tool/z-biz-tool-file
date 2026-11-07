import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 构建信息注入（顶栏版本号用）────────────────────────────────────────
// 打包时把「当前版本号 / 构建时刻 / git 短哈希」写死进产物，前端 src/_shared/version.ts
// 从 __APP_VERSION__ / __BUILD_TIME__ / __GIT_HASH__ 三个全局读。
// 这样用户一眼能看出手里这份是什么时候打的、对应哪个 commit ——
// 不至于分不清“这个 file 是不是最新的”。
function buildMeta() {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));
  let hash = "—";
  try {
    hash = execSync("git rev-parse --short HEAD", { cwd: __dirname })
      .toString()
      .trim();
  } catch {
    // 构建目录不在 git 里（比如 CI 拉的是 tarball），退回占位符
  }
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
  return {
    __APP_VERSION__: JSON.stringify(pkg.version ?? "0.0.0"),
    __BUILD_TIME__: JSON.stringify(time),
    __GIT_HASH__: JSON.stringify(hash),
  };
}

export default defineConfig({
  plugins: [react()],
  define: buildMeta(),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 2026-11-06 性能优化：把体积大且**跨板块共用**的依赖拆成独立 chunk。
        //
        // 起因：主 bundle 一度 1.7MB，antd 独占 1445KB（icons 367KB、
        // rc-component ~800KB）。首屏真正要用的只是 Layout/Button/Input 那一小撮，
        // 但 antd 是"全量进主 chunk"的 —— 于是启动时要下载 + 解析 + JIT 编译
        // 一大坨首屏用不到的代码。实测那 6.6 秒 CPU 主要就烧在
        // JSC 的 DFG 编译（ByteCodeParser / B3 优化）与首屏布局绘制上。
        //
        // 拆分的收益有两层：
        // 1. **首屏不必等**：拆出的 chunk 由 lazy 组件（终端/图书馆/数据库）
        //    或弹窗面板按需触发，不挡首屏；
        // 2. **跨版本复用缓存**：这些 chunk 的内容 hash 只在依赖变化时才变，
        //    应用小版本升级时浏览器/WebView 缓存能命中。
        //
        // 刻意**不**把 antd 整个拆成一个大 chunk —— 那样等于只是换个文件名，
        // 首屏该等的还是得等。拆的粒度是"用在哪、什么时候才需要"。
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          const p = id.replace(/\\/g, "/");

          // ── 共享核心：react 生态 + es-toolkit，**显式划给主 chunk** ──
          //
          // rollup 的 manualChunks 里返回 undefined 只是"不指定"，
          // 它仍会按**依赖就近原则**自动分配 —— 某个库若只被某个 vendor 包
          // 消费，就会被拖进那个 vendor chunk；主 chunk 于是不得不静态
          // import 那个 vendor chunk 才能拿到它，"按需加载"退化成
          // "照样首屏加载"。
          //
          // 实测踩过三轮，每一轮主 bundle 都纹丝不动：
          //  ① vendor-charts 里躺着 react-dom + react-is；
          //  ② react-dom 挪走后，es-toolkit 留在 vendor-charts；
          //  ③ es-toolkit 也标"不指定"了 —— 结果它照样被 recharts 拖走。
          //
          // 解法：**显式返回一个主 chunk 的名字**，而不是 undefined。
          // 这样无论谁消费它，它都留在主 chunk 里。
          const isSharedCore =
            /node_modules\/(react|react-dom|react-is|scheduler|es-toolkit)\//.test(id);
          if (isSharedCore) return "index";

          // 终端：xterm + ssh 相关，只在切到终端板块时才需要
          if (/node_modules\/(@xterm\/xterm|@xterm\/addon-fit|@xterm\/addon-webgl)/.test(id)) {
            return "vendor-terminal";
          }
          // SQL 编辑器：CodeMirror，只在切到数据库板块时才需要
          if (/node_modules\/(@codemirror|@lezer|codemirror)\//.test(id)) {
            return "vendor-codemirror";
          }
          // 图表：recharts（连它独占的 redux 生态与 d3-*）
          if (
            /node_modules\/recharts\//.test(id) ||
            /node_modules\/d3-[a-z]+\//.test(id) ||
            /node_modules\/(@reduxjs\/toolkit|react-redux|immer|reselect|redux)\//.test(id) ||
            /node_modules\/(internmap|delaunator|robust-predicates|decimal\.js-light)\//.test(id)
          ) {
            return "vendor-charts";
          }
          // 语法高亮：react-syntax-highlighter / highlight.js
          if (/node_modules\/(react-syntax-highlighter|refractor|highlight\.js|prismjs)\//.test(id)) {
            return "vendor-highlight";
          }
          // antd 的图标集：单独成一个 chunk。图标多（252KB）且分散在各文件，
          // 拆开后不会把整个 antd 拖下水。
          if (/node_modules\/@ant-design\/icons/.test(id)) {
            return "vendor-antd-icons";
          }
          return undefined;
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
