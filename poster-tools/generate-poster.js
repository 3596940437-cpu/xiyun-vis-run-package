const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'derived', 'v3_final');
const OUT_DIR = path.join(ROOT, 'output', 'poster');

const WIDTH = 9933;
const HEIGHT = 14043;
const STRONG_WEIGHT = 0.78;

const COLORS = {
  bg: '#070706',
  bg2: '#0B0B09',
  paper: '#F6EAD7',
  text: '#EEE7DA',
  muted: '#AFA495',
  gold: '#D8A642',
  red: '#A33A2B',
  cyan: '#59B7D3',
  teal: '#2FAE95',
};

const THEME_COLORS = {
  coarse_sanguo: '#C84032',
  coarse_jiangmen: '#D86E3B',
  coarse_suitang: '#D8A642',
  coarse_gongan: '#4F7FB7',
  coarse_lieguo: '#7E6AB5',
  coarse_shuihu: '#2FAE95',
  coarse_love_family: '#D95F86',
  coarse_shenguai: '#4BAE65',
  coarse_song_palace: '#9E75B8',
};

const COARSE_LABELS = {
  coarse_gongan: '公案',
  coarse_sanguo: '三国',
  coarse_suitang: '隋唐',
  coarse_jiangmen: '将门',
  coarse_lieguo: '列国',
  coarse_shuihu: '水浒',
  coarse_shenguai: '神怪',
  coarse_love_family: '爱情家庭',
  coarse_song_palace: '宋宫廷',
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash;
}

