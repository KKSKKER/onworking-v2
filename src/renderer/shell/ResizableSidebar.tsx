// 通用可拖动面板:左/右侧栏(横向宽度)与底部面板(纵向高度)共用。
import { useRef, useState, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  axis: 'x' | 'y';
  /** 初始宽度(x)/高度(y)。 */
  initial: number;
  min?: number;
  max?: number;
  /** 拖哪条边:右/下边缘正向,左/上边缘反向。 */
  dragEdge: 'left' | 'right' | 'top' | 'bottom';
}

export function ResizablePanel({ children, axis, initial, min = 80, max = 800, dragEdge }: Props) {
  const [size, setSize] = useState(initial);
  const dragRef = useRef<{ start: number; startSize: number } | null>(null);

  function startDrag(e: React.MouseEvent): void {
    e.preventDefault();
    dragRef.current = {
      start: axis === 'x' ? e.clientX : e.clientY,
      startSize: size,
    };
    const onMove = (ev: MouseEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      const pos = axis === 'x' ? ev.clientX : ev.clientY;
      let delta = pos - d.start;
      if (dragEdge === 'left' || dragEdge === 'top') delta = -delta;
      setSize(Math.max(min, Math.min(max, d.startSize + delta)));
    };
    const onUp = (): void => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const sizeStyle = axis === 'x' ? { width: size } : { height: size };
  const handleStyle =
    axis === 'x'
      ? { width: 5, cursor: 'col-resize' }
      : { height: 5, cursor: 'row-resize' };

  return (
    <>
      {(dragEdge === 'left' || dragEdge === 'top') && (
        <div className="resize-handle" onMouseDown={startDrag} style={handleStyle} />
      )}
      <div style={{ ...sizeStyle, flexShrink: 0, overflow: 'auto', boxSizing: 'border-box' }}>
        {children}
      </div>
      {(dragEdge === 'right' || dragEdge === 'bottom') && (
        <div className="resize-handle" onMouseDown={startDrag} style={handleStyle} />
      )}
    </>
  );
}
