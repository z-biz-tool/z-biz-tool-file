/**
 * 文件类型视觉识别：按扩展名返回颜色 + antd 图标 + 中文标签
 * 模仿 macOS Finder 的"按 kind 着色"风格，让文件列表一眼可分辨类型
 */
import React from "react";
import {
  FolderOutlined,
  FolderOpenOutlined,
  FileOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  FileExcelOutlined,
  FilePptOutlined,
  FileZipOutlined,
  FileMarkdownOutlined,
  FileTextOutlined,
  CodeOutlined,
  Html5Outlined,
  PlayCircleOutlined,
  SoundOutlined,
  GithubOutlined,
  DatabaseOutlined,
  AppstoreOutlined,
  ProfileOutlined,
} from "@ant-design/icons";

export interface FileTypeVisual {
  /** 主题色（图标/色条/标签都用） */
  color: string;
  /** 中文类型标签 */
  label: string;
  /** 渲染用图标 */
  icon: React.ReactNode;
  /** 扩展名匹配的"kind"标识（用于批量按类型筛选） */
  kind: string;
}

const TEXT_COLOR = "#8c8c8c";

/**
 * 把扩展名分类到 kind + 颜色
 * 颜色取自 antd 色板（保证 light/dark 主题下都不刺眼）
 */
const KINDS: { kind: string; color: string; label: string; exts: string[] }[] = [
  // —— 文件夹 ——
  { kind: "folder", color: "#faad14", label: "文件夹", exts: [] }, // 单独处理 is_dir

  // —— 代码 / 文本（蓝色） ——
  {
    kind: "code-js",
    color: "#1677ff",
    label: "JavaScript / TypeScript",
    exts: ["js", "jsx", "ts", "tsx", "mjs", "cjs"],
  },
  {
    kind: "code-frontend",
    color: "#1677ff",
    label: "前端代码",
    exts: ["html", "htm", "css", "scss", "less", "vue", "svelte"],
  },
  {
    kind: "code-python",
    color: "#1677ff",
    label: "Python",
    exts: ["py", "pyi", "pyc", "pyx"],
  },
  {
    kind: "code-rust",
    color: "#fa8c16",
    label: "Rust",
    exts: ["rs", "toml"],
  },
  {
    kind: "code-go",
    color: "#1677ff",
    label: "Go",
    exts: ["go"],
  },
  {
    kind: "code-java",
    color: "#f5222d",
    label: "Java / JVM",
    exts: ["java", "kt", "scala", "groovy"],
  },
  {
    kind: "code-cpp",
    color: "#722ed1",
    label: "C / C++ / 系统",
    exts: ["c", "cpp", "cc", "cxx", "h", "hpp", "m", "mm"],
  },
  {
    kind: "code-csharp",
    color: "#722ed1",
    label: "C# / .NET",
    exts: ["cs"],
  },
  {
    kind: "code-shell",
    color: "#52c41a",
    label: "Shell / 脚本",
    exts: ["sh", "bash", "zsh", "fish", "bat", "cmd", "ps1"],
  },
  {
    kind: "code-ruby",
    color: "#f5222d",
    label: "Ruby",
    exts: ["rb"],
  },
  {
    kind: "code-php",
    color: "#722ed1",
    label: "PHP",
    exts: ["php"],
  },
  {
    kind: "code-swift",
    color: "#fa8c16",
    label: "Swift / Apple",
    exts: ["swift"],
  },
  {
    kind: "code-sql",
    color: "#eb2f96",
    label: "SQL / 数据库",
    exts: ["sql", "ddl", "dml"],
  },
  {
    kind: "code-config",
    color: "#13c2c2",
    label: "配置 / 数据",
    exts: ["json", "yaml", "yml", "ini", "conf", "env", "xml", "plist"],
  },
  {
    kind: "code-log",
    color: "#bfbfbf",
    label: "日志",
    exts: ["log"],
  },

  // —— 文档（红色系） ——
  { kind: "pdf", color: "#f5222d", label: "PDF 文档", exts: ["pdf"] },
  { kind: "word", color: "#2f54eb", label: "Word 文档", exts: ["doc", "docx", "odt", "rtf"] },
  { kind: "excel", color: "#52c41a", label: "表格", exts: ["xls", "xlsx", "ods", "csv", "tsv"] },
  { kind: "ppt", color: "#fa8c16", label: "演示", exts: ["ppt", "pptx", "odp", "key"] },
  { kind: "markdown", color: "#1677ff", label: "Markdown", exts: ["md", "markdown"] },
  { kind: "ebook", color: "#722ed1", label: "电子书", exts: ["epub", "mobi", "azw3", "fb2"] },

  // —— 媒体（彩色） ——
  { kind: "image", color: "#eb2f96", label: "图片", exts: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif", "heic", "heif", "raw"] },
  { kind: "video", color: "#f5222d", label: "视频", exts: ["mp4", "webm", "ogg", "mov", "avi", "mkv", "m4v", "flv", "wmv"] },
  { kind: "audio", color: "#13c2c2", label: "音频", exts: ["mp3", "wav", "flac", "aac", "m4a", "wma", "ogg", "opus", "ape"] },

  // —— 归档（棕色） ——
  { kind: "archive", color: "#8c6e54", label: "压缩包", exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "tbz2", "dmg", "iso"] },

  // —— 字体 ——
  { kind: "font", color: "#9254de", label: "字体", exts: ["ttf", "otf", "woff", "woff2", "eot"] },

  // —— 数据库 ——
  { kind: "database", color: "#08979c", label: "数据库", exts: ["db", "sqlite", "sqlite3", "mdb", "accdb"] },

  // —— 可执行 / 安装包 ——
  { kind: "exec", color: "#595959", label: "可执行", exts: ["exe", "msi", "app", "pkg", "deb", "rpm", "apk", "ipa"] },

  // —— 设计 ——
  { kind: "design", color: "#fa541c", label: "设计文件", exts: ["psd", "ai", "sketch", "fig", "xd", "afdesign", "afphoto"] },

  // —— 3D / 模型 ——
  { kind: "model3d", color: "#73d13d", label: "3D 模型", exts: ["obj", "fbx", "gltf", "glb", "stl", "3ds", "blend"] },

  // —— 普通文本兜底 ——
  { kind: "text", color: TEXT_COLOR, label: "文本", exts: ["txt", "text"] },
];