function makeRandom(seed = 42) {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function groupNodes(nodes, groupKey) {
  const groups = new Map();
  for (const node of nodes) {
    const key = groupKey(node);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return groups;
}

function groupSortValue(list) {
  return list.reduce((sum, node) => sum + node.x, 0) / Math.max(1, list.length);
}

function buildGroupCenters(entries, useParentSatellites) {
  const major = entries.filter(([, list]) => list.length >= 24);
  const minor = entries.filter(([, list]) => list.length < 24);
  const orderedMajor = [...major].sort((a, b) => groupSortValue(a[1]) - groupSortValue(b[1]));
  const centers = new Map();
  const parentCenters = new Map();
  const majorCount = Math.max(1, orderedMajor.length);
  const ringRadius = majorCount <= 6 ? 0.58 : 0.66;

  orderedMajor.forEach(([id, list], index) => {
    const angle = -Math.PI / 2 + (index / majorCount) * Math.PI * 2;
    const sizePull = Math.min(0.14, Math.sqrt(list.length) / 92);
    centers.set(id, {
      x: Math.cos(angle) * (ringRadius - sizePull),
      y: Math.sin(angle) * (ringRadius - sizePull) * 0.78,
    });
    const center = centers.get(id);
    const parentId = list[0]?.coarse_cluster_id;
    if (parentId) {
      if (!parentCenters.has(parentId)) parentCenters.set(parentId, []);
      parentCenters.get(parentId).push(center);
    }
  });

  if (orderedMajor.length === 1) {
    centers.set(orderedMajor[0][0], { x: 0, y: 0 });
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

function applyStrongRelationForces(centers, entries, edges, groupKey) {
  if (edges.length === 0 || centers.size < 2) return centers;

  const originalCenters = new Map([...centers.entries()].map(([id, center]) => [id, { ...center }]));
  const nodeGroup = new Map();
  const groupSize = new Map();
  for (const [id, list] of entries) {
    groupSize.set(id, list.length);
    for (const node of list) nodeGroup.set(node.play_id, groupKey(node));
  }

  const relationWeights = new Map();
  for (const edge of edges) {
    if ((edge.weight ?? 0) < STRONG_WEIGHT || edge.relation_type === 'annotated_bridge') continue;
    const sourceGroup = nodeGroup.get(edge.source);
    const targetGroup = nodeGroup.get(edge.target);
    if (!sourceGroup || !targetGroup || sourceGroup === targetGroup) continue;
    const [a, b] = sourceGroup < targetGroup ? [sourceGroup, targetGroup] : [targetGroup, sourceGroup];
    const key = `${a}\u0000${b}`;
    relationWeights.set(key, (relationWeights.get(key) || 0) + Math.max(0.1, edge.weight ?? STRONG_WEIGHT));
  }

  const relations = [...relationWeights.entries()]
    .map(([key, weight]) => {
      const [source, target] = key.split('\u0000');
      return { source, target, strength: Math.min(2.2, Math.log1p(weight)) };
    })
    .filter((relation) => centers.has(relation.source) && centers.has(relation.target));
  const ids = [...centers.keys()];
  const radiusFor = (id) => Math.max(0.09, Math.min(0.28, 0.072 + Math.sqrt(groupSize.get(id) || 1) * 0.006));
  const bounds = { x: 0.78, y: 0.60 };

  for (let step = 0; step < 110; step += 1) {
    for (const relation of relations) {
      const source = centers.get(relation.source);
      const target = centers.get(relation.target);
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(0.001, Math.hypot(dx, dy));
      const desired = 0.38 + (radiusFor(relation.source) + radiusFor(relation.target)) * 0.35;
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
        const a = centers.get(ids[i]);
        const b = centers.get(ids[j]);
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
      const center = centers.get(id);
      const original = originalCenters.get(id);
      center.x = center.x * 0.988 + original.x * 0.012;
      center.y = center.y * 0.988 + original.y * 0.012;
      center.x = Math.max(-bounds.x, Math.min(bounds.x, center.x));
      center.y = Math.max(-bounds.y, Math.min(bounds.y, center.y));
    }
  }

  return centers;
}

function buildDisplayNodes(nodes, edges) {
  const groupKey = (node) => node.coarse_cluster_id || node.cluster_id || 'other';
  const groups = groupNodes(nodes, groupKey);
  const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const centers = applyStrongRelationForces(buildGroupCenters(entries, false), entries, edges, groupKey);
  const result = [];

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

function colorForNode(node) {
  return THEME_COLORS[node.coarse_cluster_id] || '#7A756B';
}

function depthForNode(node, index) {
  const clusterHash = hashText(node.cluster_id || node.coarse_cluster_id || node.play_id);
  const radial = Math.sin((clusterHash % 997) * 0.017 + index * 0.11);
  const narrativeWeight = Math.min(1, ((node.version_count || 1) + (node.role_count || 4) / 8) / 9);
  return radial * 0.58 + (narrativeWeight - 0.5) * 0.42;
}

function projectNode(node, index) {
  const stage = { x: 570, y: 2140, w: 8790, h: 8260 };
  const centerX = stage.x + stage.w * 0.515;
  const centerY = stage.y + stage.h * 0.515;
  const scaleX = stage.w * 0.58;
  const scaleY = stage.h * 0.54;
  const x = node.displayX;
  const y = node.displayY;
  const z = depthForNode(node, index);
  const cosY = Math.cos(0.37);
  const sinY = Math.sin(0.37);
  const cosX = Math.cos(-0.18);
  const sinX = Math.sin(-0.18);
  const x1 = x * cosY + z * sinY;
  const z1 = -x * sinY + z * cosY;
  const y2 = y * cosX - z1 * sinX;
  const z2 = y * sinX + z1 * cosX;
  const perspective = 1.18 / (1.18 - z2 * 0.32);
  return {
    x: centerX + x1 * scaleX * perspective,
    y: centerY + y2 * scaleY * perspective,
    z: z2,
    depth: Math.max(0, Math.min(1, (z2 + 0.85) / 1.7)),
    scale: perspective,
  };
}

function circle({ cx, cy, r, fill, opacity = 1, stroke = 'none', strokeWidth = 0, cls = '' }) {
  return `<circle${cls ? ` class="${cls}"` : ''} cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="${fill}" opacity="${opacity}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function text(x, y, value, options = {}) {
  const {
    cls = '',
    size = 120,
    fill = COLORS.text,
    anchor = 'start',
    weight = 400,
    family = 'body',
    letterSpacing = 0,
    opacity = 1,
  } = options;
  return `<text class="${cls} ${family}" x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}" letter-spacing="${letterSpacing}" opacity="${opacity}">${escapeXml(value)}</text>`;
}

function multilineText(x, y, lines, options = {}) {
  const {
    cls = '',
    size = 96,
    fill = COLORS.text,
    anchor = 'start',
    weight = 400,
    family = 'body',
    lineHeight = Math.round(size * 1.42),
    opacity = 1,
  } = options;
  const tspans = lines.map((line, index) =>
    `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
  ).join('');
  return `<text class="${cls} ${family}" x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}" opacity="${opacity}">${tspans}</text>`;
}

function infoCard(x, y, w, h, kicker, titleValue, lines, accent) {
  return `
    <g transform="translate(${x} ${y})">
      <path d="M0 0 H${w} M0 ${h} H${w}" stroke="${accent}" stroke-width="5" opacity="0.46"/>
      <path d="M0 0 V${h}" stroke="${accent}" stroke-width="14" opacity="0.78"/>
      <rect x="24" y="34" width="${w - 48}" height="${h - 68}" fill="#0D0F0D" opacity="0.5"/>
      ${text(82, 112, kicker, { size: 68, fill: accent, weight: 800 })}
      ${text(82, 246, titleValue, { size: 126, fill: COLORS.paper, weight: 800, family: 'title' })}
      ${multilineText(84, 388, lines, { size: 78, fill: COLORS.muted, weight: 650, lineHeight: 116 })}
    </g>
  `;
}

function verticalTag(x, y, label, accent = COLORS.gold) {
  const chars = label.split('').map((char, index) =>
    `<tspan x="${x + 55}" dy="${index === 0 ? 0 : 94}">${escapeXml(char)}</tspan>`,
  ).join('');
  return `
    <g>
      <rect x="${x}" y="${y}" width="142" height="${label.length * 96 + 122}" rx="18" fill="#080907" stroke="${accent}" stroke-width="4" stroke-opacity="0.42" opacity="0.94"/>
      <line x1="${x + 24}" y1="${y + 30}" x2="${x + 118}" y2="${y + 30}" stroke="${accent}" stroke-width="5" opacity="0.52"/>
      <text class="title" x="${x + 55}" y="${y + 105}" font-size="74" fill="${COLORS.paper}" text-anchor="middle" font-weight="800">${chars}</text>
    </g>
  `;
}

function redSeal(x, y, size, lines) {
  const lineText = lines.map((line, index) =>
    text(x + size / 2, y + 132 + index * 104, line, {
      size: 66,
      fill: '#F6EAD7',
      anchor: 'middle',
      weight: 800,
      family: 'title',
      opacity: 0.94,
    }),
  ).join('\n');
  return `
    <g opacity="0.9">
      <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="34" fill="${COLORS.red}" opacity="0.74"/>
      <rect x="${x + 28}" y="${y + 28}" width="${size - 56}" height="${size - 56}" rx="18" fill="none" stroke="#F6EAD7" stroke-width="8" opacity="0.62"/>
      <path d="M${x + 76} ${y + 76} H${x + size - 76} M${x + 76} ${y + size - 48} H${x + size - 76}" stroke="#F6EAD7" stroke-width="5" opacity="0.34"/>
      ${lineText}
    </g>
  `;
}

function callout(x1, y1, x2, y2, titleValue, body, accent = COLORS.gold, anchor = 'start') {
  const boxW = 1120;
  const boxH = 310;
  const boxX = anchor === 'end' ? x2 - boxW : x2;
  const textX = boxX + 62;
  return `
    <g>
      <path d="M${x1} ${y1} C${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}" fill="none" stroke="${accent}" stroke-width="5" opacity="0.52"/>
      ${circle({ cx: x1, cy: y1, r: 28, fill: accent, opacity: 0.88 })}
      <rect x="${boxX}" y="${y2 - 150}" width="${boxW}" height="${boxH}" rx="26" fill="#090A09" opacity="0.9" stroke="${accent}" stroke-width="4" stroke-opacity="0.35"/>
      ${text(textX, y2 - 36, titleValue, { size: 84, fill: COLORS.paper, weight: 800, family: 'title' })}
      ${text(textX, y2 + 86, body, { size: 60, fill: COLORS.muted, weight: 650 })}
    </g>
  `;
}

function buildPosterSvg() {
  const nodes = readJson('nebula_nodes.json');
  const edges = readJson('nebula_edges.json');
  const summary = readJson('dataset_summary.json');
  const coarseClusters = readJson('coarse_clusters.json');
  const strongEdges = edges.filter((edge) => (edge.weight ?? 0) >= STRONG_WEIGHT && edge.relation_type !== 'annotated_bridge');
  const displayNodes = buildDisplayNodes(nodes, edges);
  const nodeById = new Map(displayNodes.map((node, index) => {
    const projected = projectNode(node, index);
    return [node.play_id, { node, projected, index }];
  }));

  const rand = makeRandom(20260618);
  const stars = Array.from({ length: 900 }, () => ({
    x: 260 + rand() * (WIDTH - 520),
    y: 1600 + rand() * 9200,
    r: 1.3 + rand() * 5.8,
    opacity: 0.035 + rand() * 0.18,
  }));

  const clusterGroups = groupNodes(displayNodes, (node) => node.coarse_cluster_id || 'other');
  const glows = [...clusterGroups.entries()].map(([id, list]) => {
    const avgIndex = Math.floor(list.length / 2);
    const centerNode = {
      ...list[avgIndex],
      displayX: list.reduce((sum, node) => sum + node.displayX, 0) / list.length,
      displayY: list.reduce((sum, node) => sum + node.displayY, 0) / list.length,
      role_count: 10,
      version_count: 1,
    };
    const projected = projectNode(centerNode, avgIndex);
    return {
      id,
      x: projected.x,
      y: projected.y,
      r: 520 + Math.sqrt(list.length) * 105,
      color: THEME_COLORS[id] || '#7A756B',
      count: list.length,
    };
  }).sort((a, b) => b.r - a.r);

  const edgesSvg = strongEdges.map((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return '';
    const opacity = Math.min(0.34, 0.08 + ((edge.weight ?? STRONG_WEIGHT) - STRONG_WEIGHT) * 1.15);
    const width = edge.relation_type === 'same_title_version' ? 9.2 : 5.2;
    const color = edge.relation_type === 'same_title_version' ? COLORS.gold : '#BFD4FF';
    return `<line x1="${source.projected.x.toFixed(2)}" y1="${source.projected.y.toFixed(2)}" x2="${target.projected.x.toFixed(2)}" y2="${target.projected.y.toFixed(2)}" stroke="${color}" stroke-width="${width}" opacity="${opacity}" stroke-linecap="round"/>`;
  }).join('\n');

  const sortedNodes = [...nodeById.values()].sort((a, b) => a.projected.z - b.projected.z);
  const nodesSvg = sortedNodes.map(({ node, projected }) => {
    const color = colorForNode(node);
    const base = Math.sqrt(node.role_count || 3) * 4.7 + (node.version_count || 1) * 1.25;
    const r = Math.max(9, Math.min(34, base * projected.scale));
    const opacity = 0.58 + projected.depth * 0.36;
    const halo = node.is_focus || (node.version_count || 1) >= 5
      ? circle({ cx: projected.x, cy: projected.y, r: r * 4.4, fill: color, opacity: 0.1 })
      : '';
    return `${halo}${circle({ cx: projected.x, cy: projected.y, r: r * 1.9, fill: color, opacity: 0.13 })}${circle({ cx: projected.x, cy: projected.y, r, fill: color, opacity })}`;
  }).join('\n');

  const labelTargets = ['空城计', '玉堂春', '宇宙锋', '二进宫', '打渔杀家', '打严嵩'];
  const labelsSvg = labelTargets.map((titleValue, index) => {
    const entry = sortedNodes.find(({ node }) => node.title_clean === titleValue || node.title === titleValue);
    if (!entry) return '';
    const { projected } = entry;
    const dx = index % 2 === 0 ? 72 : -72;
    const anchor = dx > 0 ? 'start' : 'end';
    const tagW = titleValue.length * 82 + 120;
    const tagX = dx > 0 ? projected.x + 70 : projected.x - tagW - 70;
    const tagY = projected.y - 70;
    return `
      <line x1="${projected.x.toFixed(2)}" y1="${projected.y.toFixed(2)}" x2="${(projected.x + dx).toFixed(2)}" y2="${(projected.y - 48).toFixed(2)}" stroke="${COLORS.gold}" stroke-width="4" opacity="0.55"/>
      <rect x="${tagX.toFixed(2)}" y="${tagY.toFixed(2)}" width="${tagW}" height="140" rx="22" fill="#171513" stroke="${COLORS.gold}" stroke-width="3" opacity="0.92"/>
      ${text(tagX + (anchor === 'start' ? 58 : tagW - 58), tagY + 94, titleValue, { size: 58, fill: COLORS.paper, anchor, weight: 700 })}
    `;
  }).join('\n');

  const metrics = [
    { value: summary.play_count, label: '剧目节点' },
    { value: strongEdges.length, label: '强关系连线' },
    { value: summary.multi_version_group_count, label: '多版本剧目' },
    { value: 33, label: '来源类型' },
    { value: summary.text_chunk_count, label: '文本片段' },
  ];
  const metricSvg = metrics.map((item, index) => {
    const x = 610 + index * 1740;
    return `
      <g transform="translate(${x} 11335)">
        <line x1="0" y1="0" x2="1420" y2="0" stroke="#D8A642" stroke-width="5" opacity="0.42"/>
        <line x1="0" y1="520" x2="1420" y2="520" stroke="#D8A642" stroke-width="3" opacity="0.18"/>
        ${text(0, 230, formatNumber(item.value), { size: 240, fill: COLORS.gold, weight: 800, family: 'title' })}
        ${text(6, 418, item.label, { size: 112, fill: COLORS.paper, weight: 800 })}
        ${text(1040, 418, `0${index + 1}`, { size: 116, fill: COLORS.muted, weight: 800, family: 'title', opacity: 0.42 })}
      </g>
    `;
  }).join('\n');

  const legendItems = coarseClusters
    .slice()
    .sort((a, b) => b.node_count - a.node_count)
    .map((cluster) => ({
      id: cluster.coarse_cluster_id,
      label: COARSE_LABELS[cluster.coarse_cluster_id] || cluster.coarse_cluster_name,
      count: cluster.node_count,
      color: THEME_COLORS[cluster.coarse_cluster_id] || '#7A756B',
    }));
  const legendSvg = legendItems.map((item, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = 6330 + col * 1030;
    const y = 13205 + row * 250;
    return `
      <g transform="translate(${x} ${y})">
        ${circle({ cx: 0, cy: -6, r: 38, fill: item.color, opacity: 0.95 })}
        ${circle({ cx: 0, cy: -6, r: 92, fill: item.color, opacity: 0.14 })}
        ${text(92, 22, `${item.label} ${item.count}`, { size: 90, fill: COLORS.paper, weight: 800 })}
      </g>
    `;
  }).join('\n');

  const sourceLine = summary.focus_groups.map((name) => `《${name}》`).join(' / ');
  const featureSvg = [
    infoCard(610, 12135, 2750, 760, '01 关系星云', '看见剧目之间的亲缘', [
      '颜色区分题材星团，点表示剧目版本，',
      '强连线呈现主题、角色与来源的相似关系。',
    ], COLORS.cyan),
    infoCard(3595, 12135, 2750, 760, '02 版本传承', '追踪文本如何被改写', [
      '比较同名剧目的来源版本、角色增删、',
      '行当变化、关键词漂移与文本规模差异。',
    ], COLORS.gold),
    infoCard(6580, 12135, 2750, 760, '03 AI 导览', '从图谱进入证据问答', [
      '支持剧目、角色、主题检索，联动详情页、',
      '版本河流、传承报告与可解释证据片段。',
    ], COLORS.teal),
  ].join('\n');
  const calloutSvg = [
    callout(3280, 4820, 720, 3370, '主题星团', '颜色将题材谱系组织成可读星座', COLORS.gold),
    callout(7340, 5700, 9220, 3920, '强关系连线', '主题、角色、来源共同决定相似关系', COLORS.cyan, 'end'),
    callout(2380, 7540, 720, 8170, '同名版本', '多来源文本在星图中形成传承轨迹', COLORS.red),
    callout(5940, 7960, 9180, 8820, '证据片段', '检索与 AI 导览回到原始文本依据', COLORS.teal, 'end'),
  ].join('\n');
  const ornamentSvg = `
    <g id="chinese-ornament" opacity="0.9">
      <path d="M360 1970 C1560 1390, 2540 1900, 3570 1610 S5780 950, 7390 1450 S8750 1700, 9600 1040" fill="none" stroke="#D8A642" stroke-width="8" opacity="0.18"/>
      <path d="M430 2140 C1720 1650, 2590 2200, 3930 1880 S6030 1250, 7460 1780 S8790 2030, 9570 1390" fill="none" stroke="#A33A2B" stroke-width="10" opacity="0.12"/>
      <path d="M790 9790 C2380 9180, 3640 10150, 5120 9520 S7890 8970, 9340 9790" fill="none" stroke="#D8A642" stroke-width="8" opacity="0.16"/>
      <path d="M1040 10180 C2660 9480, 3900 10330, 5220 9890 S7560 9460, 9080 10170" fill="none" stroke="#A33A2B" stroke-width="8" opacity="0.11"/>
      <path d="M1020 2060 A4200 4200 0 0 1 8920 2060" fill="none" stroke="#D8A642" stroke-width="4" opacity="0.1"/>
      <path d="M1530 2060 A3680 3680 0 0 1 8410 2060" fill="none" stroke="#D8A642" stroke-width="4" opacity="0.08"/>
      <path d="M2060 2060 A3140 3140 0 0 1 7880 2060" fill="none" stroke="#D8A642" stroke-width="4" opacity="0.065"/>
      <line x1="970" y1="2060" x2="4970" y2="6120" stroke="#D8A642" stroke-width="3" opacity="0.055"/>
      <line x1="4970" y1="2060" x2="4970" y2="6120" stroke="#D8A642" stroke-width="3" opacity="0.045"/>
      <line x1="8960" y1="2060" x2="4970" y2="6120" stroke="#D8A642" stroke-width="3" opacity="0.055"/>
    </g>
  `;
  const starSvg = stars.map((star) => circle({
    cx: star.x,
    cy: star.y,
    r: star.r,
    fill: '#D9ECFF',
    opacity: star.opacity,
  })).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="841mm" height="1189mm" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="戏韵千秋京剧剧目关系与版本传承可视化海报">
  <defs>
    <radialGradient id="bg" cx="50%" cy="43%" r="71%">
      <stop offset="0%" stop-color="#1A1712"/>
      <stop offset="48%" stop-color="#0B0B09"/>
      <stop offset="100%" stop-color="#030302"/>
    </radialGradient>
    <radialGradient id="goldMist" cx="30%" cy="35%" r="58%">
      <stop offset="0%" stop-color="#D8A642" stop-opacity="0.18"/>
      <stop offset="56%" stop-color="#A33A2B" stop-opacity="0.055"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="redMist" cx="76%" cy="47%" r="48%">
      <stop offset="0%" stop-color="#A33A2B" stop-opacity="0.17"/>
      <stop offset="70%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="titleGold" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#F6EAD7"/>
      <stop offset="47%" stop-color="#D8A642"/>
      <stop offset="100%" stop-color="#F6EAD7"/>
    </linearGradient>
    <style>
      .title { font-family: "Noto Serif SC", "SimSun", "Songti SC", "Microsoft YaHei", serif; }
      .body { font-family: "Microsoft YaHei", "Noto Sans SC", "PingFang SC", sans-serif; }
      .fine-line { vector-effect: non-scaling-stroke; }
    </style>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#goldMist)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#redMist)"/>
  <rect width="2100" height="${HEIGHT}" fill="#120705" opacity="0.32"/>
  <rect x="${WIDTH - 2100}" width="2100" height="${HEIGHT}" fill="#120705" opacity="0.26"/>
  <path d="M810 860 C1240 720, 1540 780, 1960 650 M7820 1170 C8330 980, 8810 1080, 9300 870 M720 13350 C1180 13210, 1560 13300, 2060 13140 M7420 13440 C8040 13210, 8620 13350, 9280 13120" fill="none" stroke="#F6EAD7" stroke-width="3" opacity="0.075"/>
  <rect x="356" y="356" width="${WIDTH - 712}" height="${HEIGHT - 712}" fill="none" stroke="#D8A642" stroke-width="5" stroke-opacity="0.08"/>
  <path d="M530 1030 C1960 520, 3370 580, 4930 1000 S7970 1260, 9410 830" fill="none" stroke="#D8A642" stroke-width="4" opacity="0.18"/>
  <path d="M470 10695 C2270 10340, 3880 10670, 5280 10200 S8040 9890, 9420 10460" fill="none" stroke="#A33A2B" stroke-width="7" opacity="0.16"/>
  ${starSvg}
  ${ornamentSvg}

  <g id="header">
    ${text(606, 846, '戏韵千秋', { cls: 'title-main-shadow', size: 820, fill: '#000000', weight: 700, family: 'title', opacity: 0.48 })}
    ${text(590, 830, '戏韵千秋', { cls: 'title-main', size: 820, fill: COLORS.paper, weight: 700, family: 'title' })}
    ${text(607, 840, '戏韵千秋', { cls: 'title-main-warm', size: 820, fill: COLORS.gold, weight: 700, family: 'title', opacity: 0.18 })}
    ${redSeal(4300, 390, 430, ['星图', '即', '戏谱'])}
    ${text(620, 1275, '京剧剧目关系与版本传承可视化', { size: 270, fill: COLORS.paper, weight: 800, family: 'title' })}
    ${text(625, 1578, '一套面向京剧文本遗产的交互式可视化作品：用星云组织剧目谱系，用版本报告解释传承差异。', { size: 132, fill: COLORS.muted, weight: 700 })}
    ${text(9270, 690, 'DATA NEBULA', { size: 118, fill: COLORS.gold, anchor: 'end', weight: 800, opacity: 0.9 })}
    ${text(9270, 895, 'PEKING OPERA', { size: 112, fill: COLORS.paper, anchor: 'end', weight: 700, opacity: 0.74 })}
    ${multilineText(9270, 1138, ['关系图谱', '版本传承', 'AI 导览'], { size: 96, fill: COLORS.muted, anchor: 'end', weight: 700, lineHeight: 132, opacity: 0.88 })}
    ${verticalTag(8760, 1380, '京剧文本遗产', COLORS.gold)}
    ${verticalTag(8950, 1700, '星图即戏谱', COLORS.red)}
    <line x1="620" y1="1705" x2="9320" y2="1705" stroke="#D8A642" stroke-width="5" opacity="0.28"/>
  </g>

  <g id="nebula">
    ${glows.map((glow) => circle({
      cx: glow.x,
      cy: glow.y,
      r: glow.r,
      fill: glow.color,
      opacity: 0.055,
    })).join('\n')}
    ${edgesSvg}
    ${nodesSvg}
    ${labelsSvg}
  </g>
  <g id="curatorial-callouts">
    ${calloutSvg}
  </g>

  <g id="caption">
    <rect x="610" y="10125" width="6100" height="460" rx="38" fill="#0A0B0A" stroke="#D8A642" stroke-width="4" stroke-opacity="0.22" opacity="0.92"/>
    ${text(785, 10385, `${formatNumber(summary.play_count)} 个剧目 · 三维星云 · 整理布局 · ${formatNumber(strongEdges.length)} 条强关系连线`, { size: 118, fill: COLORS.paper, weight: 800 })}
    ${text(790, 10555, `重点样本：${sourceLine}`, { size: 88, fill: COLORS.muted, weight: 700 })}
  </g>

  <g id="bottom">
    <rect x="0" y="10915" width="${WIDTH}" height="3128" fill="#050504" opacity="0.78"/>
    <rect x="0" y="10915" width="${WIDTH}" height="16" fill="#D8A642" opacity="0.35"/>
    ${text(610, 11155, '作品内容与特点', { size: 176, fill: COLORS.gold, weight: 800, family: 'title' })}
    ${text(2260, 11155, '把京剧剧目从“名单”转化为可探索的关系空间', { size: 104, fill: COLORS.paper, weight: 800 })}
    ${metricSvg}
    ${featureSvg}
    ${text(610, 13235, '信息层', { size: 104, fill: COLORS.paper, weight: 800 })}
    ${multilineText(610, 13405, ['剧目节点代表结构化京剧文本；连线代表主题、角色、来源等复合特征的接近。', '版本传承模块重点呈现同名剧目在不同来源中的保存、整理与改写痕迹。'], { size: 82, fill: COLORS.muted, weight: 650, lineHeight: 132 })}
    ${text(6330, 13010, '主题星团图例', { size: 104, fill: COLORS.paper, weight: 800 })}
    ${legendSvg}
    ${text(610, 13815, '数据来源：京剧剧目结构化文本、角色行当、来源版本与相似关系索引', { size: 84, fill: COLORS.muted, weight: 650 })}
    ${text(9325, 13815, 'A0 竖版 / 300dpi 输出', { size: 84, fill: COLORS.muted, anchor: 'end', weight: 650 })}
  </g>
</svg>`;
}

function buildHtml(svg) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>A0_戏韵千秋海报</title>
  <style>
    @page { size: 841mm 1189mm; margin: 0; }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      background: #050504;
      overflow: hidden;
    }
    .poster-svg {
      display: block;
      width: 100vw;
      height: 100vh;
    }
    @media print {
      html, body {
        width: 841mm;
        height: 1189mm;
      }
      .poster-svg {
        width: 841mm;
        height: 1189mm;
      }
    }
  </style>
</head>
<body>
${svg.replace('<svg ', '<svg class="poster-svg" ')}
</body>
</html>`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const svg = buildPosterSvg();
  const html = buildHtml(svg);
  const svgPath = path.join(OUT_DIR, 'A0_戏韵千秋海报.svg');
  const htmlPath = path.join(OUT_DIR, 'A0_戏韵千秋海报.html');
  fs.writeFileSync(svgPath, svg, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(JSON.stringify({ svgPath, htmlPath, width: WIDTH, height: HEIGHT }, null, 2));
}

main();
