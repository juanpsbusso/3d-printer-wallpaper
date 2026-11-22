import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

// --- CONFIGURACIÓN GENERAL ---
const BED_SIZE = 160;
const BUILD_HEIGHT = 150;
const LAYER_HEIGHT = 0.55;
const BEAD_RADIUS = 0.34;

let printSpeed = 1.0;
let lastNonZeroSpeed = 1.0;
let infillDensity = 20;
let currentSegmentFloat = 0;
let totalSegments = 0;
let layerStartIndices = [];
let toolpathPoints = [];
let isReverseLoop = true;
let printDirection = 1; // 1 = imprimiendo hacia adelante, -1 = borrando en reversa
let isCameraLocked = false;
let isNightMode = false;
let currentRawGeometry = null;
let userBgColor = '#0d0f14';

// --- ESCENA, CÁMARA Y RENDERER ---
const canvas = document.getElementById('canvas3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(userBgColor);
scene.fog = new THREE.FogExp2(userBgColor, 0.0015);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 1500);
camera.position.set(220, 185, 240);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.enableZoom = true;
controls.rotateSpeed = 0.45;
controls.zoomSpeed = 0.85;
controls.panSpeed = 0.7;
controls.minDistance = 75;
controls.maxDistance = 650;
controls.target.set(0, 65, 0);
controls.autoRotate = true;
controls.autoRotateSpeed = 0.5;

canvas.addEventListener('pointerdown', () => window.focus());

// --- ILUMINACIÓN ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.42);
scene.add(ambientLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.55);
keyLight.position.set(160, 280, 190);
keyLight.castShadow = true;
keyLight.shadow.mapSize.width = 1024;
keyLight.shadow.mapSize.height = 1024;
keyLight.shadow.bias = -0.0005;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x88b4ff, 0.55);
fillLight.position.set(-180, 120, -150);
scene.add(fillLight);

const bottomBounceLight = new THREE.DirectionalLight(0x445577, 0.3);
bottomBounceLight.position.set(0, -100, 50);
scene.add(bottomBounceLight);

// --- MATERIALES DINÁMICOS ---
const chassisMaterial = new THREE.MeshStandardMaterial({
  color: '#242730',
  roughness: 0.45,
  metalness: 0.65,
  transparent: true,
  opacity: 0.35,
  depthWrite: false
});

const railMaterial = new THREE.MeshStandardMaterial({
  color: '#9aa0ac',
  roughness: 0.25,
  metalness: 0.85,
  transparent: true,
  opacity: 0.45,
  depthWrite: false
});

const bedMaterial = new THREE.MeshStandardMaterial({
  color: '#181a20',
  roughness: 0.65,
  metalness: 0.25
});

const bedNeonMaterial = new THREE.MeshBasicMaterial({
  color: '#00d2ff',
  transparent: true,
  opacity: 0.0
});

const filamentMaterial = new THREE.MeshStandardMaterial({
  color: '#00a8ff',
  roughness: 0.36,
  metalness: 0.08,
  emissive: '#00a8ff',
  emissiveIntensity: 0.0
});

// --- CONSTRUCCIÓN DE LA IMPRESORA COREXY ---
const printerGroup = new THREE.Group();
const frameStructureGroup = new THREE.Group(); // Agrupa marco y guías para ocultarlos a 0%
printerGroup.add(frameStructureGroup);
scene.add(printerGroup);

function buildPrinter() {
  const frameW = BED_SIZE + 50;
  const frameH = BUILD_HEIGHT + 60;
  const pillarSize = 10;

  const pillarGeo = new THREE.BoxGeometry(pillarSize, frameH, pillarSize);
  const offsets = [
    [-frameW / 2, frameH / 2, -frameW / 2],
    [frameW / 2, frameH / 2, -frameW / 2],
    [-frameW / 2, frameH / 2, frameW / 2],
    [frameW / 2, frameH / 2, frameW / 2]
  ];

  offsets.forEach(([x, y, z]) => {
    const pillar = new THREE.Mesh(pillarGeo, chassisMaterial);
    pillar.position.set(x, y, z);
    frameStructureGroup.add(pillar);
  });

  const beamXGeo = new THREE.BoxGeometry(frameW + pillarSize, pillarSize, pillarSize);
  const beamZGeo = new THREE.BoxGeometry(pillarSize, pillarSize, frameW + pillarSize);

  [pillarSize / 2, frameH - pillarSize / 2].forEach(y => {
    [-frameW / 2, frameW / 2].forEach(pos => {
      const bx = new THREE.Mesh(beamXGeo, chassisMaterial);
      bx.position.set(0, y, pos);
      frameStructureGroup.add(bx);

      const bz = new THREE.Mesh(beamZGeo, chassisMaterial);
      bz.position.set(pos, y, 0);
      frameStructureGroup.add(bz);
    });
  });

  const yRailGeo = new THREE.CylinderGeometry(2.5, 2.5, frameW - 10, 12);
  yRailGeo.rotateX(Math.PI / 2);
  [-frameW / 2 + 12, frameW / 2 - 12].forEach(x => {
    const rail = new THREE.Mesh(yRailGeo, railMaterial);
    rail.position.set(x, frameH - 18, 0);
    frameStructureGroup.add(rail);
  });
}

