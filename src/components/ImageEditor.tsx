import { useState, useRef, useEffect, useCallback } from "react";
import {
  Button, Space, Slider, Drawer, Tooltip, message, Modal, Radio, Tag, theme,
} from "antd";
import {
  RotateLeftOutlined, RotateRightOutlined, SyncOutlined,
  SwapOutlined, ScissorOutlined, FilterOutlined, DownloadOutlined,
  ZoomInOutlined, ZoomOutOutlined, ArrowLeftOutlined, CheckOutlined, CloseOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

interface ImageInfo {
  width: number;
  height: number;
  format: string;
  size: number;
}

interface Props {
  filePath: string;
  fileName: string;
  onBack: () => void;
}

const FILTERS = [
  { key: "none", label: "原图" },
  { key: "grayscale", label: "灰度" },
  { key: "sepia", label: "复古" },
  { key: "invert", label: "反色" },
  { key: "brightness", label: "增亮" },
  { key: "contrast", label: "增对比" },
  { key: "blur", label: "模糊" },
  { key: "sharpen", label: "锐化" },
];

export default function ImageEditor({ filePath, fileName, onBack }: Props) {
  const { token } = theme.useToken();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const [zoom, setZoom] = useState(100);
  const [filterOpen, setFilterOpen] = useState(false);
  const [currentFilter, setCurrentFilter] = useState("none");
  const [cropMode, setCropMode] = useState(false);
  const [cropRect, setCropRect] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState("png");
  const [exportQuality, setExportQuality] = useState(85);
  const [processing, setProcessing] = useState(false);

  // 加载图片信息
  useEffect(() => {
    invoke("get_image_info", { path: filePath })
      .then((i) => setInfo(i as ImageInfo))
      .catch(() => {});
  }, [filePath]);

  // 加载图片到Canvas
  const loadImage = useCallback(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      drawCanvas(img, zoom, currentFilter);
    };
    // Tauri asset protocol
    const assetPath = filePath.startsWith("http")
      ? filePath
      : `asset://localhost/${encodeURIComponent(filePath)}`;
    img.src = assetPath;
  }, [filePath, zoom, currentFilter]);

  useEffect(() => { loadImage(); }, [loadImage]);

  const drawCanvas = (img: HTMLImageElement, zoomPct: number, filter: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = zoomPct / 100;
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // CSS filter for preview
    const filterMap: Record<string, string> = {
      none: "none",
      grayscale: "grayscale(100%)",
      sepia: "sepia(100%)",
      invert: "invert(100%)",
      brightness: "brightness(1.4)",
      contrast: "contrast(1.5)",
      blur: "blur(2px)",
      sharpen: "contrast(1.3) brightness(1.05)",
    };
    ctx.filter = filterMap[filter] || "none";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.filter = "none";

    // Draw crop overlay
    if (cropMode && cropRect.w > 0 && cropRect.h > 0) {
      const r = { x: cropRect.x * scale, y: cropRect.y * scale, w: cropRect.w * scale, h: cropRect.h * scale };
      // Dim outside
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillRect(0, 0, canvas.width, r.y);
      ctx.fillRect(0, r.y + r.h, canvas.width, canvas.height - r.y - r.h);
      ctx.fillRect(0, r.y, r.x, r.h);
      ctx.fillRect(r.x + r.w, r.y, canvas.width - r.x - r.w, r.h);
      // Border
      ctx.strokeStyle = "#1677ff";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      // Corner handles
      const hs = 8;
      ctx.fillStyle = "#1677ff";
      for (const [cx, cy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
        ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
      }
    }
  };

  // 鼠标事件 - 裁剪拖拽
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!cropMode || !imgRef.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const scale = zoom / 100;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    setDragStart({ x, y });
    setCropRect({ x, y, w: 0, h: 0 });
    setDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging || !cropMode || !imgRef.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const scale = zoom / 100;
    const x = Math.max(0, Math.min((e.clientX - rect.left) / scale, imgRef.current.width));
    const y = Math.max(0, Math.min((e.clientY - rect.top) / scale, imgRef.current.height));
    setCropRect({
      x: Math.min(dragStart.x, x),
      y: Math.min(dragStart.y, y),
      w: Math.abs(x - dragStart.x),
      h: Math.abs(y - dragStart.y),
    });
  };

  const handleMouseUp = () => { setDragging(false); };

  // 滚轮缩放
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(10, Math.min(500, z + (e.deltaY > 0 ? -10 : 10))));
  };

  // Rust操作
  const doRustOp = async (cmd: string, args: Record<string, unknown>) => {
    setProcessing(true);
    try {
      await invoke(cmd, { ...args, path: filePath, destPath: filePath });
      message.success("操作成功");
      loadImage();
      invoke("get_image_info", { path: filePath }).then((i) => setInfo(i as ImageInfo));
    } catch (err) {
      message.error("操作失败: " + err);
    } finally {
      setProcessing(false);
    }
  };

  const handleRotate = (deg: number) => doRustOp("rotate_image", { degrees: deg });
  const handleFlip = (h: boolean) => doRustOp("flip_image", { horizontal: h });
  const handleFilter = (name: string) => {
    if (name === "none") { setCurrentFilter("none"); return; }
    doRustOp("apply_filter", { filterName: name });
  };
  const handleCropConfirm = () => {
    if (cropRect.w < 5 || cropRect.h < 5) { message.warning("裁剪区域太小"); return; }
    doRustOp("crop_image", { x: Math.round(cropRect.x), y: Math.round(cropRect.y), w: Math.round(cropRect.w), h: Math.round(cropRect.h) });
    setCropMode(false);
    setCropRect({ x: 0, y: 0, w: 0, h: 0 });
  };

  // 导出
  const handleExport = async () => {
    const destPath = await save({
      defaultPath: fileName.replace(/\.\w+$/, "." + exportFormat),
      filters: [{ name: exportFormat.toUpperCase(), extensions: [exportFormat] }],
    });
    if (!destPath) return;
    setProcessing(true);
    try {
      await invoke("export_image", { path: filePath, destPath, format: exportFormat, quality: exportQuality });
      message.success("导出成功: " + destPath);
      setExportOpen(false);
    } catch (err) {
      message.error("导出失败: " + err);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: token.colorBgLayout }}>
      {/* 工具栏 */}
      <div style={{
        padding: "6px 12px", borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
      }}>
        <Button icon={<ArrowLeftOutlined />} onClick={onBack}>返回</Button>
        <Tag color="blue">{fileName}</Tag>
        {info && <Tag>{info.width}×{info.height} {info.format} {(info.size / 1024).toFixed(1)}KB</Tag>}

        <Space.Compact>
          <Tooltip title="左转90°"><Button icon={<RotateLeftOutlined />} onClick={() => handleRotate(90)} loading={processing} /></Tooltip>
          <Tooltip title="右转90°"><Button icon={<RotateRightOutlined />} onClick={() => handleRotate(-90)} loading={processing} /></Tooltip>
          <Tooltip title="旋转180°"><Button icon={<SyncOutlined />} onClick={() => handleRotate(180)} loading={processing} /></Tooltip>
        </Space.Compact>
        <Space.Compact>
          <Tooltip title="水平翻转"><Button icon={<SwapOutlined />} onClick={() => handleFlip(true)} loading={processing} /></Tooltip>
          <Tooltip title="垂直翻转"><Button icon={<SwapOutlined style={{ transform: "rotate(90deg)" }} />} onClick={() => handleFlip(false)} loading={processing} /></Tooltip>
        </Space.Compact>

        {cropMode ? (
          <Space>
            <Button type="primary" icon={<CheckOutlined />} onClick={handleCropConfirm} loading={processing}>确认裁剪</Button>
            <Button icon={<CloseOutlined />} onClick={() => { setCropMode(false); setCropRect({ x: 0, y: 0, w: 0, h: 0 }); }}>取消</Button>
          </Space>
        ) : (
          <Button icon={<ScissorOutlined />} onClick={() => setCropMode(true)}>裁剪</Button>
        )}

        <Button icon={<FilterOutlined />} onClick={() => setFilterOpen(true)}>滤镜</Button>
        <Button type="primary" icon={<DownloadOutlined />} onClick={() => setExportOpen(true)}>导出</Button>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
          <Button icon={<ZoomOutOutlined />} onClick={() => setZoom((z) => Math.max(10, z - 20))} />
          <span style={{ width: 50, textAlign: "center", fontSize: 12 }}>{zoom}%</span>
          <Button icon={<ZoomInOutlined />} onClick={() => setZoom((z) => Math.min(500, z + 20))} />
        </div>
      </div>

      {/* 画布区 */}
      <div
        style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", cursor: cropMode ? "crosshair" : "default" }}
        onWheel={handleWheel}
      >
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
        />
      </div>

      {/* 状态栏 */}
      <div style={{
        padding: "4px 12px", borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer, fontSize: 12, color: token.colorTextSecondary,
        display: "flex", justifyContent: "space-between",
      }}>
        <span>缩放: {zoom}% | {info ? `${info.width}×${info.height}` : "加载中..."}</span>
        <span>{cropMode ? "拖拽选择裁剪区域" : processing ? "处理中..." : "就绪"}</span>
      </div>

      {/* 滤镜抽屉 */}
      <Drawer title="滤镜" open={filterOpen} onClose={() => setFilterOpen(false)} width={280}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {FILTERS.map((f) => (
            <div
              key={f.key}
              onClick={() => handleFilter(f.key)}
              style={{
                padding: 8, borderRadius: 8, border: currentFilter === f.key ? `2px solid ${token.colorPrimary}` : "1px solid #f0f0f0",
                cursor: "pointer", textAlign: "center", background: currentFilter === f.key ? token.colorPrimaryBg : undefined,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: currentFilter === f.key ? 600 : 400 }}>{f.label}</div>
            </div>
          ))}
        </div>
      </Drawer>

      {/* 导出弹窗 */}
      <Modal title="导出图片" open={exportOpen} onOk={handleExport} onCancel={() => setExportOpen(false)} okText="导出" confirmLoading={processing}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>格式</div>
          <Radio.Group value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}>
            <Radio value="png">PNG</Radio>
            <Radio value="jpg">JPG</Radio>
            <Radio value="webp">WebP</Radio>
            <Radio value="bmp">BMP</Radio>
          </Radio.Group>
        </div>
        {exportFormat === "jpg" && (
          <div>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>质量: {exportQuality}%</div>
            <Slider min={1} max={100} value={exportQuality} onChange={setExportQuality} />
          </div>
        )}
      </Modal>
    </div>
  );
}
