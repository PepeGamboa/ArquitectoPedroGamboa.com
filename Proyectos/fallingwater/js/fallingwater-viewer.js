// Fallingwater (Casa de la Cascada) — Frank Lloyd Wright · Visor 3D · APG Studio
// Requiere el importmap de "three" definido en index.html
//
// Igual que Casa Sotará, el modelo llega separado en varios archivos .glb
// independientes en vez de un único .glb con grupos internos nombrados:
// cubierta.glb, muros.glb, carpinterias.glb, pisos.glb, pisos2.glb,
// contexto.glb, cascada.glb y arboles.glb — los ocho exportados desde el
// mismo modelo de SketchUp y comparten sistema de coordenadas. Cada uno
// tiene su propio botón en el panel de capas (ver LAYERS más abajo).
//
// La separación por capas se hizo de forma automática a partir de los
// materiales originales (muros, carpinterías y cascada) y, para las
// superficies con material genérico sin nombre útil, con un criterio
// geométrico: caras horizontales sin nada por encima → cubierta; caras
// horizontales cubiertas por otra losa → pisos; caras verticales → muros.
// Ningún archivo pesa lo suficiente (el más grande, muros.glb, ronda
// 470 KB) como para justificar carga diferida: las seis se piden en
// paralelo y bloquean el loader juntas.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// ─── Capas / archivos ───
// Igual que en Casa Sotará (casa vs. lote), aquí se distingue "casa"
// (cubierta+muros+carpinterias+pisos) de "sitio" (contexto+cascada) SOLO
// para efectos del encuadre inicial de cámara: contexto.glb trae elementos
// de sitio muy extendidos (terreno, referencias aéreas) que, si entraran
// en el cálculo de la caja delimitadora, obligarían a la cámara a alejarse
// mucho para abarcarlo todo, dejando la casa diminuta en el centro del
// encuadre. Las 8 capas se cargan y se muestran igual desde el inicio —
// solo cambia qué geometría se usa para calcular dónde poner la cámara.
const HOUSE_LAYERS = [
  { key: 'cubierta', url: 'cubierta.glb', label: 'Cubierta' },
  { key: 'muros', url: 'muros.glb', label: 'Muros' },
  { key: 'carpinterias', url: 'carpinterias.glb', label: 'Carpinterías' },
  { key: 'pisos', url: 'pisos.glb', label: 'Pisos' },
  { key: 'pisos2', url: 'pisos2.glb', label: 'Pisos 2' },
];
const SITE_LAYERS = [
  { key: 'contexto', url: 'contexto.glb', label: 'Contexto' },
  { key: 'cascada', url: 'cascada.glb', label: 'Cascada' },
  { key: 'arboles', url: 'arboles.glb', label: 'Árboles' },
];
const LAYERS = [...HOUSE_LAYERS, ...SITE_LAYERS];

// contexto.glb trae, por un error en la exportación desde SketchUp, piezas
// de piso duplicadas que en realidad pertenecen a pisos.glb. Un primer
// intento las excluyó por nombre de nodo, pero la pieza grande (la losa
// con el hueco y la escalera) resultó venir de otro nodo sin identificar
// a simple vista. En vez de adivinar nombres, la detección se hace en
// tiempo real en removeContextoDuplicatesOfPisos() (más abajo): una vez
// cargadas ambas capas, se compara la caja delimitadora de cada malla de
// "contexto" contra las de "pisos" con la geometría ya descomprimida por
// el navegador, y se oculta cualquier pieza de contexto que se solape con
// una pieza real de pisos y tenga un volumen comparable (así no se
// confunde con el terreno, que envuelve toda la zona de la casa).

// ─── Detección de móvil / GPU limitada ───
const isMobile =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
  window.innerWidth < 768;

// ─── DOM refs ───
const host = document.getElementById('fwCanvasHost');
const canvas = document.getElementById('fwCanvas');
const loaderEl = document.getElementById('fwLoader');
const loaderPctEl = document.getElementById('fwLoaderPct');
const fallbackEl = document.getElementById('fwFallback');

