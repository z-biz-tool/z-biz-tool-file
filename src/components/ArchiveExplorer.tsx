/**
 * 统一归档浏览器：一个组件吃掉 zip / 7z / rar / cab / tar 全家。
 *
 * 替掉原来那两套 —— `ZipBrowser` 只会看 zip（`list_zip_contents`），`ArchiveManager`
 * 是另一套"压缩/解压"表单，两边互不知情，于是同一个应用里"打开压缩包"有两个入口、
 * 两种交互、两套后端命令。现在统一走 `archive_*` 那一组 job 命令：列举是同步的
 * （读文件头 + 目录表，7 GB 的 RAR5 也就几百毫秒），解压/压缩/校验全是后台任务，
 * 进度落在右下角的 `ArchiveJobPanel`，关掉这个窗口也照样跑、照样能取消。
 *
 * 三条刻意的取舍：
 * - **能力驱动渲染**，不做"灰掉一排按钮"。rar 不能追加就不出"添加文件"这一项，
 *   不支持校验就不出"校验完整性"——见 [[feedback-ui-fewer-buttons]]。
 * - **解压前先探重名**（`archive_conflicts`），拿到结果再决定覆盖策略。引擎是同步
 *   阻塞的，解压到一半弹窗问"要不要覆盖"会把整条任务停在那儿。
 * - **`stripRoot` 恒为 false**，和 7-Zip 的"解压到 xxx\\"一致：目标目录名已经提供了
 *   一层壳，再剥掉归档里的顶层目录，用户会在一堆散文件里找不到原来的结构。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Alert,
  App as AntdApp,
  Breadcrumb,
  Button,
  Descriptions,
  Dropdown,
  Input,
  Modal,
  Radio,
  Space,
  Spin,
  Table,
  Tag,
  theme,
  Tooltip,
  Typography,
} from "antd";
import type { MenuProps, TableColumnsType } from "antd";
import {
  ArrowLeftOutlined,
  ExportOutlined,
  FileAddOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  LockOutlined,
  MoreOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { formatFileSize, formatTime } from "../stores/fileStore";
import { parentOfPath } from "../utils/parentDir";
import { getFileTypeVisual } from "../utils/fileTypeIcon";
import {
  archiveBreadcrumbs,
  buildArchiveTree,
  childrenAt,
  compareByName,
  conflictMessage,
  describeArchiveError,
  fsBaseName,
  joinFsPath,
  packedSizeKnown,
  searchEntries,
  type ArchiveEntry,
  type ArchiveInfo,
  type ArchiveNode,
  type ConflictReport,
  type CreateOptions,
  type ExtractOptions,
  type Overwrite,
  type ProbeResult,
} from "../utils/archiveModel";

const { Text, Paragraph } = Typography;

export interface ArchiveExplorerProps {
  open: boolean;
  onClose: () => void;
  archivePath: string | null;
  /** 当前浏览的宿主机目录，"解压到当前文件夹"的落点 */
  currentPath: string;
  /** 解压任务起来之后调用，让文件列表把新建的目录显示出来 */
  onRefresh: () => void;
}

/** 表格的一行。浏览模式来自树节点，搜索模式来自扁平条目，两者归一到这个形状。 */
interface Row {
  key: string;
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  packed: number;
  modified: number;
  method: string;
  encrypted: boolean;
  comment: string;
  symlinkTarget: string;
}

function nodeToRow(n: ArchiveNode): Row {
  return {
    key: n.path,
    name: n.name,
    path: n.path,
    isDir: n.isDir,
    size: n.size,
    packed: n.packed,
    modified: n.modified,
    method: n.method,
    encrypted: n.encrypted,
    comment: n.comment,
    symlinkTarget: n.symlinkTarget,
  };
}

function entryToRow(e: ArchiveEntry): Row {
  return {
    key: e.path,
    name: e.name,
    path: e.path,
    isDir: e.isDir,
    size: e.size,
    packed: e.packed,
    modified: e.modified,
    method: e.method,
    encrypted: e.encrypted,
    comment: e.comment,
    symlinkTarget: e.symlinkTarget,
  };
}

/** 目录永远排在文件前面。表格每一列的 sorter 都以它打头，否则一按大小排序文件夹就沉底了。 */
function dirFirst(a: { isDir: boolean }, b: { isDir: boolean }): number {
  if (a.isDir === b.isDir) return 0;
  return a.isDir ? -1 : 1;
}

