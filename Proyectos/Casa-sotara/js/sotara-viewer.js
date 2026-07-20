// Casa Sótara (Casa en Río Frío) — Visor 3D · APG Studio
// Requiere el importmap de "three" definido en index.html
//
// Diferencia clave respecto al visor de Casa Weiss: aquí el modelo NO viene
// en un único .glb con grupos internos nombrados (CUBIERTA, MUROS, etc.).
// Viene ya separado por el usuario en varios archivos .glb independientes
// (muros.glb, cubiertas.glb, puertasyventanas.glb, lote.glb, arboles.glb),
// todos exportados desde el mismo modelo de SketchUp y por lo tanto
// compartiendo el mismo sistema de coordenadas — no hace falta reencuadrar
// cada archivo por separado como sí había que hacer con el lote.glb de Casa
// Weiss.
//
// pisos.glb ya NO se carga: los acabados de piso reales del proyecto viven
// dentro de muros.glb (así quedó exportado desde SketchUp) y priman sobre
// cualquier geometría de piso duplicada en pisos.glb, así que esa capa se
// quitó por completo del visor para no arrastrar un archivo redundante.
//
// Los .glb de este proyecto llegaron sin optimizar (SketchUp exporta un
// material distinto por instancia): arboles.glb pesaba ~91 MB. Se
// reprocesaron con gltf-transform (dedup + palette + join + weld + meshopt +
// texturas a WebP) antes de subirlos aquí. arboles.glb quedó en ~21 MB —
// sigue siendo el archivo más pesado con diferencia, así que se carga bajo
// demanda (lazy) solo cuando el usuario activa la capa "Árboles", en vez de
// sumarlo a la carga inicial.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ─── Capas / archivos ───
// "house": se cargan siempre, de entrada, y su caja delimitadora conjunta
// es la que se usa para encuadrar la cámara inicial.
// "lote": terreno/topografía — se carga de entrada pero no participa en el
// encuadre de cámara (solo da contexto alrededor de la casa).
// "arboles": el archivo pesado — se carga solo la primera vez que se activa
// el botón de esa capa.
const HOUSE_LAYERS = [
  { key: 'cubiertas', url: 'cubiertas.glb', label: 'Cubiertas' },
  { key: 'muros', url: 'muros.glb', label: 'Muros' },
  { key: 'puertasyventanas', url: 'puertasyventanas.glb', label: 'Puertas y ventanas' },
];
const LOTE_LAYER = { key: 'lote', url: 'lote.glb', label: 'Lote' };
const TREES_LAYER = { key: 'arboles', url: 'arboles.glb', label: 'Árboles' };

// ─── Árboles perimetrales (generados proceduralmente) ───
// arboles.glb es un único macizo de follaje instanciado (2583 fragmentos en
// 15 sub-mallas vía EXT_mesh_gpu_instancing) de apenas ~32×34 m junto al
// acceso — confirmado inspeccionando el archivo directamente. No cubre el
// resto del lote.
//
// lote.glb sí trae el contorno real del predio: se extrajo directamente de
// los nodos de borde del archivo (no de la imagen de referencia, que es una
// foto aérea sin punto de registro fiable contra el modelo 3D) un polígono
// de ~140.44 × 260.21 m — perímetro ≈801 m.
//
// En vez de forzar precisión que no se tiene calcando la foto, se distribuye
// aquí una franja arbolada perimetral ligera —estilo "seto"— a lo largo de
// ese contorno real, vía instancing (barato en GPU, sin archivo adicional
// que descargar). El macizo original de arboles.glb se conserva tal cual
// junto al acceso.
const LOT_BOUNDS = { minX: -47.66, maxX: 92.78, minZ: -191.24, maxZ: 68.97 };
const PERIMETER_INSET = 3.5; // metros hacia adentro desde el lindero
const PERIMETER_SPACING = 3.2; // separación media entre árboles
const PERIMETER_JITTER = 0.9; // variación aleatoria de posición
const PERIMETER_GROUND_Y = 0.9; // nivel de terreno aproximado en ese borde (+2m respecto al valor anterior, para que no queden enterrados)
// ─── Franja perimetral: varias filas ───
// El plano de referencia (planta de localización) muestra el cinturón
// arbolado del lindero como una franja gruesa de varias filas de copas
// traslapadas, no una sola línea de árboles — se agregan filas paralelas,
// escalonadas entre sí (como un aparejo de ladrillo) para un aspecto denso
// y orgánico similar al del plano, en vez de líneas rectas mecánicas.
const PERIMETER_ROWS = 3;
const PERIMETER_ROW_SPACING = 2.4; // separación entre filas, hacia adentro
// Hueco aproximado para el acceso vehicular (curva de entrada visible en la
// planta de localización, lado norte). Es una estimación — ajusta estos
// valores si no coincide con la posición real de la entrada.
const ACCESS_GAP = { edge: 'north', from: 33, to: 62 };

