import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { api } from './api/client';
import type { ClusterInfo, CoarseCluster, NebulaEdge, NebulaNode, SearchItem } from './api/client';
import { SearchBar } from './components/SearchBar';
import { PlayDetailPanel } from './components/PlayDetailPanel';
import { ClusterPanel } from './components/ClusterPanel';
import { VersionRivers } from './components/VersionRivers';
import { GlobalAiPanel } from './components/GlobalAiPanel';
import { Nebula3D } from './components/Nebula3D';
import { VersionLineageReport } from './components/VersionLineageReport';
import {
  COLORS,
  COARSE_CLUSTER_LABELS,
  LEGEND_ITEMS,
  getNodeColor,
} from './constants/theme';
import {
  buildClusterGlows,
  buildDisplayNodes,
  buildStarfield,
  coreGlowRadius,
  filterEdges,
  getEdgeBaseWidth,
  getDisplayX,
  getDisplayY,
  nodeRadius,
  type EdgeDisplayMode,
  type NebulaLayoutMode,
} from './utils/nebulaViz';

type ViewMode = 'all' | 'focus';
type ClusterViewMode = 'coarse' | 'fine';
type SpaceMode = '2d' | '3d';

const TOOLTIP_FONT = 13;
const FINE_CLUSTER_PALETTE = [
  '#4FC3F7',
  '#FFB74D',
  '#BA68C8',
  '#81C784',
  '#EF5350',
  '#64B5F6',
  '#F06292',
  '#A1887F',
  '#FFD54F',
  '#4DB6AC',
  '#9575CD',
  '#FF8A65',
  '#90A4AE',
  '#AED581',
  '#7986CB',
  '#DCE775',
  '#E57373',
  '#4DD0E1',
  '#CE93D8',
  '#FFCC80',
  '#B0BEC5',
];
const LEGEND_ROW_HEIGHT = 24;
const FINE_LEGEND_ROW_HEIGHT = 21;
const DEFAULT_PLAY_SIDEBAR_WIDTH = 400;
const DEFAULT_CLUSTER_SIDEBAR_WIDTH = 380;
const DEFAULT_GLOBAL_AI_WIDTH = 400;

interface NodeMarker {
  playId: string;
  label: string;
  offsetX: number;
  kind: 'current' | 'highlight' | 'both';
}

interface HighlightOptions {
  focus?: boolean;
}

interface TooltipState {
  title: string;
  playId: string;
  dataX: number;
  dataY: number;
}

function describeEdge(edge: NebulaEdge) {
  const parts: string[] = [];
  if (edge.relation_type === 'same_title_version') parts.push('同名版本关系');
  if (edge.relation_type === 'shared_character') parts.push('共享核心角色');
  if (edge.relation_type === 'annotated_bridge') parts.push('人工标注/校准关系');
  if (edge.reasons?.length) parts.push(...edge.reasons.slice(0, 3));
  if (edge.annotation_label) parts.push(edge.annotation_label);
  if (edge.weight != null) parts.push(`相似度 ${Math.round(edge.weight * 100)}%`);
  return parts.length ? parts.join(' · ') : '复合文化特征相近';
}

