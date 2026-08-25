import { useState, useEffect, useCallback } from "react";
import {
  Modal,
  Button,
  Input,
  Space,
  Alert,
  Progress,
  App as AntdApp,
  Tooltip,
} from "antd";
import { PieChartOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { getFileTypeVisual } from "../utils/fileTypeIcon";

interface Props {
  open: boolean;
  onClose: () => void;
  initialPath: string;
}

interface DirNode {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  /** 前 5 大子项（按 size 降序） */
  children?: DirNode[];
}

interface ScanResult {
  total: number;
  file_count: number;
  top_items: DirNode[];
}

/**
 * 存储分析（treemap 简化版）
 * 横向条形图 + 颜色按 kind 标识
 * 显示当前目录下前 N 大子项 + 自身大小
 */
export default function StorageAnalyzerModal({ open, onClose, initialPath }: Props) {
  const { message } = AntdApp.useApp();
  const [path, setPath] = useState(initialPath);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await invoke<ScanResult>("analyze_storage", { path, depth: 2, topN: 50 });
      setResult(r);
    } catch (err) {
      message.error("扫描失败: " + err);
    } finally {
      setLoading(false);
    }
  }, [path, message]);

  useEffect(() => {
    if (open) {
      setPath(initialPath);
      // 自动扫
      setTimeout(() => {
        invoke<ScanResult>("analyze_storage", { path: initialPath, depth: 2, topN: 50 })
          .then(setResult)
          .catch((err) => message.error("扫描失败: " + err));
      }, 0);
    }
  }, [open, initialPath, message]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={780}
      title={
        <Space>
          <PieChartOutlined />
          <span>存储分析</span>
        </Space>
      }
      destroyOnClose
    >
      <Space.Compact style={{ width: "100%", marginBottom: 12 }}>
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onPressEnter={scan}
        />
        <Button icon={<PieChartOutlined />} onClick={scan} loading={loading}>
          扫描
        </Button>
      </Space.Compact>

      {result && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <Space>
              <span>总大小: <strong>{formatSize(result.total)}</strong></span>
              <span>·</span>
              <span>文件数: <strong>{result.file_count.toLocaleString()}</strong></span>
              <span>·</span>
              <span>显示前 {result.top_items.length} 大</span>
            </Space>
          }
        />
      )}

      {result && result.top_items.length > 0 && (
        <div style={{ maxHeight: 480, overflow: "auto" }}>
          {result.top_items.map((item) => (
            <SizeBar key={item.path} item={item} total={result.total} />
          ))}
        </div>
      )}
    </Modal>
  );
}

function SizeBar({ item, total }: { item: DirNode; total: number }) {
  const visual = getFileTypeVisual(item.name, item.is_dir);
  const pct = total > 0 ? (item.size / total) * 100 : 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 2,
        }}
      >
        <span style={{ color: visual.color, fontSize: 13 }}>
          {visual.icon}
        </span>
        <Tooltip title={item.path}>
          <span
            style={{
              fontWeight: item.is_dir ? 500 : 400,
              fontSize: 13,
              maxWidth: 320,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.name}
            {item.is_dir && <span style={{ color: "#888", fontSize: 11, marginLeft: 4 }}>(目录)</span>}
          </span>
        </Tooltip>
        <span style={{ color: "#888", fontSize: 12, marginLeft: "auto" }}>
          {formatSize(item.size)} · {pct.toFixed(1)}%
        </span>
      </div>
      <Progress
        percent={pct}
        showInfo={false}
        strokeColor={visual.color}
        size="small"
      />
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    units.length - 1,
  );
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}
