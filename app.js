import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

// --- CONFIGURACIÓN GENERAL ---
const BED_SIZE = 160;
const BUILD_HEIGHT = 150;
const LAYER_HEIGHT = 0.45;

let printSpeed = 1.0;
let currentSegmentFloat = 0;
let totalSegments = 0;
let layerStartIndices = [];
let toolpathPoints = [];
let isLooping = true;
let isCameraLocked = false;

// --- ESCENA, CÁMARA Y RENDERER ---
const canvas = document.getElementById('canvas3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d0f14');
scene.fog = new THREE.FogExp2('#0d0f14', 0.0016);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 1500);
camera.position.set(220, 190, 240);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.enableZoom = true;
controls.rotateSpeed = 0.45;
controls.zoomSpeed = 0.85;
controls.panSpeed = 0.7;
controls.minDistance = 80;
controls.maxDistance = 650;
controls.target.set(0, 65, 0);
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;

canvas.addEventListener('pointerdown', () => {
  window.focus();
});

// --- ILUMINACIÓN ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.3);
dirLight.position.set(150, 260, 180);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 1024;
dirLight.shadow.mapSize.height = 1024;
scene.add(dirLight);

const rimLight = new THREE.DirectionalLight(0x6699ff, 0.45);
rimLight.position.set(-160, 120, -140);
scene.add(rimLight);

// --- MATERIALES DINÁMICOS ---
const chassisMaterial = new THREE.MeshStandardMaterial({
  color: '#242730',
  roughness: 0.45,
  metalness: 0.65,
  transparent: true,
  opacity: 1.0,
  depthWrite: true
});

const railMaterial = new THREE.MeshStandardMaterial({
  color: '#9aa0ac',
  roughness: 0.25,
  metalness: 0.85,
  transparent: true,
  opacity: 1.0
});

const bedMaterial = new THREE.MeshStandardMaterial({
  color: '#181a20',
  roughness: 0.7,
  metalness: 0.2
});

const filamentMaterial = new THREE.LineBasicMaterial({
  color: '#00a8ff',
  linewidth: 2
});

function setChassisOpacity(alpha) {
  const val = Math.max(0.05, Math.min(1.0, alpha));
  chassisMaterial.opacity = val;
  chassisMaterial.depthWrite = val > 0.85;
  chassisMaterial.needsUpdate = true;

  railMaterial.opacity = Math.max(0.25, val);
  railMaterial.depthWrite = val > 0.85;
  railMaterial.needsUpdate = true;
}

// --- CONSTRUCCIÓN DE LA IMPRESORA COREXY ---
const printerGroup = new THREE.Group();
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
    pillar.castShadow = true;
    printerGroup.add(pillar);
  });

  const beamXGeo = new THREE.BoxGeometry(frameW + pillarSize, pillarSize, pillarSize);
  const beamZGeo = new THREE.BoxGeometry(pillarSize, pillarSize, frameW + pillarSize);

  [pillarSize / 2, frameH - pillarSize / 2].forEach(y => {
    [-frameW / 2, frameW / 2].forEach(pos => {
      const bx = new THREE.Mesh(beamXGeo, chassisMaterial);
      bx.position.set(0, y, pos);
      printerGroup.add(bx);

      const bz = new THREE.Mesh(beamZGeo, chassisMaterial);
      bz.position.set(pos, y, 0);
      printerGroup.add(bz);
    });
  });

  const yRailGeo = new THREE.CylinderGeometry(2.5, 2.5, frameW - 10, 12);
  yRailGeo.rotateX(Math.PI / 2);
  [-frameW / 2 + 12, frameW / 2 - 12].forEach(x => {
    const rail = new THREE.Mesh(yRailGeo, railMaterial);
    rail.position.set(x, frameH - 18, 0);
    printerGroup.add(rail);
  });
}

buildPrinter();

// Grupo Cama Caliente
const bedAssembly = new THREE.Group();
const bedPlate = new THREE.Mesh(new THREE.BoxGeometry(BED_SIZE, 4, BED_SIZE), bedMaterial);
bedPlate.position.y = -2;
bedPlate.receiveShadow = true;
bedAssembly.add(bedPlate);

const bedGrid = new THREE.GridHelper(BED_SIZE, 16, 0x3a4052, 0x262a36);
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

const heatsink = new THREE.Mesh(
  new THREE.CylinderGeometry(6, 6, 14, 16),
  new THREE.MeshStandardMaterial({ color: '#c0392b', metalness: 0.7, roughness: 0.3 })
);
heatsink.position.y = -6;
toolhead.add(heatsink);

