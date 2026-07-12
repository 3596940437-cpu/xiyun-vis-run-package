import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { NebulaNode, VersionLineageGroup, VersionLineageReportResponse } from '../api/client';

interface VersionLineageReportProps {
  nodes: NebulaNode[];
  onClose: () => void;
  onHighlightPlay: (playId: string) => void;
  onOpenVersions: (playId: string) => void;
}

const REPORT_COLUMNS = [
  { id: 'source_diversity', label: '来源差异' },
  { id: 'role_add_missing_count', label: '角色规模差异' },
  { id: 'role_change_count', label: '行当变化' },
  { id: 'keyword_change_count', label: '关键词漂移' },
  { id: 'text_delta_weight', label: '文本规模变化' },
];

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatTextDelta(value: number) {
  if (!value) return '0';
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万字`;
  return `${formatNumber(value)} 字`;
}

function metricLabel(group: VersionLineageGroup) {
  return [
    `${group.version_count} 版本`,
    `${group.source_diversity} 来源`,
    group.role_add_missing_count ? `角色增删 ${group.role_add_missing_count}` : '',
    group.role_change_count ? `行当变化 ${group.role_change_count}` : '',
    group.keyword_change_count ? `关键词 ${group.keyword_change_count}` : '',
  ].filter(Boolean).join(' · ');
}

function buildFallbackReport(nodes: NebulaNode[]): VersionLineageReportResponse {
  const groups = new Map<string, NebulaNode[]>();
  nodes.forEach((node) => {
    const groupId = node.play_group_id || node.play_id;
    if (!groupId) return;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId)!.push(node);
  });

  const sourceCounts = new Map<string, { groupIds: Set<string>; version_count: number }>();
  const rows: VersionLineageGroup[] = [];

  groups.forEach((list, groupId) => {
    if (list.length <= 1) return;
    const sourceNames = [...new Set(list.map((node) => node.source_name || '未知来源'))].sort();
    sourceNames.forEach((source) => {
      const entry = sourceCounts.get(source) || { groupIds: new Set<string>(), version_count: 0 };
      entry.groupIds.add(groupId);
      entry.version_count += list.filter((node) => (node.source_name || '未知来源') === source).length;
      sourceCounts.set(source, entry);
    });

    const roleCounts = list.map((node) => node.role_count || 0);
    const roleSpread = Math.max(...roleCounts) - Math.min(...roleCounts);
    const representative = list.find((node) => node.is_focus) || list[0];
    const versionCount = Math.max(...list.map((node) => node.version_count || list.length), list.length);
    const sourceDiversity = sourceNames.length;
    const diffScore = versionCount * 2 + sourceDiversity * 2 + roleSpread;
    const title = representative.title_clean || representative.title || '未知剧目';

    rows.push({
      play_group_id: groupId,
      canonical_title: title,
      representative_play_id: representative.play_id,
      version_count: versionCount,
      source_names: sourceNames,
      source_diversity: sourceDiversity,
      diff_score: diffScore,
      role_change_count: 0,
      role_add_missing_count: roleSpread,
      keyword_change_count: 0,
      text_delta_total: 0,
      metric_values: {
        source_diversity: sourceDiversity,
        role_add_missing_count: roleSpread,
        role_change_count: 0,
        keyword_change_count: 0,
        text_delta_weight: 0,
      },
      reason: `《${title}》含 ${versionCount} 个版本，覆盖 ${sourceDiversity} 种来源，角色规模差异为 ${roleSpread}，可作为版本记录与来源分布的快速观察样本。`,
    });
  });

  const ranked = rows.sort((a, b) => b.diff_score - a.diff_score).slice(0, 12);
  const maxValues = Object.fromEntries(
    REPORT_COLUMNS.map((column) => [
      column.id,
      Math.max(1, ...ranked.map((row) => row.metric_values[column.id] || 0)),
    ]),
  );

  return {
    summary: {
      multi_version_group_count: rows.length,
      source_count: sourceCounts.size,
      max_version_count: Math.max(0, ...rows.map((row) => row.version_count)),
      diff_group_count: ranked.filter((row) => row.role_add_missing_count > 0 || row.source_diversity > 1).length,
    },
    ranked_groups: ranked,
    diff_matrix: {
      columns: REPORT_COLUMNS,
      rows: ranked.map((row) => ({
        play_group_id: row.play_group_id,
        canonical_title: row.canonical_title,
        representative_play_id: row.representative_play_id,
        cells: REPORT_COLUMNS.map((column) => {
          const value = row.metric_values[column.id] || 0;
          return {
            column_id: column.id,
            value,
            intensity: Math.min(1, value / (maxValues[column.id] || 1)),
          };
        }),
      })),
    },
    source_distribution: [...sourceCounts.entries()]
      .map(([source_name, entry]) => ({
        source_name,
        group_count: entry.groupIds.size,
        version_count: entry.version_count,
      }))
      .sort((a, b) => b.version_count - a.version_count)
      .slice(0, 10),
  };
}

export function VersionLineageReport({
  nodes,
  onClose,
  onHighlightPlay,
  onOpenVersions,
}: VersionLineageReportProps) {
  const [data, setData] = useState<VersionLineageReportResponse | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.versionLineageReport()
      .then((response) => {
        setData(response);
        setSelectedGroupId(response.ranked_groups[0]?.play_group_id || null);
      })
      .catch((e) => {
        const fallback = buildFallbackReport(nodes);
        if (fallback.ranked_groups.length > 0) {
          setData(fallback);
          setSelectedGroupId(fallback.ranked_groups[0]?.play_group_id || null);
          setError('后端报告接口暂不可用，当前使用星云节点生成简版报告。');
          return;
        }
        setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => setLoading(false));
  }, [nodes]);

  const selected = useMemo(() => {
    if (!data) return null;
    return data.ranked_groups.find((g) => g.play_group_id === selectedGroupId) || data.ranked_groups[0] || null;
  }, [data, selectedGroupId]);

  const maxSourceCount = Math.max(1, ...(data?.source_distribution.map((s) => s.version_count) || [1]));

  const chooseGroup = (group: VersionLineageGroup) => {
    setSelectedGroupId(group.play_group_id);
    if (group.representative_play_id) {
      onHighlightPlay(group.representative_play_id);
    }
  };

  return (
    <div className="version-report-overlay notranslate" translate="no">
      <div className="version-report-shell">
        <header className="version-report-header">
          <div>
            <span className="version-report-kicker">版本传承报告</span>
            <h2>从同名剧目的多版本记录，看京剧文本如何被保存、整理与改写</h2>
          </div>
          <button type="button" className="version-report-close" onClick={onClose}>关闭</button>
        </header>

        {loading && <div className="version-report-state">正在整理版本传承线索…</div>}
        {error && !data && <div className="version-report-state error">报告加载失败：{error}</div>}

        {data && selected && (
          <>
            {error && <div className="version-report-fallback-note">{error}</div>}
            <section className="version-report-metrics">
              <div>
                <strong>{formatNumber(data.summary.multi_version_group_count)}</strong>
                <span>多版本剧目</span>
              </div>
              <div>
                <strong>{formatNumber(data.summary.source_count)}</strong>
                <span>来源类型</span>
              </div>
              <div>
                <strong>{formatNumber(data.summary.max_version_count)}</strong>
                <span>最高版本数</span>
              </div>
              <div>
                <strong>{formatNumber(data.summary.diff_group_count)}</strong>
                <span>存在差异证据</span>
              </div>
            </section>

            <div className="version-report-grid">
              <section className="version-report-panel lineage-list-panel">
                <div className="version-report-section-title">
                  <span>重点传承剧目榜</span>
                  <small>按版本数、来源跨度、角色与文本差异综合排序</small>
                </div>
                <div className="lineage-list">
                  {data.ranked_groups.map((group, index) => (
                    <button
                      type="button"
                      key={group.play_group_id}
                      className={group.play_group_id === selected.play_group_id ? 'lineage-row active' : 'lineage-row'}
                      onClick={() => chooseGroup(group)}
                    >
                      <span className="lineage-rank">{String(index + 1).padStart(2, '0')}</span>
                      <span className="lineage-main">
                        <strong>{group.canonical_title}</strong>
                        <small>{metricLabel(group)}</small>
                      </span>
                      <span className="lineage-score">{group.diff_score.toFixed(1)}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="version-report-panel lineage-story-panel">
                <div className="version-report-section-title">
                  <span>传承故事卡</span>
                  <small>解释为什么这个剧目值得深入查看</small>
                </div>
                <div className="lineage-story-card">
                  <div className="story-title-row">
                    <h3>{selected.canonical_title}</h3>
                    <span>{selected.version_count} 个版本</span>
                  </div>
                  <p>{selected.reason}</p>
                  <div className="story-chip-grid">
                    <span>来源：{selected.source_names.slice(0, 4).join('、') || '未知来源'}</span>
                    <span>角色增删：{selected.role_add_missing_count}</span>
                    <span>行当变化：{selected.role_change_count}</span>
                    <span>文本差异：{formatTextDelta(selected.text_delta_total)}</span>
                  </div>
                  <div className="story-actions">
                    {selected.representative_play_id && (
                      <>
                        <button type="button" onClick={() => onHighlightPlay(selected.representative_play_id!)}>
                          定位星云
                        </button>
                        <button type="button" className="primary" onClick={() => onOpenVersions(selected.representative_play_id!)}>
                          查看版本河流
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="source-strip">
                  <div className="version-report-section-title compact">
                    <span>来源贡献</span>
                    <small>哪些文献来源支撑了多版本传承线索</small>
                  </div>
                  {data.source_distribution.slice(0, 7).map((source) => (
                    <div key={source.source_name} className="source-bar-row">
                      <span>{source.source_name}</span>
                      <div>
                        <i style={{ width: `${Math.max(8, (source.version_count / maxSourceCount) * 100)}%` }} />
                      </div>
                      <em>{source.version_count}</em>
                    </div>
                  ))}
                </div>
              </section>

              <section className="version-report-panel lineage-matrix-panel">
                <div className="version-report-section-title">
                  <span>差异类型热力图</span>
                  <small>颜色越深，说明该剧目的版本差异越集中在对应维度</small>
                </div>
                <div className="lineage-matrix">
                  <div className="matrix-header" style={{ gridTemplateColumns: `150px repeat(${data.diff_matrix.columns.length}, minmax(74px, 1fr))` }}>
                    <span />
                    {data.diff_matrix.columns.map((column) => <strong key={column.id}>{column.label}</strong>)}
                  </div>
                  {data.diff_matrix.rows.map((row) => (
                    <button
                      type="button"
                      key={row.play_group_id}
                      className={row.play_group_id === selected.play_group_id ? 'matrix-row active' : 'matrix-row'}
                      style={{ gridTemplateColumns: `150px repeat(${data.diff_matrix.columns.length}, minmax(74px, 1fr))` }}
                      onClick={() => {
                        const group = data.ranked_groups.find((g) => g.play_group_id === row.play_group_id);
                        if (group) chooseGroup(group);
                      }}
                    >
                      <span>{row.canonical_title}</span>
                      {row.cells.map((cell) => (
                        <i
                          key={cell.column_id}
                          style={{ '--heat': cell.intensity } as React.CSSProperties}
                          title={`${cell.value}`}
                        >
                          {cell.value ? cell.value : '·'}
                        </i>
                      ))}
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
