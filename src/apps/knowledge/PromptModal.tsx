// 受控输入弹窗：新建目录 / 重命名这类「要填个字」的确认框。
//
// 为什么不用 modal.confirm + 内嵌 Input：antd v6 的 confirm 在 onOk 返回
// rejected promise 时会把拒绝**重新抛出**（ActionButton.handlePromiseOnOk），
// 于是任何一次表单校验失败都会变成未处理的 Promise 拒绝 —— 配合 boot-guard
// 曾经直接把整个窗口糊成错误页。这里改成受控 open，校验不过就不关。
import { useEffect, useState } from "react";
import { App as AntdApp, Input, Modal } from "antd";

export interface PromptState {
  title: string;
  defaultValue?: string;
  placeholder?: string;
  okText?: string;
  onOk: (value: string) => Promise<void>;
}

export default function PromptModal({
  state,
  onClose,
}: {
  state: PromptState | null;
  onClose: () => void;
}) {
  const { message: msgApi } = AntdApp.useApp();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state) {
      setValue(state.defaultValue ?? "");
      setBusy(false);
    }
  }, [state]);

  if (!state) return null;

  async function handleOk() {
    const text = value.trim();
    if (!text) {
      msgApi.warning("内容不能为空");
      return;
    }
    setBusy(true);
    try {
      await state!.onOk(text);
      onClose();
    } catch (e) {
      msgApi.error(`${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={state.title}
      open
      onCancel={onClose}
      onOk={() => void handleOk()}
      okText={state.okText ?? "确定"}
      confirmLoading={busy}
      destroyOnHidden
    >
      <Input
        autoFocus
        value={value}
        placeholder={state.placeholder ?? "请输入"}
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={() => void handleOk()}
      />
    </Modal>
  );
}
