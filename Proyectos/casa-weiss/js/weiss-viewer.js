// Casa Weiss — Visor 3D · APG Studio
// Requiere el importmap de "three" definido en index.html

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MODEL_URL = 'weiss-optimized.glb';
const LOTE_URL = 'lote.glb';

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
const layerButtons = document.querySelectorAll('.wh-layer-btn[data-layer]');

// ─── Definición de capas del modelo ───
// Empareja cada botón con los nombres de grupo/instancia tal como fueron
// exportados desde SketchUp (Instancia en el panel "Información de la
// entidad"). Se compara sin tildes y en mayúsculas, así que es tolerante a
// variaciones menores de mayúsculas/minúsculas.
// Nota: "estructura cubierta" y "puertas y ventanas" ya no son capas propias:
// esa geometría se agrupó dentro de CUBIERTA y MUROS respectivamente en el modelo.
// Nota 2: "lote" NO se busca aquí por nombre — se carga por separado desde
// lote.glb y se detecta por textura (ver loadLote más abajo). Se deja fuera
// de esta lista para que collectLayerObjects no la marque erróneamente como
// "no disponible" antes de que termine de cargar.
const LAYER_DEFINITIONS = [
  { key: 'cubierta', names: ['CUBIERTA', 'ROOF'] },
  { key: 'muros', names: ['MUROS', 'WALLS'] },
  { key: 'arboles', names: ['ARBOLES', 'ÁRBOLES', 'TREES'] },
  { key: 'pisos', names: ['PISOS', 'FLOORS'] },
];

function normalizeName(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .toUpperCase()
    .trim();
}

const layerObjects = { lote: [] }; // key -> [Object3D, ...]

function collectLayerObjects(root) {
  LAYER_DEFINITIONS.forEach((def) => (layerObjects[def.key] = []));

  root.traverse((obj) => {
    const normalized = normalizeName(obj.name);
    if (!normalized) return;
    const def = LAYER_DEFINITIONS.find((d) =>
      d.names.some((n) => normalizeName(n) === normalized)
    );
    if (def) layerObjects[def.key].push(obj);
  });

  // Marca como no disponibles los botones cuyo grupo no existe en el modelo.
  // "lote" se excluye de esta comprobación: su disponibilidad la decide
  // loadLote() de forma independiente, cuando termine (o falle) su propia carga.
  layerButtons.forEach((btn) => {
    const key = btn.dataset.layer;
    if (key === 'lote') return;
    const found = (layerObjects[key] || []).length > 0;
    btn.classList.toggle('is-unavailable', !found);
    btn.disabled = !found;
    if (!found) {
      btn.title = 'No se encontró este grupo en el modelo 3D';
    }
  });
}

function setLayerVisible(key, visible) {
  (layerObjects[key] || []).forEach((obj) => {
    obj.visible = visible;
  });
}

layerButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const key = btn.dataset.layer;
    const nowActive = !btn.classList.contains('is-active');
    btn.classList.toggle('is-active', nowActive);
    setLayerVisible(key, nowActive);

    // La capa "Lote" solo cambia visibilidad — la cámara se queda exactamente
    // donde el usuario la dejó (mismo ángulo, misma posición, mismo zoom).
    // Antes esto alejaba automáticamente la cámara al vecindario; se quitó
    // esa transición a pedido: activar/desactivar "Lote" ya no mueve la vista.
  });
});

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

// ─── Transición suave de cámara entre encuadres ───
// Se usa para pasar del encuadre "casa" al encuadre "vecindario" (y
// viceversa) al activar/desactivar la capa Lote, en vez de un salto brusco.
let cameraTween = null;

function tweenCameraTo(pos, target, duration = 900) {
  cameraTween = {
    startPos: camera.position.clone(),
    endPos: pos.clone(),
    startTarget: controls.target.clone(),
    endTarget: target.clone(),
    startTime: performance.now(),
    duration,
  };
}

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

