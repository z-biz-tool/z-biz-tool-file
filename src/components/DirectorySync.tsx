import { useState, useCallback, useMemo } from "react";
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
  Typography,
  Tooltip,
} from "antd";
import {
  FolderOpenOutlined,
  SwapOutlined,
  FolderOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { formatFileSize } from "../stores/fileStore";

interface Props {
  open: boolean;
  onClose: () => void;
  currentPath: string;
}

/** 与 Rust 侧 SyncDiffEntry 字段一一对应（snake_case 直传） */
interface DiffEntry {
  name: string;
  status: "only_left" | "only_right" | "modified";
  left_modified: number | null;
  right_modified: number | null;
  left_size: number | null;
  right_size: number | null;
}

interface SyncResult {
  copied: number;
  errors: string[];
}

type SyncDirection = "left_to_right" | "right_to_left";

const STATUS_MAP: Record<
  DiffEntry["status"],
  { label: string; color: string }
> = {
  only_left: { label: "仅左侧", color: "blue" },
  only_right: { label: "仅右侧", color: "green" },
  modified: { label: "已修改", color: "orange" },
};

function formatTimestamp(ts: number | null): string {
  if (ts == null) return "-";
  return new Date(ts * 1000).toLocaleString("zh-CN");
}

/** 当前方向下会被同步的条目：以源为准，对侧独有的文件不动 */
function pickSyncable(
  entries: DiffEntry[],
  direction: SyncDirection
): DiffEntry[] {
  const wanted: DiffEntry["status"] =
    direction === "left_to_right" ? "only_left" : "only_right";
  return entries.filter((e) => e.status === wanted || e.status === "modified");
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
  const [compared, setCompared] = useState(false);
  const [comparedDirs, setComparedDirs] = useState<[string, string] | null>(null);
  const [syncDirection, setSyncDirection] = useState<SyncDirection>("left_to_right");
  const [syncing, setSyncing] = useState(false);

  const handleAfterOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setLeftDir(currentPath);
      setRightDir("");
      setDiffEntries([]);
      setCompared(false);
      setComparedDirs(null);
      setSyncDirection("left_to_right");
    }
  };

  const pickDir = async (setter: (v: string) => void) => {
    try {
      const sel = await openDialog({ directory: true });
      if (typeof sel === "string" && sel) setter(sel);
    } catch (err) {
      message.error("选择目录失败: " + err);
    }
  };

  const handleCompare = useCallback(async () => {
    const l = leftDir.trim();
    const r = rightDir.trim();
    if (!l || !r) {
      message.warning("请选择源目录和目标目录");
      return;
    }
    setComparing(true);
    setDiffEntries([]);
    try {
      const result = await invoke<DiffEntry[]>("compare_directories", {
        leftDir: l,
        rightDir: r,
      });
      setDiffEntries(result);
      setCompared(true);
      setComparedDirs([l, r]);
      if (result.length === 0) {
        message.info("两个目录内容完全一致");
      } else {
        message.success(`比较完成，发现 ${result.length} 处差异`);
      }
    } catch (err) {
      message.error("比较失败: " + err);
    } finally {
      setComparing(false);
    }
  }, [leftDir, rightDir]);

  const handleSync = useCallback(async () => {
    const toSync = pickSyncable(diffEntries, syncDirection);
    if (toSync.length === 0) {
      message.info("没有需要同步的文件");
      return;
    }
    const [sourceDir, targetDir] =
      syncDirection === "left_to_right"
        ? [leftDir.trim(), rightDir.trim()]
        : [rightDir.trim(), leftDir.trim()];

    setSyncing(true);
    let copied = 0;
    try {
      // 一条命令交给后端：嵌套子目录、覆盖同名、逐项失败都不该由前端循环拼出来
      const res = await invoke<SyncResult>("sync_directories", {
        sourceDir,
        targetDir,
        names: toSync.map((e) => e.name),
      });
      copied = res.copied;
      if (res.copied > 0) {
        message.success(`已同步 ${res.copied} 项`);
      }
      if (res.errors.length > 0) {
        message.error(`${res.errors.length} 项失败：${res.errors[0]}`);
      }
    } catch (err) {
      message.error("同步失败: " + err);
    } finally {
      setSyncing(false);
    }

    // 重新比较以刷新结果：同步成功的那几项应当从列表里消失
    if (copied > 0) handleCompare();
  }, [diffEntries, syncDirection, leftDir, rightDir, handleCompare]);

  const columns = [
    {
      title: "文件名",
      dataIndex: "name",
      key: "name",
      ellipsis: true,
      render: (name: string, row: DiffEntry) => (
        <span>
          {name}
          {row.status === "modified" &&
            row.left_size != null &&
            row.right_size != null && (
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, marginLeft: 8 }}
              >
                {formatFileSize(row.left_size)} → {formatFileSize(row.right_size)}
              </Typography.Text>
            )}
        </span>
      ),
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
      title: "左侧修改时间",
      dataIndex: "left_modified",
      key: "left_modified",
      width: 180,
      render: (ts: number | null) => formatTimestamp(ts),
    },
    {
      title: "右侧修改时间",
      dataIndex: "right_modified",
      key: "right_modified",
      width: 180,
      render: (ts: number | null) => formatTimestamp(ts),
    },
  ];

  const syncable = useMemo(
    () => pickSyncable(diffEntries, syncDirection),
    [diffEntries, syncDirection]
  );
  // 比较之后又改了目录：列表里的相对路径已经对不上新的源/目标，同步会写错地方
  const staleDirs =
    comparedDirs !== null &&
    (comparedDirs[0] !== leftDir.trim() || comparedDirs[1] !== rightDir.trim());

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
          <div style={{ marginBottom: 4, fontWeight: 500 }}>左侧目录</div>
          <Input
            prefix={<FolderOpenOutlined />}
            value={leftDir}
            onChange={(e) => setLeftDir(e.target.value)}
            placeholder="选择或输入目录路径"
            suffix={
              <Button
                type="text"
                size="small"
                icon={<FolderOutlined />}
                onClick={() => pickDir(setLeftDir)}
              />
            }
          />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>右侧目录</div>
          <Input
            prefix={<FolderOpenOutlined />}
            value={rightDir}
            onChange={(e) => setRightDir(e.target.value)}
            placeholder="选择或输入目录路径"
            suffix={
              <Button
                type="text"
                size="small"
                icon={<FolderOutlined />}
                onClick={() => pickDir(setRightDir)}
              />
            }
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
            pagination={
              diffEntries.length > 200
                ? { pageSize: 200, showSizeChanger: false, size: "small" }
                : false
            }
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
              gap: 12,
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
                左 → 右（右侧重名文件将被覆盖）
              </Radio>
              <Radio value="right_to_left">
                右 → 左（左侧重名文件将被覆盖）
              </Radio>
            </Radio.Group>
            <Tooltip title={staleDirs ? "目录已改动，请重新比较" : ""}>
              <Button
                type="primary"
                onClick={handleSync}
                loading={syncing}
                disabled={syncable.length === 0 || staleDirs}
              >
                开始同步{syncable.length > 0 ? ` (${syncable.length} 项)` : ""}
              </Button>
            </Tooltip>
          </div>
        </div>
      )}

      {/* 比较过但无差异：不该再退回到"请输入路径"的引导文案 */}
      {!comparing && compared && diffEntries.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "40px 0",
            color: token.colorSuccess,
          }}
        >
          两个目录内容完全一致
        </div>
      )}

      {/* 尚未比较 */}
      {!comparing && !compared && (
        <div
          style={{
            textAlign: "center",
            padding: "40px 0",
            color: token.colorTextSecondary,
          }}
        >
          选择或输入左右两个目录，点击比较以查看差异
        </div>
      )}
    </Modal>
  );
}
