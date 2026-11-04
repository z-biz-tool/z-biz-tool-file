/**
 * 中间的书目列表：网格（封面墙）与列表（表格信息）两种视图。
 *
 * 封面不真的去加载书里的图：EPUB 抽封面要开 zip、PDF 要渲染首页，几百本书
 * 逐个来会把列表拖住好几秒，而其中大半封面本来就缺失。这里用「格式色块 + 书名
 * 首字」当占位 —— 加载成本为零、不会失败，浏览时靠颜色和首字就能定位。
 */
import { Dropdown, Empty, Progress, Rate, Skeleton, theme, Tooltip, Typography } from "antd";
import type { MenuProps } from "antd";
import type { LibraryEntry } from "../libraryClient";
import { formatLabel, progressText, readStatusOf, resolveReaderKind, STATUS_LABEL } from "../facets";

const { Text } = Typography;

export type BookAction =
  | "open-external"
  | "toggle-favorite"
  | "mark-unread"
  | "mark-reading"
  | "mark-finished"
  | "edit-meta"
  | "remove-from-collection"
  | "remove-entry"
  | "reveal";

interface Props {
  entries: LibraryEntry[];
  loading: boolean;
  selectedId: string | null;
  viewMode: "grid" | "list";
  /** 当前是否停在某个图书集里 —— 只有这时才给"从本集移除" */
  currentCollectionId?: string;
  onSelect: (e: LibraryEntry) => void;
  onAction: (action: BookAction, e: LibraryEntry) => void;
}

/** 每种格式一个稳定的颜色，让封面墙一眼能分出 PDF / EPUB / 漫画 */
function formatColor(format: string): string {
  switch (format) {
    case "PDF":
      return "#d4380d";
    case "EPUB":
      return "#237804";
    case "MOBI":
    case "AZW3":
      return "#ad6800";
    case "CBZ":
    case "CBR":
      return "#531dab";
    case "TXT":
    case "MD":
      return "#0958d9";
    default:
      return "#595959";
  }
}

function buildMenu(
  entry: LibraryEntry,
  currentCollectionId: string | undefined,
  onAction: (a: BookAction, e: LibraryEntry) => void,
): MenuProps {
  const status = readStatusOf(entry);
  const canReadInline = resolveReaderKind(entry) !== null;
  return {
    items: [
      {
        key: "open-external",
        label: canReadInline ? "用默认应用打开" : "用默认应用打开（此格式无法在应用内阅读）",
        onClick: () => onAction("open-external", entry),
      },
      { type: "divider" },
      {
        key: "fav",
        label: entry.favorite ? "取消收藏" : "加入收藏",
        onClick: () => onAction("toggle-favorite", entry),
      },
      {
        key: "status",
        label: "阅读状态",
        children: [
          {
            key: "unread",
            label: STATUS_LABEL.unread,
            disabled: status === "unread",
            onClick: () => onAction("mark-unread", entry),
          },
          {
            key: "reading",
            label: STATUS_LABEL.reading,
            disabled: status === "reading",
            onClick: () => onAction("mark-reading", entry),
          },
          {
            key: "finished",
            label: STATUS_LABEL.finished,
            disabled: status === "finished",
            onClick: () => onAction("mark-finished", entry),
          },
        ],
      },
      { key: "edit-meta", label: "编辑书目信息…", onClick: () => onAction("edit-meta", entry) },
      ...(currentCollectionId
        ? [
            {
              key: "remove-from-collection",
              label: "从本图书集移除",
              onClick: () => onAction("remove-from-collection", entry),
            },
          ]
        : []),
      { type: "divider" as const },
      { key: "reveal", label: "在 Finder 中显示", onClick: () => onAction("reveal", entry) },
      {
        key: "remove-entry",
        label: "从图书馆移除（不删文件）",
        danger: true,
        onClick: () => onAction("remove-entry", entry),
      },
    ],
  };
}