// ─── Lote (foto aérea del terreno) — archivo aparte ───
// El grupo LOTE embebido en weiss-optimized.glb se elimina más abajo porque
// su transformación quedó rota en la exportación (ver EMBEDDED_LOTE_NAMES).
// En su lugar, se carga aquí lote.glb como archivo independiente y se
// posiciona con reglas propias, distintas a las del resto del modelo:
//
//   1) POSICIÓN (X/Z): se centra usando el centro de SU PROPIA caja
//      delimitadora — el centro de la foto — en vez de restar el centro
//      de la casa. weiss-optimized.glb y lote.glb salieron de SketchUp con
//      orígenes distintos, así que reusar el offset de la casa desalineaba
//      la foto respecto al modelo.
//   2) ALTURA (Y): se alinea el borde superior de la foto (el "suelo") con
//      el nivel de piso real de la casa ya recentrada (houseFloorY), para
//      que no quede flotando sobre la casa ni hundida bajo ella.
//   3) DETECCIÓN: la malla de la foto se identifica por tener una textura
//      (mapa de imagen) asignada, no por su nombre de grupo. El archivo
//      también trae geometría auxiliar sin textura (bordes/remates del
//      terreno) que, si se incluye en el cálculo de la caja delimitadora,
//      desplaza el centro calculado y produce el corte diagonal visto
//      antes en la cámara.
let loteRoot = null;
let loteWideView = null; // { pos, target } — encuadre amplio para ver el vecindario de la foto del lote

