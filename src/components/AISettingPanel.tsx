import { useState } from "react";
import { Card, Switch, Typography, Divider, Space, Input, Button, Tabs } from "antd";
import type { TabPaneProps } from "antd/es/tabs";
import {
  BrainOutlined,
  SettingsOutlined,
  SearchOutlined,
  FileImageOutlined,
  FileAudioOutlined,
  FileVideoOutlined,
} from "@ant-design/icons";
import { useFileStore } from "../stores/fileStore";

const { Title, Paragraph, Text } = Typography;
const { TabPane } = Tabs;

// AI 设置面板组件
const AISettingPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>("general");

  // 从 store 获取 AI 状态
  const {
    aiEnabled,
    aiModel,
    aiEndpoint,
    setAiEnabled,
    setAiModel,
    setAiEndpoint,
  } = useFileStore();

  return (
    <div style={{ padding: "16px" }}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {/* 标题区域 */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <BrainOutlined style={{ fontSize: "24px", color: "#1677ff" }} />
          <div>
            <Title level={4} style={{ margin: 0 }}>
              AI 智能功能设置
            </Title>
            <Text type="secondary">为文件管理器添加智能增强能力</Text>
          </div>
        </div>

        {/* 主功能开关 */}
        <Card>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <Title level={5} style={{ margin: "0 0 4px 0" }}>
                启用 AI 功能
              </Title>
              <Text type="secondary" style={{ fontSize: "12px" }}>
                开启后可使用语义搜索、智能分类、内容摘要等功能
              </Text>
            </div>
            <Switch
              checked={aiEnabled}
              onChange={(checked) => setAiEnabled(checked)}
              checkedChildren="开启"
              unCheckedChildren="关闭"
            />
          </div>
        </Card>

        {/* 配置选项卡 */}
        <Tabs activeKey={activeTab} onChange={setActiveTab}>
          <TabPane
            tab={
              <span>
                <SettingsOutlined />
                基础配置
              </span>
            }
            key="general"
          >
            <Card>
              <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <div>
                  <Title level={5} style={{ margin: "0 0 8px 0" }}>
                LLM 模型选择
              </Title>
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    选择用于 AI 功能的模型
                  </Text>
                  <Input
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                    placeholder="例如：gpt-4, llama-3, qwen-plus"
                    style={{ marginTop: "8px" }}
                  />
                </div>

                <Divider />

                <div>
                  <Title level={5} style={{ margin: "0 0 8px 0" }}>
                API 端点
              </Title>
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    AI 服务的 API 地址（可选，留空使用内置模型）
                  </Text>
                  <Input
                    value={aiEndpoint}
                    onChange={(e) => setAiEndpoint(e.target.value)}
                    placeholder="例如：http://localhost:11434/v1/chat/completions"
                    style={{ marginTop: "8px" }}
                  />
                </div>
              </Space>
            </Card>
          </TabPane>

          <TabPane
            tab={
              <span>
                <FileImageOutlined />
                图片智能
              </span>
            }
            key="images"
          >
            <Card>
              <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <div>
                  <Title level={5} style={{ margin: "0 0 8px 0" }}>
                图片内容识别
              </Title>
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    自动识别图片内容并生成描述标签
                  </Text>
                </div>
                <div>
                  <Title level={5} style={{ margin: "0 0 8px 0" }}>
                人物/场景识别
              </Title>
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    自动识别图片中的人物、场景、活动等信息
                  </Text>
                </div>
              </Space>
            </Card>
          </TabPane>

          <TabPane
            tab={
              <span>
                <FileAudioOutlined />
                音频智能
              </span>
            }
            key="audio"
          >
            <Card>
              <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <div>
                  <Title level={5} style={{ margin: "0 0 8px 0" }}>
                音频内容分析
              </Title>
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    自动提取音频元数据和内容摘要
                  </Text>
                </div>
                <div>
                  <Title level={5} style={{ margin: "0 0 8px 0" }}>
                语音转文本
              </Title>
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    将语音内容转换为文本供搜索
                  </Text>
                </div>
              </Space>
            </Card>
          </TabPane>

          <TabPane
            tab={
              <span>
                <FileVideoOutlined />
                视频智能
              </span>
            }
            key="video"
          >
            <Card>
              <Space direction="vertical" size="large" style={{ width: "100%" }}>
                <div>
                  <Title level={5} style={{ margin: "0 0 8px 0" }}>
                视频内容分析
              </Title>
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    自动提取视频帧、场景和内容描述
                  </Text>
                </div>
                <div>
                  <Title level={5} style={{ margin: "0 0 8px 0" }}>
                关键帧提取
              </Title>
                  <Text type="secondary" style={{ fontSize: "12px" }}>
                    自动提取视频关键帧用于预览
                  </Text>
                </div>
              </Space>
            </Card>
          </TabPane>
        </Tabs>

        {/* 功能说明 */}
        <Card>
          <Title level={5} style={{ margin: "0 0 12px 0" }}>
            可用 AI 功能
          </Title>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div style={{ padding: "12px", background: "#f5f5f5", borderRadius: "8px" }}>
              <SearchOutlined style={{ color: "#1677ff", marginRight: "8px" }} />
              <Text strong>语义搜索</Text>
              <Text type="secondary" style={{ display: "block", fontSize: "12px", marginTop: "4px" }}>
                使用自然语言搜索文件内容
              </Text>
            </div>
            <div style={{ padding: "12px", background: "#f5f5f5", borderRadius: "8px" }}>
              <FileImageOutlined style={{ color: "#1677ff", marginRight: "8px" }} />
              <Text strong>智能分类</Text>
              <Text type="secondary" style={{ display: "block", fontSize: "12px", marginTop: "4px" }}>
                自动为文件添加分类标签
              </Text>
            </div>
            <div style={{ padding: "12px", background: "#f5f5f5", borderRadius: "8px" }}>
              <FileTextOutlined style={{ color: "#1677ff", marginRight: "8px" }} />
              <Text strong>内容摘要</Text>
              <Text type="secondary" style={{ display: "block", fontSize: "12px", marginTop: "4px" }}>
                为文档生成智能摘要
              </Text>
            </div>
            <div style={{ padding: "12px", background: "#f5f5f5", borderRadius: "8px" }}>
              <FormOutlined style={{ color: "#1677ff", marginRight: "8px" }} />
              <Text strong>批量重命名</Text>
              <Text type="secondary" style={{ display: "block", fontSize: "12px", marginTop: "4px" }}>
                AI 智能批量重命名建议
              </Text>
            </div>
          </div>
        </Card>

        {/* 操作按钮 */}
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <Button onClick={() => { setAiEnabled(true); setAiModel("default"); setAiEndpoint(""); }}>
            重置默认
          </Button>
          <Button type="primary">保存设置</Button>
        </div>
      </Space>
    </div>
  );
};

export default AISettingPanel;
