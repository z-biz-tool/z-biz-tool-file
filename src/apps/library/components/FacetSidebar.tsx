/**
 * 左侧归纳栏。
 *
 * 三层结构，对应三种不同的「归类冲动」：
 *   1. 书库概览（全部 / 未读 / 在读 / 已读 / 收藏）—— 按状态看，最常用，放最上面
 *   2. 图书集 —— 用户亲手拉的线，可以没有，但一旦有了就是他的主目录
 *   3. 自动维度（作者 / 系列 / 出版社 / 年份 / 标签 / 格式）—— 从书目数据里长出来的
 *
 * 用 antd Menu 而不是自绘：它自带上下键导航与 role=menu 的语义，而侧栏会有
 * 上百个条目（一个书多的作者维度），键盘可达比样式重要。
 */
import { useMemo } from "react";
import { Menu, theme, Typography } from "antd";
import type { MenuProps } from "antd";
import type { LibraryFacets } from "../libraryClient";
import { buildFacetSections, STATUS_LABEL, viewKey, type LibraryView } from "../facets";

const { Text } = Typography;

interface Props {
  facets: LibraryFacets | null;
  view: LibraryView;
  onView: (v: LibraryView) => void;
  onNewCollection: () => void;
}

export default function FacetSidebar({ facets, view, onView, onNewCollection }: Props) {
  const { token } = theme.useToken();

  const items = useMemo<MenuProps["items"]>(() => {
    const count = (n: number) => (
      <span style={{ float: "right", color: token.colorTextTertiary, fontSize: 12 }}>{n}</span>
    );
    const entry = (key: string, label: string, n: number, target: LibraryView) => ({
      key,
      label: (
        <span>
          {label}
          {count(n)}
        </span>
      ),
      onClick: () => onView(target),
    });

    if (!facets) return [];

    const out: MenuProps["items"] = [
      {
        type: "group" as const,
        label: "书库",
        children: [
          entry("all", "全部图书", facets.total, { kind: "all" }),
          entry(`status:unread`, STATUS_LABEL.unread, facets.unread, {
            kind: "status",
            value: "unread",
          }),
          entry(`status:reading`, STATUS_LABEL.reading, facets.reading, {
            kind: "status",
            value: "reading",
          }),
          entry(`status:finished`, STATUS_LABEL.finished, facets.finished, {
            kind: "status",
            value: "finished",
          }),
          entry("favorites", "收藏", facets.favorites, { kind: "favorites" }),
        ],
      },
      {
        type: "group" as const,
        label: "图书集",
        children: [
          ...facets.collections.map(({ collection: c, count: n }) => ({
            key: `collection:${c.id}`,
            label: (
              <span>
                {c.color && (
                  <span
                    aria-hidden
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: c.color,
                      marginRight: 6,
                    }}
                  />
                )}
                {c.name}
                {count(n)}
              </span>
            ),
            onClick: () => onView({ kind: "collection", id: c.id }),
          })),
          {
            key: "__new-collection",
            label: <Text type="secondary">＋ 新建图书集…</Text>,
            onClick: onNewCollection,
          },
        ],
      },
    ];

    for (const section of buildFacetSections(facets)) {
      out.push({
        type: "group" as const,
        label: section.title,
        children: section.values.map((v) =>
          entry(
            `facet:${section.field}:${v.value}`,
            v.value,
            v.count,
            { kind: "facet", field: section.field, value: v.value },
          ),
        ),
      });
    }

    return out;
  }, [facets, onView, onNewCollection, token.colorTextTertiary]);

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        borderRight: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        paddingBottom: 16,
      }}
    >
      <Menu
        mode="inline"
        selectedKeys={[viewKey(view)]}
        items={items}
        style={{ borderInlineEnd: "none", fontSize: 13 }}
      />
    </div>
  );
}