function loadLote(houseFloorY, houseMaxDim) {
  loader.load(
    LOTE_URL,
    (gltf) => {
      loteRoot = gltf.scene;

      const texturedMeshes = [];
      loteRoot.traverse((child) => {
        if (child.isMesh) {
          child.receiveShadow = true;
          child.castShadow = false;
          const mats = Array.isArray(child.material) ? child.material : [child.material];

          // lote.glb trae, superpuesta a la foto aérea real, una geometría
          // de "césped" genérico (material "Carpet Plush Forest" — una
          // textura tileable de relleno típica de SketchUp) que cubre toda
          // la parcela y tapa por completo la foto real que está debajo.
          // Se oculta ese césped de relleno para que se vea la foto.
          const isFillerGrass = mats.some((m) => m && m.name === 'Carpet Plush Forest');
          if (isFillerGrass) {
            child.visible = false;
            return;
          }

          const texturedMat = mats.find((m) => m && m.map);
          if (texturedMat) {
            texturedMeshes.push(child);
            // La foto del lote se ve casi en rasante (ángulo muy oblicuo
            // respecto a la cámara), y con el filtrado por defecto (sin
            // anisotropía) el GPU la difumina agresivamente en esa
            // dirección, perdiendo casi todo el detalle y dejando un tono
            // plano. Subir la anisotropía al máximo que soporte el
            // dispositivo mantiene la foto nítida en ese ángulo.
            if (texturedMat.map) {
              texturedMat.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
              texturedMat.map.needsUpdate = true;
            }
            // La foto del lote se renderiza SIN luz (unlit) y sin la curva
            // de tone mapping/exposición del resto de la escena. El rig de
            // luces está calibrado para que la madera oscura de la casa se
            // vea bien (varias luces muy intensas sumadas), pero aplicado a
            // la foto aérea la sobreexpone por completo: todo el detalle se
            // pierde y queda un verde plano uniforme. Con MeshBasicMaterial
            // + toneMapped=false, la foto se muestra tal como fue capturada.
            child.material = new THREE.MeshBasicMaterial({
              map: texturedMat.map,
              toneMapped: false,
              side: THREE.DoubleSide, // el .glb marca este material como doubleSided; si no lo respetamos aquí, el back-face culling puede ocultar el plano de la foto según el ángulo
            });
          } else {
            // Lo único que queda sin textura a estas alturas es el mesh
            // "Edge": un contorno/borde del lote (las líneas sueltas que se
            // veían cruzando la foto) que no aporta nada visualmente. Se
            // oculta.
            child.visible = false;
          }
        }
      });

      // IMPORTANTE: en este punto loteRoot todavía no se ha agregado a la
      // escena ni se ha renderizado ni un solo frame, así que las matrices
      // de mundo (matrixWorld) de sus nodos internos siguen en su valor por
      // defecto (identidad) — Three.js normalmente las recalcula durante el
      // render, pero aquí necesitamos los valores correctos YA, para poder
      // calcular la caja delimitadora de la foto. Sin este forzado, Box3
      // ignora por completo la escala 0.0254 que trae el nodo "Root Node"
      // del .glb (conversión de unidades de SketchUp a metros), y el
      // tamaño/posición calculados quedan ~40 veces más grandes de lo real.
      loteRoot.updateMatrixWorld(true);

      // Caja delimitadora SOLO de la(s) malla(s) con textura (la foto real)
      const photoBox = new THREE.Box3();
      if (texturedMeshes.length) {
        texturedMeshes.forEach((m) => photoBox.union(new THREE.Box3().setFromObject(m)));
      } else {
        // Respaldo: si por algún motivo no se detecta ninguna malla con
        // textura, usa la caja de todo el grupo para no dejar el lote sin
        // posicionar.
        photoBox.setFromObject(loteRoot);
        console.warn('[lote] No se detectó ninguna malla con textura; usando caja completa como respaldo.');
      }

      const photoCenter = new THREE.Vector3();
      photoBox.getCenter(photoCenter);

      // 1) Posición: centro propio de la foto (X/Z), no el centro de la casa
      loteRoot.position.x -= photoCenter.x;
      loteRoot.position.z -= photoCenter.z;

      // 2) Altura: borde superior de la foto = nivel de piso real de la casa
      loteRoot.position.y += houseFloorY - photoBox.max.y;

      scene.add(loteRoot);
      loteRoot.updateMatrixWorld(true);

      // ─── Encuadre amplio para la capa "Lote" ───
      // La foto cubre todo el vecindario (decenas de casas); la Casa Weiss
      // es solo un punto diminuto en el centro. Se calcula aquí un
      // encuadre diagonal-elevado que abarque el ancho real de la foto ya
      // posicionada, para usarlo como vista al activar el botón "Lote".
      const loteWorldBox = new THREE.Box3().setFromObject(loteRoot);
      const loteSize = new THREE.Vector3();
      loteWorldBox.getSize(loteSize);
      const loteMaxDim = Math.max(loteSize.x, loteSize.z) || houseMaxDim * 10;
      const loteViewDist = loteMaxDim * 0.62;
      loteWideView = {
        pos: new THREE.Vector3(loteViewDist * 0.55, loteViewDist * 0.62, loteViewDist * 0.55),
        target: new THREE.Vector3(0, 0, 0),
      };

      // Vincula el resultado al botón de capa "Lote" y respeta su estado actual
      layerObjects.lote = [loteRoot];
      const loteBtn = document.querySelector('.wh-layer-btn[data-layer="lote"]');
      if (loteBtn) {
        loteBtn.disabled = false;
        loteBtn.classList.remove('is-unavailable');
        loteBtn.title = '';
        loteRoot.visible = loteBtn.classList.contains('is-active');
      }
    },
    undefined,
    (error) => {
      console.error('Error cargando lote.glb:', error);
      const loteBtn = document.querySelector('.wh-layer-btn[data-layer="lote"]');
      if (loteBtn) {
        loteBtn.disabled = true;
        loteBtn.classList.add('is-unavailable');
        loteBtn.title = 'No se pudo cargar lote.glb';
      }
    }
  );
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

    // ─── Quita el LOTE embebido (roto) de este archivo ───
    // weiss-optimized.glb trae un grupo LOTE/SITE/TERRENO/"1" (la foto
    // aérea) cuyo nodo interno quedó sin la transformación correcta y
    // desalineado respecto a la casa. Es una imagen enorme (~490 x 350 m)
    // que si se deja ahí arruina el cálculo de tamaño/centro de todo el
    // modelo (la cámara termina enfocando un punto microscópico de esa
    // foto en vez de la casa). Se elimina aquí, antes de medir el bounding
    // box, y se reemplaza más abajo por lote.glb (cargado y posicionado
    // por separado en loadLote).
    const EMBEDDED_LOTE_NAMES = ['LOTE', 'SITE', 'LOT', 'TERRENO', '1'];
    const embeddedLote = [];
    modelRoot.traverse((obj) => {
      if (EMBEDDED_LOTE_NAMES.includes(normalizeName(obj.name))) embeddedLote.push(obj);
    });
    embeddedLote.forEach((obj) => obj.parent && obj.parent.remove(obj));

    // Center + fit
    const box = new THREE.Box3().setFromObject(modelRoot);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    modelRoot.position.sub(center); // recenter to origin
    scene.add(modelRoot);

    const maxDim = Math.max(size.x, size.y, size.z) || 10;

    // ─── Vista inicial: desde dentro del patio, mirando hacia la chimenea ───
    // Antes era una vista aérea 3/4 alejada centrada en la chimenea. Ahora
    // se busca una vista más baja y cercana, como si la cámara estuviera de
    // pie dentro del patio de acceso, con el piso del patio en primer plano
    // y las fachadas de madera + chimenea de fondo (ver referencia SketchUp).
    let chimneyCenter = null;
    modelRoot.traverse((obj) => {
      const n = normalizeName(obj.name);
      if (n.includes('CHIMENEA') || n.includes('CHIMNEY')) {
        const b = new THREE.Box3().setFromObject(obj);
        if (!b.isEmpty()) {
          chimneyCenter = chimneyCenter
            ? chimneyCenter.add(b.getCenter(new THREE.Vector3())).multiplyScalar(0.5)
            : b.getCenter(new THREE.Vector3());
        }
      }
    });

    if (!chimneyCenter) {
      // Estimación: costado izquierdo del volumen, cerca de la parte alta
      // de cubierta. Ajusta estos tres multiplicadores si la chimenea no
      // queda perfectamente centrada — son fracciones del tamaño del modelo.
      chimneyCenter = new THREE.Vector3(
        -size.x * 0.10,
        size.y * 0.68,
        size.z * 0.03
      );
    }

    // ─── Vista inicial: toma de conjunto, casa completa ───
    // Encuadre tipo "presentación": diagonal, elevado, mostrando toda la
    // casa (cubierta, muros, chimenea) de cerca pero sin recortarla.
    // VIEW_DIST_FACTOR: <1 acerca la vista, >1 la aleja.
    const VIEW_DIST_FACTOR = 0.95;
    const viewDist = maxDim * VIEW_DIST_FACTOR;
    initialCameraPos = new THREE.Vector3(
      viewDist * 0.95,
      viewDist * 0.55,
      viewDist * 0.9
    );
    initialTarget = new THREE.Vector3(0, size.y * 0.18, 0);

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

    // Empareja los botones de capas con los grupos reales del modelo
    collectLayerObjects(modelRoot);

    // Carga el lote (foto aérea) por separado, alineado al piso real
    // de la casa ya recentrada (recenteredBox.min.y = nivel de piso).
    loadLote(recenteredBox.min.y, maxDim);

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

// ─── Ajuste fino manual temporal (BORRA este bloque cuando ya tengas el
// encuadre inicial final) ───
// Navega con el mouse (OrbitControls) hasta encontrar el punto de vista
// exacto que quieres como vista inicial, y presiona la tecla "C" (con el
// canvas enfocado, haz clic sobre él primero) para imprimir en consola las
// coordenadas exactas de camera.position y controls.target — cópialas
// directo a initialCameraPos / initialTarget más arriba en este archivo.
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

  cameraTween = null; // cancela cualquier transición en curso (p. ej. hacia la vista del Lote)
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

  if (loteRoot) {
    loteRoot.traverse((child) => {
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

  if (cameraTween) {
    const t = Math.min(1, (performance.now() - cameraTween.startTime) / cameraTween.duration);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    camera.position.lerpVectors(cameraTween.startPos, cameraTween.endPos, ease);
    controls.target.lerpVectors(cameraTween.startTarget, cameraTween.endTarget, ease);
    if (t >= 1) cameraTween = null;
  }

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