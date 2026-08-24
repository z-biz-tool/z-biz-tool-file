# z-biz-tool-file

> 万能文件管理器 — 文件管理 / 媒体预览 / 播放 / 电子书阅读 / 全盘搜索

![tech](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri)
![tech](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![tech](https://img.shields.io/badge/AntD-6-0170FE?logo=antdesign)
![tech](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![tech](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust)
![tech](https://img.shields.io/badge/Zustand-5-433931)

---

## 概览

**万能文件管理器** — 单一应用聚合 4 个原项目的功能 + 全盘搜索：

| 原项目 | 模块 |
|--------|------|
| z-biz-tool-media-cos | 图片 / 视频预览 |
| z-biz-tool-ebook-reader | epub / txt / PDF 阅读 |
| z-biz-tool-music-player-cos | 音频播放 |
| z-biz-tool-file-manager-cos | 文件管理 |
| （新增） | 全盘搜索 / 重复文件 / 哈希 / 批量重命名 / Git 状态 / 内置终端 / 压缩包浏览 等高级工具 |

**核心定位**：替代 macOS Finder / Windows Explorer + 一个媒体中心 + 一个 dev 工具集，三合一。

---

## 功能

### 📁 文件管理（多视图）

| 视图 | 说明 |
|------|------|
| 文件树 (FileTree) | 经典侧边栏树形视图，展开/折叠，右键操作 |
| 列视图 (ColumnView) | macOS Finder 风格多列浏览 |
| 网格视图 (GridView) | 缩略图网格，适合图片浏览 |
| 双面板 (DualPanelView) | 左右双窗口，便于文件移动/复制 |

### 🖼️ 媒体预览

| 类型 | 功能 |
|------|------|
| 图片 | 内置图片编辑器（裁剪/旋转/调整/标注），支持 PNG/JPG/GIF/WebP/HEIC/SVG |
| 视频 | 视频播放器，支持 MP4/MOV/AVI/MKV |
| 音频 | 音频播放器（播放列表/歌词/迷你模式） |
| PDF | PDF 阅读器 |
| Markdown | Markdown 实时预览 |
| epub | 电子书阅读器（书签/笔记/进度/夜间模式） |

### 🔍 搜索 & 分析

| 工具 | 说明 |
|------|------|
| 搜索栏 (SearchBar) | 当前目录下文件名模糊搜索 |
| 全盘秒搜 | 文件名 + 内容搜索（基于索引） |
| 重复文件查找 (DuplicateFinder) | 基于内容哈希找出重复文件 |
| 哈希计算器 (HashCalculator) | MD5/SHA-1/SHA-256 等 |
| Git 状态 (GitStatus) | 目录作为 Git 仓库时显示修改状态 |

### 🔧 工具

| 工具 | 说明 |
|------|------|
| 内置终端 (BuiltInTerminal) | 当前目录直接打开终端 |
| 压缩包浏览 (ZipBrowser) | 不解压浏览 zip/tar 等压缩包 |
| 批量重命名 (BatchRename) | 正则/序号/替换批量重命名 |
| 文本转换 (TextConverter) | 编码转换（GBK/UTF-8 等）/ 行尾符转换 |
| 新建文件模板 (NewFileTemplate) | 按模板快速新建文件 |
| 目录同步 (DirectorySync) | 两个目录差异对比 + 同步 |

### 🏷️ 组织

| 功能 | 说明 |
|------|------|
| 文件标签 (FileTagsPanel) | 给文件/文件夹打彩色标签 |
| 书签 (Bookmarks) | 快速跳转到常用目录 |
| 传输队列 (TransferQueue) | 复制/移动/上传/下载的进度跟踪 |
| 拖放堆 (DropStack) | 暂存拖入的文件/文件夹，二次操作 |
| 拖放移动 (DragDropMove) | 直接拖动文件到目标目录 |

### 📋 元信息

| 功能 | 说明 |
|------|------|
| 文件属性 (FileProperties) | 完整元信息（大小/权限/修改时间/哈希等） |
| 工作区管理 (WorkspaceManager) | 多工作区切换（每个工作区是一组常用目录） |

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面运行时 | Tauri 2 (Rust + 系统 WebView) |
| 前端框架 | React 19 + TypeScript 5 |
| UI 组件 | Ant Design 6 |
| 状态管理 | Zustand 5 |
| 文件系统 | `@tauri-apps/plugin-fs` + `@tauri-apps/plugin-dialog` |
| 系统能力 | `@tauri-apps/plugin-shell`、`@tauri-apps/plugin-clipboard-manager` |
| 构建 | Vite 6 |

---

## 项目结构

```
src/
├─ App.tsx                  顶层布局 + 视图切换
├─ main.tsx                 React 入口
├─ stores/
│  ├─ fileStore.ts           Zustand 状态（当前目录/选中/历史）
│  └─ transferStore.ts       Zustand 状态（传输队列）
├─ components/              35+ 个功能组件
│  ├─ FileTree.tsx           树形视图
│  ├─ ColumnView.tsx         列视图
│  ├─ GridView.tsx           网格视图
│  ├─ DualPanelView.tsx      双面板
│  ├─ PreviewPane.tsx        预览容器
│  ├─ ImageEditor.tsx        图片编辑器
│  ├─ VideoPlayer.tsx        视频播放器
│  ├─ AudioPlayer.tsx        音频播放器
│  ├─ PdfViewer.tsx          PDF 阅读器
│  ├─ EpubReader.tsx         电子书阅读器
│  ├─ MarkdownPreview.tsx    Markdown 预览
│  ├─ SearchBar.tsx          搜索栏
│  ├─ DuplicateFinder.tsx    重复文件查找
│  ├─ HashCalculator.tsx     哈希计算
│  ├─ GitStatus.tsx          Git 状态
│  ├─ BuiltInTerminal.tsx    内置终端
│  ├─ ZipBrowser.tsx         压缩包浏览
│  ├─ BatchRename.tsx        批量重命名
│  ├─ TextConverter.tsx      文本编码转换
│  ├─ NewFileTemplate.tsx    新建文件模板
│  ├─ DirectorySync.tsx      目录同步
│  ├─ FileProperties.tsx     文件属性
│  ├─ WorkspaceManager.tsx   工作区管理
│  ├─ TransferQueue.tsx      传输队列
│  ├─ DropStack.tsx          拖放堆
│  ├─ DragDropMove.tsx       拖放移动
│  ├─ FileTagsPanel.tsx      文件标签
│  ├─ Bookmarks.tsx          书签
│  └─ ...                    更多
└─ _shared/                  通用 UI
src-tauri/
└─ src/                      Rust 后端（文件系统访问）
```

---

## 开发

```bash
# 装依赖
npm install

# 前端开发（HMR）
npm run dev

# 类型检查
npm run typecheck

# 生产构建（前端）
npm run build

# 桌面应用开发（启动 Tauri 原生窗口）
npm run tauri dev

# 桌面应用打包
npm run tauri build
```

---

## 平台支持

- **macOS** — Apple Silicon + Intel
- **Windows** — x86_64
- **Linux** — deb / AppImage / rpm

---

## 路线图

- [ ] 完整全盘搜索索引（SQLite FTS5）
- [ ] 云存储后端（S3 / OneDrive / iCloud）
- [ ] AI 辅助文件整理（自动重命名/分类）
- [ ] 视频转码/压缩
- [ ] 图片 AI 标注
- [ ] 高级过滤（按日期/大小/类型组合）

---

## License

MIT
