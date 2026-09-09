import { useState, useEffect } from "react";
import {
  Modal,
  Button,
  Space,
  Select,
  Input,
  Typography,
  message,
  Card,
  Row,
  Col,
  Statistic,
  Alert,
  Spin,
  Progress,
} from "antd";
import {
  FileSearchOutlined,
  CopyOutlined,
  DownloadOutlined,
  ReloadOutlined,
  ScanOutlined,
  GlobalOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

const { Text } = Typography;

interface OcrLanguage {
  code: string;
  name: string;
}

interface OcrResult {
  text: string;
  confidence: number;
  language: string;
  duration_ms: number;
}

interface OcrToolProps {
  open: boolean;
  onClose: () => void;
  initialPath?: string | null;
}

export default function OcrTool({ open, onClose, initialPath }: OcrToolProps) {
  const [msgApi, msgContext] = message.useMessage();
  const [imagePath, setImagePath] = useState<string | null>(initialPath || null);
  const [languages, setLanguages] = useState<OcrLanguage[]>([]);
  const [selectedLang, setSelectedLang] = useState("chi_sim+eng");
  const [text, setText] = useState("");
  const [confidence, setConfidence] = useState(0);
  const [duration, setDuration] = useState(0);
  const [running, setRunning] = useState(false);
  const [tesseractOk, setTesseractOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (open) {
      invoke<OcrLanguage[]>("list_ocr_languages").then(setLanguages).catch(() => {});
      invoke<boolean>("check_tesseract").then(setTesseractOk).catch(() => setTesseractOk(false));
      if (initialPath) setImagePath(initialPath);
    }
  }, [open, initialPath]);

  const pickImage = async () => {
    try {
      const sel = await openDialog({
        multiple: false,
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg", "bmp", "tiff", "webp"] },
        ],
      });
      if (sel && typeof sel === "string") setImagePath(sel);
    } catch (e: any) {
      msgApi.error("选择失败: " + e);
    }
  };

  const doOcr = async () => {
    if (!imagePath) {
      msgApi.warning("请选择图片");
      return;
    }
    setRunning(true);
    setText("");
    try {
      const result = await invoke<OcrResult>("ocr_image", {
        path: imagePath,
        language: selectedLang,
      });
      setText(result.text);
      setConfidence(result.confidence);
      setDuration(result.duration_ms);
      msgApi.success(`识别完成，耗时 ${result.duration_ms}ms`);
    } catch (e: any) {
      msgApi.error("OCR 失败: " + e);
      setText("识别失败：" + e);
    } finally {
      setRunning(false);
    }
  };

  const copyText = () => {
    navigator.clipboard.writeText(text).then(
      () => msgApi.success("已复制"),
      () => msgApi.error("复制失败")
    );
  };

  const exportText = () => {
    if (!text) {
      msgApi.warning("暂无内容");
      return;
    }
    const stem = imagePath?.split("/").pop()?.replace(/\.[^.]+$/, "") || "ocr";
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${stem}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      title={
        <Space>
          <ScanOutlined style={{ color: "#13c2c2" }} />
          <span>OCR 文字识别</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={840}
      footer={null}
      destroyOnClose
    >
      {msgContext}
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        {tesseractOk === false && (
          <Alert
            type="warning"
            showIcon
            message="未检测到 Tesseract"
            description={
              <div>
                <div>OCR 依赖系统 Tesseract：</div>
                <ul style={{ marginBottom: 4 }}>
                  <li>macOS: <code>brew install tesseract tesseract-lang</code></li>
                  <li>Ubuntu: <code>sudo apt install tesseract-ocr tesseract-ocr-chi-sim</code></li>
                  <li>Windows: 从 <a href="https://github.com/UB-Mannheim/tesseract/wiki" target="_blank">UB Mannheim</a> 下载安装</li>
                </ul>
              </div>
            }
          />
        )}

        <Row gutter={12}>
          <Col span={16}>
            <Text>选择图片</Text>
            <Space.Compact style={{ width: "100%", marginTop: 4 }}>
              <Input value={imagePath || ""} readOnly placeholder="选择要识别的图片..." />
              <Button onClick={pickImage} icon={<FileSearchOutlined />}>选择</Button>
            </Space.Compact>
          </Col>
          <Col span={8}>
            <Text>
              <GlobalOutlined /> 识别语言
            </Text>
            <Select
              style={{ width: "100%", marginTop: 4 }}
              value={selectedLang}
              onChange={setSelectedLang}
              options={[
                { value: "chi_sim+eng", label: "中文+英文（推荐）" },
                ...languages.map((l) => ({ value: l.code, label: l.name })),
                { value: "chi_sim", label: "仅简体中文" },
                { value: "eng", label: "仅英语" },
              ]}
            />
          </Col>
        </Row>

        <Button
          type="primary" size="large" block icon={<ScanOutlined />}
          onClick={doOcr}
          loading={running}
          disabled={!imagePath}
        >
          开始识别
        </Button>

        {running && (
          <div style={{ textAlign: "center", padding: 24 }}>
            <Spin size="large" />
            <div style={{ marginTop: 12, color: "#999" }}>OCR 引擎处理中...</div>
          </div>
        )}

        {(text || confidence > 0) && (
          <Card
            size="small"
            title="识别结果"
            extra={
              <Space>
                <Button size="small" icon={<CopyOutlined />} onClick={copyText} disabled={!text}>
                      复制
                    </Button>
                    <Button size="small" icon={<DownloadOutlined />} onClick={exportText} disabled={!text}>
                      导出 .txt
                    </Button>
                    <Button size="small" icon={<ReloadOutlined />} onClick={() => { setText(""); setConfidence(0); }}>
                      清空
                    </Button>
              </Space>
            }
          >
            <Row gutter={16} style={{ marginBottom: 12 }}>
              <Col span={8}>
                <Statistic
                  title="置信度"
                  value={confidence}
                  suffix="%"
                  precision={1}
                  valueStyle={{ color: confidence >= 80 ? "#52c41a" : confidence >= 50 ? "#faad14" : "#ff4d4f" }}
                />
                <Progress
                  percent={Math.min(100, confidence)}
                  strokeColor={confidence >= 80 ? "#52c41a" : confidence >= 50 ? "#faad14" : "#ff4d4f"}
                  showInfo={false}
                />
              </Col>
              <Col span={8}>
                <Statistic title="耗时" value={duration} suffix="ms" />
              </Col>
              <Col span={8}>
                <Statistic title="字符数" value={text.length} />
              </Col>
            </Row>

            <Input.TextArea
              value={text}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
              autoSize={{ minRows: 8, maxRows: 20 }}
              style={{ fontFamily: "monospace", fontSize: 13 }}
              placeholder="识别结果将显示在这里..."
            />
          </Card>
        )}
      </Space>
    </Modal>
  );
}