import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { SearchItem } from '../api/client';
import { COLORS } from '../constants/theme';

interface SearchBarProps {
  onSelect: (item: SearchItem) => void;
}

export function SearchBar({ onSelect }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) {
      setItems([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.search(query.trim(), 12);
        setItems(res.items);
        setOpen(res.items.length > 0);
      } catch {
        setItems([]);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    }, 280);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  return (
    <div className="search-shell">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => items.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="搜索剧目、角色、主题…"
        className="search-input"
      />
      {loading && (
        <span className="search-loading" style={{ color: COLORS.textMuted }}>
          搜索中…
        </span>
      )}
      {open && items.length > 0 && (
        <div className="search-results">
          {items.map((item) => (
            <button
              key={item.play_id}
              type="button"
              onClick={() => {
                onSelect(item);
                setQuery(item.title);
                setOpen(false);
              }}
              className="search-result"
            >
              <div style={{ fontWeight: 600, color: COLORS.searchHit }}>{item.title}</div>
              <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4 }}>{item.snippet}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
