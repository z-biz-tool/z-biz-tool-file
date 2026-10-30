import { useState, useEffect, useCallback } from "react";
import { Input, Button, Breadcrumb, Table, Tooltip, theme, App as AntdApp } from "antd";
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
import { resolveHomeDir } from "../utils/homeDir";
import SideBySideDiff from "./SideBySideDiff";
import { describeApply, applyConfirmText, type DiffApplyAction } from "../utils/diffApply";

interface PanelState {
  currentPath: string;
  history: string[];
  historyIndex: number;
  fileList: FileEntry[];
  selectedFile: FileEntry | null;
}

interface DiffLine {
  kind: "context" | "add" | "remove";
  old_line: number | null;
  new_line: number | null;
  content: string;
}

interface DiffResult {
  added: number;
  removed: number;
  equal: number;
  lines: DiffLine[];
  old_size: number;
  new_size: number;
}

const Panel: React.FC<{
  panelId: "left" | "right";
  state: PanelState;
  setState: React.Dispatch<React.SetStateAction<PanelState>>;
  onFileOpen: (path: string, isDir: boolean) => void;
  showHidden: boolean;
  onToggleHidden: () => void;
  syncNavigate?: (path: string) => void;
  /** 对比模式下：点文件只选中，不交给系统打开 */
  selectOnly?: boolean;
}> = ({ panelId, state, setState, onFileOpen, showHidden, onToggleHidden, syncNavigate, selectOnly }) => {
  const { message } = AntdApp.useApp();
  const { token } = theme.useToken();

  const loadDirectory = useCallback(
    (path: string) => {
      const cmd = showHidden ? "list_directory_with_hidden" : "list_directory";
      const args = showHidden ? { path, showHidden: true } : { path };
      invoke(cmd, args)
        .then((entries: unknown) => {
          // 用函数式更新而不是 `{...state}`：加载是异步的，回来时 state 可能已经被
          // 导航/同步改过了，展开旧快照会把那些改动整个盖掉（选中的文件会消失）。
          setState((prev) => ({ ...prev, currentPath: path, fileList: entries as FileEntry[] }));
        })
        .catch((err) => {
          message.error(`${panelId} 加载失败: ${err}`);
        });
    },
    [panelId, showHidden, setState, message]
  );

  // 当前路径变化时重载列表。
  //
  // 早先这里只跟 showHidden，于是"同步浏览"把另一侧导航到新路径后，路径变了
  // 列表却还是旧的 —— 路径条和列表内容对不上。路径是列表的来源，就得跟它走。
  useEffect(() => {
    if (state.currentPath) {
      loadDirectory(state.currentPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden, state.currentPath]);

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
    // 同步浏览：通知另一个面板跟随导航
    syncNavigate?.(path);
  };

  const goBack = () => {
    if (state.historyIndex > 0) {
      const newIndex = state.historyIndex - 1;
      const path = state.history[newIndex];
      setState({ ...state, historyIndex: newIndex, currentPath: path, selectedFile: null });
    }
  };

  const goForward = () => {
    if (state.historyIndex < state.history.length - 1) {
      const newIndex = state.historyIndex + 1;
      const path = state.history[newIndex];
      setState({ ...state, historyIndex: newIndex, currentPath: path, selectedFile: null });
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

  /** 对比模式下点文件只选中（不打开、不双击触发系统程序） */
  const handleClick = (record: FileEntry) => {
    setState({ ...state, selectedFile: record });
    if (record.is_dir) {
      navigateTo(record.path);
    } else if (!selectOnly) {
      onFileOpen(record.path, false);
    }
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
          onClick={() => handleClick(record)}
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
          <Button aria-label="后退"
            size="small"
            icon={<ArrowLeftOutlined />}
            onClick={goBack}
            disabled={state.historyIndex <= 0}
          />
        </Tooltip>
        <Tooltip title="前进">
          <Button aria-label="前进"
            size="small"
            icon={<ArrowRightOutlined />}
            onClick={goForward}
            disabled={state.historyIndex >= state.history.length - 1}
          />
        </Tooltip>
        <Tooltip title="刷新">
          <Button aria-label="刷新"
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
          <Button aria-label={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
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

/**
 * 同步浏览：把另一侧导航到同一个路径。
 *
 * 只在"同步"开关打开时接线。两侧的 history 各自记一份 —— 面板的后退/前进
 * 语义是"我这一侧走过哪里"，同步的是当前位置，不是历史。
 */
function syncTo(
  target: PanelState,
  setTarget: (s: PanelState) => void,
  path: string
) {
  if (!path || target.currentPath === path) return;
  setTarget({
    ...target,
    currentPath: path,
    history: [...target.history.slice(0, target.historyIndex + 1), path],
    historyIndex: target.historyIndex + 1,
    selectedFile: null,
  });
}

export default function DualPanelView({ onClose, onOpenFile }: DualPanelViewProps) {
  const { message, modal } = AntdApp.useApp();
  const [showHidden, setShowHidden] = useState(false);
  const [syncBrowsing, setSyncBrowsing] = useState(false);
  /** "browse" = 两个浏览器；"compare" = 底部展开并排 diff */
  const [mode, setMode] = useState<"browse" | "compare">("browse");
  const emptyPanel = (): PanelState => ({
    currentPath: "",
    history: [],
    historyIndex: -1,
    fileList: [],
    selectedFile: null,
  });
  const [leftPanel, setLeftPanel] = useState<PanelState>(emptyPanel);
  const [rightPanel, setRightPanel] = useState<PanelState>(emptyPanel);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const { token } = theme.useToken();

  // 双栏面板打开时落到当前用户主目录
  useEffect(() => {
    let cancelled = false;
    resolveHomeDir().then((home) => {
      if (cancelled) return;
      const init: PanelState = { ...emptyPanel(), currentPath: home, history: [home], historyIndex: 0 };
      setLeftPanel(init);
      setRightPanel({ ...init });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const leftFile = leftPanel.selectedFile && !leftPanel.selectedFile.is_dir
    ? leftPanel.selectedFile.path
    : null;
  const rightFile = rightPanel.selectedFile && !rightPanel.selectedFile.is_dir
    ? rightPanel.selectedFile.path
    : null;

  /** 两侧都选好了文件就跑一次对比。 */
  const runDiff = useCallback(async () => {
    if (!leftFile || !rightFile) {
      message.warning("请在左右两侧各选一个文件");
      return;
    }
    setDiffLoading(true);
    try {
      const result = await invoke<DiffResult>("diff_files", {
        oldPath: leftFile,
        newPath: rightFile,
      });
      setDiffResult(result);
      message.success(`对比完成：+${result.added} / -${result.removed}`);
    } catch (e: any) {
      message.error("对比失败: " + e);
    } finally {
      setDiffLoading(false);
    }
  }, [leftFile, rightFile, message]);

  /**
   * 把一侧应用到另一侧（覆盖 / 互换）。
   *
   * 与 DiffViewer 走同一套文案与后端命令；确认框必须走 context 的 modal.confirm，
   * 并把目标路径摊开 —— 这是会改写用户文件的操作。
   */
  const applySide = useCallback(
    async (action: DiffApplyAction) => {
      const desc = describeApply(action, leftFile, rightFile);
      if (!desc) {
        message.warning("请在左右两侧各选一个文件");
        return;
      }
      const go = await new Promise<boolean>((resolve) => {
        modal.confirm({
          title: desc.title,
          content: applyConfirmText(desc),
          okText: desc.okText,
          okType: "danger",
          cancelText: "取消",
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!go) return;
      try {
        await invoke("apply_diff_side", {
          leftPath: leftFile,
          rightPath: rightFile,
          mode: desc.mode,
        });
        message.success("已应用");
        await runDiff();
      } catch (e: any) {
        message.error("应用失败: " + e);
      }
    },
    [leftFile, rightFile, message, modal, runDiff]
  );

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
          {mode === "compare"
            ? "对比模式 · 左右各选一个文件，点「开始对比」看并排差异"
            : "双击文件夹进入 · 单击文件可触发右侧"}
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
        <Button
          size="small"
          type={mode === "compare" ? "primary" : "text"}
          onClick={() => setMode(mode === "compare" ? "browse" : "compare")}
        >
          {mode === "compare" ? "退出对比" : "对比模式"}
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          size="small"
          icon={<CloseOutlined />}
          onClick={onClose}
        >
          关闭双面板
        </Button>
      </div>
      <div style={{ flex: 1, display: "flex", overflow: "hidden", flexDirection: "column" }}>
        <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
          <div style={{ flex: 1, borderRight: `1px solid ${token.colorBorderSecondary}` }}>
            <Panel
              panelId="left"
              state={leftPanel}
              setState={setLeftPanel}
              onFileOpen={onOpenFile}
              showHidden={showHidden}
              onToggleHidden={() => setShowHidden(!showHidden)}
              // 同步浏览：两侧联动导航。之前这个按钮一直挂着但没人接线，
              // 开着"同步"点过去另一侧纹丝不动 —— 按钮承诺的事没兑现。
              syncNavigate={syncBrowsing ? (p) => syncTo(rightPanel, setRightPanel, p) : undefined}
              selectOnly={mode === "compare"}
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
              syncNavigate={syncBrowsing ? (p) => syncTo(leftPanel, setLeftPanel, p) : undefined}
              selectOnly={mode === "compare"}
            />
          </div>
        </div>

        {mode === "compare" && (
          <div
            style={{
              flex: "0 0 45%",
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgContainer,
              padding: 8,
              gap: 8,
              overflow: "auto",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Button
                type="primary"
                size="small"
                loading={diffLoading}
                disabled={!leftFile || !rightFile}
                onClick={runDiff}
              >
                开始对比
              </Button>
              <Button
                size="small"
                disabled={!leftFile || !rightFile}
                onClick={() => applySide("left_to_right")}
              >
                用左侧覆盖右侧
              </Button>
              <Button
                size="small"
                disabled={!leftFile || !rightFile}
                onClick={() => applySide("right_to_left")}
              >
                用右侧覆盖左侧
              </Button>
              <Button
                size="small"
                disabled={!leftFile || !rightFile}
                onClick={() => applySide("swap")}
              >
                左右互换
              </Button>
              <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
                左：{leftFile || "（未选）"} · 右：{rightFile || "（未选）"}
              </span>
            </div>

            {diffResult ? (
              <SideBySideDiff
                lines={diffResult.lines}
                leftLabel={leftFile || "左侧"}
                rightLabel={rightFile || "右侧"}
                maxHeight={320}
              />
            ) : (
              <div style={{ color: token.colorTextSecondary, fontSize: 12 }}>
                选好左右两个文件后点「开始对比」。
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