// ─── Detección de móvil / GPU limitada ───
// Ver nota equivalente en el visor de Casa Weiss: en móviles de gama media,
// demasiadas luces simultáneas pueden hacer fallar la compilación del
// shader y dejar mallas invisibles. Se reduce el rig de luces y sombras ahí.
const isMobile =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
  window.innerWidth < 768;

// ─── DOM refs ───
const host = document.getElementById('csCanvasHost');
const canvas = document.getElementById('csCanvas');
const loaderEl = document.getElementById('csLoader');
const loaderPctEl = document.getElementById('csLoaderPct');
const fallbackEl = document.getElementById('csFallback');

const resetBtn = document.getElementById('csResetView');
const autorotateBtn = document.getElementById('csToggleAutorotate');
const autorotateLabel = document.getElementById('csAutorotateLabel');
const wireBtn = document.getElementById('csToggleWire');
const wireLabel = document.getElementById('csWireLabel');
const layerButtons = document.querySelectorAll('.cs-layer-btn[data-layer]');
const hintEl = document.getElementById('csHint');
const DEFAULT_HINT = hintEl ? hintEl.textContent : '';

function normalizeName(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .toUpperCase()
    .trim();
}

// key -> Object3D raíz de esa capa (o null si aún no ha cargado)
const layerRoots = {};

function setLayerVisible(key, visible) {
  const root = layerRoots[key];
  if (root) root.visible = visible;
}

function markLayerUnavailable(key, reason) {
  const btn = document.querySelector(`.cs-layer-btn[data-layer="${key}"]`);
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add('is-unavailable');
  btn.classList.remove('is-active');
  btn.title = reason || 'No se encontró este archivo';
}

// ─── Scene setup ───
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a3632); // fondo cálido neutro, no compite con el ladrillo

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
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = !isMobile;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ─── Entorno (IBL) ───
// Antes los materiales tenían envMapIntensity fijado pero la escena no
// tenía ningún scene.environment asignado, así que ese valor no hacía
// nada: toda la "luz" venía de sumar cada vez más luces direccionales
// planas (ambient + hemi + key + fill + frontFill + sideFill + topFill),
// lo que aplanaba el relieve de las bóvedas de ladrillo y sobreexponía
// la escena (exposure 1.9). Un mapa de entorno real da reflejos y luz
// ambiental físicamente coherente con muchas menos luces "de relleno".
const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
pmremGenerator.dispose();

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
// Tabio, Cundinamarca (≈ 4.92°N, 74.10°O). Cerca del ecuador el sol pasa
// casi cenital todo el año, así que en vez de replicar una fecha/hora real
// se usa una posición de "media mañana" que valoriza bien las bóvedas de
// ladrillo (luz rasante lateral en vez de un cenital plano que aplana el
// relieve de las bóvedas).
const SUN_ELEVATION_DEG = 42;
const SUN_AZIMUTH_DEG = 100;
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

