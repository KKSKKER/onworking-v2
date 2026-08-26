// 通用右键菜单:固定在鼠标位置,点击外部/按 Esc 关闭。
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 9999 }}
    >
      {menu.items.map((it, i) => (
        <button
          key={i}
          className={`ctx-item${it.danger ? ' danger' : ''}`}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** 鼠标右键事件里取到的坐标 → 菜单状态。 */
export function menuAt(e: ReactMouseEvent, items: ContextMenuItem[]): ContextMenuState {
  return { x: e.clientX, y: e.clientY, items };
}