buildPrinter();

// Grupo Cama Caliente
const bedAssembly = new THREE.Group();
const bedPlate = new THREE.Mesh(new THREE.BoxGeometry(BED_SIZE, 4, BED_SIZE), bedMaterial);
bedPlate.position.y = -2;
bedPlate.receiveShadow = true;
bedAssembly.add(bedPlate);

// Borde LED neón alrededor de la cama (se enciende en Modo Nocturno)
const neonEdgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(BED_SIZE + 1.5, 4.2, BED_SIZE + 1.5));
const bedNeonOutline = new THREE.LineSegments(neonEdgesGeo, bedNeonMaterial);
bedNeonOutline.position.y = -2;
bedAssembly.add(bedNeonOutline);

let bedGrid = new THREE.GridHelper(BED_SIZE, 16, 0x3a4052, 0x262a36);
bedGrid.position.y = 0.2;
bedAssembly.add(bedGrid);
printerGroup.add(bedAssembly);

// Puente móvil en Z
const topY = BUILD_HEIGHT + 42;
const gantryBridge = new THREE.Group();
gantryBridge.position.y = topY;
const xRail = new THREE.Mesh(
  new THREE.CylinderGeometry(3, 3, BED_SIZE + 26, 12).rotateZ(Math.PI / 2),
  railMaterial
);
gantryBridge.add(xRail);
printerGroup.add(gantryBridge);

// Cabezal Extrusor (Hotend)
const toolhead = new THREE.Group();
const carriage = new THREE.Mesh(new THREE.BoxGeometry(22, 24, 22), chassisMaterial);
carriage.position.y = 8;
toolhead.add(carriage);

const heatsinkMaterial = new THREE.MeshStandardMaterial({
  color: '#c0392b',
  metalness: 0.7,
  roughness: 0.3,
  transparent: true,
  opacity: 1.0
});
const heatsink = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 14, 16), heatsinkMaterial);
heatsink.position.y = -6;
toolhead.add(heatsink);

// La boquilla (Nozzle) siempre permanece visible incluso con chasis al 0%
const nozzle = new THREE.Mesh(
  new THREE.ConeGeometry(3.2, 7, 16).rotateX(Math.PI),
  new THREE.MeshStandardMaterial({
    color: '#f1c40f',
    metalness: 0.9,
    roughness: 0.2,
    emissive: '#ff6600',
    emissiveIntensity: 0.15
  })
);
nozzle.position.y = -16.5;
toolhead.add(nozzle);

const nozzleLight = new THREE.PointLight('#ff9933', 2.2, 48);
nozzleLight.position.set(0, -18, 0);
toolhead.add(nozzleLight);

gantryBridge.add(toolhead);

// Control de transparencia total del chasis (0% deja solo la boquilla visible)
function setChassisOpacity(alpha) {
  const val = Math.max(0.0, Math.min(1.0, alpha));

  if (val <= 0.01) {
    frameStructureGroup.visible = false;
    xRail.visible = false;
    carriage.visible = false;
    heatsink.visible = false;
  } else {
    frameStructureGroup.visible = true;
    xRail.visible = true;
    carriage.visible = true;
    heatsink.visible = true;

    chassisMaterial.opacity = val;
    chassisMaterial.depthWrite = val > 0.85;
    chassisMaterial.needsUpdate = true;

    railMaterial.opacity = Math.min(1.0, val * 1.15);
    railMaterial.depthWrite = val > 0.85;
    railMaterial.needsUpdate = true;

    heatsinkMaterial.opacity = Math.min(1.0, val * 1.35);
    heatsinkMaterial.depthWrite = val > 0.7;
    heatsinkMaterial.needsUpdate = true;
  }
}

