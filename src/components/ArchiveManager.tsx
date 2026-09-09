import { useState, useEffect, useCallback } from "react";
import {
  Modal,
  Table,
  Button,
  message,
  Spin,
  Tabs,
  Space,
  Select,
  Form,
  Input,
  InputNumber,
  theme,
  Tag,
} from "antd";
import {
  FolderOutlined,
  FileOutlined,
  FileZipOutlined,
  CompressOutlined,
  ExpandOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { formatFileSize } from "../stores/fileStore";

// 归档条目
interface ArchiveEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  modified: number;
  compressed_size?: number;
  compression_ratio?: number;
}

// 归档格式
type ArchiveFormat = "zip" | "tar" | "tar.gz" | "tar.bz2" | "gz" | "bz2" | "7z";

interface ArchiveManagerProps {
  open: boolean;
  onClose: () => void;
  // 用于"压缩"模式：传入当前目录路径
  sourcePaths?: string[];
  // 用于"解压"模式：传入归档文件路径
  archivePath?: string | null;
  onRefresh?: () => void;
}

const FORMAT_OPTIONS: { value: ArchiveFormat; label: string; description: string; ext: string }[] = [
  { value: "zip", label: "ZIP", description: "通用压缩格式，跨平台", ext: ".zip" },
  { value: "tar.gz", label: "TAR.GZ", description: "Linux 常用，先打包再 gzip 压缩", ext: ".tar.gz" },
  { value: "tar.bz2", label: "TAR.BZ2", description: "更高压缩率，比 gzip 慢", ext: ".tar.bz2" },
  { value: "tar", label: "TAR", description: "纯打包，不压缩", ext: ".tar" },
  { value: "gz", label: "GZIP", description: "单文件 gzip 压缩", ext: ".gz" },
];

