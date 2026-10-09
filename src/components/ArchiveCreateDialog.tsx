/**
 * 新建压缩对话框。
 *
 * 格式清单、每种格式支持的算法/等级上限/能不能加密分卷，全部由后端 `archive_formats`
 * 给（写死在 Rust 的能力表里）。前端不自己维护一份：两份清单迟早会分叉，然后界面上
 * 出现一个后端根本不会写的格式，用户点下去才报错。
 *
 * 低频选项（存储完整路径、排除模式、加密文件名、solid、注释）默认折在"高级"里，
 * 不平铺成一屏控件——见 [[feedback-ui-fewer-buttons]]。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  App as AntdApp,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  theme,
  Tooltip,
  Typography,
} from "antd";
import { FolderOpenOutlined, FolderOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

import {
  defaultArchiveName,
  describeArchiveError,
  formatVolumeSize,
  joinFsPath,
  levelBoundsFor,
  parseVolumeSizeStrict,
  VOLUME_PRESETS,
  type CreateOptions,
  type FormatOption,
} from "../utils/archiveModel";

const { Text } = Typography;

export interface CreateSource {
  path: string;
  name: string;
  isDir: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  sources: CreateSource[];
  /** 目标文件默认落在哪个目录（一般是当前目录） */
  defaultDir: string;
  /** 任务起来之后调用，让文件列表刷新 */
  onStarted?: () => void;
}