export default function BookList({
  entries,
  loading,
  selectedId,
  viewMode,
  currentCollectionId,
  onSelect,
  onAction,
}: Props) {
  const { token } = theme.useToken();

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div style={{ padding: 48 }}>
        <Empty
          description={
            <span>
              这里还没有书。
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                可以「添加扫描目录」把已有的书收进来，或者在文件管理里右键任意文件「加入图书集」
              </Text>
            </span>
          }
        />
      </div>
    );
  }

  if (viewMode === "list") {
    return (
      <div role="list" aria-label="书目列表">
        {entries.map((e) => {
          const fmt = formatLabel(e);
          const active = e.id === selectedId;
          return (
            <Dropdown
              key={e.id}
              trigger={["contextMenu"]}
              menu={buildMenu(e, currentCollectionId, onAction)}
            >
              <div
                role="listitem"
                tabIndex={0}
                aria-current={active ? "true" : undefined}
                onClick={() => onSelect(e)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelect(e);
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 14px",
                  cursor: "pointer",
                  background: active ? token.colorPrimaryBg : undefined,
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 26,
                    height: 34,
                    borderRadius: 3,
                    background: formatColor(fmt),
                    color: "#fff",
                    fontSize: 10,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 600,
                  }}
                >
                  {fmt.slice(0, 4)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Text ellipsis style={{ maxWidth: 420, fontWeight: active ? 600 : 400 }}>
                      {e.title}
                    </Text>
                    {e.favorite && (
                      <span aria-label="已收藏" style={{ color: token.colorError, fontSize: 11 }}>
                        ♥
                      </span>
                    )}
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                    {[e.author, e.publisher, e.publish_year, e.series].filter(Boolean).join(" · ") ||
                      "元数据待补"}
                  </Text>
                </div>
                {e.rating ? (
                  <Rate disabled value={e.rating} style={{ fontSize: 11 }} />
                ) : null}
                <div style={{ width: 90, flexShrink: 0 }}>
                  <Progress
                    percent={Math.round((e.read_progress ?? 0) * 100)}
                    size="small"
                    showInfo={false}
                    strokeColor={readStatusOf(e) === "finished" ? token.colorSuccess : undefined}
                  />
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {progressText(e)}
                  </Text>
                </div>
              </div>
            </Dropdown>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="list"
      aria-label="书目网格"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
        gap: 14,
        padding: 16,
        alignContent: "start",
      }}
    >
      {entries.map((e) => {
        const fmt = formatLabel(e);
        const active = e.id === selectedId;
        const status = readStatusOf(e);
        return (
          <Dropdown
            key={e.id}
            trigger={["contextMenu"]}
            menu={buildMenu(e, currentCollectionId, onAction)}
          >
            <div
              role="listitem"
              tabIndex={0}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(e)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(e);
                }
              }}
              style={{
                cursor: "pointer",
                borderRadius: token.borderRadiusLG,
                padding: 8,
                background: active ? token.colorPrimaryBg : token.colorFillQuaternary,
                outline: active ? `1px solid ${token.colorPrimaryBorder}` : "none",
              }}
            >
              {/* 封面：格式色块 + 书名首字 */}
              <div
                style={{
                  position: "relative",
                  aspectRatio: "3 / 4",
                  borderRadius: token.borderRadius,
                  background: `linear-gradient(160deg, ${formatColor(fmt)} 0%, ${token.colorFill} 220%)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    fontSize: 40,
                    fontWeight: 700,
                    color: "rgba(255,255,255,0.92)",
                    fontFamily: "serif",
                  }}
                >
                  {(e.title.trim()[0] ?? "书").toUpperCase()}
                </span>
                <span
                  style={{
                    position: "absolute",
                    left: 6,
                    bottom: 6,
                    fontSize: 10,
                    color: "#fff",
                    background: "rgba(0,0,0,0.32)",
                    borderRadius: 3,
                    padding: "1px 5px",
                    letterSpacing: 0.3,
                  }}
                >
                  {fmt}
                </span>
                {e.favorite && (
                  <span
                    aria-label="已收藏"
                    style={{ position: "absolute", right: 6, top: 6, color: "#fff", fontSize: 13 }}
                  >
                    ♥
                  </span>
                )}
                {status !== "unread" && (
                  <span
                    style={{
                      position: "absolute",
                      right: 6,
                      bottom: 6,
                      fontSize: 10,
                      color: "#fff",
                      background: status === "finished" ? "rgba(56,158,13,0.85)" : "rgba(0,0,0,0.45)",
                      borderRadius: 3,
                      padding: "1px 5px",
                    }}
                  >
                    {status === "finished" ? "已读" : progressText(e)}
                  </span>
                )}
              </div>

              <Tooltip title={e.path}>
                <div style={{ marginTop: 6 }}>
                  <Text
                    ellipsis
                    style={{ fontSize: 13, fontWeight: active ? 600 : 400, display: "block" }}
                  >
                    {e.title}
                  </Text>
                  <Text
                    type="secondary"
                    ellipsis
                    style={{ fontSize: 11, display: "block" }}
                  >
                    {e.author || "未知作者"}
                  </Text>
                </div>
              </Tooltip>
            </div>
          </Dropdown>
        );
      })}
    </div>
  );
}
