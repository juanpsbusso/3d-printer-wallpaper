import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { unzipSync, strFromU8 } from 'fflate';

// --- GENERAL CONFIGURATION & PERSISTENT STATE ---
const BED_SIZE = 160;
const BUILD_HEIGHT = 150;
const LAYER_HEIGHT = 0.55;
const BEAD_RADIUS = 0.34;
const BED_SURFACE_Y = 20;
const SETTINGS_STORAGE_KEY = 'printerSimSettings_v3';
const MODEL_STORAGE_KEY = 'savedCustomModel_v3';
const BOOT_TIMESTAMP = performance.now();

const defaultSettings = {
  filamentColor: '#00a8ff',
  use3mfColors: true,
  enableInfill: true,
  infillDensity: 20,
  printerColor: '#242730',
  chassisOpacity: 0.35,
  bgColor: '#0d0f14',
  printSpeed: 1.0,
  nightMode: false,
  reverseLoop: true,
  lockCamera: false,
  autoRotate: true,
  rotateSpeed: 0.5,
  modelScale: 100,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  camPos: [205, BED_SURFACE_Y + 143, 225],
  camTarget: [0, BED_SURFACE_Y + 38, 0]
};

function readCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=315360000; path=/; SameSite=Lax`;
}

function hasPersistedSettings() {
  return readCookie(SETTINGS_STORAGE_KEY) !== null || localStorage.getItem(SETTINGS_STORAGE_KEY) !== null;
}

function loadSavedSettings() {
  try {
    const raw = readCookie(SETTINGS_STORAGE_KEY) || localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch (e) {
    return { ...defaultSettings };
  }
}

const appState = loadSavedSettings();

function saveSettings() {
  const serialized = JSON.stringify(appState);
  writeCookie(SETTINGS_STORAGE_KEY, serialized);
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, serialized);
  } catch (e) {
    // Ignore storage quota errors
  }
}

let printSpeed = appState.printSpeed;
let lastNonZeroSpeed = appState.printSpeed > 0 ? appState.printSpeed : 1.0;
let isInfillEnabled = appState.enableInfill;
let infillDensity = appState.infillDensity;
let use3mfColors = appState.use3mfColors;
let currentSegmentFloat = 0;
let totalSegments = 0;
let layerStartIndices = [];
let toolpathPoints = [];
let isReverseLoop = appState.reverseLoop;
let printDirection = 1;
let isCameraLocked = appState.lockCamera;
let isNightMode = appState.nightMode;
let currentModelTriangles = [];
let currentModelHasEmbeddedColors = false;
let userBgColor = appState.bgColor;

// --- SCENE, CAMERA & RENDERER ---
const canvas = document.getElementById('canvas3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(userBgColor);
scene.fog = new THREE.FogExp2(userBgColor, 0.0015);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 1500);

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
controls.autoRotate = appState.autoRotate;
controls.autoRotateSpeed = appState.rotateSpeed;

if (Array.isArray(appState.camPos) && appState.camPos.length === 3) {
  camera.position.set(appState.camPos[0], appState.camPos[1], appState.camPos[2]);
}
if (Array.isArray(appState.camTarget) && appState.camTarget.length === 3) {
  controls.target.set(appState.camTarget[0], appState.camTarget[1], appState.camTarget[2]);
}
controls.update();

let camSaveTimeout = null;
function scheduleCameraSave() {
  clearTimeout(camSaveTimeout);
  camSaveTimeout = setTimeout(() => {
    appState.camPos = [
      Number(camera.position.x.toFixed(2)),
      Number(camera.position.y.toFixed(2)),
      Number(camera.position.z.toFixed(2))
    ];
    appState.camTarget = [
      Number(controls.target.x.toFixed(2)),
      Number(controls.target.y.toFixed(2)),
      Number(controls.target.z.toFixed(2))
    ];
    saveSettings();
  }, 250);
}

controls.addEventListener('change', scheduleCameraSave);
canvas.addEventListener('pointerdown', () => window.focus());

// --- LIGHTING ---
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

const rimLight = new THREE.DirectionalLight(0x99ccff, 0.35);
rimLight.position.set(-120, 190, -210);
scene.add(rimLight);

const bottomBounceLight = new THREE.DirectionalLight(0x445577, 0.3);
bottomBounceLight.position.set(0, -100, 50);
scene.add(bottomBounceLight);

// --- MATERIALS ---
const chassisMaterial = new THREE.MeshStandardMaterial({
  color: appState.printerColor,
  roughness: 0.45,
  metalness: 0.65,
  transparent: true,
  opacity: appState.chassisOpacity,
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

// Switched dynamically between solid color (instant GPU tint) and 3MF vertexColors
const filamentMaterial = new THREE.MeshStandardMaterial({
  color: appState.filamentColor,
  vertexColors: false,
  roughness: 0.36,
  metalness: 0.08,
  emissive: appState.filamentColor,
  emissiveIntensity: 0.0
});

function syncFilamentMaterialMode() {
  const showMulticolor = currentModelHasEmbeddedColors && use3mfColors;
  if (showMulticolor) {
    filamentMaterial.vertexColors = true;
    filamentMaterial.color.set('#ffffff');
    if (isNightMode) {
      filamentMaterial.emissive.set('#334155');
    }
  } else {
    filamentMaterial.vertexColors = false;
    filamentMaterial.color.set(appState.filamentColor);
    if (isNightMode) {
      filamentMaterial.emissive.set(appState.filamentColor);
    }
  }
  filamentMaterial.needsUpdate = true;
}

// --- PRINTER ASSEMBLY (FIXED BED + FLYING GANTRY) ---
const printerGroup = new THREE.Group();
const frameStructureGroup = new THREE.Group();
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

  const zRodGeo = new THREE.CylinderGeometry(2.5, 2.5, frameH - 16, 12);
  [[-frameW / 2 + 12, -frameW / 2 + 12], [frameW / 2 - 12, -frameW / 2 + 12],
   [-frameW / 2 + 12, frameW / 2 - 12], [frameW / 2 - 12, frameW / 2 - 12]].forEach(([x, z]) => {
    const rod = new THREE.Mesh(zRodGeo, railMaterial);
    rod.position.set(x, frameH / 2, z);
    frameStructureGroup.add(rod);
  });
}

buildPrinter();

// Fixed Heated Bed Assembly
const bedAssembly = new THREE.Group();
bedAssembly.position.y = BED_SURFACE_Y;

const bedPlate = new THREE.Mesh(new THREE.BoxGeometry(BED_SIZE, 4, BED_SIZE), bedMaterial);
bedPlate.position.y = -2;
bedPlate.receiveShadow = true;
bedAssembly.add(bedPlate);

const neonEdgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(BED_SIZE + 1.5, 4.2, BED_SIZE + 1.5));
const bedNeonOutline = new THREE.LineSegments(neonEdgesGeo, bedNeonMaterial);
bedNeonOutline.position.y = -2;
bedAssembly.add(bedNeonOutline);

let bedGrid = new THREE.GridHelper(BED_SIZE, 16, 0x3a4052, 0x262a36);
bedGrid.position.y = 0.2;
bedAssembly.add(bedGrid);

// --- DISCREET BUILD PLATE WATERMARK ("Jacataca*") ---
function createBedWatermarkMesh() {
  const wmCanvas = document.createElement('canvas');
  wmCanvas.width = 512;
  wmCanvas.height = 128;
  const ctx = wmCanvas.getContext('2d');

  ctx.clearRect(0, 0, wmCanvas.width, wmCanvas.height);
  ctx.font = '600 44px "Segoe UI", system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Jacataca*', wmCanvas.width - 16, wmCanvas.height / 2);

  const texture = new THREE.CanvasTexture(wmCanvas);
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const wmMat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.26,
    color: new THREE.Color('#9aa6bd'),
    depthWrite: false
  });

  const wmGeo = new THREE.PlaneGeometry(54, 13.5);
  wmGeo.rotateX(-Math.PI / 2);

  const mesh = new THREE.Mesh(wmGeo, wmMat);
  mesh.position.set(BED_SIZE / 2 - 31, 0.28, BED_SIZE / 2 - 11);
  return mesh;
}

const bedWatermarkMesh = createBedWatermarkMesh();
bedAssembly.add(bedWatermarkMesh);
printerGroup.add(bedAssembly);

// Flying Gantry Assembly
const gantryYAssembly = new THREE.Group();
gantryYAssembly.position.y = BED_SURFACE_Y + 20;
printerGroup.add(gantryYAssembly);

const sideRailGeo = new THREE.CylinderGeometry(2.5, 2.5, BED_SIZE + 30, 12).rotateX(Math.PI / 2);
[-BED_SIZE / 2 - 13, BED_SIZE / 2 + 13].forEach(x => {
  const sRail = new THREE.Mesh(sideRailGeo, railMaterial);
  gantryYAssembly.add(sRail);
});

const gantryBridge = new THREE.Group();
const xRail = new THREE.Mesh(
  new THREE.CylinderGeometry(3, 3, BED_SIZE + 26, 12).rotateZ(Math.PI / 2),
  railMaterial
);
gantryBridge.add(xRail);
gantryYAssembly.add(gantryBridge);

// Extruder Toolhead
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

function applyCameraPreset(view) {
  const focusY = BED_SURFACE_Y + 38;

  if (view === 'view-front') {
    controls.target.set(0, focusY, 0);
    camera.position.set(0, focusY + 12, 275);
  } else if (view === 'view-top') {
    controls.target.set(0, BED_SURFACE_Y + 15, 0);
    camera.position.set(0, BED_SURFACE_Y + 290, 25);
  } else {
    controls.target.set(0, focusY, 0);
    camera.position.set(205, focusY + 105, 225);
  }
  controls.update();
  scheduleCameraSave();
}

function setChassisOpacity(alpha, persist = true) {
  const val = Math.max(0.0, Math.min(1.0, alpha));
  appState.chassisOpacity = val;
  chassisOpacitySlider.value = val;
  chassisOpacityVal.textContent = `${Math.round(val * 100)}%`;

  if (val <= 0.01) {
    frameStructureGroup.visible = false;
    gantryYAssembly.children.forEach(child => {
      if (child !== gantryBridge) child.visible = false;
    });
    xRail.visible = false;
    carriage.visible = false;
    heatsink.visible = false;
  } else {
    frameStructureGroup.visible = true;
    gantryYAssembly.children.forEach(child => {
      child.visible = true;
    });
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

  if (persist) saveSettings();
}

// --- NIGHT MODE ---
function setNightMode(enabled, persist = true) {
  isNightMode = enabled;
  appState.nightMode = enabled;
  nightModeToggle.checked = enabled;
  nightModeBtn.classList.toggle('night-active', enabled);

  bedAssembly.remove(bedGrid);
  bedGrid.geometry.dispose();

  if (enabled) {
    const darkBg = '#050609';
    scene.background.set(darkBg);
    scene.fog.color.set(darkBg);

    ambientLight.intensity = 0.22;
    keyLight.intensity = 1.15;
    keyLight.color.set('#dce8ff');
    fillLight.intensity = 0.45;
    fillLight.color.set('#5588ff');
    rimLight.intensity = 0.95;
    rimLight.color.set('#aaddff');

    bedMaterial.color.set('#0b0d12');
    bedMaterial.roughness = 0.35;
    bedMaterial.metalness = 0.5;
    bedNeonMaterial.opacity = 0.85;

    bedGrid = new THREE.GridHelper(BED_SIZE, 16, 0x00a8ff, 0x102238);
    bedGrid.position.y = 0.2;
    bedAssembly.add(bedGrid);

    bedWatermarkMesh.material.color.set('#38bdf8');
    bedWatermarkMesh.material.opacity = 0.36;

    filamentMaterial.roughness = 0.21;
    filamentMaterial.metalness = 0.16;
    filamentMaterial.emissive.set(currentModelHasEmbeddedColors && use3mfColors ? '#334155' : appState.filamentColor);
    filamentMaterial.emissiveIntensity = 0.18;

    nozzleLight.intensity = 5.2;
    nozzleLight.distance = 95;
    nozzle.material.emissiveIntensity = 0.65;
  } else {
    scene.background.set(userBgColor);
    scene.fog.color.set(userBgColor);

    ambientLight.intensity = 0.42;
    keyLight.intensity = 1.55;
    keyLight.color.set('#ffffff');
    fillLight.intensity = 0.55;
    fillLight.color.set('#88b4ff');
    rimLight.intensity = 0.35;
    rimLight.color.set('#99ccff');

    bedMaterial.color.set('#181a20');
    bedMaterial.roughness = 0.65;
    bedMaterial.metalness = 0.25;
    bedNeonMaterial.opacity = 0.0;

    bedGrid = new THREE.GridHelper(BED_SIZE, 16, 0x3a4052, 0x262a36);
    bedGrid.position.y = 0.2;
    bedAssembly.add(bedGrid);

    bedWatermarkMesh.material.color.set('#9aa6bd');
    bedWatermarkMesh.material.opacity = 0.26;

    filamentMaterial.roughness = 0.36;
    filamentMaterial.metalness = 0.08;
    filamentMaterial.emissiveIntensity = 0.0;

    nozzleLight.intensity = 2.2;
    nozzleLight.distance = 48;
    nozzle.material.emissiveIntensity = 0.15;
  }

  if (persist) saveSettings();
}

let printedMesh = null;
const VERTS_PER_SEGMENT = 18;

// --- 3D EXTRUSION BEAD GENERATOR WITH VERTEX COLORS ---
function appendBeadTriangles(p1, p2, radius, color, outPositions, outColors) {
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

  for (let i = 0; i < VERTS_PER_SEGMENT; i++) {
    outColors.push(color.r, color.g, color.b);
  }

  return true;
}

function subdivideSegment(segObj, maxStep = 2.2) {
  const { p1, p2, color } = segObj;
  const dist = p1.distanceTo(p2);
  if (dist <= maxStep) return [segObj];

  const steps = Math.ceil(dist / maxStep);
  const subSegs = [];
  let prev = p1;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const curr = (i === steps) ? p2 : new THREE.Vector3().lerpVectors(p1, p2, t);
    subSegs.push({ p1: prev, p2: curr, color });
    prev = curr;
  }
  return subSegs;
}

function generateLayerInfill(perimeterSegObjs, sliceY, layerIndex, densityPercent, fallbackColor) {
  if (!isInfillEnabled || densityPercent <= 0 || perimeterSegObjs.length < 3) return [];

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const { p1, p2 } of perimeterSegObjs) {
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
    for (const seg of perimeterSegObjs) {
      const { p1, p2, color } = seg;
      const sx = p2.x - p1.x;
      const sz = p2.z - p1.z;
      const denom = dx * sz - dz * sx;
      if (Math.abs(denom) < 1e-6) continue;

      const t = ((p1.x - ox) * sz - (p1.z - oz) * sx) / denom;
      const s = ((p1.x - ox) * dz - (p1.z - oz) * dx) / denom;

      if (s >= 0 && s <= 1) {
        hits.push({ t, color });
      }
    }

    hits.sort((a, b) => a.t - b.t);

    for (let k = 0; k + 1 < hits.length; k += 2) {
      const tStart = hits[k].t + margin;
      const tEnd = hits[k + 1].t - margin;
      if (tEnd - tStart > 1.2) {
        const segColor = hits[k].color || fallbackColor;
        infillSegs.push({
          p1: new THREE.Vector3(ox + tStart * dx, sliceY, oz + tStart * dz),
          p2: new THREE.Vector3(ox + tEnd * dx, sliceY, oz + tEnd * dz),
          color: segColor
        });
      }
    }
  }

  return infillSegs;
}

// --- FAST .3MF PARSER (BAMBU STUDIO, ORCASLICER, PRUSASLICER & STANDARD 3MF) ---
function parse3MFTransformMatrix(transformStr) {
  const mat = new THREE.Matrix4();
  if (!transformStr) return mat;
  const nums = transformStr.trim().split(/\s+/).map(Number);
  if (nums.length === 12) {
    mat.set(
      nums[0], nums[3], nums[6], nums[9],
      nums[1], nums[4], nums[7], nums[10],
      nums[2], nums[5], nums[8], nums[11],
      0,       0,       0,       1
    );
  }
  return mat;
}

function parseHexColor3MF(hexStr) {
  if (!hexStr) return null;
  const clean = hexStr.trim().replace(/^#/, '');
  if (clean.length >= 6) {
    return new THREE.Color('#' + clean.slice(0, 6));
  }
  return null;
}

function parse3MFBuffer(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const parser = new DOMParser();

  const slicerPalette = [];
  for (const [path, data] of Object.entries(files)) {
    const lowerPath = path.toLowerCase();
    if (lowerPath.endsWith('project_settings.config') || lowerPath.endsWith('model_settings.config')) {
      try {
        const text = strFromU8(data);
        const jsonMatch = text.match(/"filament_colour"\s*:\s*\[([^\]]+)\]/);
        if (jsonMatch) {
          const hexes = jsonMatch[1].match(/#[0-9a-fA-F]{6}/g);
          if (hexes) hexes.forEach(h => slicerPalette.push(new THREE.Color(h)));
        }
      } catch (e) { /* ignore */ }
    }
  }

  const modelDocs = {};
  for (const [path, data] of Object.entries(files)) {
    if (path.toLowerCase().endsWith('.model')) {
      const normalizedPath = path.replace(/^\/+/, '');
      const xmlText = strFromU8(data);
      modelDocs[normalizedPath] = parser.parseFromString(xmlText, 'application/xml');
    }
  }

  const rootPath = Object.keys(modelDocs).find(p => p.toLowerCase() === '3d/3dmodel.model') || Object.keys(modelDocs)[0];
  if (!rootPath) throw new Error('No .model file found inside .3mf archive');

  const parsedModels = {};
  for (const [docPath, doc] of Object.entries(modelDocs)) {
    const baseMaterials = {};
    const bmNodes = doc.getElementsByTagName('basematerials');
    for (let i = 0; i < bmNodes.length; i++) {
      const bm = bmNodes[i];
      const id = bm.getAttribute('id');
      const list = [];
      const baseNodes = bm.getElementsByTagName('base');
      for (let j = 0; j < baseNodes.length; j++) {
        list.push(parseHexColor3MF(baseNodes[j].getAttribute('displaycolor')));
      }
      baseMaterials[id] = list;
    }

    const colorGroups = {};
    const cgNodes = doc.getElementsByTagName('colorgroup');
    for (let i = 0; i < cgNodes.length; i++) {
      const cg = cgNodes[i];
      const id = cg.getAttribute('id');
      const list = [];
      const cNodes = cg.getElementsByTagName('color');
      for (let j = 0; j < cNodes.length; j++) {
        list.push(parseHexColor3MF(cNodes[j].getAttribute('color')));
      }
      colorGroups[id] = list;
    }

    const objects = {};
    const objNodes = doc.getElementsByTagName('object');
    for (let i = 0; i < objNodes.length; i++) {
      const objEl = objNodes[i];
      const id = objEl.getAttribute('id');
      const pid = objEl.getAttribute('pid');
      const pindex = parseInt(objEl.getAttribute('pindex') || '0', 10);

      let objColor = null;
      if (pid && baseMaterials[pid] && baseMaterials[pid][pindex]) {
        objColor = baseMaterials[pid][pindex];
      } else if (pid && colorGroups[pid] && colorGroups[pid][pindex]) {
        objColor = colorGroups[pid][pindex];
      }

      const meshEl = objEl.getElementsByTagName('mesh')[0];
      let vertCoords = null;
      let tris = [];
      if (meshEl) {
        const vNodes = meshEl.getElementsByTagName('vertex');
        vertCoords = new Float32Array(vNodes.length * 3);
        for (let v = 0; v < vNodes.length; v++) {
          const vEl = vNodes[v];
          vertCoords[v * 3] = parseFloat(vEl.getAttribute('x') || '0');
          vertCoords[v * 3 + 1] = parseFloat(vEl.getAttribute('y') || '0');
          vertCoords[v * 3 + 2] = parseFloat(vEl.getAttribute('z') || '0');
        }

        const tNodes = meshEl.getElementsByTagName('triangle');
        tris = new Array(tNodes.length);
        for (let t = 0; t < tNodes.length; t++) {
          const tEl = tNodes[t];
          const v1 = parseInt(tEl.getAttribute('v1'), 10);
          const v2 = parseInt(tEl.getAttribute('v2'), 10);
          const v3 = parseInt(tEl.getAttribute('v3'), 10);

          const tPid = tEl.getAttribute('pid') || pid;
          const tP1 = parseInt(tEl.getAttribute('p1') || pindex, 10);
          const paintColor = tEl.getAttribute('paint_color');

          let triColor = objColor;
          if (tPid && baseMaterials[tPid] && baseMaterials[tPid][tP1]) {
            triColor = baseMaterials[tPid][tP1];
          } else if (tPid && colorGroups[tPid] && colorGroups[tPid][tP1]) {
            triColor = colorGroups[tPid][tP1];
          } else if (paintColor && slicerPalette.length > 0) {
            const slotIdx = Math.min(slicerPalette.length - 1, Math.max(0, parseInt(paintColor, 16) % slicerPalette.length));
            triColor = slicerPalette[slotIdx];
          }

          tris[t] = { v1, v2, v3, color: triColor };
        }
      }

      const components = [];
      const compNodes = objEl.getElementsByTagName('component');
      for (let c = 0; c < compNodes.length; c++) {
        const comp = compNodes[c];
        const compObjId = comp.getAttribute('objectid');
        const compPathAttr = comp.getAttribute('p:path') || comp.getAttributeNS('http://schemas.microsoft.com/3dmanufacturing/production/2015/06', 'path');
        const targetDocPath = compPathAttr ? compPathAttr.replace(/^\/+/, '') : docPath;
        const matrix = parse3MFTransformMatrix(comp.getAttribute('transform'));
        components.push({ objectId: compObjId, docPath: targetDocPath, matrix });
      }

      objects[id] = { vertCoords, tris, components, objColor };
    }

    parsedModels[docPath] = { objects };
  }

  const rootModel = parsedModels[rootPath];
  const rootDoc = modelDocs[rootPath];
  const buildItems = [];
  const itemNodes = rootDoc.getElementsByTagName('item');
  for (let i = 0; i < itemNodes.length; i++) {
    const item = itemNodes[i];
    const objectId = item.getAttribute('objectid');
    const itemPathAttr = item.getAttribute('p:path') || item.getAttributeNS('http://schemas.microsoft.com/3dmanufacturing/production/2015/06', 'path');
    const targetDocPath = itemPathAttr ? itemPathAttr.replace(/^\/+/, '') : rootPath;
    const matrix = parse3MFTransformMatrix(item.getAttribute('transform'));
    buildItems.push({ objectId, docPath: targetDocPath, matrix });
  }

  if (buildItems.length === 0) {
    Object.keys(rootModel.objects).forEach(id => {
      buildItems.push({ objectId: id, docPath: rootPath, matrix: new THREE.Matrix4() });
    });
  }

  const finalTriangles = [];
  let hasEmbeddedColors = false;
  const baseRotMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

  function traverseObject(docPath, objectId, parentMatrix, partIdxFallback) {
    const model = parsedModels[docPath];
    if (!model || !model.objects[objectId]) return;
    const obj = model.objects[objectId];

    if (obj.tris.length > 0 && obj.vertCoords) {
      const fullMatrix = new THREE.Matrix4().multiplyMatrices(baseRotMatrix, parentMatrix);
      const e = fullMatrix.elements;
      const vc = obj.vertCoords;
      const vertCount = vc.length / 3;

      // Pre-transform all vertices of this object once
      const tx = new Float32Array(vertCount);
      const ty = new Float32Array(vertCount);
      const tz = new Float32Array(vertCount);
      for (let v = 0; v < vertCount; v++) {
        const x = vc[v * 3], y = vc[v * 3 + 1], z = vc[v * 3 + 2];
        tx[v] = e[0] * x + e[4] * y + e[8] * z + e[12];
        ty[v] = e[1] * x + e[5] * y + e[9] * z + e[13];
        tz[v] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }

      const fallbackPartColor = slicerPalette[partIdxFallback % Math.max(1, slicerPalette.length)] || null;

      for (let t = 0; t < obj.tris.length; t++) {
        const tri = obj.tris[t];
        const a = new THREE.Vector3(tx[tri.v1], ty[tri.v1], tz[tri.v1]);
        const b = new THREE.Vector3(tx[tri.v2], ty[tri.v2], tz[tri.v2]);
        const c = new THREE.Vector3(tx[tri.v3], ty[tri.v3], tz[tri.v3]);

        let col = tri.color || fallbackPartColor;
        if (col && col.getHex() === 0xffffff && slicerPalette.length === 0) {
          col = null;
        }
        if (col) hasEmbeddedColors = true;

        finalTriangles.push({ a, b, c, color: col });
      }
    }

    obj.components.forEach((comp, idx) => {
      const nextMatrix = new THREE.Matrix4().multiplyMatrices(parentMatrix, comp.matrix);
      traverseObject(comp.docPath, comp.objectId, nextMatrix, partIdxFallback + idx);
    });
  }

  buildItems.forEach((item, idx) => {
    traverseObject(item.docPath, item.objectId, item.matrix, idx);
  });

  if (finalTriangles.length === 0) {
    throw new Error('Parsed 0 triangles from .3mf');
  }

  currentModelTriangles = finalTriangles;
  currentModelHasEmbeddedColors = hasEmbeddedColors;
  updateMulticolorUIState();
  syncFilamentMaterialMode();
  sliceCurrentModel();
}

// --- EXTRACT TRIANGLES FROM STL / THREE.JS MESH ---
function extractTrianglesFromGeometry(geometry, defaultRotationX = -Math.PI / 2) {
  const triangles = [];
  const baseRotMatrix = new THREE.Matrix4().makeRotationX(defaultRotationX);
  const posAttr = geometry.attributes.position;
  if (!posAttr) return;

  const isIndexed = geometry.index !== null;
  const triCount = isIndexed ? geometry.index.count / 3 : posAttr.count / 3;
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();

  for (let i = 0; i < triCount; i++) {
    const i0 = isIndexed ? geometry.index.getX(i * 3) : i * 3;
    const i1 = isIndexed ? geometry.index.getX(i * 3 + 1) : i * 3 + 1;
    const i2 = isIndexed ? geometry.index.getX(i * 3 + 2) : i * 3 + 2;

    vA.fromBufferAttribute(posAttr, i0).applyMatrix4(baseRotMatrix);
    vB.fromBufferAttribute(posAttr, i1).applyMatrix4(baseRotMatrix);
    vC.fromBufferAttribute(posAttr, i2).applyMatrix4(baseRotMatrix);

    triangles.push({
      a: vA.clone(),
      b: vB.clone(),
      c: vC.clone(),
      color: null
    });
  }

  currentModelTriangles = triangles;
  currentModelHasEmbeddedColors = false;
  updateMulticolorUIState();
  syncFilamentMaterialMode();
  sliceCurrentModel();
}

function updateMulticolorUIState() {
  const badge = document.getElementById('multicolorBadge');
  const use3mfGroup = document.getElementById('use3mfColorsGroup');
  if (currentModelHasEmbeddedColors) {
    badge.style.display = 'inline-block';
    use3mfGroup.style.display = 'flex';
  } else {
    badge.style.display = 'none';
    use3mfGroup.style.display = 'none';
  }
}

// --- FAST SPATIAL-BUCKET GEOMETRIC SLICER ---
function sliceCurrentModel() {
  if (!currentModelTriangles || currentModelTriangles.length === 0) return;

  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(appState.rotX),
    THREE.MathUtils.degToRad(appState.rotY),
    THREE.MathUtils.degToRad(appState.rotZ),
    'XYZ'
  );
  const rotQuat = new THREE.Quaternion().setFromEuler(euler);

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  const triCount = currentModelTriangles.length;
  const rotatedTris = new Array(triCount);

  for (let i = 0; i < triCount; i++) {
    const tri = currentModelTriangles[i];
    const a = tri.a.clone().applyQuaternion(rotQuat);
    const b = tri.b.clone().applyQuaternion(rotQuat);
    const c = tri.c.clone().applyQuaternion(rotQuat);

    minX = Math.min(minX, a.x, b.x, c.x);
    maxX = Math.max(maxX, a.x, b.x, c.x);
    minY = Math.min(minY, a.y, b.y, c.y);
    maxY = Math.max(maxY, a.y, b.y, c.y);
    minZ = Math.min(minZ, a.z, b.z, c.z);
    maxZ = Math.max(maxZ, a.z, b.z, c.z);

    rotatedTris[i] = { a, b, c, color: tri.color };
  }

  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  const maxDim = Math.max(sizeX, sizeY, sizeZ, 1e-4);

  const baseTargetSize = 95;
  const scaleFactor = (baseTargetSize / maxDim) * (appState.modelScale / 100);
  const centerX = (minX + maxX) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;

  const modelHeight = sizeY * scaleFactor;
  const numLayers = Math.max(1, Math.floor(modelHeight / LAYER_HEIGHT));

  // Build spatial Y-buckets so each layer only tests triangles intersecting that height
  const layerBuckets = Array.from({ length: numLayers }, () => []);

  for (let i = 0; i < triCount; i++) {
    const tri = rotatedTris[i];
    const a = new THREE.Vector3(
      (tri.a.x - centerX) * scaleFactor,
      (tri.a.y - minY) * scaleFactor,
      (tri.a.z - centerZ) * scaleFactor
    );
    const b = new THREE.Vector3(
      (tri.b.x - centerX) * scaleFactor,
      (tri.b.y - minY) * scaleFactor,
      (tri.b.z - centerZ) * scaleFactor
    );
    const c = new THREE.Vector3(
      (tri.c.x - centerX) * scaleFactor,
      (tri.c.y - minY) * scaleFactor,
      (tri.c.z - centerZ) * scaleFactor
    );

    const tMinY = Math.min(a.y, b.y, c.y);
    const tMaxY = Math.max(a.y, b.y, c.y);

    const startLayer = Math.max(0, Math.floor(tMinY / LAYER_HEIGHT - 0.5));
    const endLayer = Math.min(numLayers - 1, Math.ceil(tMaxY / LAYER_HEIGHT - 0.5));

    if (startLayer <= endLayer) {
      const scaledTri = { a, b, c, color: tri.color };
      for (let l = startLayer; l <= endLayer; l++) {
        layerBuckets[l].push(scaledTri);
      }
    }
  }

  const positions = [];
  const colors = [];
  toolpathPoints = [];
  layerStartIndices = [];

  const fallbackColor = new THREE.Color(appState.filamentColor);

  for (let l = 0; l < numLayers; l++) {
    const bucket = layerBuckets[l];
    if (bucket.length === 0) continue;

    const sliceY = (l + 0.5) * LAYER_HEIGHT;
    const rawSegObjs = [];

    for (let t = 0; t < bucket.length; t++) {
      const tri = bucket[t];
      const pts = [];
      intersectEdge(tri.a, tri.b, sliceY, pts);
      intersectEdge(tri.b, tri.c, sliceY, pts);
      intersectEdge(tri.c, tri.a, sliceY, pts);

      if (pts.length >= 2) {
        const segColor = tri.color || fallbackColor;
        rawSegObjs.push({ p1: pts[0], p2: pts[1], color: segColor });
      }
    }

    if (rawSegObjs.length === 0) continue;

    layerStartIndices.push({ layer: l + 1, segIndex: toolpathPoints.length });

    const orderedPerimeter = orderSegmentObjects(rawSegObjs);
    let subdividedInfill = [];

    if (isInfillEnabled) {
      const rawInfill = generateLayerInfill(rawSegObjs, sliceY, l, infillDensity, fallbackColor);
      if (rawInfill.length > 0) {
        const orderedInfill = orderSegmentObjects(rawInfill);
        for (const seg of orderedInfill) {
          subdividedInfill.push(...subdivideSegment(seg, 2.2));
        }
      }
    }

    const combined = [...orderedPerimeter, ...subdividedInfill];

    for (let k = 0; k < combined.length; k++) {
      const seg = combined[k];
      if (appendBeadTriangles(seg.p1, seg.p2, BEAD_RADIUS, seg.color, positions, colors)) {
        toolpathPoints.push({
          start: seg.p1,
          end: seg.p2,
          layer: l + 1
        });
      }
    }
  }

  if (printedMesh) {
    bedAssembly.remove(printedMesh);
    printedMesh.geometry.dispose();
  }

  const meshGeo = new THREE.BufferGeometry();
  meshGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  meshGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  meshGeo.computeVertexNormals();
  meshGeo.setDrawRange(0, 0);

  syncFilamentMaterialMode();

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

function orderSegmentObjects(segObjs) {
  const n = segObjs.length;
  const result = new Array(n);
  const used = new Uint8Array(n);
  let currentPos = segObjs[0].p1;
  let count = 0;

  for (let i = 0; i < n; i++) {
    let bestIdx = -1;
    let bestDist = Infinity;
    let flip = false;

    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const seg = segObjs[j];
      const dx0 = currentPos.x - seg.p1.x;
      const dz0 = currentPos.z - seg.p1.z;
      const d0 = dx0 * dx0 + dz0 * dz0;
      if (d0 < bestDist) {
        bestDist = d0;
        bestIdx = j;
        flip = false;
      }
      const dx1 = currentPos.x - seg.p2.x;
      const dz1 = currentPos.z - seg.p2.z;
      const d1 = dx1 * dx1 + dz1 * dz1;
      if (d1 < bestDist) {
        bestDist = d1;
        bestIdx = j;
        flip = true;
      }
    }

    if (bestIdx === -1) break;
    used[bestIdx] = 1;
    const chosen = segObjs[bestIdx];
    const seg = flip
      ? { p1: chosen.p2, p2: chosen.p1, color: chosen.color }
      : chosen;
    result[count++] = seg;
    currentPos = seg.p2;
  }

  result.length = count;
  return result;
}

function loadDefaultModel() {
  const geo = new THREE.TorusKnotGeometry(28, 9, 120, 20, 2, 3);
  extractTrianglesFromGeometry(geo, 0);
}

// --- .STL & .3MF FILE LOADING + PERSISTENCE ---
const stlLoader = new STLLoader();
const modelInput = document.getElementById('modelInput');

function loadModelFromBuffer(buffer, fileName, saveToStorage = true) {
  const lowerName = fileName.toLowerCase();

  try {
    if (lowerName.endsWith('.3mf')) {
      parse3MFBuffer(buffer);
    } else {
      const geometry = stlLoader.parse(buffer);
      extractTrianglesFromGeometry(geometry, -Math.PI / 2);
    }
  } catch (err) {
    console.error('Error loading model:', err);
    return;
  }

  if (saveToStorage) {
    try {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({
        name: fileName,
        data: btoa(binary)
      }));
    } catch (e) {
      // Ignore storage quota error if model file is very large
    }
  }
}

(function initInitialModel() {
  const savedRaw = localStorage.getItem(MODEL_STORAGE_KEY);
  if (savedRaw) {
    try {
      const parsed = JSON.parse(savedRaw);
      const binary = atob(parsed.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      loadModelFromBuffer(bytes.buffer, parsed.name || 'model.stl', false);
      return;
    } catch (e) {
      localStorage.removeItem(MODEL_STORAGE_KEY);
    }
  }
  loadDefaultModel();
})();

modelInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => loadModelFromBuffer(ev.target.result, file.name, true);
  reader.readAsArrayBuffer(file);
  e.target.value = '';
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.stl') || lower.endsWith('.3mf')) {
    const reader = new FileReader();
    reader.onload = (ev) => loadModelFromBuffer(ev.target.result, file.name, true);
    reader.readAsArrayBuffer(file);
  }
});

// --- UI TABS & PANEL TOGGLE ---
const uiContainer = document.getElementById('ui-container');
const toggleUiBtn = document.getElementById('toggleUiBtn');
const closeUiBtn = document.getElementById('closeUiBtn');

toggleUiBtn.addEventListener('click', () => {
  const isCollapsed = uiContainer.classList.toggle('collapsed');
  toggleUiBtn.classList.toggle('active', !isCollapsed);
});

closeUiBtn.addEventListener('click', () => {
  uiContainer.classList.add('collapsed');
  toggleUiBtn.classList.remove('active');
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.getAttribute('data-tab')).classList.add('active');
  });
});

// --- FIX COLOR PICKER FOCUS IN WALLPAPER ENGINE ---
document.querySelectorAll('input[type="color"]').forEach(colorEl => {
  colorEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    window.focus();
  });
  colorEl.addEventListener('click', (e) => {
    e.stopPropagation();
    window.focus();
  });
});

// --- CAMERA LOCK & ANALOG JOYSTICKS ---
const playPauseBtn = document.getElementById('playPauseBtn');
const nightModeBtn = document.getElementById('nightModeBtn');
const lockCameraBtn = document.getElementById('lockCameraBtn');
const cameraControlsWrapper = document.getElementById('camera-controls-wrapper');
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
zoomInBtn.addEventListener('pointerup', () => { joyInput.zoomVel = 0; scheduleCameraSave(); });
zoomInBtn.addEventListener('pointerleave', () => { joyInput.zoomVel = 0; });

zoomOutBtn.addEventListener('pointerdown', () => { if (!isCameraLocked) joyInput.zoomVel = 1; });
zoomOutBtn.addEventListener('pointerup', () => { joyInput.zoomVel = 0; scheduleCameraSave(); });
zoomOutBtn.addEventListener('pointerleave', () => { joyInput.zoomVel = 0; });

document.querySelectorAll('#tab-camera button[data-cam]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isCameraLocked) return;
    applyCameraPreset(btn.getAttribute('data-cam'));
  });
});

function setCameraLocked(locked, persist = true) {
  isCameraLocked = locked;
  appState.lockCamera = locked;
  controls.enabled = !locked;
  lockCameraToggle.checked = locked;

  if (locked) {
    controls.autoRotate = false;
    joyInput.orbitX = joyInput.orbitY = joyInput.panX = joyInput.panY = joyInput.zoomVel = 0;
    lockCameraBtn.textContent = '🔒 Locked';
    lockCameraBtn.classList.add('locked-active');
    cameraControlsWrapper.classList.add('pad-locked');
    autoRotateGroup.classList.add('disabled');
    rotateSpeedGroup.classList.add('disabled');
  } else {
    controls.autoRotate = autoRotateToggle.checked;
    lockCameraBtn.textContent = '🔓 Free';
    lockCameraBtn.classList.remove('locked-active');
    cameraControlsWrapper.classList.remove('pad-locked');
    autoRotateGroup.classList.remove('disabled');
    rotateSpeedGroup.classList.toggle('disabled', !autoRotateToggle.checked);
  }

  if (persist) saveSettings();
}

lockCameraBtn.addEventListener('click', () => setCameraLocked(!isCameraLocked, true));
lockCameraToggle.addEventListener('change', (e) => setCameraLocked(e.target.checked, true));

// --- CUSTOMIZATION & MODEL TRANSFORM CONTROLS ---
const filamentInput = document.getElementById('filamentColor');
const use3mfColorsToggle = document.getElementById('use3mfColorsToggle');
const infillToggle = document.getElementById('infillToggle');
const infillDensityGroup = document.getElementById('infillDensityGroup');
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

const modelScaleSlider = document.getElementById('modelScaleSlider');
const modelScaleVal = document.getElementById('modelScaleVal');
const rotXSlider = document.getElementById('rotXSlider');
const rotXVal = document.getElementById('rotXVal');
const rotYSlider = document.getElementById('rotYSlider');
const rotYVal = document.getElementById('rotYVal');
const rotZSlider = document.getElementById('rotZSlider');
const rotZVal = document.getElementById('rotZVal');

function reslicePreservingProgress() {
  if (!currentModelTriangles || currentModelTriangles.length === 0) return;
  const prevProgress = totalSegments > 0 ? currentSegmentFloat / totalSegments : 0;
  sliceCurrentModel();
  currentSegmentFloat = prevProgress * totalSegments;
}

function setInfillEnabled(enabled, persist = true) {
  isInfillEnabled = enabled;
  appState.enableInfill = enabled;
  infillToggle.checked = enabled;
  infillDensityGroup.classList.toggle('disabled', !enabled);
  reslicePreservingProgress();
  if (persist) saveSettings();
}

function updateSpeed(newSpeed, persist = true) {
  printSpeed = Math.max(0, newSpeed);
  appState.printSpeed = printSpeed;
  if (printSpeed > 0) {
    lastNonZeroSpeed = printSpeed;
    playPauseBtn.textContent = '⏸️ Pause';
  } else {
    playPauseBtn.textContent = '▶️ Resume';
  }
  speedSlider.value = printSpeed;
  speedVal.textContent = `${printSpeed.toFixed(1)}x`;
  if (persist) saveSettings();
}

// Instant O(1) GPU filament color update without re-slicing
function setFilamentColorHex(hex, persist = true) {
  appState.filamentColor = hex;
  filamentInput.value = hex;
  syncFilamentMaterialMode();
  if (persist) saveSettings();
}

function setPrinterColorHex(hex, persist = true) {
  appState.printerColor = hex;
  printerInput.value = hex;
  chassisMaterial.color.set(hex);
  if (persist) saveSettings();
}

function setBgColorHex(hex, persist = true) {
  userBgColor = hex;
  appState.bgColor = hex;
  bgInput.value = hex;
  if (!isNightMode) {
    scene.background.set(userBgColor);
    scene.fog.color.set(userBgColor);
  }
  if (persist) saveSettings();
}

function setReverseLoop(enabled, persist = true) {
  isReverseLoop = enabled;
  appState.reverseLoop = enabled;
  reverseLoopToggle.checked = enabled;
  if (!isReverseLoop) printDirection = 1;
  if (persist) saveSettings();
}

function setAutoRotate(enabled, persist = true) {
  appState.autoRotate = enabled;
  autoRotateToggle.checked = enabled;
  if (!isCameraLocked) {
    controls.autoRotate = enabled;
  }
  rotateSpeedGroup.classList.toggle('disabled', !enabled);
  if (persist) saveSettings();
}

function setRotateSpeed(val, persist = true) {
  appState.rotateSpeed = val;
  controls.autoRotateSpeed = val;
  rotateSpeedSlider.value = val;
  rotateSpeedVal.textContent = val.toFixed(1);
  if (persist) saveSettings();
}

function updateTransformUI() {
  modelScaleSlider.value = appState.modelScale;
  modelScaleVal.textContent = `${appState.modelScale}%`;
  rotXSlider.value = appState.rotX;
  rotXVal.textContent = `${appState.rotX}°`;
  rotYSlider.value = appState.rotY;
  rotYVal.textContent = `${appState.rotY}°`;
  rotZSlider.value = appState.rotZ;
  rotZVal.textContent = `${appState.rotZ}°`;
}

function wrapAngleDeg(deg) {
  let a = ((deg + 180) % 360 + 360) % 360 - 180;
  return a === -180 && deg > 0 ? 180 : a;
}

(function applySavedStateOnBoot() {
  use3mfColorsToggle.checked = appState.use3mfColors;
  setFilamentColorHex(appState.filamentColor, false);
  setPrinterColorHex(appState.printerColor, false);
  setChassisOpacity(appState.chassisOpacity, false);
  setBgColorHex(appState.bgColor, false);
  infillSlider.value = appState.infillDensity;
  infillVal.textContent = `${appState.infillDensity}%`;
  setInfillEnabled(appState.enableInfill, false);
  updateSpeed(appState.printSpeed, false);
  setNightMode(appState.nightMode, false);
  setReverseLoop(appState.reverseLoop, false);
  setAutoRotate(appState.autoRotate, false);
  setRotateSpeed(appState.rotateSpeed, false);
  setCameraLocked(appState.lockCamera, false);
  updateTransformUI();
})();

playPauseBtn.addEventListener('click', () => {
  if (printSpeed > 0) {
    updateSpeed(0, true);
  } else {
    updateSpeed(lastNonZeroSpeed || 1.0, true);
  }
});

nightModeBtn.addEventListener('click', () => setNightMode(!isNightMode, true));
nightModeToggle.addEventListener('change', (e) => setNightMode(e.target.checked, true));

reverseLoopToggle.addEventListener('change', (e) => setReverseLoop(e.target.checked, true));

filamentInput.addEventListener('input', (e) => setFilamentColorHex(e.target.value, true));

use3mfColorsToggle.addEventListener('change', (e) => {
  use3mfColors = e.target.checked;
  appState.use3mfColors = use3mfColors;
  syncFilamentMaterialMode();
  saveSettings();
});

infillToggle.addEventListener('change', (e) => setInfillEnabled(e.target.checked, true));

infillSlider.addEventListener('input', (e) => {
  infillDensity = parseInt(e.target.value, 10);
  appState.infillDensity = infillDensity;
  infillVal.textContent = `${infillDensity}%`;
  if (isInfillEnabled) {
    reslicePreservingProgress();
  }
  saveSettings();
});

printerInput.addEventListener('input', (e) => setPrinterColorHex(e.target.value, true));

chassisOpacitySlider.addEventListener('input', (e) => {
  setChassisOpacity(parseFloat(e.target.value), true);
});

bgInput.addEventListener('input', (e) => setBgColorHex(e.target.value, true));

speedSlider.addEventListener('input', (e) => {
  updateSpeed(parseFloat(e.target.value), true);
});

autoRotateToggle.addEventListener('change', (e) => setAutoRotate(e.target.checked, true));

rotateSpeedSlider.addEventListener('input', (e) => {
  setRotateSpeed(parseFloat(e.target.value), true);
});

modelScaleSlider.addEventListener('input', (e) => {
  appState.modelScale = parseInt(e.target.value, 10);
  updateTransformUI();
  reslicePreservingProgress();
  saveSettings();
});

rotXSlider.addEventListener('input', (e) => {
  appState.rotX = parseInt(e.target.value, 10);
  updateTransformUI();
  reslicePreservingProgress();
  saveSettings();
});

rotYSlider.addEventListener('input', (e) => {
  appState.rotY = parseInt(e.target.value, 10);
  updateTransformUI();
  reslicePreservingProgress();
  saveSettings();
});

rotZSlider.addEventListener('input', (e) => {
  appState.rotZ = parseInt(e.target.value, 10);
  updateTransformUI();
  reslicePreservingProgress();
  saveSettings();
});

document.getElementById('rotX90Btn').addEventListener('click', () => {
  appState.rotX = wrapAngleDeg(appState.rotX + 90);
  updateTransformUI();
  reslicePreservingProgress();
  saveSettings();
});

document.getElementById('rotZ90Btn').addEventListener('click', () => {
  appState.rotZ = wrapAngleDeg(appState.rotZ + 90);
  updateTransformUI();
  reslicePreservingProgress();
  saveSettings();
});

document.getElementById('resetTransformBtn').addEventListener('click', () => {
  appState.modelScale = 100;
  appState.rotX = 0;
  appState.rotY = 0;
  appState.rotZ = 0;
  updateTransformUI();
  reslicePreservingProgress();
  saveSettings();
});

// --- WALLPAPER ENGINE INTEGRATION ---
function weColorToHex(weColorString) {
  const rgb = weColorString.split(' ').map(Number);
  return '#' + new THREE.Color(rgb[0], rgb[1], rgb[2]).getHexString();
}

window.wallpaperPropertyListener = {
  applyUserProperties: function (properties) {
    if (properties.showwebmenu !== undefined) {
      const show = properties.showwebmenu.value;
      toggleUiBtn.classList.toggle('hidden-completely', !show);
      if (!show) {
        uiContainer.classList.add('collapsed');
        toggleUiBtn.classList.remove('active');
      }
    }

    const isDuringBootBurst = (performance.now() - BOOT_TIMESTAMP) < 1500;
    if (isDuringBootBurst && hasPersistedSettings()) {
      return;
    }

    if (properties.nightmode !== undefined) {
      setNightMode(properties.nightmode.value, true);
    }
    if (properties.reverseloop !== undefined) {
      setReverseLoop(properties.reverseloop.value, true);
    }
    if (properties.lockcamera !== undefined) {
      setCameraLocked(properties.lockcamera.value, true);
    }
    if (properties.filamentcolor) {
      setFilamentColorHex(weColorToHex(properties.filamentcolor.value), true);
    }
    if (properties.enableinfill !== undefined) {
      setInfillEnabled(properties.enableinfill.value, true);
    }
    if (properties.infilldensity !== undefined) {
      infillDensity = properties.infilldensity.value;
      appState.infillDensity = infillDensity;
      infillSlider.value = infillDensity;
      infillVal.textContent = `${infillDensity}%`;
      if (isInfillEnabled) reslicePreservingProgress();
      saveSettings();
    }
    if (properties.printercolor) {
      setPrinterColorHex(weColorToHex(properties.printercolor.value), true);
    }
    if (properties.chassisopacity !== undefined) {
      setChassisOpacity(properties.chassisopacity.value, true);
    }
    if (properties.bgcolor) {
      setBgColorHex(weColorToHex(properties.bgcolor.value), true);
    }
    if (properties.printspeed !== undefined) {
      updateSpeed(properties.printspeed.value, true);
    }
    if (properties.autorotate !== undefined) {
      setAutoRotate(properties.autorotate.value, true);
    }
    if (properties.rotatespeed) {
      setRotateSpeed(properties.rotatespeed.value, true);
    }
  }
};

// --- ANIMATION LOOP ---
const layerInfoEl = document.getElementById('layerInfo');
const progressInfoEl = document.getElementById('progressInfo');

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
  scheduleCameraSave();
}

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.1);

  if (totalSegments > 0 && printedMesh) {
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
    gantryYAssembly.position.y = BED_SURFACE_Y + tipY + 20;

    const totalLayers = layerStartIndices.length;
    const pct = Math.floor((segIdx / totalSegments) * 100);
    const dirSymbol = printDirection === -1 ? ' ⏪' : '';
    layerInfoEl.textContent = `Layer: ${currentSeg.layer} / ${totalLayers}${dirSymbol}`;
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
