import { useState, useEffect, useRef } from "react";
import { Input, Button, List, Typography, Segmented, Spin, Empty } from "antd";
import { SearchOutlined, FolderOutlined, FileOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useFileStore, formatFileSize, type SearchResultItem } from "../stores/fileStore";

const { Text } = Typography;

interface SearchBarProps {
  rootPath: string;
}

export default function SearchBar({ rootPath }: SearchBarProps) {
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

  return (
    <div style={{ padding: "8px 12px", borderBottom: "1px solid #f0f0f0" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <Input
          placeholder="全盘搜索文件名或内容..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          prefix={<SearchOutlined style={{ color: "#999" }} />}
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

      {loading && (
        <div style={{ textAlign: "center", padding: 12 }}>
          <Spin size="small" /> <Text type="secondary">搜索中...</Text>
        </div>
      )}

      {!loading && hasSearched && results.length === 0 && (
        <Empty description="未找到匹配结果" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 12 }} />
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
                      {item.name}
                    </Text>
                    {!item.is_dir && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {formatFileSize(item.size)}
                      </Text>
                    )}
                  </div>
                  <Text
                    type="secondary"
                    style={{ fontSize: 11, display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {item.path}
                  </Text>
                  {item.matched_line && (
                    <Text
                      code
                      style={{ fontSize: 11, display: "block", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                    >
                      {item.matched_line}
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