// ─── Lights ───
// Antes había 7 luces sumadas (ambient + hemi + key + fill + frontFill +
// sideFill + topFill) casi todas de relleno omnidireccional a intensidad
// alta: entre eso y el exposure a 1.9, el resultado era una escena
// sobreexpuesta y sin contraste, que es justo lo contrario de lo que
// buscaban los comentarios de más abajo (luz rasante que valorice el
// relieve de las bóvedas). Con el entorno IBL ya aportando una base de
// luz ambiental/reflejos coherente, basta con: una luz ambiental muy
// suave, el hemisferio (tinte cielo/suelo) y el sol como única fuente
// direccional fuerte + un contraluz azulado tenue para que las sombras
// no queden completamente negras.
const ambient = new THREE.AmbientLight(0xe8ecf4, isMobile ? 0.35 : 0.25);
scene.add(ambient);

const hemi = new THREE.HemisphereLight(0xb8d4f0, 0x8a6f58, isMobile ? 0.9 : 0.75);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffe3bd, isMobile ? 2.6 : 3.2);
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
  key.shadow.radius = 2.5; // suaviza el borde de sombra (PCFSoftShadowMap)
}
scene.add(key);

// Contraluz frío (rebote de cielo) del lado opuesto al sol, tenue: evita
// que las caras en sombra queden completamente negras sin aplanar el
// relieve como hacían las luces de relleno anteriores.
const fill = new THREE.DirectionalLight(0x9fc6ff, isMobile ? 0.5 : 0.6);
fill.position.set(-sunPos.x, 8, -sunPos.z);
scene.add(fill);