// --- MODO NOCTURNO ---
function setNightMode(enabled) {
  isNightMode = enabled;
  nightModeToggle.checked = enabled;
  nightModeBtn.classList.toggle('night-active', enabled);

  bedAssembly.remove(bedGrid);
  bedGrid.geometry.dispose();

  if (enabled) {
    // Escena oscura con cama PEI texturada oscura + neón y luz focal en boquilla
    const darkBg = '#050609';
    scene.background.set(darkBg);
    scene.fog.color.set(darkBg);

    ambientLight.intensity = 0.14;
    keyLight.intensity = 0.45;
    keyLight.color.set('#b8d0ff');
    fillLight.intensity = 0.25;

    bedMaterial.color.set('#0b0d12');
    bedMaterial.roughness = 0.35;
    bedMaterial.metalness = 0.5;
    bedNeonMaterial.opacity = 0.85;

    bedGrid = new THREE.GridHelper(BED_SIZE, 16, 0x00a8ff, 0x102238);
    bedGrid.position.y = 0.2;
    bedAssembly.add(bedGrid);

    filamentMaterial.emissive.copy(filamentMaterial.color);
    filamentMaterial.emissiveIntensity = 0.22;

    nozzleLight.intensity = 4.5;
    nozzleLight.distance = 85;
    nozzle.material.emissiveIntensity = 0.55;
  } else {
    // Restaurar modo estudio normal
    scene.background.set(userBgColor);
    scene.fog.color.set(userBgColor);

    ambientLight.intensity = 0.42;
    keyLight.intensity = 1.55;
    keyLight.color.set('#ffffff');
    fillLight.intensity = 0.55;

    bedMaterial.color.set('#181a20');
    bedMaterial.roughness = 0.65;
    bedMaterial.metalness = 0.25;
    bedNeonMaterial.opacity = 0.0;

    bedGrid = new THREE.GridHelper(BED_SIZE, 16, 0x3a4052, 0x262a36);
    bedGrid.position.y = 0.2;
    bedAssembly.add(bedGrid);

    filamentMaterial.emissiveIntensity = 0.0;

    nozzleLight.intensity = 2.2;
    nozzleLight.distance = 48;
    nozzle.material.emissiveIntensity = 0.15;
  }
}

let printedMesh = null;
const VERTS_PER_SEGMENT = 18;

// --- GENERADOR DE CORDÓN 3D CON NORMALES ---
function appendBeadTriangles(p1, p2, radius, outPositions) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dz = p2.z - p1.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return false;

  const nx = -dz / len;
  const nz = dx / len;

  const rW = radius * 1.15;
  const rH = radius * 0.85;

  const a1 = [p1.x, p1.y + rH, p1.z];
  const b1 = [p1.x + nx * rW, p1.y - rH * 0.6, p1.z + nz * rW];
  const c1 = [p1.x - nx * rW, p1.y - rH * 0.6, p1.z - nz * rW];

  const a2 = [p2.x, p2.y + rH, p2.z];
  const b2 = [p2.x + nx * rW, p2.y - rH * 0.6, p2.z + nz * rW];
  const c2 = [p2.x - nx * rW, p2.y - rH * 0.6, p2.z - nz * rW];

  outPositions.push(...a1, ...b1, ...b2, ...a1, ...b2, ...a2);
  outPositions.push(...c1, ...a1, ...a2, ...c1, ...a2, ...c2);
  outPositions.push(...b1, ...c1, ...c2, ...b1, ...c2, ...b2);

  return true;
}

// --- CÁLCULO DE RELLENO INTERNO (INFILL ±45°) ---
function generateLayerInfill(perimeterSegments, sliceY, layerIndex, densityPercent) {
  if (densityPercent <= 0 || perimeterSegments.length < 3) return [];

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [p1, p2] of perimeterSegments) {
    minX = Math.min(minX, p1.x, p2.x);
    maxX = Math.max(maxX, p1.x, p2.x);
    minZ = Math.min(minZ, p1.z, p2.z);
    maxZ = Math.max(maxZ, p1.z, p2.z);
  }

  const spacing = THREE.MathUtils.lerp(13.0, 2.2, (densityPercent - 10) / 50);
  const angle = (layerIndex % 2 === 0) ? Math.PI / 4 : -Math.PI / 4;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const diag = Math.hypot(maxX - minX, maxZ - minZ) * 0.55;

  const infillSegs = [];
  const margin = BEAD_RADIUS * 1.4;

  for (let u = -diag; u <= diag; u += spacing) {
    const ox = cx + u * cos;
    const oz = cz + u * sin;
    const dx = -sin;
    const dz = cos;

    const hits = [];
    for (const [p1, p2] of perimeterSegments) {
      const sx = p2.x - p1.x;
      const sz = p2.z - p1.z;
      const denom = dx * sz - dz * sx;
      if (Math.abs(denom) < 1e-6) continue;

      const t = ((p1.x - ox) * sz - (p1.z - oz) * sx) / denom;
      const s = ((p1.x - ox) * dz - (p1.z - oz) * dx) / denom;

      if (s >= 0 && s <= 1) {
        hits.push(t);
      }
    }

    hits.sort((a, b) => a - b);

    for (let k = 0; k + 1 < hits.length; k += 2) {
      const tStart = hits[k] + margin;
      const tEnd = hits[k + 1] - margin;
      if (tEnd - tStart > 1.2) {
        infillSegs.push([
          new THREE.Vector3(ox + tStart * dx, sliceY, oz + tStart * dz),
          new THREE.Vector3(ox + tEnd * dx, sliceY, oz + tEnd * dz)
        ]);
      }
    }
  }

  return infillSegs;
}

