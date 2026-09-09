import { useState, useEffect } from "react";
import {
  Modal,
  Tabs,
  Button,
  Space,
  Input,
  Slider,
  Typography,
  message,
  Table,
  Tag,
  Row,
  Col,
  Statistic,
  Progress,
  Card,
  Radio,
} from "antd";
import {
  MergeCellsOutlined,
  ScissorOutlined,
  HighlightOutlined,
  PictureOutlined,
  CompressOutlined,
  FilePdfOutlined,
  PlusOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

const { Text } = Typography;

interface PdfPageInfo {
  page_number: number;
  width: number;
  height: number;
  size_bytes: number;
}

interface PdfToolsProps {
  open: boolean;
  onClose: () => void;
  initialPath?: string | null;
}

export default function PdfTools({ open, onClose, initialPath }: PdfToolsProps) {
  const [tab, setTab] = useState("merge");
  const [msgApi, msgContext] = message.useMessage();

  // ====== Merge Tab ======
  const [mergeFiles, setMergeFiles] = useState<string[]>([]);

  // ====== Split Tab ======
  const [splitPath, setSplitPath] = useState<string | null>(initialPath || null);
  const [splitPages, setSplitPages] = useState<PdfPageInfo[]>([]);
  const [splitMode, setSplitMode] = useState<"range" | "each" | "custom">("each");
  const [customRanges, setCustomRanges] = useState("1-3, 5-7");

  // ====== Watermark Tab ======
  const [wmPath, setWmPath] = useState<string | null>(initialPath || null);
  const [wmText, setWmText] = useState("CONFIDENTIAL");
  const [wmOpacity, setWmOpacity] = useState(30);

  // ====== Extract Images Tab ======
  const [extPath, setExtPath] = useState<string | null>(initialPath || null);
  const [extOutputDir, setExtOutputDir] = useState<string>("");
  const [extImages, setExtImages] = useState<string[]>([]);

  // ====== Compress Tab ======
  const [compPath, setCompPath] = useState<string | null>(initialPath || null);
  const [compBefore, setCompBefore] = useState(0);
  const [compAfter, setCompAfter] = useState(0);

  // ====== Busy ======
  const [busy, setBusy] = useState(false);

  // 加载拆分页信息
  const loadPdfPages = async (path: string) => {
    try {
      const pages = await invoke<PdfPageInfo[]>("get_pdf_pages", { path });
      setSplitPages(pages);
    } catch (e: any) {
      message.error("加载 PDF 失败: " + e);
    }
  };

  useEffect(() => {
    if (initialPath) {
      setSplitPath(initialPath);
      setWmPath(initialPath);
      setExtPath(initialPath);
      setCompPath(initialPath);
      loadPdfPages(initialPath);
    }
  }, [initialPath, open]);

  // 选 PDF 文件
  const pickPdfFiles = async () => {
    try {
      const sel = await openDialog({
        multiple: true,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (sel) {
        const arr = Array.isArray(sel) ? sel : [sel];
        setMergeFiles((prev) => [...prev, ...arr as string[]]);
      }
    } catch (e: any) {
      message.error("选择失败: " + e);
    }
  };

  const pickFile = async (setter: (v: string) => void) => {
    try {
      const sel = await openDialog({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (sel && typeof sel === "string") {
        setter(sel);
      }
    } catch (e: any) {
      message.error("选择失败: " + e);
    }
  };

  const pickFolder = async (setter: (v: string) => void) => {
    try {
      const sel = await openDialog({ directory: true, multiple: false });
      if (sel && typeof sel === "string") {
        setter(sel);
      }
    } catch (e: any) {
      message.error("选择失败: " + e);
    }
  };

  // ====== Actions ======

  const doMerge = async () => {
    if (mergeFiles.length < 2) {
      message.warning("请至少选择 2 个 PDF");
      return;
    }
    setBusy(true);
    try {
      const outPath = mergeFiles[0].replace(/\.pdf$/i, "") + "-merged.pdf";
      const count = await invoke<number>("merge_pdfs", {
        inputPaths: mergeFiles,
        outputPath: outPath,
      });
      msgApi.success(`合并完成！共 ${count} 页，输出: ${outPath}`);
      setMergeFiles([]);
    } catch (e: any) {
      msgApi.error("合并失败: " + e);
    } finally {
      setBusy(false);
    }
  };

  const doSplit = async () => {
    if (!splitPath) {
      message.warning("请选择 PDF");
      return;
    }
    setBusy(true);
    try {
      const outDir = splitPath.replace(/\.pdf$/i, "") + "-split";
      let ranges: [number, number][] = [];

      if (splitMode === "each") {
        ranges = splitPages.map((p) => [p.page_number, p.page_number] as [number, number]);
      } else if (splitMode === "range") {
        ranges = [[1, splitPages.length]] as [number, number][];
      } else {
        // 解析自定义范围 (如 "1-3, 5-7, 10")
        ranges = customRanges.split(",").map((s) => {
          const [a, b] = s.trim().split("-").map((n) => parseInt(n, 10));
          return [a, b || a] as [number, number];
        });
      }

      const outputs = await invoke<string[]>("split_pdf", {
        inputPath: splitPath,
        outputDir: outDir,
        pageRanges: ranges,
      });
      msgApi.success(`拆分完成！生成 ${outputs.length} 个文件于: ${outDir}`);
    } catch (e: any) {
      msgApi.error("拆分失败: " + e);
    } finally {
      setBusy(false);
    }
  };

  const doWatermark = async () => {
    if (!wmPath || !wmText) {
      message.warning("请选择 PDF 并输入水印文字");
      return;
    }
    setBusy(true);
    try {
      const outPath = wmPath.replace(/\.pdf$/i, "") + "-watermarked.pdf";
      await invoke("watermark_pdf", {
        inputPath: wmPath,
        outputPath: outPath,
        text: wmText,
        opacity: wmOpacity / 100,
      });
      msgApi.success(`水印添加完成！输出: ${outPath}`);
    } catch (e: any) {
      msgApi.error("添加水印失败: " + e);
    } finally {
      setBusy(false);
    }
  };

  const doExtractImages = async () => {
    if (!extPath || !extOutputDir) {
      message.warning("请选择 PDF 和输出目录");
      return;
    }
    setBusy(true);
    try {
      const imgs = await invoke<string[]>("extract_pdf_images", {
        inputPath: extPath,
        outputDir: extOutputDir,
      });
      setExtImages(imgs);
      msgApi.success(`提取完成！共 ${imgs.length} 张图片`);
    } catch (e: any) {
      msgApi.error("提取失败: " + e);
    } finally {
      setBusy(false);
    }
  };

  const doCompress = async () => {
    if (!compPath) {
      message.warning("请选择 PDF");
      return;
    }
    setBusy(true);
    try {
      const outPath = compPath.replace(/\.pdf$/i, "") + "-compressed.pdf";
      const [before, after] = await invoke<[number, number]>("compress_pdf", {
        inputPath: compPath,
        outputPath: outPath,
      });
      setCompBefore(before);
      setCompAfter(after);
      const ratio = ((1 - after / before) * 100).toFixed(1);
      msgApi.success(`压缩完成！减少 ${ratio}% (${(before - after) / 1024} KB)`);
    } catch (e: any) {
      msgApi.error("压缩失败: " + e);
    } finally {
      setBusy(false);
    }
  };

  // ====== Render ======

  return (
    <Modal
      title={
        <Space>
          <FilePdfOutlined style={{ color: "#e74c3c" }} />
          <span>PDF 工具集</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={780}
      footer={null}
      destroyOnClose
    >
      {msgContext}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "merge",
            label: <span><MergeCellsOutlined />合并</span>,
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Text>选择要合并的 PDF 文件（按顺序）</Text>
                <Space>
                  <Button icon={<PlusOutlined />} onClick={pickPdfFiles}>添加文件</Button>
                  <Button onClick={() => setMergeFiles([])} disabled={mergeFiles.length === 0}>清空</Button>
                </Space>
                {mergeFiles.length > 0 && (
                  <Table
                    rowKey={(r) => r}
                    size="small"
                    pagination={false}
                    dataSource={mergeFiles.map((p, i) => ({
                      key: i,
                      idx: i + 1,
                      path: p,
                      name: p.split("/").pop(),
                    }))}
                    columns={[
                      { title: "顺序", dataIndex: "idx", width: 60 },
                      { title: "文件名", dataIndex: "name" },
                      {
                        title: "操作",
                        width: 80,
                        render: (_: any, r: any) => (
                          <Button
                            type="link" danger size="small"
                            icon={<DeleteOutlined />}
                            onClick={() => setMergeFiles(mergeFiles.filter((_, i) => i !== r.idx - 1))}
                          />
                        ),
                      },
                    ]}
                  />
                )}
                <Button
                  type="primary" size="large" block loading={busy}
                  disabled={mergeFiles.length < 2}
                  onClick={doMerge}
                >
                  合并 {mergeFiles.length} 个 PDF
                </Button>
              </Space>
            ),
          },
          {
            key: "split",
            label: <span><ScissorOutlined />拆分</span>,
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Text>选择要拆分的 PDF</Text>
                <Space.Compact style={{ width: "100%" }}>
                  <Input value={splitPath || ""} readOnly placeholder="选择 PDF..." />
                  <Button onClick={() => pickFile((v) => {
                    setSplitPath(v);
                    loadPdfPages(v);
                  })}>选择</Button>
                </Space.Compact>

                {splitPages.length > 0 && (
                  <Card size="small" title={`共 ${splitPages.length} 页`}>
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Radio.Group
                        value={splitMode}
                        onChange={(e) => setSplitMode(e.target.value)}
                        options={[
                          { label: `每页一个文件（生成 ${splitPages.length} 个）`, value: "each" },
                          { label: `全部一页文件`, value: "range" },
                          { label: "自定义范围", value: "custom" },
                        ]}
                      />
                      {splitMode === "custom" && (
                        <Input
                          value={customRanges}
                          onChange={(e) => setCustomRanges(e.target.value)}
                          placeholder="如: 1-3, 5-7, 10"
                        />
                      )}
                    </Space>
                  </Card>
                )}

                <Button
                  type="primary" size="large" block loading={busy}
                  disabled={!splitPath}
                  onClick={doSplit}
                >
                  开始拆分
                </Button>
              </Space>
            ),
          },
          {
            key: "watermark",
            label: <span><HighlightOutlined />水印</span>,
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Text>选择 PDF</Text>
                <Space.Compact style={{ width: "100%" }}>
                  <Input value={wmPath || ""} readOnly placeholder="选择 PDF..." />
                  <Button onClick={() => pickFile(setWmPath)}>选择</Button>
                </Space.Compact>

                <div>
                  <Text>水印文字</Text>
                  <Input
                    value={wmText}
                    onChange={(e) => setWmText(e.target.value)}
                    placeholder="如: CONFIDENTIAL"
                    style={{ marginTop: 4 }}
                  />
                </div>

                <div>
                  <Text>透明度: {wmOpacity}%</Text>
                  <Slider
                    value={wmOpacity}
                    min={5}
                    max={100}
                    onChange={(v: any) => setWmOpacity(v)}
                  />
                </div>

                <Button
                  type="primary" size="large" block loading={busy}
                  disabled={!wmPath || !wmText}
                  onClick={doWatermark}
                >
                  添加水印
                </Button>
              </Space>
            ),
          },
          {
            key: "extract",
            label: <span><PictureOutlined />提取图片</span>,
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Text>选择 PDF 和输出目录</Text>
                <Space.Compact style={{ width: "100%" }}>
                  <Input value={extPath || ""} readOnly placeholder="选择 PDF..." />
                  <Button onClick={() => pickFile(setExtPath)}>选择 PDF</Button>
                </Space.Compact>

                <Space.Compact style={{ width: "100%" }}>
                  <Input value={extOutputDir} readOnly placeholder="输出目录..." />
                  <Button onClick={() => pickFolder(setExtOutputDir)}>选择目录</Button>
                </Space.Compact>

                <Button
                  type="primary" size="large" block loading={busy}
                  disabled={!extPath || !extOutputDir}
                  onClick={doExtractImages}
                >
                  提取嵌入图片
                </Button>

                {extImages.length > 0 && (
                  <Card size="small" title={`已提取 ${extImages.length} 张图片`}>
                    {extImages.map((p) => (
                      <Tag key={p} icon={<PictureOutlined />}>{p.split("/").pop()}</Tag>
                    ))}
                  </Card>
                )}
              </Space>
            ),
          },
          {
            key: "compress",
            label: <span><CompressOutlined />压缩</span>,
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Text>选择要压缩的 PDF</Text>
                <Space.Compact style={{ width: "100%" }}>
                  <Input value={compPath || ""} readOnly placeholder="选择 PDF..." />
                  <Button onClick={() => pickFile(setCompPath)}>选择</Button>
                </Space.Compact>

                <Button
                  type="primary" size="large" block loading={busy}
                  disabled={!compPath}
                  onClick={doCompress}
                >
                  开始压缩
                </Button>

                {compBefore > 0 && (
                  <Card size="small">
                    <Row gutter={16}>
                      <Col span={8}>
                        <Statistic title="原始大小" value={(compBefore / 1024).toFixed(2)} suffix="KB" />
                      </Col>
                      <Col span={8}>
                        <Statistic title="压缩后" value={(compAfter / 1024).toFixed(2)} suffix="KB" />
                      </Col>
                      <Col span={8}>
                        <Statistic
                          title="压缩率"
                          value={((1 - compAfter / compBefore) * 100).toFixed(1)}
                          suffix="%"
                          valueStyle={{ color: "#52c41a" }}
                        />
                      </Col>
                    </Row>
                    <Progress
                      percent={Math.round((1 - compAfter / compBefore) * 100)}
                      strokeColor="#52c41a"
                      style={{ marginTop: 12 }}
                    />
                  </Card>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Modal>
  );
}