import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { NebulaEdge, NebulaNode } from '../api/client';
import { COLORS } from '../constants/theme';
import { filterEdges, getDisplayX, getDisplayY, nodeRadius, type DisplayNebulaNode, type EdgeDisplayMode } from '../utils/nebulaViz';

interface LegendItem {
  id: string;
  label: string;
  color: string;
  count?: number;
}

interface Nebula3DProps {
  nodes: Array<NebulaNode | DisplayNebulaNode>;
  edges: NebulaEdge[];
  edgeMode: EdgeDisplayMode;
  sidebarWidth: number;
  clusterViewMode: 'coarse' | 'fine';
  legendItems: LegendItem[];
  selectedPlayId: string | null;
  highlightIds: Set<string>;
  isRotating: boolean;
  layoutMode: 'tidy' | 'raw';
  getNodeColor3D: (node: NebulaNode) => string;
  onSelectNode: (node: NebulaNode) => void;
}

interface HoverState {
  title: string;
  left: number;
  top: number;
}

interface SelectedMarkerState {
  left: number;
  top: number;
}

const Z_SPREAD = 360;
const CAMERA_BASE_Z = 860;
const DRAG_CLICK_THRESHOLD = 5;
const POINT_VERTEX_SHADER = `
  attribute float size;
  attribute vec3 customColor;
  varying vec3 vColor;
  void main() {
    vColor = customColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (520.0 / max(120.0, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const POINT_FRAGMENT_SHADER = `
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float dist = length(uv);
    float core = smoothstep(0.46, 0.04, dist);
    float halo = smoothstep(0.5, 0.20, dist) * 0.52;
    float alpha = max(core, halo);
    gl_FragColor = vec4(vColor * 1.22, alpha);
  }