const KIND_BY_EXT = new Map<string, { kind: string; color: string; label: string }>();
for (const k of KINDS) {
  if (k.kind === "folder") continue;
  for (const ext of k.exts) {
    KIND_BY_EXT.set(ext, { kind: k.kind, color: k.color, label: k.label });
  }
}

/** antd 图标按 kind 映射 */
function iconForKind(kind: string): React.ReactNode {
  switch (kind) {
    case "code-js":
    case "code-frontend":
      return <Html5Outlined />;
    case "code-python":
    case "code-rust":
    case "code-go":
    case "code-java":
    case "code-cpp":
    case "code-csharp":
    case "code-ruby":
    case "code-php":
    case "code-swift":
      return <CodeOutlined />;
    case "code-shell":
      return <AppstoreOutlined />;
    case "code-sql":
      return <DatabaseOutlined />;
    case "code-config":
      return <ProfileOutlined />;
    case "code-log":
      return <FileTextOutlined />;
    case "pdf":
      return <FilePdfOutlined />;
    case "word":
      return <FileWordOutlined />;
    case "excel":
      return <FileExcelOutlined />;
    case "ppt":
      return <FilePptOutlined />;
    case "markdown":
      return <FileMarkdownOutlined />;
    case "ebook":
      return <FileTextOutlined />;
    case "image":
      return <FileImageOutlined />;
    case "video":
      return <PlayCircleOutlined />;
    case "audio":
      return <SoundOutlined />;
    case "archive":
      return <FileZipOutlined />;
    case "database":
      return <DatabaseOutlined />;
    case "font":
    case "design":
    case "model3d":
      return <FileOutlined />;
    case "text":
    default:
      return <FileOutlined />;
  }
}

