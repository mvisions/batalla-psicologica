import * as THREE from 'three';

// Mundo: los carriles van en X (1 unidad de movimiento = UNIT); mi barco está en +Z y el rival en -Z.
const LANE_X = [-4.5, -1.5, 1.5, 4.5];
const UNIT = 1.5;
const SHIP_Z = 16, FIN_Z = 4.5, HIT_SHIP_Z = SHIP_Z - 1.3, MUZZLE_Z = SHIP_Z - 2.45, OUT_Z = SHIP_Z + 5.5;
const SPEED = 7; // unidades/s: misma velocidad para todas las balas (el viaje más largo dura unos 3 s)
const zOf = (who) => (who === 'me' ? 1 : who === 'op' ? -1 : 0);
const rnd = (a, b) => a + Math.random() * (b - a);
// Dispositivos modestos: menos partículas, lluvia y resolución
const LOW = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent) || (navigator.hardwareConcurrency || 8) <= 4;
const SHADOWS = !LOW;

const easeIn = (t) => t * t;
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createScene(container) {
  const api = {};
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LOW ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = SHADOWS;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  container.prepend(canvas);
  const fogOverlay = document.createElement('div');
  fogOverlay.style.cssText = 'position:absolute;inset:0;z-index:3;pointer-events:none;opacity:0;background:linear-gradient(180deg,#d9e6e866,#b8cbd655 55%,#d9e6e866);backdrop-filter:blur(1.5px);transition:opacity 1.2s ease';
  container.appendChild(fogOverlay);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
  const baseCam = new THREE.Vector3();

  // Estado del tiempo: tormenta (rondas de lluvia) y oleaje (mar agitado)
  let storm = 0, rough = 0, lightning = 0, nextBolt = 3;

  // ---------- Texturas procedurales ----------
  const glowTex = canvasTex(128, 128, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
  const smokeTex = canvasTex(128, 128, (g, w) => {
    for (let i = 0; i < 9; i++) {
      const x = rnd(35, 93), y = rnd(35, 93), r = rnd(25, 46);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, w);
    }
  });
  const ringTex = canvasTex(256, 256, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, w * 0.2, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.7, 'rgba(255,255,255,0)'); gr.addColorStop(0.86, 'rgba(255,255,255,.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
  const foamTex = canvasTex(512, 128, (g, w, h) => {
    g.filter = 'blur(10px)'; g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 18;
    g.beginPath(); g.roundRect(34, 30, w - 68, h - 60, 40); g.stroke();
  });
  const deckTex = canvasTex(256, 256, (g, w) => {
    g.fillStyle = '#8a7655'; g.fillRect(0, 0, w, w);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = `rgba(${rnd(0, 40) | 0},${rnd(0, 30) | 0},0,${rnd(0.05, 0.2)})`; g.fillRect(0, i * 32, w, 32);
      g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, i * 32, w, 2);
    }
  });
  deckTex.wrapS = deckTex.wrapT = THREE.RepeatWrapping;
  deckTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  function applyModelShadows(root) {
    if (!SHADOWS) return;
    root.traverse((object) => {
      if (object.isMesh || object.isInstancedMesh) { object.castShadow = true; object.receiveShadow = true; }
    });
  }

  // ---------- Cielo, entorno y luces ----------
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uStorm: { value: 0 } },
    vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `uniform float uStorm; varying vec3 vP; void main(){
      vec3 d = normalize(vP); float h = d.y;
      vec3 top=vec3(.16,.40,.78), hor=vec3(.82,.91,.98), bot=vec3(.03,.13,.26);
      vec3 c = h>0. ? mix(hor, top, pow(h,.5)) : mix(hor, bot, pow(-h,.6));
      c += vec3(1.,.9,.7)*pow(max(dot(d, normalize(vec3(-.5,.7,.4))),0.),200.)*6.*(1.-uStorm);
      c = mix(c, vec3(.26,.29,.34)*(.75+.5*clamp(h+.3,0.,1.)), uStorm);
      gl_FragColor = vec4(c,1.); }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat));
  scene.environment = pmrem.fromScene(envScene).texture;

  const hemi = new THREE.HemisphereLight(0x9ed4ff, 0x16324d, 0.8);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d2, 2.6);
  sun.position.set(-8, 14, 6);
  sun.castShadow = SHADOWS;
  sun.shadow.mapSize.set(SHADOWS ? 2048 : 512, SHADOWS ? 2048 : 512);
  sun.shadow.camera.left = -24; sun.shadow.camera.right = 24;
  sun.shadow.camera.top = 35; sun.shadow.camera.bottom = -35;
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.00015; sun.shadow.normalBias = 0.035;
  sun.shadow.blurSamples = SHADOWS ? 8 : 4;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  const flashLights = [0, 1].map(() => { const l = new THREE.PointLight(0xffa040, 0, 18, 2); scene.add(l); return l; });
  let flashIdx = 0;

  // ---------- Agua ----------
  const WAVE = `uniform float uStorm; uniform float uRough; uniform float uRiver; uniform float uMud;
    float wave(vec2 p){ float a = 1. + uStorm*.9 + uRough*1.7;
      float swell = sin(p.x*.55+uTime*1.1)*.13 + sin(p.y*.8-uTime*1.4)*.1;
      float chop = sin((p.x+p.y)*1.2+uTime*1.9)*.05 + sin((p.x-p.y)*2.1-uTime*2.4)*.025;
      float ripples = sin(p.x*3.1+uTime*1.7)*sin(p.y*2.6-uTime*1.3)*.012;
      return a*(swell + chop + ripples); }`;
  const waterMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uStorm: { value: 0 }, uRough: { value: 0 }, uRiver: { value: 0 }, uMud: { value: 0 }, uSun: { value: new THREE.Vector3(-0.5, 0.7, 0.4).normalize() } },
    vertexShader: `uniform float uTime; varying vec3 vW; varying float vH; ${WAVE}
      void main(){ vec4 w = modelMatrix*vec4(position,1.); float h = wave(w.xz); w.y += h; vH = h; vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uSun; varying vec3 vW; varying float vH; ${WAVE}
      void main(){
        float e = .045;
        float dx = (wave(vW.xz+vec2(e,0.))-wave(vW.xz-vec2(e,0.)))/(2.*e);
        float dz = (wave(vW.xz+vec2(0.,e))-wave(vW.xz-vec2(0.,e)))/(2.*e);
        vec3 n = normalize(vec3(-dx, 1., -dz));
        vec3 V = normalize(cameraPosition - vW);
        float fres = pow(1. - max(dot(n,V),0.), 3.);
        vec3 col = mix(vec3(.01,.13,.30), vec3(.06,.44,.64), .5 + vH*1.6);
        col = mix(col, mix(vec3(.05,.17,.07), vec3(.24,.44,.15), .5 + vH*1.6), uRiver);
        col = mix(col, mix(vec3(.16,.09,.04), vec3(.42,.27,.14), .5 + vH*1.6), uMud);
        col = mix(col, vec3(.12,.2,.27), uStorm*.55);
        col = mix(col, vec3(.62,.8,.94)*(1.-uStorm*.5), fres*.65);
        vec3 R = reflect(-uSun, n);
        float spec = max(dot(R,V),0.);
        col += vec3(1.,.95,.82)*(pow(spec, 28.)*.18+pow(spec, 96.)*1.15)*(1.-uStorm*.85);
        float crest = max(vH,0.);
        float foam = smoothstep(.2-uRough*.04,.34-uRough*.025,crest+length(vec2(dx,dz))*.045);
        col = mix(col, vec3(.82,.92,.97), foam*(.24+uRough*.18)*(1.-uStorm*.55));
        col += .006*sin(vW.x*2.1+uTime*.7)*sin(vW.z*1.7-uTime*.55);
        gl_FragColor = vec4(col, .86); }`,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(140, 140, LOW ? 120 : 220, LOW ? 120 : 220).rotateX(-Math.PI / 2), waterMat);
  water.renderOrder = 1;
  scene.add(water);

  LANE_X.forEach((x) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 30).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13, depthWrite: false }));
    m.position.set(x, 0.2, 0); m.renderOrder = 2; scene.add(m);
  });

  // ---------- Lluvia ----------
  const RAIN_N = LOW ? 600 : 1400;
  const rd = new Float32Array(RAIN_N * 3);
  for (let i = 0; i < RAIN_N; i++) { rd[i * 3] = rnd(-16, 16); rd[i * 3 + 1] = rnd(0, 18); rd[i * 3 + 2] = rnd(-14, 14); }
  const rainPos = new Float32Array(RAIN_N * 6);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.LineBasicMaterial({ color: 0xbcd4ea, transparent: true, opacity: 0, depthWrite: false });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false; rain.visible = false; rain.renderOrder = 7;
  scene.add(rain);

  const SNOW_N = LOW ? 180 : 420;
  const snowPos = new Float32Array(SNOW_N * 3);
  for (let i = 0; i < SNOW_N; i++) {
    snowPos[i * 3] = rnd(-16, 16); snowPos[i * 3 + 1] = rnd(0, 18); snowPos[i * 3 + 2] = rnd(-14, 14);
  }
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const snowMat = new THREE.PointsMaterial({ color: 0xeaf6ff, size: LOW ? 0.2 : 0.16, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true });
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false; snow.visible = false; snow.renderOrder = 8;
  scene.add(snow);

  // ---------- Partículas ----------
  const parts = [];
  function spawn(o) {
    if (LOW && Math.random() < 0.4) return;
    const m = new THREE.SpriteMaterial({ map: o.tex || glowTex, color: o.color ?? 0xffffff, transparent: true, depthWrite: false,
      blending: o.add ? THREE.AdditiveBlending : THREE.NormalBlending, opacity: o.op ?? 1 });
    const sp = new THREE.Sprite(m);
    sp.position.copy(o.pos); sp.scale.setScalar(o.s0 ?? 1); sp.renderOrder = 5;
    scene.add(sp);
    parts.push({ sp, m, vel: (o.vel || new THREE.Vector3()).clone(), grav: o.grav || 0, drag: o.drag || 0, life: o.life ?? 1, age: 0, s0: o.s0 ?? 1, s1: o.s1 ?? 1, op: o.op ?? 1 });
  }
  const debris = [];
  const ripples = [];
  const ringGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  function ripple(x, z, size, delay = 0, life = 1.5) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, opacity: 0 }));
    m.position.set(x, 0.18, z); m.renderOrder = 3; m.scale.setScalar(0.4); scene.add(m);
    ripples.push({ m, age: -delay, life, size });
  }

  // ---------- Animaciones ----------
  const tweens = [];
  const tween = (ms, fn, ease = (t) => t) => new Promise((res) => tweens.push({ age: 0, ms, fn, ease, res }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let shakeLeft = 0, shakeDur = 1, shakeAmp = 0;
  const shake = (amp, dur) => { if (amp >= shakeAmp * (shakeLeft / shakeDur || 0)) { shakeAmp = amp; shakeDur = shakeLeft = dur; } };

  function flashLight(pos, intensity, color = 0xffa040) {
    const l = flashLights[flashIdx++ % flashLights.length];
    l.position.copy(pos); l.color.set(color); l.userData.i = intensity; l.userData.t = 0; l.intensity = intensity;
  }

  // ---------- Barcos ----------
  const numberSprite = (n) => {
    const t = canvasTex(128, 128, (g) => {
      g.fillStyle = 'rgba(8,16,24,.78)'; g.beginPath(); g.arc(64, 64, 52, 0, 7); g.fill();
      g.lineWidth = 6; g.strokeStyle = '#ffd54f'; g.stroke();
      g.fillStyle = '#fff'; g.font = 'bold 76px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), 64, 70);
    });
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false }));
    s.scale.setScalar(0.95); s.renderOrder = 6; s.userData.tex = t; return s;
  };

  function buildShip(who) {
    const sign = who === 'me' ? 1 : -1;
    const g = new THREE.Group();
    const wrap = new THREE.Group(); // balanceo y sacudidas
    g.add(wrap);
    const base = new THREE.Color(0x7d8a96), red = new THREE.Color(0xdc1414);
    const hullMat = new THREE.MeshPhysicalMaterial({ color: base, metalness: 0.5, roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.4, emissive: 0x000000 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x8e99a1, metalness: 0.6, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d252a, metalness: 0.4, roughness: 0.5 });
    const turretMat = new THREE.MeshStandardMaterial({ color: 0xa4afb6, metalness: 0.65, roughness: 0.3 });
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x2c363c, metalness: 0.9, roughness: 0.28 });
    const whiteM = new THREE.MeshStandardMaterial({ color: 0xe9eef1, roughness: 0.6 });
    const bootM = new THREE.MeshStandardMaterial({ color: 0x7a1d1d, roughness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x10202c, metalness: 0.8, roughness: 0.15, emissive: 0x2b5f86, emissiveIntensity: 0.6 });

    const L = 6.5, b = 1.45;
    const hs = new THREE.Shape();
    hs.moveTo(-L, -b); hs.lineTo(L - 3.2, -b); hs.quadraticCurveTo(L - 0.6, -b, L + 0.9, 0);
    hs.quadraticCurveTo(L - 0.6, b, L - 3.2, b); hs.lineTo(-L, b); hs.lineTo(-L, -b);
    const hull = new THREE.Mesh(new THREE.ExtrudeGeometry(hs, { depth: 1, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 3, curveSegments: 24 }).rotateX(-Math.PI / 2), hullMat);
    hull.position.y = -0.45; wrap.add(hull);

    // Piezas de barco moderno (puente, chimenea, radar, ojos de buey...): se ocultan con la skin vikinga.
    const modern = new THREE.Group(); wrap.add(modern);
    // Franja roja de flotación, línea blanca y ojos de buey
    for (const s of [-1, 1]) {
      const strip = (mat, y, h) => { const m = new THREE.Mesh(new THREE.BoxGeometry(9.9, h, 0.03), mat); m.position.set(-1.6, y, s * 1.545); modern.add(m); };
      strip(bootM, -0.2, 0.2); strip(whiteM, 0.52, 0.06);
    }
    const ports = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 10).rotateX(Math.PI / 2), glass, 32);
    const m4 = new THREE.Matrix4(); let pn = 0;
    for (const s of [-1, 1]) for (let i = 0; i < 16; i++) { m4.makeTranslation(-5.9 + i * 0.6, 0.22, s * 1.552); ports.setMatrixAt(pn++, m4); }
    modern.add(ports);

    const ds = new THREE.Shape(); const L2 = 6.2, b2 = 1.2;
    ds.moveTo(-L2, -b2); ds.lineTo(L2 - 3.2, -b2); ds.quadraticCurveTo(L2 - 0.6, -b2, L2 + 0.6, 0);
    ds.quadraticCurveTo(L2 - 0.6, b2, L2 - 3.2, b2); ds.lineTo(-L2, b2); ds.lineTo(-L2, -b2);
    const deck = new THREE.Mesh(new THREE.ExtrudeGeometry(ds, { depth: 0.05, bevelEnabled: false, curveSegments: 24 }).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.85, metalness: 0.1 }));
    deck.position.y = 0.6; wrap.add(deck);
    const DY = 0.66;
    const palette = { hull: base.clone(), steel: new THREE.Color(0x8e99a1), turret: turretMat.color.clone(), emissive: new THREE.Color(0x000000), emissiveIntensity: 0 };

    // Skin de nivel 5: dos mascarones chinos dentro del perfil original del casco.
    const dragonSkin = new THREE.Group();
    const dragonRed = new THREE.MeshStandardMaterial({ color: 0xb5222b, roughness: 0.35, metalness: 0.08, emissive: 0x3a080b, emissiveIntensity: 0.22 });
    const dragonGold = new THREE.MeshStandardMaterial({ color: 0xf0b83e, roughness: 0.3, metalness: 0.58, emissive: 0x59340b, emissiveIntensity: 0.12 });
    const dragonDark = new THREE.MeshStandardMaterial({ color: 0x27151b, roughness: 0.38, metalness: 0.22 });
    const dragonEye = new THREE.MeshStandardMaterial({ color: 0xffed9b, emissive: 0xffa91e, emissiveIntensity: 1.2, roughness: 0.2 });
    const makeDragonHead = (direction) => {
      const head = new THREE.Group();
      const skull = new THREE.Mesh(new THREE.SphereGeometry(0.58, 20, 14), dragonRed);
      skull.scale.set(0.78, 0.64, 0.9); skull.position.y = 0.18; head.add(skull);
      const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.34, 18, 12), dragonGold);
      muzzle.scale.set(0.85, 0.46, 1.05); muzzle.position.set(0, 0.02, 0.43); head.add(muzzle);
      const lowerJaw = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.12, 0.45), dragonRed);
      lowerJaw.position.set(0, -0.2, 0.42); head.add(lowerJaw);
      const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.045, 0.26), dragonDark);
      mouth.position.set(0, -0.13, 0.58); head.add(mouth);
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 8), dragonEye);
        eye.position.set(side * 0.29, 0.34, 0.28); head.add(eye);
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.52, 9), dragonGold);
        horn.position.set(side * 0.34, 0.52, -0.12); horn.rotation.z = -side * 0.28; head.add(horn);
        const whisker = new THREE.CatmullRomCurve3([
          V(side * 0.3, 0.02, 0.42), V(side * 0.62, 0.12, 0.56), V(side * 0.72, 0.38, 0.78),
        ]);
        head.add(new THREE.Mesh(new THREE.TubeGeometry(whisker, 10, 0.035, 7, false), dragonGold));
        const fang = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.18, 7), dragonGold);
        fang.position.set(side * 0.17, -0.13, 0.62); fang.rotation.x = Math.PI; head.add(fang);
      }
      head.position.set(direction * 5.62, DY + 0.16, 0);
      head.rotation.y = direction > 0 ? Math.PI / 2 : -Math.PI / 2;
      head.scale.setScalar(0.72);
      dragonSkin.add(head);
    };
    makeDragonHead(-1); makeDragonHead(1);
    dragonSkin.visible = false; wrap.add(dragonSkin);

    const gondolaSkin = new THREE.Group();
    const gondolaGold = new THREE.MeshStandardMaterial({ color: 0xd7b35a, metalness: 0.72, roughness: 0.24 });
    const gondolaBlack = new THREE.MeshStandardMaterial({ color: 0x10151c, metalness: 0.35, roughness: 0.32 });
    for (const direction of [-1, 1]) {
      const end = new THREE.Group();
      const curve = new THREE.CatmullRomCurve3([V(0, -0.05, -0.45), V(0, 0.06, 0), V(0, 0.45, 0.7), V(0, 1.05, 1.18)]);
      end.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 18, 0.14, 9, false), gondolaBlack));
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), gondolaGold); tip.position.set(0, 1.03, 1.16); end.add(tip);
      const trim = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(0, 0.06, 0.02), V(0, 0.48, 0.7), V(0, 0.84, 1.02)]), 12, 0.035, 7, false), gondolaGold);
      end.add(trim); end.position.set(direction * 5.0, DY, 0); end.rotation.y = direction > 0 ? Math.PI / 2 : -Math.PI / 2; gondolaSkin.add(end);
    }
    gondolaSkin.visible = false; wrap.add(gondolaSkin);

    const santaSkin = new THREE.Group();
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x60391f, roughness: 0.62 });
    const sailMat = new THREE.MeshStandardMaterial({ color: 0xf2e7cc, side: THREE.DoubleSide, roughness: 0.84 });
    const sailCrossMat = new THREE.MeshStandardMaterial({ color: 0xb8292e, roughness: 0.65 });
    for (const [x, height, width] of [[-3.0, 2.65, 1.35], [0, 3.35, 1.8], [3.0, 2.5, 1.25]]) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.09, height, 10), mastMat); mast.position.set(x, DY + height / 2, 0); santaSkin.add(mast);
      const sail = new THREE.Mesh(new THREE.PlaneGeometry(width, height * 0.62), sailMat); sail.position.set(x + 0.12, DY + height * 0.58, 0.08); santaSkin.add(sail);
      const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.11, height * 0.34, 0.025), sailCrossMat); crossV.position.set(x + 0.12, DY + height * 0.58, 0.1); santaSkin.add(crossV);
      const crossH = new THREE.Mesh(new THREE.BoxGeometry(width * 0.4, 0.11, 0.025), sailCrossMat); crossH.position.set(x + 0.12, DY + height * 0.58, 0.1); santaSkin.add(crossH);
    }
    santaSkin.visible = false; wrap.add(santaSkin);

    const iceSkin = new THREE.Group();
    const iceCrystal = new THREE.MeshPhysicalMaterial({ color: 0xa8eaff, roughness: 0.18, metalness: 0.08, clearcoat: 0.9, transparent: true, opacity: 0.9, emissive: 0x287b9b, emissiveIntensity: 0.24 });
    for (const side of [-1, 1]) for (const [index, x] of [-5.2, -3.9, -2.6, 2.6, 3.9, 5.2].entries()) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(index % 2 ? 0.22 : 0.3, index % 2 ? 0.85 : 1.1, 6), iceCrystal);
      spike.position.set(x, DY + 0.45, side * 1.12); spike.rotation.z = (index % 2 ? 0.16 : -0.12) * side; iceSkin.add(spike);
    }
    iceSkin.visible = false; wrap.add(iceSkin);

    const lavaSkin = new THREE.Group();
    const lavaRock = new THREE.MeshStandardMaterial({ color: 0x281e21, roughness: 0.86, flatShading: true });
    const lavaGlow = new THREE.MeshStandardMaterial({ color: 0xff6a16, emissive: 0xf02f08, emissiveIntensity: 1.35, roughness: 0.4 });
    for (const side of [-1, 1]) {
      const crack = new THREE.CatmullRomCurve3([V(-5.8, DY + 0.1, side * 1.17), V(-3.4, DY + 0.12, side * 0.96), V(-1.6, DY + 0.1, side * 1.18), V(0.4, DY + 0.13, side * 0.94), V(2.7, DY + 0.1, side * 1.16), V(5.7, DY + 0.12, side * 0.98)]);
      lavaSkin.add(new THREE.Mesh(new THREE.TubeGeometry(crack, 28, 0.065, 7, false), lavaGlow));
      for (const x of [-5.2, -2.6, 0, 2.6, 5.2]) {
        const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), lavaRock); rock.position.set(x, DY + 0.08, side * 1.2); rock.scale.set(1.2, 0.6, 0.75); lavaSkin.add(rock);
      }
    }
    lavaSkin.visible = false; wrap.add(lavaSkin);

    const goldSkin = new THREE.Group();
    const goldPlate = new THREE.MeshStandardMaterial({ color: 0xf0c44f, metalness: 0.88, roughness: 0.2, emissive: 0x56340a, emissiveIntensity: 0.18 });
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(11.4, 0.08, 0.06), goldPlate); rail.position.set(0, DY + 0.28, side * 1.17); goldSkin.add(rail);
      for (const x of [-5.2, -3.9, -2.6, -1.3, 0, 1.3, 2.6, 3.9, 5.2]) {
        const stud = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), goldPlate); stud.position.set(x, DY + 0.28, side * 1.22); goldSkin.add(stud);
      }
    }
    goldSkin.visible = false; wrap.add(goldSkin);

    // Skin de la tienda: drakkar vikingo con tracas de madera, mascarón de dragón dorado, cola en espiral,
    // escudos pintados, remos que bogan y vela a rayas con valknut.
    const vikingSkin = new THREE.Group();
    const vkWoodA = new THREE.MeshStandardMaterial({ color: 0x7a4b27, roughness: 0.72 });
    const vkWoodB = new THREE.MeshStandardMaterial({ color: 0x4e2c15, roughness: 0.78 });
    const vkRed = new THREE.MeshStandardMaterial({ color: 0x9c1c1c, roughness: 0.5, emissive: 0x2a0303, emissiveIntensity: 0.3 });
    const vkGold = new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 0.85, roughness: 0.22, emissive: 0x5a3a08, emissiveIntensity: 0.28 });
    const vkIron = new THREE.MeshStandardMaterial({ color: 0xb0b8bd, metalness: 0.8, roughness: 0.3 });
    const vkBone = new THREE.MeshStandardMaterial({ color: 0xfff6e0, roughness: 0.4 });
    const vkEye = new THREE.MeshStandardMaterial({ color: 0xfff176, emissive: 0xffb300, emissiveIntensity: 1.6 });
    const vkBlack = new THREE.MeshStandardMaterial({ color: 0x120a06, roughness: 0.4 });
    const vkRope = new THREE.MeshStandardMaterial({ color: 0x3a2716, roughness: 0.9 });
    const ball = new THREE.SphereGeometry(1, 14, 10);
    const vk = (geo, mat, x, y, z, parent = vikingSkin) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
    const blob = (mat, x, y, z, sx, sy, sz, parent) => { const m = vk(ball, mat, x, y, z, parent); m.scale.set(sx, sy, sz); return m; };

    // Popa redondeada (el casco moderno acaba en espejo plano)
    const SX = -6.5, SY = 0.1, SA = 1.05, SH = 0.56, SW = 1.53;
    blob(hullMat, SX, SY, 0, SA, SH, SW);
    // Tracas solapadas que rodean el casco: proa → costado → popa redonda → costado → proa
    const outline = (y, o) => {
      const k = Math.sqrt(Math.max(0.05, 1 - ((y - SY) / SH) ** 2)), w = SW + o, pts = [];
      const bez = (t, a, c, d) => (1 - t) ** 2 * a + 2 * (1 - t) * t * c + t * t * d;
      for (const s of [1, -1]) {
        const side = [];
        for (let i = 0; i <= 8; i++) { const t = i / 8; side.push(V(bez(t, 7.5 + o, 5.9, 3.3), y, s * bez(t, 0, w, w))); }
        for (let x = 2.3; x > SX; x -= 1.4) side.push(V(x, y, s * w));
        for (let i = 0; i <= 8; i++) { const a = (i / 8) * (Math.PI / 2); side.push(V(SX - (SA * k + o) * Math.sin(a), y, s * (SW * k + o + (w - SW * k - o) * (1 - Math.sin(a)) ** 3) * Math.cos(a))); }
        pts.push(...(s > 0 ? side : side.reverse().slice(1, -1)));
      }
      return new THREE.CatmullRomCurve3(pts, true);
    };
    [[-0.26, vkWoodB], [-0.06, vkWoodA], [0.14, vkWoodB], [0.33, vkRed], [0.5, vkWoodA]].forEach(([y, mat]) => {
      const m = new THREE.Mesh(new THREE.TubeGeometry(outline(y, 0.02), 220, 0.085, 6, true), mat); m.scale.y = 0.85; m.position.y = y * 0.15; vikingSkin.add(m);
    });
    vikingSkin.add(new THREE.Mesh(new THREE.TubeGeometry(outline(0.64, 0), 220, 0.06, 8, true), vkGold));

    // Cadena de "escamas" que forma el cuello del dragón y la cola, con crestas doradas
    const chain = (curve, n, r0, r1, crest) => {
      for (let i = 0; i <= n; i++) {
        const t = i / n, p = curve.getPoint(t), r = r0 + (r1 - r0) * t;
        blob(i % 3 === 2 ? vkGold : i % 2 ? vkRed : vkWoodA, p.x, p.y, p.z, r, r, r * 0.9);
        if (crest && i % 2 === 0 && i < n) {
          const tg = curve.getTangent(t), spike = vk(new THREE.ConeGeometry(r * 0.45, r * 1.5, 8), vkGold, p.x, p.y, p.z);
          spike.quaternion.setFromUnitVectors(V(0, 1, 0), V(-tg.y, tg.x, 0).normalize().multiplyScalar(crest).add(V(-tg.x * 0.4, -tg.y * 0.4, 0)).normalize());
          spike.translateY(r * 0.9);
        }
      }
    };
    const neck = new THREE.CatmullRomCurve3([V(6.85, 0.35, 0), V(7.45, 0.9, 0), V(7.62, 1.65, 0), V(7.38, 2.3, 0), V(7.12, 2.72, 0)]);
    chain(neck, 22, 0.36, 0.22, 1);
    const head = new THREE.Group(); head.position.set(7.28, 3.08, 0); head.rotation.z = -0.15; head.scale.setScalar(1.55); vikingSkin.add(head);
    blob(vkRed, 0, 0, 0, 0.4, 0.31, 0.29, head);
    blob(vkGold, 0.08, 0.2, 0, 0.26, 0.09, 0.3, head);
    blob(vkRed, 0.42, 0.04, 0, 0.42, 0.15, 0.21, head);
    blob(vkGold, 0.82, 0.09, 0, 0.09, 0.08, 0.13, head);
    blob(vkBlack, 0.4, -0.1, 0, 0.36, 0.07, 0.16, head);
    const jaw = new THREE.Group(); jaw.position.set(0.05, -0.12, 0); jaw.rotation.z = -0.38; head.add(jaw);
    blob(vkGold, 0.36, 0, 0, 0.38, 0.07, 0.17, jaw);
    const tongue = vk(new THREE.ConeGeometry(0.05, 0.5, 6).rotateZ(-Math.PI / 2), vkRed, 0.75, 0.05, 0, jaw); tongue.rotation.y = 0.1;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        vk(new THREE.ConeGeometry(0.03, 0.12, 6).rotateX(Math.PI), vkBone, 0.3 + i * 0.13, -0.08, side * 0.14, head);
        vk(new THREE.ConeGeometry(0.03, 0.11, 6), vkBone, 0.24 + i * 0.13, 0.08, side * 0.12, jaw);
      }
      blob(vkEye, 0.2, 0.15, side * 0.22, 0.08, 0.07, 0.06, head);
      blob(vkBlack, 0.25, 0.15, side * 0.265, 0.025, 0.05, 0.02, head);
      const horn = vk(new THREE.ConeGeometry(0.07, 0.7, 8), vkGold, -0.28, 0.32, side * 0.16, head); horn.rotation.set(side * -0.25, 0, 1.15);
      const fin = vk(new THREE.ConeGeometry(0.12, 0.42, 3), vkGold, -0.1, 0.12, side * 0.3, head); fin.rotation.set(side * 1.1, 0, 1.3); fin.scale.z = 0.3;
      const whisker = new THREE.CatmullRomCurve3([V(0.7, 0.02, side * 0.18), V(0.75, -0.15, side * 0.4), V(0.55, -0.45, side * 0.5), V(0.35, -0.6, side * 0.42)]);
      head.add(new THREE.Mesh(new THREE.TubeGeometry(whisker, 12, 0.02, 5, false), vkGold));
    }
    for (const [y, r] of [[0.15, 1.35], [0, 1.5], [-0.15, 1.7]]) { const mane = vk(new THREE.ConeGeometry(0.08, 0.55, 6), vkGold, -0.32, y, 0, head); mane.rotation.z = r; }
    const tailCurve = new THREE.CatmullRomCurve3([V(-6.95, 0.35, 0), V(-7.55, 0.95, 0), V(-7.78, 1.75, 0), V(-7.55, 2.4, 0), V(-7.08, 2.6, 0), V(-6.85, 2.3, 0), V(-7.02, 2.02, 0), V(-7.3, 2.12, 0)]);
    chain(tailCurve, 26, 0.34, 0.09, 1);
    blob(vkGold, -7.3, 2.12, 0, 0.14, 0.14, 0.14);

    // Escudos pintados colgados de la borda (con aro de hierro y umbo)
    const shieldTex = [['#c62828', '#f4ecd8', 'quarter'], ['#1e4f9a', '#f2c14e', 'half'], ['#f4ecd8', '#2e7d32', 'cross'], ['#f2c14e', '#8e1b1b', 'spiral']].map(([a, c, kind]) => canvasTex(128, 128, (g, w) => {
      const r = w / 2; g.fillStyle = a; g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill(); g.fillStyle = c;
      if (kind === 'quarter') { for (const q of [0, 2]) { g.beginPath(); g.moveTo(r, r); g.arc(r, r, r, q * Math.PI / 2, (q + 1) * Math.PI / 2); g.fill(); } }
      else if (kind === 'half') { g.beginPath(); g.moveTo(r, r); g.arc(r, r, r, -Math.PI / 2, Math.PI / 2); g.fill(); }
      else if (kind === 'cross') { g.fillRect(r - 12, 0, 24, w); g.fillRect(0, r - 12, w, 24); }
      else { g.lineWidth = 12; g.strokeStyle = c; for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(r, r, r * 0.62, k * 2.09, k * 2.09 + 1.7); g.stroke(); } }
      for (let i = 0; i < 9; i++) { g.fillStyle = 'rgba(60,30,10,.12)'; g.fillRect(0, i * 14 + 3, w, 3); }
    }));
    const shieldGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.05, 28).rotateX(Math.PI / 2);
    const rimGeo = new THREE.TorusGeometry(0.44, 0.035, 6, 28), bossGeo = new THREE.SphereGeometry(0.09, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2);
    for (const s of [-1, 1]) for (const [i, x] of [-5.4, -4.35, -3.3, -2.25, -1.2, -0.15, 0.9, 1.95, 3.0].entries()) {
      const face = new THREE.MeshStandardMaterial({ map: shieldTex[(i + (s > 0 ? 0 : 2)) % 4], roughness: 0.55 });
      const shield = new THREE.Group(); shield.position.set(x, 0.62, s * 1.6); shield.rotation.x = -s * 0.5; vikingSkin.add(shield);
      vk(shieldGeo, [vkWoodB, face, face], 0, 0, 0, shield);
      vk(rimGeo, vkIron, 0, 0, s * 0.03, shield);
      const boss = vk(bossGeo, vkIron, 0, 0, s * 0.03, shield); if (s < 0) boss.rotation.y = Math.PI;
    }

    // Remos que salen por debajo de los escudos y bogan al compás
    const oars = [];
    const oarShaft = new THREE.CylinderGeometry(0.045, 0.05, 1.45, 6).rotateX(Math.PI / 2), oarBlade = new THREE.BoxGeometry(0.06, 0.26, 0.5);
    for (const s of [-1, 1]) for (const x of [-4.87, -3.82, -2.77, -1.72, -0.67, 0.38, 1.43, 2.48]) {
      const pivot = new THREE.Group(); pivot.position.set(x, 0.12, s * 1.6); vikingSkin.add(pivot);
      const arm = new THREE.Group(); arm.rotation.x = s * 0.75; pivot.add(arm);
      vk(oarShaft, vkWoodA, 0, 0, s * 0.72, arm); vk(oarBlade, vkRed, 0, 0, s * 1.5, arm);
      oars.push({ pivot, arm, s });
    }

    // Bancos de remeros y cofres en cubierta
    for (const [x, w] of [[-6.0, 2.1], [-3.0, 2.3], [3.0, 2.3], [5.7, 1.5]]) {
      vk(new THREE.BoxGeometry(0.32, 0.1, w), vkWoodB, x, DY + 0.08, 0);
      for (const s of [-1, 1]) vk(new THREE.BoxGeometry(0.34, 0.03, 0.05), vkGold, x, DY + 0.14, s * (w / 2 - 0.12));
    }
    for (const [x, z] of [[-5.2, 0.75], [5.0, -0.6]]) {
      vk(new THREE.BoxGeometry(0.6, 0.32, 0.4), vkRed, x, DY + 0.16, z);
      vk(new THREE.BoxGeometry(0.64, 0.05, 0.44), vkGold, x, DY + 0.33, z);
    }
    // Mástil, verga, jarcia y vela hinchada por el viento. El aparejo se inclina hacia popa (lejos de los cañones)
    // para que la vela mire a la cámara cenital y luzca entera.
    const RAKE = 0.55, rig = new THREE.Group(); rig.position.y = DY; rig.rotation.x = -sign * RAKE; vikingSkin.add(rig);
    vk(new THREE.CylinderGeometry(0.08, 0.12, 4.6, 12), vkWoodB, 0, 2.3, 0, rig);
    vk(new THREE.CylinderGeometry(0.06, 0.06, 5.5, 10).rotateZ(Math.PI / 2), vkWoodB, 0, 4.2, 0, rig);
    for (const x of [-2.75, 2.75]) blob(vkGold, x, 4.2, 0, 0.1, 0.1, 0.1, rig);
    blob(vkGold, 0, 4.62, 0, 0.13, 0.13, 0.13, rig);
    const rigPoint = (y) => V(0, DY + y * Math.cos(RAKE), -sign * y * Math.sin(RAKE));
    const rope = (a, b) => { const d = b.clone().sub(a), m = vk(new THREE.CylinderGeometry(0.014, 0.014, d.length(), 4), vkRope, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); m.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize()); };
    rope(rigPoint(4.5), V(6.7, DY + 0.05, 0)); rope(rigPoint(4.5), V(-6.6, DY + 0.05, 0));
    const sailTex = canvasTex(272, 200, (g, w, h) => {
      const n = 7, sw = w / n;
      for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? '#f3e8cf' : '#b3171d'; g.fillRect(i * sw, 0, sw + 1, h); }
      for (let y = 0; y < h; y += 4) { g.fillStyle = `rgba(80,40,10,${0.04 + Math.random() * 0.05})`; g.fillRect(0, y, w, 1); }
      g.strokeStyle = '#5a2e12'; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8);
      const cx = w / 2, cy = h / 2;
      g.fillStyle = '#2a140a'; g.beginPath(); g.arc(cx, cy, 52, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#f2c14e'; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, 52, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 5; g.lineJoin = 'round';
      for (let k = 0; k < 3; k++) {
        const a0 = k * (Math.PI * 2 / 3), ox = Math.cos(a0 - Math.PI / 2) * 9, oy = Math.sin(a0 - Math.PI / 2) * 9;
        g.beginPath();
        for (let j = 0; j < 3; j++) { const a = a0 + j * (Math.PI * 2 / 3) - Math.PI / 2; g.lineTo(cx + ox + Math.cos(a) * 30, cy + oy + Math.sin(a) * 30); }
        g.closePath(); g.stroke();
      }
    });
    const sailGeo = new THREE.PlaneGeometry(5.2, 3.0, 24, 12), sp = sailGeo.attributes.position;
    for (let i = 0; i < sp.count; i++) { const u = sp.getX(i) / 2.6, v = sp.getY(i) / 1.5; sp.setZ(i, sign * 0.55 * (1 - u * u) * (1 - 0.3 * (v - 0.2) ** 2)); }
    sailGeo.computeVertexNormals();
    const sail = vk(sailGeo, new THREE.MeshStandardMaterial({ map: sailTex, side: THREE.DoubleSide, roughness: 0.88 }), 0, 2.68, 0, rig);
    if (sign < 0) sail.scale.x = -1; // el rival está girado: así el emblema no sale en espejo
    vikingSkin.visible = false; wrap.add(vikingSkin);

    const box = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); modern.add(m); return m; };
    const cyl = (r0, r1, h, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, 16), mat); m.position.set(x, y, z); modern.add(m); return m; };

    // Barandillas
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.3, 0.03), steel, 40);
    let rn = 0;
    for (const s of [-1, 1]) {
      box(9.2, 0.025, 0.025, steel, -1.4, DY + 0.3, s * 1.13);
      for (let i = 0; i < 19; i++) { m4.makeTranslation(-5.9 + i * 0.5, DY + 0.15, s * 1.13); posts.setMatrixAt(rn++, m4); }
    }
    modern.add(posts);

    // Puente de mando, chimenea y mástil
    box(1.5, 0.9, 1.3, steel, 0, DY + 0.45, 0.1);
    box(1.1, 0.6, 1.0, steel, 0, DY + 1.2, 0.1);
    box(1.12, 0.16, 0.04, glass, 0, DY + 1.28, -0.42);
    box(0.04, 0.16, 0.8, glass, -0.56, DY + 1.28, 0.1); box(0.04, 0.16, 0.8, glass, 0.56, DY + 1.28, 0.1);
    box(1.52, 0.12, 0.04, glass, 0, DY + 0.55, -0.56);
    box(1.6, 0.08, 1.4, dark, 0, DY + 0.92, 0.1);
    const funnel = cyl(0.26, 0.32, 1.0, steel, 0, DY + 1.0, 0.65); funnel.rotation.x = -0.12;
    cyl(0.335, 0.335, 0.1, whiteM, 0, DY + 1.18, 0.66);
    cyl(0.27, 0.27, 0.12, dark, 0, DY + 1.5, 0.7);
    cyl(0.04, 0.06, 2.0, dark, 0, DY + 2.2, 0.1);
    box(1.1, 0.05, 0.05, dark, 0, DY + 2.55, 0.1);
    const radar = box(0.95, 0.07, 0.22, steel, 0, DY + 3.2, 0.1);
    for (const x of [-0.7, 0.7]) { cyl(0.07, 0.07, 0.16, dark, x, DY + 1.1, -0.5).rotation.x = Math.PI / 2; }
    // Bandera en proa: asta en la punta de la cubierta y la tela ondea hacia popa
    const flagGeo = new THREE.PlaneGeometry(1.5, 1.1, 14, 1); flagGeo.translate(who === 'op' ? 0.75 : -0.75, 0, 0);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.9, 8), dark); pole.position.set(6.2, DY + 0.95, 0); modern.add(pole);
    const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: 0xdddddd, side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(6.2, DY + 1.5, 0);
    if (who === 'op') flag.rotation.y = Math.PI; // el barco rival está girado: así la bandera no se ve al revés
    wrap.add(flag);
    const flagBase = Float32Array.from(flagGeo.attributes.position.array);

    // Salvavidas de la ruleta: aro blanco y rojo colgado en la popa, inclinado hacia fuera
    const buoy = new THREE.Group(); buoy.visible = false; wrap.add(buoy);
    {
      const ringW = new THREE.MeshStandardMaterial({ color: 0xf5f5f0, roughness: 0.45 });
      const ringR = new THREE.MeshStandardMaterial({ color: 0xe5262b, roughness: 0.45, emissive: 0x3a0505, emissiveIntensity: 0.25 });
      const ring = new THREE.Group(); buoy.add(ring);
      for (let i = 0; i < 8; i++) {
        const arc = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.13, 10, 8, Math.PI / 4 + 0.01), i % 2 ? ringW : ringR);
        arc.rotation.z = (i * Math.PI) / 4; ring.add(arc);
      }
      const rope = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.022, 5, 32), new THREE.MeshStandardMaterial({ color: 0xd8c08a, roughness: 0.9 }));
      ring.add(rope);
      for (let i = 0; i < 4; i++) {
        const tie = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.02, 5, 10), rope.material);
        const a = (i * Math.PI) / 2 + Math.PI / 4; tie.position.set(Math.cos(a) * 0.48, Math.sin(a) * 0.48, 0); tie.rotation.z = a; tie.rotation.x = Math.PI / 2; ring.add(tie);
      }
      ring.rotation.set(0, Math.PI / 2, 0); // plano del aro mirando a popa (-x)
      buoy.rotation.z = 0.75; // se apoya hacia fuera para verse desde la cámara alta
      buoy.position.set(-6.45, DY + 0.32, 0);
    }

    // Casetas con ametralladoras antiaéreas
    box(1.0, 0.45, 1.0, steel, -5.3, DY + 0.22, 0);
    box(0.8, 0.3, 0.8, steel, 5.0, DY + 0.15, 0);
    for (const [x, y] of [[-5.3, DY + 0.5], [5.0, DY + 0.32]]) {
      cyl(0.2, 0.24, 0.12, steel, x, y, 0);
      for (const bx of [-0.07, 0.07]) { const br = cyl(0.025, 0.025, 0.7, barrelMat, x + bx, y + 0.1, -0.4); br.rotation.x = Math.PI / 2; }
    }
    for (const x of [-3.2, 3.2]) for (const z of [-1.0, 1.0]) {
      const lb = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.75, 4, 10), dark);
      lb.rotation.z = Math.PI / 2; lb.position.set(x, DY + 0.18, z); modern.add(lb);
    }

    // Torretas con armadura angular y cañones dobles
    const tsh = new THREE.Shape();
    tsh.moveTo(-0.62, -0.45); tsh.lineTo(0.62, -0.45); tsh.lineTo(0.5, 0.2); tsh.lineTo(0.28, 0.58); tsh.lineTo(-0.28, 0.58); tsh.lineTo(-0.5, 0.2); tsh.lineTo(-0.62, -0.45);
    const turretGeo = new THREE.ExtrudeGeometry(tsh, { depth: 0.45, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2 }).rotateX(-Math.PI / 2);
    const turrets = LANE_X.map((lx, i) => {
      const t = new THREE.Group(); t.position.set(sign * lx, DY, 0); wrap.add(t);
      const baseM = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.78, 0.22, 28), steel); baseM.position.y = 0.11; t.add(baseM);
      const tMat = turretMat.clone();
      const body = new THREE.Mesh(turretGeo, tMat); body.position.y = 0.22; t.add(body);
      const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.05, 14), dark); hatch.position.set(0, 0.76, 0.25); t.add(hatch);
      const finder = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.08, 0.12), steel); finder.position.set(0, 0.74, -0.05); t.add(finder);
      for (const sx of [-0.4, 0.4]) { const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 10).rotateZ(Math.PI / 2), dark); lens.position.set(sx, 0.74, -0.05); t.add(lens); }
      const barrels = new THREE.Group(); barrels.position.y = 0.5; t.add(barrels);
      for (const bx of [-0.2, 0.2]) {
        const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.3, 14).rotateX(Math.PI / 2), dark); sleeve.position.set(bx, 0, -0.5); barrels.add(sleeve);
        const br = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, 2.1, 14).rotateX(Math.PI / 2), barrelMat); br.position.set(bx, 0, -1.3); barrels.add(br);
        for (const cz of [-1.0, -1.7]) { const col = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.08, 14).rotateX(Math.PI / 2), dark); col.position.set(bx, 0, cz); barrels.add(col); }
        const mb = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.24, 14).rotateX(Math.PI / 2), dark); mb.position.set(bx, 0, -2.3); barrels.add(mb);
      }
      const num = numberSprite(i + 1); num.position.set(0, 1.95, 0.35); t.add(num);
      return { barrels, node: t, tMat, num, broken: false, acc: 0 };
    });

    const foam = new THREE.Mesh(new THREE.PlaneGeometry(16.6, 4.6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: foamTex, transparent: true, opacity: 0.7, depthWrite: false }));
    foam.position.set(0.4, 0.17, 0); foam.renderOrder = 3; g.add(foam);

    g.position.z = zOf(who) * SHIP_Z;
    if (who === 'op') g.rotation.y = Math.PI;
    scene.add(g);
    applyModelShadows(g);
    return { g, wrap, hullMat, steel, turrets, radar, flag, flagBase, buoy, flagHome: flag.position.clone(), flagMast: V(0, DY + 4.95 * Math.cos(0.55), -sign * 4.95 * Math.sin(0.55)), modern, oars, sail, skins: { dragon: dragonSkin, gondola: gondolaSkin, santa: santaSkin, ice: iceSkin, lava: lavaSkin, gold: goldSkin, viking: vikingSkin }, palette, base, red, ratio: 1, smokeAcc: 0, puffAcc: 0, phase: who === 'me' ? 0 : 2, hitT: 0, off: 0 };
  }

  // ---------- Tiburones ----------
  function buildUmbrella() {
    const dark = new THREE.MeshStandardMaterial({ color: 0x3b2a20, roughness: 0.6 });
    const g = new THREE.Group();
    const canopy = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const seg = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 10, (i * Math.PI) / 4, Math.PI / 4, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: i % 2 ? 0xfff3e0 : 0xe53935, side: THREE.DoubleSide, roughness: 0.7 }));
      seg.scale.y = 0.5; canopy.add(seg);
    }
    canopy.add(new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.035, 6, 40).rotateX(Math.PI / 2), dark));
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.25, 8), dark); tip.position.y = 0.8; canopy.add(tip);
    canopy.position.y = 2.1; g.add(canopy);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.1, 8), dark); handle.position.y = 1.05; g.add(handle);
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), dark));
    g.visible = false;
    return { g, canopy };
  }

  function buildShark(who) {
    const root = new THREE.Group();
    const rig = new THREE.Group();
    root.add(rig);
    const finMat = new THREE.MeshPhysicalMaterial({ color: who === 'mid' ? 0x1a222a : 0x56626e, metalness: 0.15, roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.3, emissive: 0x000000 });
    const skin = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.25, emissive: 0x000000 });
    const white = new THREE.MeshStandardMaterial({ color: 0xeef3f6, roughness: 0.45 });
    const black = new THREE.MeshStandardMaterial({ color: 0x0b1318, roughness: 0.7 });

    // Sombreado: lomo oscuro y vientre blanco
    const topC = new THREE.Color(who === 'mid' ? 0x10161d : 0x3a4752), bellyC = new THREE.Color(0xe6ecef), tmp = new THREE.Color();
    const countershade = (geo) => {
      geo.computeVertexNormals();
      const n = geo.attributes.normal, c = new Float32Array(n.count * 3);
      for (let i = 0; i < n.count; i++) {
        tmp.copy(topC).lerp(bellyC, THREE.MathUtils.smoothstep(-n.getY(i), -0.1, 0.45));
        c[i * 3] = tmp.r; c[i * 3 + 1] = tmp.g; c[i * 3 + 2] = tmp.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return geo;
    };
    const lathe = (pts) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 36).rotateZ(-Math.PI / 2);
    const fin = (shape, depth) => new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 20 });

    // Cuerpo fusiforme
    const bodyGeo = countershade(lathe([[0, -2.7], [0.09, -2.55], [0.16, -2.2], [0.3, -1.6], [0.5, -0.9], [0.62, -0.2], [0.62, 0.45], [0.55, 0.9], [0.4, 1.15], [0, 1.2]]).scale(1, 0.85, 0.95));
    const body = new THREE.Mesh(bodyGeo, skin); body.position.y = -0.6; rig.add(body);

    // Aleta dorsal, segunda dorsal, pectorales y cola
    const fs = new THREE.Shape();
    fs.moveTo(-0.7, 0); fs.bezierCurveTo(-0.35, 0.55, 0.0, 1.15, 0.45, 1.75);
    fs.bezierCurveTo(0.42, 1.15, 0.6, 0.45, 0.95, 0); fs.quadraticCurveTo(0.1, 0.18, -0.7, 0);
    const dorsal = new THREE.Mesh(fin(fs, 0.1), finMat); dorsal.position.set(-0.3, -0.05, -0.05); rig.add(dorsal);
    const dorsal2 = new THREE.Mesh(fin(fs, 0.1), finMat); dorsal2.scale.setScalar(0.22); dorsal2.position.set(-1.5, -0.12, -0.012); rig.add(dorsal2);
    const ps = new THREE.Shape();
    ps.moveTo(0.35, 0); ps.lineTo(-0.35, 0); ps.lineTo(-0.95, -0.95); ps.lineTo(-0.2, -0.55); ps.lineTo(0.35, 0);
    for (const s of [-1, 1]) {
      const pf = new THREE.Mesh(fin(ps, 0.04), finMat);
      pf.rotation.x = -s * (Math.PI / 2 - 0.35); pf.position.set(0.35, -0.8, s * 0.45); rig.add(pf);
    }
    const ts = new THREE.Shape();
    ts.moveTo(0, 0); ts.lineTo(-0.6, 1.4); ts.lineTo(-0.4, 0.2); ts.lineTo(-0.5, -0.75); ts.lineTo(0, 0);
    const tail = new THREE.Mesh(fin(ts, 0.07), finMat); tail.position.set(-2.6, -0.62, -0.035); rig.add(tail);

    // Branquias
    for (const s of [-1, 1]) for (let i = 0; i < 5; i++) {
      const gl = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.3, 0.015), black);
      gl.position.set(0.05 + i * 0.12, -0.5, s * 0.58); gl.rotation.z = 0.25; rig.add(gl);
    }

    // Cabeza con boca entreabierta, dientes y ojos
    const head = new THREE.Group(); head.position.set(1.55, -0.8, 0); rig.add(head);
    head.add(new THREE.Mesh(countershade(lathe([[0, -0.8], [0.45, -0.75], [0.55, -0.3], [0.52, 0.2], [0.4, 0.6], [0.22, 0.9], [0, 1.05]]).scale(1, 0.8, 0.9)), skin));
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), black);
    mouth.scale.set(0.5, 0.07, 0.34); mouth.position.set(0.15, -0.23, 0); head.add(mouth);
    for (let i = 0; i < 7; i++) {
      const a = THREE.MathUtils.degToRad(-75 + i * 25);
      const x = 0.15 + 0.5 * Math.cos(a), z = 0.34 * Math.sin(a);
      const up = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.13, 6), white); up.rotation.z = Math.PI; up.position.set(x, -0.2, z); head.add(up);
      const lo = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.11, 6), white); lo.position.set(x, -0.27, z); head.add(lo);
    }
    for (const z of [-0.47, 0.47]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8), new THREE.MeshStandardMaterial({ color: 0x030507, roughness: 0.1, metalness: 0.3 }));
      eye.position.set(0.38, 0.12, z); head.add(eye);
      const hl = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      hl.position.set(0.41, 0.15, z * 1.04); head.add(hl);
    }
    if (who === 'mid') { // la ballena extra es una orca con mancha blanca tras el ojo
      for (const z of [-0.43, 0.43]) {
        const patch = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), white);
        patch.scale.set(0.2, 0.07, 0.12); patch.position.set(0.1, 0.19, z); head.add(patch);
      }
    }
    const umb = buildUmbrella(); umb.g.position.set(-0.3, -0.1, 0); head.add(umb.g);

    root.position.set(0, 0, zOf(who) * FIN_Z);
    root.scale.setScalar(who === 'mid' ? 1.7 : 1.3);
    scene.add(root);
    applyModelShadows(root);
    if (who === 'mid') root.visible = false;
    return { root, rig, head, finMat, skin, umb: umb.g, canopy: umb.canopy, base: new THREE.Color(who === 'mid' ? 0x1a222a : 0x56626e), red: new THREE.Color(0xdc1414),
      dead: false, swimming: false, away: who === 'mid', pending: null, ratio: 1, wakeAcc: 0, hitT: 0 };
  }

  const ships = { me: buildShip('me'), op: buildShip('op') };
  const sharks = { me: buildShark('me'), op: buildShark('op'), mid: buildShark('mid') };

  // ---------- API: salud y movimiento ----------
  const whiteC = new THREE.Color(1, 1, 1), skinRed = new THREE.Color(1, 0.35, 0.3);
  function setHealth(h) {
    for (const who of ['me', 'op']) {
      const s = ships[who], k = sharks[who];
      s.ratio = h[who].ship; k.ratio = h[who].shark;
      s.hullMat.color.copy(s.base).lerp(s.red, 1 - s.ratio);
      s.steel.color.copy(s.palette.steel).lerp(s.red, (1 - s.ratio) * 0.45);
      k.finMat.color.copy(k.base).lerp(k.red, 1 - k.ratio);
      k.skin.color.copy(whiteC).lerp(skinRed, 1 - k.ratio);
      if (k.ratio > 0 && k.dead) { // revancha: el tiburón vuelve
        k.dead = false; k.root.visible = true; k.rig.position.y = 0;
      }
      if (k.ratio <= 0 && !k.dead) {
        k.dead = true;
        const y0 = k.rig.position.y;
        tween(900, (t) => { k.rig.position.y = y0 - 3.2 * t; }, easeIn).then(() => { k.root.visible = false; });
      }
    }
  }

  function setLifebuoy(who, on) { if (ships[who]) ships[who].buoy.visible = !!on; }

  function setShipLevel(who, level, skin = null) {
    const ship = ships[who];
    if (!ship) return;
    const currentLevel = Number(level) || 1;
    const style = skin === 'viking' ? { skin: 'viking', hull: 0x5d3a1e, steel: 0x8d6e4c, turret: 0x9e8062, emissive: 0x000000, intensity: 0 }
      : currentLevel >= 30 ? { skin: 'gold', hull: 0xc79b35, steel: 0xffd778, turret: 0xf6c75a, emissive: 0x5b3d09, intensity: 0.16 }
      : currentLevel >= 25 ? { skin: 'lava', hull: 0x352024, steel: 0x743b2b, turret: 0x9d4f2b, emissive: 0xff3300, intensity: 0.46 }
        : currentLevel >= 20 ? { skin: 'ice', hull: 0xa8dce9, steel: 0xe7fbff, turret: 0xbee5f1, emissive: 0x297994, intensity: 0.17 }
          : currentLevel >= 15 ? { skin: 'santa', hull: 0x70472d, steel: 0xb58953, turret: 0xd0b072, emissive: 0x000000, intensity: 0 }
            : currentLevel >= 10 ? { skin: 'gondola', hull: 0x171923, steel: 0xc9a55f, turret: 0xdec675, emissive: 0x000000, intensity: 0 }
              : currentLevel >= 5 ? { skin: 'dragon', hull: 0x77333a, steel: 0xc99f4b, turret: 0xc4a259, emissive: 0x240607, intensity: 0.08 }
                : { skin: null, hull: 0x7d8a96, steel: 0x8e99a1, turret: 0xa4afb6, emissive: 0x000000, intensity: 0 };
    for (const [name, group] of Object.entries(ship.skins)) group.visible = name === style.skin;
    const viking = style.skin === 'viking';
    ship.modern.visible = !viking;
    ship.flag.position.copy(viking ? ship.flagMast : ship.flagHome);
    ship.flag.scale.setScalar(viking ? 0.75 : 1);
    ship.palette.hull.set(style.hull);
    ship.palette.steel.set(style.steel);
    ship.palette.turret.set(style.turret);
    ship.palette.emissive.set(style.emissive);
    ship.palette.emissiveIntensity = style.intensity;
    ship.base.copy(ship.palette.hull);
    ship.hullMat.color.copy(ship.base).lerp(ship.red, 1 - ship.ratio);
    ship.hullMat.emissive.copy(ship.palette.emissive);
    ship.hullMat.emissiveIntensity = ship.palette.emissiveIntensity;
    ship.steel.color.copy(ship.palette.steel).lerp(ship.red, (1 - ship.ratio) * 0.45);
    for (const turret of ship.turrets) {
      const health = turret.hp ?? 25;
      turret.tMat.color.copy(ship.palette.turret).lerp(new THREE.Color(0x5a2a22), (1 - Math.max(0, health / 25)) * 0.85);
    }
  }

  async function moveFin(who, lane) {
    const s = sharks[who];
    if (s.pending) await s.pending;
    const toX = LANE_X[lane - 1], fromX = s.root.position.x, z = s.root.position.z;
    if (s.dead || s.away || Math.abs(toX - fromX) < 0.01) return;
    const dir = toX > fromX ? 1 : -1;
    ripple(fromX, z, 2.6);
    await tween(380, (t) => { s.rig.position.y = -1.9 * t; }, easeIn);
    s.rig.scale.x = dir;
    s.swimming = true;
    await tween(750, (t) => { s.root.position.x = fromX + (toX - fromX) * t; }, easeInOut);
    s.swimming = false;
    ripple(toX, z, 3);
    (async () => {
      await tween(330, (t) => { s.head.position.y = -0.8 + 0.88 * t; }, easeOut);
      await wait(520);
      await tween(380, (t) => { s.head.position.y = 0.08 - 0.88 * t; }, easeIn);
    })();
    await tween(420, (t) => { s.rig.position.y = -1.9 * (1 - t); }, easeOut);
  }

  // Oleaje: el barco se desplaza lateralmente (o = unidades de 1,5 hacia la derecha)
  function moveShip(who, o) {
    const s = ships[who];
    if (s.off === o) return Promise.resolve();
    s.off = o;
    const from = s.g.position.x, to = o * UNIT;
    return tween(700, (t) => { s.g.position.x = from + (to - from) * t; }, easeInOut);
  }

  // Lluvia: los tiburones sacan un paraguas y se marchan; vuelven al terminar la ronda
  function sharkLeave(who, umbrella = true) {
    const s = sharks[who];
    if (s.dead || s.away) return;
    s.away = true; s.umbrella = umbrella;
    if (!umbrella) return sharkFlee(s);
    const prev = s.pending;
    s.pending = (async () => {
      if (prev) await prev;
      const x0 = s.root.position.x, dir = x0 >= 0 ? 1 : -1, y0 = s.rig.position.y;
      await tween(300, (t) => { s.rig.position.y = y0 * (1 - t); });
      s.rig.scale.x = dir;
      await tween(380, (t) => { s.head.position.y = -0.8 + 0.88 * t; }, easeOut);
      s.canopy.scale.set(0.12, 1.6, 0.12); s.umb.visible = true;
      await tween(700, (t) => { s.canopy.scale.set(0.12 + 0.88 * t, 1.6 - 0.6 * t, 0.12 + 0.88 * t); }, easeOut);
      await tween(600, (t) => { s.rig.rotation.z = Math.sin(t * Math.PI * 4) * 0.08; });
      s.rig.rotation.z = 0;
      s.swimming = true;
      await tween(2600, (t) => { s.root.position.x = x0 + (dir * 13 - x0) * t; s.rig.position.y = Math.sin(t * 14) * 0.04; }, easeIn);
      s.swimming = false; s.root.visible = false;
    })();
  }
  // susto: la aleta da un respingo, salpica y huye a toda velocidad
  function sharkFlee(s) {
    const prev = s.pending;
    s.pending = (async () => {
      if (prev) await prev;
      const x0 = s.root.position.x, dir = x0 >= 0 ? 1 : -1, z = s.root.position.z;
      await tween(260, (t) => { s.rig.position.y = 0.5 * Math.sin(t * Math.PI); s.rig.rotation.z = Math.sin(t * 30) * 0.2; });
      s.rig.rotation.z = 0; s.rig.scale.x = dir;
      ripple(x0, z, 4); spawn({ pos: V(x0, 0.3, z), tex: smokeTex, vel: V(0, 3, 0), grav: 8, life: 0.8, s0: 0.6, s1: 1.6, color: 0xf2fbff, op: 0.9 });
      s.swimming = true;
      await tween(1500, (t) => { s.root.position.x = x0 + (dir * 14 - x0) * t; }, easeIn);
      s.swimming = false; s.root.visible = false;
    })();
  }
  function sharkReturn(who) {
    const s = sharks[who];
    if (!s.away) return;
    s.away = false;
    const prev = s.pending;
    s.pending = (async () => {
      if (prev) await prev;
      if (s.dead) return;
      const dir = s.rig.scale.x, x0 = dir * 13;
      s.root.position.x = x0; s.root.visible = true; s.rig.position.y = 0; s.rig.scale.x = -dir;
      const umb = s.umbrella !== false;
      s.canopy.scale.set(1, 1, 1); s.umb.visible = umb;
      s.swimming = true;
      await tween(2200, (t) => { s.root.position.x = x0 * (1 - t); }, easeOut);
      s.swimming = false;
      if (umb) {
        await tween(500, (t) => { s.canopy.scale.set(1 - 0.88 * t, 1 + 0.6 * t, 1 - 0.88 * t); }, easeIn);
        s.umb.visible = false;
        await tween(380, (t) => { s.head.position.y = 0.08 - 0.88 * t; }, easeIn);
      }
      s.pending = null;
    })();
  }

  // Ballena extra (ronda 7): llega nadando, se coloca en medio del mar y se va al terminar
  function whaleArrive() {
    const s = sharks.mid;
    const prev = s.pending;
    s.pending = (async () => {
      if (prev) await prev;
      const dir = Math.random() < 0.5 ? 1 : -1;
      s.away = false; s.root.position.x = dir * 13; s.rig.position.y = 0; s.rig.scale.x = -dir; s.root.visible = true;
      s.swimming = true;
      await tween(2200, (t) => { s.root.position.x = dir * 13 * (1 - t); }, easeOut);
      s.swimming = false;
      await tween(330, (t) => { s.head.position.y = -0.8 + 0.88 * t; }, easeOut);
      await wait(500);
      await tween(380, (t) => { s.head.position.y = 0.08 - 0.88 * t; }, easeIn);
      s.pending = null;
    })();
  }
  function whaleLeave() {
    const s = sharks.mid;
    s.away = true;
    const prev = s.pending;
    s.pending = (async () => {
      if (prev) await prev;
      const x0 = s.root.position.x, dir = x0 >= 0 ? 1 : -1;
      s.rig.scale.x = dir; s.swimming = true;
      await tween(2000, (t) => { s.root.position.x = x0 + (dir * 13 - x0) * t; }, easeIn);
      s.swimming = false; s.root.visible = false; s.pending = null;
    })();
  }

  // Tiempo según la ronda: lluvia cada 5, oleaje cada 6 y ballena extra cada 7
  let stormOn = false, roughOn = false, whaleOn = false, snowOn = false, lightningOn = false, fogOn = false, snowAmount = 0;
  let riverOn = false, mudOn = false;
  function setWeather(round) {
    const rv = round >= 20 || (round >= 5 && round <= 10);
    if (rv !== riverOn) {
      riverOn = rv;
      const from = waterMat.uniforms.uRiver.value, to = rv ? 1 : 0;
      tween(1800, (t) => { waterMat.uniforms.uRiver.value = from + (to - from) * t; }, easeInOut);
    }
    const md = round >= 35 && round <= 40;
    if (md !== mudOn) {
      mudOn = md;
      const from = waterMat.uniforms.uMud.value, to = md ? 1 : 0;
      tween(1800, (t) => { waterMat.uniforms.uMud.value = from + (to - from) * t; }, easeInOut);
    }
    const st = round % 5 === 0 && round !== 15, ro = round % 6 === 0, wh = round % 7 === 0;
    const sn = round === 15, bolt = round === 25, fg = round === 35;
    if (wh !== whaleOn) { whaleOn = wh; wh ? whaleArrive() : whaleLeave(); }
    const special = !api.isTutorial?.(), warOn = special && [11, 22, 33].includes(round), isleOn = special && round === 9;
    warOn ? warshipArrive() : warshipLeave();
    isleOn ? islandShow() : islandLeave();
    if (warOn || isleOn) setCalm(true);
    if (st !== stormOn) {
      stormOn = st;
      const from = storm, to = st ? 1 : 0;
      tween(2200, (t) => { storm = from + (to - from) * t; }, easeInOut);
      for (const w of ['me', 'op']) st ? sharkLeave(w) : !calmOn && sharkReturn(w);
    }
    if (!warOn && !isleOn) setCalm(false);
    if (ro !== roughOn) {
      roughOn = ro;
      const from = rough, to = ro ? 1 : 0;
      tween(2200, (t) => { rough = from + (to - from) * t; }, easeInOut);
    }
    if (sn !== snowOn) {
      snowOn = sn;
      tween(1200, (t) => { snowAmount = sn ? t : 1 - t; }, easeInOut);
    }
    if (bolt && !lightningOn) nextBolt = 0.5;
    lightningOn = bolt;
    fogOn = fg;
    fogOverlay.style.opacity = fg ? '1' : '0';
  }

  // ---------- Efectos de impacto ----------
  function sparks(p, n, speed, color = 0xffd27a) {
    for (let i = 0; i < n; i++) {
      const v = V(rnd(-1, 1), rnd(-0.2, 1.2), rnd(-1, 1)).normalize().multiplyScalar(rnd(speed * 0.4, speed));
      spawn({ pos: p, vel: v, grav: 9, life: rnd(0.6, 1.3), s0: 0.22, s1: 0.04, add: true, color });
    }
  }
  function explodeShip(p) {
    flashLight(p, 90);
    spawn({ pos: p, life: 0.28, s0: 1.2, s1: 8, add: true, color: 0xfff1b8 });
    for (let i = 0; i < 16; i++) {
      spawn({ pos: p, vel: V(rnd(-2.6, 2.6), rnd(0.8, 4), rnd(-2.6, 2.6)), drag: 1.2, life: rnd(0.7, 1.2), s0: 1.2, s1: 3.6, add: true, color: i % 2 ? 0xff7a18 : 0xffc04a, op: 0.9 });
    }
    for (let i = 0; i < 12; i++) {
      spawn({ pos: p, tex: smokeTex, vel: V(rnd(-1.2, 1.2), rnd(0.8, 2.2), rnd(-1.2, 1.2)), drag: 0.5, life: rnd(2.2, 3.4), s0: 1.5, s1: 5.2, color: 0x2a2a2a, op: 0.75 });
    }
    sparks(p, 40, 7);
    ripple(p.x, p.z, 11);
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(rnd(0.1, 0.25), rnd(0.05, 0.12), rnd(0.1, 0.25)), new THREE.MeshStandardMaterial({ color: 0x2b3238, metalness: 0.6, roughness: 0.5 }));
      m.position.copy(p); scene.add(m);
      debris.push({ m, v: V(rnd(-3, 3), rnd(3, 7), rnd(-3, 3)), spin: V(rnd(-6, 6), rnd(-6, 6), rnd(-6, 6)) });
    }
    shake(0.45, 0.5);
  }
  function splash(p) {
    spawn({ pos: p, life: 0.2, s0: 0.8, s1: 3.5, add: true, color: 0xbfe3ff });
    for (let i = 0; i < 26; i++) {
      spawn({ pos: p, tex: smokeTex, vel: V(rnd(-1.3, 1.3), rnd(3, 7), rnd(-1.3, 1.3)), grav: 9, life: rnd(0.9, 1.5), s0: 0.5, s1: 1.3, color: 0xdff1ff, op: 0.9 });
    }
    sparks(p, 26, 5, 0xe8f6ff);
    ripple(p.x, p.z, 5); ripple(p.x, p.z, 8, 0.15);
    shake(0.15, 0.3);
  }
  function clash(p) {
    flashLight(p, 40, 0xbfe0ff);
    spawn({ pos: p, life: 0.3, s0: 1, s1: 7, add: true, color: 0xffffff });
    spawn({ pos: p, tex: ringTex, life: 0.5, s0: 0.6, s1: 8, add: true, color: 0x9ecbff });
    sparks(p, 30, 6, 0xcfe6ff);
    for (let i = 0; i < 5; i++) spawn({ pos: p, tex: smokeTex, vel: V(rnd(-1, 1), rnd(0, 1), rnd(-1, 1)), life: 1.6, s0: 0.8, s1: 2.6, color: 0x555555, op: 0.5 });
    shake(0.12, 0.3);
  }

  function hitShip(who) { ships[who].hitT = 0.5; }
  function hitShark(who) { sharks[who].hitT = 0.5; }
  function tickShark(sk, phase, dt) {
    if (!sk.dead && !sk.swimming && !sk.away && sk.rig.position.y > -0.01) sk.rig.rotation.z = Math.sin(time * 2 + phase) * 0.04;
    if (sk.hitT > 0) {
      sk.hitT -= dt;
      sk.rig.rotation.z = Math.sin(sk.hitT * 50) * 0.3 * (sk.hitT / 0.5);
      const e = sk.hitT / 0.5;
      sk.finMat.emissive.setRGB(0.8 * e, 0.1, 0.05); sk.skin.emissive.setRGB(0.8 * e, 0.1, 0.05);
    } else { sk.finMat.emissive.setRGB(0, 0, 0); sk.skin.emissive.setRGB(0, 0, 0); }
    if (sk.swimming) {
      sk.wakeAcc += dt;
      while (sk.wakeAcc > 0.04) {
        sk.wakeAcc -= 0.04;
        spawn({ pos: V(sk.root.position.x - sk.rig.scale.x * 0.4, 0.15, sk.root.position.z + rnd(-0.3, 0.3)), tex: smokeTex, life: 0.9, s0: 0.5, s1: 1.7, color: 0xffffff, op: 0.55 });
      }
    }
  }

  // ---------- Balas ----------
  const bullets = [];
  const brass = new THREE.MeshStandardMaterial({ color: 0xd2a35a, metalness: 0.85, roughness: 0.25 });
  const shellSteel = new THREE.MeshStandardMaterial({ color: 0x3b4146, metalness: 0.9, roughness: 0.25 });
  const copper = new THREE.MeshStandardMaterial({ color: 0xb87333, metalness: 0.9, roughness: 0.3 });

  // ---------- Submarino (rondas múltiplo de 3): cruza el centro y dispara a un lado ----------
  const sub = (() => {
    const g = new THREE.Group();
    const hullM = new THREE.MeshPhysicalMaterial({ color: 0x46564c, metalness: 0.55, roughness: 0.38, clearcoat: 0.3, emissive: 0x000000 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d2522, metalness: 0.5, roughness: 0.5 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xe0b01c, roughness: 0.5 });
    const pts = [[0, -2.1], [0.32, -1.9], [0.6, -1.3], [0.72, -0.3], [0.72, 0.9], [0.58, 1.5], [0.3, 1.95], [0, 2.15]].map(([r, x]) => new THREE.Vector2(r, x));
    g.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 28).rotateZ(-Math.PI / 2).scale(1, 0.9, 1), hullM));
    const tower = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.75, 0.5), hullM); tower.position.set(0.2, 0.75, 0); g.add(tower);
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 0.42), dark); top.position.set(0.2, 1.17, 0); g.add(top);
    const peri = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.7, 8), dark); peri.position.set(0.4, 1.5, 0); g.add(peri);
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.1), dark); lens.position.set(0.5, 1.85, 0); g.add(lens);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3b30 })); lamp.position.set(0.2, 1.28, 0); g.add(lamp);
    const fin1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 1.6), dark); fin1.position.set(-1.9, 0, 0); g.add(fin1);
    const fin2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.05), dark); fin2.position.set(-1.9, 0.4, 0); g.add(fin2);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.73, 0.04, 8, 28).rotateY(Math.PI / 2), yellow); ring.position.set(1.0, 0, 0); g.add(ring);
    g.visible = false; g.position.set(0, -2.6, 0);
    scene.add(g);
    return { g, hullM, present: false, x: 0, hitT: 0, acc: 0 };
  })();
  async function subMove(wx) {
    const s = sub;
    if (!s.present) {
      s.present = true; s.g.visible = true; s.g.position.set(wx, -2.6, 0); s.x = wx;
      ripple(wx, 0, 3.4);
      await tween(700, (t) => { s.g.position.y = -2.6 + 2.6 * t; }, easeOut);
    } else if (s.x !== wx) {
      const from = s.x; s.x = wx;
      await tween(300, (t) => { s.g.position.y = -1.6 * t; }, easeIn);
      await tween(450, (t) => { s.g.position.x = from + (wx - from) * t; }, easeInOut);
      ripple(wx, 0, 3);
      await tween(300, (t) => { s.g.position.y = -1.6 * (1 - t); }, easeOut);
    }
  }
  async function subLeave() {
    const s = sub;
    if (!s.present) return;
    s.present = false;
    ripple(s.g.position.x, 0, 3.4);
    const y0 = s.g.position.y;
    await tween(700, (t) => { s.g.position.y = y0 - 2.8 * t; }, easeIn);
    s.g.visible = false;
  }

  // ---------- Icebergs (rondas de lluvia): derivan por el centro y se destruyen al recibir una bala ----------
  const iceMat = new THREE.MeshStandardMaterial({ color: 0xcfe9f7, roughness: 0.25, metalness: 0.05, emissive: 0x4a7a99, emissiveIntensity: 0.25, flatShading: true });
  const ices = [0, 1].map(() => {
    const g = new THREE.Group();
    const peak = new THREE.IcosahedronGeometry(0.95, 1);
    const pp = peak.attributes.position;
    for (let i = 0; i < pp.count; i++) pp.setXYZ(i, pp.getX(i) * rnd(0.85, 1.15), pp.getY(i) * rnd(0.9, 1.4), pp.getZ(i) * rnd(0.85, 1.15));
    peak.computeVertexNormals();
    const main = new THREE.Mesh(peak, iceMat); main.position.y = 0.35; g.add(main);
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(new THREE.IcosahedronGeometry(rnd(0.35, 0.6), 0), iceMat);
      c.position.set(rnd(-0.9, 0.9), rnd(0.05, 0.3), rnd(-0.7, 0.7)); c.rotation.set(rnd(0, 3), rnd(0, 3), rnd(0, 3)); g.add(c);
    }
    g.visible = false; g.scale.setScalar(0.01);
    scene.add(g);
    return { g, present: false };
  });
  async function iceShow(id, wx) {
    const s = ices[id];
    if (!s.present) {
      s.present = true; s.g.visible = true; s.g.position.set(wx, -0.2, 0);
      ripple(wx, 0, 3.2);
      await tween(500, (t) => { s.g.scale.setScalar(0.01 + 0.99 * t); }, easeOut);
    } else {
      const from = s.g.position.x;
      if (from === wx) return;
      ripple(from, 0, 2.2);
      await tween(800, (t) => { s.g.position.x = from + (wx - from) * t; }, easeInOut);
    }
  }
  function iceBreak(id) {
    const s = ices[id];
    if (!s || !s.present) return;
    s.present = false; s.g.visible = false;
    const p = V(s.g.position.x, 0.6, 0);
    spawn({ pos: p, life: 0.3, s0: 1, s1: 5, add: true, color: 0xe3f4ff });
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(rnd(0.08, 0.2), 0), new THREE.MeshStandardMaterial({ color: 0xdff2ff, roughness: 0.2, flatShading: true }));
      m.position.copy(p); scene.add(m);
      debris.push({ m, v: V(rnd(-3, 3), rnd(3, 7), rnd(-3, 3)), spin: V(rnd(-6, 6), rnd(-6, 6), rnd(-6, 6)) });
    }
    sparks(p, 20, 5, 0xe8f6ff);
    for (let i = 0; i < 14; i++) spawn({ pos: p, tex: smokeTex, vel: V(rnd(-1.5, 1.5), rnd(2, 5), rnd(-1.5, 1.5)), grav: 9, life: rnd(0.8, 1.3), s0: 0.5, s1: 1.2, color: 0xeaf6ff, op: 0.85 });
    ripple(p.x, 0, 6); ripple(p.x, 0, 9, 0.15);
    shake(0.2, 0.35);
  }
  function iceClear() {
    ices.forEach((s) => {
      if (!s.present) return;
      s.present = false;
      tween(400, (t) => { s.g.scale.setScalar(Math.max(0.01, 1 - t)); }, easeIn).then(() => { s.g.visible = false; });
    });
  }

  // ---------- Pulpo (ronda 2): intercepta una bala y la devuelve al rival ----------
  const octopus = (() => {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd45fa5, roughness: 0.34, metalness: 0.04, emissive: 0x321128, emissiveIntensity: 0.3 });
    const armMat = new THREE.MeshStandardMaterial({ color: 0xb84391, roughness: 0.36, metalness: 0.03, emissive: 0x281021, emissiveIntensity: 0.18 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.76, 24, 18), bodyMat);
    body.position.y = 0.66; body.scale.set(1.08, 0.82, 0.98); g.add(body);
    const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x15121a, roughness: 0.2 });
    for (const x of [-0.2, 0.2]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), eyeWhite);
      eye.position.set(x * 1.3, 0.73, 0.62); g.add(eye);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), pupilMat);
      pupil.position.set(x * 1.3, 0.71, 0.75); g.add(pupil);
    }
    for (let arm = 0; arm < 8; arm++) {
      const angle = arm * Math.PI / 4;
      const dx = Math.cos(angle), dz = Math.sin(angle);
      const curve = new THREE.CatmullRomCurve3([
        V(0, 0.22, 0), V(dx * 0.62, 0.18, dz * 0.62),
        V(dx * 1.28, -0.02, dz * 1.28), V(dx * 1.78, 0.16, dz * 1.78),
      ]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 18, 0.12, 8, false), armMat));
      for (const t of [0.42, 0.62, 0.8]) {
        const p = curve.getPoint(t);
        const sucker = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), eyeWhite);
        sucker.position.copy(p); sucker.scale.set(1, 0.35, 1); g.add(sucker);
      }
    }
    g.visible = false; g.scale.setScalar(0.01); scene.add(g);
    return { g, bodyMat, armMat, present: false, x: 0 };
  })();
  async function octopusShow(wx) {
    if (!octopus.present) {
      octopus.present = true; octopus.x = wx; octopus.g.position.set(wx, -0.2, 0);
      octopus.g.rotation.set(0, 0, 0); octopus.g.scale.setScalar(0.01); octopus.g.visible = true;
      ripple(wx, 0, 3);
      await tween(550, (t) => { octopus.g.scale.setScalar(0.01 + 1.24 * t); }, easeOut);
    }
  }
  async function octopusSpin() {
    const start = octopus.g.rotation.y;
    octopus.bodyMat.emissive.setHex(0xff5f9d);
    sparks(V(octopus.x, 0.9, 0), 18, 4, 0xff91c5);
    await tween(1000, (t) => {
      octopus.g.rotation.y = start + Math.PI * 6 * t;
      octopus.g.rotation.z = Math.sin(t * Math.PI * 6) * 0.08;
    }, easeOut);
    octopus.g.rotation.y = start;
    octopus.g.rotation.z = 0;
    octopus.bodyMat.emissive.setHex(0x321128);
  }
  async function octopusLeave() {
    if (!octopus.present) return;
    octopus.present = false;
    const wx = octopus.x;
    ripple(wx, 0, 2.4);
    await tween(350, (t) => { octopus.g.scale.setScalar(Math.max(0.01, 1 - t)); }, easeIn);
    octopus.g.visible = false;
  }

  // ---------- Botiquín: recorre los cuatro puestos y se recoge al recibir un disparo ----------
  const medkit = (() => {
    const g = new THREE.Group();
    const caseMat = new THREE.MeshPhysicalMaterial({ color: 0xf7f8f2, roughness: 0.28, metalness: 0.08, clearcoat: 0.7, clearcoatRoughness: 0.2 });
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xc8d0cf, metalness: 0.48, roughness: 0.28 });
    const crossMat = new THREE.MeshStandardMaterial({ color: 0xe32336, roughness: 0.28, metalness: 0.02, emissive: 0x8f101b, emissiveIntensity: 0.22 });
    const strapMat = new THREE.MeshStandardMaterial({ color: 0x315e68, roughness: 0.55 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.82, 0.78), caseMat); box.position.y = 0.43; g.add(box);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.16, 0.84), caseMat); lid.position.y = 0.91; g.add(lid);
    for (const x of [-0.54, 0.54]) for (const z of [-0.35, 0.35]) {
      const bumper = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), edgeMat);
      bumper.position.set(x, 0.12, z); bumper.scale.set(1, 1, 0.8); g.add(bumper);
    }
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.055, 10, 20, Math.PI), strapMat);
    handle.position.set(0, 1.04, 0); g.add(handle);
    const addCross = (x, y, z, face, scale = 1) => {
      const vertical = new THREE.Mesh(new THREE.BoxGeometry(0.22 * scale, 0.62 * scale, 0.06), crossMat);
      const horizontal = new THREE.Mesh(new THREE.BoxGeometry(0.62 * scale, 0.22 * scale, 0.06), crossMat);
      vertical.position.set(x, y, z); horizontal.position.set(x, y, z);
      if (face === 'top') { vertical.rotation.x = -Math.PI / 2; horizontal.rotation.x = -Math.PI / 2; }
      if (face === 'back') { vertical.rotation.y = Math.PI; horizontal.rotation.y = Math.PI; }
      g.add(vertical, horizontal);
    };
    addCross(0, 0.45, 0.43, 'front', 1.1);
    addCross(0, 0.45, -0.43, 'back', 1.1);
    addCross(0, 0.99, 0, 'top', 0.8);
    for (const x of [-0.37, 0.37]) {
      const latch = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.08), edgeMat);
      latch.position.set(x, 0.91, 0.43); g.add(latch);
    }
    const sideStripe = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.7, 0.8), strapMat);
    g.add(sideStripe);
    g.visible = false; g.scale.setScalar(0.01); scene.add(g);
    return { g, present: false, x: 0 };
  })();
  async function medkitShow(wx) {
    if (!medkit.present) {
      medkit.present = true; medkit.x = wx; medkit.g.position.set(wx, -0.2, 0);
      medkit.g.scale.setScalar(0.01); medkit.g.visible = true;
      ripple(wx, 0, 2.5);
      await tween(450, (t) => { medkit.g.scale.setScalar(0.01 + 1.15 * t); }, easeOut);
    } else if (medkit.x !== wx) {
      const from = medkit.x; medkit.x = wx;
      await tween(300, (t) => { medkit.g.position.x = from + (wx - from) * t; }, easeInOut);
    }
  }
  function medkitCollect() {
    if (!medkit.present) return;
    medkit.present = false;
    const p = V(medkit.x, 0.45, 0);
    medkit.g.visible = false;
    spawn({ pos: p, life: 0.3, s0: 0.5, s1: 4, add: true, color: 0x8dffb0 });
    sparks(p, 16, 4, 0x8dffb0);
    ripple(medkit.x, 0, 4);
  }
  async function medkitLeave() {
    if (!medkit.present) return;
    medkit.present = false;
    await tween(280, (t) => { medkit.g.scale.setScalar(Math.max(0.01, 1 - t)); }, easeIn);
    medkit.g.visible = false;
  }

  // ---------- Cubo flotante (ronda 8): se hunde al recibir un disparo ----------
  const bucket = (() => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.4, 0.7, 20, 1, true), new THREE.MeshStandardMaterial({ color: 0xd9531e, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide }));
    body.position.y = 0.35; g.add(body);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.4, 20).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a3513 }));
    bottom.position.y = 0.02; g.add(bottom);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.045, 8, 24).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.7, roughness: 0.3 }));
    rim.position.y = 0.7; g.add(rim);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.03, 8, 20, Math.PI), new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.7, roughness: 0.3 }));
    handle.position.y = 0.7; g.add(handle);
    g.visible = false; g.scale.setScalar(0.01); scene.add(g);
    return { g, present: false, x: 0 };
  })();
  async function bucketShow(wx) {
    if (!bucket.present) {
      bucket.present = true; bucket.x = wx; bucket.g.position.set(wx, -0.1, 0); bucket.g.rotation.set(0, 0, 0);
      bucket.g.scale.setScalar(0.01); bucket.g.visible = true;
      ripple(wx, 0, 2);
      await tween(400, (t) => { bucket.g.scale.setScalar(0.01 + 1.09 * t); }, easeOut);
    } else if (bucket.x !== wx) {
      const from = bucket.x; bucket.x = wx;
      await tween(300, (t) => { bucket.g.position.x = from + (wx - from) * t; }, easeInOut);
    }
  }
  function bucketSink() {
    if (!bucket.present) return;
    bucket.present = false;
    const p = V(bucket.x, 0.4, 0);
    sparks(p, 14, 4, 0xbfe8ff); ripple(bucket.x, 0, 4);
    tween(700, (t) => { bucket.g.position.y = -0.1 - 1.2 * t; bucket.g.rotation.z = 0.9 * t; }, easeIn).then(() => { bucket.g.visible = false; });
  }
  async function bucketLeave() {
    if (!bucket.present) return;
    bucket.present = false;
    await tween(280, (t) => { bucket.g.scale.setScalar(Math.max(0.01, 1.1 - t)); }, easeIn);
    bucket.g.visible = false;
  }

  // ---------- Gaviota, calamar y helicóptero ----------
  const frameHooks = [];
  const gull = (() => {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.6 });
    const grey = new THREE.MeshStandardMaterial({ color: 0x9fb0bd, roughness: 0.6 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xffa726, roughness: 0.5 });
    const dark = new THREE.MeshBasicMaterial({ color: 0x151515 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 10), white); body.scale.set(1.6, 0.7, 0.8); g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), white); head.position.set(0.7, 0.14, 0); g.add(head);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 8), orange); beak.rotation.z = -Math.PI / 2; beak.position.set(1.0, 0.1, 0); g.add(beak);
    for (const z of [-0.1, 0.1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), dark); eye.position.set(0.82, 0.2, z); g.add(eye); }
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.3), grey); tail.position.set(-0.75, 0.04, 0); g.add(tail);
    const wings = [-1, 1].map((side) => {
      const w = new THREE.Group();
      const inner = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.04, 0.9), white); inner.position.z = side * 0.45; w.add(inner);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.7), grey); tip.position.set(-0.05, 0, side * 1.15); w.add(tip);
      w.position.y = 0.12; g.add(w); return w;
    });
    g.visible = false; g.scale.setScalar(1.3); scene.add(g);
    const s = { g, wings, present: false, x: 0, falling: false, face: 1 };
    frameHooks.push((dt, t) => {
      if (!s.present || s.falling) return;
      const flap = Math.sin(t * 13) * 0.7;
      wings[0].rotation.x = flap; wings[1].rotation.x = -flap;
      g.rotation.z = Math.sin(t * 6.5) * 0.04;
      // el modelo mira a +x: si vuela hacia la izquierda gira 180° sobre sí misma
      const want = s.face < 0 ? Math.PI : 0;
      g.rotation.y += (want - g.rotation.y) * Math.min(1, dt * 9);
    });
    return s;
  })();
  async function gullFly(wx) {
    const s = gull;
    if (!s.present) {
      s.present = true; s.falling = false; s.g.visible = true; s.face = 1; s.g.rotation.set(0, 0, 0); s.g.scale.setScalar(1.3);
      s.g.position.set(wx - 7, 3.4, 0); s.x = wx - 7;
    }
    const from = s.g.position.x, y0 = s.g.position.y;
    if (Math.abs(wx - from) > 0.01) s.face = Math.sign(wx - from);
    s.x = wx;
    await tween(900, (t) => { s.g.position.x = from + (wx - from) * t; s.g.position.y = y0 + (1.9 - y0) * t + Math.sin(t * Math.PI) * 0.35; }, easeInOut);
  }
  async function gullLeave() {
    const s = gull;
    if (!s.present) return;
    s.present = false;
    const x0 = s.g.position.x, y0 = s.g.position.y, r0 = s.g.rotation.y;
    s.falling = false; s.face = 1;
    await tween(1000, (t) => { s.g.position.x = x0 + 8 * t; s.g.position.y = y0 + 3 * t; s.g.rotation.y = r0 * Math.max(0, 1 - t * 4); }, easeIn);
    s.g.visible = false;
  }
  async function gullShot() {
    const s = gull;
    if (!s.present) return;
    s.present = false; s.falling = true;
    const p = s.g.position.clone();
    for (let i = 0; i < 24; i++) {
      spawn({ pos: p, tex: smokeTex, vel: V(rnd(-2, 2), rnd(-0.5, 2.5), rnd(-2, 2)), grav: 3, drag: 0.8, life: rnd(1, 1.8), s0: 0.18, s1: 0.3, color: 0xffffff, op: 0.95 });
    }
    sparks(p, 12, 4, 0xffffff);
    shake(0.1, 0.25);
    const x0 = p.x, y0 = p.y, face = s.face < 0 ? -1 : 1, ry = s.g.rotation.y;
    await tween(900, (t) => {
      s.g.position.set(x0 + 0.8 * face * t, y0 - (y0 + 0.3) * t * t, 0);
      s.g.rotation.set(t * 7, ry, t * 4);
      s.wings[0].rotation.x = 0.4; s.wings[1].rotation.x = -0.4;
    }, easeIn);
    splash(V(s.g.position.x, 0.2, 0)); ripple(s.g.position.x, 0, 3.4);
    s.g.visible = false; s.falling = false;
  }

  const squid = (() => {
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xe0503c, roughness: 0.4, emissive: 0x3a0a05, emissiveIntensity: 0.3 });
    const belly = new THREE.MeshStandardMaterial({ color: 0xf29a7e, roughness: 0.45 });
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
    const dark = new THREE.MeshBasicMaterial({ color: 0x120a12 });
    const mantle = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.2, 18), skin); mantle.position.y = 1.7; g.add(mantle);
    for (const side of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.9, 3), belly);
      fin.position.set(side * 0.52, 2.55, 0); fin.rotation.z = -side * 1.1; fin.scale.z = 0.25; g.add(fin);
    }
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), skin); head.position.y = 0.55; head.scale.set(1, 0.85, 1); g.add(head);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), white); eye.position.set(side * 0.38, 0.65, 0.3); g.add(eye);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), dark); pupil.position.set(side * 0.4, 0.65, 0.44); g.add(pupil);
    }
    const arms = [];
    for (let a = 0; a < 8; a++) {
      const ang = a * Math.PI / 4, long = a % 4 === 0;
      const dx = Math.cos(ang), dz = Math.sin(ang), len = long ? 1.9 : 1.1;
      const curve = new THREE.CatmullRomCurve3([V(dx * 0.15, 0.25, dz * 0.15), V(dx * 0.4, -0.1, dz * 0.4), V(dx * 0.62, -0.5, dz * 0.62), V(dx * 0.75, -len * 0.5, dz * 0.75)]);
      const arm = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, long ? 0.07 : 0.1, 6, false), belly);
      g.add(arm); arms.push(arm);
    }
    g.visible = false; g.scale.setScalar(1.15); scene.add(g);
    return { g, skin, arms, present: false, up: false, x: 0, z: 0 };
  })();
  function inkCloud(x, z, n = 14) {
    for (let i = 0; i < n; i++) spawn({ pos: V(x, 0.3, z), tex: smokeTex, vel: V(rnd(-1.4, 1.4), rnd(0.2, 1.4), rnd(-1.4, 1.4)), drag: 1.2, life: rnd(1.3, 2.2), s0: 0.6, s1: 2.4, color: 0x1a0f2e, op: 0.8 });
  }
  function bubbles(x, z) {
    for (let i = 0; i < 10; i++) spawn({ pos: V(x + rnd(-0.4, 0.4), 0.05, z + rnd(-0.4, 0.4)), tex: glowTex, vel: V(rnd(-0.2, 0.2), rnd(0.6, 1.6), rnd(-0.2, 0.2)), life: rnd(0.6, 1.1), s0: 0.22, s1: 0.1, color: 0xcfeeff, op: 0.85 });
  }
  async function squidShow(wx, up, owner) {
    const s = squid, z = zOf(owner) * 11; // pegado a su barco
    if (s.up) {
      const y0 = s.g.position.y;
      await tween(320, (t) => { s.g.position.y = y0 - 2.4 * t; }, easeIn);
      s.up = false; s.g.visible = false; ripple(s.x, s.z, 3.4);
    }
    s.present = true; s.x = wx; s.z = z;
    s.g.position.set(wx, -2.3, z); s.g.rotation.y = z > 0 ? Math.PI : 0;
    if (up) {
      s.g.visible = true; s.up = true;
      ripple(wx, z, 3.6); bubbles(wx, z);
      await tween(550, (t) => { s.g.position.y = -2.3 + 2.4 * t + Math.sin(t * Math.PI) * 0.25; }, easeOut);
      sparks(V(wx, 0.2, z), 10, 3, 0xcfeeff);
    } else {
      ripple(wx, z, 2.4); bubbles(wx, z); inkCloud(wx, z, 6);
      await wait(350);
    }
  }
  async function squidLeave() {
    const s = squid;
    if (!s.present) return;
    s.present = false;
    if (s.up) {
      const y0 = s.g.position.y;
      await tween(450, (t) => { s.g.position.y = y0 - 2.6 * t; }, easeIn);
      ripple(s.x, s.z, 3.6);
    }
    s.up = false; s.g.visible = false;
  }
  function squidBlock() {
    const s = squid;
    clash(V(s.x, 1.2, s.z)); shake(0.14, 0.3);
    inkCloud(s.x, s.z, 22);
    s.skin.emissive.setHex(0xffffff);
    const y0 = s.g.position.y;
    tween(450, (t) => { s.g.rotation.z = Math.sin(t * Math.PI * 5) * 0.2 * (1 - t); s.skin.emissive.lerpColors(new THREE.Color(0xffffff), new THREE.Color(0x3a0a05), t); s.g.position.y = y0 + Math.sin(t * Math.PI) * 0.4; }).then(() => { s.g.rotation.z = 0; });
  }

  // ---------- Árbol caído en horizontal (ronda 7 y desde la 20): ocupa dos carriles y bloquea los disparos de ambos lados ----------
  const logObj = (() => {
    const g = new THREE.Group();
    const bark = new THREE.MeshStandardMaterial({ color: 0x5b4030, roughness: 0.95, flatShading: true });
    const wood = new THREE.MeshStandardMaterial({ color: 0xc8a06a, roughness: 0.8 });
    const leaf = new THREE.MeshStandardMaterial({ color: 0x3f7d2a, roughness: 0.8, flatShading: true });
    const leafLight = new THREE.MeshStandardMaterial({ color: 0x5c9c3a, roughness: 0.8, flatShading: true });
    // tronco tumbado a lo ancho del mar (eje X): cubre los dos carriles contiguos
    const trunkGeo = new THREE.CylinderGeometry(0.45, 0.6, 4.4, 12, 8).rotateZ(Math.PI / 2);
    const pp = trunkGeo.attributes.position;
    for (let i = 0; i < pp.count; i++) { const k = rnd(0.92, 1.08); pp.setY(i, pp.getY(i) * k); pp.setZ(i, pp.getZ(i) * k); }
    trunkGeo.computeVertexNormals();
    const trunk = new THREE.Mesh(trunkGeo, bark); trunk.position.x = -0.5; g.add(trunk);
    const cap = new THREE.Mesh(new THREE.CircleGeometry(0.58, 12), wood);
    cap.position.x = -2.71; cap.rotation.y = -Math.PI / 2; g.add(cap);
    // raíces en la base del tronco
    [[0.5, 0.3], [-0.4, 0.5], [0.1, -0.55], [-0.5, -0.3]].forEach(([y, z]) => {
      const root = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.14, 0.9, 6), bark);
      root.position.set(-2.8, y * 0.75, z * 0.75); root.rotation.set(z * 1.2, 0, Math.PI / 2 + y * 1.4); g.add(root);
    });
    // ramas a lo largo del tronco
    [[-1.5, 1, 0.8], [-0.2, -1, 0.9], [0.9, 1, 0.7]].forEach(([x, side, len]) => {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.13, len + 0.4, 6), bark);
      stick.position.set(x, 0.5, side * (len * 0.4 + 0.25)); stick.rotation.x = side * 0.95; g.add(stick);
      const tuft = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), leaf);
      tuft.position.set(x, 1.05, side * (len * 0.8 + 0.5)); g.add(tuft);
    });
    // copa del árbol en la punta
    [[2.05, 0.5, 0, 0.8, leaf], [2.3, 0.85, 0.45, 0.55, leafLight], [2.25, 0.8, -0.5, 0.55, leafLight], [1.75, 1.05, 0.15, 0.5, leafLight], [2.5, 0.35, 0, 0.45, leaf]].forEach(([x, y, z, r, m]) => {
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), m);
      crown.position.set(x, y, z); g.add(crown);
    });
    g.visible = false; g.scale.setScalar(0.01); scene.add(g);
    const s = { g, present: false, x: 0, hitT: 0 };
    frameHooks.push((dt, t) => {
      if (!s.present) return;
      g.position.y = 0.05 + Math.sin(t * 2.1) * 0.07;
      g.rotation.x = Math.sin(t * 1.5) * 0.05 + s.hitT * Math.sin(t * 40) * 0.08; // balanceo sobre su eje largo
      s.hitT = Math.max(0, s.hitT - dt * 2.5);
    });
    return s;
  })();
  async function logShow(wx) {
    const s = logObj;
    if (!s.present) {
      s.present = true; s.x = wx; s.g.position.set(wx, 0.05, 0); s.g.rotation.y = rnd(-0.12, 0.12);
      s.g.scale.setScalar(0.01); s.g.visible = true;
      ripple(wx - 1.5, 0, 4.5); ripple(wx + 1.5, 0, 4.5);
      await tween(600, (t) => { s.g.scale.setScalar(0.01 + 0.99 * t); }, easeOut);
    } else if (s.x !== wx) {
      const from = s.x; s.x = wx;
      ripple(from, 0, 3);
      await tween(700, (t) => { s.g.position.x = from + (wx - from) * t; }, easeInOut);
    }
  }
  async function logLeave() {
    const s = logObj;
    if (!s.present) return;
    s.present = false;
    ripple(s.x - 1.5, 0, 4); ripple(s.x + 1.5, 0, 4);
    await tween(450, (t) => { s.g.scale.setScalar(Math.max(0.01, 1 - t)); }, easeIn);
    s.g.visible = false;
  }
  function logHit(x) {
    const p = V(x, 0.8, 0);
    clash(p); shake(0.1, 0.25); logObj.hitT = 1;
    for (let i = 0; i < 10; i++) spawn({ pos: p, tex: smokeTex, vel: V(rnd(-2, 2), rnd(1, 3.5), rnd(-2, 2)), grav: 7, life: rnd(0.5, 0.9), s0: 0.14, s1: 0.1, color: 0xc8a06a, op: 0.95 });
    sparks(p, 8, 4, 0xc8a06a);
  }

  const heli = (() => {
    const g = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xd32f2f, roughness: 0.35, metalness: 0.3 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.4 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.8 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x424950, metalness: 0.7, roughness: 0.4 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.8, 18, 14), red); body.scale.set(1.5, 0.95, 0.85); g.add(body);
    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), glass); cockpit.position.set(0.75, 0.12, 0); cockpit.scale.set(1, 0.85, 0.85); g.add(cockpit);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.69, 0.69, 0.18, 18), white); stripe.rotation.z = Math.PI / 2; stripe.position.set(-0.2, 0, 0); stripe.scale.set(1, 1, 1.0); g.add(stripe);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.06, 2.6, 10), red); boom.rotation.z = Math.PI / 2; boom.position.set(-2.2, 0.15, 0); g.add(boom);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.8, 0.06), red); fin.position.set(-3.4, 0.5, 0); g.add(fin);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 8), steel); mast.position.y = 0.95; g.add(mast);
    const rotor = new THREE.Group(); rotor.position.y = 1.18;
    for (let k = 0; k < 2; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.04, 0.22), steel); b.rotation.y = k * Math.PI / 2; rotor.add(b); }
    g.add(rotor);
    const tailRotor = new THREE.Group(); tailRotor.position.set(-3.45, 0.55, 0.1);
    for (let k = 0; k < 2; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, 0.08), steel); b.rotation.z = k * Math.PI / 2; tailRotor.add(b); }
    g.add(tailRotor);
    for (const z of [-0.55, 0.55]) {
      const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.0, 8), steel); skid.rotation.z = Math.PI / 2; skid.position.set(0.1, -1.0, z); g.add(skid);
      for (const x of [-0.5, 0.6]) { const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.55, 6), steel); strut.position.set(x, -0.72, z * 0.85); g.add(strut); }
    }
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3030 })); light.position.set(-0.1, 0.85, 0); g.add(light);
    g.visible = false; g.scale.setScalar(1.25); scene.add(g);
    frameHooks.push((dt) => { if (!g.visible) return; rotor.rotation.y += dt * 38; tailRotor.rotation.z += dt * 44; });
    return { g, light };
  })();
  const cargo = (() => {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xf7f8f2, roughness: 0.3 });
    const redM = new THREE.MeshStandardMaterial({ color: 0xe32336, roughness: 0.3, emissive: 0x8f101b, emissiveIntensity: 0.3 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.65, 0.65), white); box.position.y = 0.33; g.add(box);
    for (const z of [-0.331, 0.331]) {
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.4, 0.02), redM), h = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.02), redM);
      v.position.set(0, 0.33, z); h.position.set(0, 0.33, z); g.add(v, h);
    }
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.12, 0.72), white); lid.position.y = 0.7; g.add(lid);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.045, 8, 16, Math.PI), new THREE.MeshStandardMaterial({ color: 0x315e68, roughness: 0.5 })); handle.position.y = 0.76; g.add(handle);
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.4), redM), top2 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.14), redM);
    top.position.y = 0.77; top2.position.y = 0.77; g.add(top, top2);
    g.scale.setScalar(1.5);
    g.visible = false; scene.add(g);
    return { g };
  })();
  // el helicóptero llega, suelta un botiquín con paracaídas sobre el barco y se marcha
  async function heliSupport(who) {
    const sx = ships[who].g.position.x, z = zOf(who) * SHIP_Z, hy = 6.2;
    heli.g.visible = true; heli.g.rotation.set(0, 0, 0);
    heli.g.position.set(sx - 18, hy + 4, z);
    const ripples = setInterval(() => ripple(heli.g.position.x, z, 4.5, 0, 1.1), 260);
    await tween(1500, (t) => { heli.g.position.x = sx - 18 + 18 * t; heli.g.position.y = hy + 4 - 4 * t; heli.g.rotation.z = -0.22 * (1 - t); }, easeOut);
    // se abre la puerta y cae el botiquín directo sobre el barco
    cargo.g.visible = true; cargo.g.scale.setScalar(1.5);
    cargo.g.position.set(sx, hy - 1.2, z);
    const y0 = cargo.g.position.y;
    await tween(900, (t) => { cargo.g.position.y = y0 + (1.0 - y0) * t * t; cargo.g.rotation.y = t * Math.PI * 2; cargo.g.rotation.z = Math.sin(t * Math.PI * 2) * 0.15; }, (t) => t);
    // aterriza y el barco se cura
    const p = V(sx, 1.2, z);
    spawn({ pos: p, life: 0.4, s0: 0.5, s1: 6, add: true, color: 0x8dffb0 });
    sparks(p, 28, 5, 0x8dffb0);
    for (let k = 0; k < 18; k++) spawn({ pos: V(sx + rnd(-1.2, 1.2), 1, z + rnd(-1.2, 1.2)), tex: glowTex, vel: V(0, rnd(1.5, 3.5), 0), life: rnd(0.9, 1.5), s0: 0.45, s1: 0.1, add: true, color: 0x69f0ae, op: 0.9 });
    api.onHeal?.();
    await tween(500, (t) => { cargo.g.position.y = 1.0 + Math.sin(t * Math.PI) * 0.6; cargo.g.rotation.y = t * Math.PI * 2; }, easeOut);
    await tween(350, (t) => { cargo.g.scale.setScalar(Math.max(0.01, 1.5 * (1 - t))); }, easeIn);
    cargo.g.visible = false; cargo.g.rotation.set(0, 0, 0);
    // el piloto saluda con un giro y se va
    const x1 = heli.g.position.x;
    await tween(500, (t) => { heli.g.rotation.x = Math.sin(t * Math.PI * 2) * 0.35; }, easeInOut);
    await tween(1300, (t) => { heli.g.position.x = x1 + 22 * t; heli.g.position.y = hy + 5 * t; heli.g.rotation.z = -0.3 * t; heli.g.rotation.x = 0; }, easeIn);
    clearInterval(ripples);
    heli.g.visible = false;
  }

  // un dron sale del barco de `from`, vuela por encima de todo y se lanza contra el cañón de `to` en la posición x
  async function troopShip(from, to, xu) {
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b3238, metalness: 0.5, roughness: 0.4 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.7), new THREE.MeshStandardMaterial({ color: 0xd32f2f, metalness: 0.3, roughness: 0.4 }));
    g.add(body);
    const rotors = [];
    for (const [dx, dz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.1), dark);
      arm.position.set(dx / 2, 0, dz / 2); arm.scale.set(Math.abs(dx) * 10, 1, Math.abs(dz) * 10);
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.03, 16), new THREE.MeshBasicMaterial({ color: 0xcfd8dc, transparent: true, opacity: 0.45 }));
      rotor.position.set(dx, 0.14, dz);
      g.add(arm, rotor); rotors.push(rotor);
    }
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3030 })); led.position.set(0, 0.16, 0.36); g.add(led);
    g.scale.setScalar(1.3);
    const z0 = zOf(from) * (SHIP_Z - 2.6), z1 = zOf(to) * HIT_SHIP_Z, x0 = ships[from].g.position.x, x1 = xu * UNIT;
    scene.add(g);
    const place = (t) => {
      g.position.set(x0 + (x1 - x0) * t, 0.6 + Math.sin(Math.min(1, t * 1.4) * Math.PI) * 3.2 * (1 - t) + 1.1 * t, z0 + (z1 - z0) * t);
      g.rotation.y = Math.atan2(x1 - x0, z1 - z0);
      g.rotation.x = 0.35 * Math.sin(t * Math.PI); // cabecea al lanzarse en picado
    };
    place(0);
    const spin = setInterval(() => { for (const r of rotors) r.rotation.y += 1.2; }, 30);
    const shadow = setInterval(() => ripple(g.position.x, g.position.z, 1.8, 0, 0.8), 160);
    await tween(2400, place, easeInOut);
    clearInterval(spin); clearInterval(shadow);
    scene.remove(g);
    explodeShip(V(x1, 1.1, z1)); hitShip(to);
  }

  // desde el barco se lanzan peces a la ballena (el tiburón) del mismo bando
  async function feedShark(who) {
    const z0 = zOf(who) * (SHIP_Z - 2), z1 = zOf(who) * FIN_Z, x0 = ships[who].g.position.x, x1 = sharks[who].root.position.x;
    const fishMat = new THREE.MeshStandardMaterial({ color: 0xff8a65, roughness: 0.4 });
    const throws = [];
    for (let k = 0; k < 5; k++) {
      const fish = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), fishMat);
      fish.scale.set(1.8, 0.7, 0.7);
      fish.visible = false; scene.add(fish);
      throws.push((async () => {
        await tween(k * 160, () => {});
        fish.visible = true;
        const dx = rnd(-0.8, 0.8), dz = rnd(-0.6, 0.6);
        await tween(900, (t) => {
          fish.position.set(x0 + (x1 + dx - x0) * t, 1.6 + Math.sin(t * Math.PI) * 4.5 * (1 - 0.3 * t) - 1.2 * t, z0 + (z1 + dz - z0) * t);
          fish.rotation.z = t * 9;
        });
        splash(V(fish.position.x, 0.2, fish.position.z));
        scene.remove(fish);
      })());
    }
    await Promise.all(throws);
    api.onHeal?.();
    const p = V(x1, 0.8, z1);
    sparks(p, 24, 4, 0x69f0ae);
    for (let k = 0; k < 14; k++) spawn({ pos: V(x1 + rnd(-1, 1), 0.6, z1 + rnd(-1, 1)), tex: glowTex, vel: V(0, rnd(1.5, 3.5), 0), life: rnd(0.9, 1.4), s0: 0.4, s1: 0.1, add: true, color: 0x69f0ae, op: 0.9 });
  }

  // pez espada: sale junto al barco de `from`, cruza el mar a saltos y embiste a la ballena de `to`
  async function swordfishAttack(from, to) {
    const g = new THREE.Group();
    const blue = new THREE.MeshStandardMaterial({ color: 0x3f6fc4, metalness: 0.35, roughness: 0.35 });
    const belly = new THREE.MeshStandardMaterial({ color: 0xdfe9f7, roughness: 0.4 });
    const fin = new THREE.MeshStandardMaterial({ color: 0x2a4f9a, roughness: 0.5, side: THREE.DoubleSide });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), blue); body.scale.set(1, 1, 3.4); g.add(body);
    const under = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 10), belly); under.scale.set(0.9, 0.7, 3.1); under.position.y = -0.12; g.add(under);
    const bill = new THREE.Mesh(new THREE.ConeGeometry(0.09, 2.2, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9fb4cc, metalness: 0.6, roughness: 0.3 }));
    bill.position.z = 2.4; g.add(bill);
    const sailShape = new THREE.Shape(); sailShape.moveTo(0, 0); sailShape.lineTo(-0.2, 1.1); sailShape.lineTo(-0.9, 0.4); sailShape.lineTo(-1.4, 0);
    const sail = new THREE.Mesh(new THREE.ShapeGeometry(sailShape), fin); sail.rotation.y = -Math.PI / 2; sail.position.set(0, 0.32, 0.5); g.add(sail);
    const tail = new THREE.Group(); tail.position.z = -1.45; g.add(tail);
    for (const s of [1, -1]) {
      const lobe = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.0, 6), fin);
      lobe.position.set(0, s * 0.42, -0.2); lobe.rotation.x = s * 2.4; tail.add(lobe);
    }
    for (const sx of [1, -1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0x0b1a2e })); eye.position.set(sx * 0.3, 0.12, 1.05); g.add(eye); }
    g.scale.setScalar(0.9);
    const target = sharks[to].root.position;
    const x0 = ships[from].g.position.x + 3.5, z0 = zOf(from) * (SHIP_Z - 4), x1 = target.x, z1 = target.z;
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    scene.add(g);
    splash(V(x0, 0.2, z0));
    const hops = 3;
    await tween(2000, (t) => {
      const h = (t * hops) % 1;
      g.position.set(x0 + (x1 - x0) * t, -0.4 + Math.sin(h * Math.PI) * (t < 0.95 ? 2.2 : 0.6), z0 + (z1 - z0) * t);
      g.rotation.set(-Math.cos(h * Math.PI) * 0.6, yaw, 0);
      tail.rotation.y = Math.sin(t * 60) * 0.35;
      if (h < 0.04 && t > 0.05) ripple(g.position.x, g.position.z, 2, 0, 0.9);
    }, easeInOut);
    const p = V(x1, 0.9, z1);
    hitShark(to); splash(p); sparks(p, 26, 5, 0x90caf9); shake(0.12, 0.3);
    const xe = g.position.x, ze = g.position.z;
    await tween(500, (t) => { g.position.set(xe + Math.sin(yaw) * 2 * t, 0.5 - 2.4 * t, ze + Math.cos(yaw) * 2 * t); g.rotation.x = 0.9 * t; }, easeIn);
    scene.remove(g);
  }

  // cúpula: burbuja translúcida sobre un cañón; domeBlock la hace destellar al absorber un impacto
  const domes = { me: null, op: null };
  function setDome(who, lane) {
    const cur = domes[who];
    if (cur && cur.lane === lane) return;
    if (cur) { cur.node.remove(cur.mesh); domes[who] = null; }
    if (!lane) return;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.25, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }));
    mesh.position.y = 0.05;
    const node = ships[who].turrets[lane - 1].node;
    node.add(mesh);
    domes[who] = { lane, mesh, node };
    sparks(node.getWorldPosition(new THREE.Vector3()), 14, 3, 0x81d4fa);
  }
  function domeBlock(who, lane) {
    const d = domes[who];
    if (!d || d.lane !== lane) return;
    d.mesh.material.opacity = 0.85;
    sparks(d.node.getWorldPosition(new THREE.Vector3()).add(V(0, 0.8, 0)), 22, 5, 0xb3e5fc);
    tween(450, (t) => { d.mesh.material.opacity = 0.85 - 0.53 * t; }, easeOut);
  }

  // ---------- Dragones (tienda) ----------
  // El modelo mira a +z; rojo = fuego (a la izquierda del barco), azul = rayos (a la derecha).
  const DRAGON_LOOK = {
    fire: { body: 0xb71c1c, dark: 0x5a0d0d, belly: 0xffb300, wing: 0x8e1414, eye: 0xffee58, spark: 0xff7a1a },
    storm: { body: 0x1565c0, dark: 0x0b2f6b, belly: 0x80deea, wing: 0x0d47a1, eye: 0xe0f7fa, spark: 0x9be7ff },
  };
  function makeDragon(kind) {
    const c = DRAGON_LOOK[kind];
    const skin = new THREE.MeshStandardMaterial({ color: c.body, roughness: 0.42, metalness: 0.3, emissive: c.body, emissiveIntensity: 0.18 });
    const dark = new THREE.MeshStandardMaterial({ color: c.dark, roughness: 0.5, metalness: 0.3 });
    const belly = new THREE.MeshStandardMaterial({ color: c.belly, roughness: 0.35, metalness: 0.45, emissive: c.belly, emissiveIntensity: 0.15 });
    const horn = new THREE.MeshStandardMaterial({ color: 0xf3e6c4, roughness: 0.4 });
    const membrane = new THREE.MeshStandardMaterial({ color: c.wing, roughness: 0.6, side: THREE.DoubleSide, transparent: true, opacity: 0.93, emissive: c.wing, emissiveIntensity: 0.25 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: c.eye });
    const root = new THREE.Group(), model = new THREE.Group(); root.add(model);
    const ball = (r, mat, x, y, z, sx = 1, sy = 1, sz = 1, parent = model) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); parent.add(m); return m; };
    // cuerpo, pecho y vientre
    ball(0.5, skin, 0, 0, 0, 1, 0.9, 1.7);
    ball(0.42, skin, 0, 0.08, 0.75, 1, 1, 1.2);
    ball(0.42, belly, 0, -0.17, 0.2, 0.85, 0.6, 1.75);
    // cuello curvado hasta la cabeza
    const neck = [[0, 0.2, 1.15, 0.33], [0, 0.34, 1.45, 0.28], [0, 0.5, 1.72, 0.24], [0, 0.62, 1.97, 0.22]];
    for (const [x, y, z, r] of neck) { ball(r, skin, x, y, z); ball(r * 0.75, belly, x, y - r * 0.45, z + 0.04, 1, 0.6, 1); }
    const head = new THREE.Group(); head.position.set(0, 0.7, 2.2); model.add(head);
    ball(0.27, skin, 0, 0, 0, 1, 0.85, 1.25, head);
    const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.2, 0.55, 12).rotateX(Math.PI / 2), skin); snout.position.set(0, -0.04, 0.42); head.add(snout);
    const jaw = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.15, 0.48, 10).rotateX(Math.PI / 2), belly); jaw.position.set(0, -0.15, 0.36); head.add(jaw);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), eyeMat); eye.position.set(sx * 0.17, 0.08, 0.17); head.add(eye);
      const brow = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 6), dark); brow.position.set(sx * 0.16, 0.15, 0.2); brow.rotation.set(-1.2, 0, sx * 0.4); head.add(brow);
      const h1 = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.55, 8), horn); h1.position.set(sx * 0.14, 0.25, -0.22); h1.rotation.set(-2.1, 0, -sx * 0.35); head.add(h1);
      const h2 = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.32, 8), horn); h2.position.set(sx * 0.22, 0.05, -0.2); h2.rotation.set(-2.0, 0, -sx * 0.9); head.add(h2);
    }
    const mouth = new THREE.Object3D(); mouth.position.set(0, -0.1, 0.72); head.add(mouth);
    // crestas a lo largo del lomo
    for (let i = 0; i < 9; i++) {
      const z = 1.85 - i * 0.42, y = i < 4 ? 0.85 - i * 0.12 : 0.45 - (i - 4) * 0.02;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3 - i * 0.015, 6), dark); spike.position.set(0, y, z); spike.rotation.x = -0.5; model.add(spike);
    }
    // cola articulada que ondula
    const tail = []; let parent = model, tz = -0.75;
    for (let i = 0; i < 7; i++) {
      const seg = new THREE.Group(); seg.position.set(0, i === 0 ? -0.02 : 0, i === 0 ? tz : -0.42); parent.add(seg);
      const r = 0.34 * (1 - i * 0.12);
      ball(r, skin, 0, 0, -0.2, 1, 0.9, 1.5, seg);
      if (i > 1) { const sp = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.2, 5), dark); sp.position.set(0, r * 0.85, -0.2); sp.rotation.x = -0.6; seg.add(sp); }
      tail.push(seg); parent = seg;
    }
    const tipShape = new THREE.Shape(); tipShape.moveTo(0, 0.05); tipShape.lineTo(0.22, -0.25); tipShape.lineTo(0, -0.55); tipShape.lineTo(-0.22, -0.25); tipShape.closePath();
    const tip = new THREE.Mesh(new THREE.ShapeGeometry(tipShape).rotateX(-Math.PI / 2), dark); tip.material = new THREE.MeshStandardMaterial({ color: c.dark, side: THREE.DoubleSide, roughness: 0.5 }); tip.position.z = -0.35; parent.add(tip);
    // patas recogidas
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.4, 4, 8), skin); leg.position.set(sx * 0.32, -0.38, -0.45); leg.rotation.x = 1.1; model.add(leg);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.25, 4, 8), skin); arm.position.set(sx * 0.3, -0.3, 0.75); arm.rotation.x = 0.9; model.add(arm);
      for (const [lz, ly] of [[-0.72, -0.52], [0.9, -0.42]]) for (const cx of [-0.05, 0.05]) { const claw = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.1, 5), horn); claw.position.set(sx * 0.31 + cx, ly, lz); claw.rotation.x = 2.2; model.add(claw); }
    }
    // alas de murciélago en dos tramos (el exterior aletea con retraso)
    const wingPart = (pts, bones) => {
      const g = new THREE.Group();
      const sh = new THREE.Shape(); sh.moveTo(pts[0][0], -pts[0][1]); for (const [x, z] of pts.slice(1)) sh.lineTo(x, -z); sh.closePath();
      g.add(new THREE.Mesh(new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2), membrane));
      for (const [x0, z0, x1, z1, r] of bones) {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const b = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r, len, 6), dark);
        b.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2); b.rotation.set(Math.PI / 2, 0, 0); b.rotation.order = 'YXZ'; b.rotation.y = Math.atan2(x1 - x0, z1 - z0); g.add(b);
      }
      return g;
    };
    const wings = [-1, 1].map((side) => {
      const w = new THREE.Group(); w.position.set(side * 0.38, 0.32, 0.55); w.scale.x = side; model.add(w);
      const inner = wingPart([[0, 0.25], [1.4, 0.35], [1.4, -0.45], [0.95, -0.9], [0.45, -0.75], [0, -1.05]], [[0, 0.2, 1.4, 0.35, 0.07]]);
      w.add(inner);
      const outer = new THREE.Group(); outer.position.set(1.4, 0, 0.35); w.add(outer);
      outer.add(wingPart([[0, 0], [1.75, -0.5], [1.25, -0.95], [1.0, -0.85], [0.75, -1.45], [0.45, -1.05], [0, -0.8]], [[0, 0, 1.75, -0.5, 0.06], [0, 0, 1.05, -0.9, 0.045], [0, 0, 0.6, -1.25, 0.04]]));
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 6), horn); claw.position.set(0, 0.04, 0.12); claw.rotation.x = Math.PI / 2; outer.add(claw);
      return { w, outer, side };
    });
    model.scale.setScalar(0.85);
    return { root, model, head, mouth, wings, tail, kind };
  }
  const dragons = { me: { fire: null, storm: null }, op: { fire: null, storm: null } };
  const dragonHome = (who, kind) => {
    const zs = zOf(who), side = kind === 'fire' ? -1 : 1; // izquierda / derecha vistas desde el propio barco
    return V(side * zs * 6.4, 2.9, zs * (SHIP_Z - 3.4));
  };
  function setDragons(who, owned = {}) {
    for (const kind of ['fire', 'storm']) {
      const has = !!owned?.[kind], cur = dragons[who][kind];
      if (has && !cur) {
        const d = makeDragon(kind);
        Object.assign(d, { who, home: dragonHome(who, kind), phase: kind === 'fire' ? 0 : 2.3, attack: null, yaw: zOf(who) < 0 ? 0 : Math.PI, pitch: 0, roll: 0, prev: null, emberT: 0 });
        d.root.position.copy(d.home); scene.add(d.root);
        dragons[who][kind] = d;
      } else if (!has && cur) { scene.remove(cur.root); dragons[who][kind] = null; }
    }
  }
  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  frameHooks.push((dt, t) => {
    for (const who of ['me', 'op']) for (const kind of ['fire', 'storm']) {
      const d = dragons[who][kind];
      if (!d) continue;
      const tt = t + d.phase, fast = d.attack ? 1.35 : 1;
      // aleteo: bajada potente y subida lenta; el cuerpo sube con cada golpe de ala
      const beat = tt * 5.2 * fast, flap = Math.sin(beat), amp = d.attack ? 0.75 : 0.55 + 0.2 * Math.sin(tt * 0.5);
      for (const { w, outer, side } of d.wings) {
        w.rotation.z = side * (0.12 + flap * amp);
        outer.rotation.z = side * Math.sin(beat - 0.8) * amp * 0.65;
        w.rotation.x = -Math.cos(beat) * 0.12;
      }
      d.tail.forEach((seg, i) => { seg.rotation.y = Math.sin(tt * 2.4 - i * 0.7) * 0.16; seg.rotation.x = Math.sin(tt * 1.7 - i * 0.5) * 0.05 + 0.03; });
      d.head.rotation.x = Math.sin(tt * 1.3) * 0.08; d.head.rotation.y = Math.sin(tt * 0.9) * 0.12;
      let pos;
      if (d.attack) pos = d.attack.clone();
      else { // vuelo en ocho alrededor de su sitio junto al barco
        const w = 0.42;
        pos = d.home.clone().add(V(Math.sin(tt * w) * 1.0, Math.sin(tt * w * 1.6) * 0.3, Math.sin(tt * w * 2) * 0.9));
      }
      if (d.prev) {
        const v = pos.clone().sub(d.prev);
        const hv = Math.hypot(v.x, v.z);
        if (hv > 1e-4) {
          const want = Math.atan2(v.x, v.z), turn = angDiff(want, d.yaw);
          d.yaw += turn * Math.min(1, dt * 4);
          d.roll += (Math.max(-0.6, Math.min(0.6, -turn * 1.6)) - d.roll) * Math.min(1, dt * 3);
          d.pitch += (Math.max(-0.5, Math.min(0.5, -Math.atan2(v.y, hv))) - d.pitch) * Math.min(1, dt * 3);
        }
      }
      d.prev = pos.clone();
      d.root.position.copy(pos); d.root.position.y -= flap * 0.12;
      d.root.rotation.set(0, 0, 0); d.root.rotation.order = 'YXZ';
      d.root.rotation.y = d.yaw; d.root.rotation.x = d.pitch; d.root.rotation.z = d.roll;
      // ascuas o chispas que se escapan de las fauces
      d.emberT -= dt;
      if (d.emberT <= 0) {
        d.emberT = rnd(0.25, 0.6);
        const m = d.mouth.getWorldPosition(new THREE.Vector3());
        spawn({ pos: m, vel: V(rnd(-0.3, 0.3), rnd(0.2, 0.7), rnd(-0.3, 0.3)), life: rnd(0.5, 0.9), s0: kind === 'fire' ? 0.28 : 0.2, s1: 0.04, add: true, color: DRAGON_LOOK[kind].spark, op: 0.9 });
      }
    }
  });
  const burns = [];
  frameHooks.push((dt) => {
    for (let i = burns.length - 1; i >= 0; i--) {
      const b = burns[i]; b.left -= dt;
      if (b.left <= 0) { burns.splice(i, 1); continue; }
      const sp = ships[b.who].g.position, k = Math.min(1, b.left / 1.5);
      for (let n = 0; n < 2; n++) {
        const p = V(sp.x + rnd(-5, 5), 0.9 + rnd(0, 0.5), sp.z + rnd(-0.9, 0.9));
        spawn({ pos: p, vel: V(rnd(-0.2, 0.2), rnd(1.4, 2.6), rnd(-0.2, 0.2)), life: rnd(0.45, 0.8), s0: 0.7 * k + 0.2, s1: 0.1, add: true, color: Math.random() < 0.5 ? 0xff5a16 : 0xffb030, op: 0.95 });
      }
      if (Math.random() < 0.35) spawn({ pos: V(sp.x + rnd(-4.5, 4.5), 1.6, sp.z + rnd(-0.6, 0.6)), tex: smokeTex, vel: V(rnd(-0.3, 0.3), rnd(1.2, 2), rnd(-0.3, 0.3)), drag: 0.3, life: rnd(1.6, 2.4), s0: 0.8, s1: 2.8, color: 0x2a2a2a, op: 0.6 });
    }
  });
  function boltBetween(a, b, color = 0xb3f5ff) {
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
    const lines = [0, 1, 2].map(() => {
      const pts = [];
      for (let i = 0; i <= 10; i++) {
        const k = i / 10, p = a.clone().lerp(b, k);
        if (i > 0 && i < 10) p.add(V(rnd(-0.35, 0.35), rnd(-0.25, 0.25), rnd(-0.35, 0.35)));
        pts.push(p);
      }
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat); l.renderOrder = 9; scene.add(l); return l;
    });
    for (let i = 1; i < 12; i++) spawn({ pos: a.clone().lerp(b, i / 12), life: 0.35, s0: 0.9, s1: 0.2, add: true, color: i % 2 ? 0x9be7ff : 0xffffff, op: 0.9 });
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.9, 14, 10), new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.7, depthWrite: false }));
    halo.position.copy(b); scene.add(halo);
    flashLight(b.clone().add(V(0, 1, 0)), 12, 0xbfe9ff);
    sparks(b, 28, 6, 0xe1f5fe); sparks(b, 12, 3, 0x4fc3f7);
    shake(0.22, 0.3);
    tween(650, (t) => {
      mat.opacity = t < 0.55 ? (Math.floor(t * 26) % 2 ? 0.3 : 1) : 1 - (t - 0.55) / 0.45;
      halo.material.opacity = 0.7 * (1 - t); halo.scale.setScalar(1 + t);
    }).then(() => { lines.forEach((l) => { scene.remove(l); l.geometry.dispose(); }); scene.remove(halo); mat.dispose(); });
  }
  const bezier = (a, c, b, t) => a.clone().multiplyScalar((1 - t) * (1 - t)).add(c.clone().multiplyScalar(2 * (1 - t) * t)).add(b.clone().multiplyScalar(t * t));
  async function dragonPass(d, to, kind, dirX, lift, opts = {}) {
    if (to === 'warship') return dragonPassWar(d, kind, dirX, lift);
    if (to === 'monkeys') return dragonPassWar(d, kind, dirX, lift, opts.monkeys || []);
    const zt = zOf(to) * SHIP_Z + (kind === 'fire' ? 0.7 : -0.7) * zOf(to);
    const start = d.root.position.clone();
    const passA = V(-dirX * 8.5, 4.2 + lift, zt), passB = V(dirX * 8.5, 4.2 + lift, zt);
    const mid = start.clone().lerp(passA, 0.5); mid.y += 3.5;
    d.attack = start.clone();
    await tween(1400, (t) => { d.attack.copy(bezier(start, mid, passA, t)); }, easeInOut);
    const struck = new Set(), turrets = ships[to].turrets.map((tr) => tr.node.getWorldPosition(new THREE.Vector3()));
    let flameT = 0, last = 0;
    await tween(1700, (t) => {
      const x = passA.x + (passB.x - passA.x) * t;
      d.attack.set(x, passA.y - Math.sin(t * Math.PI) * 1.4, zt);
      const dtl = t - last; last = t;
      const mouth = d.mouth.getWorldPosition(new THREE.Vector3());
      if (kind === 'fire' && t > 0.12 && t < 0.9) {
        flameT += dtl;
        for (; flameT > 0.012; flameT -= 0.012) {
          const aim = V(x + dirX * 1.2, 1.1, zOf(to) * SHIP_Z).sub(mouth).normalize().multiplyScalar(rnd(7, 10));
          spawn({ pos: mouth, vel: aim.add(V(rnd(-0.8, 0.8), rnd(-0.6, 0.6), rnd(-0.8, 0.8))), drag: 1.5, life: rnd(0.35, 0.6), s0: 0.35, s1: 1.9, add: true, color: [0xffe08a, 0xff9a2e, 0xff4a12][Math.floor(Math.random() * 3)], op: 0.95 });
          if (Math.random() < 0.3) spawn({ pos: V(x + dirX * 1.2 + rnd(-0.6, 0.6), 1.0, zOf(to) * SHIP_Z + rnd(-0.8, 0.8)), vel: V(rnd(-0.4, 0.4), rnd(1.5, 3), rnd(-0.4, 0.4)), life: rnd(0.5, 0.9), s0: 0.9, s1: 0.2, add: true, color: 0xff6a1a, op: 0.9 });
        }
        if (Math.random() < 0.08) { flashLight(V(x, 2, zOf(to) * SHIP_Z), 16, 0xff7a1a); hitShip(to); }
      }
      if (kind === 'storm') turrets.forEach((tp, i) => {
        if (struck.has(i) || (dirX > 0 ? x < tp.x - 0.6 : x > tp.x + 0.6)) return;
        struck.add(i); boltBetween(mouth, tp.clone().add(V(0, 0.6, 0))); hitShip(to);
      });
    }, (t) => t);
    if (kind === 'fire') { burns.push({ who: to, left: 3.6 }); explodeShip(V(ships[to].g.position.x, 1.4, zOf(to) * SHIP_Z)); }
    // vuelta a casa junto a su barco (sin bloquear la ronda)
    const back = d.attack.clone(), home = d.home.clone(), mid2 = back.clone().lerp(home, 0.5); mid2.y += 3;
    tween(1600, (t) => { d.attack.copy(bezier(back, mid2, home, t)); }, easeInOut).then(() => { d.attack = null; d.prev = null; });
  }
  // contra el barco de guerra (o los monos de la isla): pasada rasante (llamas o rayos)
  async function dragonPassWar(d, kind, dirX, lift, monkeys = null) {
    const onIsle = Array.isArray(monkeys), struck = new Set();
    const zt = onIsle ? (kind === 'fire' ? 1.8 : -1.2) : kind === 'fire' ? 2.6 : -2.6, y = (onIsle ? 6 : 8.5) + lift;
    const start = d.root.position.clone(), passA = V(-dirX * 11, y, zt), passB = V(dirX * 11, y, zt);
    const mid = start.clone().lerp(passA, 0.5); mid.y += 3;
    d.attack = start.clone();
    await tween(1400, (t) => { d.attack.copy(bezier(start, mid, passA, t)); }, easeInOut);
    let flameT = 0, last = 0, boltT = 0;
    await tween(1900, (t) => {
      const x = passA.x + (passB.x - passA.x) * t;
      d.attack.set(x, y - Math.sin(t * Math.PI) * 1.6, zt);
      const dtl = t - last; last = t;
      const mouth = d.mouth.getWorldPosition(new THREE.Vector3()), hit = onIsle ? V(x + dirX * 1.2, rnd(0.8, 2), 0.4 + rnd(-0.6, 0.6)) : V(x + dirX * 1.2, rnd(1.5, 3.5), rnd(-1, 1));
      if (onIsle) for (const id of monkeys) { // el dragón abate a cada mono al pasar por encima
        if (struck.has(id) || (dirX > 0 ? x < LANE_X[id] - 1.2 : x > LANE_X[id] + 1.2)) continue;
        struck.add(id);
        const mp = V(LANE_X[id], 1.6, 0.4);
        if (kind === 'storm') boltBetween(mouth, mp); else flashLight(mp, 18, 0xff7a1a);
        monkeyKill(id);
        for (let k = 0; k < 10; k++) spawn({ pos: mp, vel: V(rnd(-2, 2), rnd(3, 6), rnd(-2, 2)), grav: 9, life: 1, s0: 0.5, s1: 0.3, add: true, color: 0xffd54f, op: 1 });
        api.onMonkeyDragon?.(id);
      }
      if (kind === 'fire' && t > 0.08 && t < 0.92) {
        flameT += dtl;
        for (; flameT > 0.012; flameT -= 0.012) {
          const aim = hit.clone().sub(mouth).normalize().multiplyScalar(rnd(8, 11));
          spawn({ pos: mouth, vel: aim.add(V(rnd(-0.8, 0.8), rnd(-0.6, 0.6), rnd(-0.8, 0.8))), drag: 1.5, life: rnd(0.4, 0.65), s0: 0.4, s1: 2.1, add: true, color: [0xffe08a, 0xff9a2e, 0xff4a12][Math.floor(Math.random() * 3)], op: 0.95 });
        }
        if (Math.random() < 0.1) { flashLight(hit, 18, 0xff7a1a); if (!onIsle) war.hitT = 0.3; spawn({ pos: hit, tex: smokeTex, vel: V(0, 2, 0), life: 2, s0: 1, s1: 3, color: 0x2a2a2a, op: 0.6 }); }
      }
      if (kind === 'storm' && t > 0.08 && t < 0.92) {
        boltT += dtl;
        if (boltT > 0.14) { boltT = 0; boltBetween(mouth, hit); if (!onIsle) war.hitT = 0.3; }
      }
    }, (t) => t);
    if (!onIsle) explodeShip(V(rnd(-4, 4), 2.5, 0));
    const back = d.attack.clone(), home = d.home.clone(), mid2 = back.clone().lerp(home, 0.5); mid2.y += 3;
    tween(1600, (t) => { d.attack.copy(bezier(back, mid2, home, t)); }, easeInOut).then(() => { d.attack = null; d.prev = null; });
  }
  async function dragonAttack(from, to, { fire: useFire, storm: useStorm, monkeys } = {}) {
    const jobs = [];
    const f = dragons[from].fire, s = dragons[from].storm;
    // si los tienes los dos, cruzan el barco rival en sentidos opuestos a la vez
    if (useFire && f) jobs.push(dragonPass(f, to, 'fire', 1, 0, { monkeys }));
    if (useStorm && s) jobs.push(dragonPass(s, to, 'storm', -1, 0.9, { monkeys }));
    await Promise.all(jobs);
  }

  // ==================== Barco de guerra pirata (rondas 11, 22 y 33) ====================
  const pirateTex = canvasTex(256, 160, (g, w, h) => {
    g.fillStyle = '#0b0b0d'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f4f1e6'; g.strokeStyle = '#f4f1e6'; g.lineCap = 'round';
    g.lineWidth = 16;
    g.beginPath(); g.moveTo(80, 128); g.lineTo(176, 70); g.moveTo(176, 128); g.lineTo(80, 70); g.stroke();
    for (const [x, y] of [[74, 132], [86, 124], [182, 132], [170, 124], [74, 66], [86, 74], [182, 66], [170, 74]]) { g.beginPath(); g.arc(x, y, 9, 0, 7); g.fill(); }
    g.beginPath(); g.arc(128, 66, 40, 0, 7); g.fill(); g.fillRect(104, 82, 48, 30);
    g.fillStyle = '#0b0b0d';
    g.beginPath(); g.arc(112, 64, 11, 0, 7); g.arc(144, 64, 11, 0, 7); g.fill();
    g.beginPath(); g.moveTo(128, 76); g.lineTo(121, 89); g.lineTo(135, 89); g.fill();
    for (let i = 0; i < 4; i++) g.fillRect(110 + i * 10, 98, 4, 14);
  });
  const skullTex = canvasTex(128, 128, (g) => {
    g.fillStyle = '#f4f1e6';
    g.beginPath(); g.arc(64, 54, 34, 0, 7); g.fill(); g.fillRect(44, 70, 40, 30);
    g.fillStyle = '#121212';
    g.beginPath(); g.arc(50, 54, 10, 0, 7); g.arc(78, 54, 10, 0, 7); g.fill();
    g.beginPath(); g.moveTo(64, 64); g.lineTo(58, 76); g.lineTo(70, 76); g.fill();
    for (let i = 0; i < 4; i++) g.fillRect(48 + i * 9, 86, 4, 14);
  });
  const war = (() => {
    const g = new THREE.Group(), wrap = new THREE.Group(); g.add(wrap);
    const steelM = new THREE.MeshStandardMaterial({ color: 0x2c3036, metalness: 0.7, roughness: 0.45 });
    const darkM = new THREE.MeshStandardMaterial({ color: 0x1b1d21, metalness: 0.6, roughness: 0.5 });
    const redM = new THREE.MeshStandardMaterial({ color: 0x7a1010, metalness: 0.3, roughness: 0.6 });
    const goldM = new THREE.MeshStandardMaterial({ color: 0xd4a640, metalness: 0.9, roughness: 0.25, emissive: 0x3a2400 });
    const deckM = new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.4, roughness: 0.7 });
    const glassM = new THREE.MeshStandardMaterial({ color: 0x0b1a22, emissive: 0x29e0ff, emissiveIntensity: 1.6 });
    const hullShape = (s = 1) => {
      const sh = new THREE.Shape();
      sh.moveTo(-9 * s, -1.9 * s); sh.lineTo(4.5 * s, -1.9 * s); sh.quadraticCurveTo(8 * s, -1.6 * s, 10 * s, 0);
      sh.quadraticCurveTo(8 * s, 1.6 * s, 4.5 * s, 1.9 * s); sh.lineTo(-9 * s, 1.9 * s); sh.quadraticCurveTo(-9.8 * s, 0, -9 * s, -1.9 * s);
      return sh;
    };
    const ext = (sh, depth, mat, y) => {
      const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 2, curveSegments: 18 });
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, mat); m.position.y = y; m.castShadow = true; wrap.add(m); return m;
    };
    ext(hullShape(0.97), 0.8, redM, -0.9);
    ext(hullShape(1), 1.25, steelM, -0.1);
    ext(hullShape(1.012), 0.1, goldM, 0.05);
    ext(hullShape(0.95), 0.12, deckM, 1.2);
    const box = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; wrap.add(m); return m; };
    // superestructura escalonada con puente iluminado
    box(7, 1.2, 2.8, steelM, -2, 1.9, 0);
    box(4.6, 1.1, 2.3, steelM, -1.6, 3.05, 0);
    box(4.8, 0.32, 2.42, glassM, -1.6, 3.15, 0);
    box(2.8, 0.9, 2, darkM, -1.2, 4.05, 0);
    box(2.95, 0.22, 2.1, glassM, -1.2, 4.12, 0);
    // chimeneas
    const funnels = [-4.6, -6].map((x) => {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 2.4, 18), darkM); f.position.set(x, 3.2, 0); f.rotation.z = 0.12; wrap.add(f);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.53, 0.53, 0.25, 18), redM); band.position.set(x + 0.13, 4, 0); band.rotation.z = 0.12; wrap.add(band);
      return f;
    });
    // mástil, radar y bandera pirata
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 4.6, 10), darkM); mast.position.set(-0.6, 6.7, 0); wrap.add(mast);
    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), darkM); yard.rotation.x = Math.PI / 2; yard.position.set(-0.6, 7.4, 0); wrap.add(yard);
    const radar = new THREE.Group(); radar.position.set(-0.6, 6.1, 0); wrap.add(radar);
    const dish = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.35, 1.8), steelM); dish.position.x = 0.15; radar.add(dish);
    const flagGeo = new THREE.PlaneGeometry(2.6, 1.6, 16, 6); flagGeo.translate(1.3, 0, 0);
    const flagBase = flagGeo.attributes.position.array.slice();
    const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ map: pirateTex, side: THREE.DoubleSide, roughness: 0.9 }));
    flag.position.set(-0.6, 8.2, 0); flag.rotation.y = Math.PI; wrap.add(flag);
    // calaveras en los costados
    for (const s of [1, -1]) for (const x of [3.5, -6.5]) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 1.25), new THREE.MeshBasicMaterial({ map: skullTex, transparent: true }));
      d.position.set(x, 0.55, s * 1.93); d.rotation.y = s > 0 ? 0 : Math.PI; wrap.add(d);
    }
    // torretas triples (proa y popa)
    const mkTurret = (x, facing) => {
      const t = new THREE.Group(); t.position.set(x, 1.55, 0); t.rotation.y = facing; wrap.add(t);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.15, 0.5, 20), steelM); t.add(base);
      const head = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.75, 1.5), darkM); head.position.set(0.2, 0.55, 0); t.add(head);
      const barrels = [-0.42, 0, 0.42].map((z) => {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 2.4, 10), steelM); b.rotation.z = -Math.PI / 2; b.position.set(2.1, 0.6, z); t.add(b); return b;
      });
      return { t, barrels, rest: facing };
    };
    const turrets = [mkTurret(5.6, 0), mkTurret(-7.8, Math.PI)];
    // lanzamisiles a ambos costados
    const pods = [];
    for (const s of [1, -1]) for (const x of [1.6, 3.4]) {
      const pod = box(1.4, 0.7, 0.9, darkM, x, 1.6, s * 1.15);
      for (let i = 0; i < 6; i++) {
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 8), redM); tip.position.set(x - 0.45 + (i % 3) * 0.45, 2.05, s * 1.15 + (i < 3 ? -0.2 : 0.2)); wrap.add(tip);
      }
      pods.push({ x, z: s * 1.15, side: s });
    }
    // torre láser en lo alto del puente (gira como un faro)
    const laser = new THREE.Group(); laser.position.set(-1.2, 4.75, 0); wrap.add(laser);
    laser.add(new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.45, 16), steelM));
    const emitter = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 1.3, 12), darkM); emitter.rotation.z = -Math.PI / 2; emitter.position.set(0.65, 0.25, 0); laser.add(emitter);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), new THREE.MeshBasicMaterial({ color: 0xff2040 })); lens.position.set(1.32, 0.25, 0); laser.add(lens);
    const lensGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff2040, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })); lensGlow.scale.setScalar(1.2); lens.add(lensGlow);
    // luces de navegación
    const navs = [[9.6, 1.4, 0, 0xffffff], [-1.2, 5.1, 1.1, 0xff1a1a], [-1.2, 5.1, -1.1, 0x1aff5a], [-0.6, 9.05, 0, 0xff1a1a]].map(([x, y, z, c]) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: c, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      s.position.set(x, y, z); s.scale.setScalar(0.9); wrap.add(s); return s;
    });
    // rayo láser (núcleo + halo)
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true); beamGeo.translate(0, 0.5, 0);
    const beam = new THREE.Group(); beam.visible = false; scene.add(beam);
    const core = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xffe6ea, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); core.scale.set(0.09, 1, 0.09);
    const halo = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xff1030, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })); halo.scale.set(0.3, 1, 0.3);
    beam.add(core, halo); beam.renderOrder = 9;
    g.scale.setScalar(0.88); g.position.set(-40, 0, 0); g.visible = false; scene.add(g);
    return { g, wrap, funnels, radar, flag, flagGeo, flagBase, turrets, pods, laser, lens, navs, beam, core, halo, present: false, moving: 0, hitT: 0, smokeAcc: 0, wakeAcc: 0, stuck: [], job: null };
  })();
  const warWorld = (lx, ly, lz) => war.wrap.localToWorld(V(lx, ly, lz));
  frameHooks.push((dt, t) => {
    if (!war.g.visible) return;
    war.wrap.rotation.z = Math.sin(t * 0.7) * 0.015; war.wrap.rotation.x = Math.sin(t * 0.55) * 0.012;
    war.wrap.position.y = Math.sin(t * 0.9) * 0.06;
    if (war.hitT > 0) { war.hitT -= dt; war.wrap.position.x = Math.sin(war.hitT * 70) * 0.12 * war.hitT; }
    war.radar.rotation.y += dt * 2.4;
    if (!war.beam.visible) war.laser.rotation.y += dt * 0.6;
    const pa = war.flagGeo.attributes.position, b = war.flagBase;
    for (let i = 0; i < pa.count; i++) { const x = b[i * 3]; pa.array[i * 3 + 2] = Math.sin(x * 2.4 - t * 7) * 0.22 * (x / 2.6); }
    pa.needsUpdate = true; war.flagGeo.computeVertexNormals();
    war.navs.forEach((s, i) => { s.material.opacity = (Math.sin(t * 4 + i * 1.7) > 0.2 ? 1 : 0.15); });
    war.smokeAcc += dt;
    if (war.smokeAcc > 0.09) {
      war.smokeAcc = 0;
      for (const f of war.funnels) {
        const p = f.getWorldPosition(new THREE.Vector3()); p.y += 1.3;
        spawn({ pos: p, tex: smokeTex, vel: V(-1.2 - war.moving * 3, rnd(1.2, 2), rnd(-0.3, 0.3)), drag: 0.25, life: rnd(2.2, 3.2), s0: 0.8, s1: 3.4, color: 0x26282c, op: 0.55 });
      }
    }
    if (war.moving > 0) { // espuma de proa, estela y oleaje al desplazarse
      war.wakeAcc += dt;
      while (war.wakeAcc > 0.05) {
        war.wakeAcc -= 0.05;
        const bow = warWorld(10, 0.1, 0), stern = warWorld(-9.4, 0.1, 0);
        for (const s of [1, -1]) {
          spawn({ pos: bow.clone().add(V(rnd(-0.3, 0.3), 0, s * rnd(0.4, 1.2))), tex: smokeTex, vel: V(rnd(0.5, 2), rnd(1.5, 3.5) * war.moving, s * rnd(1.5, 3.5)), grav: 7, life: rnd(0.6, 1), s0: 0.5, s1: 1.4, color: 0xf2fbff, op: 0.9 });
          spawn({ pos: warWorld(rnd(-8, 8), 0.1, s * 1.75), tex: smokeTex, vel: V(-0.6, 0.3, s * rnd(0.6, 1.4)), life: 1.4, s0: 0.6, s1: 2.2, color: 0xe8f6ff, op: 0.6 });
        }
        spawn({ pos: stern.clone().add(V(0, 0, rnd(-1, 1))), tex: smokeTex, vel: V(-rnd(1, 2.5), rnd(0.4, 1.4), rnd(-0.8, 0.8)), life: rnd(1.4, 2.2), s0: 0.9, s1: 3.2, color: 0xf4fbff, op: 0.75 });
        if (Math.random() < 0.35) { ripple(bow.x, rnd(-2.6, 2.6), rnd(4, 7)); ripple(stern.x - 1, 0, rnd(6, 10), 0, 2.4); }
      }
    }
  });
  function warshipArrive() {
    if (war.present) return war.job;
    war.present = true;
    const prev = war.job;
    war.job = (async () => {
      if (prev) await prev;
      war.g.position.set(-40, 0, 0); war.g.visible = true;
      war.turrets.forEach((tr) => { tr.t.rotation.y = tr.rest; }); war.moving = 1;
      api.onWarship?.();
      shake(0.1, 1.2);
      await tween(5200, (t) => { war.g.position.x = -40 * (1 - t); war.moving = 1 - t * 0.85; }, easeOut);
      war.moving = 0;
      ripple(0, 0, 18, 0, 2.6); ripple(0, 0, 24, 0.3, 2.8);
    })();
    return war.job;
  }
  function warshipLeave() {
    if (!war.present) return war.job;
    war.present = false; war.beam.visible = false;
    const prev = war.job;
    war.job = (async () => {
      if (prev) await prev;
      war.moving = 0.3;
      await tween(4200, (t) => { war.g.position.x = 42 * t; war.moving = 0.3 + t * 0.7; }, easeIn);
      war.moving = 0; war.g.visible = false;
      for (const s of war.stuck) { war.wrap.remove(s); }
      war.stuck.length = 0;
    })();
    return war.job;
  }
  // una bala de jugador se queda clavada en el casco sin hacerle daño
  function warshipStick(x, dir) {
    const zSide = -dir * 1.9, p = V(x, 0.8, zSide * 0.88);
    clash(p); sparks(p, 18, 5, 0xffd27a);
    for (let i = 0; i < 4; i++) spawn({ pos: p, tex: smokeTex, vel: V(rnd(-0.3, 0.3), rnd(0.6, 1.2), -dir * rnd(0.2, 0.6)), life: 1.6, s0: 0.4, s1: 1.4, color: 0x4a4a4a, op: 0.6 });
    const shell = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.75, 12), brass), band = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.08, 12), copper);
    band.position.y = -0.15; shell.add(body, band);
    const local = war.wrap.worldToLocal(V(x + rnd(-0.2, 0.2), rnd(0.35, 1.05), zSide * 0.88 + -dir * 0.3));
    shell.position.copy(local); shell.rotation.x = Math.PI / 2 + rnd(-0.25, 0.25); shell.rotation.z = rnd(-0.3, 0.3);
    war.wrap.add(shell); war.stuck.push(shell); war.hitT = 0.25;
  }
  function launchMissile(from, to, ms, big = true) {
    const mid = from.clone().lerp(to, 0.5); mid.y += big ? 11 : 4;
    const m = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 10), new THREE.MeshStandardMaterial({ color: 0xe8e8e8, metalness: 0.4, roughness: 0.4 }));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 10), new THREE.MeshStandardMaterial({ color: 0xc81e1e })); nose.position.y = 0.55;
    const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffa040, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })); flame.position.y = -0.55; flame.scale.setScalar(0.9);
    m.add(body, nose, flame); m.scale.setScalar(1.4); m.position.copy(from); scene.add(m);
    let prev = from.clone(), acc = 0;
    return tween(ms, (t) => {
      const p = bezier(from, mid, to, t); m.position.copy(p);
      const d = p.clone().sub(prev); if (d.lengthSq() > 1e-6) m.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize());
      prev = p; flame.scale.setScalar(0.7 + Math.random() * 0.6);
      acc++;
      spawn({ pos: p.clone(), life: 0.25, s0: 0.6, s1: 0.1, add: true, color: 0xffb040 });
      if (acc % 2 === 0) spawn({ pos: p.clone(), tex: smokeTex, vel: V(rnd(-0.2, 0.2), 0.3, rnd(-0.2, 0.2)), life: 1.5, s0: 0.4, s1: 1.8, color: 0xdedede, op: 0.55 });
    }, easeIn).then(() => { scene.remove(m); });
  }
  function shipPoint(who) { const sp = ships[who].g.position; return V(sp.x + rnd(-3.5, 3.5), 1.1, zOf(who) * SHIP_Z + rnd(-0.6, 0.6)); }
  async function warshipFire(who) { // andanada: misiles múltiples + cañonazo de torreta contra un barco
    const jobs = [];
    const s = zOf(who), pods = war.pods.filter((p) => p.side === s);
    for (let i = 0; i < 4; i++) {
      const pod = pods[i % pods.length];
      jobs.push(wait(i * 170 + rnd(0, 80)).then(() => {
        const from = warWorld(pod.x + rnd(-0.4, 0.4), 2.2, pod.z);
        spawn({ pos: from, life: 0.3, s0: 1.4, s1: 0.2, add: true, color: 0xffd27a });
        for (let k = 0; k < 4; k++) spawn({ pos: from, tex: smokeTex, vel: V(rnd(-1, 1), rnd(0.2, 1), rnd(-1, 1)), life: 1.2, s0: 0.6, s1: 2.2, color: 0xcfcfcf, op: 0.6 });
        const to = shipPoint(who);
        return launchMissile(from, to, 1500 + rnd(0, 300)).then(() => {
          flashLight(to, 30, 0xff7a1a);
          spawn({ pos: to, life: 0.25, s0: 1, s1: 5, add: true, color: 0xfff1b8 });
          for (let k = 0; k < 8; k++) spawn({ pos: to, vel: V(rnd(-2, 2), rnd(1, 3.5), rnd(-2, 2)), drag: 1.2, life: rnd(0.5, 0.9), s0: 0.9, s1: 2.6, add: true, color: k % 2 ? 0xff7a18 : 0xffc04a });
          for (let k = 0; k < 5; k++) spawn({ pos: to, tex: smokeTex, vel: V(rnd(-0.8, 0.8), rnd(0.8, 1.8), rnd(-0.8, 0.8)), life: rnd(1.8, 2.6), s0: 1, s1: 3.6, color: 0x2a2a2a, op: 0.7 });
          sparks(to, 16, 6); hitShip(who); shake(0.2, 0.25);
        });
      }));
    }
    // cañonazo de la torreta que mira hacia ese barco
    const tr = war.turrets[who === 'me' ? 0 : 1], aim = who === 'me' ? -Math.PI / 2 : Math.PI / 2;
    jobs.push((async () => {
      const r0 = tr.t.rotation.y;
      await tween(500, (t) => { tr.t.rotation.y = r0 + (aim - r0) * t; }, easeInOut);
      for (const b of tr.barrels) {
        const mp = b.getWorldPosition(new THREE.Vector3()).add(V(0, 0, s * 1.2));
        flashLight(mp, 40, 0xffc070);
        spawn({ pos: mp, life: 0.2, s0: 2.6, s1: 0.4, add: true, color: 0xfff0b0 });
        for (let k = 0; k < 5; k++) spawn({ pos: mp, tex: smokeTex, vel: V(rnd(-0.6, 0.6), rnd(0, 0.6), s * rnd(1.5, 3.5)), drag: 1.4, life: 1.4, s0: 0.7, s1: 2.6, color: 0xbdbdbd, op: 0.6 });
        const to = shipPoint(who);
        launchMissile(mp, to, 650, false).then(() => { explodeShip(to); hitShip(who); });
        shake(0.18, 0.2);
        await wait(140);
      }
    })());
    await Promise.all(jobs);
  }
  // rayo láser que gira como la luz de un faro y barre un barco de punta a punta
  function aimBeam(from, to) {
    const d = to.clone().sub(from), len = d.length();
    war.beam.position.copy(from); war.beam.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize()); war.beam.scale.set(1, len, 1);
  }
  async function warshipLaser(who) {
    const s = zOf(who), lensP = () => war.lens.getWorldPosition(new THREE.Vector3());
    const sp0 = ships[who].g.position, e0 = lensP();
    const a0 = ((war.laser.rotation.y % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    let start = Math.atan2(-(zOf(who) * SHIP_Z - e0.z), sp0.x - 5.5 - e0.x);
    while (start > a0) start -= Math.PI * 2;
    if (a0 - start < Math.PI) start -= Math.PI * 2; // al menos una vuelta completa de faro
    war.beam.visible = true; war.halo.material.opacity = 0.3; war.core.material.opacity = 0.5;
    api.onLaser?.();
    // giro de faro: una vuelta completa barriendo el mar y levantando vapor
    let acc = 0;
    await tween(1300, (t) => {
      const a = a0 + (start - a0) * t; war.laser.rotation.y = a;
      const e = lensP(), dir = V(Math.cos(a), 0, -Math.sin(a)), hit = e.clone().add(dir.multiplyScalar(11)); hit.y = 0.15;
      aimBeam(e, hit);
      if (++acc % 2 === 0) { spawn({ pos: hit, tex: smokeTex, vel: V(0, rnd(1, 2), 0), life: 1.1, s0: 0.6, s1: 2, color: 0xffffff, op: 0.6 }); spawn({ pos: hit, life: 0.3, s0: 1.2, s1: 0.2, add: true, color: 0xff3050 }); }
    }, easeIn);
    // barrido sobre el barco rival: a lo largo de todo el casco, con humo y chispas
    war.halo.material.opacity = 0.65; war.core.material.opacity = 1;
    const sp = ships[who].g.position;
    await tween(1700, (t) => {
      const x = sp.x - 5.5 + 11 * t, hit = V(x, 1.2 + Math.sin(t * 30) * 0.15, zOf(who) * SHIP_Z), e = lensP();
      war.laser.rotation.y = Math.atan2(-(hit.z - e.z), hit.x - e.x);
      aimBeam(e, hit);
      war.halo.scale.set(0.3 + Math.random() * 0.12, 1, 0.3 + Math.random() * 0.12);
      spawn({ pos: hit, life: 0.25, s0: 1.8, s1: 0.3, add: true, color: Math.random() < 0.5 ? 0xff2040 : 0xffd0d8 });
      spawn({ pos: hit, vel: V(rnd(-2, 2), rnd(1, 4), rnd(-2, 2)), grav: 8, life: 0.5, s0: 0.25, s1: 0.05, add: true, color: 0xffb060 });
      if (Math.random() < 0.5) spawn({ pos: hit.clone().add(V(0, 0.3, 0)), tex: smokeTex, vel: V(rnd(-0.3, 0.3), rnd(1.2, 2.2), rnd(-0.3, 0.3)), drag: 0.3, life: rnd(2, 3), s0: 0.8, s1: 3, color: 0x222222, op: 0.7 });
      if (Math.random() < 0.12) { flashLight(hit, 22, 0xff2040); hitShip(who); }
    }, easeInOut);
    war.beam.visible = false;
    burns.push({ who, left: 4.5 });
    shake(0.25, 0.4);
  }
  async function warshipVolley(targets, laserWho) {
    const jobs = targets.map((w) => warshipFire(w));
    if (laserWho) jobs.push(wait(400).then(() => warshipLaser(laserWho)));
    await Promise.all(jobs);
    war.turrets.forEach((tr) => { const r0 = tr.t.rotation.y; tween(700, (t) => { tr.t.rotation.y = r0 + (tr.rest - r0) * t; }, easeInOut); });
  }

  // ==================== Isla de los monos (ronda 9) ====================
  const isle = (() => {
    const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
    const sandM = new THREE.MeshStandardMaterial({ color: 0xe6c98a, roughness: 0.95 });
    const wetM = new THREE.MeshStandardMaterial({ color: 0xb59a62, roughness: 0.8 });
    const grassM = new THREE.MeshStandardMaterial({ color: 0x3f9b3a, roughness: 0.9 });
    const rockM = new THREE.MeshStandardMaterial({ color: 0x6d6a66, roughness: 0.9 });
    const wet = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 16), wetM); wet.scale.set(8.4, 0.55, 3.6); wet.position.y = -0.2; body.add(wet);
    const sand = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 16), sandM); sand.scale.set(7.8, 0.85, 3.1); sand.position.y = -0.1; sand.receiveShadow = true; body.add(sand);
    const hill = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 12), grassM); hill.scale.set(4.6, 0.75, 1.5); hill.position.set(0, 0.2, -1); body.add(hill);
    for (const [x, z, s] of [[-6.6, 1.2, 0.6], [6.4, -1.4, 0.75], [-5.2, -2, 0.5], [3.4, 2.3, 0.4]]) {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(s), rockM); r.position.set(x, 0.25, z); r.rotation.set(rnd(0, 3), rnd(0, 3), 0); body.add(r);
    }
    const foam = new THREE.Mesh(new THREE.RingGeometry(0.98, 1.12, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }));
    foam.scale.set(8.5, 1, 3.7); foam.position.y = 0.16; g.add(foam);
    // palmeras de coco
    const trunkM = new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.9 }), leafM = new THREE.MeshStandardMaterial({ color: 0x2e8b3a, roughness: 0.7, side: THREE.DoubleSide }), nutM = new THREE.MeshStandardMaterial({ color: 0x5a3a1c, roughness: 0.8 });
    const palms = [[-6, -1.2, 0.3], [-3, -1.6, -0.25], [0, -1.9, 0.15], [3, -1.5, -0.3], [6.1, -0.9, 0.25], [-1.6, 1.8, 0.4]].map(([x, z, lean]) => {
      const p = new THREE.Group(); p.position.set(x, 0.35, z); body.add(p);
      const curve = new THREE.QuadraticBezierCurve3(V(0, 0, 0), V(lean * 1.2, 1.8, 0), V(lean * 3, 3.6, 0.2));
      p.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.17, 8), trunkM));
      const crown = new THREE.Group(); crown.position.copy(curve.getPoint(1)); p.add(crown);
      for (let i = 0; i < 7; i++) {
        const leaf = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.95, 6, 1), leafM);
        const pa = leaf.geometry.attributes.position;
        for (let k = 0; k < pa.count; k++) { const lx = pa.getX(k) + 1.2; pa.setX(k, lx); pa.setY(k, -0.2 * lx * lx + pa.getY(k) * 0.2); pa.setZ(k, pa.getY(k) === 0 ? 0 : pa.getZ(k)); }
        leaf.geometry.computeVertexNormals(); leaf.rotation.y = (i / 7) * Math.PI * 2; leaf.rotation.x = 0.3; crown.add(leaf);
      }
      for (let i = 0; i < 3; i++) { const n = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), nutM); n.position.set(Math.cos(i * 2.1) * 0.25, -0.2, Math.sin(i * 2.1) * 0.25); crown.add(n); }
      return { p, crown, ph: rnd(0, 6) };
    });
    // monos: uno por carril (posiciones 1, 2, 3 y 4)
    const furM = new THREE.MeshStandardMaterial({ color: 0x8a5530, roughness: 0.85 }), faceM = new THREE.MeshStandardMaterial({ color: 0xe0b48a, roughness: 0.8 }), eyeM = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const MK = 2.1; // tamaño de los monos
    const monkeys = LANE_X.map((x) => {
      const root = new THREE.Group(); root.position.set(x, 0.55, 0.4); root.scale.setScalar(MK); g.add(root);
      const rig = new THREE.Group(); root.add(rig);
      const bodyM = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), furM); bodyM.scale.set(1, 1.15, 0.9); bodyM.position.y = 0.45; rig.add(bodyM);
      const belly = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), faceM); belly.position.set(0, 0.42, 0.2); belly.scale.set(1, 1.1, 0.6); rig.add(belly);
      const head = new THREE.Group(); head.position.y = 1.08; rig.add(head);
      head.add(new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), furM));
      const face = new THREE.Mesh(new THREE.SphereGeometry(0.25, 14, 10), faceM); face.scale.set(1.1, 0.85, 0.6); face.position.set(0, -0.05, 0.2); head.add(face);
      for (const s of [-1, 1]) {
        const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), eyeM); e.position.set(s * 0.1, 0.05, 0.33); head.add(e);
        const ear = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), faceM); ear.scale.z = 0.5; ear.position.set(s * 0.36, 0.04, 0); head.add(ear);
      }
      const arms = [-1, 1].map((s) => {
        const a = new THREE.Group(); a.position.set(s * 0.38, 0.7, 0); rig.add(a);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.62, 8), furM); m.position.y = -0.3; a.add(m);
        const hand = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), faceM); hand.position.y = -0.62; a.add(hand);
        a.rotation.z = s * 0.35; return a;
      });
      const tail = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.05, 6, 16, Math.PI * 1.4), furM); tail.position.set(0, 0.35, -0.42); tail.rotation.y = Math.PI / 2; rig.add(tail);
      const nut = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), nutM); nut.position.y = -0.7; arms[1].add(nut);
      return { root, rig, head, arms, nut, alive: true, ph: rnd(0, 6), throwT: 0 };
    });
    g.position.y = -3; g.visible = false; scene.add(g);
    return { g, palms, monkeys, foam, MK, present: false, job: null };
  })();
  frameHooks.push((dt, t) => {
    if (!isle.g.visible) return;
    isle.foam.material.opacity = 0.45 + Math.sin(t * 2) * 0.2; isle.foam.scale.set(8.5 + Math.sin(t * 1.6) * 0.12, 1, 3.7 + Math.sin(t * 1.6) * 0.06);
    for (const p of isle.palms) { p.crown.rotation.z = Math.sin(t * 1.3 + p.ph) * 0.08; p.crown.rotation.x = Math.sin(t * 1.1 + p.ph) * 0.06; }
    for (const m of isle.monkeys) {
      if (!m.alive || m.throwT > 0) continue;
      m.rig.position.y = Math.abs(Math.sin(t * 3.2 + m.ph)) * 0.12;
      m.arms[0].rotation.x = Math.sin(t * 3.2 + m.ph) * 0.4; m.head.rotation.z = Math.sin(t * 1.7 + m.ph) * 0.15;
    }
  });
  function islandShow(targets) {
    if (targets) isle.monkeys.forEach((m, id) => { if (targets[id] != null) m.root.rotation.y = targets[id] === 'me' ? 0 : Math.PI; });
    if (isle.present) return isle.job;
    isle.present = true;
    const prev = isle.job;
    isle.job = (async () => {
      if (prev) await prev;
      isle.monkeys.forEach((m) => { m.alive = true; m.root.visible = true; m.root.scale.setScalar(0.01); m.rig.rotation.set(0, 0, 0); m.rig.position.set(0, 0, 0); m.nut.visible = true; });
      isle.g.visible = true; isle.g.position.y = -3;
      for (let i = 0; i < 4; i++) ripple(rnd(-5, 5), rnd(-2, 2), rnd(8, 14), i * 0.25, 2.2);
      shake(0.12, 1.4);
      let acc = 0;
      await tween(2200, (t) => {
        isle.g.position.y = -3 * (1 - t);
        if (++acc % 3 === 0) spawn({ pos: V(rnd(-8, 8), 0.2, rnd(-3.4, 3.4)), tex: smokeTex, vel: V(0, rnd(1.5, 3), 0), grav: 5, life: 1, s0: 0.6, s1: 1.8, color: 0xf2fbff, op: 0.85 });
      }, easeOut);
      for (const [i, m] of isle.monkeys.entries()) {
        tween(450, (t) => { m.root.scale.setScalar(isle.MK * Math.max(0.01, easeOut(t) * (1 + Math.sin(t * Math.PI) * 0.25))); });
        await wait(120 + i * 30);
      }
    })();
    return isle.job;
  }
  function islandLeave() {
    if (!isle.present) return;
    isle.present = false;
    const prev = isle.job;
    isle.job = (async () => {
      if (prev) await prev;
      for (let i = 0; i < 4; i++) ripple(rnd(-5, 5), rnd(-2, 2), rnd(8, 14), i * 0.25, 2.2);
      await tween(2200, (t) => { isle.g.position.y = -3.2 * t; }, easeIn);
      isle.g.visible = false;
    })();
    return isle.job;
  }
  async function monkeyThrow(id, who) {
    const m = isle.monkeys[id];
    if (!m?.alive) return;
    m.root.rotation.y = who === 'me' ? 0 : Math.PI;
    m.throwT = 1;
    const arm = m.arms[1];
    await tween(380, (t) => { arm.rotation.x = -2.6 * easeOut(t); m.rig.rotation.x = -0.25 * t; });
    const from = m.nut.getWorldPosition(new THREE.Vector3()); m.nut.visible = false;
    tween(220, (t) => { arm.rotation.x = -2.6 + 3.4 * t; m.rig.rotation.x = -0.25 + 0.45 * t; }).then(() => tween(300, (t) => { arm.rotation.x = 0.8 * (1 - t); m.rig.rotation.x = 0.2 * (1 - t); })).then(() => { m.throwT = 0; if (m.alive) m.nut.visible = true; });
    const to = shipPoint(who), mid = from.clone().lerp(to, 0.5); mid.y += 6;
    const nut = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), new THREE.MeshStandardMaterial({ color: 0x5a3a1c, roughness: 0.8 })); nut.position.copy(from); scene.add(nut);
    await tween(1250, (t) => { nut.position.copy(bezier(from, mid, to, t)); nut.rotation.x += 0.3; nut.rotation.z += 0.2; });
    scene.remove(nut);
    spawn({ pos: to, life: 0.2, s0: 0.8, s1: 2.6, add: true, color: 0xfff1d0 });
    for (let k = 0; k < 9; k++) { // trozos de coco y leche
      spawn({ pos: to, vel: V(rnd(-2.5, 2.5), rnd(2, 4.5), rnd(-2.5, 2.5)), grav: 10, life: 0.8, s0: 0.35, s1: 0.2, color: k % 2 ? 0x5a3a1c : 0xfaf6ee, op: 1 });
    }
    hitShip(who); shake(0.1, 0.15);
    api.onCoconut?.();
  }
  async function monkeyKill(id) {
    const m = isle.monkeys[id];
    if (!m?.alive) return;
    m.alive = false; m.nut.visible = false;
    const p = m.root.getWorldPosition(new THREE.Vector3()).add(V(0, 0.9, 0));
    sparks(p, 16, 5); spawn({ pos: p, life: 0.25, s0: 1, s1: 3, add: true, color: 0xfff1b8 });
    const dz = m.root.rotation.y === 0 ? -1 : 1, y0 = m.root.position.y;
    await tween(750, (t) => { m.rig.rotation.x = dz * 5 * t; m.root.position.y = y0 + Math.sin(t * Math.PI) * 1.4; m.root.position.z = 0.4 + dz * 1.2 * t; }, easeOut);
    for (let k = 0; k < 8; k++) spawn({ pos: m.root.getWorldPosition(new THREE.Vector3()).add(V(0, 0.5, 0)), tex: smokeTex, vel: V(rnd(-1, 1), rnd(0.5, 1.5), rnd(-1, 1)), life: 1, s0: 0.6, s1: 1.8, color: 0xf0f0f0, op: 0.8 });
    m.root.visible = false; m.root.position.set(LANE_X[id], y0, 0.4); m.rig.rotation.x = 0;
  }
  function labelAt(p, html, ms = 2900) {
    const { x, y } = toScreen(p);
    const el = document.createElement('div');
    el.className = 'dmg'; el.style.left = x + 'px'; el.style.top = y + 'px'; el.innerHTML = html;
    container.appendChild(el); setTimeout(() => el.remove(), ms);
  }
  function monkeyLabel(id, html) { labelAt(V(LANE_X[id], 3.6, 0.4), html); }
  function warshipLabel(html) { labelAt(V(0, 6, 0), html); }

  // Animales asustados: se van sin paraguas y vuelven al acabar la ronda especial
  let calmOn = false;
  function setCalm(on) {
    if (on === calmOn) return;
    calmOn = on;
    for (const w of ['me', 'op']) on ? sharkLeave(w, false) : !stormOn && sharkReturn(w);
  }

  // x en unidades de 1,5 (posición real del cañón); 'miss' = la bala se pierde fuera de la pantalla
  function fire({ from, x: xu, lane, target, owner, fromX, sub: fromSub = false, octopus: fromOctopus = false, toward, ice, flame = false }) {
    const dir = fromSub ? (toward === 'me' ? 1 : -1) : fromOctopus ? Math.sign(zOf(owner)) : (from === 'me' ? -1 : 1);
    const x = xu !== undefined ? xu * UNIT : LANE_X[lane - 1], y = fromSub ? 0.9 : 1.3;
    const startX = fromOctopus && fromX !== undefined ? fromX * UNIT : x;
    const startZ = fromSub ? dir * 1.0 : fromOctopus ? 0 : -dir * MUZZLE_Z;
    const endZ = target === 'warship' ? -dir * 1.67 : target === 'monkey' ? 0.4 - dir * 0.9 : ['collision', 'whale', 'sub', 'ice', 'octopus', 'medkit', 'bucket', 'gull', 'log'].includes(target) ? 0 : target === 'squid' ? zOf(owner) * 11 : target === 'shark' ? zOf(owner) * FIN_Z : zOf(owner) * HIT_SHIP_Z;
    const finalZ = target === 'miss' ? zOf(owner) * OUT_Z : endZ;
    const flight = ((Math.abs(endZ - startZ) + (target === 'whale' ? Math.abs(zOf(owner) * HIT_SHIP_Z - endZ) : 0)) / SPEED) * 1000;

    const m = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.46, 14), brass);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 14), shellSteel); tip.position.y = 0.38;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.05, 14), copper); band.position.y = -0.1;
    m.add(body, tip, band);
    m.rotation.x = dir < 0 ? -Math.PI / 2 : Math.PI / 2;
    const holder = new THREE.Group(); holder.add(m);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff9a2e, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    glow.scale.setScalar(1.1); holder.add(glow);
    if (flame) { // bala de fuego: núcleo incandescente envuelto en llamas
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffe08a }));
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.36, 14, 10), new THREE.MeshBasicMaterial({ color: 0xff3d00, transparent: true, opacity: 0.85, depthWrite: false }));
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.3, 14, 1, true), new THREE.MeshBasicMaterial({ color: 0xff5a10, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
      tail.rotation.x = dir < 0 ? -Math.PI / 2 : Math.PI / 2; tail.position.z = -dir * 0.7; // cola de llama detrás de la bola
      holder.add(tail, shell, core); m.visible = false;
      glow.material.color.set(0xff3300); glow.scale.setScalar(2.4);
    }
    holder.position.set(startX, y, startZ);
    holder.scale.setScalar(1.7);
    scene.add(holder);

    const mp = V(x, y, startZ);
    spawn({ pos: mp, life: 0.18, s0: 1.8, s1: 0.5, add: true, color: 0xffe3a0 });
    flashLight(mp, 14);
    for (let i = 0; i < 7; i++) {
      spawn({ pos: mp, tex: smokeTex, vel: V(rnd(-0.6, 0.6), rnd(0, 0.5), dir * rnd(1, 3)), drag: 1.5, life: 1.3, s0: 0.5, s1: 2, color: 0xb8b8b8, op: 0.6 });
    }
    if (!fromSub && !fromOctopus) {
      const br = ships[from].turrets[lane - 1].barrels;
      tween(300, (t) => { br.position.z = 0.38 * Math.sin(Math.PI * Math.pow(t, 0.5)) * (1 - t * 0.2); }, easeOut).then(() => { br.position.z = 0; });
    }

    let done;
    const promise = new Promise((r) => { done = r; });
    bullets.push({ holder, m, dir, startX, startZ, endZ, finalZ, x, target, owner, ice, trail: 0, done, glow, passed: false, flame });
    return { flight, done: promise };
  }

  function impact(b) {
    const p = V(b.x, b.target === 'ship' ? 1.1 : b.target === 'shark' ? 0.5 : 1.3, b.endZ);
    if (b.flame) { // estallido de fuego
      sparks(p, 26, 7, 0xff7a1a);
      for (let i = 0; i < 10; i++) spawn({ pos: p.clone().add(V(rnd(-0.5, 0.5), rnd(0, 0.4), rnd(-0.5, 0.5))), vel: V(rnd(-1, 1), rnd(1, 2.6), rnd(-1, 1)), life: 0.7, s0: 1.4, s1: 0.3, add: true, color: i % 2 ? 0xff4a12 : 0xffc040 });
    }
    if (b.target === 'ship') { explodeShip(p); hitShip(b.owner); }
    else if (b.target === 'shark') { splash(V(b.x, 0.2, b.endZ)); hitShark(b.owner); }
    else if (b.target === 'sub') { clash(V(b.x, 0.9, 0)); sub.hitT = 0.5; }
    else if (b.target === 'octopus') { clash(V(b.x, 0.8, 0)); shake(0.12, 0.25); }
    else if (b.target === 'medkit') medkitCollect();
    else if (b.target === 'bucket') bucketSink();
    else if (b.target === 'gull') gullShot();
    else if (b.target === 'log') logHit(b.x);
    else if (b.target === 'squid') squidBlock();
    else if (b.target === 'ice') { clash(V(b.x, 0.9, 0)); iceBreak(b.ice); }
    else if (b.target === 'warship') warshipStick(b.x, b.dir);
    else if (b.target === 'monkey') { sparks(p, 20, 6); flashLight(p, 14); }
    else clash(p);
  }

  // La orca devuelve la bala: da la vuelta y va hacia el barco que disparó
  function bounceOff(b) {
    const p = V(b.x, 1.3, 0);
    spawn({ pos: p, life: 0.25, s0: 1, s1: 5, add: true, color: 0xffffff });
    sparks(p, 22, 6, 0xcfe6ff);
    ripple(b.x, 0, 4);
    hitShark('mid'); shake(0.15, 0.3);
    api.onBounce?.();
    b.holder.position.z = 0;
    b.dir = -b.dir;
    b.m.rotation.x = b.dir < 0 ? -Math.PI / 2 : Math.PI / 2;
    b.endZ = zOf(b.owner) * HIT_SHIP_Z; b.target = 'ship';
  }

  // ---------- Etiquetas HTML sobre la escena ----------
  function toScreen(v) {
    const p = v.clone().project(camera);
    return { x: (p.x * 0.5 + 0.5) * container.clientWidth, y: (-p.y * 0.5 + 0.5) * container.clientHeight };
  }
  function label(kind, who, html, ms = 2900, high = false) {
    const pos = kind === 'ship' ? V(ships[who].g.position.x, high ? 3.1 : 2.2, zOf(who) * SHIP_Z) : V(sharks[who].root.position.x, 2.6, zOf(who) * FIN_Z);
    const { x, y } = toScreen(pos);
    const el = document.createElement('div');
    el.className = 'dmg'; el.style.left = x + 'px'; el.style.top = y + 'px'; el.innerHTML = html;
    container.appendChild(el); setTimeout(() => el.remove(), ms);
  }
  const tracked = [];
  function trackLabel(el, who) { tracked.push({ el, who }); }
  function trackPoint(el, x, y, z) { tracked.push({ el, p: V(x, y, z) }); }
  // punto de mi barco: sigue al barco cuando se mueve con el oleaje
  function trackShip(el, who, lx, y, z) { tracked.push({ el, who, lx, y, z }); }

  // ---------- Cañones: vida de 25, quemados al dañarse y rotos al llegar a 0 ----------
  const xTex = canvasTex(128, 128, (g) => {
    g.fillStyle = 'rgba(30,0,0,.85)'; g.beginPath(); g.arc(64, 64, 52, 0, 7); g.fill();
    g.lineWidth = 6; g.strokeStyle = '#ff5252'; g.stroke();
    g.lineWidth = 12; g.beginPath(); g.moveTo(38, 38); g.lineTo(90, 90); g.moveTo(90, 38); g.lineTo(38, 90); g.stroke();
  });
  const turretBurnt = new THREE.Color(0x5a2a22);
  function setCannons(c) {
    for (const who of ['me', 'op']) {
      ships[who].turrets.forEach((tu, i) => {
        const hp = c[who][i];
        tu.hp = hp;
        tu.tMat.color.copy(ships[who].palette.turret).lerp(turretBurnt, (1 - Math.max(0, hp / 25)) * 0.85);
        if (hp <= 0 && !tu.broken) {
          tu.broken = true;
          tu.num.material.map = xTex; tu.num.material.needsUpdate = true;
          tween(500, (t) => { tu.barrels.rotation.x = -0.55 * t; }, easeIn);
          const p = tu.node.getWorldPosition(new THREE.Vector3()); p.y += 1;
          spawn({ pos: p, life: 0.3, s0: 1, s1: 4, add: true, color: 0xffb060 });
          sparks(p, 16, 4);
        } else if (hp > 0 && tu.broken) { // regenerado
          tu.broken = false;
          tu.num.material.map = tu.num.userData.tex; tu.num.material.needsUpdate = true;
          const from = tu.barrels.rotation.x;
          tween(500, (t) => { tu.barrels.rotation.x = from * (1 - t); }, easeOut);
          const p = tu.node.getWorldPosition(new THREE.Vector3()); p.y += 1;
          spawn({ pos: p, life: 0.5, s0: 1, s1: 5, add: true, color: 0x7dff9a });
          sparks(p, 14, 4, 0x9dffb0);
        }
      });
    }
  }
  // Disparo con un cañón roto: solo sale humo
  // rayo del cielo sobre un cañón bloqueado
  function lightningStrike(who, lane) {
    const base = ships[who].turrets[lane - 1].node.getWorldPosition(new THREE.Vector3()); base.y += 0.6;
    const mat = new THREE.LineBasicMaterial({ color: 0xe1f5fe, transparent: true, opacity: 1 });
    const bolts = [0, 1, 2].map(() => {
      const pts = [];
      for (let i = 0; i <= 9; i++) {
        const k = i / 9;
        pts.push(V(base.x + (i === 9 ? 0 : rnd(-0.5, 0.5)) * (1 - k * 0.4), base.y + 9 * (1 - k), base.z + (i === 9 ? 0 : rnd(-0.5, 0.5))));
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
      scene.add(line); return line;
    });
    const halo = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), new THREE.MeshBasicMaterial({ color: 0x81d4fa, transparent: true, opacity: 0.7, depthWrite: false }));
    halo.position.copy(base); scene.add(halo);
    flashLight(base.clone().add(V(0, 1.5, 0)), 9, 0xbfe9ff);
    sparks(base, 26, 6, 0xe1f5fe); sparks(base, 14, 3, 0x4fc3f7);
    shake(0.25, 0.35);
    tween(700, (t) => {
      mat.opacity = t < 0.5 ? (Math.floor(t * 24) % 2 ? 0.35 : 1) : 1 - (t - 0.5) * 2;
      halo.material.opacity = 0.7 * (1 - t); halo.scale.setScalar(1 + t * 0.8);
    }).then(() => { bolts.forEach((b) => { scene.remove(b); b.geometry.dispose(); }); scene.remove(halo); mat.dispose(); });
  }
  function dud(who, lane) {
    const p = ships[who].turrets[lane - 1].node.getWorldPosition(new THREE.Vector3()); p.y += 1.1;
    for (let i = 0; i < 4; i++) spawn({ pos: p, tex: smokeTex, vel: V(rnd(-0.3, 0.3), rnd(0.5, 1), rnd(-0.3, 0.3)), life: 1.4, s0: 0.4, s1: 1.6, color: 0x333333, op: 0.6 });
  }
  function labelCannon(who, lane, html, ms = 2900) {
    const p = ships[who].turrets[lane - 1].node.getWorldPosition(new THREE.Vector3()); p.y += 2.8;
    const { x, y } = toScreen(p);
    const el = document.createElement('div');
    el.className = 'dmg'; el.style.left = x + 'px'; el.style.top = y + 'px'; el.innerHTML = html;
    container.appendChild(el); setTimeout(() => el.remove(), ms);
  }

  // ---------- Cámara ----------
  // Zona tapada por los paneles del HUD (px arriba y abajo): los barcos se encuadran en la franja libre.
  const insets = { top: 0, bottom: 0 };
  function fit() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    let top = insets.top, bottom = insets.bottom;
    if (h - top - bottom < h * 0.45) { const k = (h * 0.55) / (top + bottom); top *= k; bottom *= k; }
    const band = h - top - bottom;
    camera.aspect = w / band;
    camera.clearViewOffset();
    const el = (57 * Math.PI) / 180, dirv = V(0, Math.sin(el), Math.cos(el));
    const pts = [V(-7.8, 0, SHIP_Z + 1.7), V(7.8, 0, SHIP_Z + 1.7), V(-7.8, 0, -SHIP_Z - 1.7), V(7.8, 0, -SHIP_Z - 1.7), V(0, 3.4, -SHIP_Z - 0.5)];
    for (let d = 12; d < 120; d += 0.4) {
      camera.position.copy(dirv).multiplyScalar(d); camera.lookAt(0, 0, 0.3); camera.updateMatrixWorld();
      if (pts.every((q) => { const n = q.clone().project(camera); return Math.abs(n.x) < 0.97 && Math.abs(n.y) < 0.94; })) break;
    }
    // El encuadre calculado ocupa la franja libre; se amplía la ventana para cubrir todo el lienzo.
    camera.setViewOffset(w, band, 0, -Math.round(top), w, h);
    baseCam.copy(camera.position);
  }
  function setInsets(top, bottom) {
    if (Math.abs(top - insets.top) < 1 && Math.abs(bottom - insets.bottom) < 1) return;
    insets.top = top; insets.bottom = bottom; fit();
  }
  new ResizeObserver(fit).observe(container);
  fit();

  // ---------- Bucle principal ----------
  let time = 0, last = performance.now();
  function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!container.clientWidth) return;
    time += dt;
    for (const hook of frameHooks) hook(dt, time);

    // Tiempo atmosférico
    lightning = Math.max(0, lightning - dt * 3.5);
    if (storm > 0.8 || lightningOn) {
      nextBolt -= dt;
      if (nextBolt <= 0) { lightning = 1; nextBolt = lightningOn ? rnd(2.2, 4) : rnd(5, 10); setTimeout(() => api.onThunder?.(), 450); }
    }
    hemi.intensity = 0.8 - 0.3 * storm + lightning * 3;
    sun.intensity = 2.6 - 1.9 * storm + lightning * 4;
    scene.environmentIntensity = 1 - 0.65 * storm + lightning * 1.5;
    renderer.toneMappingExposure = 1.05 - 0.15 * storm;
    waterMat.uniforms.uTime.value = time;
    waterMat.uniforms.uStorm.value = storm;
    waterMat.uniforms.uRough.value = rough;
    skyMat.uniforms.uStorm.value = storm;

    if (storm > 0.02) {
      rain.visible = true; rainMat.opacity = 0.5 * storm;
      for (let i = 0; i < RAIN_N; i++) {
        let y = rd[i * 3 + 1] - 24 * dt, x = rd[i * 3] - 3 * dt;
        if (y < 0) { y += 18; x = rnd(-16, 16); rd[i * 3 + 2] = rnd(-14, 14); }
        rd[i * 3] = x; rd[i * 3 + 1] = y;
        const z = rd[i * 3 + 2], o = i * 6;
        rainPos[o] = x; rainPos[o + 1] = y; rainPos[o + 2] = z;
        rainPos[o + 3] = x + 0.1; rainPos[o + 4] = y + 0.7; rainPos[o + 5] = z;
      }
      rainGeo.attributes.position.needsUpdate = true;
      if (Math.random() < dt * 14 * storm) ripple(rnd(-8, 8), rnd(-8, 8), 0.9, 0, 0.7);
    } else rain.visible = false;

    snowMat.opacity = 0.9 * snowAmount;
    snow.visible = snowAmount > 0.02;
    if (snow.visible) {
      for (let i = 0; i < SNOW_N; i++) {
        const offset = i * 3;
        snowPos[offset + 1] -= dt * (1.1 + (i % 7) * 0.12);
        snowPos[offset] += Math.sin(time * 0.7 + i) * dt * 0.28;
        if (snowPos[offset + 1] < 0) {
          snowPos[offset] = rnd(-16, 16); snowPos[offset + 1] = rnd(14, 19); snowPos[offset + 2] = rnd(-14, 14);
        }
      }
      snowGeo.attributes.position.needsUpdate = true;
    }

    for (const who of ['me', 'op']) {
      const s = ships[who];
      const k = 1 + rough * 3;
      s.wrap.position.y = Math.sin(time * (1.2 + rough) + s.phase) * 0.07 * k;
      s.wrap.rotation.z = Math.sin(time * (0.9 + rough * 0.8) + s.phase) * 0.018 * (1 + rough * 5);
      s.wrap.rotation.x = Math.sin(time * (0.7 + rough * 0.6) + s.phase) * 0.01 * (1 + rough * 5);
      s.radar.rotation.y = time * 2;
      if (s.skins.viking.visible) {
        const row = time * 2.4 + s.phase;
        for (const o of s.oars) { o.pivot.rotation.y = o.s * Math.sin(row) * 0.3; o.arm.rotation.x = o.s * (0.75 + 0.16 * Math.cos(row)); }
        s.sail.scale.z = 1 + 0.14 * Math.sin(time * 1.6 + s.phase);
      }
      const fp = s.flag.geometry.attributes.position;
      for (let i = 0; i < fp.count; i++) fp.setZ(i, Math.sin(Math.abs(s.flagBase[i * 3]) * 4 - time * 6) * 0.12 * (Math.abs(s.flagBase[i * 3]) / 1.5));
      fp.needsUpdate = true;
      if (s.hitT > 0) {
        s.hitT -= dt;
        s.wrap.position.x = Math.sin(s.hitT * 60) * 0.12 * (s.hitT / 0.5);
        s.hullMat.emissive.setRGB(0.9 * (s.hitT / 0.5), 0.25 * (s.hitT / 0.5), 0);
      } else { s.wrap.position.x = 0; s.hullMat.emissive.setRGB(0, 0, 0); }
      const dmg = 1 - s.ratio;
      if (dmg > 0.5) {
        s.smokeAcc += dt * (2 + (dmg - 0.5) * 14);
        while (s.smokeAcc > 1) {
          s.smokeAcc -= 1;
          const p = V(s.g.position.x + rnd(-5, 5), 1.4, zOf(who) * SHIP_Z + rnd(-0.6, 0.6));
          spawn({ pos: p, tex: smokeTex, vel: V(rnd(-0.2, 0.2), rnd(0.8, 1.4), rnd(-0.2, 0.2)), life: 2.4, s0: 0.8, s1: 2.8, color: 0x202020, op: 0.6 });
          if (dmg > 0.7) spawn({ pos: p, vel: V(0, 0.8, 0), life: 0.5, s0: 0.9, s1: 0.2, add: true, color: 0xff7a18, op: 0.8 });
        }
      } else if (!s.skins.viking.visible) {
        s.puffAcc += dt;
        if (s.puffAcc > 0.28) {
          s.puffAcc = 0;
          spawn({ pos: s.g.localToWorld(V(0, 2.3, 0.7)), tex: smokeTex, vel: V(rnd(-0.1, 0.1), 0.7, rnd(-0.1, 0.1)), life: 1.8, s0: 0.4, s1: 1.6, color: 0x888888, op: 0.28 });
        }
      }
      for (const tu of s.turrets) {
        if (!tu.broken) continue;
        tu.acc += dt;
        if (tu.acc > 0.22) {
          tu.acc = 0;
          const p = tu.node.getWorldPosition(new THREE.Vector3()); p.y += 1;
          spawn({ pos: p, tex: smokeTex, vel: V(rnd(-0.15, 0.15), rnd(0.7, 1.2), rnd(-0.15, 0.15)), life: 1.8, s0: 0.5, s1: 1.9, color: 0x1c1c1c, op: 0.6 });
        }
      }
      tickShark(sharks[who], s.phase, dt);
    }
    tickShark(sharks.mid, 1, dt);
    if (sub.present) {
      sub.g.rotation.z = Math.sin(time * 1.5) * 0.03; sub.g.rotation.x = Math.sin(time * 1.1) * 0.02;
      if (sub.hitT > 0) { sub.hitT -= dt; const e = sub.hitT / 0.5; sub.hullM.emissive.setRGB(0.9 * e, 0.25 * e, 0); } else sub.hullM.emissive.setRGB(0, 0, 0);
      sub.acc += dt;
      if (sub.acc > 0.12) { sub.acc = 0; spawn({ pos: V(sub.g.position.x - 2.3, 0.1, rnd(-0.2, 0.2)), tex: smokeTex, life: 0.9, s0: 0.3, s1: 1.1, color: 0xffffff, op: 0.5 }); }
    }
    ices.forEach((s, id) => { if (s.present) { s.g.position.y = -0.2 + Math.sin(time * 1.4 + id * 2) * 0.07; s.g.rotation.y += dt * 0.15; } });

    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.holder.position.z += b.dir * SPEED * dt;
      if (b.startX !== b.x) {
        const span = b.endZ - b.startZ;
        const progress = span === 0 ? 1 : Math.max(0, Math.min(1, (b.holder.position.z - b.startZ) / span));
        b.holder.position.x = b.startX + (b.x - b.startX) * progress;
        b.holder.rotation.y = Math.atan2((b.x - b.startX) * b.dir, Math.abs(span));
      }
      b.glow.material.opacity = 0.75 + Math.random() * 0.25;
      b.trail += dt;
      while (b.trail > 0.035) {
        b.trail -= 0.035;
        const p = b.holder.position.clone();
        spawn({ pos: p, tex: smokeTex, life: 1.3, s0: 0.35, s1: 1.5, color: 0xcfcfcf, op: 0.5 });
        spawn({ pos: p.clone().setZ(p.z - b.dir * 0.25), life: 0.25, s0: 0.35, s1: 0.05, add: true, color: 0xffa040 });
        if (b.flame) {
          for (let f = 0; f < 2; f++) spawn({ pos: p.clone().add(V(rnd(-0.15, 0.15), rnd(-0.1, 0.15), -b.dir * rnd(0.3, 0.9))), vel: V(rnd(-0.5, 0.5), rnd(0.5, 1.4), -b.dir * rnd(0.5, 1.5)), life: 0.5, s0: 1.3, s1: 0.2, color: f ? 0xff3d00 : 0xff8a1a, op: 0.9 });
          spawn({ pos: p.clone(), life: 0.3, s0: 0.9, s1: 0.2, add: true, color: 0xffc040 });
          spawn({ pos: p.clone(), tex: smokeTex, vel: V(0, 0.6, 0), life: 1, s0: 0.4, s1: 1.4, color: 0x3a2a22, op: 0.45 });
        }
      }
      if (!b.passed && b.dir * (b.holder.position.z - b.endZ) >= 0) {
        if (b.target === 'whale') bounceOff(b);
        else if (b.target === 'miss') { b.passed = true; b.done(); }
        else { scene.remove(b.holder); impact(b); b.done(); bullets.splice(i, 1); continue; }
      }
      if (b.passed && b.dir * (b.holder.position.z - b.finalZ) >= 0) { scene.remove(b.holder); bullets.splice(i, 1); }
    }

    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) { scene.remove(p.sp); p.m.dispose(); parts.splice(i, 1); continue; }
      p.sp.position.addScaledVector(p.vel, dt);
      p.vel.y -= p.grav * dt;
      if (p.drag) p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.sp.scale.setScalar(p.s0 + (p.s1 - p.s0) * k);
      p.m.opacity = p.op * (1 - k) * (1 - k * 0.3);
    }
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i];
      d.v.y -= 12 * dt; d.m.position.addScaledVector(d.v, dt);
      d.m.rotation.x += d.spin.x * dt; d.m.rotation.y += d.spin.y * dt; d.m.rotation.z += d.spin.z * dt;
      if (d.m.position.y < -0.3) {
        spawn({ pos: V(d.m.position.x, 0.2, d.m.position.z), life: 0.5, s0: 0.3, s1: 1.1, add: true, color: 0xcfe8ff, op: 0.6 });
        scene.remove(d.m); d.m.geometry.dispose(); d.m.material.dispose(); debris.splice(i, 1);
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.age += dt;
      if (r.age < 0) continue;
      const k = r.age / r.life;
      if (k >= 1) { scene.remove(r.m); r.m.material.dispose(); ripples.splice(i, 1); continue; }
      r.m.scale.setScalar(0.4 + r.size * easeOut(k));
      r.m.material.opacity = 0.9 * (1 - k);
    }
    for (const l of flashLights) {
      if (l.intensity > 0) { l.userData.t += dt; l.intensity = Math.max(0, l.userData.i * (1 - l.userData.t / 0.45)); }
    }
    for (let i = tweens.length - 1; i >= 0; i--) {
      const t = tweens[i];
      t.age += dt * 1000;
      const k = Math.min(1, t.age / t.ms);
      t.fn(t.ease(k));
      if (k >= 1) { tweens.splice(i, 1); t.res(); }
    }

    if (shakeLeft > 0) {
      shakeLeft -= dt;
      const a = shakeAmp * Math.max(0, shakeLeft / shakeDur);
      camera.position.set(baseCam.x + rnd(-a, a), baseCam.y + rnd(-a, a), baseCam.z + rnd(-a, a));
    } else camera.position.copy(baseCam);
    camera.lookAt(0, 0, 0.3);
    camera.updateMatrixWorld();

    // El nombre va en el borde del barco más alejado del centro del mar
    for (const t of tracked) {
      const { x, y } = toScreen(t.p || (t.lx !== undefined ? V(ships[t.who].g.position.x + t.lx, t.y, t.z) : V(ships[t.who].g.position.x, 0.5, zOf(t.who) * (SHIP_Z + 1.6))));
      t.el.style.left = x + 'px'; t.el.style.top = y + 'px'; t.el.style.bottom = 'auto';
      t.el.style.transform = 'translate(-50%, -50%)';
    }
    renderer.render(scene, camera);
  }
  loop();

  // Bandera del país del jugador (SVG de /flags); 'un' es la bandera internacional
  function setFlag(who, code) {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      c.getContext('2d').drawImage(img, 0, 0, 320, 240);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      const m = ships[who].flag.material;
      m.map = tex; m.color.set(0xffffff); m.needsUpdate = true;
    };
    img.onerror = () => { if (code !== 'un') setFlag(who, 'un'); };
    img.src = `./flags/${code}.svg`;
  }

  // Números sobre las torretas: visibles al elegir, casi transparentes mientras se ejecuta la secuencia
  function setCannonLabels(visible) {
    const to = visible ? 1 : 0.1;
    for (const who of ['me', 'op']) {
      for (const tu of ships[who].turrets) {
        const m = tu.num.material, from = m.opacity;
        tween(400, (t) => { m.opacity = from + (to - from) * t; });
      }
    }
  }

  // Qué bandera de barco está cerca del puntero (para el texto con el nombre del país); admite dedos con margen
  function pickFlag(cx, cy) {
    const r = container.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    let best = null, bd = 44;
    for (const who of ['me', 'op']) {
      const p = toScreen(ships[who].flag.getWorldPosition(new THREE.Vector3()));
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < bd) { bd = d; best = who; }
    }
    return best;
  }

  Object.assign(api, { lightningStrike, setHealth, setCannons, setCannonLabels, setShipLevel, setLifebuoy, pickFlag, subMove, subLeave, iceShow, iceClear, octopusShow, octopusSpin, octopusLeave, medkitShow, medkitLeave, bucketShow, bucketLeave, gullFly, gullLeave, logShow, logLeave, squidShow, squidLeave, heliSupport, troopShip, swordfishAttack, setDragons, dragonAttack, warshipArrive, warshipLeave, warshipVolley, warshipLabel, islandShow, islandLeave, monkeyThrow, monkeyKill, monkeyLabel, setDome, domeBlock, feedShark, dud, labelCannon, moveFin, moveShip, fire, label, trackLabel, trackPoint, trackShip, setWeather, setFlag, setInsets, SHIP_Z });
  return api;
}
