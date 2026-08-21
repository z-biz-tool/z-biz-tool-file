import { useState, useEffect, useCallback } from "react";
import { Input, Button, Breadcrumb, Table, Tooltip, theme, message } from "antd";
import type { BreadcrumbProps } from "antd";
import {
  FolderOutlined,
  FileOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ReloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  ColumnHeightOutlined,
  CloseOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { formatFileSize, formatTime, type FileEntry } from "../stores/fileStore";

interface PanelState {
  currentPath: string;
  history: string[];
  historyIndex: number;
  fileList: FileEntry[];
  selectedFile: FileEntry | null;
}

const Panel: React.FC<{
  panelId: "left" | "right";
  state: PanelState;
  setState: (s: PanelState) => void;
  onFileOpen: (path: string, isDir: boolean) => void;
  showHidden: boolean;
  onToggleHidden: () => void;
  syncNavigate?: (path: string) => void;
}> = ({ panelId, state, setState, onFileOpen, showHidden, onToggleHidden, syncNavigate }) => {
  const { token } = theme.useToken();

  const loadDirectory = useCallback(
    (path: string) => {
      const cmd = showHidden ? "list_directory_with_hidden" : "list_directory";
      const args = showHidden ? { path, showHidden: true } : { path };
      invoke(cmd, args)
        .then((entries: unknown) => {
          setState({ ...state, currentPath: path, fileList: entries as FileEntry[] });
        })
        .catch((err) => {
          message.error(`${panelId} 加载失败: ${err}`);
        });
    },
    [panelId, showHidden, state, setState]
  );

  useEffect(() => {
    if (state.currentPath) {
      loadDirectory(state.currentPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  const navigateTo = (path: string, isRoot = false) => {
    if (isRoot) {
      setState({
        ...state,
        currentPath: path,
        history: [path],
        historyIndex: 0,
        selectedFile: null,
      });
    } else {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(path);
      setState({
        ...state,
        currentPath: path,
        history: newHistory,
        historyIndex: newHistory.length - 1,
        selectedFile: null,
      });
    }
    loadDirectory(path);
    // 同步浏览：通知另一个面板跟随导航
    syncNavigate?.(path);
  };

  const goBack = () => {
    if (state.historyIndex > 0) {
      const newIndex = state.historyIndex - 1;
      const path = state.history[newIndex];
      setState({ ...state, historyIndex: newIndex, currentPath: path, selectedFile: null });
      loadDirectory(path);
    }
  };

  const goForward = () => {
    if (state.historyIndex < state.history.length - 1) {
      const newIndex = state.historyIndex + 1;
      const path = state.history[newIndex];
      setState({ ...state, historyIndex: newIndex, currentPath: path, selectedFile: null });
      loadDirectory(path);
    }
  };

  const goUp = () => {
    if (state.currentPath && state.currentPath !== "/") {
      const parts = state.currentPath.split("/").filter(Boolean);
      parts.pop();
      navigateTo("/" + parts.join("/") || "/");
    }
  };

  const buildBreadcrumb = (): BreadcrumbProps["items"] => {
    if (!state.currentPath) return [];
    const parts = state.currentPath.split("/").filter(Boolean);
    const items: NonNullable<BreadcrumbProps["items"]> = [
      {
        title: (
          <span onClick={() => navigateTo("/", true)} style={{ cursor: "pointer" }}>
            <FolderOutlined />
          </span>
        ),
      },
    ];
    let path = "";
    parts.forEach((part) => {
      path += "/" + part;
      const p = path;
      items.push({
        title: (
          <span onClick={() => navigateTo(p)} style={{ cursor: "pointer" }}>
            {part}
          </span>
        ),
      });
    });
    return items;
  };

  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (text: string, record: FileEntry) => (
        <div
          style={{
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
          onClick={() => {
            setState({ ...state, selectedFile: record });
            if (record.is_dir) {
              navigateTo(record.path);
            } else {
              onFileOpen(record.path, false);
            }
          }}
          onDoubleClick={() => {
            if (record.is_dir) {
              navigateTo(record.path);
            } else {
              onFileOpen(record.path, false);
            }
          }}
        >
          {record.is_dir ? (
            <FolderOutlined style={{ color: "#faad14" }} />
          ) : (
            <FileOutlined style={{ color: "#8c8c8c" }} />
          )}
          <span
            style={{
              color: state.selectedFile?.path === record.path ? "#1677ff" : "inherit",
              fontWeight: state.selectedFile?.path === record.path ? 600 : 400,
            }}
          >
            {text}
          </span>
        </div>
      ),
    },
    {
      title: "大小",
      dataIndex: "size",
      key: "size",
      width: 80,
      render: (size: number, record: FileEntry) => (record.is_dir ? "-" : formatFileSize(size)),
    },
    {
      title: "修改时间",
      dataIndex: "modified",
      key: "modified",
      width: 150,
      render: (modified: number) => formatTime(modified),
    },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: token.colorBgContainer,
      }}
    >
      {/* 工具栏 */}
      <div
        style={{
          padding: "4px 8px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexWrap: "wrap",
        }}
      >
        <Tooltip title="后退">
          <Button
            size="small"
            icon={<ArrowLeftOutlined />}
            onClick={goBack}
            disabled={state.historyIndex <= 0}
          />
        </Tooltip>
        <Tooltip title="前进">
          <Button
            size="small"
            icon={<ArrowRightOutlined />}
            onClick={goForward}
            disabled={state.historyIndex >= state.history.length - 1}
          />
        </Tooltip>
        <Tooltip title="刷新">
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => loadDirectory(state.currentPath)}
          />
        </Tooltip>
        <Tooltip title="上级">
          <Button size="small" onClick={goUp}>
            上级
          </Button>
        </Tooltip>
        <Tooltip title={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}>
          <Button
            size="small"
            icon={showHidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
            onClick={onToggleHidden}
            type={showHidden ? "primary" : "text"}
          />
        </Tooltip>
        <div style={{ flex: 1, minWidth: 0, marginLeft: 8 }}>
          <Breadcrumb items={buildBreadcrumb()} />
        </div>
      </div>
      {/* 路径输入 */}
      <div
        style={{
          padding: "4px 8px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <Input
          size="small"
          value={state.currentPath}
          onChange={(e) => setState({ ...state, currentPath: e.target.value })}
          onPressEnter={() => loadDirectory(state.currentPath)}
          placeholder="输入路径后回车"
          prefix={<FolderOutlined />}
        />
      </div>
      {/* 文件列表 */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <Table
          columns={columns}
          dataSource={state.fileList}
          rowKey="path"
          size="small"
          pagination={false}
        />
      </div>
      {/* 状态栏 */}
      <div
        style={{
          padding: "2px 8px",
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          fontSize: 12,
          color: token.colorTextSecondary,
          background: token.colorBgContainer,
        }}
      >
        {panelId === "left" ? "左面板" : "右面板"} · {state.fileList.length} 项
        {state.selectedFile && (
          <span style={{ marginLeft: 8 }}>已选: {state.selectedFile.name}</span>
        )}
      </div>
    </div>
  );
};

interface DualPanelViewProps {
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

export default function DualPanelView({ onClose, onOpenFile }: DualPanelViewProps) {
  const [showHidden, setShowHidden] = useState(false);
  const [syncBrowsing, setSyncBrowsing] = useState(false);
  const [leftPanel, setLeftPanel] = useState<PanelState>({
    currentPath: "/Users/zifang",
    history: ["/Users/zifang"],
    historyIndex: 0,
    fileList: [],
    selectedFile: null,
  });
  const [rightPanel, setRightPanel] = useState<PanelState>({
    currentPath: "/Users/zifang",
    history: ["/Users/zifang"],
    historyIndex: 0,
    fileList: [],
    selectedFile: null,
  });
  const { token } = theme.useToken();

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: token.colorBgLayout,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <ColumnHeightOutlined style={{ fontSize: 18, color: token.colorPrimary }} />
        <span style={{ fontWeight: 600 }}>双面板模式</span>
        <span style={{ color: token.colorTextSecondary, fontSize: 12, marginLeft: 8 }}>
          双击文件夹进入 · 单击文件可触发右侧
        </span>
        <Tooltip title={syncBrowsing ? "同步浏览已开启，点此关闭" : "开启同步浏览（两侧面板联动导航）"}>
          <Button
            size="small"
            icon={<SwapOutlined />}
            onClick={() => setSyncBrowsing(!syncBrowsing)}
            type={syncBrowsing ? "primary" : "text"}
          >
            {syncBrowsing ? "同步" : "同步"}
          </Button>
        </Tooltip>
        <div style={{ flex: 1 }} />
        <Button
          size="small"
          icon={<CloseOutlined />}
          onClick={onClose}
        >
          关闭双面板
        </Button>
      </div>
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, borderRight: `1px solid ${token.colorBorderSecondary}` }}>
          <Panel
            panelId="left"
            state={leftPanel}
            setState={setLeftPanel}
            onFileOpen={onOpenFile}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden(!showHidden)}
            syncNavigate={undefined}
          />
        </div>
        <div style={{ flex: 1 }}>
          <Panel
            panelId="right"
            state={rightPanel}
            setState={setRightPanel}
            onFileOpen={onOpenFile}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden(!showHidden)}
          />
        </div>
      </div>
    </div>
  );
}