// --- SLICER GEOMÉTRICO EN JAVASCRIPT ---
function sliceGeometry(rawGeometry) {
  currentRawGeometry = rawGeometry;
  const geo = rawGeometry.clone();
  geo.computeBoundingBox();

  geo.rotateX(-Math.PI / 2);
  geo.computeBoundingBox();

  const box = geo.boundingBox;
  const size = new THREE.Vector3();
  box.getSize(size);

  const maxDim = Math.max(size.x, size.y, size.z);
  const targetSize = 95;
  const scale = targetSize / maxDim;
  geo.scale(scale, scale, scale);

  geo.computeBoundingBox();
  const newBox = geo.boundingBox;
  const center = new THREE.Vector3();
  newBox.getCenter(center);

  geo.translate(-center.x, -newBox.min.y, -center.z);
  geo.computeBoundingBox();

  const modelHeight = geo.boundingBox.max.y;
  const posAttr = geo.attributes.position;
  const isIndexed = geo.index !== null;
  const triCount = isIndexed ? geo.index.count / 3 : posAttr.count / 3;

  const triangles = [];
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  for (let i = 0; i < triCount; i++) {
    const i0 = isIndexed ? geo.index.getX(i * 3) : i * 3;
    const i1 = isIndexed ? geo.index.getX(i * 3 + 1) : i * 3 + 1;
    const i2 = isIndexed ? geo.index.getX(i * 3 + 2) : i * 3 + 2;

    vA.fromBufferAttribute(posAttr, i0);
    vB.fromBufferAttribute(posAttr, i1);
    vC.fromBufferAttribute(posAttr, i2);

    const minY = Math.min(vA.y, vB.y, vC.y);
    const maxY = Math.max(vA.y, vB.y, vC.y);
    triangles.push({ a: vA.clone(), b: vB.clone(), c: vC.clone(), minY, maxY });
  }

  const numLayers = Math.max(1, Math.floor(modelHeight / LAYER_HEIGHT));
  const positions = [];
  toolpathPoints = [];
  layerStartIndices = [];

  for (let l = 0; l < numLayers; l++) {
    const sliceY = (l + 0.5) * LAYER_HEIGHT;
    const rawSegments = [];

    for (let t = 0; t < triangles.length; t++) {
      const tri = triangles[t];
      if (sliceY < tri.minY || sliceY > tri.maxY) continue;

      const pts = [];
      intersectEdge(tri.a, tri.b, sliceY, pts);
      intersectEdge(tri.b, tri.c, sliceY, pts);
      intersectEdge(tri.c, tri.a, sliceY, pts);

      if (pts.length >= 2) {
        rawSegments.push([pts[0], pts[1]]);
      }
    }

    if (rawSegments.length === 0) continue;

    layerStartIndices.push({ layer: l + 1, segIndex: toolpathPoints.length });

    const orderedPerimeter = orderSegments(rawSegments);
    const effectiveDensity = (infillDensity > 0 && (l < 2 || l >= numLayers - 2))
      ? Math.max(infillDensity, 55)
      : infillDensity;
    const rawInfill = generateLayerInfill(rawSegments, sliceY, l, effectiveDensity);
    const orderedInfill = rawInfill.length > 0 ? orderSegments(rawInfill) : [];

    const combined = [...orderedPerimeter, ...orderedInfill];

    combined.forEach(([p1, p2]) => {
      if (appendBeadTriangles(p1, p2, BEAD_RADIUS, positions)) {
        toolpathPoints.push({
          start: p1,
          end: p2,
          layer: l + 1
        });
      }
    });
  }

  if (printedMesh) {
    bedAssembly.remove(printedMesh);
    printedMesh.geometry.dispose();
  }

  const meshGeo = new THREE.BufferGeometry();
  meshGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  meshGeo.computeVertexNormals();
  meshGeo.setDrawRange(0, 0);

  printedMesh = new THREE.Mesh(meshGeo, filamentMaterial);
  printedMesh.castShadow = true;
  printedMesh.receiveShadow = true;
  bedAssembly.add(printedMesh);

  totalSegments = toolpathPoints.length;
  currentSegmentFloat = 0;
  printDirection = 1;
}

