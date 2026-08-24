// 可拖动调宽的侧边栏(参考 V1 ResizableSidebar):右侧把手拖动改变宽度。
import { useRef, useState, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  initialWidth: number;
  minWidth?: number;
  maxWidth?: number;
  side?: 'left' | 'right';
}

export function ResizableSidebar({ children, initialWidth, minWidth = 160, maxWidth = 700, side = 'left' }: Props) {
  const [width, setWidth] = useState(initialWidth);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  function startDrag(e: React.MouseEvent): void {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    const onMove = (ev: MouseEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      const delta = side === 'left' ? ev.clientX - d.startX : d.startX - ev.clientX;
      setWidth(Math.max(minWidth, Math.min(maxWidth, d.startW + delta)));
    };
    const onUp = (): void => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <>
      <div style={{ width, flexShrink: 0, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
        {children}
      </div>
      <div
        onMouseDown={startDrag}
        style={{ width: 5, flexShrink: 0, cursor: 'col-resize', background: 'transparent' }}
        title="拖动调整宽度"
      />
    </>
  );
}
