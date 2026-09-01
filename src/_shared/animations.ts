/**
 * 动画配置和工具函数 - 提供丝滑的交互体验
 */

// 动画时长配置
export const ANIMATION_DURATIONS = {
  quick: '150ms',
  normal: '250ms',
  slow: '350ms',
} as const;

// 动画缓动函数
export const ANIMATION_EASING = {
  smooth: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
  bouncy: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  gentle: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
} as const;

// 折叠面板动画
export const collapsibleAnimation = {
  transition: `height ${ANIMATION_DURATIONS.normal} ${ANIMATION_EASING.smooth}, opacity ${ANIMATION_DURATIONS.quick} ${ANIMATION_EASING.smooth}`,
};

// 悬浮动画
export const hoverAnimation = {
  transition: `transform ${ANIMATION_DURATIONS.quick} ${ANIMATION_EASING.smooth}, box-shadow ${ANIMATION_DURATIONS.normal} ${ANIMATION_EASING.smooth}`,
  hover: {
    transform: 'translateY(-2px)',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
  },
};

// 淡入淡出
export const fadeInOut = (duration: string = ANIMATION_DURATIONS.normal) => ({
  animation: `${duration} ease-in-out`,
});

// 虚拟滚动优化配置
export const virtualScrollConfig = {
  bufferSize: 20, // 缓冲区大小
  viewportThreshold: 1.5, // 视口阈值
  debounceDelay: 50, // 防抖延迟(ms)
};

// 滚动优化
export const smoothScroll = {
  behavior: 'smooth' as const,
};

// 拖拽动画
export const dragAnimation = {
  dragStart: {
    opacity: 0.5,
    transform: 'scale(1.02)',
  },
  dragging: {
    cursor: 'grabbing',
  },
  dragEnd: {
    transition: `all ${ANIMATION_DURATIONS.quick} ${ANIMATION_EASING.bouncy}`,
  },
};

// 状态变化动画
export const stateTransition = (duration: string = ANIMATION_DURATIONS.normal) => ({
  transition: `all ${duration} ${ANIMATION_EASING.smooth}`,
});