function intersectEdge(p1, p2, y, outPts) {
  if ((p1.y <= y && p2.y >= y) || (p2.y <= y && p1.y >= y)) {
    const dy = p2.y - p1.y;
    if (Math.abs(dy) < 1e-6) return;
    const t = (y - p1.y) / dy;
    outPts.push(new THREE.Vector3(
      p1.x + t * (p2.x - p1.x),
      y,
      p1.z + t * (p2.z - p1.z)
    ));
  }
}

function orderSegments(segments) {
  const result = [];
  const used = new Uint8Array(segments.length);
  let currentPos = segments[0][0];

  for (let i = 0; i < segments.length; i++) {
    let bestIdx = -1;
    let bestDist = Infinity;
    let flip = false;

    for (let j = 0; j < segments.length; j++) {
      if (used[j]) continue;
      const d0 = currentPos.distanceToSquared(segments[j][0]);
      const d1 = currentPos.distanceToSquared(segments[j][1]);
      if (d0 < bestDist) {
        bestDist = d0;
        bestIdx = j;
        flip = false;
      }
      if (d1 < bestDist) {
        bestDist = d1;
        bestIdx = j;
        flip = true;
      }
    }

    if (bestIdx === -1) break;
    used[bestIdx] = 1;
    const seg = flip ? [segments[bestIdx][1], segments[bestIdx][0]] : segments[bestIdx];
    result.push(seg);
    currentPos = seg[1];
  }
  return result;
}

function loadDefaultModel() {
  const geo = new THREE.TorusKnotGeometry(28, 9, 120, 20, 2, 3);
  geo.rotateX(Math.PI / 2);
  sliceGeometry(geo);
}

loadDefaultModel();

// --- CARGA DE ARCHIVOS .STL ---
const stlLoader = new STLLoader();

function loadSTLFromBuffer(buffer) {
  const geometry = stlLoader.parse(buffer);
  sliceGeometry(geometry);
}

document.getElementById('stlInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => loadSTLFromBuffer(ev.target.result);
  reader.readAsArrayBuffer(file);
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.stl')) {
    const reader = new FileReader();
    reader.onload = (ev) => loadSTLFromBuffer(ev.target.result);
    reader.readAsArrayBuffer(file);
  }
});

// --- SISTEMA DE BLOQUEO Y JOYSTICKS SUAVES DE CÁMARA ---
const quickActions = document.getElementById('quick-actions');
const playPauseBtn = document.getElementById('playPauseBtn');
const nightModeBtn = document.getElementById('nightModeBtn');
const lockCameraBtn = document.getElementById('lockCameraBtn');
const toggleCameraPadBtn = document.getElementById('toggleCameraPadBtn');
const cameraPad = document.getElementById('camera-pad');
const closeCameraPadBtn = document.getElementById('closeCameraPadBtn');
const lockCameraToggle = document.getElementById('lockCameraToggle');
const autoRotateGroup = document.getElementById('autoRotateGroup');
const autoRotateToggle = document.getElementById('autoRotateToggle');
const rotateSpeedGroup = document.getElementById('rotateSpeedGroup');

const joyInput = { orbitX: 0, orbitY: 0, panX: 0, panY: 0, zoomVel: 0 };
const joySmooth = { orbitX: 0, orbitY: 0, panX: 0, panY: 0, zoomVel: 0 };

function setupJoystick(baseId, stickId, onMove) {
  const base = document.getElementById(baseId);
  const stick = document.getElementById(stickId);
  const maxRadius = 26;
  let activePointer = null;

  const updateStick = (clientX, clientY) => {
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);

    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }

    stick.style.transform = `translate(${dx}px, ${dy}px)`;
    onMove(dx / maxRadius, dy / maxRadius);
  };

  const resetStick = () => {
    activePointer = null;
    stick.style.transition = 'transform 0.18s ease-out';
    stick.style.transform = 'translate(0px, 0px)';
    onMove(0, 0);
  };

  base.addEventListener('pointerdown', (e) => {
    if (isCameraLocked) return;
    e.stopPropagation();
    base.setPointerCapture(e.pointerId);
    activePointer = e.pointerId;
    stick.style.transition = 'none';
    updateStick(e.clientX, e.clientY);
  });

  base.addEventListener('pointermove', (e) => {
    if (e.pointerId === activePointer) updateStick(e.clientX, e.clientY);
  });

  base.addEventListener('pointerup', (e) => {
    if (e.pointerId === activePointer) resetStick();
  });

  base.addEventListener('pointercancel', (e) => {
    if (e.pointerId === activePointer) resetStick();
  });
}

setupJoystick('joyOrbit', 'stickOrbit', (nx, ny) => {
  joyInput.orbitX = nx;
  joyInput.orbitY = ny;
});