const resetBtn = document.getElementById('fwResetView');
const autorotateBtn = document.getElementById('fwToggleAutorotate');
const autorotateLabel = document.getElementById('fwAutorotateLabel');
const wireBtn = document.getElementById('fwToggleWire');
const wireLabel = document.getElementById('fwWireLabel');
const layerButtons = document.querySelectorAll('.fw-layer-btn[data-layer]');
const hintEl = document.getElementById('fwHint');

// key -> Object3D raíz de esa capa (o null si aún no ha cargado)
const layerRoots = {};

function setLayerVisible(key, visible) {
  const root = layerRoots[key];
  if (root) root.visible = visible;
}

// ─── Scene setup ───
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a3a36); // mismo fondo que Casa Weiss

const camera = new THREE.PerspectiveCamera(
  45,
  host.clientWidth / host.clientHeight,
  0.1,
  1000
);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 2.2; // igual que Casa Weiss: iluminación general más alta
renderer.shadowMap.enabled = !isMobile;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  console.error('Contexto WebGL perdido');
  showFallback(new Error('Se perdió el contexto WebGL (posible falta de memoria de GPU en este dispositivo).'));
});

function sizeRenderer() {
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
sizeRenderer();
requestAnimationFrame(sizeRenderer);

// ─── Posición solar ───
// Mismo criterio que Casa Weiss: mañana, luz cálida rasante.
const SUN_ELEVATION_DEG = 26;
const SUN_AZIMUTH_DEG = 80;
const NORTH_OFFSET_DEG = 0; // ← gira esto si el Norte del modelo no coincide

function sunDirectionFromAngles(elevationDeg, azimuthDeg, northOffsetDeg = 0) {
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const az = THREE.MathUtils.degToRad(azimuthDeg + northOffsetDeg);
  const dist = 50;
  return new THREE.Vector3(
    dist * Math.cos(el) * Math.sin(az),
    dist * Math.sin(el),
    -dist * Math.cos(el) * Math.cos(az)
  );
}

// ─── Lights (mismo rig que Casa Weiss: sol cálido + relleno general fuerte) ───
// En móvil se usan menos luces y sin sombra dinámica, por el mismo motivo
// que en Casa Weiss: demasiadas luces simultáneas pueden superar el límite
// de uniforms del shader en GPUs de gama media y dejar la casa invisible.
const ambient = new THREE.AmbientLight(0xe4ecf8, isMobile ? 1.6 : 1.1);
scene.add(ambient);

const hemi = new THREE.HemisphereLight(0xb8d4f0, 0x8a7d64, isMobile ? 2.2 : 1.9);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffdca8, 3.4);
const sunPos = sunDirectionFromAngles(SUN_ELEVATION_DEG, SUN_AZIMUTH_DEG, NORTH_OFFSET_DEG);
key.position.copy(sunPos);
key.castShadow = !isMobile;
if (!isMobile) {
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 120;
  key.shadow.camera.left = -30;
  key.shadow.camera.right = 30;
  key.shadow.camera.top = 30;
  key.shadow.camera.bottom = -30;
  key.shadow.bias = -0.0005;
}
scene.add(key);

const fill = new THREE.DirectionalLight(0x9fc6ff, 2.1);
fill.position.set(-sunPos.x, 10, -sunPos.z);
scene.add(fill);

const frontFill = new THREE.DirectionalLight(0xffffff, 1.6);
frontFill.position.set(0, 12, 25);
scene.add(frontFill);

if (!isMobile) {
  const sideFill = new THREE.DirectionalLight(0xffffff, 1.2);
  sideFill.position.set(-25, 10, 0);
  scene.add(sideFill);

  const topFill = new THREE.DirectionalLight(0xffffff, 0.9);
  topFill.position.set(5, 30, 5);
  scene.add(topFill);
}

