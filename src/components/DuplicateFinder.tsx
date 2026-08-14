import { useState, useCallback } from "react";
import {
  Modal,
  Input,
  Button,
  Table,
  Checkbox,
  Tag,
  message,
  Spin,
  theme,
} from "antd";
import {
  SearchOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { formatFileSize } from "../stores/fileStore";

interface DuplicateGroup {
  hash: string;
  size: number;
  paths: string[];
}

interface DuplicateFinderProps {
  open: boolean;
  onClose: () => void;
  currentPath: string;
  onRefresh: () => void;
}

export default function DuplicateFinder({
  open,
  onClose,
  currentPath,
  onRefresh,
}: DuplicateFinderProps) {
  const [directory, setDirectory] = useState(currentPath);
  const [scanning, setScanning] = useState(false);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const { token } = theme.useToken();

  // 每次打开重置
  const handleAfterOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setDirectory(currentPath);
      setGroups([]);
      setSelectedPaths(new Set());
    }
  };

  const handleScan = useCallback(async () => {
    if (!directory.trim()) {
      message.warning("请输入目录路径");
      return;
    }
    setScanning(true);
    setGroups([]);
    setSelectedPaths(new Set());
    try {
      const result = await invoke<DuplicateGroup[]>("find_duplicate_files", {
        directory: directory.trim(),
      });
      if (result.length === 0) {
        message.info("未发现重复文件");
      } else {
        const totalDuplicates = result.reduce(
          (sum, g) => sum + g.paths.length - 1,
          0
        );
        message.success(
          `发现 ${result.length} 组重复文件，共 ${totalDuplicates} 个重复项`
        );
      }
      setGroups(result);
    } catch (err) {
      message.error("扫描失败: " + err);
    } finally {
      setScanning(false);
    }
  }, [directory]);

  const togglePath = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const toggleGroup = useCallback((group: DuplicateGroup, checked: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      // 选中/取消组内除第一个以外的所有文件（保留一份）
      const duplicates = group.paths.slice(1);
      for (const p of duplicates) {
        if (checked) {
          next.add(p);
        } else {
          next.delete(p);
        }
      }
      return next;
    });
  }, []);

  const handleDeleteSelected = useCallback(() => {
    if (selectedPaths.size === 0) {
      message.warning("请先选择要删除的文件");
      return;
    }

    const pathsToDelete = Array.from(selectedPaths);
    Modal.confirm({
      title: "确认删除",
      content: `确定要删除选中的 ${pathsToDelete.length} 个重复文件吗？此操作不可恢复。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setDeleting(true);
        let successCount = 0;
        let failCount = 0;
        for (const path of pathsToDelete) {
          try {
            await invoke("delete_file", { path });
            successCount++;
          } catch {
            failCount++;
          }
        }
        setDeleting(false);
        if (successCount > 0) {
          message.success(`已删除 ${successCount} 个文件`);
          // 从结果中移除已删除的路径
          const deletedSet = new Set(pathsToDelete);
          setGroups((prev) =>
            prev
              .map((g) => ({
                ...g,
                paths: g.paths.filter((p) => !deletedSet.has(p)),
              }))
              .filter((g) => g.paths.length > 1)
          );
          setSelectedPaths(new Set());
          onRefresh();
        }
        if (failCount > 0) {
          message.error(`${failCount} 个文件删除失败`);
        }
      },
    });
  }, [selectedPaths, onRefresh]);

  // 为每个组生成列定义
  const getGroupColumns = useCallback(
    (_group: DuplicateGroup) => [
      {
        title: "文件路径",
        dataIndex: "path",
        key: "path",
        ellipsis: true,
        render: (path: string) => (
          <span style={{ fontSize: 13 }}>{path}</span>
        ),
      },
      {
        title: "选择删除",
        key: "select",
        width: 80,
        align: "center" as const,
        render: (_: unknown, record: { key: string; path: string; isFirst: boolean }) => (
          <Checkbox
            checked={selectedPaths.has(record.path)}
            disabled={record.isFirst}
            onChange={() => togglePath(record.path)}
          />
        ),
      },
    ],
    [selectedPaths, togglePath]
  );

  return (
    <Modal
      title="重复文件查找"
      open={open}
      onCancel={onClose}
      width={800}
      footer={null}
      afterOpenChange={handleAfterOpenChange}
    >
      {/* 目录输入 + 扫描按钮 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <Input
          prefix={<FolderOpenOutlined />}
          value={directory}
          onChange={(e) => setDirectory(e.target.value)}
          placeholder="输入要扫描的目录路径"
          onPressEnter={handleScan}
        />
        <Button
          type="primary"
          icon={<SearchOutlined />}
          onClick={handleScan}
          loading={scanning}
        >
          扫描
        </Button>
      </div>

      {/* 扫描中 */}
      {scanning && (
        <div
          style={{
            textAlign: "center",
            padding: "40px 0",
          }}
        >
          <Spin size="large" />
          <div
            style={{
              marginTop: 12,
              color: token.colorTextSecondary,
            }}
          >
            正在扫描重复文件...
          </div>
        </div>
      )}

      {/* 结果 */}
      {!scanning && groups.length > 0 && (
        <div>
          {/* 统计 + 操作 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <span style={{ color: token.colorTextSecondary, fontSize: 13 }}>
              共 {groups.length} 组重复文件，已选中{" "}
              {selectedPaths.size} 个待删除
            </span>
            <Button
              type="primary"
              danger
              icon={<DeleteOutlined />}
              onClick={handleDeleteSelected}
              disabled={selectedPaths.size === 0}
              loading={deleting}
              size="small"
            >
              删除选中
            </Button>
          </div>

          {/* 分组展示 */}
          <div
            style={{
              maxHeight: 460,
              overflow: "auto",
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusSM,
            }}
          >
            {groups.map((group) => {
              const allDuplicatesSelected =
                group.paths.length > 1 &&
                group.paths.slice(1).every((p) => selectedPaths.has(p));

              return (
                <div
                  key={group.hash}
                  style={{
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  {/* 组头 */}
                  <div
                    style={{
                      padding: "8px 12px",
                      background: token.colorBgLayout,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <Tag color="blue" style={{ margin: 0 }}>
                      {group.hash.slice(0, 12)}...
                    </Tag>
                    <Tag style={{ margin: 0 }}>
                      {formatFileSize(group.size)}
                    </Tag>
                    <span
                      style={{
                        color: token.colorTextSecondary,
                        fontSize: 12,
                      }}
                    >
                      {group.paths.length} 个相同文件
                    </span>
                    <div style={{ flex: 1 }} />
                    <Checkbox
                      checked={allDuplicatesSelected}
                      onChange={(e) => toggleGroup(group, e.target.checked)}
                      style={{ fontSize: 12 }}
                    >
                      <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
                        选中全部重复项
                      </span>
                    </Checkbox>
                  </div>

                  {/* 文件列表 */}
                  <Table
                    columns={getGroupColumns(group)}
                    dataSource={group.paths.map((p, idx) => ({
                      key: p,
                      path: p,
                      isFirst: idx === 0,
                    }))}
                    pagination={false}
                    size="small"
                    showHeader={false}
                    rowClassName={(record) =>
                      selectedPaths.has(record.key as string)
                        ? "ant-table-row-selected"
                        : ""
                    }
                    components={{
                      body: {
                        row: (props: React.HTMLAttributes<HTMLTableRowElement> & { "data-row-key"?: string }) => {
                          const rowKey = props["data-row-key"];
                          const isSelected =
                            rowKey && selectedPaths.has(rowKey);
                          return (
                            <tr
                              {...props}
                              style={{
                                ...props.style,
                                background: isSelected
                                  ? "rgba(255, 77, 79, 0.06)"
                                  : undefined,
                              }}
                            />
                          );
                        },
                      },
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 无结果 */}
      {!scanning && groups.length === 0 && open && (
        <div
          style={{
            textAlign: "center",
            padding: "40px 0",
            color: token.colorTextSecondary,
          }}
        >
          输入目录路径并点击扫描以查找重复文件
        </div>
      )}
    </Modal>
  );
}
