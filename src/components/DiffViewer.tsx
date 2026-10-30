import { useState, useCallback, useEffect } from "react";
import {
  Modal,
  Button,
  Space,
  Input,
  Typography,
  Tabs,
  Card,
  Row,
  Col,
  Statistic,
  Tag,
  Table,
  App as AntdApp,
  Tooltip,
} from "antd";
import {
  SwapOutlined,
  FileTextOutlined,
  FolderOutlined,
  PlusOutlined,
  MinusOutlined,
  EditOutlined,
  DownloadOutlined,
  ArrowRightOutlined,
  ColumnHeightOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import SideBySideDiff from "./SideBySideDiff";
import {
  describeApply,
  applyConfirmText,
  type DiffApplyAction,
} from "../utils/diffApply";

const { Text } = Typography;

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

/**
 * 一条目录差异条目。
 *
 * 后端已经把相对路径还原成了左右两侧的绝对路径（`left_path` / `right_path`），
 * 所以点条目就能直接下钻到文件级 diff —— 前端不用也不该自己拼路径。
 */
interface DirDiffEntry {
  rel_path: string;
  left_path: string | null;
  right_path: string | null;
  status: "added" | "removed" | "modified";
}

interface DirDiffSummary {
  added_files: DirDiffEntry[];
  removed_files: DirDiffEntry[];
  modified_files: DirDiffEntry[];
}

interface DiffViewerProps {
  open: boolean;
  onClose: () => void;
  initialLeft?: string | null;
  initialRight?: string | null;
}

export default function DiffViewer({ open, onClose, initialLeft, initialRight }: DiffViewerProps) {
  const { message, modal } = AntdApp.useApp();
  const [tab, setTab] = useState<"file" | "dir">("file");

  // 文件对比
  const [leftFile, setLeftFile] = useState<string | null>(initialLeft || null);
  const [rightFile, setRightFile] = useState<string | null>(initialRight || null);

  // App 里这个面板是常驻挂载的（靠 open 显隐），只在 mount 时读一次 initial*
  // 就等于"从工具栏/右键第二次打开还是上次的两个文件"。开面板时按当前选择重来一遍。
  useEffect(() => {
    if (!open) return;
    setLeftFile(initialLeft || null);
    setRightFile(initialRight || null);
  }, [open, initialLeft, initialRight]);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  /** "统一" | "双栏"：并排视图与行内视图两种看法 */
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");

  // 目录对比
  const [leftDir, setLeftDir] = useState<string | null>(null);
  const [rightDir, setRightDir] = useState<string | null>(null);
  const [dirDiff, setDirDiff] = useState<DirDiffSummary | null>(null);
  const [dirLoading, setDirLoading] = useState(false);

  // 选文件
  const pickFile = async (setter: (v: string) => void) => {
    try {
      const sel = await openDialog({ multiple: false });
      if (sel && typeof sel === "string") setter(sel);
    } catch (e: any) {
      message.error("选择失败: " + e);
    }
  };

  const pickDir = async (setter: (v: string) => void) => {
    try {
      const sel = await openDialog({ directory: true, multiple: false });
      if (sel && typeof sel === "string") setter(sel);
    } catch (e: any) {
      message.error("选择失败: " + e);
    }
  };

  /** 跑一次文件对比并把结果放进 state。left/right 缺一就不跑。 */
  const runFileDiff = useCallback(async (left: string | null, right: string | null) => {
    if (!left || !right) {
      message.warning("请选择两个文件");
      return;
    }
    setDiffLoading(true);
    try {
      const result = await invoke<DiffResult>("diff_files", {
        oldPath: left,
        newPath: right,
      });
      setDiffResult(result);
      message.success(`对比完成：+${result.added} / -${result.removed}`);
    } catch (e: any) {
      message.error("对比失败: " + e);
    } finally {
      setDiffLoading(false);
    }
  }, [message]);

  const doFileDiff = useCallback(async () => {
    await runFileDiff(leftFile, rightFile);
  }, [leftFile, rightFile, runFileDiff]);

  const doDirDiff = useCallback(async () => {
    if (!leftDir || !rightDir) {
      message.warning("请选择两个目录");
      return;
    }
    setDirLoading(true);
    try {
      const result = await invoke<DirDiffSummary>("quick_diff_dirs", {
        leftDir,
        rightDir,
      });
      setDirDiff(result);
      message.success(
        `对比完成：+${result.added_files.length} / -${result.removed_files.length} / ~${result.modified_files.length}`
      );
    } catch (e: any) {
      message.error("对比失败: " + e);
    } finally {
      setDirLoading(false);
    }
  }, [leftDir, rightDir, message]);

  /**
   * 目录 diff 的条目下钻：把左右两侧的绝对路径填进文件对比，并立刻跑一次。
   *
   * 这是"目录 diff 点不进去"那个缺口的正面解法：条目自带两侧绝对路径，
   * 所以这里不需要猜路径，也不需要用户再手挑两个文件。
   */
  const drillIntoFile = useCallback(
    async (entry: DirDiffEntry) => {
      // 一侧不存在的条目（纯新增/纯删除）没法做双文件对比：
      // 那一侧不存在，diff_files 会直接报"读取失败"。
      if (!entry.left_path || !entry.right_path) {
        message.info(
          entry.status === "added"
            ? "这个文件只存在于右侧，无法双栏对比（可以到文件对比页选它与左侧任意文件比）"
            : "这个文件只存在于左侧，无法双栏对比（可以到文件对比页选它与右侧任意文件比）"
        );
        return;
      }
      setLeftFile(entry.left_path);
      setRightFile(entry.right_path);
      setTab("file");
      await runFileDiff(entry.left_path, entry.right_path);
    },
    [message, runFileDiff]
  );

  /**
   * 把一侧应用到另一侧（覆盖 / 互换）。
   *
   * 这是全站 diff 里唯一会改写用户文件的入口，所以确认框必须走 context 的
   * `modal.confirm`（静态 Modal.confirm 在深色主题下是白底黑字），并且
   * 把"目标路径是哪个"摊开写清楚。
   */
  const applySide = useCallback(
    async (action: DiffApplyAction) => {
      const desc = describeApply(action, leftFile, rightFile);
      if (!desc) {
        message.warning("请先选择两个文件");
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
        // 应用完两侧应当一致了，重跑一次让界面跟上真实状态
        await runFileDiff(leftFile, rightFile);
      } catch (e: any) {
        message.error("应用失败: " + e);
      }
    },
    [leftFile, rightFile, message, modal, runFileDiff]
  );

  // 导出 diff
  const exportDiff = () => {
    if (!diffResult) return;
    const content = diffResult.lines.map((l) => {
      const prefix = l.kind === "add" ? "+" : l.kind === "remove" ? "-" : " ";
      return `${prefix}${l.content}`;
    }).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "diff.patch";
    a.click();
    URL.revokeObjectURL(url);
  };

  /** 目录 diff 的一张表：三组条目共用一套渲染，只是配色不同。 */
  const renderDirTable = (
    entries: DirDiffEntry[],
    color: string,
    statusLabel: string
  ) => {
    if (entries.length === 0) return null;
    return (
      <Card
        size="small"
        title={
          <span>
            {statusLabel} ({entries.length})
          </span>
        }
      >
        <Table
          size="small"
          pagination={false}
          scroll={{ y: 220 }}
          dataSource={entries.slice(0, 200).map((e) => ({ key: e.rel_path, ...e }))}
          columns={[
            {
              title: "文件",
              dataIndex: "rel_path",
              ellipsis: true,
              render: (rel: string, row: DirDiffEntry) => (
                <span
                  style={{ color: "#1677ff", cursor: "pointer" }}
                  onClick={() => drillIntoFile(row)}
                >
                  {rel}
                </span>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 90,
              render: (s: string) => <Tag color={color}>{s}</Tag>,
            },
          ]}
        />
        {entries.length > 200 && (
          <Text type="secondary">... 还有 {entries.length - 200} 个</Text>
        )}
      </Card>
    );
  };

  return (
    <Modal
      title={
        <Space>
          <SwapOutlined style={{ color: "#1890ff" }} />
          <span>文件对比 (Diff)</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={1100}
      footer={null}
      destroyOnClose
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as "file" | "dir")}
        items={[
          {
            key: "file",
            label: <span><FileTextOutlined />文件对比</span>,
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size={12}>
                {/* 左右文件选择 */}
                <Row gutter={12}>
                  <Col span={12}>
                    <Text>原文件</Text>
                    <Space.Compact style={{ width: "100%", marginTop: 4 }}>
                      <Input value={leftFile || ""} readOnly placeholder="选择原文件..." />
                      <Button onClick={() => pickFile(setLeftFile)}>选择</Button>
                    </Space.Compact>
                  </Col>
                  <Col span={12}>
                    <Text>新文件</Text>
                    <Space.Compact style={{ width: "100%", marginTop: 4 }}>
                      <Input value={rightFile || ""} readOnly placeholder="选择新文件..." />
                      <Button onClick={() => pickFile(setRightFile)}>选择</Button>
                    </Space.Compact>
                  </Col>
                </Row>

                <Space.Compact style={{ width: "100%" }}>
                  <Button
                    type="primary" icon={<SwapOutlined />} loading={diffLoading}
                    disabled={!leftFile || !rightFile}
                    onClick={doFileDiff}
                    block size="large"
                  >
                    开始对比
                  </Button>
                  <Tooltip title="并排双栏视图">
                    <Button
                      size="large"
                      icon={<ColumnHeightOutlined />}
                      aria-label="切换双栏视图"
                      type={viewMode === "split" ? "default" : "text"}
                      onClick={() => setViewMode(viewMode === "split" ? "unified" : "split")}
                    />
                  </Tooltip>
                </Space.Compact>

                {/* 统计 */}
                {diffResult && (
                  <Row gutter={12}>
                    <Col span={6}>
                      <Card size="small">
                        <Statistic
                          title="新增行"
                          value={diffResult.added}
                          valueStyle={{ color: "#52c41a" }}
                          prefix={<PlusOutlined />}
                        />
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card size="small">
                        <Statistic
                          title="删除行"
                          value={diffResult.removed}
                          valueStyle={{ color: "#ff4d4f" }}
                          prefix={<MinusOutlined />}
                        />
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card size="small">
                        <Statistic
                          title="相同行"
                          value={diffResult.equal}
                          valueStyle={{ color: "#8c8c8c" }}
                        />
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card size="small">
                        <Statistic
                          title="大小变化"
                          value={((diffResult.new_size - diffResult.old_size) / 1024)}
                          precision={2}
                          suffix="KB"
                          prefix={<EditOutlined />}
                          valueStyle={{
                            color: diffResult.new_size >= diffResult.old_size ? "#52c41a" : "#ff4d4f",
                          }}
                        />
                      </Card>
                    </Col>
                  </Row>
                )}

                {/* 把一侧应用到另一侧 */}
                {diffResult && (
                  <Space wrap>
                    <Button
                      size="small"
                      icon={<ArrowRightOutlined />}
                      disabled={!leftFile || !rightFile}
                      onClick={() => applySide("left_to_right")}
                    >
                      用左侧覆盖右侧
                    </Button>
                    <Button
                      size="small"
                      icon={<ArrowRightOutlined />}
                      disabled={!leftFile || !rightFile}
                      onClick={() => applySide("right_to_left")}
                    >
                      用右侧覆盖左侧
                    </Button>
                    <Button
                      size="small"
                      icon={<SwapOutlined />}
                      disabled={!leftFile || !rightFile}
                      onClick={() => applySide("swap")}
                    >
                      左右互换
                    </Button>
                  </Space>
                )}

                {/* Diff 显示 */}
                {diffResult && viewMode === "split" && (
                  <SideBySideDiff
                    lines={diffResult.lines}
                    leftLabel={leftFile || "原文件"}
                    rightLabel={rightFile || "新文件"}
                  />
                )}

                {diffResult && viewMode === "unified" && (
                  <Card
                    size="small"
                    title="对比结果"
                    extra={
                      <Button size="small" icon={<DownloadOutlined />} onClick={exportDiff}>
                        导出 .patch
                      </Button>
                    }
                    bodyStyle={{ padding: 0, maxHeight: 500, overflow: "auto" }}
                  >
                    <table style={{ width: "100%", fontFamily: "monospace", fontSize: 12, borderCollapse: "collapse" }}>
                      <tbody>
                        {diffResult.lines.map((line, i) => (
                          <tr
                            key={i}
                            style={{
                              background:
                                line.kind === "add" ? "#f6ffed"
                                : line.kind === "remove" ? "#fff1f0"
                                : "transparent",
                              borderLeft: `3px solid ${
                                line.kind === "add" ? "#52c41a"
                                : line.kind === "remove" ? "#ff4d4f"
                                : "transparent"
                              }`,
                            }}
                          >
                            <td style={{ width: 50, padding: "2px 8px", color: "var(--ant-color-text-tertiary)", textAlign: "right", userSelect: "none" }}>
                              {line.old_line || ""}
                            </td>
                            <td style={{ width: 50, padding: "2px 8px", color: "var(--ant-color-text-tertiary)", textAlign: "right", userSelect: "none" }}>
                              {line.new_line || ""}
                            </td>
                            <td style={{ width: 20, padding: "2px 4px", textAlign: "center", userSelect: "none" }}>
                              {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                            </td>
                            <td style={{ padding: "2px 8px", whiteSpace: "pre" }}>
                              {line.content}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )}
              </Space>
            ),
          },
          {
            key: "dir",
            label: <span><FolderOutlined />目录对比</span>,
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size={12}>
                <Row gutter={12}>
                  <Col span={12}>
                    <Text>左侧目录</Text>
                    <Space.Compact style={{ width: "100%", marginTop: 4 }}>
                      <Input value={leftDir || ""} readOnly placeholder="选择左侧目录..." />
                      <Button onClick={() => pickDir(setLeftDir)}>选择</Button>
                    </Space.Compact>
                  </Col>
                  <Col span={12}>
                    <Text>右侧目录</Text>
                    <Space.Compact style={{ width: "100%", marginTop: 4 }}>
                      <Input value={rightDir || ""} readOnly placeholder="选择右侧目录..." />
                      <Button onClick={() => pickDir(setRightDir)}>选择</Button>
                    </Space.Compact>
                  </Col>
                </Row>

                <Button
                  type="primary" icon={<SwapOutlined />} loading={dirLoading}
                  disabled={!leftDir || !rightDir}
                  onClick={doDirDiff}
                  block size="large"
                >
                  开始对比
                </Button>

                {dirDiff && (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Text type="secondary">
                      点文件名可直接下钻到该文件的行内对比。
                    </Text>
                    <Row gutter={12}>
                      <Col span={8}>
                        <Card size="small">
                          <Statistic
                            title="新增文件"
                            value={dirDiff.added_files.length}
                            valueStyle={{ color: "#52c41a" }}
                            prefix={<PlusOutlined />}
                          />
                        </Card>
                      </Col>
                      <Col span={8}>
                        <Card size="small">
                          <Statistic
                            title="删除文件"
                            value={dirDiff.removed_files.length}
                            valueStyle={{ color: "#ff4d4f" }}
                            prefix={<MinusOutlined />}
                          />
                        </Card>
                      </Col>
                      <Col span={8}>
                        <Card size="small">
                          <Statistic
                            title="修改文件"
                            value={dirDiff.modified_files.length}
                            valueStyle={{ color: "#faad14" }}
                            prefix={<EditOutlined />}
                          />
                        </Card>
                      </Col>
                    </Row>

                    {renderDirTable(dirDiff.added_files, "green", "新增")}
                    {renderDirTable(dirDiff.removed_files, "red", "删除")}
                    {renderDirTable(dirDiff.modified_files, "gold", "修改")}
                  </Space>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Modal>
  );
}