setupJoystick('joyPan', 'stickPan', (nx, ny) => {
  joyInput.panX = nx;
  joyInput.panY = ny;
});

const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');

zoomInBtn.addEventListener('pointerdown', () => { if (!isCameraLocked) joyInput.zoomVel = -1; });
zoomInBtn.addEventListener('pointerup', () => { joyInput.zoomVel = 0; });
zoomInBtn.addEventListener('pointerleave', () => { joyInput.zoomVel = 0; });

zoomOutBtn.addEventListener('pointerdown', () => { if (!isCameraLocked) joyInput.zoomVel = 1; });
zoomOutBtn.addEventListener('pointerup', () => { joyInput.zoomVel = 0; });
zoomOutBtn.addEventListener('pointerleave', () => { joyInput.zoomVel = 0; });

document.querySelectorAll('#camera-pad button[data-cam]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isCameraLocked) return;
    const view = btn.getAttribute('data-cam');
    if (view === 'view-front') {
      controls.target.set(0, 75, 0);
      camera.position.set(0, 85, 310);
    } else if (view === 'view-iso') {
      controls.target.set(0, 65, 0);
      camera.position.set(220, 185, 240);
    } else if (view === 'view-top') {
      controls.target.set(0, 50, 0);
      camera.position.set(0, 340, 25);
    }
    controls.update();
  });
});

function setCameraLocked(locked) {
  isCameraLocked = locked;
  controls.enabled = !locked;
  lockCameraToggle.checked = locked;

  if (locked) {
    controls.autoRotate = false;
    joyInput.orbitX = joyInput.orbitY = joyInput.panX = joyInput.panY = joyInput.zoomVel = 0;
    lockCameraBtn.textContent = '🔒';
    lockCameraBtn.classList.add('locked-active');
    cameraPad.classList.add('pad-locked');
    autoRotateGroup.classList.add('disabled');
    rotateSpeedGroup.classList.add('disabled');
  } else {
    controls.autoRotate = autoRotateToggle.checked;
    lockCameraBtn.textContent = '🔓';
    lockCameraBtn.classList.remove('locked-active');
    cameraPad.classList.remove('pad-locked');
    autoRotateGroup.classList.remove('disabled');
    rotateSpeedGroup.classList.toggle('disabled', !autoRotateToggle.checked);
  }
}

lockCameraBtn.addEventListener('click', () => setCameraLocked(!isCameraLocked));
lockCameraToggle.addEventListener('change', (e) => setCameraLocked(e.target.checked));

const uiContainer = document.getElementById('ui-container');
const toggleUiBtn = document.getElementById('toggleUiBtn');
const closeUiBtn = document.getElementById('closeUiBtn');

toggleCameraPadBtn.addEventListener('click', () => {
  uiContainer.classList.add('collapsed');
  cameraPad.classList.toggle('collapsed');
});

closeCameraPadBtn.addEventListener('click', () => cameraPad.classList.add('collapsed'));

toggleUiBtn.addEventListener('click', () => {
  cameraPad.classList.add('collapsed');
  uiContainer.classList.toggle('collapsed');
});

closeUiBtn.addEventListener('click', () => uiContainer.classList.add('collapsed'));

// --- CONTROLES DE PERSONALIZACIÓN ---
const filamentInput = document.getElementById('filamentColor');
const infillSlider = document.getElementById('infillSlider');
const infillVal = document.getElementById('infillVal');
const printerInput = document.getElementById('printerColor');
const chassisOpacitySlider = document.getElementById('chassisOpacitySlider');
const chassisOpacityVal = document.getElementById('chassisOpacityVal');
const bgInput = document.getElementById('bgColor');
const speedSlider = document.getElementById('speedSlider');
const speedVal = document.getElementById('speedVal');
const nightModeToggle = document.getElementById('nightModeToggle');
const reverseLoopToggle = document.getElementById('reverseLoopToggle');
const rotateSpeedSlider = document.getElementById('rotateSpeedSlider');
const rotateSpeedVal = document.getElementById('rotateSpeedVal');

function updateSpeed(newSpeed) {
  printSpeed = Math.max(0, newSpeed);
  if (printSpeed > 0) {
    lastNonZeroSpeed = printSpeed;
    playPauseBtn.textContent = '⏸️';
  } else {
    playPauseBtn.textContent = '▶️';
  }
  speedSlider.value = printSpeed;
  speedVal.textContent = `${printSpeed.toFixed(1)}x`;
}

playPauseBtn.addEventListener('click', () => {
  if (printSpeed > 0) {
    updateSpeed(0);
  } else {
    updateSpeed(lastNonZeroSpeed || 1.0);
  }
});

