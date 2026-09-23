import { useEffect, useMemo, useState } from "react";
import { Empty, Input, Modal, Typography, theme } from "antd";
import {
  describeShortcuts,
  filterShortcutDocs,
  type ShortcutSpec,
} from "../_shared/useKeyboardShortcuts";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 就是 useKeyboardShortcuts 吃的那一份数组 */
  specs: ShortcutSpec[];
}

const { Text } = Typography;

/**
 * 快捷键面板。
 *
 * 它吃调用方传进来的 spec 数组，而不是自己另写一份"功能 → 键位"表：
 * 键位一旦改了、某条删了，手抄的表就开始教用户按一个不存在的组合键，
 * 而这种错只有人去试才知道。
 */
export default function ShortcutHelp({ open, onClose, specs }: Props) {
  const { token } = theme.useToken();
  const [query, setQuery] = useState("");

  // 重新打开不该带着上一次的搜索词：用户会以为"怎么只剩两条快捷键了"
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const groups = useMemo(() => filterShortcutDocs(describeShortcuts(specs), query), [specs, query]);

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={560} title="快捷键">
      <Input
        placeholder="搜索功能或键位"
        allowClear
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ margin: "8px 0 4px" }}
      />
      <div style={{ maxHeight: "60vh", overflow: "auto", paddingRight: 4 }}>
        {groups.length === 0 ? (
          <Empty description={`没有匹配「${query}」的快捷键`} />
        ) : (
          groups.map((g) => (
            <div key={g.group} style={{ marginTop: 14 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {g.group}
              </Text>
              {g.items.map((item) => (
                <div
                  key={`${item.keys}-${item.label}`}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 16,
                    padding: "5px 0",
                    borderBottom: `1px solid ${token.colorSplit}`,
                  }}
                >
                  <span>{item.label}</span>
                  {/* 键位不换行：⌥ + ← 拆成两行会比没有面板还难读 */}
                  <Text code style={{ whiteSpace: "nowrap" }}>
                    {item.keys}
                  </Text>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
