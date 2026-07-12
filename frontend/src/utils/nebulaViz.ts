import type { NebulaEdge, NebulaNode } from '../api/client';
import { getNodeColor } from '../constants/theme';

export type EdgeDisplayMode = 'none' | 'strong' | 'all';
export type NebulaLayoutMode = 'tidy' | 'raw';

export interface DisplayNebulaNode extends NebulaNode {
  displayX: number;
  displayY: number;
}

const STRONG_WEIGHT = 0.78;

export function filterEdges(
  edges: NebulaEdge[],
  mode: EdgeDisplayMode,
  hoveredPlayId: string | null,
  visibleNodeIds: Set<string>,
): NebulaEdge[] {
  if (mode === 'none' && !hoveredPlayId) return [];

  const inView: NebulaEdge[] = [];
  const strong: NebulaEdge[] = [];
  const hoverExtra: NebulaEdge[] = [];

  for (const edge of edges) {
    if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) continue;
    if (mode === 'all') {
      inView.push(edge);
      continue;
    }

    const isStrong = (edge.weight ?? 0) >= STRONG_WEIGHT && edge.relation_type !== 'annotated_bridge';
    if (isStrong) {
      strong.push(edge);
    } else if (hoveredPlayId && (edge.source === hoveredPlayId || edge.target === hoveredPlayId)) {
      hoverExtra.push(edge);
    }
  }

  if (mode === 'all') return inView;
  if (!hoveredPlayId) return mode === 'strong' ? strong : [];
  return hoverExtra.length ? [...strong, ...hoverExtra] : strong;
}

export function nodeRadius(d: NebulaNode): number {
  return Math.sqrt(d.role_count || 3) * 0.35;
}

export function glowRadius(d: NebulaNode): number {
  return nodeRadius(d) * 2.2;
}

/** 紧贴节点的核心光晕半径（不外扩） */
export function coreGlowRadius(d: NebulaNode): number {
  return nodeRadius(d) * 1.35;
}

export interface ClusterGlow {
  id: string;
  cx: number;
  cy: number;
  r: number;
  color: string;
  count: number;
}

export function buildClusterGlows(
  nodes: Array<NebulaNode | DisplayNebulaNode>,
  xScale: (v: number) => number,
  yScale: (v: number) => number,
  groupKey: (node: NebulaNode) => string = (node) => node.coarse_cluster_id || node.cluster_id || 'other',
  colorForNode: (node: NebulaNode) => string = getNodeColor,
): ClusterGlow[] {
  const groups = new Map<string, NebulaNode[]>();
  for (const n of nodes) {
    const key = groupKey(n);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }

  return [...groups.entries()].map(([id, list]) => {
    const mx = list.reduce((s, n) => s + getDisplayX(n), 0) / list.length;
    const my = list.reduce((s, n) => s + getDisplayY(n), 0) / list.length;
    const cx = xScale(mx);
    const cy = yScale(my);
    const spread = Math.sqrt(list.length) * 8 + 24;
    return {
      id,
      cx,
      cy,
      r: spread,
      color: colorForNode(list[0]),
      count: list.length,
    };
  });
}

export function getEdgeBaseWidth(
  edge: NebulaEdge,
  activeHover: string | null,
): number {
  const isHover =
    activeHover &&
    (edge.source === activeHover || edge.target === activeHover);
  if (isHover) return 1.2;
  return edge.relation_type === 'annotated_bridge' ? 0.4 : 0.6;
}

/** 固定星点，用于背景 */
export function buildStarfield(count: number, width: number, height: number, seed = 42): Array<{ x: number; y: number; r: number; o: number }> {
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  return Array.from({ length: count }, () => ({
    x: rand() * width,
    y: rand() * height,
    r: rand() * 0.7 + 0.2,
    o: rand() * 0.1 + 0.02,
  }));
}

export function getDisplayX(node: NebulaNode | DisplayNebulaNode): number {
  return 'displayX' in node ? node.displayX : node.x;
}

export function getDisplayY(node: NebulaNode | DisplayNebulaNode): number {
  return 'displayY' in node ? node.displayY : node.y;
}

