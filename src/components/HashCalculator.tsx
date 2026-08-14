import { useState } from "react";
import { Modal, Select, Button, Input, message, Spin, Typography, theme } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  open: boolean;
  onClose: () => void;
  filePath: string | null;
}

const ALGORITHM_OPTIONS = [
  { label: "MD5", value: "MD5" },
  { label: "SHA1", value: "SHA1" },
  { label: "SHA256", value: "SHA256" },
  { label: "CRC32", value: "CRC32" },
];

export default function HashCalculator({ open, onClose, filePath }: Props) {
  const { token } = theme.useToken();
  const [algorithm, setAlgorithm] = useState<string>("MD5");
  const [calculating, setCalculating] = useState(false);
  const [result, setResult] = useState<string>("");

  const handleCalculate = async () => {
    if (!filePath) {
      message.warning("未选择文件");
      return;
    }
    setCalculating(true);
    setResult("");
    try {
      const hash = (await invoke("calculate_file_hash", {
        path: filePath,
        algorithm,
      })) as string;
      setResult(hash);
      message.success("计算完成");
    } catch (err) {
      message.error("计算失败: " + err);
    } finally {
      setCalculating(false);
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      message.success("已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  };

  const handleAfterOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setAlgorithm("MD5");
      setResult("");
    }
  };

  return (
    <Modal
      title="哈希计算"
      open={open}
      onCancel={onClose}
      footer={null}
      width={500}
      afterOpenChange={handleAfterOpenChange}
    >
      {/* 文件路径 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 4, fontWeight: 500 }}>文件路径</div>
        <Typography.Text
          style={{
            fontSize: 13,
            wordBreak: "break-all",
            color: token.colorTextSecondary,
          }}
        >
          {filePath ?? "未选择文件"}
        </Typography.Text>
      </div>

      {/* 算法选择 + 计算按钮 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <Select
          value={algorithm}
          onChange={setAlgorithm}
          options={ALGORITHM_OPTIONS}
          style={{ width: 140 }}
        />
        <Button
          type="primary"
          onClick={handleCalculate}
          loading={calculating}
          disabled={!filePath}
        >
          计算
        </Button>
      </div>

      {/* 计算中 */}
      {calculating && (
        <div style={{ textAlign: "center", padding: "24px 0" }}>
          <Spin />
          <div
            style={{
              marginTop: 8,
              color: token.colorTextSecondary,
              fontSize: 13,
            }}
          >
            正在计算 {algorithm} 哈希值...
          </div>
        </div>
      )}

      {/* 结果 */}
      {result && !calculating && (
        <div>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>计算结果</div>
          <Input
            readOnly
            value={result}
            suffix={
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={handleCopy}
              />
            }
          />
        </div>
      )}
    </Modal>
  );
}
