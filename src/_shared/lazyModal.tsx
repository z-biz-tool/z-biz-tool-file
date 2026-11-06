import React, { Suspense, lazy, useEffect, useState } from "react";

/**
 * 把一个「靠 open 显隐的弹窗」从启动包里拆出去。
 *
 * ## 为什么需要它
 *
 * 2026-11-06 那轮性能排查实测到：应用启动时 WebContent 进程烧掉 6.6 秒 CPU，
 * `sample` 抓到的热点是 JSC 的 DFG 编译（`ByteCodeParser` / `B3 优化`）
 * 与首屏布局绘制（`RenderBlock::layout` / `paint`）。
 * 根因是主 bundle 1.7MB，而首屏真正需要的只是
 * Layout / Button / Input / Table 那一小撮。
 *
 * 逐个文件用 sourcemap 归因后发现，主 chunk 里排第一的不是 antd 本体，
 * 而是 **App.tsx 静态 import 的 30+ 个功能组件** —— 归档浏览器、PDF 工具、
 * OCR、差异对比、媒体库… 这些全是「点开才用」的功能，却全部躺在首屏包里。
 *
 * ## 为什么不能只写 `lazy()`
 *
 * `lazy()` 只是把模块求值推迟到**首次渲染**时。但这些弹窗的写法是
 * 「常挂载 + 靠 `open` prop 显隐」—— 组件在 App.tsx 里**无条件渲染**，
 * 只是 `open=false` 时 Modal 自己不显示。
 * 于是 `lazy()` 的组件在**首帧就会触发求值**，拆包等于白拆：
 * `React.lazy` 在渲染时就会发起 import，哪怕最终返回 null。
 *
 * 所以这里补上「open 为真才挂载」这一层：
 * - `open=false` → 根本不渲染 → 不发起 import → 首屏不下载；
 * - `open=true` → 挂载并渲染 → 触发 import → 期间显示 fallback。
 *
 * ## 语义保持：关掉后不卸载
 *
 * Modal 靠 `open` 做进出场动画（淡入淡出）。如果 open 一变假就立刻卸载，
 * 淡出动画会被砍掉、面板内部的状态也会丢。
 * 所以这里记住「曾经打开过」，之后一直保持挂载 ——
 * 与 `apps/terminal/_shared/lazyPanel.tsx` 是同一套思路。
 */
export function lazyModal<P extends { open?: boolean }>(
  load: () => Promise<{ default: React.ComponentType<P> }>,
  /** 加载中的占位。默认不显示任何东西（Modal 还没开，没什么可提示的） */
  fallback: React.ReactNode = null,
) {
  const Modal = lazy(load);
  return function LazyModal(props: P) {
    const [mounted, setMounted] = useState(Boolean(props.open));
    useEffect(() => {
      if (props.open) setMounted(true);
    }, [props.open]);
    if (!mounted) return null;
    return (
      <Suspense fallback={fallback}>
        <Modal {...props} />
      </Suspense>
    );
  };
}