export default function ArchiveCreateDialog({
  open,
  onClose,
  sources,
  defaultDir,
  onStarted,
}: Props) {
  const { token } = theme.useToken();
  const { message } = AntdApp.useApp();

  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [formatId, setFormatId] = useState("zip");
  const [methodId, setMethodId] = useState<string | null>(null);
  const [level, setLevel] = useState(6);
  const [dest, setDest] = useState("");
  const [password, setPassword] = useState("");
  const [encryptHeader, setEncryptHeader] = useState(false);
  const [solid, setSolid] = useState(false);
  const [comment, setComment] = useState("");
  const [volumeText, setVolumeText] = useState("");
  const [storeFullPath, setStoreFullPath] = useState(false);
  const [excludeText, setExcludeText] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const format = useMemo(
    () => formats.find((f) => f.id === formatId) ?? formats[0],
    [formats, formatId],
  );

  // 等级上限挂在**算法**上：同一个 zip 里 deflate 到 9、zstd 到 22、store 压根没有等级
  const bounds = useMemo(
    () => (format ? levelBoundsFor(format, methodId) : { max: 9, def: 6 }),
    [format, methodId],
  );

  /** 分卷输入框下面那句实时回显。填错了就什么都不显示——错误留到点"开始压缩"时再说，
   *  边打字边飘红字只会让人以为对话框坏了。 */
  const volumePreview = useMemo(() => {
    const r = parseVolumeSizeStrict(volumeText);
    return r.ok && r.bytes ? formatVolumeSize(r.bytes) : null;
  }, [volumeText]);

  /** 换了格式/算法之后，把等级和算法夹回合法区间。不夹的话会提交一个越界等级给后端。 */
  useEffect(() => {
    if (!format) return;
    const b = levelBoundsFor(format, methodId);
    setLevel((l) => Math.min(Math.max(l, 0), b.max));
  }, [format, methodId]);

  const pickFormat = useCallback((id: string) => {
    setFormatId(id);
    setMethodId(null);
    setEncryptHeader(false);
  }, []);

  // 打开时载入格式表并给出默认目标名。只在 open 的那一刻做，
  // 之后用户在对话框里改的东西不能被 sources 的引用变化冲掉
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const list = await invoke<FormatOption[]>("archive_formats");
        if (!alive) return;
        setFormats(list);
        const first = list.find((f) => f.id === formatId) ?? list[0];
        if (first && first.id !== formatId) pickFormat(first.id);
        const ext = (first ?? { extension: ".zip" }).extension;
        setDest(joinFsPath(defaultDir, defaultArchiveName(sources, ext)));
      } catch (err) {
        if (alive) message.error(describeArchiveError(err).message);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onFormatChange = (id: string) => {
    pickFormat(id);
    const f = formats.find((x) => x.id === id);
    if (!f) return;
    setMethodId(null);
    setLevel(f.defaultLevel);
    setSolid(false);
    setVolumeText("");
    // 换格式时目标名的扩展名要跟着换，否则会得到一个"内容 7z、名字 .zip"的文件
    setDest((d) => {
      const dir = d.replace(/\\/g, "/").slice(0, d.replace(/\\/g, "/").lastIndexOf("/"));
      const name = defaultArchiveName(sources, f.extension);
      return dir.length > 0 ? joinFsPath(dir, name) : name;
    });
  };

  const onMethodChange = (id: string | null) => {
    setMethodId(id);
    const m = format?.methods.find((x) => x.id === id);
    if (m) setLevel(m.defaultLevel);
  };

  const browseDest = async () => {
    try {
      const picked = await saveDialog({
        title: "选择压缩包保存位置",
        defaultPath: dest || undefined,
        filters: format
          ? [{ name: format.label, extensions: [format.extension.replace(/^\./, "")] }]
          : undefined,
      });
      if (picked) setDest(picked);
    } catch (err) {
      message.error(describeArchiveError(err).message);
    }
  };

  const submit = async () => {
    if (!format) return;
    if (sources.length === 0) {
      message.warning("没有要压缩的内容");
      return;
    }
    if (dest.trim().length === 0) {
      message.warning("请选择压缩包保存位置");
      return;
    }
    const vol = parseVolumeSizeStrict(volumeText);
    if (!vol.ok) {
      message.error(vol.error);
      return;
    }

    const options: CreateOptions = {
      format: format.id,
      level: bounds.max > 0 ? level : null,
      method: methodId,
      password: password.length > 0 ? password : null,
      // 加密文件名只有 7z 有；别的格式传过去后端会忽略，但界面上就不该让它被勾上
      encryptHeader: format.id === "7z" && format.supportsPassword && encryptHeader,
      solid: format.supportsSolid && solid,
      comment: format.supportsComment && comment.trim().length > 0 ? comment : null,
      volumeSize: vol.bytes,
      storeFullPath,
      excludePatterns: excludeText
        .split(/[\n,;]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    };

    setSubmitting(true);
    try {
      await invoke<string>("archive_create", {
        sources: sources.map((s) => s.path),
        dest,
        options,
      });
      message.success("已开始压缩，进度见右下角");
      onStarted?.();
      onClose();
    } catch (err) {
      message.error(describeArchiveError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const row = (label: string, control: ReactNode, hint?: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <Text style={{ width: 86, flexShrink: 0, color: token.colorTextSecondary }}>
        {hint ? (
          <Tooltip title={hint}>
            <span>{label}</span>
          </Tooltip>
        ) : (
          label
        )}
      </Text>
      <div style={{ flex: 1, minWidth: 0 }}>{control}</div>
    </div>
  );

  return (
    <Modal
      title={`新建压缩包${sources.length > 0 ? `（${sources.length} 项）` : ""}`}
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="开始压缩"
      cancelText="取消"
      confirmLoading={submitting}
      width={520}
      destroyOnHidden
    >
      {row(
        "格式",
        <Select
          style={{ width: "100%" }}
          value={format?.id ?? formatId}
          onChange={onFormatChange}
          options={(formats.length > 0 ? formats : []).map((f) => ({
            value: f.id,
            label: f.label,
          }))}
          optionRender={(o) => {
            const f = formats.find((x) => x.id === o.value);
            return (
              <div>
                <div>{f?.label}</div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {f?.description}
                </Text>
              </div>
            );
          }}
        />,
      )}

      {row(
        "保存到",
        <Space.Compact style={{ width: "100%" }}>
          <Input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="压缩包完整路径" />
          <Button icon={<FolderOpenOutlined />} onClick={browseDest} aria-label="浏览保存位置" />
        </Space.Compact>,
      )}

      {format && format.methods.length > 0 &&
        row(
          "压缩算法",
          <Select
            style={{ width: "100%" }}
            value={methodId ?? format.methods[0]?.id}
            onChange={onMethodChange}
            options={format.methods.map((m) => ({ value: m.id, label: m.label }))}
            optionRender={(o) => {
              const m = format.methods.find((x) => x.id === o.value);
              return (
                <div>
                  <div>{m?.label}</div>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {m?.description}
                  </Text>
                </div>
              );
            }}
          />,
        )}

      {bounds.max > 0 &&
        row(
          "压缩等级",
          <Space>
            <InputNumber
              min={0}
              max={bounds.max}
              value={level}
              onChange={(v) => setLevel(typeof v === "number" ? v : bounds.def)}
              style={{ width: 80 }}
            />
            <Text type="secondary" style={{ fontSize: 11 }}>
              0 = 只打包不压缩，{bounds.max} = 最小体积（最慢）
            </Text>
          </Space>,
        )}

      {format?.supportsPassword &&
        row(
          "密码",
          <Input.Password
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="留空则不加密"
            autoComplete="new-password"
          />,
          "ZIP 用的是 ZipCrypto/AES，7z 用的是 AES-256。密码不存进任何配置，只在这一次压缩里用。",
        )}

      <div style={{ marginBottom: 6 }}>
        <Button type="link" size="small" onClick={() => setAdvanced((a) => !a)} style={{ padding: 0 }}>
          {advanced ? "收起高级选项" : "高级选项"}
        </Button>
      </div>

      {advanced && (
        <div
          style={{
            padding: 10,
            marginBottom: 10,
            background: token.colorFillQuaternary,
            borderRadius: token.borderRadius,
          }}
        >
          {format?.supportsVolumes &&
            row(
              "分卷",
              <Space.Compact style={{ width: "100%" }}>
                <Select
                  style={{ width: 180 }}
                  value={VOLUME_PRESETS.some((p) => p.value === volumeText) ? volumeText : "__custom"}
                  onChange={(v) => setVolumeText(v === "__custom" ? volumeText : v)}
                  options={[
                    ...VOLUME_PRESETS,
                    { label: "自定义…", value: "__custom" },
                  ]}
                />
                <Input
                  value={volumeText}
                  onChange={(e) => setVolumeText(e.target.value)}
                  placeholder="如 700M、4G；留空不分卷"
                />
              </Space.Compact>,
              volumePreview ? `每卷约 ${volumePreview}` : undefined,
            )}

          {format?.supportsSolid &&
            row(
              "Solid 压缩",
              <Switch checked={solid} onChange={setSolid} />,
              "条目之间共享字典，压得更小；代价是从包里单独抽一个文件也要从头解到那一条。",
            )}

          {format?.id === "7z" && format?.supportsPassword && (
            <div style={{ marginBottom: 10 }}>
              <Checkbox
                checked={encryptHeader}
                onChange={(e) => setEncryptHeader(e.target.checked)}
                disabled={password.length === 0}
              >
                同时加密文件名
              </Checkbox>
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  不给密码连目录都列不出来。忘记密码就等于整个包作废。
                </Text>
              </div>
            </div>
          )}

          {format?.supportsComment &&
            row("注释", <Input.TextArea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />)}

          {row(
            "存储完整路径",
            <Switch checked={storeFullPath} onChange={setStoreFullPath} />,
            "关掉时按每个源的父目录算相对路径（等于 7-Zip 的\"添加到压缩包\"）；打开则把 D:\\a\\b 这样的完整层级一起存进去。",
          )}

          {row(
            "排除模式",
            <Input.TextArea
              rows={2}
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              placeholder="每行一个，如 *.tmp、node_modules"
            />,
          )}
        </div>
      )}

      <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 8 }}>
        <Space size={4} wrap>
          {sources.slice(0, 3).map((s) => (
            <Tag key={s.path} icon={s.isDir ? <FolderOutlined /> : undefined}>
              {s.name}
            </Tag>
          ))}
          {sources.length > 3 && <Tag>等 {sources.length} 项</Tag>}
        </Space>
      </div>
    </Modal>
  );
}
