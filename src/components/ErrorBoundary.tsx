import React from "react";
import { Button, Result } from "antd";

interface ErrorBoundaryState {
  error: Error | null;
}

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 出错时显示在哪一层：局部区域（文件网格）用 inline，整页用整屏 Result */
  inline?: boolean;
  /** 参与重置的 key：切目录/换 tab 时旧的异常不该一直挡着 */
  resetKey?: string | null;
}

/**
 * 顶层与局部错误边界。
 *
 * 没有它的时候，一行渲染异常（比如某个条目字段是 undefined）会把整棵树卸载成白屏，
 * 用户只能重启应用。这里把异常收在出事的那块区域里，给一个"重试"，
 * 让用户不重启也能继续干活。
 */
export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("渲染异常:", error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const body = (
      <Result
        status="error"
        title="这一片显示出错了"
        subTitle={error.message || "未知异常"}
        extra={
          <Button type="primary" autoFocus onClick={() => this.setState({ error: null })}>
            重试
          </Button>
        }
      />
    );
    if (!this.props.inline) return body;
    return (
      <div style={{ padding: 8, height: "100%", overflow: "auto" }}>{body}</div>
    );
  }
}
