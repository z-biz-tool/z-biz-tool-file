import { useState, useEffect, useRef, useCallback } from "react";
import { Input, theme } from "antd";
import { invoke } from "@tauri-apps/api/core";

interface CommandResult {
  stdout: string;
  stderr: string;
  success: boolean;
}

interface TerminalLine {
  type: "prompt" | "stdout" | "stderr" | "error" | "info";
  content: string;
}

interface BuiltInTerminalProps {
  currentPath: string;
  onPathChange: (path: string) => void;
  visible: boolean;
  onClose: () => void;
}

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 240;
const MAX_HEIGHT = 600;

export default function BuiltInTerminal({
  currentPath,
  onPathChange,
  visible,
  onClose,
}: BuiltInTerminalProps) {
  const { token } = theme.useToken();
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [input, setInput] = useState("");
  const [executing, setExecuting] = useState(false);
  const [workingDir, setWorkingDir] = useState(currentPath);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  // Sync working directory with currentPath
  useEffect(() => {
    setWorkingDir(currentPath);
  }, [currentPath]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  // Focus input when terminal becomes visible
  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible]);

  const addLine = useCallback((type: TerminalLine["type"], content: string) => {
    setLines((prev) => [...prev, { type, content }]);
  }, []);

  const resolvePath = useCallback(
    (target: string): string => {
      if (target.startsWith("/")) return target;
      if (target === "~") {
        return "/Users/zifang";
      }
      if (target.startsWith("~/")) {
        return "/Users/zifang" + target.slice(1);
      }
      // Relative path
      const parts = workingDir.split("/").filter(Boolean);
      target.split("/").forEach((segment) => {
        if (segment === "..") {
          parts.pop();
        } else if (segment !== ".") {
          parts.push(segment);
        }
      });
      return "/" + parts.join("/");
    },
    [workingDir]
  );

  const executeCommand = useCallback(async () => {
    const cmd = input.trim();
    if (!cmd) return;

    setInput("");
    setHistory((prev) => [...prev, cmd]);
    setHistoryIndex(-1);

    // Show prompt line
    addLine("prompt", `${workingDir} $ ${cmd}`);

    // Handle built-in commands
    if (cmd === "clear") {
      setLines([]);
      return;
    }

    if (cmd.startsWith("cd ")) {
      const target = cmd.slice(3).trim();
      if (!target) {
        // cd with no args - go to home
        setWorkingDir("/Users/zifang");
        onPathChange("/Users/zifang");
        return;
      }
      const resolved = resolvePath(target);
      // Verify the directory exists by trying to list it
      try {
        await invoke("list_directory", { path: resolved });
        setWorkingDir(resolved);
        onPathChange(resolved);
      } catch {
        addLine("error", `cd: no such directory: ${target}`);
      }
      return;
    }

    if (cmd === "cd") {
      setWorkingDir("/Users/zifang");
      onPathChange("/Users/zifang");
      return;
    }

    // Execute via backend
    setExecuting(true);
    try {
      const result = await invoke<CommandResult>("execute_command", {
        command: cmd,
        workingDir: workingDir,
      });
      if (result.stdout) {
        addLine("stdout", result.stdout);
      }
      if (result.stderr) {
        addLine("stderr", result.stderr);
      }
      if (!result.success && !result.stderr) {
        addLine("error", `命令执行失败 (exit code non-zero)`);
      }
    } catch (err) {
      addLine("error", String(err));
    } finally {
      setExecuting(false);
    }
  }, [input, workingDir, addLine, resolvePath, onPathChange]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      executeCommand();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length > 0) {
        const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setInput(history[newIndex]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex !== -1) {
        const newIndex = historyIndex + 1;
        if (newIndex >= history.length) {
          setHistoryIndex(-1);
          setInput("");
        } else {
          setHistoryIndex(newIndex);
          setInput(history[newIndex]);
        }
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    }
  };

  // Resize drag handlers
  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartY.current = e.clientY;
    dragStartHeight.current = height;

    const handleDragMove = (moveEvent: MouseEvent) => {
      if (!isDragging.current) return;
      // Dragging up increases height (bottom-anchored terminal)
      const delta = dragStartY.current - moveEvent.clientY;
      const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragStartHeight.current + delta));
      setHeight(newHeight);
    };

    const handleDragEnd = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", handleDragMove);
      document.removeEventListener("mouseup", handleDragEnd);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleDragMove);
    document.addEventListener("mouseup", handleDragEnd);
  };

  if (!visible) return null;

  const lineColor = (type: TerminalLine["type"]): string => {
    switch (type) {
      case "prompt":
        return "#6a9955";
      case "stdout":
        return "#d4d4d4";
      case "stderr":
        return "#ce9178";
      case "error":
        return "#f44747";
      case "info":
        return "#569cd6";
    }
  };

  return (
    <div
      style={{
        height,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#1e1e1e",
        borderTop: `2px solid ${token.colorBorderSecondary}`,
        position: "relative",
        flexShrink: 0,
      }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={handleDragStart}
        style={{
          position: "absolute",
          top: -4,
          left: 0,
          right: 0,
          height: 8,
          cursor: "ns-resize",
          zIndex: 10,
        }}
      />

      {/* Header bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "2px 12px",
          backgroundColor: "#2d2d2d",
          borderBottom: "1px solid #3c3c3c",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#cccccc", fontSize: 12, fontFamily: "monospace" }}>
          TERMINAL
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#cccccc",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            padding: "0 4px",
          }}
          title="关闭终端"
        >
          ✕
        </button>
      </div>

      {/* Output area */}
      <div
        ref={outputRef}
        onClick={() => inputRef.current?.focus()}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "4px 12px",
          fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {lines.map((line, i) => (
          <div key={i} style={{ color: lineColor(line.type) }}>
            {line.content}
          </div>
        ))}
        {/* Input line */}
        <div style={{ display: "flex", alignItems: "center", color: "#6a9955" }}>
          <span style={{ flexShrink: 0 }}>{workingDir} $&nbsp;</span>
          <Input
            ref={inputRef as never}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={executing}
            variant="borderless"
            style={{
              flex: 1,
              fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
              fontSize: 13,
              color: "#d4d4d4",
              background: "transparent",
              padding: 0,
              caretColor: "#d4d4d4",
            }}
          />
        </div>
      </div>
    </div>
  );
}
