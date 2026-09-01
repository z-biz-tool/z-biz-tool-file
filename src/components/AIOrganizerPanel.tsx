import { useState, useEffect } from "react";
import {
  Card,
  Tabs,
  Button,
  Table,
  Typography,
  Progress,
  Tag,
  Modal,
  Space,
  Divider,
  Input,
  Form,
  Select,
  message,
} from "antd";
import type { TableProps } from "antd";
import {
  FolderOpenOutlined,
  TagOutlined,
  FileTextOutlined,
  ImageOutlined,
  VideoCameraOutlined,
  AudioOutlined,
  ArchiveOutlined,
  CodeOutlined,
  BuildOutlined,
  DownloadOutlined,
  ScanOutlined,
} from "@ant-design/icons";
import { categorizeFile, organizeDirectory, getCategories } from "../services/aiOrganizer";
import { useFileStore, type FileData } from "../stores/fileStore";
import { EmptyState } from "../_shared";

const { Title, Text } = Typography;
const { TabPane } = Tabs;

// 智能整理面板组件
export function AIOrganizerPanel() {
  const [activeTab, setActiveTab] = useState("organize");
  const [organizeProgress, setOrganizeProgress] = useState(0);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [organizePlans, setOrganizePlans] = useState<any[]>([]);
  const [categories, setCategories] = useState<Record<string, number>>({});
  const [selectedFile, setSelectedFile] = useState<FileData | null>(null);
  const [categoryResult, setCategoryResult] = useState<any>(null);

  const { currentPath } = useFileStore();

  // 加载分类统计
  useEffect(() => {
    loadCategories();
  }, []);

  // 加载分类统计
  const loadCategories = async () => {
    try {
      const stats = await getCategories();
      setCategories(stats);
    } catch (error) {
      console.error("加载分类统计失败:", error);
    }
  };

  // 开始整理
  const handleOrganize = async () => {
    if (!currentPath) {
      message.warning("请先选择一个目录");
      return;
    }

    setIsOrganizing(true);
    setOrganizeProgress(0);
    setOrganizePlans([]);

    try {
      const plans = await organizeDirectory(currentPath);
      setOrganizePlans(plans);

      // 模拟进度
      for (let i = 1; i <= 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        setOrganizeProgress(i * 10);
      }

      message.success(`整理完成，共找到 ${plans.length} 个文件需要整理`);
    } catch (error) {
      console.error("整理失败:", error);
      message.error("整理失败");
    } finally {
      setIsOrganizing(false);
    }
  };

  // 分类文件
  const handleCategorize = async () => {
    if (!selectedFile?.path) {
      message.warning("请先选择一个文件");
      return;
    }

    try {
      const result = await categorizeFile(selectedFile.path);
      setCategoryResult(result);
    } catch (error) {
      console.error("分类失败:", error);
      message.error("分类失败");
    }
  };

  // 获取类型图标
  const getTypeIcon = (type: string) => {
    switch (type) {
      case "image":
        return <ImageOutlined style={{ color: "#1890ff" }} />;
      case "document":
        return <FileTextOutlined style={{ color: "#52c41a" }} />;
      case "video":
        return <VideoCameraOutlined style={{ color: "#f56a00" }} />;
      case "audio":
        return <AudioOutlined style={{ color: "#722ed1" }} />;
      case "code":
        return <CodeOutlined style={{ color: "#eb2f96" }} />;
      case "archive":
        return <ArchiveOutlined style={{ color: "#5734d3" }} />;
      default:
        return <FolderOpenOutlined style={{ color: "#999" }} />;
    }
  };

  // 类型名称
  const getTypeName = (type: string) => {
    const names: Record<string, string> = {
      image: "图片",
      document: "文档",
      video: "视频",
      audio: "音频",
      code: "代码",
      archive: "压缩包",
      other: "其他",
    };
    return names[type] || type;
  };

  // 表格列定义
  const columns: TableProps<any>["columns"] = [
    {
      title: "文件",
      dataIndex: "source",
      key: "source",
      render: (text: string) => (
        <Text ellipsis style={{ maxWidth: 200 }} title={text}>
          {text.split("/").pop()}
        </Text>
      ),
    },
    {
      title: "目标位置",
      dataIndex: "target",
      key: "target",
      render: (text: string) => <Text type="secondary">{text}</Text>,
    },
    {
      title: "规则",
      dataIndex: "rule_name",
      key: "rule_name",
      render: (text: string) => (
        <Tag color="blue">{text.substring(0, 20)}...</Tag>
      ),
    },
  ];

  return (
    <Card
      title={
        <Space>
          <BuildOutlined />
          <Title level={4}>AI 智能整理</Title>
        </Space>
      }
      extra={
        <Button
          type="primary"
          icon={<ScanOutlined />}
          loading={isOrganizing}
          onClick={handleOrganize}
          disabled={!currentPath}
        >
          扫描整理
        </Button>
      }
    >
      <Tabs activeKey={activeTab} onChange={setActiveTab}>
        {/* 智能整理 Tab */}
        <TabPane
          tab={
            <span>
              <BuildOutlined />
              智能整理
            </span>
          }
          key="organize"
        >
          {/* 进度显示 */}
          {isOrganizing && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <Progress
                    percent={organizeProgress}
                    strokeColor={{
                      "0%": "#108ee9",
                      "100%": "#87d068",
                    }}
                  />
                </div>
                <Text>{organizeProgress}%</Text>
              </div>
            </Card>
          )}

          {/* 统计卡片 */}
          <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
            {Object.entries(categories).map(([type, count]) => (
              <Card key={type} size="small" style={{ flex: 1 }}>
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Space>
                    {getTypeIcon(type)}
                    <Text strong>{getTypeName(type)}</Text>
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {count} 个文件
                  </Text>
                </Space>
              </Card>
            ))}
          </div>

          {/* 整理计划表格 */}
          {organizePlans.length > 0 && (
            <Table
              dataSource={organizePlans}
              columns={columns}
              rowKey="source"
              pagination={{ pageSize: 10 }}
              scroll={{ y: 300 }}
            />
          )}

          {organizePlans.length === 0 && !isOrganizing && (
            <EmptyState
              icon={<BuildOutlined />}
              title="暂无整理计划"
              description="点击「扫描整理」按钮开始智能整理当前目录"
            />
          )}
        </TabPane>

        {/* 文件分类 Tab */}
        <TabPane
          tab={
            <span>
              <TagOutlined />
              文件分类
            </span>
          }
          key="categorize"
        >
          <Space direction="vertical" style={{ width: "100%" }}>
            <Input
              placeholder="选择一个文件进行分类"
              value={selectedFile?.path || ""}
              readOnly
            />
            <Button
              icon={<ScanOutlined />}
              onClick={() => {
                // TODO: 打开文件选择器
                message.info("文件选择功能待实现");
              }}
            >
              选择文件
            </Button>

            {categoryResult && (
              <Card>
                <Space direction="vertical" style={{ width: "100%" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {getTypeIcon(categoryResult.type)}
                    <Title level={5}>{getTypeName(categoryResult.type)}</Title>
                  </div>
                  <Text>子类型: {categoryResult.sub_type || "未知"}</Text>
                  <Text>
                    置信度: <Progress percent={categoryResult.confidence * 100} size="small" />
                  </Text>
                  <div>
                    <Text strong>推荐标签: </Text>
                    {categoryResult.tags.map((tag: string) => (
                      <Tag key={tag} color="blue">
                        {tag}
                      </Tag>
                    ))}
                  </div>
                </Space>
              </Card>
            )}
          </Space>
        </TabPane>

        {/* 批量重命名 Tab */}
        <TabPane
          tab={
            <span>
              <FileTextOutlined />
              批量重命名
            </span>
          }
          key="rename"
        >
          <Card>
            <Form layout="vertical">
              <Form.Item label="重命名规则">
                <Select defaultValue="date_name">
                  <Select.Option value="date_name">日期_原始文件名</Select.Option>
                  <Select.Option value="prefix_date">前缀_日期</Select.Option>
                  <Select.Option value="project_date">项目名_日期</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item label="前缀">
                <Input placeholder="例如: project_" />
              </Form.Item>
              <Form.Item>
                <Button type="primary">应用重命名</Button>
              </Form.Item>
            </Form>
          </Card>
        </TabPane>

        {/* AI 功能 Tab */}
        <TabPane
          tab={
            <span>
              <CodeOutlined />
              AI 功能
            </span>
          }
          key="ai"
        >
          <Card>
            <Space direction="vertical" style={{ width: "100%" }}>
              <Title level={5}>AI 智能标签</Title>
              <Text>自动为文件生成标签，方便搜索和分类</Text>
              <Button icon={<TagOutlined />} onClick={handleCategorize}>
                生成标签
              </Button>

              <Divider />

              <Title level={5}>AI 归档建议</Title>
              <Text>自动识别长期未访问的文件并建议归档</Text>
              <Button icon={<ArchiveOutlined />} onClick={() => message.info("归档功能待实现")}>
                检查归档
              </Button>
            </Space>
          </Card>
        </TabPane>
      </Tabs>
    </Card>
  );
}
