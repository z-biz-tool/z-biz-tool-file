import { useState, useEffect } from "react";
import { Layout, Input, Button, Breadcrumb, Table, Dropdown, message, Modal, theme } from "antd";
import type { MenuProps } from "antd";
import {
  FolderOutlined,
  FileOutlined,
  HomeOutlined,
  ArrowLeftOutlined,
  ReloadOutlined,
  DeleteOutlined,
  EditOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useFileStore, formatFileSize, formatTime, type FileEntry } from "./stores/fileStore";
import FileTree from "./components/FileTree";
import PreviewPane from "./components/PreviewPane";
import SearchBar from "./components/SearchBar";

const { Sider, Content, Header } = Layout;

export default function App() {
  const [rootPath, setRootPath] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [renameModal, setRenameModal] = useState<{ visible: boolean; path: string; oldName: string }>({
    visible: false,
    path: "",
    oldName: "",
  });
  const [newName, setNewName] = useState("");
  const { token } = theme.useToken();

  const {
    currentPath,
    fileList,
    selectedFile,
    setSelectedFile,
    setCurrentPath,
    setFileList,
  } = useFileStore();

  // 初始化：获取用户主目录
  useEffect(() => {
    const homeDir = "/Users/" + (typeof window !== "undefined" ? "" : "");
    // macOS默认用户目录
    const defaultPath = "/Users/zifang";
    setRootPath(defaultPath);
    navigateTo(defaultPath, true);
  }, []);

  // 导航到路径
  const navigateTo = (path: string, isRoot: boolean = false) => {
    setCurrentPath(path);
    loadDirectory(path);

    if (isRoot) {
      setHistory([path]);
      setHistoryIndex(0);
    } else {
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(path);
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
    }
  };

  // 加载目录
  const loadDirectory = (path: string) => {
    invoke("list_directory", { path })
      .then((entries: any) => {
        setFileList(entries);
      })
      .catch((err) => {
        message.error("加载目录失败: " + err);
      });
  };

  // 后退
  const goBack = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      const path = history[newIndex];
      setCurrentPath(path);
      loadDirectory(path);
    }
  };

  // 前进
  const goForward = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      const path = history[newIndex];
      setCurrentPath(path);
      loadDirectory(path);
    }
  };

  // 返回上级目录
  const goUp = () => {
    if (currentPath && currentPath !== "/") {
      const parts = currentPath.split("/").filter(Boolean);
      parts.pop();
      const parentPath = "/" + parts.join("/");
      navigateTo(parentPath || "/");
    }
  };

  // 文件/文件夹点击
  const handleFileClick = (entry: FileEntry) => {
    setSelectedFile(entry);
    if (entry.is_dir) {
      navigateTo(entry.path);
    }
  };

  // 面包屑导航
  const breadcrumbItems = () => {
    if (!currentPath) return [];
    const parts = currentPath.split("/").filter(Boolean);
    const items: any[] = [
      {
        title: (
          <span onClick={() => navigateTo("/", true)} style={{ cursor: "pointer" }}>
            <HomeOutlined />
          </span>
        ),
      },
    ];
    let path = "";
    parts.forEach((part, idx) => {
      path += "/" + part;
      const currentPathCopy = path;
      items.push({
        title: (
          <span
            onClick={() => navigateTo(currentPathCopy)}
            style={{ cursor: "pointer" }}
          >
            {part}
          </span>
        ),
      });
    });
    return items;
  };

  // 右键菜单
  const contextMenuItems = (record: FileEntry): MenuProps["items"] => [
    {
      key: "rename",
      label: "重命名",
      icon: <EditOutlined />,
      onClick: () => {
        setRenameModal({ visible: true, path: record.path, oldName: record.name });
        setNewName(record.name);
      },
    },
    {
      key: "delete",
      label: "删除",
      icon: <DeleteOutlined />,
      danger: true,
      onClick: () => handleDelete(record),
    },
  ];

  // 删除文件
  const handleDelete = (entry: FileEntry) => {
    Modal.confirm({
      title: "确认删除",
      content: `确定要删除「${entry.name}」吗？此操作不可恢复。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await invoke("delete_file", { path: entry.path });
          message.success("删除成功");
          loadDirectory(currentPath);
        } catch (err) {
          message.error("删除失败: " + err);
        }
      },
    });
  };

  // 重命名
  const handleRename = async () => {
    if (!renameModal.path || !newName.trim()) return;
    try {
      await invoke("rename_file", { oldPath: renameModal.path, newName: newName.trim() });
      message.success("重命名成功");
      loadDirectory(currentPath);
    } catch (err) {
      message.error("重命名失败: " + err);
    }
    setRenameModal({ visible: false, path: "", oldName: "" });
  };

  // 表格列定义
  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      sorter: (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name),
      render: (text: string, record: FileEntry) => (
        <div
          style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
          onClick={() => handleFileClick(record)}
        >
          {record.is_dir ? <FolderOutlined style={{ color: "#faad14" }} /> : <FileOutlined style={{ color: "#8c8c8c" }} />}
          <span style={{ color: selectedFile?.path === record.path ? "#1677ff" : "inherit", fontWeight: selectedFile?.path === record.path ? 600 : 400 }}>
            {text}
          </span>
        </div>
      ),
    },
    {
      title: "大小",
      dataIndex: "size",
      key: "size",
      width: 100,
      sorter: (a: FileEntry, b: FileEntry) => a.size - b.size,
      render: (size: number, record: FileEntry) => record.is_dir ? "-" : formatFileSize(size),
    },
    {
      title: "修改时间",
      dataIndex: "modified",
      key: "modified",
      width: 180,
      sorter: (a: FileEntry, b: FileEntry) => a.modified - b.modified,
      render: (modified: number) => formatTime(modified),
    },
  ];

  return (
    <Layout style={{ height: "100vh" }}>
      {/* 顶部搜索栏 */}
      <Header style={{ background: token.colorBgContainer, padding: "0 16px", height: "auto", lineHeight: "normal", borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <SearchBar rootPath={rootPath} />
      </Header>

      <Layout>
        {/* 左侧文件树 */}
        <Sider width={240} style={{ background: token.colorBgContainer, borderRight: `1px solid ${token.colorBorderSecondary}`, overflow: "auto" }}>
          <FileTree rootPath={rootPath} />
        </Sider>

        {/* 中间文件列表 */}
        <Content style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* 工具栏 */}
          <div style={{ padding: "8px 12px", borderBottom: `1px solid ${token.colorBorderSecondary}`, display: "flex", alignItems: "center", gap: 8, background: token.colorBgContainer }}>
            <Button icon={<ArrowLeftOutlined />} onClick={goBack} disabled={historyIndex <= 0} size="small" />
            <Button icon={<ReloadOutlined />} onClick={() => loadDirectory(currentPath)} size="small" />
            <Button onClick={goUp} size="small">上级</Button>
            <div style={{ flex: 1 }}>
              <Breadcrumb items={breadcrumbItems()} />
            </div>
            <Input
              placeholder="根目录路径"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              onPressEnter={() => navigateTo(rootPath, true)}
              style={{ width: 250 }}
              size="small"
            />
          </div>

          {/* 文件列表表格 */}
          <div style={{ flex: 1, overflow: "auto" }}>
            <Dropdown
              trigger={["contextMenu"]}
              menu={{ items: selectedFile ? contextMenuItems(selectedFile) : [] }}
            >
              <div style={{ height: "100%" }}>
                <Table
                  columns={columns}
                  dataSource={fileList}
                  rowKey="path"
                  size="small"
                  pagination={false}
                  scroll={{ y: "calc(100vh - 200px)" }}
                />
              </div>
            </Dropdown>
          </div>
        </Content>

        {/* 右侧预览区 */}
        <Sider width={420} style={{ background: token.colorBgContainer, borderLeft: `1px solid ${token.colorBorderSecondary}`, overflow: "hidden" }}>
          <PreviewPane />
        </Sider>
      </Layout>

      {/* 重命名弹窗 */}
      <Modal
        title="重命名"
        open={renameModal.visible}
        onOk={handleRename}
        onCancel={() => setRenameModal({ visible: false, path: "", oldName: "" })}
        okText="确定"
        cancelText="取消"
      >
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} onPressEnter={handleRename} />
      </Modal>
    </Layout>
  );
}
