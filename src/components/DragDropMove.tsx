import React, { useState, useCallback } from "react";
import { message } from "antd";
import { useFileStore } from "../stores/fileStore";
import { batchToast, placeBatch } from "../utils/conflictChoice";

export interface DragItem {
  path: string;
  name: string;
  is_dir: boolean;
}

interface DragDropMoveProps {
  /**
   * 拖拽目标的目录路径。空字符串表示拖到当前目录或上一级。
   * - 提供了 targetPath: 行级拖拽（拖到文件夹行）
   * - 未提供 targetPath：容器级拖拽（拖到当前目录空白区域）
   */
  targetPath?: string;
  /**
   * 拖拽目标类型描述（用于调试/提示）
   */
  targetLabel?: string;
  /**
   * 拖拽完成后回调
   */
  onDrop?: () => void;
  /**
   * 包裹的子元素
   */
  children: React.ReactNode;
  /**
   * 自定义样式
   */
  style?: React.CSSProperties;
  /**
   * 自定义类
   */
  className?: string;
}

/**
 * 拖放移动组件
 * - 包裹任何需要作为拖拽目标的文件夹/区域
 * - 拖拽文件/文件夹到目标位置触发移动
 * - 默认使用剪贴板逻辑（cut = move, copy = copy）
 * - 如果拖拽源不是来自当前应用（外源拖拽），则 fallback 到仅移动一个文件
 */
export const DragDropTarget: React.FC<DragDropMoveProps> = ({
  targetPath,
  targetLabel,
  onDrop,
  children,
  style,
  className,
}) => {
  const [isOver, setIsOver] = useState(false);
  const { clipboard, currentPath, clearClipboard } = useFileStore();

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    setIsOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsOver(false);

      const destDir = targetPath ?? currentPath;
      if (!destDir) return;

      // 1. 来自应用内表格行的拖拽（application/x-z-tool-paths）
      const pathsData = e.dataTransfer?.getData("application/x-z-tool-paths");
      if (pathsData) {
        try {
          const paths: string[] = JSON.parse(pathsData);
          const operation = e.dataTransfer?.getData("application/x-z-tool-operation") || "cut";
          const mode: "copy" | "move" = operation === "copy" ? "copy" : "move";
          const done = await placeBatch(destDir, paths.map((src) => ({ src, mode })));
          if (!done) return;
          const toast = batchToast(done, mode === "copy" ? "已复制" : "已移动", targetLabel || destDir);
          if (!toast) return;
          message[toast.kind](toast.text);
          if (toast.refresh) onDrop?.();
          return;
        } catch (err) {
          message.error("拖拽操作失败: " + err);
          return;
        }
      }

      // 2. 来自应用内 DragSource 组件（兼容旧 dataTransfer key）
      const internalData = e.dataTransfer?.getData("application/x-z-tool-files");
      if (internalData) {
        try {
          const items: DragItem[] = JSON.parse(internalData);
          const done = await placeBatch(
            destDir,
            items.map((item) => ({ src: item.path, mode: "move" as const }))
          );
          if (!done) return;
          const toast = batchToast(done, "已移动", targetLabel || destDir);
          if (!toast) return;
          message[toast.kind](toast.text);
          if (toast.refresh) onDrop?.();
          return;
        } catch {
          // ignore
        }
      }

      // 3. 来自剪贴板（用户先复制/剪切，然后用拖拽进行粘贴）
      if (clipboard.length > 0) {
        try {
          const done = await placeBatch(
            destDir,
            clipboard.map((item) => ({
              src: item.path,
              mode: item.operation === "copy" ? ("copy" as const) : ("move" as const),
            }))
          );
          if (!done) return;
          const toast = batchToast(done, "已粘贴", targetLabel || destDir);
          if (!toast) return;
          message[toast.kind](toast.text);
          // 用户取消或全被剔掉时剪贴板要留着，稍后还能贴到别处
          if (toast.refresh) {
            clearClipboard();
            onDrop?.();
          }
          return;
        } catch (err) {
          message.error("粘贴失败: " + err);
          return;
        }
      }

      // 4. 没有任何来源 - 静默忽略
      // （Tauri 的 webview 不会让我们读取外部 file:// 路径 filePath，只能借助 OS API）
    },
    [targetPath, targetLabel, currentPath, clipboard, clearClipboard, onDrop]
  );

  return (
    <div
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        position: "relative",
        transition: "background 0.15s, outline 0.15s",
        outline: isOver ? "2px dashed #1677ff" : "none",
        outlineOffset: -2,
        background: isOver ? "rgba(22, 119, 255, 0.06)" : "transparent",
        ...style,
      }}
      className={className}
    >
      {children}
    </div>
  );
};

/**
 * 拖拽源组件 - 将文件夹/文件设置为可拖拽
 */
export const DragSource: React.FC<{
  item: DragItem;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ item, children, style }) => {
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-z-tool-files", JSON.stringify([item]));
      }
    },
    [item]
  );

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      style={{ cursor: "grab", ...style }}
    >
      {children}
    </div>
  );
};
