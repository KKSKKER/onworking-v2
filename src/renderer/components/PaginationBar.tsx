// 分页条(参考 V1 PaginationBar):上一页/下一页 + 页码 + 总行数。
interface PaginationBarProps {
  page: number; // 0-based
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function PaginationBar({ page, pageSize, total, onPageChange }: PaginationBarProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, totalPages - 1);
  const btnStyle: React.CSSProperties = {
    border: '1px solid #ccc',
    background: '#fff',
    borderRadius: 3,
    padding: '1px 10px',
    fontSize: 11,
    cursor: 'pointer',
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 12px',
        borderBottom: '1px solid #eee',
        fontSize: 11,
        color: '#666',
      }}
    >
      <span>
        第 {cur + 1} / {totalPages} 页
      </span>
      <button
        onClick={() => onPageChange(cur - 1)}
        disabled={cur <= 0}
        style={{ ...btnStyle, cursor: cur <= 0 ? 'default' : 'pointer', opacity: cur <= 0 ? 0.4 : 1 }}
      >
        上一页
      </button>
      <button
        onClick={() => onPageChange(cur + 1)}
        disabled={cur >= totalPages - 1}
        style={{
          ...btnStyle,
          cursor: cur >= totalPages - 1 ? 'default' : 'pointer',
          opacity: cur >= totalPages - 1 ? 0.4 : 1,
        }}
      >
        下一页
      </button>
      <span>
        共 {total} 行 · 每页 {pageSize} 行
      </span>
    </div>
  );
}
