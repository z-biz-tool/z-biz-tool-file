// 添加资料弹窗：三个通道，对应 future-brain material-add-modal 的 local/link/source：
// 1. 本地文件 —— 选文件或整个目录（目录导入会把子目录结构镜像成库内目录树）；
// 2. 语雀 —— 选仓库 → TOC 目录树勾选文档 → 拉正文导入；
// 3. 纯文本 —— 标题 + 内容直接登记为资料。
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Checkbox,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Tree,
  Typography,
} from "antd";
import type { DataNode } from "antd/es/tree";
import {
  FileAddOutlined,
  FolderAddOutlined,
  ImportOutlined,
} from "@ant-design/icons";
import {
  kbCategoryTree,
  kbConfigGet,
  kbImportLocal,
  kbRegisterText,
  kbYuqueImport,
  kbYuqueRepos,
  kbYuqueToc,
  type KbCategory,
  type KbConfigView,
  type YuqueRepo,
  type YuqueTocItem,
} from "./api";
import { buildTree, flattenFolders } from "./tree";

const { Text } = Typography;

interface Props {
  kbId: string;
  open: boolean;
  defaultCategoryId: string | null;
  onClose: () => void;
  onAdded: () => void;
}

export default function AddMaterialModal({
  kbId,
  open,
  defaultCategoryId,
  onClose,
  onAdded,
}: Props) {
  const { message: msgApi, modal } = AntdApp.useApp();
  const [tab, setTab] = useState("local");
  const [categories, setCategories] = useState<KbCategory[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(defaultCategoryId);
  const [busy, setBusy] = useState(false);

  // 本地文件
  const [picked, setPicked] = useState<{ path: string; size?: number; isDir: boolean }[]>([]);

  // 语雀
  const [config, setConfig] = useState<KbConfigView | null>(null);
  const [repos, setRepos] = useState<YuqueRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [namespace, setNamespace] = useState<string | null>(null);
  const [toc, setToc] = useState<YuqueTocItem[]>([]);
  const [tocLoading, setTocLoading] = useState(false);
  const [checkedDocKeys, setCheckedDocKeys] = useState<React.Key[]>([]);

  // 纯文本
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");

  useEffect(() => {
    if (!open) return;
    setCategoryId(defaultCategoryId);
    setPicked([]);
    setTab("local");
    kbCategoryTree(kbId)
      .then(setCategories)
      .catch((e) => msgApi.error(`加载目录失败: ${e}`));
    kbConfigGet()
      .then(setConfig)
      .catch(() => setConfig(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kbId, defaultCategoryId]);

  useEffect(() => {
    if (!open || tab !== "yuque" || repos.length > 0) return;
    setReposLoading(true);
    kbYuqueRepos()
      .then((list) => {
        setRepos(list);
        if (list.length === 0) {
          msgApi.info("语雀账号下没有可见的知识库");
        }
      })
      .catch((e) => msgApi.error(`${e}`))
      .finally(() => setReposLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  async function loadToc(ns: string) {
    setNamespace(ns);
    setToc([]);
    setCheckedDocKeys([]);
    if (!ns) return;
    setTocLoading(true);
    try {
      setToc(await kbYuqueToc(ns));
    } catch (e) {
      msgApi.error(`拉取目录失败: ${e}`);
    } finally {
      setTocLoading(false);
    }
  }

  const folderOptions = useMemo(
    () =>
      categories.length === 0
        ? [{ id: "", name: "根目录", path: [] as string[] }]
        : [{ id: "", name: "根目录", path: [] as string[] }, ...flattenFolders(buildTree(categories, []).roots)],
    [categories],
  );

  async function pickFiles() {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const selected = await openDialog({ multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setPicked(paths.map((p) => ({ path: p, isDir: false })));
  }

  async function pickDirectory() {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const selected = await openDialog({ directory: true });
    if (!selected) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;
    setPicked([{ path, isDir: true }]);
  }

  async function importLocal() {
    if (picked.length === 0) {
      msgApi.warning("请先选择要导入的文件或目录");
      return;
    }
    setBusy(true);
    try {
      const report = await kbImportLocal({
        kbId,
        categoryId: categoryId || null,
        paths: picked.map((p) => p.path),
      });
      const skippedCount = report.skipped.length;
      msgApi.success(
        `已登记 ${report.registered.length} 条${skippedCount ? `，跳过 ${skippedCount} 条` : ""}，解析任务已提交`,
      );
      if (report.skipped.length > 0) {
        modal.info({
          title: "部分文件被跳过",
          width: 520,
          content: (
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              {report.skipped.map((item, i) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <Text strong style={{ fontSize: 12 }}>{item.path}</Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>{item.reason}</Text>
                </div>
              ))}
            </div>
          ),
        });
      }
      onAdded();
      onClose();
    } catch (e) {
      msgApi.error(`导入失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const tocTree = useMemo<DataNode[]>(() => {
    const byParent = new Map<string, YuqueTocItem[]>();
    for (const item of toc) {
      const key = item.parent_uuid || "__root__";
      const list = byParent.get(key) || [];
      list.push(item);
      byParent.set(key, list);
    }
    const walk = (parentKey: string): DataNode[] =>
      (byParent.get(parentKey) || []).map((item) => ({
        key: item.uuid,
        title: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {item.title}
            {item.kind === "DOC" ? (
              <Tag style={{ fontSize: 10, lineHeight: "16px", marginRight: 0 }} bordered={false}>
                文档
              </Tag>
            ) : null}
          </span>
        ),
        children: walk(item.uuid),
      }));
    return walk("__root__");
  }, [toc]);

  const checkedDocs = useMemo(() => {
    const byUuid = new Map(toc.map((t) => [t.uuid, t]));
    const docs: { namespace: string; slug: string; title: string }[] = [];
    const collect = (keys: React.Key[]) => {
      for (const key of keys) {
        const item = byUuid.get(String(key));
        if (item && item.kind === "DOC" && item.url) {
          docs.push({ namespace: namespace!, slug: item.url, title: item.title });
        }
      }
    };
    collect(checkedDocKeys);
    return docs;
  }, [checkedDocKeys, toc, namespace]);

  async function importYuque() {
    if (!namespace || checkedDocs.length === 0) {
      msgApi.warning("请选择仓库并勾选要导入的文档");
      return;
    }
    setBusy(true);
    try {
      const report = await kbYuqueImport(kbId, categoryId || null, checkedDocs);
      msgApi.success(
        `已登记 ${report.registered.length} 篇语雀文档，正文拉取中（完成后自动显示「已解析」）`,
      );
      onAdded();
      onClose();
    } catch (e) {
      msgApi.error(`导入失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function importText() {
    if (!textTitle.trim() || !textContent.trim()) {
      msgApi.warning("标题和内容都不能为空");
      return;
    }
    setBusy(true);
    try {
      await kbRegisterText({
        kbId,
        categoryId: categoryId || null,
        title: textTitle.trim(),
        content: textContent,
      });
      msgApi.success("文本资料已登记");
      setTextTitle("");
      setTextContent("");
      onAdded();
      onClose();
    } catch (e) {
      msgApi.error(`登记失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const folderSelect = (
    <Select
      style={{ width: 220 }}
      size="small"
      placeholder="导入到（根目录）"
      allowClear
      value={categoryId ?? undefined}
      onChange={(v) => setCategoryId((v as string) || null)}
      options={folderOptions.map((f) => ({
        value: f.id || "",
        label: f.path.length > 0 ? `${f.path.join(" / ")}` : "根目录",
      }))}
    />
  );

  return (
    <Modal
      title="添加资料"
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: "100%" }} size={4}>
        {folderSelect}
      </Space>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "local",
            label: "本地文件",
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size={12}>
                <Space wrap>
                  <Button icon={<FileAddOutlined />} onClick={() => void pickFiles()}>
                    选择文件（可多选）
                  </Button>
                  <Button icon={<FolderAddOutlined />} onClick={() => void pickDirectory()}>
                    选择整个目录
                  </Button>
                </Space>
                {picked.length > 0 ? (
                  <div
                    style={{
                      border: "1px solid var(--ant-color-border-secondary)",
                      borderRadius: 8,
                      padding: "8px 12px",
                      maxHeight: 180,
                      overflowY: "auto",
                    }}
                  >
                    {picked.map((p) => (
                      <div key={p.path} style={{ fontSize: 12, marginBottom: 4 }}>
                        <Text strong>{p.path.split("/").pop()}</Text>
                        <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                          {p.isDir ? "目录（含子目录，结构会镜像到库内目录树）" : p.path}
                        </Text>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    全程本地解析，不联网：文本类（md/txt/代码…）直读；PDF/Word/PPT 走文本层；
                    xlsx 本地抽表；图片/扫描件走内嵌中文 OCR（首次约下载 20MB 模型，之后离线）。
                    同内容重复导入会按指纹跳过。
                  </Text>
                )}
                <Button
                  type="primary"
                  icon={<ImportOutlined />}
                  loading={busy}
                  disabled={picked.length === 0}
                  onClick={() => void importLocal()}
                >
                  导入并解析
                </Button>
              </Space>
            ),
          },
          {
            key: "yuque",
            label: "语雀",
            children:
              config && !config.yuque_token_set ? (
                <Alert
                  type="warning"
                  showIcon
                  message="尚未配置语雀 Token"
                  description="请先到工作台右上角「设置」里填写语雀个人访问令牌（语雀 → 个人设置 → Token），再回来导入。"
                />
              ) : (
                <Space direction="vertical" style={{ width: "100%" }} size={12}>
                  <Space wrap>
                    <Select
                      style={{ minWidth: 260 }}
                      placeholder={reposLoading ? "加载知识库中…" : "选择语雀知识库"}
                      loading={reposLoading}
                      value={namespace ?? undefined}
                      onChange={(v) => void loadToc(v as string)}
                      options={groupByScope(repos).map(([scope, list]) => ({
                        label: scope,
                        title: scope,
                        options: list.map((r) => ({ value: r.namespace, label: r.name })),
                      }))}
                      showSearch
                      optionFilterProp="label"
                    />
                    {tocLoading ? <Spin size="small" /> : null}
                  </Space>
                  {namespace && !tocLoading ? (
                    toc.length === 0 ? (
                      <Text type="secondary">该知识库没有目录内容</Text>
                    ) : (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <Checkbox
                            indeterminate={
                              checkedDocKeys.length > 0 &&
                              checkedDocKeys.length < toc.filter((t) => t.kind === "DOC").length
                            }
                            checked={
                              toc.some((t) => t.kind === "DOC") &&
                              checkedDocKeys.length === toc.filter((t) => t.kind === "DOC").length
                            }
                            onChange={(e) => {
                              if (e.target.checked) {
                                setCheckedDocKeys(
                                  toc.filter((t) => t.kind === "DOC").map((t) => t.uuid),
                                );
                              } else {
                                setCheckedDocKeys([]);
                              }
                            }}
                          >
                            全选文档（{toc.filter((t) => t.kind === "DOC").length} 篇）
                          </Checkbox>
                        </div>
                        <div
                          style={{
                            border: "1px solid var(--ant-color-border-secondary)",
                            borderRadius: 8,
                            padding: "6px 4px",
                            maxHeight: 260,
                            overflowY: "auto",
                          }}
                        >
                          <Tree
                            checkable
                            blockNode
                            treeData={tocTree}
                            checkedKeys={checkedDocKeys}
                            onCheck={(keys) => setCheckedDocKeys(keys as React.Key[])}
                          />
                        </div>
                      </>
                    )
                  ) : null}
                  <Button
                    type="primary"
                    icon={<ImportOutlined />}
                    loading={busy}
                    disabled={checkedDocs.length === 0}
                    onClick={() => void importYuque()}
                  >
                    导入所选 {checkedDocs.length > 0 ? `（${checkedDocs.length} 篇）` : ""}
                  </Button>
                </Space>
              ),
          },
          {
            key: "text",
            label: "纯文本",
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size={12}>
                <Input
                  placeholder="标题"
                  value={textTitle}
                  maxLength={200}
                  onChange={(e) => setTextTitle(e.target.value)}
                />
                <Input.TextArea
                  placeholder="正文内容（支持 Markdown）"
                  value={textContent}
                  autoSize={{ minRows: 8, maxRows: 16 }}
                  onChange={(e) => setTextContent(e.target.value)}
                />
                <Button
                  type="primary"
                  icon={<ImportOutlined />}
                  loading={busy}
                  onClick={() => void importText()}
                >
                  登记为资料
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </Modal>
  );
}

function groupByScope(repos: YuqueRepo[]): [string, YuqueRepo[]][] {
  const map = new Map<string, YuqueRepo[]>();
  for (const repo of repos) {
    const list = map.get(repo.scope) || [];
    list.push(repo);
    map.set(repo.scope, list);
  }
  return [...map.entries()];
}