function groupNodes(nodes: NebulaNode[], groupKey: (node: NebulaNode) => string) {
  const groups = new Map<string, NebulaNode[]>();
  for (const node of nodes) {
    const key = groupKey(node);
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }
  return groups;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function groupSortValue(list: NebulaNode[]) {
  return list.reduce((sum, node) => sum + node.x, 0) / Math.max(1, list.length);
}

function buildGroupCenters(
  entries: Array<[string, NebulaNode[]]>,
  useParentSatellites: boolean,
) {
  const major = entries.filter(([, list]) => list.length >= 24);
  const minor = entries.filter(([, list]) => list.length < 24);
  const orderedMajor = [...major].sort((a, b) => groupSortValue(a[1]) - groupSortValue(b[1]));
  const centers = new Map<string, { x: number; y: number }>();
  const parentCenters = new Map<string, Array<{ x: number; y: number }>>();
  const majorCount = Math.max(1, orderedMajor.length);
  const ringRadius = majorCount <= 6 ? 0.58 : 0.66;

  orderedMajor.forEach(([id, list], index) => {
    const angle = -Math.PI / 2 + (index / majorCount) * Math.PI * 2;
    const sizePull = Math.min(0.14, Math.sqrt(list.length) / 92);
    centers.set(id, {
      x: Math.cos(angle) * (ringRadius - sizePull),
      y: Math.sin(angle) * (ringRadius - sizePull) * 0.78,
    });
    const center = centers.get(id)!;
    const parentId = list[0]?.coarse_cluster_id;
    if (parentId) {
      const parentList = parentCenters.get(parentId);
      if (parentList) parentList.push(center);
      else parentCenters.set(parentId, [center]);
    }
  });

  if (orderedMajor.length === 1) {
    const [id] = orderedMajor[0];
    centers.set(id, { x: 0, y: 0 });
  }

  minor.forEach(([id, list], index) => {
    const parentId = list[0]?.coarse_cluster_id;
    const parentGroup = parentId ? parentCenters.get(parentId) : null;
    const parent = useParentSatellites && parentGroup?.length
      ? {
        x: parentGroup.reduce((sum, center) => sum + center.x, 0) / parentGroup.length,
        y: parentGroup.reduce((sum, center) => sum + center.y, 0) / parentGroup.length,
      }
      : null;
    if (parent) {
      const angle = (index * 2.399963229728653) % (Math.PI * 2);
      centers.set(id, {
        x: parent.x + Math.cos(angle) * 0.18,
        y: parent.y + Math.sin(angle) * 0.14,
      });
      return;
    }

    const angle = -Math.PI / 2 + (index / Math.max(1, minor.length)) * Math.PI * 2;
    centers.set(id, {
      x: Math.cos(angle) * 0.82,
      y: Math.sin(angle) * 0.64,
    });
  });

  return centers;
}

function applyStrongRelationForces(
  centers: Map<string, { x: number; y: number }>,
  entries: Array<[string, NebulaNode[]]>,
  edges: NebulaEdge[],
  groupKey: (node: NebulaNode) => string,
  clusterViewMode: 'coarse' | 'fine',
) {
  if (edges.length === 0 || centers.size < 2) return centers;

  const originalCenters = new Map([...centers.entries()].map(([id, center]) => [id, { ...center }]));
  const nodeGroup = new Map<string, string>();
  const groupSize = new Map<string, number>();
  for (const [id, list] of entries) {
    groupSize.set(id, list.length);
    for (const node of list) nodeGroup.set(node.play_id, groupKey(node));
  }

  const relationWeights = new Map<string, number>();
  for (const edge of edges) {
    if ((edge.weight ?? 0) < STRONG_WEIGHT || edge.relation_type === 'annotated_bridge') continue;
    const sourceGroup = nodeGroup.get(edge.source);
    const targetGroup = nodeGroup.get(edge.target);
    if (!sourceGroup || !targetGroup || sourceGroup === targetGroup) continue;
    const [a, b] = sourceGroup < targetGroup ? [sourceGroup, targetGroup] : [targetGroup, sourceGroup];
    const key = `${a}\u0000${b}`;
    relationWeights.set(key, (relationWeights.get(key) || 0) + Math.max(0.1, edge.weight ?? STRONG_WEIGHT));
  }
  if (relationWeights.size === 0) return centers;

  const relations = [...relationWeights.entries()]
    .map(([key, weight]) => {
      const [source, target] = key.split('\u0000');
      return { source, target, strength: Math.min(2.2, Math.log1p(weight)) };
    })
    .filter((relation) => centers.has(relation.source) && centers.has(relation.target));
  const ids = [...centers.keys()];
  const radiusFor = (id: string) => Math.max(0.09, Math.min(0.28, 0.072 + Math.sqrt(groupSize.get(id) || 1) * 0.006));
  const desiredRelationDistance = clusterViewMode === 'fine' ? 0.26 : 0.38;
  const bounds = clusterViewMode === 'fine'
    ? { x: 0.88, y: 0.68 }
    : { x: 0.78, y: 0.60 };

  for (let step = 0; step < 110; step += 1) {
    for (const relation of relations) {
      const source = centers.get(relation.source)!;
      const target = centers.get(relation.target)!;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(0.001, Math.hypot(dx, dy));
      const desired = desiredRelationDistance + (radiusFor(relation.source) + radiusFor(relation.target)) * 0.35;
      const force = (distance - desired) * 0.012 * relation.strength;
      const mx = (dx / distance) * force;
      const my = (dy / distance) * force;
      source.x += mx;
      source.y += my;
      target.x -= mx;
      target.y -= my;
    }

    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = centers.get(ids[i])!;
        const b = centers.get(ids[j])!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(0.001, Math.hypot(dx, dy));
        const minDistance = radiusFor(ids[i]) + radiusFor(ids[j]) + 0.06;
        if (distance >= minDistance) continue;
        const force = (minDistance - distance) * 0.04;
        const mx = (dx / distance) * force;
        const my = (dy / distance) * force;
        a.x -= mx;
        a.y -= my;
        b.x += mx;
        b.y += my;
      }
    }

    for (const id of ids) {
      const center = centers.get(id)!;
      const original = originalCenters.get(id)!;
      center.x = center.x * 0.988 + original.x * 0.012;
      center.y = center.y * 0.988 + original.y * 0.012;
      center.x = Math.max(-bounds.x, Math.min(bounds.x, center.x));
      center.y = Math.max(-bounds.y, Math.min(bounds.y, center.y));
    }
  }

  return centers;
}

