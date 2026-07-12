// Casa Weiss — Visor 3D · APG Studio
// Requiere el importmap de "three" definido en index.html

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MODEL_URL = 'weiss-optimized.glb';

// ─── DOM refs ───
const host = document.getElementById('whCanvasHost');
const canvas = document.getElementById('whCanvas');
const loaderEl = document.getElementById('whLoader');
const loaderPctEl = document.getElementById('whLoaderPct');
const fallbackEl = document.getElementById('whFallback');

const resetBtn = document.getElementById('whResetView');
const autorotateBtn = document.getElementById('whToggleAutorotate');
const autorotateLabel = document.getElementById('whAutorotateLabel');
const wireBtn = document.getElementById('whToggleWire');
const wireLabel = document.getElementById('whWireLabel');

// ─── Scene setup ───
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a3a36); // fondo un poco más claro para no "comerse" las fachadas oscuras

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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 2.2; // subido: iluminación general más alta
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

function sizeRenderer() {
  const w = host.clientWidth;
  const h = host.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
sizeRenderer();

// ─── Posición solar real ───
// 2935 Whitehall Road, East Norriton, PA (40.13°N, 75.36°O)
// 21 de junio (verano), 8:00 a.m. hora local (EDT)
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

// ─── Lights (sol real de la mañana + relleno general fuerte) ───
const ambient = new THREE.AmbientLight(0xe4ecf8, 1.1); // subido de 0.85 → 1.1
scene.add(ambient);

const hemi = new THREE.HemisphereLight(0xb8d4f0, 0x8a7d64, 1.9); // subido de 1.5 → 1.9, rebote de tierra más claro
scene.add(hemi);

// Sol principal (cálido, mañana de verano)
const key = new THREE.DirectionalLight(0xffdca8, 3.4); // subido de 3.0 → 3.4
const sunPos = sunDirectionFromAngles(SUN_ELEVATION_DEG, SUN_AZIMUTH_DEG, NORTH_OFFSET_DEG);
key.position.copy(sunPos);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 120;
key.shadow.camera.left = -30;
key.shadow.camera.right = 30;
key.shadow.camera.top = 30;
key.shadow.camera.bottom = -30;
key.shadow.bias = -0.0005;
scene.add(key);

// Relleno frío desde el lado opuesto al sol
const fill = new THREE.DirectionalLight(0x9fc6ff, 2.1); // subido de 1.6 → 2.1
fill.position.set(-sunPos.x, 10, -sunPos.z);
scene.add(fill);

// Luz de relleno frontal (cámara)
const frontFill = new THREE.DirectionalLight(0xffffff, 1.6); // subido de 1.1 → 1.6
frontFill.position.set(0, 12, 25);
scene.add(frontFill);

// Luz de relleno lateral opuesta
const sideFill = new THREE.DirectionalLight(0xffffff, 1.2); // subido de 0.8 → 1.2
sideFill.position.set(-25, 10, 0);
scene.add(sideFill);

// Relleno cenital adicional — ataca techo y aristas superiores
const topFill = new THREE.DirectionalLight(0xffffff, 0.9); // nueva
topFill.position.set(5, 30, 5);
scene.add(topFill);

// Ground plane to catch shadows
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.ShadowMaterial({ opacity: 0.2 }) // sombra un poco más suave que antes
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
controls.maxDistance = 200;
controls.maxPolarAngle = Math.PI / 2 + 0.15;
controls.autoRotate = false;
controls.autoRotateSpeed = 1.4;

let initialCameraPos = new THREE.Vector3(20, 14, 20);
let initialTarget = new THREE.Vector3(0, 0, 0);
camera.position.copy(initialCameraPos);
controls.target.copy(initialTarget);
controls.update();

// ─── Luces interiores simuladas ───
// Como no controlamos materiales individuales del .glb, colocamos varias
// luces puntuales cálidas dentro del volumen del modelo, calculadas a
// partir de su caja delimitadora, para simular ventanas/lámparas encendidas.
const interiorLights = [];

function addInteriorLights(box, size, center) {
  const count = 5; // número de "focos" interiores
  const warmColor = 0xffb877;
  const intensity = 1.4;
  const distance = Math.max(size.x, size.z) * 0.8;

  for (let i = 0; i < count; i++) {
    const light = new THREE.PointLight(warmColor, intensity, distance, 2);
    // distribuidas a lo largo del eje X del volumen, a media altura,
    // ligeramente dentro del centro de la planta
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = THREE.MathUtils.lerp(box.min.x, box.max.x, t) - center.x;
    const y = size.y * 0.35; // altura media-baja, como una lámpara de interior
    const z = 0;
    light.position.set(x, y, z);
    light.castShadow = false; // evita artefactos y costo de render extra
    scene.add(light);
    interiorLights.push(light);
  }
}

// ─── Load model ───
let modelRoot = null;
let wireframeOn = false;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

loader.load(
  MODEL_URL,
  (gltf) => {
    modelRoot = gltf.scene;

    modelRoot.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        // Sube un poco la reflectividad ambiental de materiales muy oscuros
        // para que no queden negros absolutos en zonas con poca luz directa
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          if (m && 'emissiveIntensity' in m === false && 'roughness' in m) {
            m.envMapIntensity = 1.2;
          }
        });
      }
    });

    // Center + fit
    const box = new THREE.Box3().setFromObject(modelRoot);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    modelRoot.position.sub(center); // recenter to origin
    scene.add(modelRoot);

    const maxDim = Math.max(size.x, size.y, size.z) || 10;
    const fitDistance = maxDim * 1.6;

    initialCameraPos = new THREE.Vector3(
      fitDistance * 0.75,
      fitDistance * 0.55,
      fitDistance * 0.75
    );
    initialTarget = new THREE.Vector3(0, size.y * 0.15, 0);

    camera.position.copy(initialCameraPos);
    camera.near = maxDim / 100;
    camera.far = maxDim * 20;
    camera.updateProjectionMatrix();

    controls.target.copy(initialTarget);
    controls.minDistance = maxDim * 0.15;
    controls.maxDistance = maxDim * 6;
    controls.update();

    // Resize ground relative to model
    ground.scale.setScalar(Math.max(4, maxDim / 20));

    // Luces interiores, calculadas ya con el modelo recentrado en el origen
    const recenteredBox = new THREE.Box3().setFromObject(modelRoot);
    addInteriorLights(recenteredBox, size, new THREE.Vector3(0, 0, 0));

    hideLoader();
    fallbackEl.hidden = true;
    fallbackEl.style.display = 'none';
  },
  (progress) => {
    if (progress.total) {
      const pct = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
      loaderPctEl.textContent = ` ${pct}%`;
    }
  },
  (error) => {
    console.error('Error cargando el modelo GLTF:', error);
    showFallback(error);
  }
);

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
    let detail = document.getElementById('whFallbackDetail');
    if (!detail) {
      detail = document.createElement('pre');
      detail.id = 'whFallbackDetail';
      detail.className = 'wh-fallback-detail';
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

wireBtn.addEventListener('click', () => {
  wireframeOn = !wireframeOn;
  wireBtn.classList.toggle('is-active', wireframeOn);
  wireLabel.textContent = wireframeOn ? 'Modo sólido' : 'Modo alambre';

  if (modelRoot) {
    modelRoot.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => (m.wireframe = wireframeOn));
      }
    });
  }
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
  const trigger = item.querySelector('.wh-acc-trigger');
  trigger.addEventListener('click', () => {
    const isOpen = item.classList.contains('is-open');
    accItems.forEach((i) => i.classList.remove('is-open'));
    if (!isOpen) item.classList.add('is-open');
  });
});