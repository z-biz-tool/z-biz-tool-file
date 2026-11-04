/**
 * 图书馆 app（活动栏第三个 app）。
 *
 * 三栏：左归纳 / 中书目 / 右阅读。
 *
 * 定位：它**不是**另一个文件浏览器，而是叠在本地文件树上的一层书目视图 ——
 * 文件还在原来的位置（右键「在 Finder 中显示」能到），图书馆只记「有哪些书、
 * 怎么归类、读到哪了」。所以这里所有的删除动作都只是「从图书馆移除」，
 * 磁盘上的文件分毫不动。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntdApp,
  Button,
  Input,
  Segmented,
  Select,
  theme,
  Tooltip,
  Typography,
} from "antd";
import {
  AppstoreOutlined,
  BarsOutlined,
  FolderAddOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import FacetSidebar from "./components/FacetSidebar";
import BookList, { type BookAction } from "./components/BookList";
import ReaderPane from "./components/ReaderPane";
import CollectionDialog from "./components/CollectionDialog";
import BookMetaDialog from "./components/BookMetaDialog";
import { libraryApi, type Collection, type LibraryEntry, type LibraryFacets } from "./libraryClient";
import { viewTitle, viewToFilter, type LibraryView } from "./facets";

const { Text } = Typography;

const SORT_OPTIONS = [
  { value: "added", label: "最近加入" },
  { value: "title", label: "书名" },
  { value: "author", label: "作者" },
  { value: "year", label: "出版年份" },
  { value: "rating", label: "评分" },
  { value: "lastRead", label: "最近阅读" },
];

export default function LibraryApp() {
  const { message, modal } = AntdApp.useApp();
  const { token } = theme.useToken();

  const [facets, setFacets] = useState<LibraryFacets | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [view, setView] = useState<LibraryView>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("added");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const [selected, setSelected] = useState<LibraryEntry | null>(null);
  const [readerOpen, setReaderOpen] = useState(true);

  const [collectionDialog, setCollectionDialog] = useState<{
    open: boolean;
    target: Collection | null;
  }>({ open: false, target: null });
  const [metaTarget, setMetaTarget] = useState<LibraryEntry | null>(null);

  const collections = useMemo(
    () => facets?.collections.map((c) => c.collection) ?? [],
    [facets],
  );
  const currentCollectionId = view.kind === "collection" ? view.id : undefined;

  // =============== 取数 ===============

  const refreshFacets = useCallback(async () => {
    try {
      setFacets(await libraryApi.facets());
    } catch (e) {
      message.error("读取归纳信息失败: " + String(e));
    }
  }, [message]);

  // 搜索用防抖：每敲一个字就查一次，几百本书时后端要读整份 JSON
  const searchRef = useRef<number | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    if (searchRef.current) window.clearTimeout(searchRef.current);
    searchRef.current = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => {
      if (searchRef.current) window.clearTimeout(searchRef.current);
    };
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    libraryApi
      .query(viewToFilter(view, { search: debouncedSearch, sort }))
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((e) => {
        if (!cancelled) message.error("查书失败: " + String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, debouncedSearch, sort, message]);

  useEffect(() => {
    void refreshFacets();
  }, [refreshFacets]);

  /** 改完数据之后统一走这里，保证「列表」和「侧栏计数」不会各说各话 */
  const reload = useCallback(async () => {
    await Promise.all([refreshFacets()]);
    setLoading(true);
    try {
      setEntries(await libraryApi.query(viewToFilter(view, { search: debouncedSearch, sort })));
    } catch (e) {
      message.error("刷新失败: " + String(e));
    } finally {
      setLoading(false);
    }
  }, [refreshFacets, view, debouncedSearch, sort, message]);

  // =============== 交互 ===============

  /**
   * 阅读器回写进度。
   *
   * 阅读器那边已经按 350ms 防抖，这里再加一道"变化小于半个百分点就不落库"：
   * 每翻一页都 invoke 一次会把整份 library.json 反复读写，几百本书时肉眼可见地拖。
   * 内存里的 entries / selected 同步改掉，所以列表上的进度条即时动，不必重查。
   */
  const lastWritten = useRef<Record<string, number>>({});
  const handleReadProgress = useCallback((entry: LibraryEntry, progress: number) => {
    const p = progress <= 0 ? 0.01 : Math.min(1, progress);
    const prev = lastWritten.current[entry.id];
    if (prev !== undefined && Math.abs(prev - p) < 0.005 && p < 1) return;
    lastWritten.current[entry.id] = p;

    const patch = { read_progress: p, last_read_at: Math.floor(Date.now() / 1000) };
    setEntries((list) => list.map((b) => (b.id === entry.id ? { ...b, ...patch } : b)));
    setSelected((s) => (s && s.id === entry.id ? { ...s, ...patch } : s));
    void libraryApi.setReadProgress(entry.id, p).catch(() => {
      // 写库失败不打断阅读：阅读器本地另存了一份位置，下次打开照样落回原处
    });
  }, []);

  const openEntry = useCallback(
    (entry: LibraryEntry) => {
      setSelected(entry);
      setReaderOpen(true);
      // 打开即标记「在读」：书是拿来看的，读到一半关掉再回来，
      // 「在读」这一档应该已经有它。已读完的不动。
      if ((entry.read_progress ?? 0) <= 0) {
        void libraryApi
          .setReadStatus(entry.id, "reading")
          .then(() => refreshFacets())
          .catch(() => {
            // 标记失败不该打断阅读
          });
      }
    },
    [refreshFacets],
  );

  const handleAction = useCallback(
    async (action: BookAction, entry: LibraryEntry) => {
      try {
        switch (action) {
          case "open-external":
            await invoke("open_with_default_app", { path: entry.path });
            break;
          case "reveal":
            await invoke("reveal_in_finder", { path: entry.path });
            break;
          case "toggle-favorite": {
            const fav = await libraryApi.toggleFavorite(entry.id);
            setSelected((s) => (s && s.id === entry.id ? { ...s, favorite: fav } : s));
            await reload();
            break;
          }
          case "mark-unread":
          case "mark-reading":
          case "mark-finished": {
            const status =
              action === "mark-unread"
                ? "unread"
                : action === "mark-reading"
                  ? "reading"
                  : "finished";
            await libraryApi.setReadStatus(entry.id, status);
            await reload();
            break;
          }
          case "edit-meta":
            setMetaTarget(entry);
            break;
          case "remove-from-collection":
            if (!currentCollectionId) break;
            modal.confirm({
              title: "从本图书集移除？",
              content: `「${entry.title}」会离开这个集，但它还在图书馆里，文件也不动。`,
              okText: "移除",
              cancelText: "取消",
              onOk: async () => {
                await libraryApi.removeFromCollection([entry.id], currentCollectionId);
                await reload();
              },
            });
            break;
          case "remove-entry":
            modal.confirm({
              title: "从图书馆移除？",
              content: `只删掉这条书目记录，「${entry.title}」这个文件还在原处，不会被删除。`,
              okText: "移除",
              cancelText: "取消",
              onOk: async () => {
                await libraryApi.removeEntry(entry.id);
                if (selected?.id === entry.id) setSelected(null);
                await reload();
              },
            });
            break;
        }
      } catch (e) {
        message.error(String(e));
      }
    },
    [currentCollectionId, modal, message, reload, selected?.id],
  );

  // =============== 图书集 ===============

  const submitCollection = useCallback(
    async (values: { name: string; description?: string; color?: string }) => {
      const target = collectionDialog.target;
      if (target) {
        await libraryApi.updateCollection(target.id, values);
        message.success("已保存");
      } else {
        const created = await libraryApi.createCollection(
          values.name,
          values.description,
          values.color,
        );
        message.success(`已创建「${created.name}」`);
        setView({ kind: "collection", id: created.id });
      }
      setCollectionDialog({ open: false, target: null });
      await reload();
    },
    [collectionDialog.target, message, reload],
  );

  const deleteCurrentCollection = useCallback(() => {
    if (view.kind !== "collection") return;
    const name = collections.find((c) => c.id === view.id)?.name ?? "这个图书集";
    modal.confirm({
      title: `删除「${name}」？`,
      content: "集里的书不会从图书馆消失，只是不再属于这个集。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await libraryApi.deleteCollection(view.id);
        setView({ kind: "all" });
        await reload();
      },
    });
  }, [view, collections, modal, reload]);

  // =============== 收书 ===============

  const addScanDir = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "选择书库目录" });
      if (typeof picked !== "string") return;
      setBusy(true);
      await libraryApi.addScanDir(picked);
      const stats = await libraryApi.scanBooks();
      await libraryApi.enrichMetadata(200);
      await reload();
      const total =
        stats && typeof stats === "object" && "total_library" in stats
          ? (stats as { total_library: number }).total_library
          : null;
      message.success(total != null ? `已收书，馆藏 ${total} 本` : "已收书");
    } catch (e) {
      message.error("收书失败: " + String(e));
    } finally {
      setBusy(false);
    }
  }, [message, reload]);

  const rescan = useCallback(async () => {
    setBusy(true);
    try {
      await libraryApi.scanBooks();
      const filled = await libraryApi.enrichMetadata(200);
      await reload();
      message.success(filled > 0 ? `已刷新书目，补全 ${filled} 条元数据` : "已刷新书目");
    } catch (e) {
      message.error("刷新失败: " + String(e));
    } finally {
      setBusy(false);
    }
  }, [message, reload]);

  // =============== 渲染 ===============

  return (
    <div style={{ height: "100%", display: "flex", minWidth: 0 }}>
      <div style={{ width: 216, flexShrink: 0, height: "100%" }}>
        <FacetSidebar
          facets={facets}
          view={view}
          onView={(v) => {
            setView(v);
            setSelected(null);
          }}
          onNewCollection={() => setCollectionDialog({ open: true, target: null })}
        />
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* 工具条 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            flexShrink: 0,
            flexWrap: "wrap",
          }}
        >
          <Text strong style={{ fontSize: 13 }}>
            {viewTitle(view, collections)}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {entries.length} 本
          </Text>

          <div style={{ flex: 1 }} />

          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
            placeholder="搜书名 / 作者 / 标签 / 系列"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 220 }}
          />
          <Select
            size="small"
            value={sort}
            onChange={setSort}
            options={SORT_OPTIONS}
            style={{ width: 104 }}
            aria-label="排序方式"
          />
          <Segmented
            size="small"
            value={viewMode}
            onChange={(v) => setViewMode(v as "grid" | "list")}
            options={[
              { value: "grid", icon: <AppstoreOutlined />, title: "封面墙" },
              { value: "list", icon: <BarsOutlined />, title: "列表" },
            ]}
            aria-label="视图切换"
          />
          {currentCollectionId && (
            <>
              <Button
                size="small"
                onClick={() => {
                  const target = collections.find((c) => c.id === currentCollectionId) ?? null;
                  setCollectionDialog({ open: true, target });
                }}
              >
                重命名
              </Button>
              <Button size="small" danger onClick={deleteCurrentCollection}>
                删除集
              </Button>
            </>
          )}
          <Tooltip title="重新扫描书库并补全元数据">
            <Button
              size="small"
              icon={<SyncOutlined />}
              aria-label="刷新书目"
              loading={busy}
              onClick={rescan}
            />
          </Tooltip>
          <Tooltip title="把某个目录下的书收进图书馆">
            <Button
              size="small"
              icon={<FolderAddOutlined />}
              aria-label="添加扫描目录"
              onClick={addScanDir}
            >
              添加目录
            </Button>
          </Tooltip>
          <Tooltip title="刷新">
            <Button size="small" icon={<ReloadOutlined />} aria-label="刷新" onClick={reload} />
          </Tooltip>
        </div>

        {/* 书目 */}
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <BookList
            entries={entries}
            loading={loading}
            selectedId={selected?.id ?? null}
            viewMode={viewMode}
            currentCollectionId={currentCollectionId}
            onSelect={openEntry}
            onAction={handleAction}
          />
        </div>
      </div>

      {readerOpen && (
        <div style={{ width: "46%", minWidth: 360, flexShrink: 0, height: "100%" }}>
          <ReaderPane
            entry={selected}
            onReadProgress={handleReadProgress}
            onClose={() => {
              setReaderOpen(false);
              setSelected(null);
            }}
            onOpenExternal={(e) => void handleAction("open-external", e)}
            onReveal={(e) => void handleAction("reveal", e)}
          />
        </div>
      )}

      <CollectionDialog
        open={collectionDialog.open}
        collection={collectionDialog.target}
        onCancel={() => setCollectionDialog({ open: false, target: null })}
        onSubmit={submitCollection}
      />

      <BookMetaDialog
        open={metaTarget !== null}
        entry={metaTarget}
        onCancel={() => setMetaTarget(null)}
        onSubmit={async (patch) => {
          if (!metaTarget) return;
          await libraryApi.updateMeta(metaTarget.id, patch);
          setMetaTarget(null);
          message.success("已保存");
          await reload();
        }}
      />
    </div>
  );
}