// Ground plane
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.ShadowMaterial({ opacity: 0.2 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
ground.receiveShadow = true;
scene.add(ground);

// ─── Controls ───
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2;
controls.maxDistance = 300;
controls.maxPolarAngle = Math.PI / 2 + 0.15;
controls.autoRotate = false;
controls.autoRotateSpeed = 1.2;

let initialCameraPos = new THREE.Vector3(20, 14, 20);
let initialTarget = new THREE.Vector3(0, 0, 0);
camera.position.copy(initialCameraPos);
controls.target.copy(initialTarget);
controls.update();

// ─── Raíz común del mundo ───
const worldRoot = new THREE.Group();
scene.add(worldRoot);

// ─── Loader / DRACO ───
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);
loader.setMeshoptDecoder(MeshoptDecoder);

function loadLayer(def, onProgress) {
  return new Promise((resolve) => {
    loader.load(
      def.url,
      (gltf) => {
        const root = gltf.scene;
        root.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
              if (m && 'roughness' in m) m.envMapIntensity = 1.15;
            });
          }
        });
        worldRoot.add(root);
        layerRoots[def.key] = root;
        resolve({ ok: true, def, root });
      },
      onProgress,
      (error) => {
        console.error(`Error cargando ${def.url}:`, error);
        resolve({ ok: false, def, error });
      }
    );
  });
}

// Progreso en bytes agregado de las 8 capas
const byteProgress = {};
function updateLoaderPct() {
  let loaded = 0;
  let total = 0;
  Object.values(byteProgress).forEach((p) => {
    loaded += p.loaded;
    total += p.total;
  });
  if (total > 0) {
    const pct = Math.min(100, Math.round((loaded / total) * 100));
    loaderPctEl.textContent = ` ${pct}%`;
  }
}

function recenterWorld(box) {
  const center = new THREE.Vector3();
  box.getCenter(center);
  worldRoot.position.set(-center.x, -center.y, -center.z);
  worldRoot.updateMatrixWorld(true);
}

// Recorre un root y devuelve sus mallas (nodos con geometría propia),
// ignorando los grupos/contenedores intermedios que no aportan una caja
// delimitadora útil por sí mismos.
function collectMeshes(root) {
  const meshes = [];
  root.traverse((obj) => {
    if (obj.isMesh) meshes.push(obj);
  });
  return meshes;
}

// Dos cajas se consideran "la misma pieza" si se solapan Y además tienen
// un volumen comparable. Solo pedir solape no basta: el terreno de
// contexto.glb envuelve toda la zona donde está la casa, así que su caja
// delimitadora también se solaparía con la de cualquier piso sin ser un
// duplicado real.
function boxesLookLikeDuplicates(boxA, boxB) {
  if (!boxA.intersectsBox(boxB)) return false;
  const sizeA = new THREE.Vector3();
  const sizeB = new THREE.Vector3();
  boxA.getSize(sizeA);
  boxB.getSize(sizeB);
  const volA = Math.max(sizeA.x * sizeA.y * sizeA.z, 1e-6);
  const volB = Math.max(sizeB.x * sizeB.y * sizeB.z, 1e-6);
  const ratio = volA > volB ? volA / volB : volB / volA;
  return ratio < 6;
}

// Oculta en "Contexto" cualquier malla que sea, en la práctica, la misma
// pieza que ya existe en "Pisos" o "Pisos 2". Se hace en tiempo real (no
// por nombre de nodo) porque la geometría de estos .glb viene comprimida
// con Draco: solo se puede comparar de forma confiable una vez el
// navegador ya la descomprimió, y así el criterio sigue funcionando aunque
// cambien los nombres de los nodos en una futura re-exportación.
function removeContextoDuplicatesOfPisos() {
  const contextoRoot = layerRoots.contexto;
  const pisosRoot = layerRoots.pisos;
  const pisos2Root = layerRoots.pisos2;
  if (!contextoRoot || (!pisosRoot && !pisos2Root)) return;

  contextoRoot.updateMatrixWorld(true);
  if (pisosRoot) pisosRoot.updateMatrixWorld(true);
  if (pisos2Root) pisos2Root.updateMatrixWorld(true);

  const pisosBoxes = [
    ...(pisosRoot ? collectMeshes(pisosRoot) : []),
    ...(pisos2Root ? collectMeshes(pisos2Root) : []),
  ]
    .map((mesh) => new THREE.Box3().setFromObject(mesh))
    .filter((box) => !box.isEmpty());
  if (!pisosBoxes.length) return;

  const toRemove = [];
  collectMeshes(contextoRoot).forEach((mesh) => {
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) return;
    if (pisosBoxes.some((pisoBox) => boxesLookLikeDuplicates(box, pisoBox))) {
      toRemove.push(mesh);
    }
  });

  toRemove.forEach((mesh) => {
    console.info(
      `[Fallingwater] Ocultando en "Contexto" una pieza duplicada de "Pisos": ${mesh.name || '(sin nombre)'}`
    );
    if (mesh.parent) mesh.parent.remove(mesh);
  });
}

