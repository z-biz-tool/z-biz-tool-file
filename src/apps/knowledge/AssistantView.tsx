// AI 助手：库内问答（BM25 取证据 → cap-llm 生成带引用编号的回答）。
// 回答下方列引用卡片，点击跳回对应资料 —— 对应 future-brain 的 knowledge-assistant
// + assistant-citation 的「回答可溯源」交互（本地版是同步一轮调用，非 SSE 流式）。
import { useEffect, useRef, useState } from "react";
import {
  App as AntdApp,
  Button,
  Empty,
  Input,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { SendOutlined } from "@ant-design/icons";
import MDEditor from "@uiw/react-md-editor";
import { kbAsk, type AskResult, type Citation } from "./api";

const { Text } = Typography;

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  result?: AskResult;
}

export default function AssistantView({
  kbId,
  onOpenMaterial,
}: {
  kbId: string;
  onOpenMaterial: (materialId: string) => void;
}) {
  const { message: msgApi } = AntdApp.useApp();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, asking]);

  async function send() {
    const q = question.trim();
    if (!q || asking) return;
    setQuestion("");
    setTurns((prev) => [...prev, { role: "user", content: q }]);
    setAsking(true);
    try {
      const result = await kbAsk(kbId, q);
      setTurns((prev) => [...prev, { role: "assistant", content: result.answer, result }]);
    } catch (e) {
      msgApi.error(`问答失败: ${e}`);
    } finally {
      setAsking(false);
    }
  }

  const citations: Citation[] = turns[turns.length - 1]?.result?.citations ?? [];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 4px" }}>
        {turns.length === 0 ? (
          <Empty
            style={{ paddingTop: 80 }}
            description={
              <>
                基于已解析的资料回答问题，结论带引用编号
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  需要先在「AI 设置」里配好模型；证据不足时助手会直说，不会编
                </Text>
              </>
            }
          />
        ) : (
          <Space direction="vertical" size={14} style={{ width: "100%" }}>
            {turns.map((turn, i) =>
              turn.role === "user" ? (
                <div key={i} style={{ display: "flex", justifyContent: "flex-end" }}>
                  <div
                    style={{
                      maxWidth: "78%",
                      background: "var(--ant-color-fill-tertiary)",
                      borderRadius: 12,
                      padding: "8px 14px",
                      fontSize: 13,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {turn.content}
                  </div>
                </div>
              ) : (
                <div key={i} style={{ maxWidth: "92%" }}>
                  <div data-color-mode="light" style={{ fontSize: 13 }}>
                    <MDEditor.Markdown source={turn.content} style={{ background: "transparent" }} />
                  </div>
                </div>
              ),
            )}
            {asking ? (
              <Space>
                <Spin size="small" />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  正在检索语料并生成回答…
                </Text>
              </Space>
            ) : null}
          </Space>
        )}
      </div>

      {citations.length > 0 ? (
        <div style={{ flexShrink: 0, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            引用：
          </Text>
          {citations.map((c) => (
            <Tooltip key={c.no} title={c.text.slice(0, 120)} placement="top">
              <Tag
                style={{ cursor: "pointer", fontSize: 12 }}
                color="blue"
                onClick={() => onOpenMaterial(c.path)}
              >
                [{c.no}] {c.title}
              </Tag>
            </Tooltip>
          ))}
        </div>
      ) : null}

      <Space.Compact style={{ flexShrink: 0 }}>
        <Input
          placeholder="问点什么，例如：MinerU 的解析接口怎么调用？"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onPressEnter={() => void send()}
          disabled={asking}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={asking}
          onClick={() => void send()}
        >
          提问
        </Button>
      </Space.Compact>
    </div>
  );
}
