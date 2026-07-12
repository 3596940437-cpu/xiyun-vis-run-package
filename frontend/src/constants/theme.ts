/** E 视觉规范：背景、行当、主题、功能色 */
export const COLORS = {
  bg: '#090A0A',
  panel: '#111312',
  surface: '#1A1E1C',
  paper: '#F6EAD7',
  /** 侧边栏内嵌卡片，略深于宣纸 */
  sidebarSurface: '#EFE0C7',
  sidebarBorder: '#D8C29F',
  sidebarText: '#271E17',
  sidebarTextMuted: '#6D5B48',
  sidebarAccent: '#A33A2B',
  highlight: '#D8A642',
  aiEvidence: '#2FAE95',
  searchHit: '#59B7D3',
  edge: 'rgba(246,234,215,0.15)',
  text: '#EEE7DA',
  textMuted: '#AFA495',
  default: '#7A756B',
} as const;

export const HANGDANG_COLORS: Record<string, string> = {
  生: '#59B7D3',
  旦: '#D95F86',
  净: '#E06644',
  丑: '#8FAE54',
  末: '#9A9387',
  外: '#9E75B8',
  未知: '#7A756B',
  其他: '#7A756B',
};

export const THEME_COLORS: Record<string, string> = {
  coarse_sanguo: '#C84032',
  coarse_jiangmen: '#D86E3B',
  coarse_suitang: '#D8A642',
  coarse_gongan: '#4F7FB7',
  coarse_lieguo: '#7E6AB5',
  coarse_shuihu: '#2FAE95',
  coarse_love_family: '#D95F86',
  coarse_shenguai: '#4BAE65',
  coarse_song_palace: '#9E75B8',
  sanguo: '#C84032',
  三国: '#C84032',
  baogong: '#4F7FB7',
  包公: '#4F7FB7',
  公案: '#4F7FB7',
  yangjiajiang: '#D86E3B',
  杨家将: '#D86E3B',
  family_ethics: '#9E75B8',
  家庭伦理: '#9E75B8',
  love_marriage: '#D95F86',
  爱情婚姻: '#D95F86',
  爱情: '#D95F86',
  war: '#D8A642',
  战争: '#D8A642',
  征战: '#D8A642',
  myth: '#2FAE95',
  神怪: '#2FAE95',
  strategy: '#7E6AB5',
  谋略: '#7E6AB5',
};

export const COARSE_CLUSTER_LABELS: Record<string, string> = {
  coarse_sanguo: '三国',
  coarse_jiangmen: '将门',
  coarse_suitang: '隋唐',
  coarse_gongan: '公案',
  coarse_lieguo: '列国',
  coarse_shuihu: '水浒',
  coarse_love_family: '爱情家庭',
  coarse_shenguai: '神怪',
  coarse_song_palace: '宋宫廷',
};

export const LEGEND_ITEMS = [
  { label: '三国', color: '#C84032' },
  { label: '包公/公案', color: '#4F7FB7' },
  { label: '杨家将', color: '#D86E3B' },
  { label: '家庭伦理', color: '#9E75B8' },
  { label: '爱情婚姻', color: '#D95F86' },
  { label: '战争征战', color: '#D8A642' },
  { label: '神怪', color: '#2FAE95' },
  { label: '谋略', color: '#7E6AB5' },
];

export function getNodeColor(node: {
  coarse_cluster_id?: string;
  themes?: string[];
}): string {
  if (node.coarse_cluster_id && THEME_COLORS[node.coarse_cluster_id]) {
    return THEME_COLORS[node.coarse_cluster_id];
  }
  if (node.themes?.length) {
    for (const theme of node.themes) {
      if (THEME_COLORS[theme]) return THEME_COLORS[theme];
    }
  }
  return COLORS.default;
}

export function getRoleTypeColor(roleType: string): string {
  const family = roleType?.[0];
  if (family === '老' || family === '小' || family === '武' || family === '红' || family === '冠' || family === '副') {
    return HANGDANG_COLORS['生'];
  }
  if (roleType?.includes('旦')) return HANGDANG_COLORS['旦'];
  if (roleType === '净' || roleType === '武净') return HANGDANG_COLORS['净'];
  if (roleType?.includes('丑')) return HANGDANG_COLORS['丑'];
  if (roleType === '末') return HANGDANG_COLORS['末'];
  if (roleType === '外') return HANGDANG_COLORS['外'];
  return HANGDANG_COLORS[roleType] || COLORS.default;
}

/** 宣纸页热力图：0 为底色，1 为深黄棕 */
export function getPaperHeatColor(intensity: number): string {
  if (intensity <= 0) return COLORS.paper;
  const t = Math.min(1, Math.max(0, intensity));
  const r = Math.round(245 - t * 95);
  const g = Math.round(228 - t * 118);
  const b = Math.round(190 - t * 130);
  const alpha = 0.35 + t * 0.65;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function getPaperHeatTextColor(intensity: number): string {
  return intensity > 0.55 ? '#FFFAF0' : COLORS.sidebarText;
}
