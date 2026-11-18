// 认知板块根组件：首层「知识库 / 本体」两页（对齐 future-brain 知识中台的分区：
// 知识库管资料/解析/检索问答，本体管类型/实例图谱）。
import { useState } from "react";
import { BulbOutlined } from "@ant-design/icons";
import { Tabs } from "antd";
import type { KbSummary } from "./api";
import KbListPage from "./KbListPage";
import KbWorkspace from "./KbWorkspace";
import OntologyPage from "./OntologyPage";

type Page = "kb" | "ontology";

export default function KnowledgeApp() {
  const [page, setPage] = useState<Page>("kb");
  const [activeKb, setActiveKb] = useState<KbSummary | null>(null);

  const kbView = activeKb ? (
    <KbWorkspace kb={activeKb} onKbChange={setActiveKb} onBack={() => setActiveKb(null)} />
  ) : (
    <KbListPage onOpen={setActiveKb} />
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 20,
          padding: "8px 20px 0",
          flexShrink: 0,
          borderBottom: "1px solid var(--ant-color-split)",
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontWeight: 600,
            fontSize: 16,
            paddingBottom: 10,
          }}
        >
          <BulbOutlined style={{ color: "var(--ant-color-primary)" }} />
          认知
        </span>
        <Tabs
          activeKey={page}
          onChange={(key) => setPage(key as Page)}
          style={{ flex: 1, minWidth: 0 }}
          items={[
            { key: "kb", label: "知识库" },
            { key: "ontology", label: "本体" },
          ]}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {page === "kb" ? kbView : <OntologyPage />}
      </div>
    </div>
  );
}