function frameCameraOnModel(box) {
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 10;

  // ─── Vista inicial ───
  // Vista frontal y relativamente cercana (a la altura de la casa, con la
  // cascada en primer plano), en vez del encuadre aéreo/diagonal anterior.
  // VIEW_DIR es una dirección normalizada desde el centro del modelo hacia
  // la cámara; VIEW_DIST_FACTOR controla qué tan lejos queda respecto al
  // tamaño del modelo. Si no calza exacto con la vista que quieres:
  // 1) abre el visor en el navegador, 2) orbita/haz zoom a mano hasta la
  // posición deseada, 3) abre la consola (F12) y ejecuta `logFwCamera()`
  // — esa función queda expuesta más abajo e imprime los valores exactos
  // de VIEW_DIR / VIEW_DIST_FACTOR / target para pegar aquí.
  const VIEW_DIST_FACTOR = isMobile ? 1.0 : 0.62;
  const VIEW_DIR = new THREE.Vector3(0.32, 0.2, 1.0).normalize();
  const viewDist = maxDim * VIEW_DIST_FACTOR;
  initialCameraPos = new THREE.Vector3(
    VIEW_DIR.x * viewDist,
    VIEW_DIR.y * viewDist,
    VIEW_DIR.z * viewDist
  );
  initialTarget = new THREE.Vector3(0, size.y * 0.12, size.z * 0.05);

  camera.position.copy(initialCameraPos);
  camera.near = maxDim / 100;
  camera.far = maxDim * 25;
  camera.updateProjectionMatrix();

  controls.target.copy(initialTarget);
  controls.minDistance = maxDim * 0.12;
  controls.maxDistance = maxDim * 8;
  controls.update();

  ground.scale.setScalar(Math.max(4, maxDim / 15));
}

// ─── Ayuda de consola para calibrar la vista inicial ───
// Ejecuta `logFwCamera()` en la consola del navegador (F12) después de
// orbitar/zoom manualmente a la vista deseada. Imprime valores listos
// para copiar dentro de frameCameraOnModel().
window.logFwCamera = function () {
  const p = camera.position;
  const t = controls.target;
  const dist = p.distanceTo(new THREE.Vector3(0, 0, 0));
  console.log('[Fallingwater] Posición cámara:', { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) });
  console.log('[Fallingwater] Target:', { x: +t.x.toFixed(3), y: +t.y.toFixed(3), z: +t.z.toFixed(3) });
  console.log('[Fallingwater] Distancia al centro (~viewDist):', +dist.toFixed(3));
};

function updateLayerButtonState(key, { unavailable = false, active = null } = {}) {
  const btn = document.querySelector(`.fw-layer-btn[data-layer="${key}"]`);
  if (!btn) return;
  if (unavailable) {
    btn.disabled = true;
    btn.classList.add('is-unavailable');
    btn.classList.remove('is-active');
    btn.title = 'No se pudo cargar este archivo';
    return;
  }
  btn.disabled = false;
  btn.classList.remove('is-unavailable');
  if (active !== null) btn.classList.toggle('is-active', active);
}

