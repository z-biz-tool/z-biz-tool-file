/**
 * Omnibar —— 路径栏（面包屑 + 导航 + 路径编辑）。
 *
 * ## 2026-11-06 的大改：删掉「搜索」「命令」两个模式
 *
 * 原来右侧有个「路径 / 搜索 / 命令」三段切换，但其中两个是**假 UI**：
 *
 * - **搜索**：Input 只有 value/onChange，`searchQuery` 存下来之后没有任何人读它，
 *   也没有 `onPressEnter`。占位符写着"Enter 搜索"，用户敲完回车什么都不发生 ——
 *   看起来像卡死了。而本仓已经有一个真正的搜索（活动栏的搜索面板，走
 *   `SearchBar` + 后端 `search_files`），这里再放一个半成品只会让人以为搜索坏了。
 * - **命令**：`commandInput` 同样只存不用，全仓没有任何命令注册表/分发器。
 *   它是个纯粹的装饰品。
 *
 * 两个半成品占了路径栏大约一半的宽度，把真正在用的面包屑挤窄了。
 * 现在只保留「路径」这一件事 —— 这也是这个组件原本的职责（Files v4 的 Omnibar）。
 *
 * ## 搜索去哪儿了
 *
 * 活动栏第一个图标（放大镜）打开搜索面板。用 ⌘F 或 `/` 是**过滤当前目录**
 * （快速过滤，不落盘），两者的区别见快捷键面板。
 */
import { useState, useRef, useEffect } from "react";
import { Input, Tooltip, App as AntdApp } from "antd";
import {
  HomeOutlined,
  ArrowLeftOutlined,
  ArrowUpOutlined,
  CopyOutlined,
  FolderOpenOutlined,
} from "@ant-design/icons";
import type { FC } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useShortcutHint } from "./ShortcutHints";

interface OmnibarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  rootPath: string;
  onRootNavigate: (path: string) => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  historyIndex: number;
  history: string[];
}

/** 图标按钮的统一观感：无底色，hover 才浮出浅底。 */
const iconBtnStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "none",
  background: "transparent",
  color: "var(--ant-color-text-secondary)",
  display: "inline-flex",
  alignItems: "center",
  transition: "background 0.15s, color 0.15s",
};

