import { useState, useEffect, useCallback } from "react";
import { Tree, Dropdown, message, Modal, Input } from "antd";
import type { MenuProps, TreeDataNode } from "antd";
import { FolderOutlined, FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useFileStore, type FileEntry } from "../stores/fileStore";
import { EmptyState, LoadingState } from "../_shared";

interface FileTreeProps {
  rootPath: string;
}

export default function FileTree({ rootPath }: FileTreeProps) {
  const [treeData, setTreeData] = useState<TreeDataNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [loadedKeys, setLoadedKeys] = useState<React.Key[]>([]);
  const [loading, setLoading] = useState(false);
  const [renameModal, setRenameModal] = useState<{
    visible: boolean;
    path: string;
    oldName: string;
  }>({
    visible: false,
    path: "",
    oldName: "",
  });
  const [newName, setNewName] = useState("");

  const { selectedFile, setSelectedFile, setCurrentPath, setFileList } = useFileStore();

  // 加载目录内容
  const loadDirectory = useCallback(
    async (path: string): Promise<TreeDataNode[]> => {
      try {
        const entries = (await invoke("list_directory", { path })) as FileEntry[];
        // 同时更新fileList（仅根目录级别）
        if (path === rootPath) {
          setFileList(entries);
        }
        return entries
          .filter((e) => e.is_dir)
          .map((entry) => ({
            key: entry.path,
            title: entry.name,
            icon: expandedKeys.includes(entry.path) ? <FolderOpenOutlined /> : <FolderOutlined />,
            isLeaf: false,
            children: undefined,
          }));
      } catch (err) {
        console.error("加载目录失败:", err);
        return [];
      }
    },
    [rootPath, expandedKeys, setFileList]
  );

  // 初始加载
  useEffect(() => {
    if (rootPath) {
      setLoading(true);
      loadDirectory(rootPath)
        .then(setTreeData)
        .finally(() => setLoading(false));
      setCurrentPath(rootPath);
    } else {
      setTreeData([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  // 异步加载子目录
  const onLoadData = async (node: TreeDataNode): Promise<void> => {
    const path = node.key as string;
    const children = await loadDirectory(path);
    setTreeData((prevData) => updateTreeData(prevData, path, children));
  };

  // 递归更新树数据
  const updateTreeData = (
    list: TreeDataNode[],
    key: React.Key,
    children: TreeDataNode[]
  ): TreeDataNode[] => {
    return list.map((node) => {
      if (node.key === key) {
        return { ...node, children };
      }
      if (node.children) {
        return { ...node, children: updateTreeData(node.children, key, children) };
      }
      return node;
    });
  };

  // 选中节点
  const onSelect = (keys: React.Key[], info: { node: TreeDataNode }) => {
    if (keys.length > 0) {
      const path = keys[0] as string;
      const node = info.node;
      const entry: FileEntry = {
        name: node.title as string,
        path: path,
        is_dir: true,
        size: 0,
        modified: 0,
      };
      setSelectedFile(entry);
      setCurrentPath(path);

      // 加载该目录下的文件列表
      invoke("list_directory", { path }).then((entries: unknown) => {
        setFileList(entries as FileEntry[]);
      });
    }
  };

  // 右键菜单操作
  const handleRename = async () => {
    if (!renameModal.path) return;
    try {
      await invoke("rename_file", { oldPath: renameModal.path, newName: newName });
      message.success("重命名成功");
      // 刷新树
      loadDirectory(rootPath).then(setTreeData);
    } catch (err) {
      message.error("重命名失败: " + err);
    }
    setRenameModal({ visible: false, path: "", oldName: "" });
  };

  const handleDelete = (path: string) => {
    Modal.confirm({
      title: "确认删除",
      content: "确定要删除此文件/目录吗？此操作不可恢复。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await invoke("delete_file", { path });
          message.success("删除成功");
          loadDirectory(rootPath).then(setTreeData);
        } catch (err) {
          message.error("删除失败: " + err);
        }
      },
    });
  };

  const contextMenuItems = (path: string, name: string): MenuProps["items"] => [
    {
      key: "rename",
      label: "重命名",
      onClick: () => {
        setRenameModal({ visible: true, path, oldName: name });
        setNewName(name);
      },
    },
    {
      key: "delete",
      label: "删除",
      danger: true,
      onClick: () => handleDelete(path),
    },
  ];

  return (
    <div className="file-tree" style={{ padding: "8px" }}>
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>文件树</span>
        {rootPath && (
          <ReloadOutlined
            style={{ cursor: "pointer" }}
            onClick={() => loadDirectory(rootPath).then(setTreeData)}
          />
        )}
      </div>

      {!rootPath ? (
        <EmptyState
          title="请选择目录"
          description="请先在上方输入根目录路径"
          icon={
            <FolderOutlined style={{ fontSize: 48, color: "var(--ant-color-text-tertiary)" }} />
          }
        />
      ) : loading ? (
        <LoadingState tip="加载目录中..." minHeight={200} />
      ) : treeData.length === 0 ? (
        <EmptyState
          title="文件夹为空"
          description="该目录下没有子文件夹"
          icon={
            <FolderOutlined style={{ fontSize: 48, color: "var(--ant-color-text-tertiary)" }} />
          }
        />
      ) : (
        <Dropdown
          trigger={["contextMenu"]}
          menu={{
            items: contextMenuItems(selectedFile?.path || rootPath, selectedFile?.name || ""),
          }}
        >
          <div>
            <Tree
              treeData={treeData}
              loadData={onLoadData}
              onSelect={onSelect}
              expandedKeys={expandedKeys}
              onExpand={setExpandedKeys}
              loadedKeys={loadedKeys}
              onLoad={setLoadedKeys}
              showIcon
              blockNode
            />
          </div>
        </Dropdown>
      )}

      <Modal
        title="重命名"
        open={renameModal.visible}
        onOk={handleRename}
        onCancel={() => setRenameModal({ visible: false, path: "", oldName: "" })}
        okText="确定"
        cancelText="取消"
      >
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
      </Modal>
    </div>
  );
}
