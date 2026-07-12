import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import type { ClusterDetailResponse } from '../api/client';
import { COLORS, getNodeColor } from '../constants/theme';
import { AiChatPanel } from './AiChatPanel';
import { ResizableSidebar } from './ResizableSidebar';

interface ClusterPanelProps {
  clusterId: string;
  onClose: () => void;
  onSelectPlay: (playId: string) => void;
  width: number;
  onWidthChange: (width: number) => void;
}

type CountItem = { name: string; count: number } | string;

function itemName(item: CountItem): string {
  return typeof item === 'string' ? item : item.name;
}

function itemCount(item: CountItem): number | null {
  return typeof item === 'string' ? null : item.count;
}

export function ClusterPanel({ clusterId, onClose, onSelectPlay, width, onWidthChange }: ClusterPanelProps) {
  const [data, setData] = useState<ClusterDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.cluster(clusterId)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [clusterId]);

  const cluster = data?.cluster;
  const explanation = data?.explanation;
  const summary = explanation?.summary || cluster?.explanation;

  const representativeRoles = useMemo(() => {
    const roles = new Set<string>();
    for (const play of data?.representative_plays || []) {
      for (const r of play.main_roles || []) roles.add(r);
    }
    if (roles.size === 0) {
      for (const n of data?.nodes || []) {
        for (const r of n.main_roles || []) {
          roles.add(r);
          if (roles.size >= 8) break;
        }
        if (roles.size >= 8) break;
      }
    }
    return [...roles].slice(0, 8);
  }, [data]);

  const topSources = useMemo(() => {
    const fromCluster = cluster?.top_sources?.map(itemName) || [];
    if (fromCluster.length > 0) return fromCluster.slice(0, 6);
    const evidence = explanation?.evidence as { top_sources?: CountItem[] } | undefined;
    return (evidence?.top_sources || []).map(itemName).slice(0, 6);
  }, [cluster, explanation]);

  const evidenceRows = useMemo(() => {
    if (!cluster) return [];
    return [
      { label: '主题依据', items: cluster.top_themes || [] },
      { label: '关键词依据', items: cluster.top_keywords || [] },
      { label: '行当结构', items: cluster.top_role_types || [] },
      { label: '来源分布', items: cluster.top_sources || [] },
    ].filter((row) => row.items.length > 0);
  }, [cluster]);

  return (
    <ResizableSidebar
      width={width}
      minWidth={360}
      maxWidth={680}
      onWidthChange={onWidthChange}
      borderColor={COLORS.sidebarAccent}
      style={{
        height: '100vh',
        background: COLORS.paper,
        color: COLORS.sidebarText,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 20,
        boxShadow: '-4px 0 24px rgba(0,0,0,0.18)',
      }}
    >
      <div className="sidebar-header" style={{
        padding: '16px 20px',
        borderBottom: `1px solid ${COLORS.sidebarBorder}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <h2 className="sidebar-title" style={{ fontSize: 18 }}>星团详情</h2>
        <button type="button" onClick={onClose} className="sidebar-close-btn">关闭</button>
      </div>

      <div className="sidebar-body">
        {loading && <p style={{ color: COLORS.sidebarTextMuted }}>加载星团数据…</p>}
        {error && <p style={{ color: '#c0392b' }}>{error}</p>}

        {cluster && (
          <>
            <h3 style={{ margin: '0 0 8px', fontSize: 20, color: COLORS.sidebarAccent, fontFamily: "'Noto Serif SC', serif" }}>
              {cluster.cluster_name}
            </h3>
            <p style={{ fontSize: 12, color: COLORS.sidebarTextMuted, marginBottom: 16 }}>
              {cluster.node_count} 个剧目 · {cluster.coarse_cluster_name || cluster.coarse_cluster_id}
            </p>

            {summary && (
              <Section title="聚合解释">
                <div className="paper-prose">{summary}</div>
              </Section>
            )}

            {evidenceRows.length > 0 && (
              <Section title="聚类证据">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {evidenceRows.map((row) => (
                    <div key={row.label} className="paper-card-soft" style={{ padding: 10 }}>
                      <div style={{ fontSize: 11, color: COLORS.sidebarAccent, fontWeight: 700, marginBottom: 6 }}>
                        {row.label}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {row.items.slice(0, 6).map((item, i) => {
                          const count = itemCount(item);
                          const pct = count && cluster.node_count ? Math.round((count / cluster.node_count) * 100) : null;
                          return (
                            <span key={`${row.label}-${i}`} className="paper-tag">
                              {itemName(item)}{count ? ` ${count}` : ''}{pct ? ` / ${pct}%` : ''}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {representativeRoles.length > 0 && (
              <Section title="代表角色">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {representativeRoles.map((r) => (
                    <span key={r} className="paper-tag">{r}</span>
                  ))}
                </div>
              </Section>
            )}

            {topSources.length > 0 && (
              <Section title="主要来源">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {topSources.map((s) => (
                    <span key={s} className="paper-tag">{s}</span>
                  ))}
                </div>
              </Section>
            )}

            {cluster.representative_titles && cluster.representative_titles.length > 0 && (
              <Section title="代表剧目">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {cluster.representative_titles.map((t, i) => (
                    <span key={i} className="paper-tag">{t}</span>
                  ))}
                </div>
              </Section>
            )}

            {cluster.top_themes && cluster.top_themes.length > 0 && (
              <Section title="高频主题">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {cluster.top_themes.slice(0, 8).map((t, i) => (
                    <span key={i} className="paper-tag">{itemName(t)}</span>
                  ))}
                </div>
              </Section>
            )}

            {cluster.top_role_types && cluster.top_role_types.length > 0 && (
              <Section title="高频行当">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {cluster.top_role_types.slice(0, 6).map((t, i) => (
                    <span key={i} className="paper-tag">{itemName(t)}</span>
                  ))}
                </div>
              </Section>
            )}

            <Section title="AI 导览">
              <AiChatPanel
                context={{
                  cluster_id: cluster.cluster_id,
                  cluster_name: cluster.cluster_name,
                  coarse_cluster_id: cluster.coarse_cluster_id,
                  coarse_cluster_name: cluster.coarse_cluster_name,
                }}
                onHighlight={(ids, type) => {
                  if (ids.length === 1 && type === 'play') {
                    onSelectPlay(ids[0]);
                  }
                }}
                collapsible={false}
                expanded
                defaultExpanded
                resizable
                initialHeight={420}
                minHeight={260}
                maxHeight={680}
              />
            </Section>

            {data?.nodes && data.nodes.length > 0 && (
              <Section title={`星团内剧目 (${data.nodes.length})`}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {data.nodes.slice(0, 20).map((n) => (
                    <button
                      key={n.play_id}
                      type="button"
                      onClick={() => onSelectPlay(n.play_id)}
                      className="paper-list-item"
                      style={{ borderLeftColor: getNodeColor(n) }}
                    >
                      <div style={{ fontWeight: 600 }}>{n.title}</div>
                      <div className="paper-list-item-muted">
                        {n.source_name} · {n.role_count} 角色
                      </div>
                    </button>
                  ))}
                  {data.nodes.length > 20 && (
                    <p style={{ fontSize: 11, color: COLORS.sidebarTextMuted }}>另有 {data.nodes.length - 20} 个剧目…</p>
                  )}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </ResizableSidebar>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h4 className="section-title">{title}</h4>
      {children}
    </div>
  );
}