const Omnibar: FC<OmnibarProps> = ({
  currentPath,
  onNavigate,
  rootPath,
  onRootNavigate,
  onBack,
  onForward,
  onUp,
  historyIndex,
  history,
}) => {
  // 键位由 App 的注册表推导：这里写死 "⌥+←" 在 Windows/Linux 上指的是不存在的键
  const hint = useShortcutHint();
  const { message } = AntdApp.useApp();
  const [pathEditing, setPathEditing] = useState(false);
  const inputRef = useRef<any>(null);

  /**
   * 路径编辑的"草稿"。
   *
   * 输入框是**草稿**，提交才是**动作**：原来 onNavigate 直接挂在 onChange 上，
   * 敲一个字提交一次，URL 会被瞬移到 "/x/y/z"，最后落到完全打错的路径。
   */
  const [pathDraft, setPathDraft] = useState(currentPath);
  useEffect(() => {
    setPathDraft(currentPath);
  }, [currentPath, pathEditing]);

  useEffect(() => {
    if (pathEditing) {
      inputRef.current?.focus?.();
      inputRef.current?.select?.();
    }
  }, [pathEditing]);

  const commitPath = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== currentPath) onNavigate(trimmed);
    setPathEditing(false);
  };

  /**
   * 取消编辑：把草稿退回当前路径。
   *
   * 这条以前没有 —— 按 Esc 会走全局那条"清空选择"，用户在路径框里敲错一半
   * 想反悔时，选择被清掉了、路径框还开着，两个都不对。
   */
  const cancelPathEditing = () => {
    setPathDraft(currentPath);
    setPathEditing(false);
  };

  const handleCopyCurrentPath = async () => {
    try {
      await navigator.clipboard.writeText(currentPath);
      message.success("已复制当前路径");
    } catch (err) {
      message.error("复制失败: " + err);
    }
  };

  const handleRevealCurrent = () => {
    if (!currentPath) return;
    invoke("reveal_in_finder", { path: currentPath }).catch((err) =>
      message.error("打开 Finder 失败: " + err),
    );
  };

  if (pathEditing) {
    return (
      <div style={barStyle}>
        <Input
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          onPressEnter={() => commitPath(pathDraft)}
          onBlur={() => commitPath(pathDraft)}
          onKeyDown={(e) => {
            // Esc 只取消"编辑"这一件事，不能漏到全局去清空选择
            if (e.key === "Escape") {
              e.stopPropagation();
              e.preventDefault();
              cancelPathEditing();
            }
          }}
          ref={inputRef}
          size="small"
          aria-label="路径"
          placeholder="输入路径，Enter 跳转，Esc 取消"
          style={{ width: "100%", fontWeight: 500 }}
        />
      </div>
    );
  }

  // 面包屑：["/", "/Users", "/Users/zifang", ...]
  const parts = currentPath.split("/").filter(Boolean);
  const breadcrumbs = ["/", ...parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`)];

  return (
    <div style={barStyle}>
      {/* 导航三键：无底色图标按钮，hover 才浮出淺底 */}
      <div style={{ display: "flex", gap: 2 }}>
        <Tooltip title={`后退${hint("后退")}`} placement="bottom">
          <button
            aria-label="后退"
            onClick={onBack}
            disabled={historyIndex <= 0}
            style={{
              ...iconBtnStyle,
              cursor: historyIndex <= 0 ? "not-allowed" : "pointer",
              opacity: historyIndex <= 0 ? 0.35 : 1,
            }}
            onMouseEnter={(e) => {
              if (historyIndex > 0) {
                e.currentTarget.style.background = "var(--ant-color-fill-tertiary)";
                e.currentTarget.style.color = "var(--ant-color-text)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--ant-color-text-secondary)";
            }}
          >
            <ArrowLeftOutlined />
          </button>
        </Tooltip>

        <Tooltip title={`前进${hint("前进")}`} placement="bottom">
          <button
            aria-label="前进"
            onClick={onForward}
            disabled={historyIndex >= history.length - 1}
            style={{
              ...iconBtnStyle,
              cursor: historyIndex >= history.length - 1 ? "not-allowed" : "pointer",
              opacity: historyIndex >= history.length - 1 ? 0.35 : 1,
            }}
            onMouseEnter={(e) => {
              if (historyIndex < history.length - 1) {
                e.currentTarget.style.background = "var(--ant-color-fill-tertiary)";
                e.currentTarget.style.color = "var(--ant-color-text)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--ant-color-text-secondary)";
            }}
          >
            <ArrowLeftOutlined rotate={180} />
          </button>
        </Tooltip>

        <Tooltip title={`上级目录${hint("返回上级")}`} placement="bottom">
          <button
            aria-label="上级目录"
            onClick={onUp}
            style={{ ...iconBtnStyle, cursor: "pointer" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--ant-color-fill-tertiary)";
              e.currentTarget.style.color = "var(--ant-color-text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--ant-color-text-secondary)";
            }}
          >
            <ArrowUpOutlined />
          </button>
        </Tooltip>
      </div>

      {/* 面包屑。整条后面跟一块可点的空白 ——
          原来只有末尾那个小小的 "/" 能点进编辑，命中区只有 8px 宽，
          想手输路径得先瞄准它。现在"面包屑右边全是编辑区"。 */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, flex: 1, minWidth: 0 }}>
        <Tooltip title="回到首页（根目录）" placement="bottom">
          <button
            aria-label="首页"
            onClick={() => onRootNavigate(rootPath)}
            style={{ ...iconBtnStyle, padding: "4px 6px" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--ant-color-fill-tertiary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <HomeOutlined style={{ color: "var(--ant-color-primary)" }} />
          </button>
        </Tooltip>

        {breadcrumbs.slice(1).map((path, i) => {
          const isLast = i === breadcrumbs.length - 2;
          const name = parts[i];
          return (
            <div key={path} style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0 }}>
              <span aria-hidden style={{ color: "var(--ant-color-text-quaternary)", fontSize: 11 }}>
                /
              </span>
              {isLast ? (
                // 当前目录只加粗、不做点击热区：点自己等于刷新，容易误触
                <span
                  style={{
                    fontWeight: 600,
                    color: "var(--ant-color-text)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    padding: "4px 4px",
                  }}
                  title={currentPath}
                >
                  {name}
                </span>
              ) : (
                <button
                  onClick={() => onNavigate(path)}
                  style={{
                    ...iconBtnStyle,
                    padding: "4px 6px",
                    color: "var(--ant-color-text)",
                    whiteSpace: "nowrap",
                    maxWidth: 200,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "block",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--ant-color-fill-tertiary)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {name}
                </button>
              )}
            </div>
          );
        })}

        {/* 空白区：点一下进路径编辑（命中区大，不用瞄准小图标） */}
        <div
          role="button"
          tabIndex={0}
          aria-label="编辑路径"
          title="点击编辑路径"
          onClick={() => setPathEditing(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setPathEditing(true);
            }
          }}
          style={{ flex: 1, minWidth: 24, height: 24, cursor: "text", borderRadius: 6 }}
        />
      </div>

      <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
        <Tooltip title="复制当前路径" placement="bottom">
          <button
            aria-label="复制当前路径"
            onClick={handleCopyCurrentPath}
            style={{ ...iconBtnStyle, padding: "4px 6px" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--ant-color-fill-tertiary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <CopyOutlined style={{ fontSize: 13 }} />
          </button>
        </Tooltip>
        <Tooltip title="在 Finder 中显示当前目录" placement="bottom">
          <button
            aria-label="在 Finder 中显示当前目录"
            onClick={handleRevealCurrent}
            style={{ ...iconBtnStyle, padding: "4px 6px" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--ant-color-fill-tertiary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <FolderOpenOutlined style={{ fontSize: 13 }} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};

/**
 * 整条路径栏的容器。
 *
 * 背景用 `--ant-color-bg-layout` 而不是容器色：它要跟在它下面、同为内容区的
 * 文件列表区分开一档。原来这里是写死的亮白渐变 + 黑边黑阴影，深色主题下
 * 会变成一条刺眼的白带。
 */
const barStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  background: "var(--ant-color-bg-layout)",
  borderRadius: 10,
  border: "1px solid var(--ant-color-border-secondary)",
  transition: "border-color 0.15s",
};

export default Omnibar;
