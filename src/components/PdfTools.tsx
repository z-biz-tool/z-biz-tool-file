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
  FolderOpenOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  compressPercent,
  compressSummary,
  countImageSkips,
  defaultCompressPath,
  docReverted,
  formatSize,
  type CompressReport,
} from "../utils/pdfCompress";

const { Text } = Typography;

interface ExtractReport {
  images: string[];
  skipped: string[];
}

const COMPRESS_PRESETS = [
  { label: "屏幕阅读", quality: 65, maxDimension: 1200, hint: "适合邮件/网盘分享，扫描页长边缩到 1200px" },
  { label: "均衡", quality: 70, maxDimension: 1600, hint: "默认档，屏幕阅读基本看不出差别" },
  { label: "打印级", quality: 85, maxDimension: 3000, hint: "保留更多细节，体积降得少" },
];

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
  const [wmOut, setWmOut] = useState<string | null>(null);

  // ====== Extract Images Tab ======
  const [extPath, setExtPath] = useState<string | null>(initialPath || null);
  const [extOutputDir, setExtOutputDir] = useState<string>("");
  const [extImages, setExtImages] = useState<string[]>([]);
  const [extSkipped, setExtSkipped] = useState<string[]>([]);

  // ====== Compress Tab ======
  const [compPath, setCompPath] = useState<string | null>(initialPath || null);
  const [compOutPath, setCompOutPath] = useState<string | null>(null);
  const [compReport, setCompReport] = useState<CompressReport | null>(null);
  const [compPreset, setCompPreset] = useState(1);
  const [compQuality, setCompQuality] = useState(COMPRESS_PRESETS[1].quality);
  const [compMaxDim, setCompMaxDim] = useState(COMPRESS_PRESETS[1].maxDimension);

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

  // 换了输入文件，上一份的统计就作废——留着会把两个文件的数字混在一起看
  useEffect(() => {
    setCompReport(null);
    setCompOutPath(null);
  }, [compPath]);

  const compResultPath = compOutPath || (compPath ? defaultCompressPath(compPath) : "");

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
      const pages = await invoke<number>("watermark_pdf", {
        inputPath: wmPath,
        outputPath: outPath,
        text: wmText,
        opacity: wmOpacity / 100,
      });
      setWmOut(outPath);
      msgApi.success(`已为 ${pages} 页添加水印`);
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
      const report = await invoke<ExtractReport>("extract_pdf_images", {
        inputPath: extPath,
        outputDir: extOutputDir,
      });
      setExtImages(report.images);
      setExtSkipped(report.skipped);
      if (report.images.length === 0) {
        // 文字版 PDF 本来就没有位图，说"完成"会让人以为功能坏了
        msgApi.info(
          report.skipped.length
            ? `没有图片可保存，${report.skipped.length} 张解码失败`
            : "这份 PDF 里没有嵌入位图"
        );
      } else if (report.skipped.length) {
        msgApi.warning(
          `已提取 ${report.images.length} 张，${report.skipped.length} 张跳过（见下方原因）`
        );
      } else {
        msgApi.success(`提取完成！共 ${report.images.length} 张图片`);
      }
    } catch (e: any) {
      msgApi.error("提取失败: " + e);
    } finally {
      setBusy(false);
    }
  };

  const applyCompPreset = (index: number) => {
    setCompPreset(index);
    setCompQuality(COMPRESS_PRESETS[index].quality);
    setCompMaxDim(COMPRESS_PRESETS[index].maxDimension);
  };

  const pickCompOut = async () => {
    if (!compPath) return;
    try {
      const sel = await saveDialog({
        defaultPath: compOutPath || defaultCompressPath(compPath),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (sel) setCompOutPath(sel);
    } catch (e: any) {
      message.error("选择失败: " + e);
    }
  };

  const doCompress = async () => {
    if (!compPath) {
      message.warning("请选择 PDF");
      return;
    }
    const outPath = compOutPath || defaultCompressPath(compPath);
    if (outPath === compPath) {
      message.warning("输出文件与原件相同，请换一个文件名");
      return;
    }
    setBusy(true);
    try {
      const report = await invoke<CompressReport>("compress_pdf", {
        inputPath: compPath,
        outputPath: outPath,
        quality: compQuality,
        maxDimension: compMaxDim,
      });
      setCompReport(report);
      const summary = compressSummary(report);
      if (summary.kind === "info") msgApi.info(summary.text);
      else msgApi.success(summary.text);
    } catch (e: any) {
      msgApi.error("压缩失败: " + e);
    } finally {
      setBusy(false);
    }
  };

  // ====== Render ======

  const compKept = compReport ? countImageSkips(compReport) : 0;
  const compReverted = !!compReport && docReverted(compReport);
  const compPct = compReport ? compressPercent(compReport) : 0;

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
                  {/* 传给后端的是不透明度：100% = 完全实心，别写成"透明度" */}
                  <Text>不透明度: {wmOpacity}%</Text>
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

                {wmOut && (
                  <Space style={{ width: "100%" }} direction="vertical" size={4}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      输出：{wmOut}（原文件未改动）
                    </Text>
                    <Button
                      size="small"
                      icon={<FolderOpenOutlined />}
                      onClick={() => invoke("reveal_in_finder", { path: wmOut })}
                    >
                      在访达中显示
                    </Button>
                  </Space>
                )}
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

                {(extImages.length > 0 || extSkipped.length > 0) && (
                  <Card
                    size="small"
                    title={`已提取 ${extImages.length} 张图片`}
                    extra={
                      extImages.length > 0 ? (
                        <Button
                          size="small"
                          icon={<FolderOpenOutlined />}
                          onClick={() =>
                            invoke("reveal_in_finder", { path: extImages[0] }).catch((err) =>
                              msgApi.error("打开 Finder 失败: " + err)
                            )
                          }
                        >
                          在访达中显示
                        </Button>
                      ) : null
                    }
                  >
                    {extImages.length > 0 && (
                      <div style={{ maxHeight: 160, overflow: "auto" }}>
                        {extImages.map((p) => (
                          <Tag
                            key={p}
                            icon={<PictureOutlined />}
                            style={{ cursor: "pointer", marginBottom: 4 }}
                            title={p}
                            onClick={() =>
                              invoke("reveal_in_finder", { path: p }).catch((err) =>
                                msgApi.error("打开 Finder 失败: " + err)
                              )
                            }
                          >
                            {p.split("/").pop()}
                          </Tag>
                        ))}
                      </div>
                    )}
                    {extSkipped.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <Text type="secondary">以下图片未能保存：</Text>
                        {extSkipped.map((reason) => (
                          <div key={reason}>
                            <Text type="warning" style={{ fontSize: 12 }}>{reason}</Text>
                          </div>
                        ))}
                      </div>
                    )}
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

                <div>
                  <Text>画质档位</Text>
                  <Radio.Group
                    value={compPreset}
                    onChange={(e) => applyCompPreset(e.target.value)}
                    optionType="button"
                    buttonStyle="solid"
                    size="small"
                    style={{ marginTop: 4 }}
                    options={COMPRESS_PRESETS.map((p, i) => ({ label: p.label, value: i }))}
                  />
                  <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {COMPRESS_PRESETS[compPreset].hint}
                    </Text>
                  </div>
                </div>

                <div>
                  <Text>JPEG 画质: {compQuality}</Text>
                  <Slider
                    value={compQuality}
                    min={20}
                    max={95}
                    onChange={(v: any) => setCompQuality(v)}
                    marks={{ 20: "20", 70: "70", 95: "95" }}
                  />
                </div>

                <div>
                  {/* 下限对齐后端 clamp(64, …)：更小的值会被静默抬到 64，摆出来就是骗人 */}
                  <Text>图片长边上限: {compMaxDim}px</Text>
                  <Slider
                    value={compMaxDim}
                    min={64}
                    max={4000}
                    step={64}
                    onChange={(v: any) => setCompMaxDim(v)}
                    marks={{ 64: "64", 1200: "1200", 2400: "2400", 4000: "4000" }}
                  />
                </div>

                <Space.Compact style={{ width: "100%" }}>
                  <Input value={compResultPath} readOnly placeholder="输出文件..." />
                  <Button onClick={pickCompOut} disabled={!compPath}>另存为</Button>
                </Space.Compact>

                <Button
                  type="primary" size="large" block loading={busy}
                  disabled={!compPath}
                  onClick={doCompress}
                >
                  开始压缩
                </Button>

                {compReport && (
                  <Card size="small">
                    <Row gutter={16}>
                      <Col span={8}>
                        <Statistic title="原始大小" value={formatSize(compReport.original_size)} />
                      </Col>
                      <Col span={8}>
                        <Statistic title="压缩后" value={formatSize(compReport.new_size)} />
                      </Col>
                      <Col span={8}>
                        <Statistic
                          title="压缩率"
                          value={compPct}
                          suffix="%"
                          valueStyle={{ color: compPct > 0 ? "#52c41a" : undefined }}
                        />
                      </Col>
                    </Row>
                    <Progress percent={compPct} strokeColor="#52c41a" style={{ marginTop: 12 }} />
                    <div style={{ marginTop: 8 }}>
                      <Space size={4} wrap>
                        <Tag color="blue">{compReport.rewritten} 张位图重编码</Tag>
                        <Tag color="cyan">{compReport.flated} 条流补 Flate</Tag>
                        {compKept > 0 && <Tag color="orange">{compKept} 张保持原样</Tag>}
                        {compReverted && <Tag color="default">已按原样输出副本</Tag>}
                      </Space>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        输出：{compResultPath}（原文件未改动）
                      </Text>
                      <Button
                        size="small"
                        icon={<FolderOpenOutlined />}
                        style={{ marginLeft: 8 }}
                        onClick={() =>
                          invoke("reveal_in_finder", { path: compResultPath }).catch((err) =>
                            msgApi.error("打开 Finder 失败: " + err)
                          )
                        }
                      >
                        在访达中显示
                      </Button>
                    </div>
                    {compReport.skipped.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        {compReport.skipped.map((reason) => (
                          <div key={reason}>
                            <Text type="warning" style={{ fontSize: 12 }}>{reason}</Text>
                          </div>
                        ))}
                      </div>
                    )}
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