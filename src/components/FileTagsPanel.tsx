import { useState, useEffect, useCallback } from "react";
import { Popover, Tag, Input, Button, Space, message, theme } from "antd";
import { TagOutlined, PlusOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  filePath: string | null;
}

interface FileTags {
  colorTags: string[];
  customTags: string[];
}

const MACOS_COLORS: { name: string; value: string; label: string }[] = [
  { name: "red", value: "#FF3B30", label: "红色" },
  { name: "orange", value: "#FF9500", label: "橙色" },
  { name: "yellow", value: "#FFCC00", label: "黄色" },
  { name: "green", value: "#34C759", label: "绿色" },
  { name: "blue", value: "#007AFF", label: "蓝色" },
  { name: "purple", value: "#AF52DE", label: "紫色" },
  { name: "gray", value: "#8E8E93", label: "灰色" },
];

export default function FileTagsPanel({ filePath }: Props) {
  const { token } = theme.useToken();

  const [colorTags, setColorTags] = useState<string[]>([]);
  const [customTags, setCustomTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadTags = useCallback(async () => {
    if (!filePath) return;
    setLoading(true);
    try {
      const result = (await invoke("get_file_tags", { path: filePath })) as FileTags;
      setColorTags(result.colorTags ?? []);
      setCustomTags(result.customTags ?? []);
    } catch (err) {
      message.error("获取标签失败: " + err);
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    if (filePath && open) {
      loadTags();
    }
    if (!filePath) {
      setColorTags([]);
      setCustomTags([]);
    }
  }, [filePath, open, loadTags]);

  const saveTags = async (newColorTags: string[], newCustomTags: string[]) => {
    if (!filePath) return;
    try {
      await invoke("set_file_tags", {
        path: filePath,
        colorTags: newColorTags,
        customTags: newCustomTags,
      });
      setColorTags(newColorTags);
      setCustomTags(newCustomTags);
    } catch (err) {
      message.error("保存标签失败: " + err);
    }
  };

  const toggleColor = (colorName: string) => {
    const newColorTags = colorTags.includes(colorName)
      ? colorTags.filter((c) => c !== colorName)
      : [...colorTags, colorName];
    saveTags(newColorTags, customTags);
  };

  const addCustomTag = () => {
    const trimmed = newTag.trim();
    if (!trimmed) return;
    if (customTags.includes(trimmed)) {
      message.warning("标签已存在");
      return;
    }
    saveTags(colorTags, [...customTags, trimmed]);
    setNewTag("");
  };

  const removeCustomTag = (tag: string) => {
    saveTags(colorTags, customTags.filter((t) => t !== tag));
  };

  const activeColorDots = MACOS_COLORS.filter((c) => colorTags.includes(c.name));

  const content = (
    <div style={{ width: 240 }}>
      <div style={{ marginBottom: token.marginSM, fontWeight: 500 }}>颜色标签</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: token.marginMD }}>
        {MACOS_COLORS.map((color) => {
          const active = colorTags.includes(color.name);
          return (
            <div
              key={color.name}
              title={color.label}
              onClick={() => toggleColor(color.name)}
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                backgroundColor: color.value,
                cursor: "pointer",
                border: active
                  ? `2px solid ${token.colorPrimary}`
                  : "2px solid transparent",
                boxShadow: active ? `0 0 0 2px ${token.colorPrimaryBg}` : "none",
                opacity: active ? 1 : 0.5,
                transition: "all 0.2s",
              }}
            />
          );
        })}
      </div>

      <div style={{ marginBottom: token.marginSM, fontWeight: 500 }}>自定义标签</div>
      {customTags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: token.marginSM }}>
          {customTags.map((tag) => (
            <Tag
              key={tag}
              closable
              onClose={() => removeCustomTag(tag)}
              style={{ margin: 0 }}
            >
              {tag}
            </Tag>
          ))}
        </div>
      )}

      <Space.Compact style={{ width: "100%" }}>
        <Input
          size="small"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          placeholder="输入新标签"
          onPressEnter={addCustomTag}
        />
        <Button size="small" icon={<PlusOutlined />} onClick={addCustomTag}>
          添加
        </Button>
      </Space.Compact>
    </div>
  );

  return (
    <Popover
      content={content}
      title="文件标签"
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
    >
      <Button
        type="text"
        size="small"
        icon={<TagOutlined />}
        loading={loading}
        style={{ position: "relative" }}
      >
        {activeColorDots.length > 0 && (
          <span
            style={{
              display: "inline-flex",
              gap: 2,
              marginLeft: 4,
            }}
          >
            {activeColorDots.map((c) => (
              <span
                key={c.name}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: c.value,
                  display: "inline-block",
                }}
              />
            ))}
          </span>
        )}
      </Button>
    </Popover>
  );
}
