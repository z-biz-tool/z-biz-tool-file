import React, { useState, useCallback } from "react";
import { message } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { useFileStore } from "../stores/fileStore";

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
          let count = 0;
          for (const src of paths) {
            if (src === destDir) continue;
            if (destDir.startsWith(src + "/")) continue;
            if (operation === "copy") {
              await invoke("copy_file", { srcPath: src, destDir });
            } else {
              await invoke("move_file", { srcPath: src, destDir });
            }
            count++;
          }
          if (count > 0) {
            message.success(`${operation === "copy" ? "已复制" : "已移动"} ${count} 项到 ${targetLabel || destDir}`);
            onDrop?.();
          }
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
          let moved = 0;
          for (const item of items) {
            if (item.path === destDir) continue;
            if (destDir.startsWith(item.path + "/")) continue;
            await invoke("move_file", { srcPath: item.path, destDir });
            moved += 1;
          }
          if (moved > 0) {
            message.success(`已移动 ${moved} 项到 ${targetLabel || destDir}`);
            onDrop?.();
          }
          return;
        } catch {
          // ignore
        }
      }

      // 3. 来自剪贴板（用户先复制/剪切，然后用拖拽进行粘贴）
      if (clipboard.length > 0) {
        try {
          let count = 0;
          for (const item of clipboard) {
            if (item.path === destDir) continue;
            if (destDir.startsWith(item.path + "/")) continue;
            if (item.operation === "copy") {
              await invoke("copy_file", { srcPath: item.path, destDir });
            } else {
              await invoke("move_file", { srcPath: item.path, destDir });
            }
            count++;
          }
          if (count > 0) {
            message.success(`已粘贴 ${count} 项到 ${targetLabel || destDir}`);
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
