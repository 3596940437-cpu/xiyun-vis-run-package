import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { PlayDetailResponse } from '../api/client';
import { COLORS, getNodeColor, getRoleTypeColor } from '../constants/theme';
import { AiChatPanel } from './AiChatPanel';
import { ResizableSidebar } from './ResizableSidebar';

interface PlayDetailPanelProps {
  playId: string;
  nodePreview?: Record<string, unknown>;
  onClose: () => void;
  onExploreVersions: () => void;
  onHighlight: (ids: string[], type?: string, options?: { focus?: boolean }) => void;
  width: number;
  onWidthChange: (width: number) => void;
}

const sidebarStyle: CSSProperties = {
  height: '100vh',
  background: COLORS.paper,
  color: COLORS.sidebarText,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  zIndex: 20,
  boxShadow: '-4px 0 24px rgba(0,0,0,0.18)',
};

function splitReason(reason?: string): string[] {
  if (!reason) return [];
  return reason
    .split(/[;；,，、]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 4);
}

export function PlayDetailPanel({
  playId,
  nodePreview,
  onClose,
  onExploreVersions,
  onHighlight,
  width,
  onWidthChange,
}: PlayDetailPanelProps) {
  const [data, setData] = useState<PlayDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.play(playId)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [playId]);

  const play = { ...(nodePreview || {}), ...(data?.play || {}) } as Record<string, unknown>;
  const title = String(play.title || '未知剧目');
  const themes = (play.themes as string[]) || [];
  const borderColor = getNodeColor({ themes, coarse_cluster_id: play.coarse_cluster_id as string });
  const versionCount = (data?.version_summary?.version_count as number) || (play.version_count as number) || 0;
  const versionList = data?.version_summary?.versions || [];

  return (
    <ResizableSidebar
      width={width}
      minWidth={360}
      maxWidth={720}
      onWidthChange={onWidthChange}
      style={sidebarStyle}
      borderColor={borderColor}
    >
      <div className="sidebar-header">
        <h2 className="sidebar-title" style={{ fontSize: 20, flex: 1 }}>
          {title}
        </h2>
        <button type="button" onClick={onClose} className="sidebar-close-btn">关闭</button>
      </div>

      <div className="sidebar-body">
        {loading && <p style={{ color: COLORS.sidebarTextMuted, fontSize: 13 }}>加载剧目详情…</p>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
          {Boolean(play.source_name) && <Tag>来源 {String(play.source_name)}</Tag>}
          {Boolean(play.version_label) && <Tag>{String(play.version_label)}</Tag>}
          {play.role_count != null && <Tag>{String(play.role_count)} 角色</Tag>}
          {versionCount > 1 && <Tag>{versionCount} 个版本</Tag>}
        </div>

        {themes.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {themes.slice(0, 6).map((t) => <Tag key={t}>{t}</Tag>)}
          </div>
        )}

        <section style={{ marginBottom: 14 }}>
          <h4 style={sectionTitle}>情节摘要</h4>
          <div className="paper-prose">
            {String(play.text_summary || '暂无剧情摘要，可向 AI 助手提问。')}
          </div>
        </section>

        {versionList.length > 0 && (
          <section style={{ marginBottom: 14 }}>
            <h4 style={sectionTitle}>来源 / 版本列表</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {versionList.map((v, idx) => (
                  <button
                  key={v.play_id}
                  type="button"
                  onClick={() => onHighlight([v.play_id], 'play')}
                  className={`paper-list-item${v.play_id === playId ? ' active' : ''}`}
                  >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="paper-badge">
                      V{v.version_index ?? idx + 1}
                    </span>
                    <span style={{ fontWeight: 600 }}>{v.title}</span>
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.sidebarTextMuted, marginTop: 4, paddingLeft: 36 }}>
                    来源 {v.source_name || '未知'}
                    {v.version_label ? ` · ${v.version_label}` : ''}
                    {v.role_count != null ? ` · ${v.role_count} 角色` : ''}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {data?.roles && data.roles.length > 0 && (
          <section style={{ marginBottom: 14 }}>
            <h4 style={sectionTitle}>主要角色与行当</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.roles.slice(0, 12).map((r) => (
                <div
                  key={r.role_id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    background: COLORS.sidebarSurface,
                    padding: '8px 12px',
                    borderRadius: 6,
                    borderLeft: `4px solid ${getRoleTypeColor(r.base_role_type)}`,
                    border: `1px solid ${COLORS.sidebarBorder}`,
                    borderLeftWidth: 4,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{r.role_name}</span>
                  <span style={{ fontSize: 11, color: COLORS.sidebarTextMuted }}>{r.base_role_type}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {data?.text_evidence_preview && data.text_evidence_preview.length > 0 && (
          <section style={{ marginBottom: 14 }}>
            <h4 style={sectionTitle}>文本证据片段</h4>
            {data.text_evidence_preview.slice(0, 2).map((ch) => (
              <div key={ch.chunk_id} style={{
                background: COLORS.sidebarSurface,
                padding: 12,
                borderRadius: 6,
                marginBottom: 8,
                fontSize: 12,
                lineHeight: 1.5,
                color: COLORS.sidebarTextMuted,
                border: `1px solid ${COLORS.sidebarBorder}`,
              }}>
                {ch.evidence?.section && (
                  <div style={{ color: COLORS.sidebarAccent, marginBottom: 4, fontWeight: 600 }}>{ch.evidence.section}</div>
                )}
                {ch.text.slice(0, 120)}{ch.text.length > 120 ? '…' : ''}
              </div>
            ))}
          </section>
        )}

        {data?.neighbors && data.neighbors.length > 0 && (
          <section style={{ marginBottom: 14 }}>
            <h4 style={sectionTitle}>相似邻近剧目</h4>
            <p style={{ margin: '0 0 8px', fontSize: 11, color: COLORS.sidebarTextMuted, lineHeight: 1.5 }}>
              邻近关系由主题文本、角色行当、来源版本和角色网络等特征共同计算；用于解释星云中“靠近”的文化含义。
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.neighbors.slice(0, 5).map((n) => (
                <button
                  key={n.play_id}
                  type="button"
                  onClick={() => onHighlight([n.play_id], 'play')}
                  style={{
                    textAlign: 'left',
                    background: COLORS.sidebarSurface,
                    border: `1px solid ${COLORS.sidebarBorder}`,
                    borderRadius: 6,
                    padding: '8px 12px',
                    color: COLORS.sidebarText,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{n.title}</span>
                    {n.weight != null && (
                      <span style={{ fontSize: 10, color: COLORS.sidebarAccent, flexShrink: 0 }}>
                        相似度 {Math.round(n.weight * 100)}%
                      </span>
                    )}
                  </div>
                  {splitReason(n.similarity_reason).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
                      {splitReason(n.similarity_reason).map((reason, idx) => (
                        <span key={idx} style={miniEvidenceTagStyle}>{reason}</span>
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}

        {versionCount > 1 && (
          <button
            type="button"
            onClick={onExploreVersions}
            className="paper-action"
            style={{ width: '100%', marginBottom: 16, background: borderColor }}
          >
            探索版本传承
          </button>
        )}
      </div>

      <AiChatPanel
        context={{
          play_id: playId,
          play_title: title,
          play_group_id: String(play.play_group_id || ''),
          cluster_id: String(play.cluster_id || ''),
          coarse_cluster_id: String(play.coarse_cluster_id || ''),
          source_name: String(play.source_name || ''),
        }}
        playTitle={title}
        onHighlight={onHighlight}
        collapsible
        defaultExpanded={false}
        resizable
        initialHeight={340}
        minHeight={220}
        maxHeight={620}
      />
    </ResizableSidebar>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="paper-tag">
      {children}
    </span>
  );
}

const sectionTitle: CSSProperties = {
  margin: '0 0 8px',
  fontSize: 12,
  color: COLORS.sidebarAccent,
  fontWeight: 600,
};

const miniEvidenceTagStyle: CSSProperties = {
  background: 'rgba(163, 58, 43, 0.08)',
  border: `1px solid ${COLORS.sidebarBorder}`,
  borderRadius: 10,
  color: COLORS.sidebarTextMuted,
  fontSize: 10,
  padding: '2px 7px',
};
