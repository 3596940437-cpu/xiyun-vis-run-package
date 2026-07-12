import { COLORS } from '../constants/theme';
import { AiChatPanel } from './AiChatPanel';
import { ResizableSidebar } from './ResizableSidebar';

interface GlobalAiPanelProps {
  onClose: () => void;
  onHighlight: (ids: string[], type?: string) => void;
  width: number;
  onWidthChange: (width: number) => void;
}

export function GlobalAiPanel({ onClose, onHighlight, width, onWidthChange }: GlobalAiPanelProps) {
  return (
    <ResizableSidebar
      width={width}
      minWidth={360}
      maxWidth={720}
      onWidthChange={onWidthChange}
      borderColor={COLORS.sidebarAccent}
      style={{
        height: '100vh',
        background: COLORS.paper,
        color: COLORS.sidebarText,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 25,
        boxShadow: '-4px 0 24px rgba(0,0,0,0.18)',
      }}
    >
      <div className="sidebar-header" style={{ alignItems: 'center' }}>
        <h2 className="sidebar-title" style={{ fontSize: 18 }}>
          AI 京剧导览
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="sidebar-close-btn"
        >
          关闭
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <AiChatPanel onHighlight={onHighlight} expanded collapsible={false} />
      </div>
    </ResizableSidebar>
  );
}
