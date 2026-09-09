import { useState, useCallback } from "react";
import {
  Modal,
  Button,
  Space,
  Input,
  Typography,
  message,
  Tabs,
  Card,
  Row,
  Col,
  Statistic,
  Tag,
  Table,
} from "antd";
import {
  SwapOutlined,
  FileTextOutlined,
  FolderOutlined,
  PlusOutlined,
  MinusOutlined,
  EditOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

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

interface DirDiffSummary {
  added_files: string[];
  removed_files: string[];
  modified_files: string[];
}

interface DiffViewerProps {
  open: boolean;
  onClose: () => void;
  initialLeft?: string | null;
  initialRight?: string | null;
}

export default function DiffViewer({ open, onClose, initialLeft, initialRight }: DiffViewerProps) {
  const [tab, setTab] = useState<"file" | "dir">("file");
  const [msgApi, msgContext] = message.useMessage();

  // 文件对比
  const [leftFile, setLeftFile] = useState<string | null>(initialLeft || null);
  const [rightFile, setRightFile] = useState<string | null>(initialRight || null);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

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

  const doFileDiff = useCallback(async () => {
    if (!leftFile || !rightFile) {
      message.warning("请选择两个文件");
      return;
    }
    setDiffLoading(true);
    try {
      const result = await invoke<DiffResult>("diff_files", {
        oldPath: leftFile,
        newPath: rightFile,
      });
      setDiffResult(result);
      msgApi.success(`对比完成：+${result.added} / -${result.removed}`);
    } catch (e: any) {
      msgApi.error("对比失败: " + e);
    } finally {
      setDiffLoading(false);
    }
  }, [leftFile, rightFile, msgApi]);

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
      msgApi.success(
        `对比完成：+${result.added_files.length} / -${result.removed_files.length} / ~${result.modified_files.length}`
      );
    } catch (e: any) {
      msgApi.error("对比失败: " + e);
    } finally {
      setDirLoading(false);
    }
  }, [leftDir, rightDir, msgApi]);

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
      width={1000}
      footer={null}
      destroyOnClose
    >
      {msgContext}
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

                <Button
                  type="primary" icon={<SwapOutlined />} loading={diffLoading}
                  disabled={!leftFile || !rightFile}
                  onClick={doFileDiff}
                  block size="large"
                >
                  开始对比
                </Button>

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

                {/* Diff 显示 */}
                {diffResult && (
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
                            <td style={{ width: 50, padding: "2px 8px", color: "#999", textAlign: "right", userSelect: "none" }}>
                              {line.old_line || ""}
                            </td>
                            <td style={{ width: 50, padding: "2px 8px", color: "#999", textAlign: "right", userSelect: "none" }}>
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

                    {dirDiff.added_files.length > 0 && (
                      <Card size="small" title={<span><PlusOutlined style={{ color: "#52c41a" }} /> 新增 ({dirDiff.added_files.length})</span>}>
                        {dirDiff.added_files.slice(0, 50).map((f) => (
                          <Tag key={f} color="green" style={{ margin: 2 }}>{f}</Tag>
                        ))}
                        {dirDiff.added_files.length > 50 && (
                          <Text type="secondary">... 还有 {dirDiff.added_files.length - 50} 个</Text>
                        )}
                      </Card>
                    )}

                    {dirDiff.removed_files.length > 0 && (
                      <Card size="small" title={<span><MinusOutlined style={{ color: "#ff4d4f" }} /> 删除 ({dirDiff.removed_files.length})</span>}>
                        {dirDiff.removed_files.slice(0, 50).map((f) => (
                          <Tag key={f} color="red" style={{ margin: 2 }}>{f}</Tag>
                        ))}
                        {dirDiff.removed_files.length > 50 && (
                          <Text type="secondary">... 还有 {dirDiff.removed_files.length - 50} 个</Text>
                        )}
                      </Card>
                    )}

                    {dirDiff.modified_files.length > 0 && (
                      <Card size="small" title={<span><EditOutlined style={{ color: "#faad14" }} /> 修改 ({dirDiff.modified_files.length})</span>}>
                        <Table
                          size="small"
                          pagination={false}
                          scroll={{ y: 200 }}
                          dataSource={dirDiff.modified_files.slice(0, 100).map((f) => ({ key: f, name: f }))}
                          columns={[{ title: "文件", dataIndex: "name", ellipsis: true }]}
                        />
                      </Card>
                    )}
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