// 知识检索面板：BM25 检索解析稿，命中可跳回资料页签看原文。
// 形态对齐 future-brain 的 retrieval-workspace（topK 选择 + 相关度徽标 + 命中卡片）。
import { useState } from "react";
import {
  App as AntdApp,
  Button,
  Empty,
  Input,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { kbSearch, type SearchHit } from "./api";

const { Text, Paragraph } = Typography;

export default function RetrievalView({
  kbId,
  onOpenMaterial,
}: {
  kbId: string;
  onOpenMaterial: (materialId: string) => void;
}) {
  const { message: msgApi } = AntdApp.useApp();
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(10);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  async function run() {
    const q = query.trim();
    if (!q) {
      msgApi.warning("请输入检索词");
      return;
    }
    setSearching(true);
    try {
      setHits(await kbSearch(kbId, q, topK));
    } catch (e) {
      msgApi.error(`检索失败: ${e}`);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
      <Space.Compact style={{ flexShrink: 0 }}>
        <Input
          placeholder="在已解析的知识里检索（BM25 关键词匹配）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPressEnter={() => void run()}
          allowClear
        />
        <Select
          value={topK}
          onChange={setTopK}
          options={[5, 10, 20, 50].map((n) => ({ value: n, label: `Top ${n}` }))}
          style={{ width: 96 }}
        />
        <Button type="primary" icon={<SearchOutlined />} loading={searching} onClick={() => void run()}>
          检索
        </Button>
      </Space.Compact>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {hits === null ? (
          <Empty
            style={{ paddingTop: 80 }}
            description="输入检索词开始查询，命中片段可跳回资料原文"
          />
        ) : hits.length === 0 ? (
          <Empty style={{ paddingTop: 80 }} description="没有命中 —— 语料只覆盖「已解析」的资料" />
        ) : (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {hits.map((hit, i) => (
              <div
                key={`${hit.material_id}-${i}`}
                onClick={() => onOpenMaterial(hit.material_id)}
                style={{
                  border: "1px solid var(--ant-color-border-secondary)",
                  borderRadius: 8,
                  padding: "10px 14px",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--ant-color-primary)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--ant-color-border-secondary)";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <Text strong style={{ fontSize: 13 }}>
                    {hit.title}
                  </Text>
                  <Tag color="blue" style={{ marginRight: 0 }}>
                    相关度 {(hit.score * 100).toFixed(0)}%
                  </Tag>
                  <div style={{ flex: 1 }} />
                  {hit.category_path.length > 0 ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {hit.category_path.join(" / ")}
                    </Text>
                  ) : null}
                </div>
                <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                  {hit.snippet}
                </Paragraph>
              </div>
            ))}
          </Space>
        )}
      </div>
    </div>
  );
}