// Ground plane, por si algún borde del terreno real (lote.glb) queda corto
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.ShadowMaterial({ opacity: 0.18 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02;
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
// Todas las capas comparten el mismo sistema de coordenadas de origen
// (SketchUp), así que se cuelgan del mismo grupo y se recentran juntas una
// sola vez, cuando termina de cargar la "casa" (muros+cubiertas+puertas y
// ventanas). Lote y árboles heredan automáticamente ese mismo offset.
const worldRoot = new THREE.Group();
scene.add(worldRoot);
let worldRecentered = false;
let houseMaxDim = 40; // valor de respaldo hasta que la casa termine de cargar

// ─── Loader / DRACO ───
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');

const manager = new THREE.LoadingManager();
// (Ya no se usa manager.onProgress para el %: itemsLoaded/itemsTotal cuenta
// ARCHIVOS terminados, no bytes, así que con solo 5 archivos el % saltaba a
// trompicones —y sobre todo se quedaba "pegado" mientras el archivo más
// pesado terminaba de bajar, dando sensación de que la carga se congeló.
// Se reemplaza por progreso real en bytes vía onProgress por archivo, ver
// housePctFromProgress() más abajo. Además lote.glb deja de bloquear el
// loader por completo — ver init().)

const loader = new GLTFLoader(manager);
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

// Progreso en bytes de las 4 capas de la casa (las únicas que bloquean el
// loader). Cada archivo reporta su propio loaded/total vía onProgress del
// XHR; se suman para un % agregado y real, en vez del conteo de items.
const houseByteProgress = {};
function updateHouseLoaderPct() {
  let loaded = 0;
  let total = 0;
  Object.values(houseByteProgress).forEach((p) => {
    loaded += p.loaded;
    total += p.total;
  });
  if (total > 0) {
    const pct = Math.min(100, Math.round((loaded / total) * 100));
    loaderPctEl.textContent = ` ${pct}%`;
  }
}

function buildPerimeterTrees() {
  const points = [];
  const walk = (x0, z0, x1, z1, skip, phase = 0) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.round(len / PERIMETER_SPACING));
    for (let i = 0; i <= steps; i++) {
      const t = (i + phase) / steps;
      if (t < -0.001 || t > 1.001) continue;
      const x = x0 + dx * t;
      const z = z0 + dz * t;
      if (skip && skip(x, z)) continue;
      points.push({
        x: x + (Math.random() - 0.5) * PERIMETER_JITTER,
        z: z + (Math.random() - 0.5) * PERIMETER_JITTER,
      });
    }
  };

  const skipNorth = (x, z) =>
    ACCESS_GAP.edge === 'north' && x >= ACCESS_GAP.from && x <= ACCESS_GAP.to;

  for (let row = 0; row < PERIMETER_ROWS; row++) {
    const inset = PERIMETER_INSET + row * PERIMETER_ROW_SPACING;
    const inner = {
      minX: LOT_BOUNDS.minX + inset,
      maxX: LOT_BOUNDS.maxX - inset,
      minZ: LOT_BOUNDS.minZ + inset,
      maxZ: LOT_BOUNDS.maxZ - inset,
    };
    // Filas alternas arrancan medio paso desfasadas, para que las copas se
    // traslapen entre filas en vez de quedar alineadas en cuadrícula.
    const phase = (row % 2) * 0.5;

    walk(inner.minX, inner.minZ, inner.maxX, inner.minZ, null, phase); // borde sur
    walk(inner.maxX, inner.minZ, inner.maxX, inner.maxZ, null, phase); // borde este
    walk(inner.maxX, inner.maxZ, inner.minX, inner.maxZ, skipNorth, phase); // borde norte
    walk(inner.minX, inner.maxZ, inner.minX, inner.minZ, null, phase); // borde oeste
  }

  const count = points.length;
  if (!count) return null;

  const group = new THREE.Group();
  group.name = 'arboles-perimetro';

  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1.6, 6);
  trunkGeo.translate(0, 0.8, 0);
  const canopyGeo = new THREE.IcosahedronGeometry(1.15, 1);

  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x3b2f22,
    roughness: 0.95,
    metalness: 0,
  });
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x5b6b45,
    roughness: 0.85,
    metalness: 0,
    flatShading: true,
  });

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, count);
  trunks.castShadow = true;
  canopies.castShadow = true;
  canopies.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const canopyColor = new THREE.Color();
  points.forEach((p, i) => {
    const scale = 0.85 + Math.random() * 0.55;
    const rotY = Math.random() * Math.PI * 2;

    dummy.position.set(p.x, PERIMETER_GROUND_Y, p.z);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);

    dummy.position.set(p.x, PERIMETER_GROUND_Y + 1.6 * scale, p.z);
    dummy.updateMatrix();
    canopies.setMatrixAt(i, dummy.matrix);
    canopyColor.setHSL(0.27 + Math.random() * 0.05, 0.28, 0.24 + Math.random() * 0.08);
    canopies.setColorAt(i, canopyColor);
  });
  trunks.instanceMatrix.needsUpdate = true;
  canopies.instanceMatrix.needsUpdate = true;
  if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;

  group.add(trunks, canopies);
  return group;
}

function recenterWorld(box) {
  const center = new THREE.Vector3();
  box.getCenter(center);
  worldRoot.position.set(-center.x, -center.y, -center.z);
  worldRoot.updateMatrixWorld(true);
}

