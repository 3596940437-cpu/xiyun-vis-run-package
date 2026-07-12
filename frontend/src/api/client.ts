const isLocalHost = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1';

const getDefaultApiBase = () => {
  if (typeof window === 'undefined') return '';
  const { hostname } = window.location;
  return isLocalHost(hostname) ? 'http://127.0.0.1:8000' : '';
};

const getApiBase = () => {
  const envBase = import.meta.env.VITE_API_BASE?.trim();
  if (!envBase) return getDefaultApiBase();
  if (typeof window === 'undefined') return envBase;

  const pageIsLocal = isLocalHost(window.location.hostname);
  try {
    const envUrl = new URL(envBase, window.location.origin);
    if (!pageIsLocal && isLocalHost(envUrl.hostname)) {
      return '';
    }
  } catch {
    return envBase;
  }

  return envBase;
};

const API_BASE = getApiBase().replace(/\/$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string }>('/health'),

  nebula: (params?: {
    cluster_id?: string;
    focus_only?: boolean;
    include_edges?: boolean;
  }) => {
    const q = new URLSearchParams();
    if (params?.cluster_id) q.set('cluster_id', params.cluster_id);
    if (params?.focus_only) q.set('focus_only', 'true');
    if (params?.include_edges === false) q.set('include_edges', 'false');
    const suffix = q.toString() ? `?${q}` : '';
    return request<NebulaResponse>(`/api/graph/nebula${suffix}`);
  },

  search: (query: string, limit = 20) =>
    request<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`),

  play: (playId: string) => request<PlayDetailResponse>(`/api/play/${playId}`),

  playVersions: (playId: string) =>
    request<VersionDetailResponse>(`/api/play/${playId}/versions`),

  cluster: (clusterId: string) =>
    request<ClusterDetailResponse>(`/api/cluster/${clusterId}`),

  aiChat: (message: string, context?: AiChatContext, history?: AiChatHistoryTurn[]) =>
    request<AiChatResponse>('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, context, history, include_debug: false }),
    }),

  versionLineageReport: () =>
    request<VersionLineageReportResponse>('/api/report/version-lineage'),
};

export interface NebulaNode {
  node_id?: string;
  play_id: string;
  play_group_id?: string;
  version_id?: string;
  title: string;
  title_clean?: string;
  x: number;
  y: number;
  cluster_id?: string;
  coarse_cluster_id?: string;
  themes?: string[];
  source_name?: string;
  version_label?: string;
  role_count?: number;
  role_type_counts?: Record<string, number>;
  version_count?: number;
  is_focus?: boolean;
  main_roles?: string[];
  similarity_reason?: string;
}

export interface NebulaEdge {
  source: string;
  target: string;
  weight?: number;
  distance?: number;
  relation_type?: string;
  reasons?: string[];
  annotation_label?: string;
}

export interface ClusterInfo {
  cluster_id: string;
  cluster_name: string;
  node_count: number;
  representative_play_ids?: string[];
  representative_titles?: string[];
  top_themes?: Array<{ name: string; count: number }>;
  top_keywords?: Array<{ name: string; count: number }>;
  top_role_types?: Array<{ name: string; count: number }>;
  top_sources?: Array<{ name: string; count: number }>;
  explanation?: string;
  coarse_cluster_id?: string;
  coarse_cluster_name?: string;
}

export interface CoarseCluster {
  coarse_cluster_id: string;
  coarse_cluster_name: string;
  node_count: number;
  fine_cluster_count?: number;
  fine_cluster_ids?: string[];
  representative_titles?: string[];
}

export interface NebulaResponse {
  data_version: string;
  nodes: NebulaNode[];
  edges: NebulaEdge[];
  clusters: ClusterInfo[];
  coarse_clusters: CoarseCluster[];
  meta: { node_count: number; edge_count: number; cluster_count: number };
}

export interface SearchItem {
  type: string;
  title: string;
  play_id: string;
  cluster_id?: string;
  score: number;
  matched_fields: string[];
  snippet: string;
  highlight: { type: string; id: string };
}

export interface SearchResponse {
  query: string;
  items: SearchItem[];
  meta: { count: number };
}

export interface RoleInfo {
  role_id: string;
  role_name: string;
  character_key?: string;
  base_role_type: string;
  role_type_family: string;
  is_principal?: boolean;
  importance_score?: number;
}

export interface PlayDetailResponse {
  play: Record<string, unknown>;
  roles: RoleInfo[];
  text_evidence_preview: Array<{
    chunk_id: string;
    text: string;
    chunk_type?: string;
    evidence?: { section?: string };
  }>;
  version_summary?: {
    version_count?: number;
    canonical_title?: string;
    versions?: Array<{
      play_id: string;
      version_id?: string;
      title: string;
      source_name?: string;
      version_label?: string;
      version_index?: number;
      role_count?: number;
    }>;
  };
  neighbors: Array<{
    play_id: string;
    title: string;
    similarity_reason?: string;
    weight?: number;
  }>;
}

export interface VersionDetailResponse {
  play_id: string;
  play_group_id: string;
  canonical_title: string;
  river?: {
    versions: Array<{
      version_id: string;
      play_id: string;
      title: string;
      source_name?: string;
      version_label?: string;
      version_index?: number;
      role_count?: number;
    }>;
  };
  matrix?: {
    version_ids?: string[];
    labels: string[];
    matrix: number[][];
  };
  diff_card?: {
    reference_title?: string;
    reference_version_id?: string;
    diffs: Array<{
      version_id?: string;
      title: string;
      added_roles?: string[];
      missing_roles?: string[];
      added_keywords?: string[];
      missing_keywords?: string[];
      role_type_changes?: Array<{
        character_key: string;
        from: string;
        to: string;
      }>;
      source_difference?: { reference: string; current: string };
      text_delta?: {
        chunk_count_delta?: number;
        scene_count_delta?: number;
        text_length_delta?: number;
        singing_cue_delta?: number;
        spoken_cue_delta?: number;
        stage_direction_hint_delta?: number;
        added_chunk_keywords?: Array<{ name: string; count: number } | string>;
        missing_chunk_keywords?: Array<{ name: string; count: number } | string>;
        added_chunk_roles?: Array<{ name: string; count: number } | string>;
        missing_chunk_roles?: Array<{ name: string; count: number } | string>;
      };
      notes?: string[];
    }>;
  };
  version_nodes?: Array<{
    play_id: string;
    title: string;
    source_name?: string;
    role_type_counts?: Record<string, number>;
  }>;
}

export interface ClusterDetailResponse {
  cluster: ClusterInfo;
  explanation?: { summary?: string; evidence?: Record<string, unknown> };
  nodes: NebulaNode[];
  representative_plays: NebulaNode[];
}

export interface AiEvidence {
  evidence_no: number;
  source_type: string;
  display_text: string;
  highlight_target?: string;
  highlight_type?: string;
  title?: string;
}

export interface AiChatContext {
  play_id?: string;
  play_title?: string;
  play_group_id?: string;
  cluster_id?: string;
  cluster_name?: string;
  coarse_cluster_id?: string;
  coarse_cluster_name?: string;
  source_name?: string;
}

export interface AiChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiChatResponse {
  answer: string;
  evidence: AiEvidence[];
  highlight_targets: Array<{ target_id: string; target_type: string; label: string }>;
  suggested_questions: string[];
  meta: {
    ok: boolean;
    fallback?: boolean;
    evidence_count?: number;
  };
}

export interface VersionLineageSummary {
  multi_version_group_count: number;
  source_count: number;
  max_version_count: number;
  diff_group_count: number;
}

export interface VersionLineageGroup {
  play_group_id: string;
  canonical_title: string;
  representative_play_id?: string;
  version_count: number;
  source_names: string[];
  source_diversity: number;
  diff_score: number;
  role_change_count: number;
  role_add_missing_count: number;
  keyword_change_count: number;
  text_delta_total: number;
  metric_values: Record<string, number>;
  reason: string;
}

export interface VersionLineageMatrixCell {
  column_id: string;
  value: number;
  intensity: number;
}

export interface VersionLineageMatrixRow {
  play_group_id: string;
  canonical_title: string;
  representative_play_id?: string;
  cells: VersionLineageMatrixCell[];
}

export interface VersionLineageReportResponse {
  summary: VersionLineageSummary;
  ranked_groups: VersionLineageGroup[];
  diff_matrix: {
    columns: Array<{ id: string; label: string }>;
    rows: VersionLineageMatrixRow[];
  };
  source_distribution: Array<{ source_name: string; group_count: number; version_count: number }>;
}