const nozzle = new THREE.Mesh(
  new THREE.ConeGeometry(3.2, 7, 16).rotateX(Math.PI),
  new THREE.MeshStandardMaterial({ color: '#f1c40f', metalness: 0.9, roughness: 0.2 })
);
nozzle.position.y = -16.5;
toolhead.add(nozzle);

const nozzleLight = new THREE.PointLight('#ff9933', 1.8, 45);
nozzleLight.position.set(0, -18, 0);
toolhead.add(nozzleLight);

gantryBridge.add(toolhead);

let printedLinesMesh = null;

// --- SLICER GEOMÉTRICO EN JAVASCRIPT ---
function sliceGeometry(rawGeometry) {
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
  const vertices = [];
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
    const ordered = orderSegments(rawSegments);

    ordered.forEach(([p1, p2]) => {
      vertices.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      toolpathPoints.push({
        start: p1,
        end: p2,
        layer: l + 1
      });
    });
  }

  if (printedLinesMesh) {
    bedAssembly.remove(printedLinesMesh);
    printedLinesMesh.geometry.dispose();
  }

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  lineGeo.setDrawRange(0, 0);

  printedLinesMesh = new THREE.LineSegments(lineGeo, filamentMaterial);
  bedAssembly.add(printedLinesMesh);

  totalSegments = toolpathPoints.length;
  currentSegmentFloat = 0;
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

// --- SISTEMA DE BLOQUEO Y CONTROL DE CÁMARA ---
const quickActions = document.getElementById('quick-actions');
const lockCameraBtn = document.getElementById('lockCameraBtn');
const toggleCameraPadBtn = document.getElementById('toggleCameraPadBtn');
const cameraPad = document.getElementById('camera-pad');
const closeCameraPadBtn = document.getElementById('closeCameraPadBtn');
const lockCameraToggle = document.getElementById('lockCameraToggle');
const autoRotateGroup = document.getElementById('autoRotateGroup');
const autoRotateToggle = document.getElementById('autoRotateToggle');
const rotateSpeedGroup = document.getElementById('rotateSpeedGroup');

function setCameraLocked(locked) {
  isCameraLocked = locked;
  controls.enabled = !locked;
  lockCameraToggle.checked = locked;

  if (locked) {
    controls.autoRotate = false;
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

toggleCameraPadBtn.addEventListener('click', () => {
  cameraPad.classList.toggle('collapsed');
});

closeCameraPadBtn.addEventListener('click', () => {
  cameraPad.classList.add('collapsed');
});

function executeCameraAction(action) {
  if (isCameraLocked) return;

  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  const panStep = 14;
  const rotStep = 0.14;

  // Calcular ejes derecha y arriba de la cámara de forma segura
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  switch (action) {
    case 'orbit-left':
      spherical.theta += rotStep;
      offset.setFromSpherical(spherical);
      camera.position.copy(controls.target).add(offset);
      break;
    case 'orbit-right':
      spherical.theta -= rotStep;
      offset.setFromSpherical(spherical);
      camera.position.copy(controls.target).add(offset);
      break;
    case 'orbit-up':
      spherical.phi = Math.max(0.15, spherical.phi - rotStep);
      offset.setFromSpherical(spherical);
      camera.position.copy(controls.target).add(offset);
      break;
    case 'orbit-down':
      spherical.phi = Math.min(Math.PI - 0.15, spherical.phi + rotStep);
      offset.setFromSpherical(spherical);
      camera.position.copy(controls.target).add(offset);
      break;

    case 'pan-left':
      controls.target.addScaledVector(right, -panStep);
      camera.position.addScaledVector(right, -panStep);
      break;
    case 'pan-right':
      controls.target.addScaledVector(right, panStep);
      camera.position.addScaledVector(right, panStep);
      break;
    case 'pan-up':
      controls.target.addScaledVector(up, panStep);
      camera.position.addScaledVector(up, panStep);
      break;
    case 'pan-down':
      controls.target.addScaledVector(up, -panStep);
      camera.position.addScaledVector(up, -panStep);
      break;
    case 'pan-center':
      controls.target.set(0, 65, 0);
      break;

    case 'zoom-in':
      spherical.radius = Math.max(controls.minDistance, spherical.radius * 0.88);
      offset.setFromSpherical(spherical);
      camera.position.copy(controls.target).add(offset);
      break;
    case 'zoom-out':
      spherical.radius = Math.min(controls.maxDistance, spherical.radius * 1.14);
      offset.setFromSpherical(spherical);
      camera.position.copy(controls.target).add(offset);
      break;

    case 'view-front':
      controls.target.set(0, 75, 0);
      camera.position.set(0, 85, 310);
      break;
    case 'view-iso':
    case 'reset':
      controls.target.set(0, 65, 0);
      camera.position.set(220, 190, 240);
      break;
    case 'view-top':
      controls.target.set(0, 50, 0);
      camera.position.set(0, 340, 25);
      break;
  }
  controls.update();
}

let holdInterval = null;
document.querySelectorAll('#camera-pad button[data-cam]').forEach(btn => {
  const action = btn.getAttribute('data-cam');
  const startHold = () => {
    executeCameraAction(action);
    clearInterval(holdInterval);
    holdInterval = setInterval(() => executeCameraAction(action), 70);
  };
  const stopHold = () => clearInterval(holdInterval);

  btn.addEventListener('pointerdown', startHold);
  btn.addEventListener('pointerup', stopHold);
  btn.addEventListener('pointerleave', stopHold);
});

// --- MOSTRAR / OCULTAR PANEL DE CONFIGURACIÓN ---
const uiContainer = document.getElementById('ui-container');
const toggleUiBtn = document.getElementById('toggleUiBtn');
const closeUiBtn = document.getElementById('closeUiBtn');

toggleUiBtn.addEventListener('click', () => uiContainer.classList.toggle('collapsed'));
closeUiBtn.addEventListener('click', () => uiContainer.classList.add('collapsed'));

// --- CONTROLES DE PERSONALIZACIÓN ---
const filamentInput = document.getElementById('filamentColor');
const printerInput = document.getElementById('printerColor');
const chassisOpacitySlider = document.getElementById('chassisOpacitySlider');
const chassisOpacityVal = document.getElementById('chassisOpacityVal');
const bgInput = document.getElementById('bgColor');
const speedSlider = document.getElementById('speedSlider');
const speedVal = document.getElementById('speedVal');
const rotateSpeedSlider = document.getElementById('rotateSpeedSlider');
const rotateSpeedVal = document.getElementById('rotateSpeedVal');

filamentInput.addEventListener('input', (e) => filamentMaterial.color.set(e.target.value));
printerInput.addEventListener('input', (e) => chassisMaterial.color.set(e.target.value));

chassisOpacitySlider.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  setChassisOpacity(val);
  chassisOpacityVal.textContent = `${Math.round(val * 100)}%`;
});

