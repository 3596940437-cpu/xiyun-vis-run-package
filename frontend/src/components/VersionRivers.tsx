import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api/client';
import type { VersionDetailResponse } from '../api/client';
import { COLORS, getPaperHeatColor, getPaperHeatTextColor, getRoleTypeColor } from '../constants/theme';
import {
  alignCatalogToMatrix,
  buildVersionCatalog,
  catalogByVersionId,
  lookupVersionLabel,
  type VersionCatalogEntry,
} from '../utils/versionLabels';

const SIDEBAR_MUTED = COLORS.sidebarTextMuted;

interface VersionRiversProps {
  playId: string;
  sidebarOffset?: number;
  onClose: () => void;
}

const ROLE_TYPES = ['老生', '小生', '武生', '旦', '正旦', '青衣', '花旦', '净', '武净', '丑', '文丑', '末', '外'];

function resolveRoleName(characterKey: string, nameMap: Record<string, string>): string {
  if (nameMap[characterKey]) return nameMap[characterKey];
  return '未知角色';
}

type NamedCount = { name: string; count: number } | string;

function namedItems(items?: NamedCount[]): string[] {
  if (!items?.length) return [];
  return items.map((i) => (typeof i === 'string' ? i : i.name));
}

function buildPlotDiffLines(diff: NonNullable<VersionDetailResponse['diff_card']>['diffs'][number]): string[] {
  const lines: string[] = [];
  if (diff.added_keywords?.length) {
    lines.push(`新增情节关键词：${diff.added_keywords.join('、')}`);
  }
  if (diff.missing_keywords?.length) {
    lines.push(`缺失情节关键词：${diff.missing_keywords.join('、')}`);
  }
  const td = diff.text_delta;
  if (td) {
    if (td.scene_count_delta) {
      lines.push(`场次变化：${td.scene_count_delta > 0 ? '+' : ''}${td.scene_count_delta}`);
    }
    if (td.text_length_delta) {
      lines.push(`文本规模变化：${td.text_length_delta > 0 ? '+' : ''}${td.text_length_delta} 字`);
    }
    const addedKw = namedItems(td.added_chunk_keywords);
    if (addedKw.length) lines.push(`文本新增关键词：${addedKw.slice(0, 6).join('、')}`);
    const missingKw = namedItems(td.missing_chunk_keywords);
    if (missingKw.length) lines.push(`文本缺失关键词：${missingKw.slice(0, 6).join('、')}`);
    const addedRoles = namedItems(td.added_chunk_roles);
    if (addedRoles.length) lines.push(`文本新增角色：${addedRoles.slice(0, 5).join('、')}`);
    const missingRoles = namedItems(td.missing_chunk_roles);
    if (missingRoles.length) lines.push(`文本缺失角色：${missingRoles.slice(0, 5).join('、')}`);
  }
  if (diff.notes?.length) {
    lines.push(...diff.notes);
  }
  return lines;
}

