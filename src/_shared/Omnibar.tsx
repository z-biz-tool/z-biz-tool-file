/**
 * Omnibar - 智能地址栏，集成路径导航和搜索功能
 * 来源: Files v4 的 Omnibar 设计
 */

import { useState, useRef, useEffect } from "react";
import { Input, Dropdown } from "antd";
import {
  SearchOutlined,
  SettingOutlined,
  HomeOutlined,
  ArrowLeftOutlined,
  ArrowUpOutlined,
  HistoryOutlined,
  MacCommandOutlined,
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
              { key: 'home', label: '首页', icon: <HomeOutlined />, onClick: onRootNavigate },
              { key: 'root', label: '根目录', onClick: () => onNavigate(rootPath) },
            ],
          }}
        >
          <div
            onClick={onRootNavigate}
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
            <HomeOutlined style={{ color: '#667eea' }} />
          </div>
        </Dropdown>

        {breadcrumbs.map((path, index) => {
          const isLast = index === breadcrumbs.length - 1;
          return (
            <div key={path} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: "#999", fontSize: 10 }}>•</span>
              {isLast ? (
                <span 
                  style={{ 
                    fontWeight: 600,
                    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                  }}
                >
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
        background: 'linear-gradient(135deg, #ffffff 0%, #f8fafd 100%)',
        borderRadius: 12,
        border: '1px solid rgba(0,0,0,0.06)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)';
      }}
    >
      {/* 导航控制按钮 */}
      <div style={{ display: 'flex', gap: 2 }}>
        <button
          onClick={onBack}
          disabled={historyIndex <= 0}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: 'none',
            background: historyIndex <= 0 ? 'transparent' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: historyIndex <= 0 ? '#999' : 'white',
            cursor: historyIndex <= 0 ? 'not-allowed' : 'pointer',
            opacity: historyIndex <= 0 ? 0.4 : 1,
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          title="后退 (⌥+←)"
          onMouseEnter={(e) => {
            if (historyIndex > 0) (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)';
          }}
          onMouseLeave={(e) => {
            if (historyIndex > 0) (e.currentTarget as HTMLElement).style.transform = 'scale(1)';
          }}
        >
          <ArrowLeftOutlined />
        </button>
        
        <button
          onClick={onForward}
          disabled={historyIndex >= history.length - 1}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: 'none',
            background: historyIndex >= history.length - 1 ? 'transparent' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: historyIndex >= history.length - 1 ? '#999' : 'white',
            cursor: historyIndex >= history.length - 1 ? 'not-allowed' : 'pointer',
            opacity: historyIndex >= history.length - 1 ? 0.4 : 1,
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          title="前进 (⌥+→)"
          onMouseEnter={(e) => {
            if (historyIndex < history.length - 1) (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)';
          }}
          onMouseLeave={(e) => {
            if (historyIndex < history.length - 1) (e.currentTarget as HTMLElement).style.transform = 'scale(1)';
          }}
        >
          <ArrowLeftOutlined rotate={180} />
        </button>

        <button
          onClick={onUp}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: 'none',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            cursor: 'pointer',
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          title="上级目录 (⌥+↑)"
          onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)'}
          onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.transform = 'scale(1)'}
        >
          <ArrowUpOutlined />
        </button>
      </div>

      {/* 模式切换 */}
      <div style={{ display: 'flex', gap: 2, background: 'rgba(0,0,0,0.04)', padding: 4, borderRadius: 8 }}>
        {[
          { key: 'navigation', icon: <HistoryOutlined />, label: '路径' },
          { key: 'search', icon: <SearchOutlined />, label: '搜索' },
          { key: 'command', icon: <MacCommandOutlined />, label: '命令' },
        ].map((m) => (
          <button
            key={m.key}
            onClick={() => setMode(m.key as any)}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: 'none',
              background: mode === m.key ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' : 'transparent',
              color: mode === m.key ? 'white' : 'var(--ant-color-text)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: mode === m.key ? 600 : 500,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onMouseEnter={(e) => {
              if (mode !== m.key) (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.06)';
            }}
            onMouseLeave={(e) => {
              if (mode !== m.key) (e.currentTarget as HTMLElement).style.background = 'transparent';
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