bgInput.addEventListener('input', (e) => {
  scene.background.set(e.target.value);
  scene.fog.color.set(e.target.value);
});

speedSlider.addEventListener('input', (e) => {
  printSpeed = parseFloat(e.target.value);
  speedVal.textContent = `${printSpeed.toFixed(1)}x`;
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
    if (properties.lockcamera !== undefined) {
      setCameraLocked(properties.lockcamera.value);
    }
    if (properties.filamentcolor) {
      const c = weColorToThree(properties.filamentcolor.value);
      filamentMaterial.color.copy(c);
      filamentInput.value = '#' + c.getHexString();
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
      scene.background.copy(c);
      scene.fog.color.copy(c);
      bgInput.value = '#' + c.getHexString();
    }
    if (properties.printspeed) {
      printSpeed = properties.printspeed.value;
      speedSlider.value = printSpeed;
      speedVal.textContent = `${printSpeed.toFixed(1)}x`;
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

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.1);

  if (totalSegments > 0 && printedLinesMesh) {
    const segmentsPerSecond = Math.max(40, totalSegments * 0.04) * printSpeed;
    currentSegmentFloat += segmentsPerSecond * dt;

    if (currentSegmentFloat >= totalSegments) {
      if (isLooping) {
        currentSegmentFloat = 0;
      } else {
        currentSegmentFloat = totalSegments - 1;
      }
    }

    const segIdx = Math.floor(currentSegmentFloat);
    const frac = currentSegmentFloat - segIdx;
    const currentSeg = toolpathPoints[segIdx];

    printedLinesMesh.geometry.setDrawRange(0, (segIdx + 1) * 2);

    const tipX = THREE.MathUtils.lerp(currentSeg.start.x, currentSeg.end.x, frac);
    const tipY = currentSeg.start.y;
    const tipZ = THREE.MathUtils.lerp(currentSeg.start.z, currentSeg.end.z, frac);

    gantryBridge.position.z = tipZ;
    toolhead.position.x = tipX;
    bedAssembly.position.y = nozzleTipHeight - tipY;

    const totalLayers = layerStartIndices.length;
    const pct = Math.floor((segIdx / totalSegments) * 100);
    layerInfoEl.textContent = `Capa: ${currentSeg.layer} / ${totalLayers}`;
    progressInfoEl.textContent = `${pct}%`;
  }

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