`;

function normalize(value: number, min: number, max: number) {
  if (max === min) return 0;
  return ((value - min) / (max - min)) * 2 - 1;
}

function hashText(text: string) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash;
}

function depthForNode(node: NebulaNode, index: number) {
  const clusterHash = hashText(node.cluster_id || node.coarse_cluster_id || node.play_id);
  const radial = Math.sin((clusterHash % 997) * 0.017 + index * 0.11);
  const narrativeWeight = Math.min(1, ((node.version_count || 1) + (node.role_count || 4) / 8) / 9);
  return radial * Z_SPREAD * 0.58 + (narrativeWeight - 0.5) * Z_SPREAD * 0.42;
}

export function Nebula3D({
  nodes,
  edges,
  edgeMode,
  sidebarWidth,
  clusterViewMode,
  legendItems,
  selectedPlayId,
  highlightIds,
  isRotating,
  layoutMode,
  getNodeColor3D,
  onSelectNode,
}: Nebula3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes);
  const sceneDataRef = useRef<ReturnType<typeof buildSceneData> | null>(null);
  const selectedGeometryRef = useRef<THREE.BufferGeometry | null>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const selectedPlayIdRef = useRef(selectedPlayId);
  const highlightIdsRef = useRef(highlightIds);
  const isRotatingRef = useRef(isRotating);
  const sidebarWidthRef = useRef(sidebarWidth);
  const onSelectNodeRef = useRef(onSelectNode);
  const markerVectorRef = useRef(new THREE.Vector3());
  const [hover, setHover] = useState<HoverState | null>(null);
  const [selectedMarker, setSelectedMarker] = useState<SelectedMarkerState | null>(null);

  nodesRef.current = nodes;
  selectedPlayIdRef.current = selectedPlayId;
  highlightIdsRef.current = highlightIds;
  isRotatingRef.current = isRotating;
  sidebarWidthRef.current = sidebarWidth;
  onSelectNodeRef.current = onSelectNode;

  const sceneData = useMemo(() => buildSceneData(nodes, edges, edgeMode, getNodeColor3D), [nodes, edges, edgeMode, getNodeColor3D]);
  sceneDataRef.current = sceneData;

  const updateSelectionGeometry = () => {
    const selectedGeometry = selectedGeometryRef.current;
    const data = sceneDataRef.current;
    if (!selectedGeometry || !data) return;

    const ids = new Set(highlightIdsRef.current);
    if (selectedPlayIdRef.current) ids.add(selectedPlayIdRef.current);
    const selectedPositions: number[] = [];
    ids.forEach((id) => {
      const index = data.nodeIndex.get(id);
      if (index === undefined) return;
      selectedPositions.push(
        data.positions[index * 3],
        data.positions[index * 3 + 1],
        data.positions[index * 3 + 2],
      );
    });
    selectedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(selectedPositions, 3));
    selectedGeometry.computeBoundingSphere();
  };

  const updateSelectedMarker = () => {
    const playId = selectedPlayIdRef.current;
    const data = sceneDataRef.current;
    const root = rootRef.current;
    const camera = cameraRef.current;
    if (!playId || !data || !root || !camera) {
      setSelectedMarker(null);
      return;
    }

    const index = data.nodeIndex.get(playId);
    if (index === undefined) {
      setSelectedMarker(null);
      return;
    }

    const { width, height } = sizeRef.current;
    if (!width || !height) {
      setSelectedMarker(null);
      return;
    }

    root.updateMatrixWorld();
    const vector = markerVectorRef.current;
    vector
      .set(data.positions[index * 3], data.positions[index * 3 + 1], data.positions[index * 3 + 2])
      .applyMatrix4(root.matrixWorld)
      .project(camera);

    if (vector.z < -1 || vector.z > 1) {
      setSelectedMarker(null);
      return;
    }

    const next = {
      left: ((vector.x + 1) / 2) * width,
      top: ((-vector.y + 1) / 2) * height - 8,
    };
    setSelectedMarker((prev) => {
      if (prev && Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.top - next.top) < 0.5) {
        return prev;
      }
      return next;
    });
  };

  useEffect(() => {
    updateSelectionGeometry();
    updateSelectedMarker();
  }, [selectedPlayId, highlightIds, sceneData]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || nodes.length === 0) return undefined;

    const getViewportSize = () => ({
      width: Math.max(360, mount.clientWidth || window.innerWidth - sidebarWidthRef.current),
      height: Math.max(360, mount.clientHeight || window.innerHeight),
    });
    let { width, height } = getViewportSize();
    sizeRef.current = { width, height };
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x070a12, 0.00145);

    const camera = new THREE.PerspectiveCamera(58, width / height, 1, 4000);
    camera.position.set(0, 0, CAMERA_BASE_Z);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
    renderer.setSize(width, height);
    renderer.setClearColor(0x050810, 0);
    mount.appendChild(renderer.domElement);

    const root = new THREE.Group();
    root.rotation.x = -0.16;
    root.rotation.y = 0.36;
    rootRef.current = root;
    scene.add(root);

    const starGeometry = new THREE.BufferGeometry();
    const starPositions: number[] = [];
    for (let i = 0; i < 420; i += 1) {
      starPositions.push(
        (Math.random() - 0.5) * 1600,
        (Math.random() - 0.5) * 1100,
        -900 + Math.random() * 900,
      );
    }
    starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    const starField = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        color: 0x8ba6c8,
        size: 1.6,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      }),
    );
    scene.add(starField);

    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute('position', new THREE.BufferAttribute(sceneData.edgePositions, 3));
    const edgeLines = new THREE.LineSegments(
      edgeGeometry,
      new THREE.LineBasicMaterial({
        color: 0xbfd4ff,
        transparent: true,
        opacity: edgeMode === 'all' ? 0.11 : 0.24,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    root.add(edgeLines);

    const nodeGeometry = new THREE.BufferGeometry();
    nodeGeometry.setAttribute('position', new THREE.BufferAttribute(sceneData.positions, 3));
    nodeGeometry.setAttribute('customColor', new THREE.BufferAttribute(sceneData.colors, 3));
    nodeGeometry.setAttribute('size', new THREE.BufferAttribute(sceneData.sizes, 1));
    const nodeMaterial = new THREE.ShaderMaterial({
      vertexShader: POINT_VERTEX_SHADER,
      fragmentShader: POINT_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const nodePoints = new THREE.Points(nodeGeometry, nodeMaterial);
    root.add(nodePoints);

    const selectedGeometry = new THREE.BufferGeometry();
    selectedGeometryRef.current = selectedGeometry;
    const selectedMaterial = new THREE.PointsMaterial({
      color: COLORS.highlight,
      size: 18,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const selectedPoints = new THREE.Points(selectedGeometry, selectedMaterial);
    root.add(selectedPoints);

    updateSelectionGeometry();
    updateSelectedMarker();

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 10 };
    const pointer = new THREE.Vector2();
    const pointerPos = { x: 0, y: 0 };
    let hoveredIndex = -1;
    let isDragging = false;
    let hasDragged = false;
    let suppressNextClick = false;
    let pointerDownX = 0;
    let pointerDownY = 0;
    let previousX = 0;
    let previousY = 0;
    let frame = 0;

    const updatePointer = (event: PointerEvent | MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      pointerPos.x = event.clientX - rect.left;
      pointerPos.y = event.clientY - rect.top;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      isDragging = true;
      hasDragged = false;
      pointerDownX = event.clientX;
      pointerDownY = event.clientY;
      previousX = event.clientX;
      previousY = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      updatePointer(event);
      if (!isDragging) return;
      const dx = event.clientX - previousX;
      const dy = event.clientY - previousY;
      const totalDx = event.clientX - pointerDownX;
      const totalDy = event.clientY - pointerDownY;
      if ((totalDx * totalDx) + (totalDy * totalDy) > DRAG_CLICK_THRESHOLD * DRAG_CLICK_THRESHOLD) {
        hasDragged = true;
      }
      previousX = event.clientX;
      previousY = event.clientY;
      root.rotation.y += dx * 0.006;
      root.rotation.x += dy * 0.004;
      root.rotation.x = Math.max(-1.15, Math.min(1.15, root.rotation.x));
      updateSelectedMarker();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (hasDragged) {
        suppressNextClick = true;
      }
      isDragging = false;
      hasDragged = false;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      camera.position.z = Math.max(340, Math.min(1500, camera.position.z + event.deltaY * 0.55));
      updateSelectedMarker();
    };

    const pickNodeIndex = (event: PointerEvent | MouseEvent) => {
      updatePointer(event);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(nodePoints)[0]?.index ?? -1;
    };

    const onClick = (event: MouseEvent) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const pickedIndex = pickNodeIndex(event);
      if (pickedIndex < 0) return;
      const node = nodesRef.current[pickedIndex];
      if (node) onSelectNodeRef.current(node);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    renderer.domElement.addEventListener('click', onClick);

    const onResize = () => {
      ({ width, height } = getViewportSize());
      sizeRef.current = { width, height };
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      updateSelectedMarker();
    };
    window.addEventListener('resize', onResize);
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(mount);

    const animate = () => {
      frame = window.requestAnimationFrame(animate);
      if (isRotatingRef.current && !isDragging) {
        root.rotation.y += 0.0042;
      }
      starField.rotation.y -= 0.00025;

      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObject(nodePoints);
      const hit = intersections[0]?.index ?? -1;
      if (hit !== hoveredIndex) {
        hoveredIndex = hit;
        const node = hit >= 0 ? nodesRef.current[hit] : null;
        setHover(node ? { title: node.title, left: pointerPos.x + 14, top: pointerPos.y - 8 } : null);
        renderer.domElement.style.cursor = node ? 'pointer' : 'grab';
      } else if (hit >= 0) {
        setHover((prev) => (prev ? { ...prev, left: pointerPos.x + 14, top: pointerPos.y - 8 } : prev));
      }

      updateSelectedMarker();
      renderer.render(scene, camera);
    };

    animate();

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointerleave', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.domElement.removeEventListener('click', onClick);
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      edgeGeometry.dispose();
      (edgeLines.material as THREE.Material).dispose();
      selectedGeometry.dispose();
      selectedMaterial.dispose();
      starGeometry.dispose();
      (starField.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
      if (selectedGeometryRef.current === selectedGeometry) selectedGeometryRef.current = null;
      if (rootRef.current === root) rootRef.current = null;
      if (cameraRef.current === camera) cameraRef.current = null;
      setHover(null);
      setSelectedMarker(null);
    };
  }, [
    nodes,
    edgeMode,
    sceneData,
    layoutMode,
  ]);

  return (
    <div className="nebula-3d-layer" ref={mountRef}>
      {selectedMarker && (
        <div className="node-marker node-marker-both node-marker-3d" style={{ left: selectedMarker.left, top: selectedMarker.top }}>
          <span className="node-marker-label">当前 · 高亮</span>
          <span className="node-marker-arrow">▼</span>
        </div>
      )}
      {hover && (
        <div className="nebula-tooltip nebula-tooltip-3d" style={{ left: hover.left, top: hover.top }}>
          {hover.title}
        </div>
      )}
      <div className="legend-3d">
        <div className="legend-3d-title">{clusterViewMode === 'fine' ? '细星团图例' : '粗星团图例'}</div>
        <div className={clusterViewMode === 'fine' ? 'legend-3d-grid fine' : 'legend-3d-grid'}>
          {legendItems.map((item) => (
            <div className="legend-3d-item" key={item.id} title={item.count ? `${item.label} (${item.count})` : item.label}>
              <span className="legend-3d-dot" style={{ background: item.color }} />
              <span>{item.count ? `${item.label} (${item.count})` : item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function buildSceneData(
  nodes: Array<NebulaNode | DisplayNebulaNode>,
  edges: NebulaEdge[],
  edgeMode: EdgeDisplayMode,
  getNodeColor3D: (node: NebulaNode) => string,
) {
    const xs = nodes.map((node) => getDisplayX(node));
    const ys = nodes.map((node) => getDisplayY(node));
    const minX = Math.min(...xs, 0);
    const maxX = Math.max(...xs, 1);
    const minY = Math.min(...ys, 0);
    const maxY = Math.max(...ys, 1);
    const nodeIdSet = new Set(nodes.map((node) => node.play_id));
    const nodeIndex = new Map<string, number>();
    const positions: number[] = [];
    const colors: number[] = [];
    const sizes: number[] = [];

    nodes.forEach((node, index) => {
      nodeIndex.set(node.play_id, index);
      positions.push(
        normalize(getDisplayX(node), minX, maxX) * 460,
        normalize(getDisplayY(node), minY, maxY) * -310,
        depthForNode(node, index),
      );
      const color = new THREE.Color(getNodeColor3D(node));
      colors.push(color.r, color.g, color.b);
      sizes.push(Math.max(9.5, nodeRadius(node) * 3.25));
    });

    const edgePositions: number[] = [];
    const visibleEdges = filterEdges(edges, edgeMode, null, nodeIdSet);
    visibleEdges.forEach((edge) => {
      const sourceIndex = nodeIndex.get(edge.source);
      const targetIndex = nodeIndex.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined) return;
      edgePositions.push(
        positions[sourceIndex * 3],
        positions[sourceIndex * 3 + 1],
        positions[sourceIndex * 3 + 2],
        positions[targetIndex * 3],
        positions[targetIndex * 3 + 1],
        positions[targetIndex * 3 + 2],
      );
    });

    return {
      colors: new Float32Array(colors),
      edgePositions: new Float32Array(edgePositions),
      nodeIndex,
      positions: new Float32Array(positions),
      sizes: new Float32Array(sizes),
    };
}