function frameCameraOnHouse(box) {
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 10;
  houseMaxDim = maxDim;

  // ─── Vista inicial: cerca del acceso, encuadre diagonal elevado ───
  // Igual que en Casa Weiss: una toma "de presentación", cercana, mostrando
  // la casa completa (cubiertas, muros, patios) sin recortarla, en vez de
  // una vista aérea lejana. Sin geometría con nombre para detectar el punto
  // exacto del primer patio/rampa de acceso, se usa un encuadre diagonal
  // genérico centrado en la casa; ajusta initialCameraPos/initialTarget
  // abajo con la ayuda de la tecla "C" (ver bloque de ajuste manual) una vez
  // que identifiques visualmente el ángulo exacto de acceso que quieres.
  const VIEW_DIST_FACTOR = isMobile ? 1.05 : 0.78;
  const viewDist = maxDim * VIEW_DIST_FACTOR;
  initialCameraPos = new THREE.Vector3(
    viewDist * 1.05,
    viewDist * 0.4,
    viewDist * 0.7
  );
  initialTarget = new THREE.Vector3(0, size.y * 0.15, 0);

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

function updateLayerButtonState(key, { unavailable = false, active = null } = {}) {
  const btn = document.querySelector(`.cs-layer-btn[data-layer="${key}"]`);
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

// ─── Carga inicial ───
// Antes el loader esperaba a la casa Y a lote.glb (con diferencia el
// archivo más pesado) antes de mostrar nada: el usuario se quedaba
// mirando el % "pegado" mientras ese archivo grande terminaba de bajar,
// sin ninguna señal de que en realidad sí seguía progresando.
//
// Ahora: lote.glb arranca su descarga YA (en paralelo con la casa, misma
// conexión, no pierde tiempo), pero su promesa NO bloquea el loader — la
// casa (muros+cubiertas+puertas y ventanas, ~2 MB en total) es lo
// único que hace falta para mostrar el visor y encuadrar la cámara. El
// lote aparece solo, en segundo plano, en cuanto termina.
const lotePromise = loadLayer(LOTE_LAYER);

async function init() {
  const results = await Promise.all(
    HOUSE_LAYERS.map((def) =>
      loadLayer(def, (evt) => {
        if (!evt.lengthComputable) return;
        houseByteProgress[def.key] = { loaded: evt.loaded, total: evt.total };
        updateHouseLoaderPct();
      })
    )
  );

  const houseBox = new THREE.Box3();
  let houseHasGeometry = false;

  results.forEach(({ ok, def, root }) => {
    if (!ok) {
      updateLayerButtonState(def.key, { unavailable: true });
      return;
    }
    root.updateMatrixWorld(true);
    houseBox.union(new THREE.Box3().setFromObject(root));
    houseHasGeometry = true;
  });

  if (!houseHasGeometry) {
    showFallback(new Error('No se pudo cargar ninguna de las capas de la casa (muros, cubiertas, puertas y ventanas).'));
    return;
  }

  // Recentra el mundo (casa + lote + árboles, que comparten coordenadas)
  // usando el centro de la CASA, no del lote — así el encuadre queda
  // centrado en la vivienda y no en medio del terreno circundante. Lote y
  // árboles, aunque lleguen después, heredan este mismo offset por ser
  // hijos de worldRoot.
  recenterWorld(houseBox);

  const recenteredHouseBox = new THREE.Box3();
  HOUSE_LAYERS.forEach((def) => {
    const root = layerRoots[def.key];
    if (root) recenteredHouseBox.union(new THREE.Box3().setFromObject(root));
  });
  frameCameraOnHouse(recenteredHouseBox);

  HOUSE_LAYERS.forEach((def) => {
    if (layerRoots[def.key]) updateLayerButtonState(def.key, { active: true });
  });
  const treesBtn = document.querySelector('.cs-layer-btn[data-layer="arboles"]');
  if (treesBtn) {
    treesBtn.disabled = false;
    treesBtn.classList.remove('is-unavailable');
  }

  // Árboles perimetrales (procedurales): visibles desde el primer render,
  // ya que no dependen de ningún archivo adicional.
  const perimeterTrees = buildPerimeterTrees();
  if (perimeterTrees) {
    perimeterTrees.visible = true;
    worldRoot.add(perimeterTrees);
    layerRoots['arboles-perimetro'] = perimeterTrees;
  }

  // ─── Árboles: activos por defecto ───
  // El botón "Árboles" arranca marcado como activo y su archivo se
  // dispara en segundo plano apenas termina de encuadrarse la casa, sin
  // bloquear el loader. Así el visitante ve el lote arbolado desde la
  // primera vista, sin tener que pulsar el botón.
  if (treesBtn) treesBtn.classList.add('is-active');
  ensureTreesLoaded().then((result) => {
    if (!result.ok) return;
    setLayerVisible('arboles', true);
    setLayerVisible('arboles-perimetro', true);
  });

  hideLoader();
  fallbackEl.hidden = true;
  fallbackEl.style.display = 'none';

  // ─── Lote: llega en segundo plano ───
  // El botón queda deshabilitado con texto "Cargando…" mientras tanto (lo
  // más probable es que, al haber arrancado su descarga a la vez que la
  // casa, ya esté listo o casi listo para cuando el usuario llegue aquí).
  const loteBtn = document.querySelector('.cs-layer-btn[data-layer="lote"]');
  if (loteBtn) {
    loteBtn.disabled = true;
    loteBtn.classList.remove('is-unavailable');
    loteBtn.textContent = 'Cargando…';
  }
  if (hintEl) hintEl.textContent = 'Cargando terreno en segundo plano…';

  lotePromise.then((result) => {
    if (loteBtn) loteBtn.textContent = 'Lote';
    if (hintEl) hintEl.textContent = DEFAULT_HINT;
    if (!result.ok) {
      updateLayerButtonState('lote', { unavailable: true });
      return;
    }
    worldRoot.updateMatrixWorld(true);
    if (wireframeOn) applyWireframe(result.root, true);
    updateLayerButtonState('lote', { active: true });
  });
}

init();

// ─── Carga perezosa de árboles ───
let treesLoadPromise = null;
function ensureTreesLoaded() {
  if (treesLoadPromise) return treesLoadPromise;
  const btn = document.querySelector('.cs-layer-btn[data-layer="arboles"]');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Cargando…';
  }
  treesLoadPromise = loadLayer(TREES_LAYER).then((result) => {
    if (btn) btn.textContent = originalLabel;
    if (!result.ok) {
      updateLayerButtonState('arboles', { unavailable: true });
      return result;
    }
    // No hace falta reposicionar result.root: al ser hijo de worldRoot,
    // hereda automáticamente el mismo offset de recentrado que ya se aplicó
    // a la casa y al lote (los tres archivos comparten coordenadas de origen).
    worldRoot.updateMatrixWorld(true);
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-unavailable');
    }
    if (wireframeOn) applyWireframe(result.root, true);
    return result;
  });
  return treesLoadPromise;
}

