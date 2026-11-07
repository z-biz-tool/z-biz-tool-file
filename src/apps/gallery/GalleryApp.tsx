/**
 * 图片库板块（2026-11-07）。
 *
 * ## 为什么单独做成一个板块
 *
 * 原来「看图片」只有一条路：在文件管理里右键某个图片 → 「加入图片库」，
 * 弹出一个 90vw × 80vh 的 Modal（照片馆）。那条路的两个问题：
 *
 * 1. **它是弹窗，不是地方**。用户想「我就看看这周拍的图」时，得先找到一个
 *    图片文件、右键、选菜单，才能进到本该是一个独立目的地的视图里。
 * 2. **它挂在文件管理的 currentPath 上**。图片库是「按类型看内容」，
 *    和「当前站在哪个目录」是两件事 —— 用户从图书馆切回来，
 *    照片馆里的目录也跟着变了。
 *
 * 所以这里给它一个活动栏入口（图书馆下面），以及**自己的**浏览位置：
 * 默认 `~/Pictures`，之后记在 localStorage，不跟文件管理联动。
 *
 * ## 复用而不是重写
 *
 * 画廊本体还是 `components/MediaGallery`（678 行，画廊/列表两种版式 +
 * 三档缩略图尺寸 + 右键菜单都现成）。这个文件只补它没有的那一层 ——
 * **目录导航**：MediaGallery 只 `list_directory` 单个目录，不递归也没有子目录。
 * 所以这里加「上级 / 选文件夹 / 刷新」三件套，其余一行不碰。
 *
 * 视频馆 / 音乐馆仍留在文件管理的右键里：它们本来就是「找到某个文件顺手打开」
 * 的次级场景，一个活动栏图标换来的收益不如图片。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { App as AntdApp, Button, Segmented, Space, Tooltip, Typography } from "antd";
import {
  ArrowUpOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { MediaGallery } from "../../components/MediaGallery";
import {
  sizeControlEnabled,
  type MediaGallerySize,
  type MediaViewMode,
} from "../../utils/mediaLayout";
import { homeDirSync } from "../../utils/homeDir";

const { Text } = Typography;

const PREF = "z-tool-gallery-";

/** 上次浏览的目录；没有就落到 `~/Pictures`（macOS 的标准图片位置）。 */
function initialDir(): string {
  const saved = localStorage.getItem(PREF + "dir");
  if (saved) return saved;
  const home = homeDirSync();
  return home ? `${home}/Pictures` : "";
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

export default function GalleryApp() {
  const { message, modal } = AntdApp.useApp();
  const [dir, setDir] = useState<string>(initialDir);
  const [viewMode, setViewMode] = useState<MediaViewMode>(
    () => (localStorage.getItem(PREF + "view") as MediaViewMode) || "gallery",
  );
  const [size, setSize] = useState<MediaGallerySize>(
    () => (localStorage.getItem(PREF + "size") as MediaGallerySize) || "medium",
  );
  // 换目录 / 删图后要重新 list。MediaGallery 的 effect 依赖 `directory`，
  // 但同一个目录刷新时它感知不到 —— 用一个自增的 key 强制它重挂。
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (dir) localStorage.setItem(PREF + "dir", dir);
  }, [dir]);
  useEffect(() => {
    localStorage.setItem(PREF + "view", viewMode);
  }, [viewMode]);
  useEffect(() => {
    localStorage.setItem(PREF + "size", size);
  }, [size]);

  const pickDir = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择要浏览的图片文件夹",
      });
      if (typeof picked === "string" && picked) setDir(picked);
    } catch (e) {
      message.error("选择文件夹失败: " + String(e));
    }
  }, [message]);

  const openItem = useCallback(
    (item: { path: string }) => {
      invoke("open_with_default_app", { path: item.path }).catch((e) =>
        message.error("打开失败: " + String(e)),
      );
    },
    [message],
  );

  const revealItem = useCallback(
    (item: { path: string }) => {
      invoke("reveal_in_finder", { path: item.path }).catch((e) =>
        message.error("打开 Finder 失败: " + String(e)),
      );
    },
    [message],
  );

  /**
   * 删除一张图。
   *
   * 走「确认 → 移到回收站 → 通知画廊摘掉」，和文件管理那边同一个口径：
   * 删图片不该比删文件更「重」（这里原来没有入口，用户只能回文件管理里删）。
   * 用 context 的 modal，不用静态 Modal.confirm（主题/locale 才跟得上）。
   */
  const deleteItem = useCallback(
    (item: { name: string; path: string }, afterDeleted: () => void) => {
      modal.confirm({
        title: "移到回收站？",
        content: `「${item.name}」将移到回收站，可以再恢复。`,
        okText: "移到回收站",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: async () => {
          try {
            await invoke("delete_to_trash", { path: item.path });
            afterDeleted();
            message.success("已移到回收站");
          } catch (e) {
            message.error("删除失败: " + String(e));
          }
        },
      });
    },
    [modal, message],
  );

  /** 目录不存在时给一句人话，而不是让画廊停在空白网格上。 */
  const [dirMissing, setDirMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!dir) {
      setDirMissing(true);
      return;
    }
    invoke("get_file_info", { path: dir })
      .then(() => {
        if (!cancelled) setDirMissing(false);
      })
      .catch(() => {
        if (cancelled) return;
        // 默认的 ~/Pictures 在有些机器上根本不存在（从没存过图的用户）。
        // 这种情况自动退回主目录，而不是一进来就让人看"文件夹不存在" ——
        // 那个错误页只在用户**自己选错**目录时才该出现。
        const h = homeDirSync();
        if (h && dir === `${h}/Pictures`) {
          setDir(h);
          return;
        }
        setDirMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const home = useMemo(() => homeDirSync(), []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--ant-color-bg-layout)",
      }}
    >
      {/* 工具条：目录导航 + 版式 + 刷新。
          和文件管理那块「路径栏 + 视图切换」一样的分工，但**状态完全独立** ——
          图片库有自己的浏览位置，不跟文件管理的 currentPath 联动。 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid var(--ant-color-border-secondary)",
          background: "var(--ant-color-bg-container)",
          flexShrink: 0,
        }}
      >
        <Tooltip title="上级文件夹" placement="bottom">
          <Button
            size="small"
            type="text"
            icon={<ArrowUpOutlined />}
            onClick={() => setDir((d) => (d && d !== "/" ? parentOf(d) : d))}
            disabled={!dir || dir === "/"}
            aria-label="上级文件夹"
          />
        </Tooltip>

        <Tooltip title={dir || "还没有选目录"} placement="bottom">
          <Text
            style={{
              fontSize: 13,
              maxWidth: 420,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              direction: "rtl",
              textAlign: "left",
            }}
          >
            {dir || "—"}
          </Text>
        </Tooltip>

        <Button size="small" icon={<FolderOpenOutlined />} onClick={pickDir}>
          选文件夹
        </Button>
        {home && dir !== home && (
          <Button size="small" type="text" onClick={() => setDir(home)}>
            回到主目录
          </Button>
        )}

        <div style={{ flex: 1 }} />

        <Space size={8}>
          <Segmented
            size="small"
            value={viewMode}
            onChange={(v) => setViewMode(v as MediaViewMode)}
            options={[
              { label: "画廊", value: "gallery" },
              { label: "列表", value: "list" },
            ]}
            aria-label="切换版式"
          />
          <Segmented
            size="small"
            // 尺寸只作用于网格；列表视图没有列宽可调
            disabled={!sizeControlEnabled(viewMode, "image")}
            value={size}
            onChange={(v) => setSize(v as MediaGallerySize)}
            options={[
              { label: "小", value: "small" },
              { label: "中", value: "medium" },
              { label: "大", value: "large" },
            ]}
            aria-label="缩略图尺寸"
          />
          <Tooltip title="重新读取这个目录" placement="bottom">
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              onClick={() => setReloadKey((k) => k + 1)}
              aria-label="刷新"
            />
          </Tooltip>
        </Space>
      </div>

      <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
        {dirMissing ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              color: "var(--ant-color-text-tertiary)",
              fontSize: 13,
            }}
          >
            <div>这个文件夹不存在或读不了：{dir || "(空)"}</div>
            <Space>
              <Button size="small" onClick={pickDir}>
                重新选择
              </Button>
              {home && (
                <Button size="small" type="text" onClick={() => setDir(home)}>
                  回到主目录
                </Button>
              )}
            </Space>
          </div>
        ) : (
          // key 里带上 reloadKey：同一个目录点「刷新」时，MediaGallery 的
          // useEffect 只依赖 directory，感知不到"还是这个目录但我要重读"。
          <MediaGallery
            key={`${dir}::${reloadKey}`}
            directory={dir}
            mediaType="image"
            viewMode={viewMode}
            size={size}
            onOpen={openItem}
            onReveal={revealItem}
            onDelete={deleteItem}
          />
        )}
      </div>
    </div>
  );
}