export default function ArchiveManager({
  open,
  onClose,
  sourcePaths,
  archivePath,
  onRefresh,
}: ArchiveManagerProps) {
  const { token } = theme.useToken();
  const [tab, setTab] = useState<"compress" | "extract">(archivePath ? "extract" : "compress");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);

  // 压缩相关
  const [compressFormat, setCompressFormat] = useState<ArchiveFormat>("zip");
  const [compressLevel, setCompressLevel] = useState(6);
  const [compressDest, setCompressDest] = useState("");
  const [compressSources, setCompressSources] = useState<string[]>(sourcePaths || []);

  // 解压相关
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntry[]>([]);
  const [currentArchive, setCurrentArchive] = useState<string | null>(archivePath || null);
  const [extractDest, setExtractDest] = useState("");
  const [selectedEntries, setSelectedEntries] = useState<string[]>([]);

  // 加载归档内容列表
  const loadArchiveContents = useCallback(async () => {
    if (!currentArchive) return;
    setLoading(true);
    try {
      const result = await invoke<ArchiveEntry[]>("list_zip_contents", {
        zipPath: currentArchive,
      });
      setArchiveEntries(result);
    } catch (err) {
      message.error("读取归档内容失败: " + err);
    } finally {
      setLoading(false);
    }
  }, [currentArchive]);

  useEffect(() => {
    if (open && tab === "extract" && currentArchive) {
      loadArchiveContents();
    }
    if (!open) {
      setArchiveEntries([]);
      setSelectedEntries([]);
    }
  }, [open, tab, currentArchive, loadArchiveContents]);

  useEffect(() => {
    if (archivePath) {
      setCurrentArchive(archivePath);
      setTab("extract");
    }
  }, [archivePath]);

  useEffect(() => {
    if (sourcePaths && sourcePaths.length > 0) {
      setCompressSources(sourcePaths);
      setTab("compress");
    }
  }, [sourcePaths]);

  // 选择源文件（点击压缩按钮时）
  const handleSelectSources = async () => {
    try {
      const selected = await openDialog({
        multiple: true,
        directory: false,
        title: "选择要压缩的文件或文件夹",
      });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        setCompressSources(paths);
      }
    } catch (err) {
      message.error("选择文件失败: " + err);
    }
  };

  // 选择目标归档路径
  const handleSelectDest = async () => {
    try {
      const ext = FORMAT_OPTIONS.find((f) => f.value === compressFormat)?.ext || ".zip";
      const dest = await saveDialog({
        title: "选择归档保存位置",
        defaultPath: `archive${ext}`,
        filters: [{ name: "Archive", extensions: [ext.replace(".", "")] }],
      });
      if (dest) setCompressDest(dest);
    } catch (err) {
      message.error("选择保存路径失败: " + err);
    }
  };

  // 选择解压目标目录
  const handleSelectExtractDest = async () => {
    try {
      const dir = await openDialog({
        directory: true,
        multiple: false,
        title: "选择解压目标目录",
      });
      if (dir) setExtractDest(dir as string);
    } catch (err) {
      message.error("选择目录失败: " + err);
    }
  };

  // 选择要解压/查看的归档
  const handleSelectArchive = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: "选择归档文件",
        filters: [
          { name: "Archives", extensions: ["zip", "tar", "gz", "tgz", "bz2", "tbz2", "7z"] },
        ],
      });
      if (selected) {
        setCurrentArchive(selected as string);
        setTab("extract");
      }
    } catch (err) {
      message.error("选择归档失败: " + err);
    }
  };

  // 执行压缩
  const handleCompress = async () => {
    if (compressSources.length === 0) {
      message.warning("请选择要压缩的文件或文件夹");
      return;
    }
    if (!compressDest) {
      message.warning("请选择归档保存路径");
      return;
    }

    setWorking(true);
    try {
      // zip 格式使用专门命令
      if (compressFormat === "zip") {
        await invoke("compress_to_zip", {
          paths: compressSources,
          destPath: compressDest,
        });
      } else if (compressFormat === "tar" || compressFormat === "tar.gz" || compressFormat === "tar.bz2") {
        // tar 系列
        await invoke("compress_to_tar", {
          paths: compressSources,
          destPath: compressDest,
          compression: compressFormat,
        });
      } else {
        // gz 单文件
        await invoke("compress_to_tar", {
          paths: compressSources,
          destPath: compressDest,
          compression: "gz",
        });
      }
      message.success("压缩完成！");
      onRefresh?.();
    } catch (err) {
      message.error("压缩失败: " + err);
    } finally {
      setWorking(false);
    }
  };

  // 执行解压
  const handleExtract = async () => {
    if (!currentArchive) {
      message.warning("请选择归档文件");
      return;
    }
    if (!extractDest) {
      message.warning("请选择解压目标目录");
      return;
    }

    setWorking(true);
    try {
      if (selectedEntries.length === 0) {
        // 全部解压
        await invoke("extract_archive", {
          archivePath: currentArchive,
          destDir: extractDest,
        });
        message.success("全部解压完成！");
      } else {
        // 解压选中条目
        const selectedEntryObjs = archiveEntries.filter((e) => selectedEntries.includes(e.path));
        for (const entry of selectedEntryObjs) {
          if (entry.is_dir) continue;
          try {
            await invoke("extract_zip_file", {
              zipPath: currentArchive,
              entryName: entry.name,
              destDir: extractDest,
            });
          } catch (err) {
            message.error(`解压 ${entry.name} 失败: ${err}`);
          }
        }
        message.success(`已解压 ${selectedEntryObjs.length} 个条目`);
      }
      onRefresh?.();
    } catch (err) {
      message.error("解压失败: " + err);
    } finally {
      setWorking(false);
    }
  };

  // 归档条目表格列
  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      ellipsis: true,
      render: (name: string, record: ArchiveEntry) => (
        <Space>
          {record.is_dir ? (
            <FolderOutlined style={{ color: token.colorWarning }} />
          ) : (
            <FileOutlined style={{ color: token.colorTextSecondary }} />
          )}
          <span>{name}</span>
        </Space>
      ),
    },
    {
      title: "大小",
      dataIndex: "size",
      key: "size",
      width: 120,
      render: (size: number, record: ArchiveEntry) => {
        if (record.is_dir) return "-";
        if (record.compressed_size !== undefined && record.size > 0) {
          const ratio = ((1 - record.compressed_size / record.size) * 100).toFixed(1);
          return (
            <Space direction="vertical" size={0}>
              <span>{formatFileSize(record.compressed_size)}</span>
              <Tag color="green" style={{ fontSize: 10 }}>
                -{ratio}%
              </Tag>
            </Space>
          );
        }
        return formatFileSize(size);
      },
    },
    {
      title: "原始大小",
      dataIndex: "size",
      key: "orig_size",
      width: 100,
      render: (size: number, record: ArchiveEntry) =>
        record.is_dir ? "-" : formatFileSize(size),
    },
    {
      title: "类型",
      dataIndex: "is_dir",
      key: "type",
      width: 80,
      render: (isDir: boolean) => (isDir ? "文件夹" : "文件"),
    },
    {
      title: "修改时间",
      dataIndex: "modified",
      key: "modified",
      width: 160,
      render: (modified: number) => {
        if (!modified) return "-";
        return new Date(modified * 1000).toLocaleString("zh-CN");
      },
    },
  ];

  // 压缩信息（保留供后续展示）
  // const totalSourceSize = compressSources.reduce((sum, p) => sum + 0, 0); // 实际文件大小需要后端提供

  return (
    <Modal
      title={
        <Space>
          <FileZipOutlined style={{ color: token.colorPrimary }} />
          <span>归档管理器</span>
          {currentArchive && tab === "extract" && (
            <Tag color="blue" style={{ marginLeft: 8 }}>
              {currentArchive.split("/").pop()}
            </Tag>
          )}
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={780}
      footer={null}
      destroyOnClose
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as "compress" | "extract")}
        items={[
          {
            key: "compress",
            label: (
              <span>
                <CompressOutlined /> 压缩
              </span>
            ),
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size={16}>
                {/* 源文件选择 */}
                <div>
                  <div style={{ marginBottom: 6, fontWeight: 500 }}>要压缩的文件/文件夹</div>
                  <Space.Compact style={{ width: "100%" }}>
                    <Input
                      value={compressSources.join(", ")}
                      placeholder="点击右侧按钮选择文件..."
                      readOnly
                      style={{ width: "calc(100% - 100px)" }}
                    />
                    <Button type="primary" onClick={handleSelectSources}>
                      选择...
                    </Button>
                  </Space.Compact>
                  {compressSources.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 12, color: token.colorTextSecondary }}>
                      已选择 {compressSources.length} 个项目
                    </div>
                  )}
                </div>

                {/* 格式选择 */}
                <Form layout="vertical">
                  <Form.Item label="压缩格式">
                    <Select
                      value={compressFormat}
                      onChange={setCompressFormat}
                      options={FORMAT_OPTIONS.map((f) => ({
                        value: f.value,
                        label: (
                          <Space>
                            <strong>{f.label}</strong>
                            <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
                              {f.description}
                            </span>
                          </Space>
                        ),
                      }))}
                    />
                  </Form.Item>
                  {compressFormat === "zip" && (
                    <Form.Item label="压缩级别 (0=不压缩, 9=最高压缩)">
                      <InputNumber
                        min={0}
                        max={9}
                        value={compressLevel}
                        onChange={(v) => setCompressLevel(v || 6)}
                        style={{ width: 120 }}
                      />
                    </Form.Item>
                  )}
                </Form>

                {/* 目标路径 */}
                <div>
                  <div style={{ marginBottom: 6, fontWeight: 500 }}>保存路径</div>
                  <Space.Compact style={{ width: "100%" }}>
                    <Input
                      value={compressDest}
                      onChange={(e) => setCompressDest(e.target.value)}
                      placeholder="点击右侧按钮选择保存位置..."
                      style={{ width: "calc(100% - 100px)" }}
                    />
                    <Button onClick={handleSelectDest}>浏览...</Button>
                  </Space.Compact>
                </div>

                <Button
                  type="primary"
                  size="large"
                  block
                  icon={<CompressOutlined />}
                  onClick={handleCompress}
                  loading={working}
                  disabled={compressSources.length === 0 || !compressDest}
                >
                  开始压缩
                </Button>
              </Space>
            ),
          },
          {
            key: "extract",
            label: (
              <span>
                <ExpandOutlined /> 解压
              </span>
            ),
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size={12}>
                {/* 归档文件选择 */}
                <div>
                  <div style={{ marginBottom: 6, fontWeight: 500 }}>归档文件</div>
                  <Space.Compact style={{ width: "100%" }}>
                    <Input
                      value={currentArchive || ""}
                      onChange={(e) => setCurrentArchive(e.target.value)}
                      placeholder="点击右侧按钮选择归档文件..."
                      style={{ width: "calc(100% - 100px)" }}
                    />
                    <Button type="primary" onClick={handleSelectArchive}>
                      选择...
                    </Button>
                  </Space.Compact>
                </div>

                {/* 归档内容列表 */}
                {loading ? (
                  <div style={{ textAlign: "center", padding: "40px 0" }}>
                    <Spin size="large" />
                    <div style={{ marginTop: 12, color: token.colorTextSecondary }}>
                      正在读取归档内容...
                    </div>
                  </div>
                ) : archiveEntries.length > 0 ? (
                  <Table
                    rowSelection={{
                      selectedRowKeys: selectedEntries,
                      onChange: (keys) => setSelectedEntries(keys as string[]),
                    }}
                    columns={columns}
                    dataSource={archiveEntries.map((e, i) => ({ ...e, key: e.path || String(i) }))}
                    size="small"
                    pagination={archiveEntries.length > 50 ? { pageSize: 50 } : false}
                    scroll={{ y: 300 }}
                    onRow={(record) => ({
                      onDoubleClick: () => {
                        if (!record.is_dir) {
                          setSelectedEntries([record.path]);
                        }
                      },
                    })}
                  />
                ) : currentArchive ? (
                  <div style={{ textAlign: "center", padding: "20px 0", color: token.colorTextSecondary }}>
                    归档为空或无法读取
                  </div>
                ) : null}

                {/* 目标目录 */}
                <div>
                  <div style={{ marginBottom: 6, fontWeight: 500 }}>解压到</div>
                  <Space.Compact style={{ width: "100%" }}>
                    <Input
                      value={extractDest}
                      onChange={(e) => setExtractDest(e.target.value)}
                      placeholder="点击右侧按钮选择目标文件夹..."
                      style={{ width: "calc(100% - 100px)" }}
                    />
                    <Button onClick={handleSelectExtractDest}>浏览...</Button>
                  </Space.Compact>
                </div>

                <Space style={{ width: "100%", justifyContent: "flex-end" }}>
                  <Button onClick={handleExtract} disabled={!currentArchive || !extractDest} loading={working}>
                    解压选中 ({selectedEntries.length})
                  </Button>
                  <Button
                    type="primary"
                    onClick={() => {
                      setSelectedEntries([]);
                      handleExtract();
                    }}
                    disabled={!currentArchive || !extractDest}
                    loading={working}
                  >
                    <ExpandOutlined /> 全部解压
                  </Button>
                </Space>
              </Space>
            ),
          },
        ]}
      />
    </Modal>
  );
}