// ─── Carga inicial: las 8 capas en paralelo ───
async function init() {
  const results = await Promise.all(
    LAYERS.map((def) =>
      loadLayer(def, (evt) => {
        if (!evt.lengthComputable) return;
        byteProgress[def.key] = { loaded: evt.loaded, total: evt.total };
        updateLoaderPct();
      })
    )
  );

  const houseBox = new THREE.Box3();
  let hasGeometry = false;
  let houseHasGeometry = false;
  const houseKeys = new Set(HOUSE_LAYERS.map((d) => d.key));

  results.forEach(({ ok, def, root }) => {
    if (!ok) {
      updateLayerButtonState(def.key, { unavailable: true });
      return;
    }
    root.updateMatrixWorld(true);
    hasGeometry = true;
    if (houseKeys.has(def.key)) {
      houseBox.union(new THREE.Box3().setFromObject(root));
      houseHasGeometry = true;
    }
  });

  if (!hasGeometry) {
    showFallback(new Error('No se pudo cargar ninguna de las 8 capas (cubierta, muros, carpinterias, pisos, pisos2, contexto, cascada, arboles).'));
    return;
  }

  // Antes de encuadrar la cámara: oculta en "Contexto" cualquier pieza que
  // resulte ser la misma losa ya presente en "Pisos".
  removeContextoDuplicatesOfPisos();

  // Recentrar y encuadrar SOLO con la casa (cubierta+muros+carpinterias+
  // pisos): contexto y cascada, si entraran en este cálculo, dispararían
  // el tamaño de la caja delimitadora y forzarían un encuadre muy lejano.
  // Si por lo que sea la casa no cargó pero sí el sitio, se usa el sitio
  // como respaldo para no dejar la cámara en un punto arbitrario.
  const boxForFraming = houseHasGeometry ? houseBox : new THREE.Box3().setFromObject(worldRoot);
  recenterWorld(boxForFraming);

  const recenteredHouseBox = new THREE.Box3();
  HOUSE_LAYERS.forEach((def) => {
    const root = layerRoots[def.key];
    if (root) recenteredHouseBox.union(new THREE.Box3().setFromObject(root));
  });
  frameCameraOnModel(houseHasGeometry ? recenteredHouseBox : boxForFraming);

  LAYERS.forEach((def) => {
    if (layerRoots[def.key]) updateLayerButtonState(def.key, { active: true });
  });

  hideLoader();
  fallbackEl.hidden = true;
  fallbackEl.style.display = 'none';
}

init();

// ─── Botones de capas ───
layerButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const key = btn.dataset.layer;
    const nowActive = !btn.classList.contains('is-active');
    btn.classList.toggle('is-active', nowActive);
    setLayerVisible(key, nowActive);
  });
});

function hideLoader() {
  loaderEl.hidden = true;
  loaderEl.style.display = 'none';
}

function showFallback(error) {
  loaderEl.hidden = true;
  loaderEl.style.display = 'none';
  fallbackEl.hidden = false;
  fallbackEl.style.display = 'flex';

  if (error) {
    let detail = document.getElementById('fwFallbackDetail');
    if (!detail) {
      detail = document.createElement('pre');
      detail.id = 'fwFallbackDetail';
      detail.className = 'fw-fallback-detail';
      fallbackEl.appendChild(detail);
    }
    const message =
      (error && (error.message || error.target?.statusText || String(error))) ||
      'Error desconocido';
    detail.textContent = message;
  }
}

// ─── Controls: buttons ───
resetBtn.addEventListener('click', () => {
  controls.autoRotate = false;
  autorotateBtn.classList.remove('is-active');
  autorotateLabel.textContent = 'Rotación auto';

  camera.position.copy(initialCameraPos);
  controls.target.copy(initialTarget);
  controls.update();
});

autorotateBtn.addEventListener('click', () => {
  controls.autoRotate = !controls.autoRotate;
  autorotateBtn.classList.toggle('is-active', controls.autoRotate);
  autorotateLabel.textContent = controls.autoRotate
    ? 'Detener rotación'
    : 'Rotación auto';
});

let wireframeOn = false;
function applyWireframe(root, on) {
  if (!root) return;
  root.traverse((child) => {
    if (child.isMesh && child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => (m.wireframe = on));
    }
  });
}

wireBtn.addEventListener('click', () => {
  wireframeOn = !wireframeOn;
  wireBtn.classList.toggle('is-active', wireframeOn);
  wireLabel.textContent = wireframeOn ? 'Modo sólido' : 'Modo alambre';
  Object.values(layerRoots).forEach((root) => applyWireframe(root, wireframeOn));
});

// ─── Resize ───
window.addEventListener('resize', sizeRenderer);
new ResizeObserver(sizeRenderer).observe(host);

// ─── Animate ───
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ─── Accordion ───
const accItems = document.querySelectorAll('[data-acc]');
accItems.forEach((item) => {
  const trigger = item.querySelector('.fw-acc-trigger');
  trigger.addEventListener('click', () => {
    const isOpen = item.classList.contains('is-open');
    accItems.forEach((i) => i.classList.remove('is-open'));
    if (!isOpen) item.classList.add('is-open');
  });
});