// ─── Botones de capas ───
layerButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    const key = btn.dataset.layer;

    if (key === 'arboles' && !layerRoots.arboles) {
      btn.classList.add('is-active'); // feedback optimista mientras carga
      await ensureTreesLoaded();
      if (!layerRoots.arboles) return; // falló la carga
      setLayerVisible('arboles', true);
      setLayerVisible('arboles-perimetro', true);
      return;
    }

    const nowActive = !btn.classList.contains('is-active');
    btn.classList.toggle('is-active', nowActive);
    setLayerVisible(key, nowActive);
    if (key === 'arboles') setLayerVisible('arboles-perimetro', nowActive);
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
    let detail = document.getElementById('csFallbackDetail');
    if (!detail) {
      detail = document.createElement('pre');
      detail.id = 'csFallbackDetail';
      detail.className = 'cs-fallback-detail';
      fallbackEl.appendChild(detail);
    }
    const message =
      (error && (error.message || error.target?.statusText || String(error))) ||
      'Error desconocido';
    detail.textContent = message;
  }
}

// ─── Ajuste fino manual temporal (BORRA este bloque cuando ya tengas el
// encuadre inicial final) ───
// Navega con el mouse (OrbitControls) hasta encontrar el punto de vista
// exacto que quieres como vista inicial (p. ej. la cercanía al acceso del
// primer patio), y presiona la tecla "C" (con el canvas enfocado, haz clic
// sobre él primero) para imprimir en consola las coordenadas exactas de
// camera.position y controls.target — cópialas directo a
// initialCameraPos / initialTarget dentro de frameCameraOnHouse() arriba.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'c' && e.key !== 'C') return;
  console.log(
    '[VISTA INICIAL] camera.position:',
    camera.position.toArray(),
    '— controls.target:',
    controls.target.toArray()
  );
});

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
  const trigger = item.querySelector('.cs-acc-trigger');
  trigger.addEventListener('click', () => {
    const isOpen = item.classList.contains('is-open');
    accItems.forEach((i) => i.classList.remove('is-open'));
    if (!isOpen) item.classList.add('is-open');
  });
});
