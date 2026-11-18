// 资料工作台：左侧目录 + 条目混排树（状态徽标、右键菜单），右侧条目详情。
// 解析是后台任务 —— 有条目处于「解析中」时按 2.5s 轮询物料列表驱动徽标变化
// （对应 future-brain 的异步任务 + 前端轮询模型）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntdApp,
  Button,
  Empty,
  Input,
  Space,
  Spin,
  Tag,
  Tooltip,
  Tree,
  Typography,
} from "antd";
import type { DataNode } from "antd/es/tree";
import {
  ApiOutlined,
  CodeOutlined,
  CustomerServiceOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  GlobalOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  SyncOutlined,
  TableOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import type { KbCategory, KbMaterial, KbSummary } from "./api";
import {
  kbCategoryBindLocal,
  kbCategoryCreate,
  kbCategoryDelete,
  kbCategoryRename,
  kbCategoryUnbindLocal,
  kbMaterialDelete,
  kbMaterialList,
  kbParse,
  kbSyncLocalDir,
} from "./api";
import {
  buildTree,
  collectCategoryIds,
  deriveEntryState,
  deriveEntryType,
  ENTRY_STATE_META,
  type EntryType,
  type TreeNode,
} from "./tree";
import MaterialDetail from "./MaterialDetail";
import AddMaterialModal from "./AddMaterialModal";
import PromptModal, { type PromptState } from "./PromptModal";

const { Text } = Typography;

const TYPE_ICON: Record<EntryType, React.ReactNode> = {
  document: <FileTextOutlined />,
  table: <TableOutlined />,
  image: <PictureOutlined />,
  audio: <CustomerServiceOutlined />,
  video: <VideoCameraOutlined />,
  web: <GlobalOutlined />,
  code: <CodeOutlined />,
  json: <ApiOutlined />,
};

type CtxMenu =
  | { x: number; y: number; kind: "root" }
  | { x: number; y: number; kind: "category"; categoryId: string }
  | { x: number; y: number; kind: "material"; material: KbMaterial };

export default function MaterialsView({
  kb,
  reloadKey,
  focusMaterialId,
  onConsumedFocus,
  onStatsChange,
}: {
  kb: KbSummary;
  reloadKey: number;
  focusMaterialId: string | null;
  onConsumedFocus: () => void;
  onStatsChange: (stats: { material: number; parsed: number }) => void;
}) {
  const { message: msgApi, modal } = AntdApp.useApp();
  const [materials, setMaterials] = useState<KbMaterial[]>([]);
  const [categories, setCategories] = useState<KbCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [filter, setFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const treeWrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const cats = await import("./api").then((m) => m.kbCategoryTree(kb.id));
      const mats = await kbMaterialList(kb.id);
      setCategories(cats);
      setMaterials(mats);
      onStatsChange({
        material: mats.length,
        parsed: mats.filter((m) => m.parse_status === "parsed").length,
      });
    } catch (e) {
      msgApi.error(`加载资料失败: ${e}`);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kb.id]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  // 解析中的条目存在时轮询；全部离开 parsing 态即停。
  const hasParsing = materials.some((m) => m.parse_status === "parsing");
  useEffect(() => {
    if (!hasParsing) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [hasParsing, refresh]);

  // 检索/AI 命中跳转：定位条目并展开其目录
  useEffect(() => {
    if (!focusMaterialId) return;
    setSelectedMaterialId(focusMaterialId);
    const mat = materials.find((m) => m.id === focusMaterialId);
    if (mat?.category_id) {
      // 树的节点键是 `cat:<id>`，直接用裸 id 展开不到任何节点
      const key = `cat:${mat.category_id}`;
      setExpandedKeys((keys) => (keys.includes(key) ? keys : [...keys, key]));
    }
    onConsumedFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMaterialId]);

  const model = useMemo(() => buildTree(categories, materials), [categories, materials]);

  const treeData = useMemo<DataNode[]>(() => {
    const filterText = filter.trim().toLowerCase();

    const materialNode = (material: KbMaterial): DataNode => {
      const stateMeta = ENTRY_STATE_META[deriveEntryState(material.parse_status)];
      return {
        key: `mat:${material.id}`,
        isLeaf: true,
        icon: (
          <span style={{ fontSize: 13, color: "var(--ant-color-text-tertiary)" }}>
            {TYPE_ICON[deriveEntryType(material)]}
          </span>
        ),
        title: (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 230 }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {material.title}
            </span>
            <span style={{ flexShrink: 0 }}>
              {stateMeta.label === "已解析" ? (
                <Text type="success" style={{ fontSize: 11 }}>
                  已解析
                </Text>
              ) : (
                <Text
                  style={{
                    fontSize: 11,
                    color:
                      material.parse_status === "failed"
                        ? "var(--ant-color-error)"
                        : material.parse_status === "parsing"
                          ? "var(--ant-color-primary)"
                          : "var(--ant-color-text-quaternary)",
                  }}
                >
                  {stateMeta.label}
                </Text>
              )}
            </span>
          </span>
        ),
      };
    };

    const walk = (nodes: TreeNode[]): DataNode[] => {
      const out: DataNode[] = [];
      for (const node of nodes) {
        const entries = filterText
          ? node.entries.filter((e) => e.material.title.toLowerCase().includes(filterText))
          : node.entries;
        const children = walk(node.children);
        if (filterText && entries.length === 0 && children.length === 0) continue;
        out.push({
          key: `cat:${node.category.id}`,
          icon: (
            <span
              style={{
                color: node.category.local_path
                  ? "var(--ant-color-primary)"
                  : "var(--ant-color-warning)",
              }}
            >
              <FolderOutlined />
            </span>
          ),
          title: (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span>{node.category.name}</span>
              {node.category.local_path ? (
                <Tooltip title={`已绑定本地文件夹：${node.category.local_path}（右键可同步）`}>
                  <Tag
                    color="blue"
                    style={{ marginRight: 0, fontSize: 10, lineHeight: "16px" }}
                    bordered={false}
                  >
                    本地
                  </Tag>
                </Tooltip>
              ) : null}
              <Text type="secondary" style={{ fontSize: 11 }}>
                {node.count}
              </Text>
            </span>
          ),
          children: [...children, ...entries.map((e) => materialNode(e.material))],
        });
      }
      return out;
    };

    const roots = walk(model.roots);
    const unclassified = filterText
      ? model.unclassified.filter((e) =>
          e.material.title.toLowerCase().includes(filterText),
        )
      : model.unclassified;
    if (unclassified.length > 0 || !filterText) {
      roots.push({
        key: "cat:__unclassified__",
        icon: <FolderOutlined style={{ color: "var(--ant-color-text-quaternary)" }} />,
        title: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span>未分类</span>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {unclassified.length}
            </Text>
          </span>
        ),
        children: unclassified.map((e) => materialNode(e.material)),
      });
    }
    return roots;
  }, [model, filter]);

  const selectedMaterial = materials.find((m) => m.id === selectedMaterialId) || null;

  async function handleParse(material: KbMaterial) {
    try {
      await kbParse(material.id);
      msgApi.success(`「${material.title}」解析任务已提交`);
      void refresh();
    } catch (e) {
      msgApi.error(`${e}`);
    }
  }

  function handleDeleteMaterial(material: KbMaterial) {
    modal.confirm({
      title: `删除「${material.title}」？`,
      content: "将同时删除已拷入的原件副本与解析稿。源文件不受影响。",
      okText: "删除",
      okButtonProps: { danger: true },
      autoFocusButton: "cancel",
      onOk: async () => {
        try {
          await kbMaterialDelete(material.id);
          if (selectedMaterialId === material.id) setSelectedMaterialId(null);
          msgApi.success("已删除");
          void refresh();
        } catch (e) {
          // 不能 return Promise.reject()：antd v6 会把 onOk 的拒绝重新抛出，
          // 变成未处理的 Promise 拒绝（曾经把整个窗口糊成错误页）。
          msgApi.error(`${e}`);
        }
      },
    });
  }

  function promptNewCategory(parentId: string | null) {
    setPrompt({
      title: parentId ? "新建子目录" : "新建根目录",
      placeholder: "目录名",
      onOk: async (name) => {
        const created = await kbCategoryCreate({ kbId: kb.id, parentId, name });
        setExpandedKeys((keys) => [
          ...keys,
          ...(created.parent_id ? [created.parent_id] : [created.id]).map((id) => `cat:${id}`),
        ]);
        msgApi.success(`目录「${created.name}」已创建`);
        void refresh();
      },
    });
  }

  function promptRenameCategory(category: KbCategory) {
    setPrompt({
      title: "重命名目录",
      defaultValue: category.name,
      onOk: async (name) => {
        if (name === category.name) return;
        await kbCategoryRename(category.id, name);
        msgApi.success("已重命名");
        void refresh();
      },
    });
  }

  function handleDeleteCategory(category: KbCategory, count: number) {
    modal.confirm({
      title: `删除目录「${category.name}」？`,
      content: `子目录将一并删除，目录下的 ${count} 条资料会移入「未分类」（内容不丢）。`,
      okText: "删除",
      okButtonProps: { danger: true },
      autoFocusButton: "cancel",
      onOk: async () => {
        try {
          await kbCategoryDelete(kb.id, category.id);
          msgApi.success("目录已删除");
          void refresh();
        } catch (e) {
          msgApi.error(`${e}`);
        }
      },
    });
  }

  /** 绑定本地文件夹：选一个本地目录挂到这个目录节点上，之后可增量同步。 */
  async function bindLocalFolder(category: KbCategory) {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const picked = await openDialog({ directory: true, title: "选择要绑定的本地文件夹" });
      const localPath = Array.isArray(picked) ? picked[0] : picked;
      if (!localPath) return;
      await kbCategoryBindLocal(category.id, localPath);
      msgApi.success(`已绑定本地文件夹：${localPath}`);
      await syncLocalDir(category);
      void refresh();
    } catch (e) {
      msgApi.error(`${e}`);
    }
  }

  async function syncLocalDir(category: KbCategory) {
    try {
      const report = await kbSyncLocalDir(category.id);
      msgApi.success(
        `同步完成：新增 ${report.added}、更新 ${report.updated}、未变 ${report.unchanged}` +
          (report.removed ? `、源文件已移除 ${report.removed}` : "") +
          (report.failed ? `、失败 ${report.failed}` : ""),
      );
      void refresh();
    } catch (e) {
      msgApi.error(`${e}`);
    }
  }

  async function unbindLocalFolder(category: KbCategory) {
    try {
      await kbCategoryUnbindLocal(category.id);
      msgApi.success("已解除绑定（已导入的资料保留）");
      void refresh();
    } catch (e) {
      msgApi.error(`${e}`);
    }
  }

  function onCtxClick(key: string) {
    if (!ctxMenu) return;
    const menu = ctxMenu;
    setCtxMenu(null);
    if (menu.kind === "category") {
      const node = findNode(model.roots, menu.categoryId);
      if (!node) return;
      if (key === "new-sub") promptNewCategory(node.category.id);
      if (key === "add-material") {
        setImportTarget(node.category.id);
        setAddOpen(true);
      }
      if (key === "rename") promptRenameCategory(node.category);
      if (key === "delete") handleDeleteCategory(node.category, node.count);
      if (key === "bind-local") void bindLocalFolder(node.category);
      if (key === "sync-local") void syncLocalDir(node.category);
      if (key === "unbind-local") void unbindLocalFolder(node.category);
      return;
    }
    if (menu.kind === "material") {
      if (key === "parse") void handleParse(menu.material);
      if (key === "delete") handleDeleteMaterial(menu.material);
      return;
    }
    if (key === "new-root") promptNewCategory(null);
    if (key === "add-material") {
      setImportTarget(null);
      setAddOpen(true);
    }
  }

  // 首次加载默认展开全部目录（小库全展开更直观；用户手动折叠后不再打扰）
  useEffect(() => {
    if (loading) return;
    setExpandedKeys((keys) =>
      keys.length > 0
        ? keys
        : [
            ...collectCategoryIds(model.roots).map((id) => `cat:${id}`),
            // 未分类节点是合成节点，没有 category id，要单独给树键
            "cat:__unclassified__",
          ],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, model]);

  return (
    <div style={{ height: "100%", display: "flex", gap: 12, minHeight: 0 }}>
      {/* 左：目录/条目混排树 */}
      <div
        ref={treeWrapRef}
        style={{
          width: 320,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          minHeight: 0,
        }}
      >
        <Space.Compact style={{ flexShrink: 0 }}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            style={{ flexGrow: 1 }}
            onClick={() => {
              setImportTarget(null);
              setAddOpen(true);
            }}
          >
            添加资料
          </Button>
          <Tooltip title="新建根目录">
            <Button icon={<FolderAddOutlined />} aria-label="新建根目录" onClick={() => promptNewCategory(null)} />
          </Tooltip>
          <Tooltip title="新建目录并绑定本地文件夹（之后可一键同步）">
            <Button
              icon={<FolderOpenOutlined />}
              aria-label="新建目录并绑定本地文件夹"
              onClick={() => {
                // 先建一个目录，再立刻绑定本地文件夹：一次操作完成「目录 ← 本地文件夹」
                setPrompt({
                  title: "新建目录并绑定本地文件夹",
                  placeholder: "目录名（稍后可改）",
                  onOk: async (name) => {
                    const created = await kbCategoryCreate({ kbId: kb.id, parentId: null, name });
                    setExpandedKeys((keys) => [...keys, created.id]);
                    void refresh();
                    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
                    const picked = await openDialog({ directory: true, title: "选择要绑定的本地文件夹" });
                    const localPath = Array.isArray(picked) ? picked[0] : picked;
                    if (!localPath) return;
                    await kbCategoryBindLocal(created.id, localPath);
                    msgApi.success(`已绑定本地文件夹：${localPath}`);
                    await syncLocalDir(created);
                    void refresh();
                  },
                });
              }}
            />
          </Tooltip>
          <Tooltip title="刷新列表">
            <Button icon={<ReloadOutlined />} aria-label="刷新资料列表" onClick={() => void refresh()} />
          </Tooltip>
        </Space.Compact>
        <Input.Search
          placeholder="按标题过滤"
          allowClear
          size="small"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flexShrink: 0 }}
        />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            border: "1px solid var(--ant-color-border-secondary)",
            borderRadius: 8,
            padding: "6px 4px",
          }}
        >
          {loading ? (
            <div style={{ display: "flex", justifyContent: "center", paddingTop: 40 }}>
              <Spin />
            </div>
          ) : treeData.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有资料"
              style={{ paddingTop: 40 }}
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
                导入第一份资料
              </Button>
            </Empty>
          ) : (
            <Tree
              showIcon
              blockNode
              treeData={treeData}
              expandedKeys={expandedKeys}
              onExpand={(keys) => setExpandedKeys(keys)}
              selectedKeys={selectedMaterialId ? [`mat:${selectedMaterialId}`] : []}
              onSelect={(keys) => {
                const key = String(keys[0] ?? "");
                if (key.startsWith("mat:")) {
                  setSelectedMaterialId(key.slice(4));
                }
              }}
              onRightClick={({ event, node }) => {
                event.preventDefault();
                event.stopPropagation();
                const key = String(node.key);
                const rect = (event.target as HTMLElement).getBoundingClientRect();
                const wrapRect = treeWrapRef.current?.getBoundingClientRect();
                const x = rect.left - (wrapRect?.left ?? 0) + 8;
                const y = rect.top - (wrapRect?.top ?? 0) + rect.height;
                if (key.startsWith("cat:")) {
                  const id = key.slice(4);
                  if (id === "__unclassified__") {
                    setCtxMenu({ x, y, kind: "root" });
                  } else {
                    setCtxMenu({ x, y, kind: "category", categoryId: id });
                  }
                } else if (key.startsWith("mat:")) {
                  const material = materials.find((m) => m.id === key.slice(4));
                  if (material) setCtxMenu({ x, y, kind: "material", material });
                }
              }}
            />
          )}
        </div>
        {ctxMenu && (
          <div
            style={{ position: "fixed", inset: 0, zIndex: 1000 }}
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          >
            <div
              style={{
                position: "absolute",
                left: ctxMenu.x,
                top: ctxMenu.y,
                background: "var(--ant-color-bg-elevated)",
                border: "1px solid var(--ant-color-border-secondary)",
                borderRadius: 8,
                boxShadow: "var(--ant-box-shadow-secondary)",
                padding: 4,
                minWidth: 150,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {ctxMenu.kind === "category" && (() => {
                const node = ctxMenu.categoryId ? findNode(model.roots, ctxMenu.categoryId) : null;
                const bound = node?.category.local_path;
                return (
                  <>
                    <CtxItem icon={<FolderAddOutlined />} label="新建子目录" onClick={() => onCtxClick("new-sub")} />
                    <CtxItem icon={<PlusOutlined />} label="导入到此目录" onClick={() => onCtxClick("add-material")} />
                    <CtxDivider />
                    {bound ? (
                      <>
                        <CtxItem icon={<SyncOutlined />} label="同步此目录" onClick={() => onCtxClick("sync-local")} />
                        <CtxItem icon={<FolderOpenOutlined />} label="更换本地文件夹" onClick={() => onCtxClick("bind-local")} />
                        <CtxItem icon={<DeleteOutlined />} label="解除本地绑定" onClick={() => onCtxClick("unbind-local")} />
                      </>
                    ) : (
                      <CtxItem icon={<FolderOpenOutlined />} label="绑定本地文件夹" onClick={() => onCtxClick("bind-local")} />
                    )}
                    <CtxDivider />
                    <CtxItem icon={<EditOutlined />} label="重命名" onClick={() => onCtxClick("rename")} />
                    <CtxItem danger icon={<DeleteOutlined />} label="删除目录" onClick={() => onCtxClick("delete")} />
                  </>
                );
              })()}
              {ctxMenu.kind === "material" && (
                <>
                  <CtxItem
                    icon={<ReloadOutlined />}
                    label={ctxMenu.material.parse_status === "parsed" ? "重新解析" : "解析"}
                    onClick={() => onCtxClick("parse")}
                  />
                  <CtxDivider />
                  <CtxItem danger icon={<DeleteOutlined />} label="删除条目" onClick={() => onCtxClick("delete")} />
                </>
              )}
              {ctxMenu.kind === "root" && (
                <>
                  <CtxItem icon={<FolderAddOutlined />} label="新建根目录" onClick={() => onCtxClick("new-root")} />
                  <CtxItem icon={<PlusOutlined />} label="导入资料" onClick={() => onCtxClick("add-material")} />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 右：条目详情 */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          border: "1px solid var(--ant-color-border-secondary)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {selectedMaterial ? (
          <MaterialDetail
            key={selectedMaterial.id}
            materialId={selectedMaterial.id}
            onChanged={() => void refresh()}
          />
        ) : (
          <Empty style={{ paddingTop: 100 }} description="在左侧选择一个条目查看解析稿" />
        )}
      </div>

      <AddMaterialModal
        kbId={kb.id}
        open={addOpen}
        defaultCategoryId={importTarget}
        onClose={() => {
          setAddOpen(false);
          setImportTarget(null);
        }}
        onAdded={() => void refresh()}
      />

      <PromptModal state={prompt} onClose={() => setPrompt(null)} />
    </div>
  );
}

function CtxItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 13,
        color: danger ? "var(--ant-color-error)" : "var(--ant-color-text)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--ant-color-fill-tertiary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {icon}
      {label}
    </div>
  );
}

function CtxDivider() {
  return (
    <div
      style={{
        height: 1,
        margin: "4px 6px",
        background: "var(--ant-color-border-secondary)",
      }}
    />
  );
}

function findNode(nodes: TreeNode[], categoryId: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.category.id === categoryId) return node;
    const found = findNode(node.children, categoryId);
    if (found) return found;
  }
  return undefined;
}
