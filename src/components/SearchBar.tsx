import { useState, useEffect, useRef } from "react";
import { Input, Segmented, List, Typography, theme } from "antd";
import { SearchOutlined, FolderOutlined, FileOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFileStore, formatFileSize, type SearchResultItem } from "../stores/fileStore";
import { EmptyState, LoadingState } from "../_shared";

const { Text } = Typography;

interface SearchBarProps {
  rootPath: string;
}

/// 高亮关键词
function highlightMatch(text: string, query: string): ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      return (
        <mark
          key={i}
          style={{
            background: "var(--ant-colorPrimaryBg)",
            color: "var(--ant-colorPrimary)",
            padding: "0 2px",
            borderRadius: 2,
          }}
        >
          {part}
        </mark>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export default function SearchBar({ rootPath }: SearchBarProps) {
  const { token } = theme.useToken();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"filename" | "content">("filename");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { setSelectedFile, setCurrentPath } = useFileStore();

  const doSearch = async (searchQuery: string, searchMode: "filename" | "content") => {
    if (!searchQuery.trim() || !rootPath) {
      setResults([]);
      setHasSearched(false);
      return;
    }

    setLoading(true);
    setHasSearched(true);

    try {
      let res: SearchResultItem[];
      if (searchMode === "filename") {
        res = await invoke("full_disk_search", {
          rootPath: rootPath,
          query: searchQuery,
          maxResults: 200,
        });
      } else {
        res = await invoke("search_file_content", {
          rootPath: rootPath,
          query: searchQuery,
          maxResults: 100,
        });
      }
      setResults(res);
    } catch (err) {
      console.error("搜索失败:", err);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  // 防抖搜索
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    if (query.trim()) {
      timerRef.current = setTimeout(() => {
        doSearch(query, mode);
      }, 500);
    } else {
      setResults([]);
      setHasSearched(false);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode, rootPath]);

  const handleResultClick = (item: SearchResultItem) => {
    setSelectedFile({
      name: item.name,
      path: item.path,
      is_dir: item.is_dir,
      size: item.size,
      modified: 0,
    });
    if (item.is_dir) {
      setCurrentPath(item.path);
    }
  };

  const trimmedQuery = query.trim();

  return (
    <div style={{ padding: "8px 12px", borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <Input
          placeholder="全盘搜索文件名或内容..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
          allowClear
          style={{ flex: 1 }}
        />
        <Segmented
          options={[
            { label: "文件名", value: "filename" },
            { label: "内容", value: "content" },
          ]}
          value={mode}
          onChange={(v) => setMode(v as "filename" | "content")}
          size="small"
        />
      </div>

      {loading && <LoadingState tip="搜索中..." minHeight={120} />}

      {!loading && hasSearched && results.length === 0 && (
        <EmptyState
          title="未找到匹配文件"
          description={`没有找到包含「${trimmedQuery}」的结果`}
          icon={
            <SearchOutlined style={{ fontSize: 48, color: "var(--ant-color-text-tertiary)" }} />
          }
        />
      )}

      {!loading && results.length > 0 && (
        <div className="search-results">
          <Text type="secondary" style={{ fontSize: 12, padding: "4px 0", display: "block" }}>
            找到 {results.length} 个结果
          </Text>
          <List
            size="small"
            dataSource={results}
            renderItem={(item) => (
              <List.Item
                onClick={() => handleResultClick(item)}
                style={{ cursor: "pointer", padding: "6px 8px" }}
              >
                <div style={{ width: "100%", overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {item.is_dir ? <FolderOutlined /> : <FileOutlined />}
                    <Text strong style={{ fontSize: 13 }}>
                      {highlightMatch(item.name, trimmedQuery)}
                    </Text>
                    {!item.is_dir && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {formatFileSize(item.size)}
                      </Text>
                    )}
                  </div>
                  <Text
                    type="secondary"
                    style={{
                      fontSize: 11,
                      display: "block",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {highlightMatch(item.path, trimmedQuery)}
                  </Text>
                  {item.matched_line && (
                    <Text
                      code
                      style={{
                        fontSize: 11,
                        display: "block",
                        marginTop: 2,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {highlightMatch(item.matched_line, trimmedQuery)}
                    </Text>
                  )}
                </div>
              </List.Item>
            )}
          />
        </div>
      )}
    </div>
  );
}
