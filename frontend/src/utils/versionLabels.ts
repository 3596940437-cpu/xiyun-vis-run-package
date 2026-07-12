import type { VersionDetailResponse } from '../api/client';

export interface VersionCatalogEntry {
  seq: number;
  versionId: string;
  playId?: string;
  title: string;
  sourceName: string;
  versionLabel: string;
  roleCount?: number;
  shortLabel: string;
  columnLabel: string;
  fullLabel: string;
  isReference: boolean;
}

function formatEntry(
  seq: number,
  v: {
    version_id?: string;
    play_id?: string;
    title?: string;
    source_name?: string;
    version_label?: string;
    version_index?: number;
    role_count?: number;
  },
  canonicalTitle: string,
  referenceVersionId?: string,
): VersionCatalogEntry | null {
  if (!v.version_id) return null;
  const source = v.source_name || '未知来源';
  const tag = v.version_label || '未标注';
  const title = v.title || canonicalTitle;
  return {
    seq,
    versionId: v.version_id,
    playId: v.play_id,
    title,
    sourceName: source,
    versionLabel: tag,
    roleCount: v.role_count,
    shortLabel: `V${seq}`,
    columnLabel: `V${seq}·${source}`,
    fullLabel: `V${seq} · ${source}（${tag}）`,
    isReference: v.version_id === referenceVersionId,
  };
}

/** 按版本河流顺序生成带序号的版本目录 */
export function buildVersionCatalog(data: VersionDetailResponse): VersionCatalogEntry[] {
  const canonicalTitle = data.canonical_title || '未知剧目';
  const refId = data.diff_card?.reference_version_id;
  const river = data.river?.versions || [];

  if (river.length > 0) {
    return river
      .map((v, idx) => formatEntry(v.version_index ?? idx + 1, v, canonicalTitle, refId))
      .filter((e): e is VersionCatalogEntry => e !== null);
  }

  return (data.version_nodes || [])
    .map((v, idx) => formatEntry(idx + 1, v, canonicalTitle, refId))
    .filter((e): e is VersionCatalogEntry => e !== null);
}

/** 按矩阵 version_ids 顺序重排并重新编号 */
export function alignCatalogToMatrix(
  catalog: VersionCatalogEntry[],
  versionIds: string[] | undefined,
): VersionCatalogEntry[] {
  if (!versionIds?.length) return catalog;

  const byId = new Map(catalog.map((c) => [c.versionId, c]));
  const ordered: VersionCatalogEntry[] = [];

  versionIds.forEach((id, idx) => {
    const base = byId.get(id);
    if (!base) return;
    const seq = idx + 1;
    ordered.push({
      ...base,
      seq,
      shortLabel: `V${seq}`,
      columnLabel: `V${seq}·${base.sourceName}`,
      fullLabel: `V${seq} · ${base.sourceName}（${base.versionLabel}）`,
    });
  });

  return ordered.length > 0 ? ordered : catalog;
}

export function catalogByVersionId(catalog: VersionCatalogEntry[]): Map<string, VersionCatalogEntry> {
  return new Map(catalog.map((c) => [c.versionId, c]));
}

export function catalogByPlayId(catalog: VersionCatalogEntry[]): Map<string, VersionCatalogEntry> {
  const map = new Map<string, VersionCatalogEntry>();
  for (const c of catalog) {
    if (c.playId) map.set(c.playId, c);
  }
  return map;
}

export function lookupVersionLabel(
  versionId: string | undefined,
  byId: Map<string, VersionCatalogEntry>,
  fallbackTitle?: string,
): string {
  if (versionId && byId.has(versionId)) {
    const e = byId.get(versionId)!;
    return e.fullLabel;
  }
  return fallbackTitle || '未知版本';
}
