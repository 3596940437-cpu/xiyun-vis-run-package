import type { CSSProperties, ReactNode } from 'react';
import { useCallback } from 'react';

interface ResizableSidebarProps {
  width: number;
  minWidth?: number;
  maxWidth?: number;
  onWidthChange: (width: number) => void;
  className?: string;
  style?: CSSProperties;
  borderColor?: string;
  children: ReactNode;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function ResizableSidebar({
  width,
  minWidth = 340,
  maxWidth = 680,
  onWidthChange,
  className = 'sidebar-shell',
  style,
  borderColor,
  children,
}: ResizableSidebarProps) {
  const startResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startWidth = width;

    const move = (moveEvent: PointerEvent) => {
      const nextWidth = clamp(startWidth + startX - moveEvent.clientX, minWidth, maxWidth);
      onWidthChange(nextWidth);
    };

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  }, [maxWidth, minWidth, onWidthChange, width]);

  return (
    <div
      className={className}
      style={{
        ...style,
        width,
        minWidth,
        maxWidth,
        borderLeft: `3px solid ${borderColor || 'transparent'}`,
      }}
    >
      <button
        type="button"
        className="sidebar-resize-handle"
        onPointerDown={startResize}
        aria-label="横向调整侧边栏宽度"
        title="拖动调整侧边栏宽度"
      />
      {children}
    </div>
  );
}