nightModeBtn.addEventListener('click', () => setNightMode(!isNightMode));
nightModeToggle.addEventListener('change', (e) => setNightMode(e.target.checked));

reverseLoopToggle.addEventListener('change', (e) => {
  isReverseLoop = e.target.checked;
  if (!isReverseLoop) printDirection = 1;
});

filamentInput.addEventListener('input', (e) => {
  filamentMaterial.color.set(e.target.value);
  if (isNightMode) {
    filamentMaterial.emissive.set(e.target.value);
  }
});

infillSlider.addEventListener('input', (e) => {
  infillDensity = parseInt(e.target.value, 10);
  infillVal.textContent = `${infillDensity}%`;
  if (currentRawGeometry) {
    const prevProgress = totalSegments > 0 ? currentSegmentFloat / totalSegments : 0;
    sliceGeometry(currentRawGeometry);
    currentSegmentFloat = prevProgress * totalSegments;
  }
});

printerInput.addEventListener('input', (e) => chassisMaterial.color.set(e.target.value));

chassisOpacitySlider.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  setChassisOpacity(val);
  chassisOpacityVal.textContent = `${Math.round(val * 100)}%`;
});

bgInput.addEventListener('input', (e) => {
  userBgColor = e.target.value;
  if (!isNightMode) {
    scene.background.set(userBgColor);
    scene.fog.color.set(userBgColor);
  }
});

speedSlider.addEventListener('input', (e) => {
  updateSpeed(parseFloat(e.target.value));
});

autoRotateToggle.addEventListener('change', (e) => {
  if (!isCameraLocked) {
    controls.autoRotate = e.target.checked;
  }
  rotateSpeedGroup.classList.toggle('disabled', !e.target.checked);
});

rotateSpeedSlider.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  controls.autoRotateSpeed = val;
  rotateSpeedVal.textContent = val.toFixed(1);
});

// --- INTEGRACIÓN NATIVA CON WALLPAPER ENGINE ---
function weColorToThree(weColorString) {
  const rgb = weColorString.split(' ').map(Number);
  return new THREE.Color(rgb[0], rgb[1], rgb[2]);
}

window.wallpaperPropertyListener = {
  applyUserProperties: function (properties) {
    if (properties.showwebmenu !== undefined) {
      const show = properties.showwebmenu.value;
      quickActions.classList.toggle('hidden-completely', !show);
      if (!show) {
        uiContainer.classList.add('collapsed');
        cameraPad.classList.add('collapsed');
      }
    }
    if (properties.nightmode !== undefined) {
      setNightMode(properties.nightmode.value);
    }
    if (properties.reverseloop !== undefined) {
      isReverseLoop = properties.reverseloop.value;
      reverseLoopToggle.checked = isReverseLoop;
      if (!isReverseLoop) printDirection = 1;
    }
    if (properties.lockcamera !== undefined) {
      setCameraLocked(properties.lockcamera.value);
    }
    if (properties.filamentcolor) {
      const c = weColorToThree(properties.filamentcolor.value);
      filamentMaterial.color.copy(c);
      if (isNightMode) filamentMaterial.emissive.copy(c);
      filamentInput.value = '#' + c.getHexString();
    }
    if (properties.infilldensity !== undefined) {
      infillDensity = properties.infilldensity.value;
      infillSlider.value = infillDensity;
      infillVal.textContent = `${infillDensity}%`;
      if (currentRawGeometry) sliceGeometry(currentRawGeometry);
    }
    if (properties.printercolor) {
      const c = weColorToThree(properties.printercolor.value);
      chassisMaterial.color.copy(c);
      printerInput.value = '#' + c.getHexString();
    }
    if (properties.chassisopacity !== undefined) {
      const val = properties.chassisopacity.value;
      setChassisOpacity(val);
      chassisOpacitySlider.value = val;
      chassisOpacityVal.textContent = `${Math.round(val * 100)}%`;
    }
    if (properties.bgcolor) {
      const c = weColorToThree(properties.bgcolor.value);
      userBgColor = '#' + c.getHexString();
      bgInput.value = userBgColor;
      if (!isNightMode) {
        scene.background.copy(c);
        scene.fog.color.copy(c);
      }
    }
    if (properties.printspeed !== undefined) {
      updateSpeed(properties.printspeed.value);
    }
    if (properties.autorotate !== undefined) {
      const enabled = properties.autorotate.value;
      autoRotateToggle.checked = enabled;
      if (!isCameraLocked) controls.autoRotate = enabled;
      rotateSpeedGroup.classList.toggle('disabled', !enabled);
    }
    if (properties.rotatespeed) {
      const val = properties.rotatespeed.value;
      controls.autoRotateSpeed = val;
      rotateSpeedSlider.value = val;
      rotateSpeedVal.textContent = val.toFixed(1);
    }
    if (properties.modelfile && properties.modelfile.value) {
      const filePath = 'file:///' + properties.modelfile.value.replace(/\\/g, '/');
      fetch(filePath)
        .then(res => res.arrayBuffer())
        .then(buf => loadSTLFromBuffer(buf))
        .catch(err => console.error('Error cargando STL desde WE:', err));
    }
  }
};

