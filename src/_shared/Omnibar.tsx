/**
 * Omnibar - 智能地址栏，集成路径导航和搜索功能
 * 来源: Files v4 的 Omnibar 设计
 */

import { useState, useRef, useEffect } from "react";
import { Input, Dropdown, Tooltip } from "antd";
import { App as AntdApp } from "antd";
import {
  SearchOutlined,
  SettingOutlined,
  HomeOutlined,
  ArrowLeftOutlined,
  ArrowUpOutlined,
  HistoryOutlined,
  MacCommandOutlined,
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
  const [mode, setMode] = useState<"navigation" | "search" | "command">("navigation");
  const [searchQuery, setSearchQuery] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [pathEditing, setPathEditing] = useState(false);

  const inputRef = useRef<any>(null);
  const commandRef = useRef<any>(null);

  // 当切换模式时聚焦到相应输入框
  useEffect(() => {
    if (mode === "search" && inputRef.current) {
      inputRef.current.focus();
    } else if (mode === "command" && commandRef.current) {
      commandRef.current.focus();
    }
  }, [mode]);

  // 路径编辑模式切换
  const togglePathEditing = () => {
    setPathEditing(!pathEditing);
  };

  // 路径编辑时的"草稿"。原来 Input.onChange 直接 onNavigate(currentPath)：
  // 敲一个字提交一次，URL 被瞬时切换到 "/x/y/z"，最后落到完全打错的路径。
  // 草稿态只在按 Enter 或失焦时一次性提交 —— 输入框是"草稿"，提交是"动作"。
  const [pathDraft, setPathDraft] = useState(currentPath);
  useEffect(() => {
    setPathDraft(currentPath);
  }, [currentPath, pathEditing]);

  // 路径输入提交
  const handlePathSubmit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      onNavigate(trimmed);
    }
    setPathEditing(false);
  };

  /**
   * 复制当前目录的完整路径。Omnibar 自己处理：选中一个文件再去翻右键菜单
   * 才能复制那条路径，但"我现在站在哪里"几乎同等常用 —— 单独一颗按钮省事。
   * 用 AntdApp 的 message 而不是 navigator 弹原生通知 —— 桌面壳里原生通知
   * 不吃主题、不跟站点走，看起来像 OS 弹窗。
   */
  const handleCopyCurrentPath = async () => {
    try {
      await navigator.clipboard.writeText(currentPath);
      message.success("已复制当前路径");
    } catch (err) {
      message.error("复制失败: " + err);
    }
  };

  /**
   * 在 Finder 里打开当前目录。右键菜单的同名操作只在选中某项时出现，
   * "我想直接去 Finder 看一眼当前目录"也得绕一遍菜单。
   */
  const handleRevealCurrent = () => {
    if (!currentPath) return;
    invoke("reveal_in_finder", { path: currentPath }).catch((err) =>
      message.error("打开 Finder 失败: " + err),
    );
  };

  // 快捷键处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+L - 编辑路径
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        setMode("navigation");
        setPathEditing(true);
      }
      // Ctrl+F - 搜索
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        setMode("search");
      }
      // Ctrl+Shift+P - 命令面板
      if (e.ctrlKey && e.shiftKey && e.key === 'p') {
        e.preventDefault();
        setMode("command");
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 导航模式渲染
  const renderNavigation = () => {
    if (pathEditing) {
      return (
        <Input
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          onPressEnter={() => handlePathSubmit(pathDraft)}
          onBlur={() => handlePathSubmit(pathDraft)}
          ref={inputRef}
          size="small"
          style={{
            width: '100%',
            fontWeight: 500,
          }}
        />
      );
    }

    // 面包屑导航
    const parts = currentPath.split("/").filter(Boolean);
    const breadcrumbs = ["/", ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Dropdown
          menu={{
            items: [
              // onRootNavigate 是要收路径的：之前声明成 () => void 又直接被当无参调用，
              // App 侧拿到 undefined → setRootPath(undefined)，首页这个芯片就再也点不回来了。
              // 「根目录」这一项本来就是面包屑第一片（"/"），菜单里不再重复一遍。
              { key: 'home', label: '首页', icon: <HomeOutlined />, onClick: () => onRootNavigate(rootPath) },
            ],
          }}
        >
          <div
            onClick={() => onRootNavigate(rootPath)}
            style={{ 
              cursor: 'pointer', 
              padding: '4px 8px', 
              borderRadius: 6,
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            title="首页"
            onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.04)'}
            onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = 'transparent'}
          >
            <HomeOutlined style={{ color: '#1677ff' }} />
          </div>
        </Dropdown>

        {breadcrumbs.map((path, index) => {
          const isLast = index === breadcrumbs.length - 1;
          return (
            <div key={path} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: "var(--ant-color-text-tertiary)", fontSize: 10 }}>•</span>
              {isLast ? (
                // 当前目录：加粗即可。原来是渐变文字（紫→蓝都试过），
                // 在小字号下渐变会把字压得发虚，反而不如直接加重来得分明。
                <span style={{ fontWeight: 600, color: "var(--ant-color-text)" }}>
                  {parts[index - 1] || 'Home'}
                </span>
              ) : (
                <span
                  onClick={() => onNavigate(path)}
                  style={{
                    cursor: 'pointer',
                    padding: '4px 8px',
                    borderRadius: 6,
                    color: "var(--ant-color-text)",
                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                  onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.04)'}
                  onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                >
                  {parts[index - 1]}
                </span>
              )}
            </div>
          );
        })}

        <span
          onClick={togglePathEditing}
          style={{
            cursor: 'text',
            padding: '4px 8px',
            borderRadius: 6,
            opacity: 0.6,
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          title="点击编辑路径"
          onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.opacity = '1'}
          onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.opacity = '0.6'}
        >
          /
        </span>
        {/* 复制当前路径：在 Finder 中显示：两条捷径让"我现在站在哪"不必绕右键菜单 */}
        <Tooltip title="复制当前路径">
          <span
            role="button"
            tabIndex={0}
            aria-label="复制当前路径"
            onClick={handleCopyCurrentPath}
            style={{
              cursor: 'pointer',
              padding: '4px 6px',
              borderRadius: 6,
              opacity: 0.6,
              display: 'inline-flex',
              alignItems: 'center',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = '1';
              (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.04)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = '0.6';
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
          >
            <CopyOutlined style={{ fontSize: 13 }} />
          </span>
        </Tooltip>
        <Tooltip title="在 Finder 中显示当前目录">
          <span
            role="button"
            tabIndex={0}
            aria-label="在 Finder 中显示当前目录"
            onClick={handleRevealCurrent}
            style={{
              cursor: 'pointer',
              padding: '4px 6px',
              borderRadius: 6,
              opacity: 0.6,
              display: 'inline-flex',
              alignItems: 'center',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = '1';
              (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.04)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = '0.6';
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
          >
            <FolderOpenOutlined style={{ fontSize: 13 }} />
          </span>
        </Tooltip>
      </div>
    );
  };

  // 搜索模式渲染
  const renderSearch = () => (
    <Input
      placeholder="搜索文件..."
      value={searchQuery}
      onChange={(e) => setSearchQuery(e.target.value)}
      ref={inputRef}
      prefix={<SearchOutlined />}
      suffix={<span style={{ fontSize: 12, color: '#999' }}>Enter 搜索</span>}
      size="small"
      style={{ width: '100%' }}
    />
  );

  // 命令面板模式渲染
  const renderCommand = () => (
    <Input
      placeholder="输入命令 (如: newfolder, settings, refresh)..."
      value={commandInput}
      onChange={(e) => setCommandInput(e.target.value)}
      ref={commandRef}
      prefix={<SettingOutlined />}
      size="small"
      style={{ width: '100%' }}
    />
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        // 原来是写死的亮白渐变 + 黑边黑阴影：深色主题下这条路径栏是一块刺眼的白条
        background: 'var(--ant-color-bg-layout)',
        borderRadius: 12,
        border: '1px solid var(--ant-color-border-secondary)',
        boxShadow: '0 2px 8px var(--ant-color-fill-secondary)',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)';
      }}
    >
      {/* 导航控制按钮
          原来三个都是实心渐变块（紫的，后来改蓝的还是块），一排色块压在路径栏最前面，
          视觉上比下面的文件列表还抢眼。文件管理器的前进/后退本来就是"顺手点一下"的
          次级操作，改成无底色的图标按钮 + hover 才浮出底色，和下面那排普通按钮一致。 */}
      <div style={{ display: 'flex', gap: 2 }}>
        <button
          aria-label="后退"
          onClick={onBack}
          disabled={historyIndex <= 0}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: 'none',
            background: 'transparent',
            color: 'var(--ant-color-text-secondary)',
            cursor: historyIndex <= 0 ? 'not-allowed' : 'pointer',
            opacity: historyIndex <= 0 ? 0.35 : 1,
            display: 'inline-flex',
            alignItems: 'center',
            transition: 'background 0.15s, color 0.15s',
          }}
          title={`后退${hint("后退")}`}
          onMouseEnter={(e) => {
            if (historyIndex > 0) {
              e.currentTarget.style.background = 'var(--ant-color-fill-tertiary)';
              e.currentTarget.style.color = 'var(--ant-color-text)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--ant-color-text-secondary)';
          }}
        >
          <ArrowLeftOutlined />
        </button>

        <button
          aria-label="前进"
          onClick={onForward}
          disabled={historyIndex >= history.length - 1}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: 'none',
            background: 'transparent',
            color: 'var(--ant-color-text-secondary)',
            cursor: historyIndex >= history.length - 1 ? 'not-allowed' : 'pointer',
            opacity: historyIndex >= history.length - 1 ? 0.35 : 1,
            display: 'inline-flex',
            alignItems: 'center',
            transition: 'background 0.15s, color 0.15s',
          }}
          title={`前进${hint("前进")}`}
          onMouseEnter={(e) => {
            if (historyIndex < history.length - 1) {
              e.currentTarget.style.background = 'var(--ant-color-fill-tertiary)';
              e.currentTarget.style.color = 'var(--ant-color-text)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--ant-color-text-secondary)';
          }}
        >
          <ArrowLeftOutlined rotate={180} />
        </button>

        <button
          aria-label="上级目录"
          onClick={onUp}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: 'none',
            background: 'transparent',
            color: 'var(--ant-color-text-secondary)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            transition: 'background 0.15s, color 0.15s',
          }}
          title={`上级目录${hint("返回上级")}`}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--ant-color-fill-tertiary)';
            e.currentTarget.style.color = 'var(--ant-color-text)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--ant-color-text-secondary)';
          }}
        >
          <ArrowUpOutlined />
        </button>
      </div>

      {/* 模式切换：容器灰底 + 激活项白底，是 antd Segmented 的常规观感。
          原来激活项是实心渐变块，跟左边的导航按钮叠在一起就是一条彩色条带。 */}
      <div style={{ display: 'flex', gap: 2, background: 'var(--ant-color-fill-quaternary)', padding: 3, borderRadius: 8 }}>
        {[
          { key: 'navigation', icon: <HistoryOutlined />, label: '路径' },
          { key: 'search', icon: <SearchOutlined />, label: '搜索' },
          { key: 'command', icon: <MacCommandOutlined />, label: '命令' },
        ].map((m) => (
          <button
            key={m.key}
            aria-label={m.label}
            onClick={() => setMode(m.key as any)}
            style={{
              padding: '5px 10px',
              borderRadius: 6,
              border: 'none',
              background: mode === m.key ? 'var(--ant-color-bg-container)' : 'transparent',
              color: mode === m.key ? 'var(--ant-color-primary)' : 'var(--ant-color-text-secondary)',
              boxShadow: mode === m.key ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: mode === m.key ? 600 : 500,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              if (mode !== m.key) e.currentTarget.style.color = 'var(--ant-color-text)';
            }}
            onMouseLeave={(e) => {
              if (mode !== m.key) e.currentTarget.style.color = 'var(--ant-color-text-secondary)';
            }}
          >
            {m.icon}
            <span>{m.label}</span>
          </button>
        ))}
      </div>

      {/* 主输入区域 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {mode === 'navigation' && renderNavigation()}
        {mode === 'search' && renderSearch()}
        {mode === 'command' && renderCommand()}
      </div>
    </div>
  );
};

export default Omnibar;
