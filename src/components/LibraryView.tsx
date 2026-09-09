import { useState, useEffect, useCallback } from "react";
import {
  Modal,
  Button,
  Space,
  Input,
  Typography,
  message,
  Table,
  Tag,
  Card,
  Row,
  Col,
  Statistic,
  Empty,
  Tabs,
  Select,
  Rate,
  Tooltip,
  Progress,
} from "antd";
import {
  PictureOutlined,
  VideoCameraOutlined,
  AudioOutlined,
  FileTextOutlined,
  BookOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  PlusOutlined,
  SearchOutlined,
  HeartFilled,
  HeartOutlined,
  AppstoreOutlined,
  BarsOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

const { Text } = Typography;

// =============== 类型 ===============

interface MediaItem {
  id: string;
  path: string;
  kind: string;
  title: string;
  size: number;
  modified: number;
  indexed_at: number;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  artist: string | null;
  album: string | null;
  cover_path: string | null;
  author: string | null;
  page_count: number | null;
  cover_url: string | null;
  tags: string[];
  rating: number | null;
  description: string | null;
  favorite: boolean;
  series: string | null;
  series_index: number | null;
  publisher: string | null;
  publish_year: number | null;
  isbn: string | null;
  language: string | null;
}

interface LibraryEntry {
  id: string;
  item_id: string;
  kind: string;
  title: string;
  path: string;
  author: string | null;
  series: string | null;
  series_index: number | null;
  publisher: string | null;
  publish_year: number | null;
  isbn: string | null;
  tags: string[];
  rating: number | null;
  description: string | null;
  cover_url: string | null;
  added_at: number;
  last_read_at: number | null;
  read_progress: number | null;
}

interface LibraryStats {
  total_media: number;
  total_library: number;
  by_kind: Record<string, number>;
  scan_dirs: string[];
}

// =============== 工具 ===============

const KIND_ICONS: Record<string, React.ReactNode> = {
  image: <PictureOutlined />,
  video: <VideoCameraOutlined />,
  audio: <AudioOutlined />,
  document: <FileTextOutlined />,
  ebook: <BookOutlined />,
  comic: <BookOutlined />,
  other: <FileTextOutlined />,
};

const KIND_COLORS: Record<string, string> = {
  image: "blue",
  video: "purple",
  audio: "magenta",
  document: "orange",
  ebook: "green",
  comic: "cyan",
  other: "default",
};

const LIBRARY_KIND_LABELS: Record<string, string> = {
  book: "书籍",
  comic: "漫画",
  music: "音乐",
  movie: "电影",
  tv_show: "剧集",
  podcast: "播客",
  document: "文档",
};

const MEDIA_KIND_LABELS: Record<string, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  document: "文档",
  ebook: "电子书",
  comic: "漫画",
  other: "其他",
};

const formatSize = (b: number) => {
  if (!b) return "0";
  const k = 1024;
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), u.length - 1);
  return `${(b / Math.pow(k, i)).toFixed(1)} ${u[i]}`;
};

// =============== 主组件 ===============

interface LibraryViewProps {
  open: boolean;
  onClose: () => void;
  initialTab?: "media" | "library";
}

