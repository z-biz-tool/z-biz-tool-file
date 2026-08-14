import { useState, useCallback } from "react";
import {
  Modal,
  Input,
  Button,
  Table,
  Tag,
  Radio,
  message,
  Spin,
  theme,
} from "antd";
import { FolderOpenOutlined, SwapOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  open: boolean;
  onClose: () => void;
  currentPath: string;
}

interface DiffEntry {
  name: string;
  status: "only_left" | "only_right" | "modified" | "same";
  left_modified: number | null;
  right_modified: number | null;
}

type SyncDirection = "left_to_right" | "right_to_left";

const STATUS_MAP: Record<
  DiffEntry["status"],
  { label: string; color: string }
> = {
  only_left: { label: "仅在源", color: "blue" },
  only_right: { label: "仅在目标", color: "green" },
  modified: { label: "已修改", color: "orange" },
  same: { label: "相同", color: "gray" },
};

function formatTimestamp(ts: number | null): string {
  if (ts == null) return "-";
  return new Date(ts * 1000).toLocaleString("zh-CN");
}

export default function DirectorySync({
  open,
  onClose,
  currentPath,
}: Props) {
  const { token } = theme.useToken();
  const [leftDir, setLeftDir] = useState(currentPath);
  const [rightDir, setRightDir] = useState("");
  const [comparing, setComparing] = useState(false);
  const [diffEntries, setDiffEntries] = useState<DiffEntry[]>([]);
  const [syncDirection, setSyncDirection] = useState<SyncDirection>("left_to_right");
  const [syncing, setSyncing] = useState(false);

  const handleAfterOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setLeftDir(currentPath);
      setRightDir("");
      setDiffEntries([]);
      setSyncDirection("left_to_right");
    }
  };

  const handleCompare = useCallback(async () => {
    if (!leftDir.trim() || !rightDir.trim()) {
      message.warning("请输入源目录和目标目录路径");
      return;
    }
    setComparing(true);
    setDiffEntries([]);
    try {
      const result = await invoke<DiffEntry[]>("compare_directories", {
        leftDir: leftDir.trim(),
        rightDir: rightDir.trim(),
      });
      setDiffEntries(result);
      if (result.length === 0) {
        message.info("两个目录内容完全一致");
      } else {
        const diffCount = result.filter(
          (e) => e.status !== "same"
        ).length;
        message.success(`比较完成，发现 ${diffCount} 处差异`);
      }
    } catch (err) {
      message.error("比较失败: " + err);
    } finally {
      setComparing(false);
    }
  }, [leftDir, rightDir]);

  const handleSync = useCallback(async () => {
    const sourceDir = syncDirection === "left_to_right" ? leftDir : rightDir;
    const targetDir = syncDirection === "left_to_right" ? rightDir : leftDir;

    // 筛选需要同步的条目：仅在源端或已修改（以源端为准）
    const toSync = diffEntries.filter((e) => {
      if (syncDirection === "left_to_right") {
        return e.status === "only_left" || e.status === "modified";
      } else {
        return e.status === "only_right" || e.status === "modified";
      }
    });

    if (toSync.length === 0) {
      message.info("没有需要同步的文件");
      return;
    }

    setSyncing(true);
    let successCount = 0;
    let failCount = 0;
    for (const entry of toSync) {
      try {
        const srcPath = `${sourceDir}/${entry.name}`;
        const destPath = `${targetDir}/${entry.name}`;
        await invoke("copy_file", { source: srcPath, destination: destPath });
        successCount++;
      } catch {
        failCount++;
      }
    }
    setSyncing(false);

    if (successCount > 0) {
      message.success(`已同步 ${successCount} 个文件`);
    }
    if (failCount > 0) {
      message.error(`${failCount} 个文件同步失败`);
    }

    // 重新比较以刷新结果
    if (successCount > 0) {
      handleCompare();
    }
  }, [diffEntries, syncDirection, leftDir, rightDir, handleCompare]);

  const columns = [
    {
      title: "文件名",
      dataIndex: "name",
      key: "name",
      ellipsis: true,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (status: DiffEntry["status"]) => {
        const info = STATUS_MAP[status];
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
    {
      title: "源修改时间",
      dataIndex: "left_modified",
      key: "left_modified",
      width: 180,
      render: (ts: number | null) => formatTimestamp(ts),
    },
    {
      title: "目标修改时间",
      dataIndex: "right_modified",
      key: "right_modified",
      width: 180,
      render: (ts: number | null) => formatTimestamp(ts),
    },
  ];

  const syncableCount = diffEntries.filter((e) => {
    if (syncDirection === "left_to_right") {
      return e.status === "only_left" || e.status === "modified";
    } else {
      return e.status === "only_right" || e.status === "modified";
    }
  }).length;

  return (
    <Modal
      title="目录同步"
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      afterOpenChange={handleAfterOpenChange}
    >
      {/* 目录输入 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>源目录</div>
          <Input
            prefix={<FolderOpenOutlined />}
            value={leftDir}
            onChange={(e) => setLeftDir(e.target.value)}
            placeholder="输入源目录路径"
          />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>目标目录</div>
          <Input
            prefix={<FolderOpenOutlined />}
            value={rightDir}
            onChange={(e) => setRightDir(e.target.value)}
            placeholder="输入目标目录路径"
          />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <Button
            type="primary"
            icon={<SwapOutlined />}
            onClick={handleCompare}
            loading={comparing}
          >
            比较
          </Button>
        </div>
      </div>

      {/* 比较中 */}
      {comparing && (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <Spin size="large" />
          <div
            style={{
              marginTop: 12,
              color: token.colorTextSecondary,
            }}
          >
            正在比较目录...
          </div>
        </div>
      )}

      {/* 比较结果 */}
      {!comparing && diffEntries.length > 0 && (
        <div>
          <Table
            columns={columns}
            dataSource={diffEntries.map((e, i) => ({ ...e, key: i }))}
            pagination={false}
            size="small"
            scroll={{ y: 320 }}
            style={{ marginBottom: 16 }}
          />

          {/* 同步选项 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: `12px 16px`,
              background: token.colorBgLayout,
              borderRadius: token.borderRadiusSM,
            }}
          >
            <Radio.Group
              value={syncDirection}
              onChange={(e) => setSyncDirection(e.target.value)}
            >
              <Radio value="left_to_right">
                源 → 目标（复制缺失/已修改的文件到目标）
              </Radio>
              <Radio value="right_to_left">
                目标 → 源（复制缺失/已修改的文件到源）
              </Radio>
            </Radio.Group>
            <Button
              type="primary"
              onClick={handleSync}
              loading={syncing}
              disabled={syncableCount === 0}
            >
              开始同步{syncableCount > 0 ? ` (${syncableCount} 个文件)` : ""}
            </Button>
          </div>
        </div>
      )}

      {/* 无结果 */}
      {!comparing && diffEntries.length === 0 && open && (
        <div
          style={{
            textAlign: "center",
            padding: "40px 0",
            color: token.colorTextSecondary,
          }}
        >
          输入源目录和目标目录路径，点击比较以查看差异
        </div>
      )}
    </Modal>
  );
}
