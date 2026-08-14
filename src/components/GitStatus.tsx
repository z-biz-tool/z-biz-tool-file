import { useState, useEffect, useCallback } from "react";
import { Tag, Badge, Popover, List, Spin, theme } from "antd";
import {
  BranchesOutlined,
  FileOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

interface CommandResult {
  stdout: string;
  stderr: string;
  success: boolean;
}

interface GitFileInfo {
  status: string;
  path: string;
}

interface Props {
  currentPath: string;
}

export default function GitStatus({ currentPath }: Props) {
  const { token } = theme.useToken();
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [branch, setBranch] = useState("");
  const [files, setFiles] = useState<GitFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const checkGitRepo = useCallback(async (path: string) => {
    if (!path) {
      setIsGitRepo(false);
      return;
    }
    try {
      const result = await invoke<CommandResult>("execute_command", {
        command: "git rev-parse --is-inside-work-tree",
        workingDir: path,
      });
      setIsGitRepo(result.success && result.stdout.trim() === "true");
    } catch {
      setIsGitRepo(false);
    }
  }, []);

  const fetchBranch = useCallback(async (path: string) => {
    try {
      const result = await invoke<CommandResult>("execute_command", {
        command: "git rev-parse --abbrev-ref HEAD",
        workingDir: path,
      });
      if (result.success) {
        setBranch(result.stdout.trim());
      }
    } catch {
      setBranch("");
    }
  }, []);

  const fetchStatus = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const result = await invoke<CommandResult>("execute_command", {
        command: "git status --porcelain",
        workingDir: path,
      });
      if (result.success && result.stdout.trim()) {
        const lines = result.stdout.trim().split("\n");
        const gitFiles: GitFileInfo[] = lines
          .filter((line) => line.length >= 4)
          .map((line) => ({
            status: line.substring(0, 2).trim(),
            path: line.substring(3),
          }));
        setFiles(gitFiles);
      } else {
        setFiles([]);
      }
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setIsGitRepo(false);
    setBranch("");
    setFiles([]);
    checkGitRepo(currentPath);
  }, [currentPath, checkGitRepo]);

  useEffect(() => {
    if (isGitRepo) {
      fetchBranch(currentPath);
      fetchStatus(currentPath);
    }
  }, [isGitRepo, currentPath, fetchBranch, fetchStatus]);

  if (!isGitRepo) return null;

  const modifiedCount = files.filter((f) =>
    f.status.includes("M")
  ).length;
  const untrackedCount = files.filter((f) =>
    f.status.includes("?")
  ).length;
  const totalCount = files.length;

  const statusLabel = (status: string): { text: string; color: string } => {
    if (status.includes("?")) return { text: "未跟踪", color: "#8c8c8c" };
    if (status.includes("D")) return { text: "已删除", color: "#ff4d4f" };
    if (status.includes("R")) return { text: "重命名", color: "#722ed1" };
    if (status.includes("A")) return { text: "新增", color: "#52c41a" };
    if (status.includes("M")) return { text: "已修改", color: "#faad14" };
    return { text: status, color: "#8c8c8c" };
  };

  const popoverContent = (
    <div style={{ width: 280, maxHeight: 300, overflow: "auto" }}>
      {loading ? (
        <div style={{ textAlign: "center", padding: 16 }}>
          <Spin size="small" />
        </div>
      ) : files.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: 16,
            color: token.colorTextSecondary,
            fontSize: 12,
          }}
        >
          工作区干净，无变更
        </div>
      ) : (
        <List
          size="small"
          split={false}
          dataSource={files}
          renderItem={(f) => {
            const label = statusLabel(f.status);
            return (
              <List.Item style={{ padding: "4px 0", fontSize: 12 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    overflow: "hidden",
                    width: "100%",
                  }}
                >
                  <Tag
                    style={{
                      fontSize: 10,
                      lineHeight: "16px",
                      padding: "0 4px",
                      margin: 0,
                      color: label.color,
                      borderColor: label.color,
                      background: "transparent",
                      flexShrink: 0,
                    }}
                  >
                    {label.text}
                  </Tag>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: token.colorText,
                    }}
                  >
                    {f.path}
                  </span>
                </div>
              </List.Item>
            );
          }}
        />
      )}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          <BranchesOutlined />
          <span>Git 状态</span>
        </div>
      }
      content={popoverContent}
      trigger="click"
      placement="bottomRight"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          padding: "2px 8px",
          borderRadius: token.borderRadiusSM,
          transition: "background 0.2s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.backgroundColor =
            token.colorBgTextHover;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.backgroundColor =
            "transparent";
        }}
      >
        <Tag
          icon={<BranchesOutlined />}
          color="blue"
          style={{ margin: 0, fontSize: 11, lineHeight: "18px", padding: "0 6px" }}
        >
          {branch}
        </Tag>
        {totalCount > 0 && (
          <Badge
            count={totalCount}
            size="small"
            style={{ fontSize: 10 }}
            title={`${modifiedCount} 已修改, ${untrackedCount} 未跟踪`}
          >
            <ExclamationCircleOutlined
              style={{ fontSize: 14, color: modifiedCount > 0 ? "#faad14" : "#8c8c8c" }}
            />
          </Badge>
        )}
        {totalCount === 0 && (
          <FileOutlined style={{ fontSize: 12, color: "#52c41a" }} />
        )}
      </div>
    </Popover>
  );
}
