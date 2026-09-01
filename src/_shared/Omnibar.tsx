/**
 * Omnibar - 智能地址栏，集成路径导航和搜索功能
 * 来源: Files v4 的 Omnibar 设计
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { Input, Dropdown, type MenuProps } from "antd";
import {
  SearchOutlined,
  SettingOutlined,
  HomeOutlined,
  ArrowLeftOutlined,
  ArrowUpOutlined,
} from "@ant-design/icons";
import type { FC } from "react";

interface OmnibarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  rootPath: string;
  onRootNavigate: () => void;
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
  const [mode, setMode] = useState<"navigation" | "search" | "command">("navigation");
  const [searchQuery, setSearchQuery] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  
  const inputRef = useRef<HTMLInputElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);

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

  // 路径输入提交
  const handlePathSubmit = (value: string) => {
    if (value) {
      onNavigate(value);
    }
    setPathEditing(false);
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
          value={currentPath}
          onChange={(e) => handlePathSubmit(e.target.value)}
          onPressEnter={() => handlePathSubmit(currentPath)}
          onBlur={() => setPathEditing(false)}
          ref={inputRef}
          size="small"
          style={{ width: '100%' }}
        />
      );
    }

    // 面包屑导航
    const parts = currentPath.split("/").filter(Boolean);
    const breadcrumbs = ["/", ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Dropdown
          menu={{
            items: [
              { key: 'home', label: '首页', icon: <HomeOutlined />, onClick: onRootNavigate },
              { key: 'root', label: '根目录', onClick: () => onNavigate(rootPath) },
            ],
          }}
        >
          <div
            onClick={onRootNavigate}
            style={{ cursor: 'pointer', padding: '4px 8px', borderRadius: 4 }}
            title="首页"
          >
            <HomeOutlined />
          </div>
        </Dropdown>

        {breadcrumbs.map((path, index) => {
          const isLast = index === breadcrumbs.length - 1;
          return (
            <div key={path} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#8c8c8c' }}>{index > 0 ? '/' : ''}</span>
              {isLast ? (
                <span style={{ fontWeight: 500 }}>{parts[index - 1] || 'Home'}</span>
              ) : (
                <span
                  onClick={() => onNavigate(path)}
                  style={{
                    cursor: 'pointer',
                    padding: '4px 8px',
                    borderRadius: 4,
                  }}
                >
                  {parts[index - 1]}
                </span>
              )}
            </div>
          );
        })}

        <span
          onClick={togglePathEditing}
          style={{ cursor: 'text', padding: '4px 8px', borderRadius: 4, opacity: 0 }}
          title="点击编辑路径"
        >
          /
        </span>
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
        gap: 8,
        padding: '4px 12px',
        background: 'var(--ant-color-bg-container)',
        borderRadius: 6,
        border: `1px solid var(--ant-color-border-secondary, rgba(0,0,0,0.06))`,
      }}
    >
      {/* 导航控制按钮 */}
      <div style={{ display: 'flex', gap: 2 }}>
        <button
          onClick={onBack}
          disabled={historyIndex <= 0}
          style={{ padding: '4px 8px', borderRadius: 4, border: 'none', background: 'transparent', cursor: 'pointer' }}
          title="后退 (⌥+←)"
        >
          <ArrowLeftOutlined />
        </button>
        
        <button
          onClick={onForward}
          disabled={historyIndex >= history.length - 1}
          style={{ padding: '4px 8px', borderRadius: 4, border: 'none', background: 'transparent', cursor: 'pointer' }}
          title="前进 (⌥+→)"
        >
          <ArrowLeftOutlined rotate={180} />
        </button>

        <button
          onClick={onUp}
          style={{ padding: '4px 8px', borderRadius: 4, border: 'none', background: 'transparent', cursor: 'pointer' }}
          title="上级目录 (⌥+↑)"
        >
          <ArrowUpOutlined />
        </button>
      </div>

      {/* 模式切换 */}
      <div style={{ display: 'flex', gap: 2 }}>
        {['navigation', 'search', 'command'].map((m) => (
          <button
            key={m}
            onClick={() => setMode(m as any)}
            style={{
              padding: '4px 8px',
              borderRadius: 4,
              border: 'none',
              background: mode === m ? 'var(--ant-color-primary-bg)' : 'transparent',
              color: mode === m ? 'var(--ant-color-primary)' : 'inherit',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: mode === m ? 500 : 400,
            }}
          >
            {m === 'navigation' && '🔍'}
            {m === 'search' && '🔎'}
            {m === 'command' && '⚡'}
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