// --- LOOP DE ANIMACIÓN ---
const layerInfoEl = document.getElementById('layerInfo');
const progressInfoEl = document.getElementById('progressInfo');
const nozzleTipHeight = topY - 20;

const clock = new THREE.Clock();

function applySmoothJoystickCamera(dt) {
  if (isCameraLocked) return;

  const smoothFactor = 1 - Math.exp(-10 * dt);
  joySmooth.orbitX += (joyInput.orbitX - joySmooth.orbitX) * smoothFactor;
  joySmooth.orbitY += (joyInput.orbitY - joySmooth.orbitY) * smoothFactor;
  joySmooth.panX += (joyInput.panX - joySmooth.panX) * smoothFactor;
  joySmooth.panY += (joyInput.panY - joySmooth.panY) * smoothFactor;
  joySmooth.zoomVel += (joyInput.zoomVel - joySmooth.zoomVel) * smoothFactor;

  const hasMotion =
    Math.abs(joySmooth.orbitX) > 0.002 ||
    Math.abs(joySmooth.orbitY) > 0.002 ||
    Math.abs(joySmooth.panX) > 0.002 ||
    Math.abs(joySmooth.panY) > 0.002 ||
    Math.abs(joySmooth.zoomVel) > 0.002;

  if (!hasMotion) return;

  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  const spherical = new THREE.Spherical().setFromVector3(offset);

  spherical.theta -= joySmooth.orbitX * 1.6 * dt;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi + joySmooth.orbitY * 1.4 * dt, 0.15, Math.PI - 0.15);

  spherical.radius = THREE.MathUtils.clamp(
    spherical.radius * (1 + joySmooth.zoomVel * 1.1 * dt),
    controls.minDistance,
    controls.maxDistance
  );

  offset.setFromSpherical(spherical);
  camera.position.copy(controls.target).add(offset);

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  const panSpeed = 140 * dt;
  controls.target.addScaledVector(right, joySmooth.panX * panSpeed);
  camera.position.addScaledVector(right, joySmooth.panX * panSpeed);

  controls.target.addScaledVector(up, -joySmooth.panY * panSpeed);
  camera.position.addScaledVector(up, -joySmooth.panY * panSpeed);
}

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.1);

  if (totalSegments > 0 && printedMesh) {
    // Si printSpeed === 0, no se avanza y queda congelado en su posición exacta
    if (printSpeed > 0) {
      const segmentsPerSecond = Math.max(45, totalSegments * 0.035) * printSpeed;
      currentSegmentFloat += segmentsPerSecond * dt * printDirection;

      if (currentSegmentFloat >= totalSegments) {
        if (isReverseLoop) {
          currentSegmentFloat = totalSegments - 0.001;
          printDirection = -1;
        } else {
          currentSegmentFloat = 0;
          printDirection = 1;
        }
      } else if (currentSegmentFloat < 0) {
        currentSegmentFloat = 0;
        printDirection = 1;
      }
    }

    const segIdx = Math.max(0, Math.min(totalSegments - 1, Math.floor(currentSegmentFloat)));
    const frac = currentSegmentFloat - segIdx;
    const currentSeg = toolpathPoints[segIdx];

    printedMesh.geometry.setDrawRange(0, (segIdx + 1) * VERTS_PER_SEGMENT);

    const tipX = THREE.MathUtils.lerp(currentSeg.start.x, currentSeg.end.x, frac);
    const tipY = currentSeg.start.y;
    const tipZ = THREE.MathUtils.lerp(currentSeg.start.z, currentSeg.end.z, frac);

    gantryBridge.position.z = tipZ;
    toolhead.position.x = tipX;
    bedAssembly.position.y = nozzleTipHeight - tipY;

    const totalLayers = layerStartIndices.length;
    const pct = Math.floor((segIdx / totalSegments) * 100);
    const dirSymbol = printDirection === -1 ? ' ⏪' : '';
    layerInfoEl.textContent = `Capa: ${currentSeg.layer} / ${totalLayers}${dirSymbol}`;
    progressInfoEl.textContent = `${pct}%`;
  }

  applySmoothJoystickCamera(dt);
  controls.update();
  renderer.render(scene, camera);
}

animate();

// --- RESPONSIVE ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