export default function App() {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const zoomLayerRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const scalesRef = useRef<{ xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> } | null>(null);
  const transformRef = useRef(d3.zoomIdentity);
  const overlayFrameRef = useRef<number | null>(null);
  const strokeFrameRef = useRef<number | null>(null);
  const isDraggingViewRef = useRef(false);
  const pendingDragStartRef = useRef(false);
  const suppressNodeClickUntilRef = useRef(0);

  const [nodes, setNodes] = useState<NebulaNode[]>([]);
  const [edges, setEdges] = useState<NebulaEdge[]>([]);
  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [coarseClusters, setCoarseClusters] = useState<CoarseCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [clusterViewMode, setClusterViewMode] = useState<ClusterViewMode>('coarse');
  const [spaceMode, setSpaceMode] = useState<SpaceMode>('2d');
  const [layoutMode, setLayoutMode] = useState<NebulaLayoutMode>('tidy');
  const [is3DRotating, setIs3DRotating] = useState(false);
  const [coarseFilter, setCoarseFilter] = useState<string | null>(null);
  const [fineClusterFilter, setFineClusterFilter] = useState<string | null>(null);
  const [edgeMode, setEdgeMode] = useState<EdgeDisplayMode>('strong');

  const [selectedPlayId, setSelectedPlayId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<NebulaNode | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());
  const [showRiver, setShowRiver] = useState(false);
  const [showGlobalAi, setShowGlobalAi] = useState(false);
  const [showVizGuide, setShowVizGuide] = useState(false);
  const [showVersionReport, setShowVersionReport] = useState(false);
  const [focusTargetPlayId, setFocusTargetPlayId] = useState<string | null>(null);
  const [isDraggingView, setIsDraggingView] = useState(false);
  const selectedPlayIdRef = useRef<string | null>(null);
  const highlightIdsRef = useRef<Set<string>>(new Set());
  selectedPlayIdRef.current = selectedPlayId;
  highlightIdsRef.current = highlightIds;
  const edgeLayerRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodeLayerRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodeMapRef = useRef<Map<string, NebulaNode>>(new Map());
  const [screenRevision, setScreenRevision] = useState(0);
  const [playSidebarWidth, setPlaySidebarWidth] = useState(DEFAULT_PLAY_SIDEBAR_WIDTH);
  const [clusterSidebarWidth, setClusterSidebarWidth] = useState(DEFAULT_CLUSTER_SIDEBAR_WIDTH);
  const [globalAiWidth, setGlobalAiWidth] = useState(DEFAULT_GLOBAL_AI_WIDTH);

  const sidebarWidth = selectedPlayId
    ? playSidebarWidth
    : selectedClusterId
      ? clusterSidebarWidth
      : showGlobalAi
        ? globalAiWidth
        : 0;
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.nebula({
        focus_only: viewMode === 'focus',
        include_edges: true,
      });
      setNodes(data.nodes);
      setEdges(data.edges);
      setClusters(data.clusters || []);
      setCoarseClusters(data.coarse_clusters || []);
    } catch (e) {
      const message = e instanceof Error ? e.message : '加载失败';
      setError(`数据接口连接失败：${message}`);
    } finally {
      setLoading(false);
    }
  }, [viewMode]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  const selectedFineCluster = useMemo(
    () => clusters.find((c) => c.cluster_id === fineClusterFilter) || null,
    [clusters, fineClusterFilter],
  );

  const fineClusterColorById = useMemo(() => {
    const map = new Map<string, string>();
    clusters.forEach((cluster, index) => {
      map.set(cluster.cluster_id, FINE_CLUSTER_PALETTE[index % FINE_CLUSTER_PALETTE.length]);
    });
    return map;
  }, [clusters]);

  const getVisualNodeColor = useCallback((node: NebulaNode) => {
    if (clusterViewMode === 'fine') {
      return fineClusterColorById.get(node.cluster_id || '') || getNodeColor(node);
    }
    return getNodeColor(node);
  }, [clusterViewMode, fineClusterColorById]);

  const legendItems = useMemo(() => {
    if (clusterViewMode === 'fine') {
      return clusters.map((cluster) => ({
        id: cluster.cluster_id,
        label: cluster.cluster_name,
        count: cluster.node_count,
        color: fineClusterColorById.get(cluster.cluster_id) || COLORS.default,
      }));
    }

    return LEGEND_ITEMS.map((item) => ({
      id: item.label,
      label: item.label,
      color: item.color,
    }));
  }, [clusterViewMode, clusters, fineClusterColorById]);

  const visibleNodes = useMemo(() => {
    let result = nodes;
    if (coarseFilter) {
      result = result.filter((n) => n.coarse_cluster_id === coarseFilter);
    }
    if (fineClusterFilter) {
      result = result.filter((n) => n.cluster_id === fineClusterFilter);
    }
    return result;
  }, [nodes, coarseFilter, fineClusterFilter]);

  const displayNodes = useMemo(
    () => buildDisplayNodes(visibleNodes, edges, layoutMode, clusterViewMode),
    [visibleNodes, edges, layoutMode, clusterViewMode],
  );

  const visibleNodeIds = useMemo(
    () => new Set(displayNodes.map((n) => n.play_id)),
    [displayNodes],
  );

  const hoveredPlayIdRef = useRef<string | null>(null);
  const [hoveredPlayId, setHoveredPlayIdState] = useState<string | null>(null);
  const setHoveredPlayId = useCallback((id: string | null) => {
    hoveredPlayIdRef.current = id;
    setHoveredPlayIdState(id);
  }, []);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const resetSelection = useCallback(() => {
    setSelectedPlayId(null);
    setSelectedNode(null);
    setSelectedClusterId(null);
    setFineClusterFilter(null);
    setClusterViewMode('coarse');
    setHighlightIds(new Set());
    setShowRiver(false);
    setFocusTargetPlayId(null);
    setTooltip(null);
    setHoveredPlayId(null);
  }, [setHoveredPlayId]);

  useEffect(() => {
    if (coarseFilter && nodes.length > 0 && !nodes.some((n) => n.coarse_cluster_id === coarseFilter)) {
      setCoarseFilter(null);
    }
  }, [coarseFilter, nodes]);

  useEffect(() => {
    if (fineClusterFilter && nodes.length > 0 && !nodes.some((n) => n.cluster_id === fineClusterFilter)) {
      setFineClusterFilter(null);
      setSelectedClusterId(null);
      setHighlightIds(new Set());
      setFocusTargetPlayId(null);
    }
  }, [fineClusterFilter, nodes]);

  useEffect(() => {
    if (selectedPlayId && nodes.length > 0 && !nodes.some((n) => n.play_id === selectedPlayId)) {
      resetSelection();
    }
  }, [nodes, resetSelection, selectedPlayId]);

  useEffect(() => {
    if (selectedClusterId && clusters.length > 0 && !clusters.some((c) => c.cluster_id === selectedClusterId)) {
      setSelectedClusterId(null);
      setHighlightIds(new Set());
      setFocusTargetPlayId(null);
    }
  }, [clusters, selectedClusterId]);

  const getNodeStrokeWidth = useCallback((playId: string) => {
    const emphasized =
      highlightIdsRef.current.has(playId) ||
      selectedPlayIdRef.current === playId ||
      hoveredPlayIdRef.current === playId;
    return emphasized ? 1.8 : 0.5;
  }, []);

  const applyScreenConstantStrokes = useCallback(() => {
    const hover = hoveredPlayIdRef.current;
    const edgeLayer = edgeLayerRef.current;
    if (edgeLayer) {
      edgeLayer.selectAll<SVGLineElement, NebulaEdge>('line.edge')
        .attr('stroke-width', (d) => {
          const strongBoost = edgeMode === 'strong' && !hover ? 1.75 : 1;
          return getEdgeBaseWidth(d, hover) * strongBoost;
        })
        .attr('stroke-dasharray', (d) =>
          d.relation_type === 'annotated_bridge' ? '3 4' : 'none',
        );
    }
    const nodeLayer = nodeLayerRef.current;
    if (nodeLayer) {
      nodeLayer.selectAll<SVGCircleElement, NebulaNode>('circle.node')
        .attr('stroke-width', (d) => getNodeStrokeWidth(d.play_id));
    }
  }, [edgeMode, getNodeStrokeWidth]);

  const syncOverlayPositionsNow = useCallback(() => {
    const scales = scalesRef.current;
    if (!scales) return;
    const { xScale, yScale } = scales;
    const transform = transformRef.current;

    document.querySelectorAll<HTMLElement>('.node-marker[data-play-id]').forEach((marker) => {
      const playId = marker.dataset.playId;
      if (!playId) return;
      const node = nodeMapRef.current.get(playId);
      if (!node) return;
      const offsetX = Number(marker.dataset.offsetX || 0);
      marker.style.left = `${transform.applyX(xScale(getDisplayX(node))) + offsetX}px`;
      marker.style.top = `${transform.applyY(yScale(getDisplayY(node))) - 8}px`;
    });
  }, []);

  const scheduleOverlayUpdate = useCallback(() => {
    if (overlayFrameRef.current !== null) return;
    overlayFrameRef.current = window.requestAnimationFrame(() => {
      overlayFrameRef.current = null;
      syncOverlayPositionsNow();
      setScreenRevision((revision) => revision + 1);
    });
  }, [syncOverlayPositionsNow]);

  const scheduleScreenConstantStrokes = useCallback(() => {
    if (strokeFrameRef.current !== null) return;
    strokeFrameRef.current = window.requestAnimationFrame(() => {
      strokeFrameRef.current = null;
      applyScreenConstantStrokes();
    });
  }, [applyScreenConstantStrokes]);

  useEffect(() => {
    return () => {
      if (overlayFrameRef.current !== null) {
        window.cancelAnimationFrame(overlayFrameRef.current);
      }
      if (strokeFrameRef.current !== null) {
        window.cancelAnimationFrame(strokeFrameRef.current);
      }
    };
  }, []);

  const updateNodeVisualState = useCallback(() => {
    const nodeLayer = nodeLayerRef.current;
    if (!nodeLayer) return;
    const hasHighlight = highlightIdsRef.current.size > 0;
    const selectedId = selectedPlayIdRef.current;
    const hoverId = hoveredPlayIdRef.current;
    nodeLayer.selectAll<SVGCircleElement, NebulaNode>('circle.node-halo')
      .attr('opacity', (d) => {
        if (hoverId === d.play_id) return 0.28;
        if (hasHighlight && !highlightIdsRef.current.has(d.play_id)) return 0.03;
        return 0.1;
      });

    nodeLayer.selectAll<SVGCircleElement, NebulaNode>('circle.node')
      .attr('stroke', (d) => {
        if (highlightIdsRef.current.has(d.play_id)) return COLORS.searchHit;
        if (selectedId === d.play_id) return COLORS.highlight;
        if (clusterViewMode !== 'fine' && d.is_focus) return COLORS.highlight;
        return 'rgba(255,255,255,0.08)';
      })
      .attr('stroke-width', (d) => getNodeStrokeWidth(d.play_id))
      .style('opacity', (d) => {
        if (hoverId === d.play_id) return 1;
        if (!hasHighlight) return 0.95;
        return highlightIdsRef.current.has(d.play_id) ? 1 : 0.22;
      });
  }, [clusterViewMode, getNodeStrokeWidth]);

  const syncTooltipScreen = useCallback((tip: TooltipState) => {
    if (!scalesRef.current) return null;
    const { xScale, yScale } = scalesRef.current;
    const t = transformRef.current;
    return {
      left: t.applyX(xScale(tip.dataX)) + 12,
      top: t.applyY(yScale(tip.dataY)) - 10,
    };
  }, [screenRevision]);

  const getNodeScreenPos = useCallback((playId: string) => {
    const node = nodeMapRef.current.get(playId);
    if (!node || !scalesRef.current) return null;
    const { xScale, yScale } = scalesRef.current;
    const t = transformRef.current;
    return {
      left: t.applyX(xScale(getDisplayX(node))),
      top: t.applyY(yScale(getDisplayY(node))),
    };
  }, [screenRevision]);

  const nodeMarkers = useMemo((): NodeMarker[] => {
    if (highlightIds.size === 0 && !selectedPlayId) return [];

    const hlIds = [...highlightIds].filter((id) => visibleNodeIds.has(id));
    const hasSelected = Boolean(selectedPlayId && visibleNodeIds.has(selectedPlayId));
    const selectedInHl = hasSelected && selectedPlayId && highlightIds.has(selectedPlayId);

    if (hasSelected && selectedInHl && hlIds.length === 1 && hlIds[0] === selectedPlayId) {
      return [{ playId: selectedPlayId!, label: '当前 · 高亮', offsetX: 0, kind: 'both' }];
    }

    const markers: NodeMarker[] = [];
    if (hasSelected && selectedPlayId) {
      markers.push({ playId: selectedPlayId, label: '当前', offsetX: -46, kind: 'current' });
    }

    const hlTarget =
      hlIds.find((id) => id !== selectedPlayId)
      || (!hasSelected && hlIds.length > 0 ? hlIds[0] : null);

    if (hlTarget && hlTarget !== selectedPlayId) {
      markers.push({ playId: hlTarget, label: '高亮', offsetX: 46, kind: 'highlight' });
    } else if (hlTarget && !hasSelected) {
      markers.push({ playId: hlTarget, label: '高亮', offsetX: 0, kind: 'highlight' });
    }

    return markers;
  }, [selectedPlayId, highlightIds, visibleNodeIds, focusTargetPlayId]);

  const drawEdges = useCallback((
    g: d3.Selection<SVGGElement, unknown, null, undefined>,
    visibleEdges: NebulaEdge[],
    nodeMap: Map<string, NebulaNode>,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>,
    activeHover: string | null,
  ) => {
    g.selectAll('line.edge').remove();
    const drawableEdges = visibleEdges.filter(
      (edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target),
    );
    if (drawableEdges.length === 0) return;
    const emphasizeStrongEdges = edgeMode === 'strong' && !activeHover;

    g.selectAll('line.edge')
      .data(drawableEdges)
      .enter()
      .append('line')
      .attr('class', 'edge')
      .attr('vector-effect', 'non-scaling-stroke')
      .attr('x1', (d) => xScale(getDisplayX(nodeMap.get(d.source)!)))
      .attr('y1', (d) => yScale(getDisplayY(nodeMap.get(d.source)!)))
      .attr('x2', (d) => xScale(getDisplayX(nodeMap.get(d.target)!)))
      .attr('y2', (d) => yScale(getDisplayY(nodeMap.get(d.target)!)))
      .attr('stroke', (d) => {
        const isHover =
          activeHover &&
          (d.source === activeHover || d.target === activeHover);
        if (isHover) return 'rgba(255,213,79,0.55)';
        if (emphasizeStrongEdges) return 'rgba(255,213,79,0.34)';
        if (d.annotation_label === '数据归组问题') return 'rgba(255,213,79,0.22)';
        return 'rgba(255,255,255,0.08)';
      })
      .attr('stroke-width', (d) => getEdgeBaseWidth(d, activeHover) * (emphasizeStrongEdges ? 1.75 : 1))
      .attr('stroke-dasharray', (d) =>
        d.relation_type === 'annotated_bridge' ? '3 4' : 'none',
      )
      .attr('stroke-opacity', (d) => {
        const isHover =
          activeHover &&
          (d.source === activeHover || d.target === activeHover);
        if (isHover) return 0.9;
        return emphasizeStrongEdges ? 0.72 : 0.5;
      })
      .append('title')
      .text((d) => describeEdge(d));
  }, [edgeMode]);

  const refreshEdges = useCallback(() => {
    const layer = edgeLayerRef.current;
    const scales = scalesRef.current;
    if (!layer || !scales) return;
    const activeHover = hoveredPlayIdRef.current;
    const visibleEdges = filterEdges(edges, edgeMode, activeHover, visibleNodeIds);
    drawEdges(layer, visibleEdges, nodeMapRef.current, scales.xScale, scales.yScale, activeHover);
  }, [edges, edgeMode, visibleNodeIds, drawEdges]);

  const setNodePointerEvents = useCallback((enabled: boolean) => {
    const nodeLayer = nodeLayerRef.current;
    if (!nodeLayer) return;
    nodeLayer
      .selectAll<SVGGElement, NebulaNode>('g.node-group')
      .style('pointer-events', enabled ? 'auto' : 'none');
  }, []);

  const activateDragMode = useCallback(() => {
    if (isDraggingViewRef.current) return;
    isDraggingViewRef.current = true;
    setIsDraggingView(true);
    setNodePointerEvents(false);
    if (hoveredPlayIdRef.current) {
      setHoveredPlayId(null);
      refreshEdges();
    }
    setTooltip(null);
  }, [refreshEdges, setHoveredPlayId, setNodePointerEvents]);

  const deactivateDragMode = useCallback(() => {
    if (!isDraggingViewRef.current) return;
    isDraggingViewRef.current = false;
    pendingDragStartRef.current = false;
    suppressNodeClickUntilRef.current = Date.now() + 250;
    setIsDraggingView(false);
    setNodePointerEvents(true);
    scheduleOverlayUpdate();
  }, [scheduleOverlayUpdate, setNodePointerEvents]);

  const renderNebula = useCallback(() => {
    const svg = d3.select(svgRef.current);
    if (!svgRef.current) return;

    svg.selectAll('*').remove();

    if (spaceMode === '3d') {
      scalesRef.current = null;
      nodeMapRef.current = new Map();
      edgeLayerRef.current = null;
      nodeLayerRef.current = null;
      return;
    }

    if (displayNodes.length === 0) {
      scalesRef.current = null;
      nodeMapRef.current = new Map();
      edgeLayerRef.current = null;
      nodeLayerRef.current = null;
      return;
    }

    const width = Math.max(360, window.innerWidth - sidebarWidth);
    const height = Math.max(360, window.innerHeight);

    const gZoom = svg.append('g').attr('class', 'zoom-layer');
    zoomLayerRef.current = gZoom;

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 10])
      .on('start', (e) => {
        if (!e.sourceEvent || e.sourceEvent.type !== 'mousedown') return;
        pendingDragStartRef.current = true;
      })
      .on('zoom', (e) => {
        transformRef.current = e.transform;
        if (pendingDragStartRef.current && e.sourceEvent?.type === 'mousemove') {
          activateDragMode();
        }
        gZoom.attr('transform', e.transform);
        syncOverlayPositionsNow();
        scheduleOverlayUpdate();
      })
      .on('end', () => {
        pendingDragStartRef.current = false;
        deactivateDragMode();
      });
    svg.call(zoom as never);
    zoomRef.current = zoom;
    const currentTransform = transformRef.current;
    svg.property('__zoom', currentTransform);
    gZoom.attr('transform', currentTransform.toString());
    svg
      .on('wheel.overlay-sync', () => scheduleOverlayUpdate())
      .on('pointermove.overlay-sync', () => {
        if (isDraggingViewRef.current) scheduleOverlayUpdate();
      });

    const xs = displayNodes.map((d) => d.displayX);
    const ys = displayNodes.map((d) => d.displayY);
    const padding = 80;
    const xDomain = layoutMode === 'tidy' ? [-1.16, 1.16] as [number, number] : d3.extent(xs) as [number, number];
    const yDomain = layoutMode === 'tidy' ? [-0.92, 0.92] as [number, number] : d3.extent(ys) as [number, number];
    const xScale = d3.scaleLinear().domain(xDomain).range([padding, width - padding]);
    const yScale = d3.scaleLinear().domain(yDomain).range([padding, height - padding]);
    scalesRef.current = { xScale, yScale };

    const nodeMap = new Map(displayNodes.map((n) => [n.play_id, n]));
    nodeMapRef.current = nodeMap;
    const hasHighlight = highlightIdsRef.current.size > 0;

    const stars = buildStarfield(50, width, height);
    gZoom.append('g').attr('class', 'starfield')
      .selectAll('circle')
      .data(stars)
      .enter()
      .append('circle')
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y)
      .attr('r', (d) => d.r)
      .attr('fill', '#6a7a94')
      .attr('opacity', (d) => d.o);

    const clusterGlows = buildClusterGlows(
      displayNodes,
      (v) => xScale(v),
      (v) => yScale(v),
      (node) => (clusterViewMode === 'fine' ? node.cluster_id || 'other' : node.coarse_cluster_id || node.cluster_id || 'other'),
      getVisualNodeColor,
    );
    const mistLayer = gZoom.append('g').attr('class', 'cluster-mist');
    mistLayer.selectAll('circle')
      .data(clusterGlows)
      .enter()
      .append('circle')
      .attr('cx', (d) => d.cx)
      .attr('cy', (d) => d.cy)
      .attr('r', (d) => d.r)
      .attr('fill', (d) => d.color)
      .attr('opacity', 0.028);

    const edgeLayer = gZoom.append('g').attr('class', 'edges');
    edgeLayerRef.current = edgeLayer;
    const initialEdges = filterEdges(edges, edgeMode, null, visibleNodeIds);
    drawEdges(edgeLayer, initialEdges, nodeMap, xScale, yScale, null);

    const nodeLayer = gZoom.append('g').attr('class', 'nodes');
    nodeLayerRef.current = nodeLayer;
    const nodeGroups = nodeLayer
      .selectAll<SVGGElement, NebulaNode>('g.node-group')
      .data(displayNodes, (d) => d.play_id)
      .enter()
      .append('g')
      .attr('class', 'node-group')
      .style('cursor', 'pointer');

    nodeGroups.append('circle')
      .attr('class', 'node-halo')
      .attr('cx', (d) => xScale(d.displayX))
      .attr('cy', (d) => yScale(d.displayY))
      .attr('r', (d) => coreGlowRadius(d))
      .attr('fill', (d) => getVisualNodeColor(d))
      .attr('opacity', (d) => {
        if (hasHighlight && !highlightIdsRef.current.has(d.play_id)) return 0.03;
        return hoveredPlayIdRef.current === d.play_id ? 0.22 : 0.1;
      });

    nodeGroups.append('circle')
      .attr('class', 'node')
      .attr('vector-effect', 'non-scaling-stroke')
      .attr('cx', (d) => xScale(d.displayX))
      .attr('cy', (d) => yScale(d.displayY))
      .attr('r', (d) => nodeRadius(d))
      .attr('fill', (d) => getVisualNodeColor(d))
      .attr('stroke', (d) => {
        if (highlightIdsRef.current.has(d.play_id)) return COLORS.searchHit;
        if (selectedPlayIdRef.current === d.play_id) return COLORS.highlight;
        if (clusterViewMode !== 'fine' && d.is_focus) return COLORS.highlight;
        return 'rgba(255,255,255,0.08)';
      })
      .attr('stroke-width', (d) => getNodeStrokeWidth(d.play_id))
      .style('opacity', (d) => {
        if (!hasHighlight) return 0.95;
        return highlightIdsRef.current.has(d.play_id) ? 1 : 0.22;
      });

    nodeGroups
      .on('click', (_, d) => {
        if (Date.now() < suppressNodeClickUntilRef.current) return;
        setSelectedClusterId(null);
        setSelectedPlayId(d.play_id);
        setSelectedNode(d);
        setHighlightIds(new Set([d.play_id]));
        setFocusTargetPlayId(d.play_id);
      })
      .on('mouseover', function (_, d) {
        if (isDraggingViewRef.current) return;
        setHoveredPlayId(d.play_id);
        const gNode = d3.select(this);
        gNode.select('.node')
          .attr('r', nodeRadius(d) * 1.6)
          .attr('stroke-width', getNodeStrokeWidth(d.play_id))
          .style('opacity', 1);
        gNode.select('.node-halo').attr('r', coreGlowRadius(d) * 1.35).attr('opacity', 0.28);
        setTooltip({ title: d.title, playId: d.play_id, dataX: d.displayX, dataY: d.displayY });
        refreshEdges();
        scheduleScreenConstantStrokes();
      })
      .on('mouseout', function (_, d) {
        if (isDraggingViewRef.current) return;
        setHoveredPlayId(null);
        const gNode = d3.select(this);
        gNode.select('.node')
          .attr('r', nodeRadius(d))
          .attr('stroke-width', getNodeStrokeWidth(d.play_id))
          .style('opacity', highlightIdsRef.current.size > 0 ? (highlightIdsRef.current.has(d.play_id) ? 1 : 0.22) : 0.95);
        gNode.select('.node-halo')
          .attr('r', coreGlowRadius(d))
          .attr('opacity', highlightIdsRef.current.size > 0 && !highlightIdsRef.current.has(d.play_id) ? 0.03 : 0.1);
        setTooltip(null);
        refreshEdges();
        scheduleScreenConstantStrokes();
      });

    const legendLayer = svg.append('g').attr('class', 'legend-fixed');
    const isFineLegend = clusterViewMode === 'fine';
    const legendColumns = isFineLegend ? 2 : 1;
    const legendWidth = isFineLegend ? 330 : 130;
    const rowHeight = isFineLegend ? FINE_LEGEND_ROW_HEIGHT : LEGEND_ROW_HEIGHT;
    const rows = Math.ceil(legendItems.length / legendColumns);
    const legendHeight = rows * rowHeight + 34;
    const legendX = Math.max(16, width - legendWidth - 20);
    const legendY = Math.max(96, height - legendHeight - 24);
    const legend = legendLayer.append('g').attr('transform', `translate(${legendX}, ${legendY})`);
    legend.append('rect')
      .attr('width', legendWidth)
      .attr('height', legendHeight)
      .attr('fill', 'rgba(0,0,0,0.55)')
      .attr('rx', 6);
    legend.append('text')
      .attr('x', 14)
      .attr('y', 20)
      .attr('fill', COLORS.paper)
      .attr('font-size', 11)
      .attr('font-weight', 700)
      .text(isFineLegend ? '细星团图例' : '粗星团图例');

    legendItems.forEach((item, i) => {
      const col = isFineLegend ? i % legendColumns : 0;
      const row = isFineLegend ? Math.floor(i / legendColumns) : i;
      const colWidth = legendWidth / legendColumns;
      const x = 14 + col * colWidth;
      const y = 42 + row * rowHeight;
      const label = isFineLegend && 'count' in item ? `${item.label} (${item.count})` : item.label;
      const itemGroup = legend.append('g');
      itemGroup.append('title').text(label);
      itemGroup.append('circle')
        .attr('cx', x)
        .attr('cy', y - 4)
        .attr('r', isFineLegend ? 4 : 5)
        .attr('fill', item.color);
      itemGroup.append('text')
        .attr('x', x + 14)
        .attr('y', y)
        .attr('fill', '#e0e0e0')
        .attr('font-size', isFineLegend ? 9 : 10)
        .text(label);
    });
    scheduleOverlayUpdate();
  }, [
    displayNodes,
    edges,
    edgeMode,
    visibleNodeIds,
    activateDragMode,
    deactivateDragMode,
    drawEdges,
    getNodeStrokeWidth,
    refreshEdges,
    scheduleOverlayUpdate,
    scheduleScreenConstantStrokes,
    clusterViewMode,
    getVisualNodeColor,
    legendItems,
    spaceMode,
    sidebarWidth,
    layoutMode,
  ]);

  useEffect(() => {
    if (spaceMode === '2d') refreshEdges();
  }, [refreshEdges, spaceMode]);

  useEffect(() => {
    if (spaceMode !== '2d') return;
    updateNodeVisualState();
    scheduleScreenConstantStrokes();
    scheduleOverlayUpdate();
  }, [
    highlightIds,
    selectedPlayId,
    hoveredPlayId,
    updateNodeVisualState,
    scheduleScreenConstantStrokes,
    scheduleOverlayUpdate,
    spaceMode,
  ]);

  useEffect(() => {
    if (spaceMode === '2d') syncOverlayPositionsNow();
  }, [nodeMarkers, spaceMode, syncOverlayPositionsNow]);

  useEffect(() => {
    if (!loading) renderNebula();
  }, [loading, renderNebula]);

  useEffect(() => {
    const onResize = () => renderNebula();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [renderNebula]);

  const focusOnPlayIds = useCallback((playIds: string[]) => {
    if (!playIds.length || !svgRef.current || !zoomRef.current || !scalesRef.current) return;

    const targets = playIds.flatMap((id) => {
      const node = displayNodes.find((n) => n.play_id === id);
      return node && visibleNodeIds.has(node.play_id) ? [node] : [];
    });
    if (!targets.length) return;

    if (spaceMode === '3d') return;

    const width = Math.max(360, window.innerWidth - sidebarWidthRef.current);
    const height = Math.max(360, window.innerHeight);
    const { xScale, yScale } = scalesRef.current;
    const px = targets.map((n) => xScale(getDisplayX(n)));
    const py = targets.map((n) => yScale(getDisplayY(n)));

    const cx = (Math.min(...px) + Math.max(...px)) / 2;
    const cy = (Math.min(...py) + Math.max(...py)) / 2;
    const span = Math.max(
      Math.max(...px) - Math.min(...px),
      Math.max(...py) - Math.min(...py),
      28,
    );

    const k = targets.length === 1
      ? 3.2
      : Math.min(2.8, Math.max(1.5, (Math.min(width, height) * 0.4) / span));

    const transform = d3.zoomIdentity.translate(width / 2 - cx * k, height / 2 - cy * k).scale(k);
    d3.select(svgRef.current)
      .transition()
      .duration(650)
      .call(zoomRef.current.transform as never, transform);
  }, [displayNodes, visibleNodeIds, spaceMode]);

  const scheduleFocus = useCallback((playIds: string[]) => {
    window.setTimeout(() => focusOnPlayIds(playIds), 80);
  }, [focusOnPlayIds]);

  const handleSearchSelect = (item: SearchItem) => {
    setCoarseFilter(null);
    setFineClusterFilter(null);
    setSelectedClusterId(null);
    setSelectedPlayId(item.play_id);
    setHighlightIds(new Set([item.play_id]));
    setFocusTargetPlayId(item.play_id);
    const node = nodes.find((n) => n.play_id === item.play_id);
    if (node) setSelectedNode(node);
    scheduleFocus([item.play_id]);
  };

  const handleSelectNode = useCallback((node: NebulaNode) => {
    setSelectedClusterId(null);
    setSelectedPlayId(node.play_id);
    setSelectedNode(node);
    setHighlightIds(new Set([node.play_id]));
    setFocusTargetPlayId(node.play_id);
    setShowGlobalAi(false);
    if (spaceMode === '2d') scheduleFocus([node.play_id]);
  }, [scheduleFocus, spaceMode]);

  const handleSelectPlayById = useCallback((playId: string, openVersions = false) => {
    const node = nodes.find((n) => n.play_id === playId);
    setCoarseFilter(null);
    setFineClusterFilter(null);
    setSelectedClusterId(null);
    setSelectedPlayId(playId);
    setSelectedNode(node || null);
    setHighlightIds(new Set([playId]));
    setFocusTargetPlayId(playId);
    setShowGlobalAi(false);
    setShowRiver(openVersions);
    if (spaceMode === '2d') scheduleFocus([playId]);
  }, [nodes, scheduleFocus, spaceMode]);

  const handleHighlight = useCallback((ids: string[], type?: string, options?: HighlightOptions) => {
    if (!ids.length) return;
    const primaryId = ids[0];
    let focusPlayIds: string[] = [];

    if (type === 'cluster') {
      setSelectedClusterId(primaryId);
      setFineClusterFilter(primaryId);
      setClusterViewMode('fine');
      setCoarseFilter(null);
      setSelectedPlayId(null);
      setSelectedNode(null);
      setShowRiver(false);
      const clusterNodeIds = nodes
        .filter((n) => n.cluster_id === primaryId)
        .map((n) => n.play_id);
      const hlSet = new Set(clusterNodeIds.length ? clusterNodeIds : ids);
      setHighlightIds(hlSet);
      focusPlayIds = clusterNodeIds.length ? clusterNodeIds : [];
      setFocusTargetPlayId(clusterNodeIds[0] || null);
      setShowGlobalAi(false);
      if (options?.focus && focusPlayIds.length) scheduleFocus(focusPlayIds);
      return;
    }

    if (type === 'play_group') {
      const groupNodes = nodes.filter((n) => n.play_group_id === primaryId);
      const playIds = groupNodes.map((n) => n.play_id);
      if (playIds.length) {
        setFineClusterFilter(null);
        setCoarseFilter(null);
        setSelectedClusterId(null);
        setSelectedPlayId(playIds[0]);
        const node = nodes.find((n) => n.play_id === playIds[0]);
        if (node) setSelectedNode(node);
        setHighlightIds(new Set(playIds));
        setFocusTargetPlayId(playIds[0]);
        focusPlayIds = playIds;
        setShowRiver(true);
        setShowGlobalAi(false);
      } else {
        setHighlightIds(new Set(ids));
      }
      if (options?.focus && focusPlayIds.length) scheduleFocus(focusPlayIds);
      return;
    }

    if (type === 'version') {
      const node = nodes.find((n) => n.version_id === primaryId);
      if (node) {
        setFineClusterFilter(null);
        setCoarseFilter(null);
        setSelectedClusterId(null);
        setSelectedPlayId(node.play_id);
        setSelectedNode(node);
        setHighlightIds(new Set([node.play_id]));
        setFocusTargetPlayId(node.play_id);
        focusPlayIds = [node.play_id];
        setShowRiver(true);
        setShowGlobalAi(false);
      } else {
        setHighlightIds(new Set(ids));
      }
      if (options?.focus && focusPlayIds.length) scheduleFocus(focusPlayIds);
      return;
    }

    setSelectedClusterId(null);
    setFineClusterFilter(null);
    setCoarseFilter(null);
    setHighlightIds(new Set(ids));
    const node = nodes.find((n) => n.play_id === primaryId);
    if (node) {
      setSelectedPlayId(primaryId);
      setSelectedNode(node);
      setFocusTargetPlayId(primaryId);
      focusPlayIds = ids.filter((id) => nodes.some((n) => n.play_id === id));
    } else {
      setFocusTargetPlayId(null);
    }
    setShowGlobalAi(false);
    if (options?.focus && focusPlayIds.length) scheduleFocus(focusPlayIds);
  }, [nodes, scheduleFocus]);

  const tooltipPos = tooltip ? syncTooltipScreen(tooltip) : null;

  const cycleEdgeMode = () => {
    setEdgeMode((m) => (m === 'strong' ? 'all' : m === 'all' ? 'none' : 'strong'));
  };

  const toggleViewMode = () => {
    resetSelection();
    setCoarseFilter(null);
    setFineClusterFilter(null);
    setViewMode((m) => (m === 'focus' ? 'all' : 'focus'));
  };

  const edgeModeLabel = edgeMode === 'strong' ? '强关系连线' : edgeMode === 'all' ? '全部连线' : '隐藏连线';

  const visibleEdgeCount = useMemo(
    () => filterEdges(edges, edgeMode, hoveredPlayId, visibleNodeIds).length,
    [edges, edgeMode, hoveredPlayId, visibleNodeIds],
  );

  if (loading && nodes.length === 0) {
    return (
      <div className="app-loading">
        <div>加载星云数据中…</div>
        <p style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 8 }}>
          请确认后端已启动：uvicorn main:app --reload
        </p>
      </div>
    );
  }

  return (
    <div className="app-root notranslate" translate="no">
      <div className="app-main nebula-stage" style={{ width: sidebarWidth ? `calc(100% - ${sidebarWidth}px)` : '100%' }}>
        <svg ref={svgRef} className={spaceMode === '3d' ? 'app-svg app-svg-hidden' : 'app-svg'} />

        {spaceMode === '3d' && (
          <Nebula3D
            nodes={displayNodes}
            edges={edges}
            edgeMode={edgeMode}
            sidebarWidth={sidebarWidth}
            clusterViewMode={clusterViewMode}
            legendItems={legendItems}
            selectedPlayId={selectedPlayId}
            highlightIds={highlightIds}
            isRotating={is3DRotating}
            layoutMode={layoutMode}
            getNodeColor3D={getVisualNodeColor}
            onSelectNode={handleSelectNode}
          />
        )}

        {spaceMode === '2d' && !isDraggingView && tooltip && tooltipPos && (
          <div
            className="nebula-tooltip"
            style={{ left: tooltipPos.left, top: tooltipPos.top, fontSize: TOOLTIP_FONT }}
          >
            {tooltip.title}
          </div>
        )}

        {spaceMode === '2d' && nodeMarkers.map((m) => {
          const pos = getNodeScreenPos(m.playId);
          if (!pos) return null;
          return (
            <div
              key={`${m.playId}-${m.kind}`}
              className={`node-marker node-marker-${m.kind}`}
              data-play-id={m.playId}
              data-offset-x={m.offsetX}
              style={{ left: pos.left + m.offsetX, top: pos.top - 8 }}
            >
              <span className="node-marker-label">{m.label}</span>
              <span className="node-marker-arrow">▼</span>
            </div>
          );
        })}

        <div className="app-toolbar">
          <SearchBar onSelect={handleSearchSelect} />

          <div className="toolbar-group">
            <div className="toolbar-chip-group">
              <span className="toolbar-chip-label">视图</span>
              <button
                type="button"
                className={viewMode === 'focus' ? 'toolbar-btn active' : 'toolbar-btn'}
                onClick={toggleViewMode}
              >
                {viewMode === 'focus' ? '重点剧目' : '全部节点'}
              </button>
              <button
                type="button"
                className={clusterViewMode === 'fine' ? 'toolbar-btn active' : 'toolbar-btn'}
                onClick={() => {
                  setClusterViewMode((mode) => (mode === 'fine' ? 'coarse' : 'fine'));
                  setFineClusterFilter(null);
                  setSelectedClusterId(null);
                  setHighlightIds(new Set());
                  setFocusTargetPlayId(null);
                }}
              >
                {clusterViewMode === 'fine' ? '全部细星团' : '粗星团视图'}
              </button>
              <button
                type="button"
                className={spaceMode === '3d' ? 'toolbar-btn active' : 'toolbar-btn'}
                onClick={() => {
                  setSpaceMode((mode) => (mode === '3d' ? '2d' : '3d'));
                  setTooltip(null);
                  setHoveredPlayId(null);
                }}
              >
                {spaceMode === '3d' ? '3D 星云' : '2D 星云'}
              </button>
              <button
                type="button"
                className={layoutMode === 'tidy' ? 'toolbar-btn active' : 'toolbar-btn'}
                onClick={() => setLayoutMode((mode) => (mode === 'tidy' ? 'raw' : 'tidy'))}
              >
                {layoutMode === 'tidy' ? '整理布局' : '原始布局'}
              </button>
              {spaceMode === '3d' && (
                <button
                  type="button"
                  className={is3DRotating ? 'toolbar-btn active' : 'toolbar-btn'}
                  onClick={() => setIs3DRotating((value) => !value)}
                >
                  {is3DRotating ? '停止旋转' : '旋转'}
                </button>
              )}
            </div>

            <div className="toolbar-chip-group">
              <span className="toolbar-chip-label">关系</span>
              <button
                type="button"
                className={edgeMode !== 'none' ? 'toolbar-btn active' : 'toolbar-btn'}
                onClick={cycleEdgeMode}
              >
                {edgeModeLabel}
              </button>
              <button
                type="button"
                className={showVizGuide ? 'toolbar-btn active' : 'toolbar-btn'}
                onClick={() => setShowVizGuide((value) => !value)}
              >
                图谱说明
              </button>
              <button
                type="button"
                className={showVersionReport ? 'toolbar-btn active' : 'toolbar-btn'}
                onClick={() => setShowVersionReport((value) => !value)}
              >
                版本传承
              </button>
              <button
                type="button"
                className={showGlobalAi ? 'toolbar-btn active' : 'toolbar-btn'}
                onClick={() => {
                  setShowGlobalAi((v) => !v);
                  if (!showGlobalAi) setSelectedClusterId(null);
                }}
              >
                AI 导览
              </button>
            </div>
          </div>

          <div className="toolbar-filter-group">
            <div className="toolbar-filter-block">
              <span className="toolbar-chip-label">粗星团</span>
              <select
                className="toolbar-select"
                value={coarseFilter || ''}
                onChange={(e) => {
                  setCoarseFilter(e.target.value || null);
                  setFineClusterFilter(null);
                  setClusterViewMode('coarse');
                  setSelectedClusterId(null);
                  setHighlightIds(new Set());
                  setFocusTargetPlayId(null);
                }}
              >
                <option value="">全部粗星团</option>
                {coarseClusters.map((c) => (
                  <option key={c.coarse_cluster_id} value={c.coarse_cluster_id}>
                    {COARSE_CLUSTER_LABELS[c.coarse_cluster_id] || c.coarse_cluster_name} ({c.node_count})
                  </option>
                ))}
              </select>
            </div>

            <div className="toolbar-filter-block">
              <span className="toolbar-chip-label">细星团</span>
              <select
                className="toolbar-select"
                value={fineClusterFilter || ''}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) {
                    setFineClusterFilter(id);
                    setSelectedClusterId(null);
                    setClusterViewMode('fine');
                    setCoarseFilter(null);
                    setSelectedPlayId(null);
                    setSelectedNode(null);
                    const clusterNodeIds = nodes
                      .filter((n) => n.cluster_id === id)
                      .map((n) => n.play_id);
                    setHighlightIds(new Set());
                    setFocusTargetPlayId(clusterNodeIds[0] || null);
                    window.setTimeout(() => {
                      if (clusterNodeIds.length) focusOnPlayIds(clusterNodeIds);
                    }, 120);
                  } else {
                    setFineClusterFilter(null);
                    setSelectedClusterId(null);
                    setHighlightIds(new Set());
                    setFocusTargetPlayId(null);
                  }
                }}
              >
                <option value="">选择细星团…</option>
                {clusters.map((c) => (
                  <option key={c.cluster_id} value={c.cluster_id}>
                    {c.cluster_name} ({c.node_count})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {selectedFineCluster && (
          <div className="active-filter-bar">
            <span>
              细星团可视化：{selectedFineCluster.cluster_name} · {visibleNodes.length} 个剧目
            </span>
            <button
              type="button"
              className="filter-icon-btn"
              onClick={() => setSelectedClusterId(selectedFineCluster.cluster_id)}
              title="打开细星团详情"
              aria-label="打开细星团详情"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="4" y="5" width="14" height="14" rx="3" />
                <path d="M18 8h2v8h-2" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => {
                setFineClusterFilter(null);
                setSelectedClusterId(null);
                setHighlightIds(new Set());
                setFocusTargetPlayId(null);
              }}
            >
              恢复全部
            </button>
          </div>
        )}

        {showVizGuide && (
          <div className={selectedFineCluster ? 'viz-guide-panel viz-guide-panel-offset' : 'viz-guide-panel'}>
            <div className="viz-guide-header">
              <strong>图谱说明</strong>
              <button type="button" onClick={() => setShowVizGuide(false)}>关闭</button>
            </div>
            <div className="viz-guide-grid">
              <div>
                <span className="viz-guide-kicker">节点</span>
                <p>每个光点代表一个京剧剧本版本；点越大，主要角色数越多。</p>
              </div>
              <div>
                <span className="viz-guide-kicker">颜色</span>
                <p>{clusterViewMode === 'fine' ? '当前按细星团着色，用于观察更具体的题材社区。' : '当前按粗星团着色，对应三国、公案、神怪等题材大类。'}</p>
              </div>
              <div>
                <span className="viz-guide-kicker">位置</span>
                <p>{layoutMode === 'tidy' ? '整理布局在保留星团归属和局部相邻关系的基础上压缩离群点，让题材社区更容易阅读；可切回原始布局查看降维坐标。' : '原始布局直接展示文本语义、题材、角色行当、来源、角色网络和舞台节奏等复合特征的降维坐标；相近表示文化特征更接近。'}</p>
              </div>
              <div>
                <span className="viz-guide-kicker">连线</span>
                <p>{edgeMode === 'all' ? '全部连线展示更多潜在相似关系，适合检查整体网络密度。' : edgeMode === 'strong' ? '强关系连线突出同名版本、共享核心角色或高相似剧目；悬浮节点会补充显示其邻近关系。' : '当前隐藏连线，适合观察星团整体分布。'}</p>
              </div>
              <div>
                <span className="viz-guide-kicker">3D</span>
                <p>3D 视图用于沉浸式观察星团空间，不新增历史轴；深度根据星团扰动和角色/版本复杂度生成，辅助分离重叠点。</p>
              </div>
              <div>
                <span className="viz-guide-kicker">探索路径</span>
                <p>建议按“总览星团 - 细星团解释 - 剧目详情 - 版本传承 - AI 证据问答”的顺序讲述作品。</p>
              </div>
            </div>
          </div>
        )}

        {error && <div className="app-error">{error}</div>}

        {!loading && !error && visibleNodes.length === 0 && (
          <div className="empty-nebula-state">
            <h3>当前筛选没有可显示的剧目</h3>
            <p>请切回全部节点，或清除粗星团筛选后继续浏览。</p>
            <button
              type="button"
              onClick={() => {
                setViewMode('all');
                setCoarseFilter(null);
                setFineClusterFilter(null);
                resetSelection();
              }}
            >
              恢复全部星云
            </button>
          </div>
        )}

        <div className="app-status">
          {visibleNodes.length} 个剧目
          {spaceMode === '3d' && ' · 三维星云'}
          {layoutMode === 'tidy' ? ' · 整理布局' : ' · 原始布局'}
          {clusterViewMode === 'fine' && !selectedFineCluster && ' · 全部细星团视图'}
          {selectedFineCluster && ` · 细星团：${selectedFineCluster.cluster_name}`}
          {edgeMode !== 'none' && ` · ${visibleEdgeCount} 条连线`}
          {edgeMode === 'strong' && ' · 悬浮显示邻近'}
          {viewMode === 'focus' && ' · 重点模式'}
        </div>
      </div>

      {showGlobalAi && !selectedPlayId && !selectedClusterId && (
        <GlobalAiPanel
          onClose={() => setShowGlobalAi(false)}
          onHighlight={handleHighlight}
          width={globalAiWidth}
          onWidthChange={setGlobalAiWidth}
        />
      )}

      {showVersionReport && (
        <VersionLineageReport
          nodes={nodes}
          onClose={() => setShowVersionReport(false)}
          onHighlightPlay={(playId) => handleSelectPlayById(playId, false)}
          onOpenVersions={(playId) => {
            handleSelectPlayById(playId, true);
            setShowVersionReport(false);
          }}
        />
      )}

      {selectedClusterId && !selectedPlayId && (
        <ClusterPanel
          clusterId={selectedClusterId}
          onClose={() => setSelectedClusterId(null)}
          width={clusterSidebarWidth}
          onWidthChange={setClusterSidebarWidth}
          onSelectPlay={(id) => {
            setSelectedPlayId(id);
            setSelectedClusterId(null);
            const node = nodes.find((n) => n.play_id === id);
            if (node) setSelectedNode(node);
            setHighlightIds(new Set([id]));
            setFocusTargetPlayId(id);
            scheduleFocus([id]);
          }}
        />
      )}

      {selectedPlayId && (
        <PlayDetailPanel
          playId={selectedPlayId}
          nodePreview={selectedNode ? (selectedNode as unknown as Record<string, unknown>) : undefined}
          onClose={() => {
            setSelectedPlayId(null);
            setSelectedNode(null);
            setHighlightIds(new Set());
            setShowRiver(false);
          }}
          onExploreVersions={() => setShowRiver(true)}
          onHighlight={handleHighlight}
          width={playSidebarWidth}
          onWidthChange={setPlaySidebarWidth}
        />
      )}

      {showRiver && selectedPlayId && (
        <VersionRivers
          playId={selectedPlayId}
          sidebarOffset={playSidebarWidth}
          onClose={() => setShowRiver(false)}
        />
      )}
    </div>
  );
}