function VersionLegend({ catalog }: { catalog: VersionCatalogEntry[] }) {
  return (
    <div className="vr-version-legend">
      {catalog.map((v) => (
        <div key={v.versionId} className="vr-version-legend-item">
          <span className={`vr-version-badge${v.isReference ? ' ref' : ''}`}>
            {v.shortLabel}{v.isReference ? ' 参照' : ''}
          </span>
          <div>
            <strong>{v.title}</strong>
            <div style={{ color: SIDEBAR_MUTED, marginTop: 2 }}>
              来源 {v.sourceName} · {v.versionLabel}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export const VersionRivers: React.FC<VersionRiversProps> = ({ playId, sidebarOffset = 400, onClose }) => {
  const [data, setData] = useState<VersionDetailResponse | null>(null);
  const [roleNameMap, setRoleNameMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!playId) return;
    setLoading(true);
    setError(null);
    setRoleNameMap({});
    api.playVersions(playId)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [playId]);

  useEffect(() => {
    const playIds = data?.version_nodes?.map((v) => v.play_id).filter(Boolean) as string[] | undefined;
    if (!playIds?.length) return;

    const uniqueIds = [...new Set(playIds)];
    Promise.all(uniqueIds.map((id) => api.play(id)))
      .then((results) => {
        const map: Record<string, string> = {};
        for (const detail of results) {
          for (const role of detail.roles || []) {
            if (role.character_key && role.role_name) {
              map[role.character_key] = role.role_name;
            }
          }
        }
        setRoleNameMap(map);
      })
      .catch(console.error);
  }, [data?.version_nodes]);

  const canonicalTitle = data?.canonical_title || '未知剧目';
  const matrix = data?.matrix;
  const diffCards = data?.diff_card?.diffs || [];

  const versionCatalog = useMemo(() => {
    if (!data) return [];
    const base = buildVersionCatalog(data);
    return alignCatalogToMatrix(base, matrix?.version_ids);
  }, [data, matrix?.version_ids]);

  const byVersionId = useMemo(() => catalogByVersionId(versionCatalog), [versionCatalog]);

  const referenceLabel = useMemo(() => {
    const refId = data?.diff_card?.reference_version_id;
    if (refId && byVersionId.has(refId)) {
      return `${byVersionId.get(refId)!.fullLabel}（参照）`;
    }
    return data?.diff_card?.reference_title
      ? `${data.diff_card.reference_title}（参照）`
      : '参照版本';
  }, [data?.diff_card, byVersionId]);

  const roleTypeMatrix = useMemo(() => {
    if (versionCatalog.length === 0) return null;
    const counts = versionCatalog.map((v) => {
      const node = data?.version_nodes?.find((n) => n.play_id === v.playId);
      return node?.role_type_counts || {};
    });
    const maxVal = Math.max(1, ...counts.flatMap((c) => Object.values(c)));
    return {
      columns: versionCatalog,
      counts,
      maxVal,
    };
  }, [versionCatalog, data?.version_nodes]);

  const plotDiffCards = useMemo(
    () => diffCards
      .map((diff) => ({ diff, lines: buildPlotDiffLines(diff) }))
      .filter((item) => item.lines.length > 0),
    [diffCards],
  );

  const characterChanges = useMemo(() => {
    const merged = new Map<string, { name: string; changes: string[] }>();
    for (const diff of diffCards) {
      const verLabel = lookupVersionLabel(diff.version_id, byVersionId, diff.title);
      for (const ch of diff.role_type_changes || []) {
        const name = resolveRoleName(ch.character_key, roleNameMap);
        const line = `${verLabel}: ${ch.from} → ${ch.to}`;
        const existing = merged.get(ch.character_key);
        if (existing) {
          existing.changes.push(line);
        } else {
          merged.set(ch.character_key, { name, changes: [line] });
        }
      }
    }
    return [...merged.values()];
  }, [diffCards, roleNameMap, byVersionId]);

  const panel = (content: React.ReactNode) => (
    <div
      className="version-rivers-panel"
      style={{ '--version-rivers-right': `${sidebarOffset}px` } as CSSProperties}
    >
      <div className="version-rivers-header">
        <h2>版本传承 · {canonicalTitle}</h2>
        <button type="button" onClick={onClose} className="version-rivers-close">关闭</button>
      </div>
      <div className="version-rivers-body">{content}</div>
    </div>
  );

  if (loading) return panel(<p style={{ textAlign: 'center', color: SIDEBAR_MUTED }}>加载版本数据…</p>);
  if (error) return panel(<p style={{ color: '#c0392b' }}>加载失败: {error}</p>);
  if (versionCatalog.length === 0) {
    return panel(
      <p style={{ textAlign: 'center', color: SIDEBAR_MUTED }}>
        该剧目暂无多版本数据
      </p>,
    );
  }

  return panel(
    <>
      <section className="vr-section">
        <h3>版本目录 · {versionCatalog.length} 个版本</h3>
        <VersionLegend catalog={versionCatalog} />
      </section>

      <section className="vr-section">
        <h3>版本河流</h3>
        <div className="vr-river">
          {versionCatalog.map((v, idx) => (
            <React.Fragment key={v.versionId}>
              <div className="vr-version-card">
                <span className={`vr-version-badge${v.isReference ? ' ref' : ''}`}>
                  {v.shortLabel}{v.isReference ? ' 参照' : ''}
                </span>
                <div className="vr-version-name">{v.title}</div>
                <div className="vr-version-meta">
                  来源: {v.sourceName}<br />
                  标签: {v.versionLabel}<br />
                  角色: {v.roleCount ?? '-'} 个
                </div>
              </div>
              {idx < versionCatalog.length - 1 && <div className="vr-arrow">→</div>}
            </React.Fragment>
          ))}
        </div>
      </section>

      {roleTypeMatrix && (
        <section className="vr-section">
          <h3>角色变形谱（行当分布热力图）</h3>
          <div className="vr-heatmap-wrap">
            <table className="vr-heatmap">
              <thead>
                <tr>
                  <th>行当</th>
                  {roleTypeMatrix.columns.map((col) => (
                    <th key={col.versionId} className="vr-matrix-label" title={col.fullLabel}>
                      <div>{col.shortLabel}</div>
                      <div style={{ fontWeight: 400, color: SIDEBAR_MUTED }}>{col.sourceName}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROLE_TYPES.filter((rt) =>
                  roleTypeMatrix.counts.some((c) => (c[rt] || 0) > 0),
                ).map((rt) => (
                  <tr key={rt}>
                    <td style={{ color: getRoleTypeColor(rt) }}>{rt}</td>
                    {roleTypeMatrix.counts.map((c, i) => {
                      const val = c[rt] || 0;
                      const intensity = val / roleTypeMatrix.maxVal;
                      return (
                        <td
                          key={roleTypeMatrix.columns[i].versionId}
                          style={{
                            background: val ? getPaperHeatColor(intensity) : COLORS.paper,
                            color: val ? getPaperHeatTextColor(intensity) : SIDEBAR_MUTED,
                          }}
                        >
                          {val || '·'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {plotDiffCards.length > 0 && (
        <section className="vr-section">
          <h3>情节差异卡片</h3>
          {plotDiffCards.map(({ diff, lines }, idx) => {
            const currentLabel = lookupVersionLabel(diff.version_id, byVersionId, diff.title);
            return (
              <div key={diff.version_id || idx} className="vr-diff-card">
                <div style={{ fontWeight: 600 }}>
                  {currentLabel}
                  <span style={{ fontSize: 11, color: SIDEBAR_MUTED, marginLeft: 8 }}>
                    vs {referenceLabel}
                  </span>
                </div>
                {lines.map((line, i) => (
                  <div key={i} style={{ fontSize: 12, color: COLORS.sidebarText, marginTop: 6, lineHeight: 1.5 }}>
                    {line}
                  </div>
                ))}
              </div>
            );
          })}
        </section>
      )}

      {characterChanges.length > 0 && (
        <section className="vr-section">
          <h3>跨版本行当变化</h3>
          {characterChanges.map((row, i) => (
            <div key={i} className="vr-diff-card">
              <strong>{row.name}</strong>
              <div style={{ fontSize: 12, color: SIDEBAR_MUTED, marginTop: 4 }}>
                {row.changes.join('；')}
              </div>
            </div>
          ))}
        </section>
      )}

      {diffCards.length > 0 && (
        <section className="vr-section">
          <h3>版本差异对比</h3>
          {diffCards.map((diff, idx) => {
            const currentLabel = lookupVersionLabel(diff.version_id, byVersionId, diff.title);
            return (
              <div key={diff.version_id || idx} className="vr-diff-card">
                <div style={{ fontWeight: 600 }}>
                  {currentLabel}
                  <span style={{ fontSize: 11, color: SIDEBAR_MUTED, marginLeft: 8 }}>
                    vs {referenceLabel}
                  </span>
                </div>
                {diff.source_difference && (
                  <div style={{ fontSize: 12, color: COLORS.sidebarAccent, marginTop: 6 }}>
                    来源: {diff.source_difference.current} vs {diff.source_difference.reference}
                  </div>
                )}
                {diff.added_roles && diff.added_roles.length > 0 && (
                  <div style={{ fontSize: 12, color: '#2E7D6E' }}>
                    新增角色: {diff.added_roles.map((k) => resolveRoleName(k, roleNameMap)).join('、')}
                  </div>
                )}
                {diff.missing_roles && diff.missing_roles.length > 0 && (
                  <div style={{ fontSize: 12, color: '#A0522D' }}>
                    缺失角色: {diff.missing_roles.map((k) => resolveRoleName(k, roleNameMap)).join('、')}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {matrix && matrix.matrix && matrix.matrix.length > 0 && (
        <section className="vr-section">
          <h3>版本距离矩阵</h3>
          <div className="vr-heatmap-wrap">
            <table className="vr-heatmap">
              <thead>
                <tr>
                  <th />
                  {versionCatalog.map((col) => (
                    <th key={col.versionId} className="vr-matrix-label" title={col.fullLabel}>
                      <div>{col.shortLabel}</div>
                      <div style={{ fontWeight: 400, color: SIDEBAR_MUTED }}>{col.sourceName}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.matrix.map((row, i) => {
                  const rowCol = versionCatalog[i];
                  return (
                    <tr key={rowCol?.versionId || i}>
                      <th className="vr-matrix-label" title={rowCol?.fullLabel}>
                        <div>{rowCol?.shortLabel || `V${i + 1}`}</div>
                        <div style={{ fontWeight: 400, color: SIDEBAR_MUTED }}>{rowCol?.sourceName}</div>
                      </th>
                      {row.map((val, j) => (
                        <td
                          key={j}
                          style={{
                            background: getPaperHeatColor(val),
                            color: getPaperHeatTextColor(val),
                          }}
                        >
                          {val.toFixed(2)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>,
  );
};
