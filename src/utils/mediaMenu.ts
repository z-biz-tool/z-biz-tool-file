/**
 * 画廊右键菜单的动作表。
 *
 * 抽成纯函数是为了能单测，更重要的是把"菜单项必须有行为"变成构造上的约束：
 * 之前 MediaGallery 里那份菜单只写了 label 没有 onClick（而且整份菜单是一个
 * useMemo([]) 的共享对象，压根不知道右键的是哪一项），于是"打开/在 Finder 中显示/
 * 删除"三条点了全无反应 —— 界面上看不出任何异常，只有用户以为删掉了、其实没删。
 * 现在没有对应处理器的动作根本进不了菜单。
 */
import type { MenuProps } from "antd";
import type { MediaItem } from "./mediaType";

export interface MediaActions {
  onOpen?: (item: MediaItem) => void;
  onReveal?: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
}

export type MediaMenuItem = NonNullable<MenuProps["items"]>[number];

/** 菜单项顺序与分隔线都在这里定死，便于测试把整张表钉住 */
export function buildMediaMenu(item: MediaItem, actions: MediaActions): MediaMenuItem[] {
  const items: MediaMenuItem[] = [];
  if (actions.onOpen) {
    items.push({ key: "open", label: "打开", onClick: () => actions.onOpen?.(item) });
  }
  if (actions.onReveal) {
    items.push({ key: "reveal", label: "在 Finder 中显示", onClick: () => actions.onReveal?.(item) });
  }
  const onDelete = actions.onDelete;
  if (onDelete) {
    // 分隔线只在前面上已经有动作时才加：只给 onDelete 时不该出现一条顶在菜单最上面的空线
    if (items.length) items.push({ type: "divider" });
    items.push({ key: "delete", label: "删除", danger: true, onClick: () => onDelete(item) });
  }
  return items;
}