export default function LibraryView({ open, onClose, initialTab }: LibraryViewProps) {
  const [tab, setTab] = useState<"media" | "library">(initialTab || "media");
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [msgApi, msgContext] = message.useMessage();

  // 媒体库
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaKind, setMediaKind] = useState<string | null>(null);
  const [mediaSearch, setMediaSearch] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [scanning, setScanning] = useState(false);

  // 图书馆
  const [books, setBooks] = useState<LibraryEntry[]>([]);
  const [bookKind, setBookKind] = useState<string | null>(null);
  const [bookSearch, setBookSearch] = useState("");
  const [scanningBooks, setScanningBooks] = useState(false);

  const refreshStats = useCallback(async () => {
    try {
      const s = await invoke<LibraryStats>("library_stats");
      setStats(s);
    } catch {}
  }, []);

  const refreshMedia = useCallback(async () => {
    try {
      const items = await invoke<MediaItem[]>("library_query_media", {
        kind: mediaKind,
        search: mediaSearch || null,
        favoritesOnly: favoritesOnly,
      });
      setMediaItems(items);
    } catch (e: any) {
      msgApi.error("加载失败: " + e);
    }
  }, [mediaKind, mediaSearch, favoritesOnly, msgApi]);

  const refreshBooks = useCallback(async () => {
    try {
      const items = await invoke<LibraryEntry[]>("library_query_books", {
        kind: bookKind,
        search: bookSearch || null,
      });
      setBooks(items);
    } catch (e: any) {
      msgApi.error("加载失败: " + e);
    }
  }, [bookKind, bookSearch, msgApi]);

  useEffect(() => {
    if (open) {
      refreshStats();
      refreshMedia();
      refreshBooks();
    }
  }, [open, refreshStats, refreshMedia, refreshBooks]);

  // 添加扫描目录
  const addScanDir = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false });
      if (dir && typeof dir === "string") {
        await invoke("library_add_scan_dir", { dir });
        msgApi.success(`已添加扫描目录: ${dir}`);
        refreshStats();
      }
    } catch (e: any) {
      msgApi.error("添加失败: " + e);
    }
  };

  const removeScanDir = async (dir: string) => {
    try {
      await invoke("library_remove_scan_dir", { dir });
      msgApi.success("已移除");
      refreshStats();
    } catch (e: any) {
      msgApi.error("移除失败: " + e);
    }
  };

  // 扫描
  const doScanMedia = async () => {
    if (!stats || stats.scan_dirs.length === 0) {
      msgApi.warning("请先添加扫描目录");
      return;
    }
    setScanning(true);
    try {
      const s = await invoke<LibraryStats>("library_scan_media");
      setStats(s);
      msgApi.success(`扫描完成！共 ${s.total_media} 个媒体项`);
      refreshMedia();
    } catch (e: any) {
      msgApi.error("扫描失败: " + e);
    } finally {
      setScanning(false);
    }
  };

  const doScanBooks = async () => {
    if (!stats || stats.scan_dirs.length === 0) {
      msgApi.warning("请先添加扫描目录");
      return;
    }
    setScanningBooks(true);
    try {
      const s = await invoke<LibraryStats>("library_scan_books");
      setStats(s);
      msgApi.success(`扫描完成！共 ${s.total_library} 个图书项`);
      refreshBooks();
    } catch (e: any) {
      msgApi.error("扫描失败: " + e);
    } finally {
      setScanningBooks(false);
    }
  };

  const toggleFav = async (id: string) => {
    try {
      await invoke("library_toggle_favorite", { id });
      refreshMedia();
    } catch (e: any) {
      msgApi.error(e);
    }
  };

  const setRating = async (id: string, r: number) => {
    try {
      await invoke("library_set_rating", { id, rating: r });
      refreshMedia();
    } catch {}
  };

  // =============== 渲染 ===============

  return (
    <Modal
      title={
        <Space>
          <BookOutlined style={{ color: "#eb2f96" }} />
          <span>图书馆 & 媒体库</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={1100}
      footer={null}
      destroyOnClose
    >
      {msgContext}

      {/* 顶部统计 */}
      {stats && (
        <Row gutter={12} style={{ marginBottom: 12 }}>
          <Col span={4}>
            <Card size="small">
              <Statistic title="媒体项" value={stats.total_media} prefix={<PictureOutlined />} />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic title="图书项" value={stats.total_library} prefix={<BookOutlined />} />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic title="扫描目录" value={stats.scan_dirs.length} prefix={<FolderOpenOutlined />} />
            </Card>
          </Col>
          <Col span={12}>
            <Card size="small" styles={{ body: { padding: 8 } }}>
              <Space wrap size={4}>
                {Object.entries(stats.by_kind).map(([k, n]) => (
                  <Tag key={k} color={KIND_COLORS[k] || "default"} icon={KIND_ICONS[k]}>
                    {MEDIA_KIND_LABELS[k] || k}: {n}
                  </Tag>
                ))}
                {Object.keys(stats.by_kind).length === 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>尚未扫描</Text>
                )}
              </Space>
            </Card>
          </Col>
        </Row>
      )}

      {/* 扫描目录管理 */}
      <Card size="small" title="扫描目录" style={{ marginBottom: 12 }}>
        <Space wrap>
          {stats?.scan_dirs.map((d) => (
            <Tag
              key={d}
              closable
              onClose={() => removeScanDir(d)}
              icon={<FolderOpenOutlined />}
            >
              {d}
            </Tag>
          ))}
          <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addScanDir}>
            添加目录
          </Button>
        </Space>
      </Card>

      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as any)}
        items={[
          {
            key: "media",
            label: <span><PictureOutlined />媒体库</span>,
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size={12}>
                <Space wrap>
                  <Select
                    placeholder="选择类型" allowClear style={{ width: 140 }}
                    value={mediaKind} onChange={setMediaKind}
                    options={Object.entries(MEDIA_KIND_LABELS).map(([k, v]) => ({ value: k, label: v }))}
                  />
                  <Input
                    placeholder="搜索标题/路径/标签" allowClear
                    value={mediaSearch} onChange={(e) => setMediaSearch(e.target.value)}
                    prefix={<SearchOutlined />} style={{ width: 240 }}
                  />
                  <Tooltip title="仅显示收藏">
                    <Button
                      icon={favoritesOnly ? <HeartFilled /> : <HeartOutlined />}
                      type={favoritesOnly ? "primary" : "default"}
                      onClick={() => setFavoritesOnly(!favoritesOnly)}
                    >
                      收藏
                    </Button>
                  </Tooltip>
                  <Button.Group>
                    <Button
                      icon={<AppstoreOutlined />}
                      type={view === "grid" ? "primary" : "default"}
                      onClick={() => setView("grid")}
                    />
                    <Button
                      icon={<BarsOutlined />}
                      type={view === "list" ? "primary" : "default"}
                      onClick={() => setView("list")}
                    />
                  </Button.Group>
                  <Button
                    type="primary" icon={<ReloadOutlined />}
                    onClick={doScanMedia} loading={scanning}
                  >
                    扫描
                  </Button>
                </Space>

                {mediaItems.length === 0 ? (
                  <Empty description="暂无媒体项" />
                ) : view === "grid" ? (
                  <Row gutter={[8, 8]} style={{ maxHeight: 500, overflow: "auto" }}>
                    {mediaItems.map((item) => (
                      <Col key={item.id} xs={12} sm={8} md={6} lg={4}>
                        <Card
                          size="small"
                          hoverable
                          bodyStyle={{ padding: 8 }}
                          onDoubleClick={() => invoke("open_with_default_app", { path: item.path }).catch(() => {})}
                        >
                          <div
                            style={{
                              height: 100, background: "#f5f5f5", borderRadius: 4,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 36, color: "#999", marginBottom: 8,
                            }}
                          >
                            {item.kind === "image" && item.path.match(/\.(jpe?g|png|webp|gif)$/i) ? (
                              <img
                                src={`asset://localhost/${encodeURIComponent(item.path)}`}
                                alt={item.title}
                                style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 4 }}
                                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                              />
                            ) : (
                              KIND_ICONS[item.kind]
                            )}
                          </div>
                          <Text ellipsis style={{ fontSize: 12 }} title={item.title}>
                            {item.title}
                          </Text>
                          <div style={{ marginTop: 4 }}>
                            <Tag color={KIND_COLORS[item.kind]} style={{ fontSize: 10, padding: "0 4px" }}>
                              {MEDIA_KIND_LABELS[item.kind] || item.kind}
                            </Tag>
                            {item.width && item.height && (
                              <Tag style={{ fontSize: 10, padding: "0 4px" }}>
                                {item.width}×{item.height}
                              </Tag>
                            )}
                          </div>
                          <Space size={4} style={{ marginTop: 4 }}>
                            <Button
                              size="small" type="text"
                              icon={item.favorite ? <HeartFilled style={{ color: "#eb2f96" }} /> : <HeartOutlined />}
                              onClick={() => toggleFav(item.id)}
                            />
                            <Rate
                              value={item.rating || 0}
                              onChange={(v) => setRating(item.id, v)}
                              count={5}
                              style={{ fontSize: 10 }}
                            />
                          </Space>
                        </Card>
                      </Col>
                    ))}
                  </Row>
                ) : (
                  <Table
                    size="small" rowKey="id" pagination={{ pageSize: 20 }}
                    dataSource={mediaItems}
                    columns={[
                      {
                        title: "名称", dataIndex: "title", ellipsis: true,
                        render: (t: string, r: MediaItem) => (
                          <Space>
                            <span style={{ color: KIND_COLORS[r.kind] && undefined }}>
                              {KIND_ICONS[r.kind]}
                            </span>
                            <Text ellipsis>{t}</Text>
                          </Space>
                        ),
                      },
                      {
                        title: "类型", dataIndex: "kind", width: 80,
                        render: (k: string) => <Tag color={KIND_COLORS[k]}>{MEDIA_KIND_LABELS[k]}</Tag>,
                      },
                      {
                        title: "尺寸", dataIndex: "size", width: 100,
                        render: (s: number) => formatSize(s),
                      },
                      {
                        title: "分辨率", width: 120,
                        render: (_, r: MediaItem) =>
                          r.width && r.height ? `${r.width}×${r.height}` : "-",
                      },
                      {
                        title: "评分", dataIndex: "rating", width: 160,
                        render: (v: number | null, r: MediaItem) => (
                          <Rate
                            value={v || 0}
                            onChange={(val) => setRating(r.id, val)}
                            style={{ fontSize: 12 }}
                          />
                        ),
                      },
                      {
                        title: "收藏", dataIndex: "favorite", width: 60,
                        render: (f: boolean, r: MediaItem) => (
                          <Button
                            type="text" size="small"
                            icon={f ? <HeartFilled style={{ color: "#eb2f96" }} /> : <HeartOutlined />}
                            onClick={() => toggleFav(r.id)}
                          />
                        ),
                      },
                    ]}
                  />
                )}
              </Space>
            ),
          },
          {
            key: "library",
            label: <span><BookOutlined />图书馆</span>,
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size={12}>
                <Space wrap>
                  <Select
                    placeholder="选择类型" allowClear style={{ width: 140 }}
                    value={bookKind} onChange={setBookKind}
                    options={Object.entries(LIBRARY_KIND_LABELS).map(([k, v]) => ({ value: k, label: v }))}
                  />
                  <Input
                    placeholder="搜索标题/作者" allowClear
                    value={bookSearch} onChange={(e) => setBookSearch(e.target.value)}
                    prefix={<SearchOutlined />} style={{ width: 240 }}
                  />
                  <Button
                    type="primary" icon={<ReloadOutlined />}
                    onClick={doScanBooks} loading={scanningBooks}
                  >
                    扫描
                  </Button>
                </Space>

                {books.length === 0 ? (
                  <Empty description="暂无图书项" />
                ) : (
                  <Row gutter={[12, 12]} style={{ maxHeight: 500, overflow: "auto" }}>
                    {books.map((book) => (
                      <Col key={book.id} xs={24} sm={12} md={8} lg={6}>
                        <Card
                          size="small"
                          hoverable
                          onDoubleClick={() => invoke("open_with_default_app", { path: book.path }).catch(() => {})}
                        >
                          <Space>
                            <div
                              style={{
                                width: 48, height: 64,
                                background: "#fafafa", border: "1px solid #e8e8e8",
                                borderRadius: 4,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: 20,
                              }}
                            >
                              {KIND_ICONS["ebook"]}
                            </div>
                            <Space direction="vertical" size={2} style={{ flex: 1, minWidth: 0 }}>
                              <Text ellipsis style={{ fontWeight: 500 }} title={book.title}>
                                {book.title}
                              </Text>
                              <Tag color="blue" style={{ margin: 0, fontSize: 10 }}>
                                {LIBRARY_KIND_LABELS[book.kind] || book.kind}
                              </Tag>
                              {book.author && (
                                <Text type="secondary" style={{ fontSize: 11 }} ellipsis>
                                  {book.author}
                                </Text>
                              )}
                              {book.read_progress !== null && book.read_progress > 0 && (
                                <Progress
                                  percent={Math.round(book.read_progress * 100)}
                                  size="small"
                                  strokeColor="#52c41a"
                                />
                              )}
                            </Space>
                          </Space>
                        </Card>
                      </Col>
                    ))}
                  </Row>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Modal>
  );
}