const OVERWRITE_LABEL: Record<Overwrite, string> = {
  skip: "跳过重名的",
  overwrite: "覆盖",
  rename: "保留两者",
};

export default function ArchiveExplorer({
  open,
  onClose,
  archivePath,
  currentPath,
  onRefresh,
}: ArchiveExplorerProps) {
  const { token } = theme.useToken();
  const { message, modal } = AntdApp.useApp();

  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [info, setInfo] = useState<ArchiveInfo | null>(null);
  const [loading, setLoading] = useState(false);

  // 密码只活在这次打开里，不进任何持久化存储
  const [password, setPassword] = useState("");
  const [askPassword, setAskPassword] = useState(false);
  const [passwordNote, setPasswordNote] = useState("");
  /** 已经验证过的密码。用 ref 而不是 state：它不参与渲染，而加载流程要读它。 */
  const pwRef = useRef<string | null>(null);
  const loadedPathRef = useRef<string | null>(null);

  const [dir, setDir] = useState("");
  const [query, setQuery] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [propsOpen, setPropsOpen] = useState(false);
  const [working, setWorking] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);

  const caps = info?.caps ?? probe?.caps ?? null;
  // rar / cab / tar 压根不报压缩后大小（后端在 packed 上填 0 表示"格式没给"）。
  // 标题上的"压缩率"和属性页因此都没得说 —— 照实算会显示 0%，
  // 而用户拿 7-Zip 打开同一个 RAR 看到的是 78%
  const packedTotalKnown = info ? packedSizeKnown(info) : false;
  // 条目那一列另有一个独立的失效条件：solid 的 7z **总量**是真的（上面那个判据过得去），
  // 但字典在条目之间共享，单条的 packed 只能是 0。只判总量的话这一列照样渲染，
  // 然后清一色 0 B，看着像包坏了
  const packedPerEntryKnown = packedTotalKnown && !info?.solid;

  const load = useCallback(
    async (path: string, pw: string | null) => {
      setLoading(true);
      try {
        const data = await invoke<ArchiveInfo>("archive_info", { path, password: pw });
        setInfo(data);
        setAskPassword(false);
      } catch (err) {
        const f = describeArchiveError(err);
        setInfo(null);
        if (f.needPassword || f.badPassword) {
          pwRef.current = null;
          setAskPassword(true);
          setPasswordNote(
            f.badPassword
              ? "密码不对，请重试。"
              : f.encryptedHeaders
                ? "这个压缩包连文件名都加密了：不给密码连目录都列不出来。"
                : "这个压缩包需要密码才能读取内容。",
          );
        } else {
          message.error(f.message);
        }
      } finally {
        setLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    if (!open || !archivePath) return;
    let alive = true;

    // 换了归档就丢掉上一个的密码，否则会拿旧密码去撞新包，得到一句没头没脑的"密码错误"
    if (loadedPathRef.current !== archivePath) {
      loadedPathRef.current = archivePath;
      pwRef.current = null;
    }
    setDir("");
    setQuery("");
    setSelectedKeys([]);
    setPassword("");
    setAskPassword(false);
    setPropsOpen(false);

    (async () => {
      try {
        // probe 只读文件头几百字节，且在"连列表都要密码"的情况下依然能给出格式与能力，
        // 所以先跑它：即使 info 失败，工具栏也知道该渲染什么
        const p = await invoke<ProbeResult>("archive_probe", { path: archivePath });
        if (!alive) return;
        setProbe(p);
      } catch (err) {
        if (alive) setProbe(null);
      }
      if (alive) await load(archivePath, pwRef.current);
    })();

    return () => {
      alive = false;
    };
  }, [open, archivePath, load]);

  // 关掉时清干净：下次打开另一个包不能先闪一眼上一个的内容
  useEffect(() => {
    if (open) return;
    setInfo(null);
    setProbe(null);
    setAskPassword(false);
    setSelectedKeys([]);
  }, [open]);

  // 焦点要落在列表容器上，Backspace / Enter 这两个键才有地方冒泡。
  // 要密码的时候别抢焦点，否则光标刚从密码框里被拽走。
  useEffect(() => {
    if (open && !askPassword) listRef.current?.focus();
  }, [open, askPassword, info]);

  const tree = useMemo(() => (info ? buildArchiveTree(info.entries) : []), [info]);

  const searching = query.trim().length > 0;

  const rows = useMemo<Row[]>(() => {
    if (!info) return [];
    if (searching) return searchEntries(info.entries, query).map(entryToRow);
    return childrenAt(tree, dir).map(nodeToRow);
  }, [info, searching, query, tree, dir]);

  /** "解压到 xxx\" 里那个 xxx，由后端按格式算（`movie.tar.gz` → `movie.tar`） */
  const extractDirName = probe?.extractDirName ?? (archivePath ? fsBaseName(archivePath) : "");

  const siblingExtractDir = useMemo(() => {
    if (!archivePath || extractDirName.length === 0) return currentPath;
    return joinFsPath(parentOfPath(archivePath), extractDirName);
  }, [archivePath, extractDirName, currentPath]);

  /**
   * 重名了才问；没重名就一声不响地解。
   *
   * 三个选项与后端 `Overwrite` 一字不差（snake_case，是整套 camelCase 里唯一的例外）。
   * 默认"保留两者"——悄悄盖掉用户已有的文件是文件管理器里最贵的意外。
   */
  const askOverwrite = useCallback(
    (report: ConflictReport, destName: string): Promise<Overwrite | null> =>
      new Promise((resolve) => {
        let picked: Overwrite = "rename";
        modal.confirm({
          title: "目标位置有同名文件",
          icon: <InfoCircleOutlined />,
          content: (
            <div>
              <Paragraph style={{ marginBottom: 10 }}>
                {conflictMessage(report, destName)}
              </Paragraph>
              <Radio.Group
                defaultValue="rename"
                onChange={(e) => {
                  picked = e.target.value as Overwrite;
                }}
                options={(["rename", "overwrite", "skip"] as Overwrite[]).map((v) => ({
                  label: OVERWRITE_LABEL[v],
                  value: v,
                }))}
              />
              <div style={{ marginTop: 10, fontSize: 12, color: token.colorTextTertiary }}>
                目标：{destName}
              </div>
            </div>
          ),
          okText: "开始解压",
          cancelText: "取消",
          onOk: () => resolve(picked),
          onCancel: () => resolve(null),
        });
      }),
    [modal, token.colorTextTertiary],
  );

  /**
   * 报"需要密码"是所有归档操作的共同出口：不是弹一句错就完事，而是把密码条亮出来，
   * 让用户在原地重试。加密头的包连列表都没有，这时候光有错误文字是不够的。
   */
  const handleFailure = useCallback(
    (err: unknown): boolean => {
      const f = describeArchiveError(err);
      if (f.needPassword || f.badPassword) {
        pwRef.current = null;
        setAskPassword(true);
        setPasswordNote(
          f.badPassword ? "密码不对，请重试。" : "这一步需要密码。",
        );
        return true;
      }
      message.error(f.message);
      return false;
    },
    [message],
  );

  const extractTo = useCallback(
    async (dest: string, entries: string[] | null) => {
      if (!archivePath) return;
      const options: ExtractOptions = {
        entries,
        password: pwRef.current,
        overwrite: "rename",
        // 半截文件也留着：一个大包解到 99% 出一次 CRC 错，全丢掉比留个坏文件更亏
        keepBroken: true,
        stripRoot: false,
        flatten: false,
        includeChildren: true,
      };

      setWorking(true);
      let report: ConflictReport;
      try {
        report = await invoke<ConflictReport>("archive_conflicts", {
          path: archivePath,
          dest,
          options,
        });
      } catch (err) {
        setWorking(false);
        handleFailure(err);
        return;
      }

      let overwrite: Overwrite = "rename";
      if (report.total > 0) {
        const picked = await askOverwrite(report, dest);
        if (picked === null) {
          setWorking(false);
          return;
        }
        overwrite = picked;
      }

      try {
        await invoke<string>("archive_extract", {
          path: archivePath,
          dest,
          options: { ...options, overwrite },
        });
        message.success(
          report.total > 0
            ? `已开始解压，重名的按「${OVERWRITE_LABEL[overwrite]}」处理，进度见右下角`
            : "已开始解压，进度见右下角",
        );
        onRefresh();
      } catch (err) {
        handleFailure(err);
      } finally {
        setWorking(false);
      }
    },
    [archivePath, askOverwrite, handleFailure, message, onRefresh],
  );

  const extractSelectedOrAll = useCallback(
    (dest: string) => {
      void extractTo(dest, selectedKeys.length > 0 ? selectedKeys : null);
    },
    [extractTo, selectedKeys],
  );

  const pickDestAndExtract = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择解压目标目录",
        defaultPath: currentPath || undefined,
      });
      if (picked) extractSelectedOrAll(picked as string);
    } catch (err) {
      handleFailure(err);
    }
  }, [currentPath, extractSelectedOrAll, handleFailure]);

  const openEntry = useCallback(
    async (entryPath: string) => {
      if (!archivePath) return;
      try {
        await invoke<string>("archive_open_entry", {
          path: archivePath,
          entry: entryPath,
          password: pwRef.current,
        });
        message.success("正在解出并打开，进度见右下角");
      } catch (err) {
        handleFailure(err);
      }
    },
    [archivePath, handleFailure, message],
  );

  const activate = useCallback(
    (row: Row) => {
      if (row.isDir) {
        setDir(row.path);
        setQuery("");
        setSelectedKeys([]);
        return;
      }
      void openEntry(row.path);
    },
    [openEntry],
  );

  const goUp = useCallback(() => {
    setQuery("");
    setDir((d) => {
      if (d.length === 0) return d;
      const i = d.lastIndexOf("/");
      return i < 0 ? "" : d.slice(0, i);
    });
    setSelectedKeys([]);
  }, []);

  const runTest = useCallback(async () => {
    if (!archivePath) return;
    try {
      await invoke<string>("archive_test", { path: archivePath, password: pwRef.current });
      message.success("已开始校验，进度见右下角");
    } catch (err) {
      handleFailure(err);
    }
  }, [archivePath, handleFailure, message]);

  const addFiles = useCallback(async () => {
    if (!archivePath || !info) return;
    try {
      const picked = await openDialog({
        multiple: true,
        directory: false,
        title: "选择要追加进压缩包的文件",
        defaultPath: currentPath || undefined,
      });
      if (!picked) return;
      const sources = Array.isArray(picked) ? picked : [picked];
      // 追加沿用原包的格式与密码；等级/算法留空让后端取默认（zip::add 里 level 缺省 6）
      const options: CreateOptions = {
        format: info.format,
        level: null,
        method: null,
        password: pwRef.current,
        encryptHeader: false,
        solid: false,
        comment: null,
        volumeSize: null,
        storeFullPath: false,
        excludePatterns: [],
      };
      await invoke<string>("archive_add", { archive: archivePath, sources, options });
      message.success(`已开始追加 ${sources.length} 项，进度见右下角`);
      onRefresh();
    } catch (err) {
      handleFailure(err);
    }
  }, [archivePath, currentPath, handleFailure, info, message, onRefresh]);

  const reveal = useCallback(() => {
    if (!archivePath) return;
    invoke("reveal_in_finder", { path: archivePath }).catch((err) =>
      message.error(`在文件管理器中显示失败: ${err}`),
    );
  }, [archivePath, message]);

  const submitPassword = useCallback(() => {
    if (!archivePath) return;
    const pw = password;
    pwRef.current = pw.length > 0 ? pw : null;
    void load(archivePath, pwRef.current);
  }, [archivePath, load, password]);

  /**
   * 容器级按键：Backspace 上一级、Enter 打开。
   *
   * 两条都要 `preventDefault()`：全局快捷键那层（`useKeyboardShortcuts`）会在
   * `e.defaultPrevented` 时让路，不挡住的话一次 Enter 既打开归档里的文件、又触发
   * "打开选中项"。焦点在输入框里时整段跳过——搜索框里的 Backspace 是删字符。
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "Backspace") {
      e.preventDefault();
      goUp();
      return;
    }
    // Enter 只处理"选中了恰好一项"：多选时 Enter 该干什么并不明确（解压？逐个打开？），
    // 猜错就是一次误操作，什么都不做反而是对的
    if (e.key === "Enter" && selectedKeys.length === 1) {
      const row = rows.find((r) => r.path === selectedKeys[0]);
      if (!row) return;
      e.preventDefault();
      activate(row);
    }
  };

  const columns = useMemo<TableColumnsType<Row>>(() => {
    const nameColumn: TableColumnsType<Row>[number] = {
      title: "名称",
      dataIndex: "name",
      key: "name",
      ellipsis: true,
      sorter: (a, b) => dirFirst(a, b) || compareByName(a, b),
      defaultSortOrder: "ascend",
      render: (_: unknown, r: Row) => {
        const visual = getFileTypeVisual(r.name, r.isDir);
        const label = r.symlinkTarget ? `${r.name} → ${r.symlinkTarget}` : r.name;
        return (
          <Space size={6} style={{ minWidth: 0 }}>
            <span style={{ color: visual.color, display: "inline-flex" }}>
              {r.isDir ? <FolderOpenOutlined /> : visual.icon}
            </span>
            <Tooltip title={searching ? r.path : label} mouseEnterDelay={0.5}>
              <span>{label}</span>
            </Tooltip>
            {r.encrypted && (
              <Tooltip title="已加密">
                <LockOutlined style={{ color: token.colorWarning, fontSize: 12 }} />
              </Tooltip>
            )}
            {r.comment && (
              <Tooltip title={r.comment}>
                <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
              </Tooltip>
            )}
          </Space>
        );
      },
    };

    const sizeColumn: TableColumnsType<Row>[number] = {
      title: "大小",
      dataIndex: "size",
      key: "size",
      width: 100,
      align: "right",
      sorter: (a, b) => dirFirst(a, b) || a.size - b.size,
      render: (size: number) => formatFileSize(size),
    };

    // 这一列在 rar / cab / tar 上整列都是"格式没报"，在 solid 的 7z 上整列都是
    // "共享字典，单条没有意义"。两种情况都整列不渲染：一列清一色的破折号只是占地方，
    // 还会让人以为包坏了。目录也不显示（它的 size 是子树合计，packed 更是无从谈起）。
    const packedColumn: TableColumnsType<Row>[number] = {
      title: "压缩后",
      dataIndex: "packed",
      key: "packed",
      width: 100,
      align: "right",
      sorter: (a, b) => dirFirst(a, b) || a.packed - b.packed,
      render: (packed: number, r: Row) => (r.isDir ? "-" : formatFileSize(packed)),
    };

    const rest: TableColumnsType<Row> = [
      ...(packedPerEntryKnown ? [packedColumn] : []),
      {
        title: "修改时间",
        dataIndex: "modified",
        key: "modified",
        width: 168,
        sorter: (a, b) => dirFirst(a, b) || a.modified - b.modified,
        render: (modified: number) => (modified ? formatTime(modified) : "-"),
      },
      {
        title: "方法",
        dataIndex: "method",
        key: "method",
        width: 92,
        ellipsis: true,
        render: (method: string, r: Row) => (r.isDir ? "-" : method || "-"),
      },
    ];

    return [nameColumn, sizeColumn, ...rest];
  }, [packedPerEntryKnown, searching, token.colorTextTertiary, token.colorWarning]);

  const moreItems = useMemo<MenuProps["items"]>(() => {
    const items: MenuProps["items"] = [];
    if (caps?.extract) {
      items.push({ key: "extract-to", icon: <FolderOpenOutlined />, label: "解压到…" });
    }
    if (caps?.test) {
      items.push({
        key: "test",
        icon: <SafetyCertificateOutlined />,
        label: "校验完整性",
      });
    }
    if (caps?.add) {
      items.push({ key: "add", icon: <FileAddOutlined />, label: "添加文件到压缩包…" });
    }
    if (items.length > 0) items.push({ type: "divider" });
    items.push({ key: "props", icon: <InfoCircleOutlined />, label: "压缩包属性" });
    if (archivePath) {
      items.push({ key: "reveal", icon: <ExportOutlined />, label: "在文件管理器中显示" });
    }
    return items;
  }, [archivePath, caps]);

  const onMoreClick: MenuProps["onClick"] = ({ key }) => {
    if (key === "extract-to") void pickDestAndExtract();
    else if (key === "test") void runTest();
    else if (key === "add") void addFiles();
    else if (key === "props") setPropsOpen(true);
    else if (key === "reveal") reveal();
  };

  const crumbs = archiveBreadcrumbs(dir);
  const selectedCount = selectedKeys.length;
  // 压缩后大小没报出来就不算比率：`0 / totalSize` 会显示成"0%"，
  // 而用户拿 7-Zip 打开同一个 RAR 看到的是 78%，两个数摆在一起只会让人觉得这边坏了。
  // 这里用总量那一份判据，不是条目那一份 —— solid 的 7z 单条没有 packed，总量是真的
  const ratio =
    info && packedTotalKnown ? Math.round((info.totalPacked / info.totalSize) * 100) : null;

  const title = (
    <Space size={8} style={{ minWidth: 0 }}>
      <span style={{ color: token.colorWarning, display: "inline-flex" }}>
        <FolderOpenOutlined />
      </span>
      <Text strong ellipsis style={{ maxWidth: 420 }}>
        {archivePath ? fsBaseName(archivePath) : "压缩包"}
      </Text>
      {probe && <Tag>{probe.formatLabel}</Tag>}
      {info?.solid && (
        <Tooltip title="Solid：条目之间共享字典，压得更小，但抽单条要从头解到那一条">
          <Tag color="blue">Solid</Tag>
        </Tooltip>
      )}
      {info?.needsPassword && <Tag color="orange">已加密</Tag>}
      {info && info.entryCount > 0 && (
        <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
          {info.entryCount} 项 · {formatFileSize(info.totalSize)}
          {ratio !== null ? ` → ${formatFileSize(info.totalPacked)}（${ratio}%）` : ""}
        </Text>
      )}
    </Space>
  );

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      width={940}
      destroyOnHidden
      styles={{ body: { paddingTop: 8 } }}
      footer={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Backspace 上一级 · Enter 打开 · 双击文件解出并用默认程序打开
          </Text>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>关闭</Button>
        </div>
      }
    >
      {probe?.unsupportedReason && (
        <Alert type="error" showIcon style={{ marginBottom: 8 }} message={probe.unsupportedReason} />
      )}
      {probe?.isSecondaryVolume && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`这是分卷压缩包的第 ${probe.volumeIndex ?? "?"} 卷`}
          description="分卷要从第一卷（.001 / .part1.rar / .zip.001）开始解，打开第一卷再操作。"
        />
      )}
      {info?.truncated && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`条目太多，列表被截断到 ${info.entries.length} 项`}
          description="解压不受影响（引擎直接遍历归档），但这里看到的不是全部。用搜索找具体文件。"
        />
      )}

      {askPassword ? (
        <div
          style={{
            padding: 16,
            borderRadius: token.borderRadiusLG,
            background: token.colorFillQuaternary,
            marginBottom: 8,
          }}
        >
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Text strong>
              <LockOutlined style={{ marginRight: 6 }} />
              需要密码
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {passwordNote}
            </Text>
            <Space.Compact style={{ width: "100%", maxWidth: 360 }}>
              <Input.Password
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onPressEnter={submitPassword}
                placeholder="输入压缩包密码"
                autoComplete="off"
              />
              <Button type="primary" onClick={submitPassword} loading={loading}>
                确定
              </Button>
            </Space.Compact>
          </Space>
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            {selectedCount > 0 ? (
              <>
                <Button
                  type="primary"
                  icon={<FolderOpenOutlined />}
                  loading={working}
                  onClick={() => extractSelectedOrAll(siblingExtractDir)}
                >
                  解压选中 {selectedCount} 项到 {extractDirName}\
                </Button>
                <Button loading={working} onClick={() => extractSelectedOrAll(currentPath)}>
                  解压到当前文件夹
                </Button>
                <Button
                  type="text"
                  onClick={() => setSelectedKeys([])}
                >
                  取消选择
                </Button>
              </>
            ) : (
              <>
                {caps?.extract && (
                  <>
                    <Button
                      type="primary"
                      icon={<FolderOpenOutlined />}
                      loading={working}
                      onClick={() => extractSelectedOrAll(siblingExtractDir)}
                    >
                      解压到 {extractDirName}\
                    </Button>
                    <Button loading={working} onClick={() => extractSelectedOrAll(currentPath)}>
                      解压到当前文件夹
                    </Button>
                  </>
                )}
                {/* 已经在根目录时不渲染"上一级"：留一个灰按钮在那儿只是噪音 */}
                {dir.length > 0 && (
                  <Button icon={<ArrowLeftOutlined />} onClick={goUp}>
                    上一级
                  </Button>
                )}
              </>
            )}

            <span style={{ flex: 1 }} />

            <Input.Search
              allowClear
              placeholder="在压缩包内搜索"
              style={{ width: 220 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Dropdown menu={{ items: moreItems, onClick: onMoreClick }} trigger={["click"]}>
              <Button icon={<MoreOutlined />} aria-label="更多操作" />
            </Dropdown>
          </div>

          <Breadcrumb
            style={{ marginBottom: 6 }}
            items={crumbs.map((c) => ({
              title:
                c.path === dir ? (
                  <span>{c.name}</span>
                ) : (
                  <a
                    onClick={(e) => {
                      e.preventDefault();
                      setDir(c.path);
                      setQuery("");
                      setSelectedKeys([]);
                    }}
                    href="#"
                  >
                    {c.name}
                  </a>
                ),
            }))}
          />

          <div ref={listRef} tabIndex={-1} onKeyDown={onKeyDown} style={{ outline: "none" }}>
            {loading ? (
              <div style={{ textAlign: "center", padding: "48px 0" }}>
                <Spin size="large" />
                <div style={{ marginTop: 12, color: token.colorTextSecondary }}>
                  正在读取压缩包内容…
                </div>
              </div>
            ) : (
              <Table<Row>
                columns={columns}
                dataSource={rows}
                size="small"
                rowKey="key"
                rowSelection={{
                  selectedRowKeys: selectedKeys,
                  preserveSelectedRowKeys: true,
                  onChange: (keys) => setSelectedKeys(keys.map(String)),
                }}
                pagination={
                  rows.length > 200
                    ? {
                        pageSize: 200,
                        showSizeChanger: true,
                        pageSizeOptions: [100, 200, 500, 1000],
                        size: "small",
                        showTotal: (t) => `共 ${t} 项`,
                      }
                    : false
                }
                scroll={{ y: 420 }}
                locale={{
                  emptyText: info
                    ? searching
                      ? "没有匹配的条目"
                      : "这个目录是空的"
                    : "读不出内容",
                }}
                onRow={(r) => ({
                  onDoubleClick: () => activate(r),
                  style: { cursor: r.isDir ? "default" : "pointer" },
                })}
              />
            )}
          </div>
        </>
      )}

      <Modal
        title="压缩包属性"
        open={propsOpen}
        onCancel={() => setPropsOpen(false)}
        footer={<Button onClick={() => setPropsOpen(false)}>关闭</Button>}
        width={560}
        destroyOnHidden
      >
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="路径">
            <Text copyable style={{ fontSize: 12 }}>
              {archivePath}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label="格式">
            {probe?.formatLabel ?? info?.formatLabel ?? "-"}
            {info?.container ? `（容器：${info.container}）` : ""}
          </Descriptions.Item>
          <Descriptions.Item label="条目数">{info?.entryCount ?? "-"}</Descriptions.Item>
          <Descriptions.Item label="原始大小">
            {info ? formatFileSize(info.totalSize) : "-"}
          </Descriptions.Item>
          <Descriptions.Item label="压缩后">
            {/* 说清楚"没有"和"是零"的区别：属性页是唯一有地方写这句话的视图 */}
            {info && ratio !== null
              ? `${formatFileSize(info.totalPacked)}（${ratio}%）`
              : "此格式不提供"}
          </Descriptions.Item>
          <Descriptions.Item label="特性">
            <Space size={4} wrap>
              {info?.solid && <Tag color="blue">Solid</Tag>}
              {info?.needsPassword && <Tag color="orange">已加密</Tag>}
              {info?.encryptedHeaders && <Tag color="red">文件名也加密</Tag>}
              {info?.multipart && <Tag color="purple">分卷 {info.volumes.length} 个</Tag>}
              {!info?.solid && !info?.needsPassword && !info?.multipart && <Tag>无</Tag>}
            </Space>
          </Descriptions.Item>
          {info && info.volumes.length > 1 && (
            <Descriptions.Item label="分卷">
              <div style={{ maxHeight: 120, overflow: "auto" }}>
                {info.volumes.map((v) => (
                  <div key={v} style={{ fontSize: 12 }}>
                    {v}
                  </div>
                ))}
              </div>
            </Descriptions.Item>
          )}
          {info?.comment && (
            <Descriptions.Item label="注释">
              <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>{info.comment}</pre>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Modal>
    </Modal>
  );
}