export function buildDisplayNodes(
  nodes: NebulaNode[],
  edges: NebulaEdge[],
  layoutMode: NebulaLayoutMode,
  clusterViewMode: 'coarse' | 'fine',
): DisplayNebulaNode[] {
  if (layoutMode === 'raw' || nodes.length === 0) {
    return nodes.map((node) => ({ ...node, displayX: node.x, displayY: node.y }));
  }

  const groupKey = (node: NebulaNode) =>
    clusterViewMode === 'fine'
      ? node.cluster_id || node.coarse_cluster_id || 'other'
      : node.coarse_cluster_id || node.cluster_id || 'other';
  const groups = groupNodes(nodes, groupKey);
  const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const centers = applyStrongRelationForces(
    buildGroupCenters(entries, clusterViewMode === 'fine'),
    entries,
    edges,
    groupKey,
    clusterViewMode,
  );
  const result: DisplayNebulaNode[] = [];

  for (const [id, list] of entries) {
    const cx = list.reduce((sum, node) => sum + node.x, 0) / list.length;
    const cy = list.reduce((sum, node) => sum + node.y, 0) / list.length;
    const distances = list.map((node) => Math.hypot(node.x - cx, node.y - cy));
    const robustRadius = Math.max(0.035, median(distances) * 2.2, Math.sqrt(list.length) * 0.006);
    const targetRadius = Math.max(0.08, Math.min(0.24, 0.075 + Math.sqrt(list.length) * 0.008));
    const center = centers.get(id) || { x: 0, y: 0 };

    for (const node of list) {
      const dx = node.x - cx;
      const dy = node.y - cy;
      const distance = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const normalized = distance / robustRadius;
      const compressed = Math.tanh(normalized) * targetRadius;
      const jitterSeed = Math.sin((node.play_id.length + node.title.length) * 12.9898) * 43758.5453;
      const jitter = (jitterSeed - Math.floor(jitterSeed) - 0.5) * 0.006;

      result.push({
        ...node,
        displayX: center.x + Math.cos(angle) * compressed + jitter,
        displayY: center.y + Math.sin(angle) * compressed * 0.86 - jitter,
      });
    }
  }

  return result;
}
