import { useEffect, useMemo, useState } from "react";
import {
  Tabs,
  Input,
  Button,
  List,
  Tag,
  Empty,
  Space,
  Modal,
  Form,
  Select,
  Spin,
  Alert,
  Typography,
  Card,
  Divider,
  Tooltip,
  App as AntdApp,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  SearchOutlined,
  QuestionCircleOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { searchContent, getIndexStats, initIndexer } from "../../services/indexService";
import type { ContentIndexItem } from "../../services/indexService";

// ─────────────────────────────── 类型 ───────────────────────────────

interface GlossaryTermView {
  id: string;
  term: string;
  content: string;
  tags: string[];
  updated_at: number;
}

interface Citation {
  path: string;
  title: string;
  heading: string;
  anchor: string;
  text: string;
  score: number;
  no: number;
}

interface AskResult {
  answer: string;
  citations: Citation[];
}

// ─────────────────────────────── 命令封装 ───────────────────────────────

const glossaryList = () => invoke<GlossaryTermView[]>("glossary_list");
const glossarySearch = (query: string, topN = 50) =>
  invoke<GlossaryTermView[]>("glossary_search", { query, topN });
const glossaryStats = () => invoke<[number, Record<string, number>]>("glossary_stats");
const glossaryUpsert = (input: {
  id?: string;
  term: string;
  content: string;
  tags: string[];
}) => invoke<GlossaryTermView>("glossary_upsert", { input });
const glossaryRemove = (id: string) => invoke<void>("glossary_remove", { id });
const glossaryAsk = (question: string) => invoke<AskResult>("glossary_ask", { question });

const { TextArea } = Input;
const { Text } = Typography;

/**
 * 词库板块（2026-11-08 新建）：kb（知识库）作为通用板块落地到 file。
 *
 * 三个页签对应 kb 认知能力的全部入口：
 *   1. 词条 —— 手动维护词/释义库，可检索（后端 cap-glossary 同一套 tokenize）；
 *   2. 问答 —— 在词库语料上提问，返回带引用的回答（复用 file 的 AI 链路）；
 *   3. 检索文件 —— 直接查 file 的全文索引（indexer_search_content）。
 *
 * 并入约定同 worker/mind 板块：
 *   - 高度 100%（不要 100vh）；提示用 `App.useApp()` 拿到局部实例；
 *   - 导出名 GlossayApp，由 file 的 App.tsx 懒加载（不在首屏）。
 */
export default function GlossayApp() {
  const { message: msgApi } = AntdApp.useApp();

  // ── 词条列表页签状态 ──
  const [terms, setTerms] = useState<GlossaryTermView[]>([]);
  const [loadingTerms, setLoadingTerms] = useState(false);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagCounts, setTagCounts] = useState<Record<string, number>>({});
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<GlossaryTermView | null>(null);
  const [form] = Form.useForm();

  // ── 问答页签状态 ──
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<AskResult | null>(null);

  // ── 检索文件页签状态 ──
  const [fileQuery, setFileQuery] = useState("");
  const [fileResults, setFileResults] = useState<ContentIndexItem[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const [fileStats, setFileStats] = useState<{ total_files: number } | null>(null);

  useEffect(() => {
    refreshStats();
  }, []);

  async function refreshStats() {
    try {
      const [, counts] = await glossaryStats();
      setTagCounts(counts);
    } catch (e) {
      console.error("读取词库统计失败", e);
    }
  }

  async function refreshTerms() {
    setLoadingTerms(true);
    try {
      const data = query.trim() ? await glossarySearch(query.trim(), 100) : await glossaryList();
      setTerms(data);
    } catch (e) {
      msgApi.error("读取词条失败：" + String(e));
    } finally {
      setLoadingTerms(false);
    }
  }

  useEffect(() => {
    refreshTerms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const visibleTerms = useMemo(() => {
    if (!tagFilter.length) return terms;
    return terms.filter((t) => tagFilter.some((tag) => t.tags.includes(tag)));
  }, [terms, tagFilter]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setEditorOpen(true);
  };

  const openEdit = (t: GlossaryTermView) => {
    setEditing(t);
    form.setFieldsValue({ term: t.term, content: t.content, tags: t.tags });
    setEditorOpen(true);
  };

  async function submitEditor() {
    try {
      const values = await form.validateFields();
      const saved = await glossaryUpsert({
        id: editing?.id,
        term: (values.term ?? "").trim(),
        content: values.content ?? "",
        tags: values.tags ?? [],
      });
      msgApi.success(editing ? "词条已更新" : "词条已添加");
      setEditorOpen(false);
      await Promise.all([refreshTerms(), refreshStats()]);
      void saved;
    } catch (e) {
      // 表单校验错误会直接 throw，这里不弹
      if (String(e).includes("词条名")) {
        msgApi.error(String(e));
      }
    }
  }

  async function removeTerm(t: GlossaryTermView) {
    try {
      await glossaryRemove(t.id);
      msgApi.success("已删除「" + t.term + "」");
      await Promise.all([refreshTerms(), refreshStats()]);
    } catch (e) {
      msgApi.error("删除失败：" + String(e));
    }
  }

  async function ask() {
    const q = question.trim();
    if (!q) {
      msgApi.warning("先输入问题");
      return;
    }
    setAsking(true);
    setAskResult(null);
    try {
      const result = await glossaryAsk(q);
      setAskResult(result);
    } catch (e) {
      msgApi.error("问答失败：" + String(e));
    } finally {
      setAsking(false);
    }
  }

  async function searchFiles() {
    const q = fileQuery.trim();
    if (!q) {
      msgApi.warning("先输入关键词");
      return;
    }
    setFileSearching(true);
    try {
      const results = await searchContent(q, 50);
      setFileResults(results);
    } catch (e) {
      msgApi.error("检索失败：" + String(e));
    } finally {
      setFileSearching(false);
    }
  }

  async function initFilesIndex() {
    try {
      await initIndexer();
      const stats = await getIndexStats();
      setFileStats({ total_files: stats.total_files });
      msgApi.success("文件索引已就绪（" + (stats.total_files ?? 0) + " 个文件）");
    } catch (e) {
      msgApi.error("初始化索引失败：" + String(e));
    }
  }

  const revealFile = (path: string) => {
    invoke("reveal_in_finder", { path }).catch((e) =>
      msgApi.error("在 Finder 中定位失败：" + String(e))
    );
  };

  const allTags = Object.keys(tagCounts).sort();

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Tabs
        size="small"
        tabBarStyle={{ padding: "0 16px", margin: 0 }}
        items={[
          {
            key: "terms",
            label: (
              <Space size={4}>
                <FolderOpenOutlined />
                词条
              </Space>
            ),
            children: (
              <div style={{ height: "100%", padding: "12px 16px", overflow: "auto" }}>
                <Space style={{ marginBottom: 12 }} wrap>
                  <Input.Search
                    placeholder="搜索词条"
                    allowClear
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    style={{ width: 260 }}
                    prefix={<SearchOutlined />}
                  />
                  <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                    新增词条
                  </Button>
                </Space>

                {allTags.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    {allTags.map((tag) => (
                      <Tag
                        key={tag}
                        color={tagFilter.includes(tag) ? "blue" : "default"}
                        style={{ cursor: "pointer" }}
                        onClick={() =>
                          setTagFilter((prev) =>
                            prev.includes(tag)
                              ? prev.filter((t) => t !== tag)
                              : [...prev, tag]
                          )
                        }
                      >
                        {tag} · {tagCounts[tag]}
                      </Tag>
                    ))}
                  </div>
                )}

                {loadingTerms ? (
                  <div style={{ textAlign: "center", padding: 40 }}>
                    <Spin />
                  </div>
                ) : visibleTerms.length === 0 ? (
                  <Empty description={query ? "没有匹配的词条" : "词库还是空的，点「新增词条」开始沉淀"} />
                ) : (
                  <List
                    split
                    dataSource={visibleTerms}
                    renderItem={(t) => (
                      <List.Item
                        actions={[
                          <Tooltip title="编辑" key="edit">
                            <Button
                              type="text"
                              size="small"
                              icon={<EditOutlined />}
                              aria-label={`编辑 ${t.term}`}
                              onClick={() => openEdit(t)}
                            />
                          </Tooltip>,
                          <Tooltip title="删除" key="del">
                            <Button
                              type="text"
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              aria-label={`删除 ${t.term}`}
                              onClick={() => removeTerm(t)}
                            />
                          </Tooltip>,
                        ]}
                      >
                        <List.Item.Meta
                          title={
                            <Space wrap>
                              <Text strong>{t.term}</Text>
                              {t.tags.map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                              ))}
                            </Space>
                          }
                          description={
                            <Text type="secondary" style={{ whiteSpace: "pre-wrap" }}>
                              {t.content}
                            </Text>
                          }
                        />
                      </List.Item>
                    )}
                  />
                )}
              </div>
            ),
          },
          {
            key: "ask",
            label: (
              <Space size={4}>
                <QuestionCircleOutlined />
                问答
              </Space>
            ),
            children: (
              <div style={{ height: "100%", padding: "12px 16px", overflow: "auto" }}>
                <Alert
                  type="info"
                  showIcon
                  message="在词库语料上提问，回答会带引用（基于 cap-glossary 检索 + 你已配置的 AI 服务）。"
                  style={{ marginBottom: 12 }}
                />
                <Space.Compact style={{ width: "100%", marginBottom: 12 }}>
                  <TextArea
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="例如：什么是 BMI 指数？"
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    onPressEnter={(e) => {
                      if (!e.shiftKey) {
                        e.preventDefault();
                        ask();
                      }
                    }}
                  />
                  <Button
                    type="primary"
                    icon={<QuestionCircleOutlined />}
                    loading={asking}
                    onClick={ask}
                    style={{ height: "auto", alignSelf: "stretch" }}
                  >
                    提问
                  </Button>
                </Space.Compact>

                {asking && (
                  <div style={{ textAlign: "center", padding: 40 }}>
                    <Spin tip="正在检索并作答…">
                      <div style={{ height: 60 }} />
                    </Spin>
                  </div>
                )}

                {!asking && askResult && (
                  <div>
                    <Card size="small" style={{ marginBottom: 12 }}>
                      <Text style={{ whiteSpace: "pre-wrap", lineHeight: 1.8 }}>
                        {askResult.answer}
                      </Text>
                    </Card>

                    <Divider plain>
                      引用（{askResult.citations.length}）
                    </Divider>
                    {askResult.citations.length === 0 ? (
                      <Empty description="无引用" />
                    ) : (
                      <List
                        size="small"
                        dataSource={askResult.citations}
                        renderItem={(c) => (
                          <List.Item
                            actions={[
                              <Button
                                key="locate"
                                type="link"
                                size="small"
                                onClick={() => revealFile(c.path)}
                              >
                                定位文件
                              </Button>,
                            ]}
                          >
                            <Space size={8} align="start">
                              <Tag color="blue">[{c.no}]</Tag>
                              <div>
                                <Text strong>
                                  {c.title}
                                  {c.heading ? ` › ${c.heading}` : ""}
                                </Text>
                                <br />
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {c.text.slice(0, 120)}
                                  {c.text.length > 120 ? "…" : ""}
                                </Text>
                              </div>
                            </Space>
                          </List.Item>
                        )}
                      />
                    )}
                  </div>
                )}
              </div>
            ),
          },
          {
            key: "files",
            label: (
              <Space size={4}>
                <FileSearchOutlined />
                检索文件
              </Space>
            ),
            children: (
              <div style={{ height: "100%", padding: "12px 16px", overflow: "auto" }}>
                <Space style={{ marginBottom: 12 }} wrap>
                  <Input.Search
                    placeholder="搜索文件内容"
                    allowClear
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                    onSearch={searchFiles}
                    style={{ width: 320 }}
                    loading={fileSearching}
                  />
                  <Button onClick={initFilesIndex}>初始化索引</Button>
                  {fileStats && <Text type="secondary">已索引 {fileStats.total_files} 个文件</Text>}
                </Space>

                {fileSearching ? (
                  <div style={{ textAlign: "center", padding: 40 }}>
                    <Spin />
                  </div>
                ) : fileResults.length === 0 ? (
                  <Empty description="输入关键词检索已索引文件的正文内容" />
                ) : (
                  <List
                    size="small"
                    dataSource={fileResults}
                    renderItem={(r) => (
                      <List.Item
                        actions={[
                          <Button
                            key="locate"
                            type="link"
                            size="small"
                            onClick={() => revealFile(r.path)}
                          >
                            定位
                          </Button>,
                        ]}
                      >
                        <div style={{ minWidth: 0 }}>
                          <Text strong style={{ wordBreak: "break-all" }}>
                            {r.path}
                          </Text>
                          <br />
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {r.snippet}
                          </Text>
                        </div>
                      </List.Item>
                    )}
                  />
                )}
              </div>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? "编辑词条" : "新增词条"}
        open={editorOpen}
        onOk={submitEditor}
        onCancel={() => setEditorOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" autoComplete="off">
          <Form.Item
            name="term"
            label="词条名"
            rules={[{ required: true, whitespace: true, message: "请输入词条名" }]}
          >
            <Input placeholder="例如：BMI 指数" />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="输入后回车添加，可多个" tokenSeparators={[","]} allowClear />
          </Form.Item>
          <Form.Item name="content" label="释义 / 内容">
            <TextArea rows={6} placeholder="写下这个词的定义、要点、示例……" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}