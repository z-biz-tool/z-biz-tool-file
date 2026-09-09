import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Layout,
  Tabs,
  Slider,
  Button,
  Space,
  Typography,
  message,
  Modal,
  Select,
  ColorPicker,
  Empty,
  Tooltip,
  Input,
} from "antd";
import {
  ArrowLeftOutlined,
  BgColorsOutlined,
  BorderOutlined,
  CheckOutlined,
  CompressOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FontSizeOutlined,
  FormatPainterOutlined,
  HighlightOutlined,
  InfoCircleOutlined,
  LineOutlined,
  RedoOutlined,
  ReloadOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  ScissorOutlined,
  SwapOutlined,
  UndoOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

const { Sider, Content } = Layout;
const { Title, Text } = Typography;

// =============== 类型 ===============

interface ImageInfo {
  width: number;
  height: number;
  format: string;
  size: number;
  has_alpha: boolean;
  exif: Record<string, string> | null;
}

type Tool =
  | "move"
  | "crop"
  | "text"
  | "rect"
  | "arrow"
  | "line"
  | "brush"
  | "eyedropper";

type FilterPreset =
  | "none" | "grayscale" | "sepia" | "invert"
  | "vintage" | "cool" | "warm" | "dramatic"
  | "bw_high_contrast" | "vivid" | "soft";

// =============== 滤镜预设 (CSS) ===============

const FILTER_PRESETS: { key: FilterPreset; label: string; value: string; emoji: string }[] = [
  { key: "none", label: "原图", value: "none", emoji: "🌅" },
  { key: "grayscale", label: "黑白", value: "grayscale(100%)", emoji: "⚫" },
  { key: "sepia", label: "复古", value: "sepia(80%)", emoji: "🟫" },
  { key: "invert", label: "反色", value: "invert(100%)", emoji: "🌓" },
  { key: "vintage", label: "怀旧", value: "sepia(50%) contrast(110%) brightness(95%) saturate(120%)", emoji: "📜" },
  { key: "cool", label: "冷调", value: "hue-rotate(180deg) saturate(110%)", emoji: "❄️" },
  { key: "warm", label: "暖调", value: "sepia(20%) saturate(140%) hue-rotate(-15deg)", emoji: "🔥" },
  { key: "dramatic", label: "戏剧", value: "contrast(150%) saturate(140%) brightness(90%)", emoji: "🎭" },
  { key: "bw_high_contrast", label: "高对比黑白", value: "grayscale(100%) contrast(180%)", emoji: "⚫" },
  { key: "vivid", label: "鲜艳", value: "saturate(180%) contrast(110%)", emoji: "🌈" },
  { key: "soft", label: "柔和", value: "blur(0.5px) brightness(110%) saturate(80%)", emoji: "☁️" },
];

// =============== 工具组件 ===============

interface ImageEditorProps {
  filePath: string;
  onBack: () => void;
}

export default function ImageEditor({ filePath, onBack }: ImageEditorProps) {
  const { } = { /* token */ }; // 占位
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(false);

  // 元信息
  const [info, setInfo] = useState<ImageInfo | null>(null);

  // 视图
  const [zoom, setZoom] = useState(100);

  // 当前工具
  const [tool, setTool] = useState<Tool>("move");

  // ========== 调整 (Adjustments) ==========
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);
  const [hueRotate, setHueRotate] = useState(0);
  const [blur, setBlur] = useState(0);
  const [sepia, setSepia] = useState(0);
  const [invert, setInvert] = useState(0);
  const [exposure, setExposure] = useState(0); // -100 ~ 100
  const [vibrance, setVibrance] = useState(0); // 自然饱和度
  const [sharpen, setSharpen] = useState(0);
  const [highlights, setHighlights] = useState(0);
  const [shadows, setShadows] = useState(0);
  const [whites, setWhites] = useState(0);
  const [blacks, setBlacks] = useState(0);
  const [temp, setTemp] = useState(0); // 色温 -100(冷) ~ 100(暖)
  const [tint, setTint] = useState(0); // 色调 -100(绿) ~ 100(紫)

  // 滤镜
  const [filter, setFilter] = useState<FilterPreset>("none");
  const filterCss = useMemo(
    () => FILTER_PRESETS.find((f) => f.key === filter)?.value || "none",
    [filter]
  );

  // 几何变换
  const [rotate, setRotate] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [scale, setScale] = useState(100);

  // 裁剪
  const [cropMode, setCropMode] = useState(false);
  const [cropRect, setCropRect] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [dragging, setDragging] = useState<null | "move" | "nw" | "ne" | "sw" | "se">(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, rect: { x: 0, y: 0, w: 0, h: 0 } });

  // 标注层
  interface Annotation {
    id: string;
    type: "text" | "rect" | "arrow" | "line";
    x: number;
    y: number;
    w?: number;
    h?: number;
    text?: string;
    color: string;
    fontSize?: number;
    strokeWidth: number;
  }
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [currentAnnot, setCurrentAnnot] = useState<Partial<Annotation> | null>(null);
  const [selectedAnnotId] = useState<string | null>(null);
  const [textColor, setTextColor] = useState("#FF3B30");
  const [textFontSize, setTextFontSize] = useState(24);
  const [strokeWidth, setStrokeWidth] = useState(3);

  // 历史
  const [history, setHistory] = useState<Array<ImageData>>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  // 导出
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState("png");
  const [exportQuality, setExportQuality] = useState(92);
  const [exportResize, setExportResize] = useState(100);
  const [processing, setProcessing] = useState(false);

  // 当前filter叠加在画布上的合成filter
  const canvasFilterCss = useMemo(() => {
    const parts: string[] = [];
    if (filter !== "none") parts.push(filterCss);
    parts.push(`brightness(${brightness + exposure / 2}%)`);
    parts.push(`contrast(${contrast + (highlights - shadows) * 0.5}%)`);
    parts.push(`saturate(${saturation + vibrance}%)`);
    if (hueRotate !== 0) parts.push(`hue-rotate(${hueRotate}deg)`);
    if (blur > 0) parts.push(`blur(${blur}px)`);
    if (sepia > 0) parts.push(`sepia(${sepia}%)`);
    if (invert > 0) parts.push(`invert(${invert}%)`);
    return parts.join(" ");
  }, [
    filter, filterCss, brightness, contrast, saturation, hueRotate,
    blur, sepia, invert, exposure, vibrance, highlights, shadows,
  ]);

  // ============ 加载图像 ============

  const loadImage = useCallback(() => {
    if (!filePath) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    const src = filePath.startsWith("http") ? filePath : convertFileSrc(filePath);
    img.onload = () => {
      imgRef.current = img;
      setImgReady(true);
      // 拉元信息
      invoke<ImageInfo>("get_image_info", { path: filePath })
        .then((i) => setInfo(i))
        .catch(() => setInfo({
          width: img.naturalWidth,
          height: img.naturalHeight,
          format: filePath.split(".").pop()?.toUpperCase() || "PNG",
          size: 0,
          has_alpha: true,
          exif: null,
        }));
    };
    img.onerror = () => {
      message.error("图像加载失败");
    };
    img.src = src;
  }, [filePath]);

  useEffect(() => { loadImage(); }, [loadImage]);

  // 转换 file:// URL（Tauri 2 中通过 convertFileSrc）
  function convertFileSrc(path: string): string {
    // 简单的 macOS / Windows 文件路径转 file:// URL
    if (path.startsWith("file://")) return path;
    const normalized = path.replace(/\\/g, "/");
    return `file://${normalized}`;
  }

  // ============ 绘制 ============

  const drawImage = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // CSS filter 让浏览器执行图像处理（亮度/对比/饱和等）
    ctx.filter = canvasFilterCss || "none";

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.scale(
      (flipH ? -1 : 1) * (scale / 100),
      (flipV ? -1 : 1) * (scale / 100)
    );
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }, [canvasFilterCss, rotate, flipH, flipV, scale]);

  useEffect(() => {
    if (imgReady) drawImage();
  }, [imgReady, drawImage]);

  // 同步 overlay 尺寸
  useEffect(() => {
    if (!overlayRef.current || !canvasRef.current) return;
    overlayRef.current.width = canvasRef.current.width;
    overlayRef.current.height = canvasRef.current.height;
  }, [imgReady, drawImage]);

  // 重绘 overlay（标注 + 裁剪框）
  const drawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!overlay || !canvas) return;
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // 绘制裁剪框
    if (cropMode && cropRect.w > 0 && cropRect.h > 0) {
      // 半透明遮罩
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, overlay.width, overlay.height);
      ctx.clearRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      // 边框
      ctx.strokeStyle = "#1890ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      // 九宫格
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      for (let i = 1; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(cropRect.x + (cropRect.w * i) / 3, cropRect.y);
        ctx.lineTo(cropRect.x + (cropRect.w * i) / 3, cropRect.y + cropRect.h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cropRect.x, cropRect.y + (cropRect.h * i) / 3);
        ctx.lineTo(cropRect.x + cropRect.w, cropRect.y + (cropRect.h * i) / 3);
        ctx.stroke();
      }
      // 四角把手
      const handleSize = 12;
      const corners = [
        { x: cropRect.x, y: cropRect.y, name: "nw" },
        { x: cropRect.x + cropRect.w, y: cropRect.y, name: "ne" },
        { x: cropRect.x, y: cropRect.y + cropRect.h, name: "sw" },
        { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h, name: "se" },
      ];
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#1890ff";
      ctx.lineWidth = 2;
      for (const c of corners) {
        ctx.fillRect(c.x - handleSize / 2, c.y - handleSize / 2, handleSize, handleSize);
        ctx.strokeRect(c.x - handleSize / 2, c.y - handleSize / 2, handleSize, handleSize);
      }
    }

    // 绘制标注
    for (const a of annotations) {
      ctx.strokeStyle = a.color;
      ctx.fillStyle = a.color;
      ctx.lineWidth = a.strokeWidth;
      if (a.type === "rect") {
        ctx.strokeRect(a.x, a.y, a.w || 50, a.h || 50);
      } else if (a.type === "arrow") {
        drawArrow(ctx, a.x, a.y, a.x + (a.w || 100), a.y + (a.h || 0), a.strokeWidth);
      } else if (a.type === "line") {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + (a.w || 100), a.y + (a.h || 0));
        ctx.stroke();
      } else if (a.type === "text" && a.text) {
        ctx.font = `${a.fontSize || 24}px sans-serif`;
        ctx.fillText(a.text, a.x, a.y);
        if (a.id === selectedAnnotId) {
          const w = ctx.measureText(a.text).width;
          ctx.strokeStyle = "#1890ff";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(a.x - 4, a.y - (a.fontSize || 24), w + 8, (a.fontSize || 24) + 4);
          ctx.setLineDash([]);
        }
      }
    }
  }, [cropMode, cropRect, annotations, selectedAnnotId]);

  useEffect(() => {
    if (imgReady) drawOverlay();
  }, [imgReady, drawOverlay]);

  function drawArrow(
    ctx: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    width: number
  ) {
    const headLen = Math.max(12, width * 4);
    const angle = Math.atan2(toY - fromY, toX - fromX);
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLen * Math.cos(angle - Math.PI / 6), toY - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(toX - headLen * Math.cos(angle + Math.PI / 6), toY - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  // ============ 工具栏操作 ============

  const pushHistory = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    try {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      setHistory((prev) => {
        const next = prev.slice(0, historyIdx + 1);
        next.push(data);
        if (next.length > 30) next.shift();
        return next;
      });
      setHistoryIdx((idx) => Math.min(idx + 1, 29));
    } catch {
      // getImageData 在跨域时抛错，忽略
    }
  }, [historyIdx]);

  const undo = () => {
    if (historyIdx <= 0) return;
    const newIdx = historyIdx - 1;
    setHistoryIdx(newIdx);
    applyHistory(newIdx);
  };
  const redo = () => {
    if (historyIdx >= history.length - 1) return;
    const newIdx = historyIdx + 1;
    setHistoryIdx(newIdx);
    applyHistory(newIdx);
  };
  const applyHistory = (idx: number) => {
    const data = history[idx];
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext("2d");
    ctx?.putImageData(data, 0, 0);
  };

  const reset = () => {
    setBrightness(100); setContrast(100); setSaturation(100); setHueRotate(0);
    setBlur(0); setSepia(0); setInvert(0); setExposure(0); setVibrance(0);
    setRotate(0); setFlipH(false); setFlipV(false); setScale(100);
    setFilter("none"); setAnnotations([]); setCropMode(false);
    message.info("已重置所有调整");
  };

  // ============ 鼠标事件 (Overlay) ============

  const getOverlayPos = (e: React.MouseEvent) => {
    const overlay = overlayRef.current;
    if (!overlay) return { x: 0, y: 0 };
    const rect = overlay.getBoundingClientRect();
    const scaleX = overlay.width / rect.width;
    const scaleY = overlay.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const onOverlayDown = (e: React.MouseEvent) => {
    const pos = getOverlayPos(e);
    if (cropMode) {
      // 检查是否在把手
      const handleSize = 12;
      const c = { x: pos.x, y: pos.y };
      if (Math.abs(c.x - cropRect.x) < handleSize && Math.abs(c.y - cropRect.y) < handleSize) {
        setDragging("nw"); setDragStart({ x: pos.x, y: pos.y, rect: cropRect });
      } else if (Math.abs(c.x - (cropRect.x + cropRect.w)) < handleSize && Math.abs(c.y - cropRect.y) < handleSize) {
        setDragging("ne"); setDragStart({ x: pos.x, y: pos.y, rect: cropRect });
      } else if (Math.abs(c.x - cropRect.x) < handleSize && Math.abs(c.y - (cropRect.y + cropRect.h)) < handleSize) {
        setDragging("sw"); setDragStart({ x: pos.x, y: pos.y, rect: cropRect });
      } else if (Math.abs(c.x - (cropRect.x + cropRect.w)) < handleSize && Math.abs(c.y - (cropRect.y + cropRect.h)) < handleSize) {
        setDragging("se"); setDragStart({ x: pos.x, y: pos.y, rect: cropRect });
      } else if (c.x > cropRect.x && c.x < cropRect.x + cropRect.w && c.y > cropRect.y && c.y < cropRect.y + cropRect.h) {
        setDragging("move"); setDragStart({ x: pos.x, y: pos.y, rect: cropRect });
      } else {
        // 新建裁剪框
        setCropRect({ x: pos.x, y: pos.y, w: 0, h: 0 });
        setDragging("se");
        setDragStart({ x: pos.x, y: pos.y, rect: { x: pos.x, y: pos.y, w: 0, h: 0 } });
      }
      return;
    }

    // 标注
    if (tool === "rect" || tool === "arrow" || tool === "line" || tool === "text") {
      setCurrentAnnot({
        type: tool === "text" ? "text" : tool,
        x: pos.x, y: pos.y, w: 0, h: 0,
        color: textColor, fontSize: textFontSize, strokeWidth,
      });
      setDragStart({ x: pos.x, y: pos.y, rect: { x: pos.x, y: pos.y, w: 0, h: 0 } });
      setDragging("se");
    }
  };

  const onOverlayMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const pos = getOverlayPos(e);
    const dx = pos.x - dragStart.x;
    const dy = pos.y - dragStart.y;

    if (cropMode) {
      let r = { ...dragStart.rect };
      if (dragging === "move") {
        r.x = dragStart.rect.x + dx;
        r.y = dragStart.rect.y + dy;
      } else if (dragging === "nw") {
        r.x = dragStart.rect.x + dx; r.y = dragStart.rect.y + dy;
        r.w = dragStart.rect.w - dx; r.h = dragStart.rect.h - dy;
      } else if (dragging === "ne") {
        r.y = dragStart.rect.y + dy;
        r.w = dragStart.rect.w + dx; r.h = dragStart.rect.h - dy;
      } else if (dragging === "sw") {
        r.x = dragStart.rect.x + dx;
        r.w = dragStart.rect.w - dx; r.h = dragStart.rect.h + dy;
      } else if (dragging === "se") {
        r.w = dragStart.rect.w + dx; r.h = dragStart.rect.h + dy;
      }
      // 规范化
      if (r.w < 0) { r.x += r.w; r.w = -r.w; }
      if (r.h < 0) { r.y += r.h; r.h = -r.h; }
      setCropRect(r);
      return;
    }

    if (currentAnnot) {
      const w = pos.x - dragStart.x;
      const h = pos.y - dragStart.y;
      setCurrentAnnot({ ...currentAnnot, w, h });
    }
  };

  const onOverlayUp = () => {
    if (cropMode && dragging) {
      // 约束到图片范围内
      const c = canvasRef.current;
      if (c) {
        setCropRect((r) => ({
          ...r,
          x: Math.max(0, Math.min(r.x, c.width)),
          y: Math.max(0, Math.min(r.y, c.height)),
          w: Math.max(10, Math.min(r.w, c.width - r.x)),
          h: Math.max(10, Math.min(r.h, c.height - r.y)),
        }));
      }
      setDragging(null);
      return;
    }
    if (currentAnnot && (currentAnnot.type === "rect" || currentAnnot.type === "arrow" || currentAnnot.type === "line")) {
      if ((currentAnnot.w || 0) > 5 || (currentAnnot.h || 0) > 5) {
        const newAnnot: Annotation = {
          id: Date.now().toString(),
          type: currentAnnot.type,
          x: currentAnnot.x || 0,
          y: currentAnnot.y || 0,
          w: currentAnnot.w,
          h: currentAnnot.h,
          color: currentAnnot.color || textColor,
          strokeWidth: currentAnnot.strokeWidth || strokeWidth,
        };
        setAnnotations((prev) => [...prev, newAnnot]);
      }
      setCurrentAnnot(null);
      setDragging(null);
    } else if (currentAnnot && currentAnnot.type === "text") {
      // 弹窗输入文字
      let inputValue = "双击编辑";
      Modal.confirm({
        title: "输入文字",
        content: (
          <Input
            defaultValue={inputValue}
            autoFocus
            onChange={(e) => { inputValue = e.target.value; }}
            onPressEnter={(e) => { inputValue = (e.target as HTMLInputElement).value; }}
          />
        ),
        onOk: () => {
          if (inputValue) {
            setAnnotations((prev) => [
              ...prev,
              {
                id: Date.now().toString(),
                type: "text",
                x: currentAnnot.x || 0,
                y: currentAnnot.y || 0,
                text: inputValue,
                color: textColor,
                fontSize: textFontSize,
                strokeWidth: 0,
              },
            ]);
          }
          setCurrentAnnot(null);
          setDragging(null);
        },
        onCancel: () => {
          setCurrentAnnot(null);
          setDragging(null);
        },
      });
    } else {
      setDragging(null);
    }
  };

  // ============ 裁剪执行 ============

  const applyCrop = () => {
    if (cropRect.w === 0 || cropRect.h === 0) {
      message.warning("请先绘制裁剪框");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // 复制区域
    const data = ctx.getImageData(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    // 新建画布
    const newCanvas = document.createElement("canvas");
    newCanvas.width = cropRect.w;
    newCanvas.height = cropRect.h;
    const nctx = newCanvas.getContext("2d");
    if (!nctx) return;
    nctx.putImageData(data, 0, 0);
    // 替换主画布
    canvas.width = cropRect.w;
    canvas.height = cropRect.h;
    ctx.putImageData(data, 0, 0);
    setCropMode(false);
    setCropRect({ x: 0, y: 0, w: 0, h: 0 });
    pushHistory();
    message.success("已裁剪");
  };

  // ============ 导出 ============

  const exportImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setProcessing(true);
    try {
      const dataUrl = canvas.toDataURL(`image/${exportFormat}`, exportQuality / 100);
      const base64 = dataUrl.split(",")[1];
      // 调用后端保存
      const srcPath = filePath;
      const ext = exportFormat === "jpg" ? "jpg" : exportFormat;
      const destPath = srcPath.replace(/\.[^.]+$/, "") + `-edited.${ext}`;
      await invoke("save_image_data", { data: base64, destPath, format: exportFormat });
      message.success(`已保存到: ${destPath}`);
      setExportOpen(false);
    } catch (e: any) {
      message.error("导出失败: " + e);
    } finally {
      setProcessing(false);
    }
  };

  // ============ 撤销/重做时的画布恢复 ============

  useEffect(() => {
    if (historyIdx >= 0 && history[historyIdx]) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx?.putImageData(history[historyIdx], 0, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyIdx]);

  // =============== 渲染 ===============

  return (
    <Layout style={{ height: "100vh" }}>
      {/* 顶栏 */}
      <div
        style={{
          height: 48,
          background: "#1f1f1f",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 16,
        }}
      >
        <Button icon={<ArrowLeftOutlined />} onClick={onBack} type="text" style={{ color: "#fff" }}>
          返回
        </Button>
        <Text style={{ color: "#fff", maxWidth: 300 }} ellipsis>
          {filePath.split("/").pop()}
        </Text>
        <Space style={{ marginLeft: "auto" }}>
          <Tooltip title="撤销 (⌘Z)">
            <Button icon={<UndoOutlined />} type="text" style={{ color: "#fff" }} onClick={undo} disabled={historyIdx <= 0} />
          </Tooltip>
          <Tooltip title="重做 (⌘⇧Z)">
            <Button icon={<RedoOutlined />} type="text" style={{ color: "#fff" }} onClick={redo} disabled={historyIdx >= history.length - 1} />
          </Tooltip>
          <Tooltip title="重置">
            <Button icon={<ReloadOutlined />} type="text" style={{ color: "#fff" }} onClick={reset} />
          </Tooltip>
          <Tooltip title="缩小">
            <Button icon={<ZoomOutOutlined />} type="text" style={{ color: "#fff" }} onClick={() => setZoom((z) => Math.max(10, z - 10))} />
          </Tooltip>
          <Text style={{ color: "#fff", minWidth: 50, textAlign: "center" }}>{zoom}%</Text>
          <Tooltip title="放大">
            <Button icon={<ZoomInOutlined />} type="text" style={{ color: "#fff" }} onClick={() => setZoom((z) => Math.min(400, z + 10))} />
          </Tooltip>
          <Button icon={<CheckOutlined />} type="primary" onClick={applyCrop} disabled={!cropMode || cropRect.w === 0}>
            应用裁剪
          </Button>
          <Button icon={<DownloadOutlined />} type="primary" onClick={() => setExportOpen(true)}>
            导出
          </Button>
        </Space>
      </div>

      <Layout>
        {/* 左侧工具栏 */}
        <Sider width={56} theme="dark" style={{ background: "#1f1f1f" }}>
          <Space direction="vertical" size={4} style={{ padding: 8, width: "100%" }}>
            <ToolButton icon={<SwapOutlined />} active={tool === "move"} onClick={() => setTool("move")} tooltip="选择 / 移动" />
            <ToolButton icon={<ScissorOutlined />} active={cropMode} onClick={() => { setCropMode(!cropMode); setTool("move"); }} tooltip="裁剪" />
            <ToolButton icon={<FontSizeOutlined />} active={tool === "text"} onClick={() => setTool("text")} tooltip="文字" />
            <ToolButton icon={<BorderOutlined />} active={tool === "rect"} onClick={() => setTool("rect")} tooltip="矩形" />
            <ToolButton icon={<SwapOutlined rotate={45} />} active={tool === "arrow"} onClick={() => setTool("arrow")} tooltip="箭头" />
            <ToolButton icon={<LineOutlined />} active={tool === "line"} onClick={() => setTool("line")} tooltip="直线" />
          </Space>
        </Sider>

        {/* 画布区域 */}
        <Content
          ref={containerRef}
          style={{
            background: "#2a2a2a",
            overflow: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            position: "relative",
          }}
        >
          {!imgReady && <Empty description="加载中..." />}
          {imgReady && (
            <div
              style={{
                position: "relative",
                width: (canvasRef.current?.width || 1) * (zoom / 100),
                height: (canvasRef.current?.height || 1) * (zoom / 100),
                background: "transparent",
                boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
              }}
            >
              <canvas
                ref={canvasRef}
                style={{
                  width: "100%",
                  height: "100%",
                  display: "block",
                  filter: canvasFilterCss,
                  transform: `rotate(${rotate}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1}) scale(${scale / 100})`,
                }}
              />
              <canvas
                ref={overlayRef}
                style={{
                  position: "absolute",
                  top: 0, left: 0,
                  width: "100%",
                  height: "100%",
                  cursor: cropMode || tool !== "move" ? "crosshair" : "default",
                  display: "block",
                  transform: `rotate(${rotate}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1}) scale(${scale / 100})`,
                  transformOrigin: "center center",
                }}
                onMouseDown={onOverlayDown}
                onMouseMove={onOverlayMove}
                onMouseUp={onOverlayUp}
                onMouseLeave={onOverlayUp}
                onDoubleClick={(e) => {
                  // 双击删除标注
                  const pos = getOverlayPos(e);
                  const hit = annotations.find((a) => {
                    if (a.type === "text" && a.text) {
                      const ctx = overlayRef.current?.getContext("2d");
                      if (ctx) {
                        ctx.font = `${a.fontSize || 24}px sans-serif`;
                        const w = ctx.measureText(a.text).width;
                        return pos.x > a.x - 4 && pos.x < a.x + w + 4 && pos.y < a.y && pos.y > a.y - (a.fontSize || 24);
                      }
                    }
                    return false;
                  });
                  if (hit) setAnnotations((prev) => prev.filter((a) => a.id !== hit.id));
                }}
              />
              {/* 预览正在绘制的标注 */}
              {currentAnnot && (
                <div style={{
                  position: "absolute",
                  left: currentAnnot.x,
                  top: currentAnnot.y,
                  color: currentAnnot.color,
                  pointerEvents: "none",
                  fontSize: currentAnnot.fontSize,
                }}>
                  {currentAnnot.type === "text" ? "✎ 释放鼠标输入文字" : null}
                </div>
              )}
            </div>
          )}
        </Content>

        {/* 右侧属性面板 */}
        <Sider width={340} theme="light" style={{ background: "#fafafa", borderLeft: "1px solid #e8e8e8", overflow: "auto" }}>
          <Tabs
            tabPosition="top"
            size="small"
            style={{ padding: "0 8px" }}
            items={[
              {
                key: "adjust",
                label: <span><FormatPainterOutlined />调整</span>,
                children: (
                  <Space direction="vertical" style={{ width: "100%", padding: 8 }} size={12}>
                    <PanelSection title="基本">
                      <SliderRow label="亮度" value={brightness} min={0} max={200} onChange={setBrightness} suffix="%" />
                      <SliderRow label="对比度" value={contrast} min={0} max={200} onChange={setContrast} suffix="%" />
                      <SliderRow label="饱和度" value={saturation} min={0} max={200} onChange={setSaturation} suffix="%" />
                      <SliderRow label="曝光" value={exposure} min={-100} max={100} onChange={setExposure} />
                      <SliderRow label="自然饱和度" value={vibrance} min={-100} max={100} onChange={setVibrance} />
                    </PanelSection>

                    <PanelSection title="色彩">
                      <SliderRow label="色相" value={hueRotate} min={0} max={360} onChange={setHueRotate} suffix="°" />
                      <SliderRow label="色温" value={temp} min={-100} max={100} onChange={setTemp} />
                      <SliderRow label="色调" value={tint} min={-100} max={100} onChange={setTint} />
                    </PanelSection>

                    <PanelSection title="色调映射">
                      <SliderRow label="高光" value={highlights} min={-100} max={100} onChange={setHighlights} />
                      <SliderRow label="阴影" value={shadows} min={-100} max={100} onChange={setShadows} />
                      <SliderRow label="白色" value={whites} min={-100} max={100} onChange={setWhites} />
                      <SliderRow label="黑色" value={blacks} min={-100} max={100} onChange={setBlacks} />
                    </PanelSection>

                    <PanelSection title="效果">
                      <SliderRow label="模糊" value={blur} min={0} max={20} onChange={setBlur} suffix="px" />
                      <SliderRow label="怀旧" value={sepia} min={0} max={100} onChange={setSepia} suffix="%" />
                      <SliderRow label="反色" value={invert} min={0} max={100} onChange={setInvert} suffix="%" />
                      <SliderRow label="锐化" value={sharpen} min={0} max={100} onChange={setSharpen} suffix="%" disabled hint="前端为占位" />
                    </PanelSection>
                  </Space>
                ),
              },
              {
                key: "filter",
                label: <span><BgColorsOutlined />滤镜</span>,
                children: (
                  <div style={{ padding: 8 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                      {FILTER_PRESETS.map((f) => (
                        <div
                          key={f.key}
                          onClick={() => setFilter(f.key)}
                          style={{
                            border: filter === f.key ? "2px solid #1890ff" : "1px solid #e8e8e8",
                            borderRadius: 6,
                            padding: 8,
                            cursor: "pointer",
                            textAlign: "center",
                            background: filter === f.key ? "#e6f7ff" : "#fff",
                          }}
                        >
                          <div style={{ fontSize: 24 }}>{f.emoji}</div>
                          <Text style={{ fontSize: 11 }}>{f.label}</Text>
                        </div>
                      ))}
                    </div>
                  </div>
                ),
              },
              {
                key: "transform",
                label: <span><CompressOutlined />变换</span>,
                children: (
                  <Space direction="vertical" style={{ width: "100%", padding: 8 }} size={12}>
                    <PanelSection title="旋转">
                      <Space>
                        <Button icon={<RotateLeftOutlined />} onClick={() => setRotate((r) => r - 90)}>左旋 90°</Button>
                        <Button icon={<RotateRightOutlined />} onClick={() => setRotate((r) => r + 90)}>右旋 90°</Button>
                      </Space>
                      <SliderRow label="角度" value={rotate} min={-180} max={180} onChange={setRotate} suffix="°" />
                    </PanelSection>
                    <PanelSection title="翻转">
                      <Space>
                        <Button onClick={() => setFlipH(!flipH)} icon={<SwapOutlined />} type={flipH ? "primary" : "default"}>水平</Button>
                        <Button onClick={() => setFlipV(!flipV)} icon={<SwapOutlined rotate={90} />} type={flipV ? "primary" : "default"}>垂直</Button>
                      </Space>
                    </PanelSection>
                    <PanelSection title="缩放">
                      <SliderRow label="尺寸" value={scale} min={10} max={400} onChange={setScale} suffix="%" />
                    </PanelSection>
                  </Space>
                ),
              },
              {
                key: "annotate",
                label: <span><HighlightOutlined />标注</span>,
                children: (
                  <Space direction="vertical" style={{ width: "100%", padding: 8 }} size={12}>
                    <PanelSection title="当前工具">
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {tool === "move" && "选择/移动"}
                        {tool === "text" && "📝 点击画布添加文字"}
                        {tool === "rect" && "🟦 拖动绘制矩形"}
                        {tool === "arrow" && "➡️ 拖动绘制箭头"}
                        {tool === "line" && "📏 拖动绘制直线"}
                      </Text>
                    </PanelSection>
                    <PanelSection title="样式">
                      <Space>
                        <span>颜色:</span>
                        <ColorPicker value={textColor} onChange={(c) => setTextColor(c.toHexString())} showText />
                      </Space>
                      <SliderRow label="字号" value={textFontSize} min={8} max={96} onChange={setTextFontSize} suffix="px" />
                      <SliderRow label="线宽" value={strokeWidth} min={1} max={20} onChange={setStrokeWidth} suffix="px" />
                    </PanelSection>
                    <PanelSection title={`图层 (${annotations.length})`}>
                      <Button danger size="small" onClick={() => setAnnotations([])} disabled={annotations.length === 0} icon={<DeleteOutlined />} block>
                        清空全部
                      </Button>
                    </PanelSection>
                  </Space>
                ),
              },
              {
                key: "info",
                label: <span><InfoCircleOutlined />信息</span>,
                children: info ? (
                  <Space direction="vertical" style={{ padding: 8 }} size={4}>
                    <Info label="尺寸" value={`${info.width} × ${info.height}`} />
                    <Info label="格式" value={info.format} />
                    <Info label="文件大小" value={`${(info.size / 1024).toFixed(2)} KB`} />
                    <Info label="透明度" value={info.has_alpha ? "支持" : "不支持"} />
                    {info.exif && (
                      <>
                        <Divider />
                        <Title level={5}>EXIF</Title>
                        {Object.entries(info.exif).map(([k, v]) => (
                          <Info key={k} label={k} value={v} small />
                        ))}
                      </>
                    )}
                  </Space>
                ) : (
                  <Empty />
                ),
              },
            ]}
          />
        </Sider>
      </Layout>

      {/* 导出弹窗 */}
      <Modal
        title="导出图像"
        open={exportOpen}
        onCancel={() => setExportOpen(false)}
        onOk={exportImage}
        confirmLoading={processing}
        okText="导出"
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <div>
            <Text>格式:</Text>
            <Select
              style={{ width: "100%", marginTop: 4 }}
              value={exportFormat}
              onChange={setExportFormat}
              options={[
                { value: "png", label: "PNG (无损 / 透明)" },
                { value: "jpeg", label: "JPEG (有损 / 小)" },
                { value: "webp", label: "WebP (现代压缩)" },
              ]}
            />
          </div>
          {(exportFormat === "jpeg" || exportFormat === "webp") && (
            <div>
              <Text>质量: {exportQuality}%</Text>
              <Slider value={exportQuality} min={10} max={100} onChange={setExportQuality} />
            </div>
          )}
          <div>
            <Text>尺寸缩放: {exportResize}%</Text>
            <Slider value={exportResize} min={10} max={400} onChange={setExportResize} />
          </div>
        </Space>
      </Modal>
    </Layout>
  );
}

// =============== 子组件 ===============

function ToolButton({
  icon, active, onClick, tooltip,
}: {
  icon: React.ReactNode; active: boolean; onClick: () => void; tooltip: string;
}) {
  return (
    <Tooltip title={tooltip} placement="right">
      <Button
        type={active ? "primary" : "text"}
        icon={icon}
        onClick={onClick}
        style={{
          color: active ? undefined : "#fff",
          width: "100%",
        }}
      />
    </Tooltip>
  );
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", padding: 12, borderRadius: 6, border: "1px solid #f0f0f0" }}>
      <Text strong style={{ display: "block", marginBottom: 8, fontSize: 12, color: "#666" }}>
        {title}
      </Text>
      {children}
    </div>
  );
}

function SliderRow({
  label, value, min, max, onChange, suffix = "", disabled, hint,
}: {
  label: string; value: number; min: number; max: number;
  onChange: (v: number) => void; suffix?: string; disabled?: boolean; hint?: string;
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 12 }}>{label}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {value}{suffix}
        </Text>
      </Space>
      <Slider
        value={value} min={min} max={max}
        onChange={onChange as any} disabled={disabled}
        tooltip={{ open: false }}
      />
      {hint && <Text type="secondary" style={{ fontSize: 10 }}>{hint}</Text>}
    </div>
  );
}

function Info({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: small ? 11 : 13 }}>
      <Text type="secondary" style={{ fontSize: small ? 11 : 12 }}>{label}</Text>
      <Text style={{ fontSize: small ? 11 : 12 }}>{value}</Text>
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid #e8e8e8", margin: "8px 0" }} />;
}