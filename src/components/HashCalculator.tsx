import { useEffect, useMemo, useState } from "react";
import { Modal, Select, Button, Input, Spin, Table, Typography, theme, App as AntdApp } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import {
  computeHashes,
  countHashFailures,
  formatHashReport,
  type HashRow,
  type HashTarget,
} from "../utils/batchHash";

interface Props {
  open: boolean;
  onClose: () => void;
  filePath: string | null;
  /** 批量模式：传入多个文件时忽略 filePath */
  files?: HashTarget[];
}

const ALGORITHM_OPTIONS = [
  { label: "MD5", value: "MD5" },
  { label: "SHA1", value: "SHA1" },
  { label: "SHA256", value: "SHA256" },
  { label: "CRC32", value: "CRC32" },
];

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export default function HashCalculator({ open, onClose, filePath, files }: Props) {
  const { message } = AntdApp.useApp();
  const { token } = theme.useToken();
  const [algorithm, setAlgorithm] = useState<string>("MD5");
  const [calculating, setCalculating] = useState(false);
  const [result, setResult] = useState<string>("");
  const [rows, setRows] = useState<HashRow[]>([]);
  const [progress, setProgress] = useState<string>("");

  const targets = useMemo<HashTarget[]>(() => {
    if (files && files.length > 0) return files;
    if (filePath) return [{ path: filePath, name: baseName(filePath) }];
    return [];
  }, [files, filePath]);

  const isBatch = targets.length > 1;

  // 面板是常驻挂载的：只靠 handleCalculate 里那句 setRows([]) 的话，
  // 关掉再对另一个文件打开时，表格里摆的还是上一个文件的摘要行（进度也停在 n/n）。
  // 换目标与重新打开都算"换了对象"，先把上一批的结果落地清掉。
  const targetKey = targets.map((t) => t.path).join("\n");
  useEffect(() => {
    setRows([]);
    setResult("");
    setProgress("");
  }, [open, targetKey]);

  // 算法是"这一次要算什么"，跟结果一起归零；但不跟着换目标走：
  // 面板开着点了另一个文件就跳回 MD5，等于偷偷改用户刚选的下拉框。
  useEffect(() => {
    if (open) setAlgorithm("MD5");
  }, [open]);

  const handleCalculate = async () => {
    if (targets.length === 0) {
      message.warning("未选择文件");
      return;
    }
    setCalculating(true);
    setResult("");
    setRows([]);
    setProgress(`0/${targets.length}`);
    try {
      const res = await computeHashes(targets, algorithm, (done, total) =>
        setProgress(`${done}/${total}`),
      );
      setRows(res);
      const failed = countHashFailures(res);
      if (!isBatch) {
        setResult(res[0]?.hash ?? "");
      }
      if (failed > 0) {
        const first = res.find((r) => r.error);
        message.error(
          `${res.length - failed}/${res.length} 完成，${failed} 个失败：${first?.error}`,
        );
      } else {
        message.success(`已计算 ${res.length} 个文件`);
      }
    } catch (err) {
      message.error("计算失败: " + err);
    } finally {
      setCalculating(false);
      setProgress("");
    }
  };

  const copy = async (text: string, hint: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success(hint);
    } catch {
      message.error("复制失败");
    }
  };

  const columns = [
    {
      title: "文件名",
      dataIndex: "name",
      ellipsis: true,
      width: 200,
    },
    {
      title: `${algorithm} 哈希`,
      dataIndex: "hash",
      render: (_: string, row: HashRow) =>
        row.error ? (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {row.error}
          </Typography.Text>
        ) : (
          <Typography.Text
            copyable={{ text: row.hash, onCopy: () => message.success("已复制哈希") }}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          >
            {row.hash}
          </Typography.Text>
        ),
    },
  ];

  return (
    <Modal
      title={isBatch ? `批量哈希计算（${targets.length} 个文件）` : "哈希计算"}
      open={open}
      onCancel={onClose}
      footer={null}
      width={isBatch ? 720 : 500}
    >
      {/* 目标文件 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 4, fontWeight: 500 }}>
          {isBatch ? `已选 ${targets.length} 个文件` : "文件路径"}
        </div>
        <Typography.Text
          style={{
            fontSize: 13,
            wordBreak: "break-all",
            color: token.colorTextSecondary,
          }}
        >
          {isBatch
            ? targets
                .slice(0, 3)
                .map((t) => t.path)
                .join("、") + (targets.length > 3 ? ` 等 ${targets.length} 个` : "")
            : (filePath ?? "未选择文件")}
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
          disabled={targets.length === 0}
        >
          {isBatch ? `计算 ${targets.length} 个文件` : "计算"}
        </Button>
        {rows.length > 0 && !calculating && (
          <Button
            icon={<CopyOutlined />}
            onClick={() => copy(formatHashReport(rows), "已复制全部哈希")}
          >
            复制全部
          </Button>
        )}
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
            正在计算 {algorithm} 哈希值...{progress ? ` ${progress}` : ""}
          </div>
        </div>
      )}

      {/* 批量结果 */}
      {isBatch && rows.length > 0 && !calculating && (
        <Table
          columns={columns}
          dataSource={rows.map((r, i) => ({ ...r, key: i }))}
          pagination={rows.length > 50 ? { pageSize: 50, size: "small" } : false}
          size="small"
          scroll={{ y: 320 }}
        />
      )}

      {/* 单文件结果 */}
      {result && !calculating && !isBatch && (
        <div>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>计算结果</div>
          <Input
            readOnly
            value={result}
            suffix={
              <Button aria-label="复制计算结果"
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copy(result, "已复制到剪贴板")}
              />
            }
          />
        </div>
      )}
    </Modal>
  );
}