/**
 * 入口：根据文件名（含 is_dir）和是否为 git 子模块目录，返回 FileTypeVisual
 */
export function getFileTypeVisual(
  fileName: string,
  isDir: boolean,
  isGitSubmodule = false,
): FileTypeVisual {
  if (isDir) {
    if (isGitSubmodule) {
      return {
        color: "#1677ff",
        label: "Git 子模块",
        icon: <FolderOpenOutlined />,
        kind: "git-submodule",
      };
    }
    return {
      color: "#faad14",
      label: "文件夹",
      icon: <FolderOutlined />,
      kind: "folder",
    };
  }
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  // 特殊：纯 dotfile（.gitignore / .eslintrc 等）也算 config
  if (fileName.startsWith(".")) {
    if (fileName === ".git" || fileName === ".gitignore" || fileName === ".gitmodules") {
      return {
        color: "#1677ff",
        label: "Git 配置",
        icon: <GithubOutlined />,
        kind: "git-config",
      };
    }
  }
  const info = KIND_BY_EXT.get(ext);
  if (info) {
    return {
      color: info.color,
      label: info.label,
      icon: iconForKind(info.kind),
      kind: info.kind,
    };
  }
  return {
    color: TEXT_COLOR,
    label: "未知",
    icon: <FileOutlined />,
    kind: "unknown",
  };
}

/** 仅取颜色（用于"左侧色条"等场景） */
export function getFileTypeColor(fileName: string, isDir: boolean): string {
  return getFileTypeVisual(fileName, isDir).color;
}

/**
 * 排序优先级：表格按"名称"列排序时，按 kind 分组（文件夹 → 代码 → 配置 → 文档 → 图片 → 视频 → 音频 → 归档 → 其它）。
 * 同 kind 内部仍然按字母顺序。
 * 桶内 priority 相同 = 同组内相对顺序按字母。
 *
 * 桶：
 *   10  folder
 *   20  git-config / git-submodule
 *   30  code-* (代码)
 *   40  code-config (json/yaml/...)  和 code-log
 *   50  markdown / text / ebook
 *   60  pdf / word / excel / ppt (办公文档)
 *   70  image
 *   80  video
 *   90  audio
 *  100  archive
 *  110  font / database / design / model3d / exec
 *  120  unknown
 */
const KIND_BUCKETS: { prefix: string; priority: number }[] = [
  { prefix: "folder", priority: 10 },
  { prefix: "git-", priority: 20 },
  { prefix: "code-", priority: 30 },
  { prefix: "code-config", priority: 40 },
  { prefix: "code-log", priority: 40 },
  { prefix: "markdown", priority: 50 },
  { prefix: "text", priority: 50 },
  { prefix: "ebook", priority: 50 },
  { prefix: "pdf", priority: 60 },
  { prefix: "word", priority: 60 },
  { prefix: "excel", priority: 60 },
  { prefix: "ppt", priority: 60 },
  { prefix: "image", priority: 70 },
  { prefix: "video", priority: 80 },
  { prefix: "audio", priority: 90 },
  { prefix: "archive", priority: 100 },
  { prefix: "font", priority: 110 },
  { prefix: "database", priority: 110 },
  { prefix: "design", priority: 110 },
  { prefix: "model3d", priority: 110 },
  { prefix: "exec", priority: 110 },
];

export function kindSortPriority(kind: string): number {
  for (const b of KIND_BUCKETS) {
    if (kind === b.prefix || kind.startsWith(b.prefix)) return b.priority;
  }
  return 120; // unknown
}

/**
 * 组合 sorter：先按 kind 分组，同 kind 内按字母。
 * 用法：表格 name 列 sorter 直接用这个
 */
export function compareByKindThenName(
  a: { name: string; is_dir: boolean },
  b: { name: string; is_dir: boolean },
): number {
  const ka = getFileTypeVisual(a.name, a.is_dir).kind;
  const kb = getFileTypeVisual(b.name, b.is_dir).kind;
  const pa = kindSortPriority(ka);
  const pb = kindSortPriority(kb);
  if (pa !== pb) return pa - pb;
  return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
}
