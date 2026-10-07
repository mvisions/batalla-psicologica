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
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LOW ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = SHADOWS;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  container.prepend(canvas);

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
  const WAVE = `uniform float uStorm; uniform float uRough;
    float wave(vec2 p){ float a = 1. + uStorm*.9 + uRough*1.7;
      float swell = sin(p.x*.55+uTime*1.1)*.13 + sin(p.y*.8-uTime*1.4)*.1;
      float chop = sin((p.x+p.y)*1.2+uTime*1.9)*.05 + sin((p.x-p.y)*2.1-uTime*2.4)*.025;
      float ripples = sin(p.x*3.1+uTime*1.7)*sin(p.y*2.6-uTime*1.3)*.012;
      return a*(swell + chop + ripples); }`;
  const waterMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uStorm: { value: 0 }, uRough: { value: 0 }, uSun: { value: new THREE.Vector3(-0.5, 0.7, 0.4).normalize() } },
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

    // Franja roja de flotación, línea blanca y ojos de buey
    for (const s of [-1, 1]) {
      const strip = (mat, y, h) => { const m = new THREE.Mesh(new THREE.BoxGeometry(9.9, h, 0.03), mat); m.position.set(-1.6, y, s * 1.545); wrap.add(m); };
      strip(bootM, -0.2, 0.2); strip(whiteM, 0.52, 0.06);
    }
    const ports = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 10).rotateX(Math.PI / 2), glass, 32);
    const m4 = new THREE.Matrix4(); let pn = 0;
    for (const s of [-1, 1]) for (let i = 0; i < 16; i++) { m4.makeTranslation(-5.9 + i * 0.6, 0.22, s * 1.552); ports.setMatrixAt(pn++, m4); }
    wrap.add(ports);

    const ds = new THREE.Shape(); const L2 = 6.2, b2 = 1.2;
    ds.moveTo(-L2, -b2); ds.lineTo(L2 - 3.2, -b2); ds.quadraticCurveTo(L2 - 0.6, -b2, L2 + 0.6, 0);
    ds.quadraticCurveTo(L2 - 0.6, b2, L2 - 3.2, b2); ds.lineTo(-L2, b2); ds.lineTo(-L2, -b2);
    const deck = new THREE.Mesh(new THREE.ExtrudeGeometry(ds, { depth: 0.05, bevelEnabled: false, curveSegments: 24 }).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.85, metalness: 0.1 }));
    deck.position.y = 0.6; wrap.add(deck);
    const DY = 0.66;

    const box = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); wrap.add(m); return m; };
    const cyl = (r0, r1, h, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, 16), mat); m.position.set(x, y, z); wrap.add(m); return m; };

    // Barandillas
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.3, 0.03), steel, 40);
    let rn = 0;
    for (const s of [-1, 1]) {
      box(9.2, 0.025, 0.025, steel, -1.4, DY + 0.3, s * 1.13);
      for (let i = 0; i < 19; i++) { m4.makeTranslation(-5.9 + i * 0.5, DY + 0.15, s * 1.13); posts.setMatrixAt(rn++, m4); }
    }
    wrap.add(posts);

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
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.9, 8), dark); pole.position.set(6.2, DY + 0.95, 0); wrap.add(pole);
    const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: 0xdddddd, side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(6.2, DY + 1.5, 0);
    if (who === 'op') flag.rotation.y = Math.PI; // el barco rival está girado: así la bandera no se ve al revés
    wrap.add(flag);
    const flagBase = Float32Array.from(flagGeo.attributes.position.array);

    // Casetas con ametralladoras antiaéreas
    box(1.0, 0.45, 1.0, steel, -5.3, DY + 0.22, 0);
    box(0.8, 0.3, 0.8, steel, 5.0, DY + 0.15, 0);
    for (const [x, y] of [[-5.3, DY + 0.5], [5.0, DY + 0.32]]) {
      cyl(0.2, 0.24, 0.12, steel, x, y, 0);
      for (const bx of [-0.07, 0.07]) { const br = cyl(0.025, 0.025, 0.7, barrelMat, x + bx, y + 0.1, -0.4); br.rotation.x = Math.PI / 2; }
    }
    for (const x of [-3.2, 3.2]) for (const z of [-1.0, 1.0]) {
      const lb = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.75, 4, 10), dark);
      lb.rotation.z = Math.PI / 2; lb.position.set(x, DY + 0.18, z); wrap.add(lb);
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
    return { g, wrap, hullMat, steel, turrets, radar, flag, flagBase, base, red, ratio: 1, smokeAcc: 0, puffAcc: 0, phase: who === 'me' ? 0 : 2, hitT: 0, off: 0 };
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
      s.steel.color.set(0x8e99a1).lerp(s.red, (1 - s.ratio) * 0.45);
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
  function sharkLeave(who) {
    const s = sharks[who];
    if (s.dead || s.away) return;
    s.away = true;
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
      s.canopy.scale.set(1, 1, 1); s.umb.visible = true;
      s.swimming = true;
      await tween(2200, (t) => { s.root.position.x = x0 * (1 - t); }, easeOut);
      s.swimming = false;
      await tween(500, (t) => { s.canopy.scale.set(1 - 0.88 * t, 1 + 0.6 * t, 1 - 0.88 * t); }, easeIn);
      s.umb.visible = false;
      await tween(380, (t) => { s.head.position.y = 0.08 - 0.88 * t; }, easeIn);
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
  let stormOn = false, roughOn = false, whaleOn = false;
  function setWeather(round) {
    const st = round % 5 === 0, ro = round % 6 === 0, wh = round % 7 === 0;
    if (wh !== whaleOn) { whaleOn = wh; wh ? whaleArrive() : whaleLeave(); }
    if (st !== stormOn) {
      stormOn = st;
      const from = storm, to = st ? 1 : 0;
      tween(2200, (t) => { storm = from + (to - from) * t; }, easeInOut);
      for (const w of ['me', 'op']) st ? sharkLeave(w) : sharkReturn(w);
    }
    if (ro !== roughOn) {
      roughOn = ro;
      const from = rough, to = ro ? 1 : 0;
      tween(2200, (t) => { rough = from + (to - from) * t; }, easeInOut);
    }
  }

  // ---------- Efectos de impacto ----------
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
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

  // x en unidades de 1,5 (posición real del cañón); 'miss' = la bala se pierde fuera de la pantalla
  function fire({ from, x: xu, lane, target, owner, sub: fromSub = false, toward, ice }) {
    const dir = fromSub ? (toward === 'me' ? 1 : -1) : (from === 'me' ? -1 : 1);
    const x = xu !== undefined ? xu * UNIT : LANE_X[lane - 1], y = fromSub ? 0.9 : 1.3;
    const startZ = fromSub ? dir * 1.0 : -dir * MUZZLE_Z;
    const endZ = ['collision', 'whale', 'sub', 'ice'].includes(target) ? 0 : target === 'shark' ? zOf(owner) * FIN_Z : zOf(owner) * HIT_SHIP_Z;
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
    holder.position.set(x, y, startZ);
    holder.scale.setScalar(1.7);
    scene.add(holder);

    const mp = V(x, y, startZ);
    spawn({ pos: mp, life: 0.18, s0: 1.8, s1: 0.5, add: true, color: 0xffe3a0 });
    flashLight(mp, 14);
    for (let i = 0; i < 7; i++) {
      spawn({ pos: mp, tex: smokeTex, vel: V(rnd(-0.6, 0.6), rnd(0, 0.5), dir * rnd(1, 3)), drag: 1.5, life: 1.3, s0: 0.5, s1: 2, color: 0xb8b8b8, op: 0.6 });
    }
    if (!fromSub) {
      const br = ships[from].turrets[lane - 1].barrels;
      tween(300, (t) => { br.position.z = 0.38 * Math.sin(Math.PI * Math.pow(t, 0.5)) * (1 - t * 0.2); }, easeOut).then(() => { br.position.z = 0; });
    }

    let done;
    const promise = new Promise((r) => { done = r; });
    bullets.push({ holder, m, dir, endZ, finalZ, x, target, owner, ice, trail: 0, done, glow, passed: false });
    return { flight, done: promise };
  }

  function impact(b) {
    const p = V(b.x, b.target === 'ship' ? 1.1 : b.target === 'shark' ? 0.5 : 1.3, b.endZ);
    if (b.target === 'ship') { explodeShip(p); hitShip(b.owner); }
    else if (b.target === 'shark') { splash(V(b.x, 0.2, b.endZ)); hitShark(b.owner); }
    else if (b.target === 'sub') { clash(V(b.x, 0.9, 0)); sub.hitT = 0.5; }
    else if (b.target === 'ice') { clash(V(b.x, 0.9, 0)); iceBreak(b.ice); }
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
  const turretBase = new THREE.Color(0xa4afb6), turretBurnt = new THREE.Color(0x5a2a22);
  function setCannons(c) {
    for (const who of ['me', 'op']) {
      ships[who].turrets.forEach((tu, i) => {
        const hp = c[who][i];
        tu.tMat.color.copy(turretBase).lerp(turretBurnt, (1 - Math.max(0, hp / 25)) * 0.85);
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
  function fit() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.setViewOffset(w, h, 0, Math.round(h * 0.03), w, h); // sube un poco la escena: abajo hay más panel
    const el = (57 * Math.PI) / 180, dirv = V(0, Math.sin(el), Math.cos(el));
    const pts = [V(-7.8, 0, SHIP_Z + 1.7), V(7.8, 0, SHIP_Z + 1.7), V(-7.8, 0, -SHIP_Z - 1.7), V(7.8, 0, -SHIP_Z - 1.7), V(0, 3.4, -SHIP_Z - 0.5)];
    for (let d = 12; d < 120; d += 0.4) {
      camera.position.copy(dirv).multiplyScalar(d); camera.lookAt(0, 0, 0.3); camera.updateMatrixWorld();
      if (pts.every((q) => { const n = q.clone().project(camera); return Math.abs(n.x) < 0.97 && Math.abs(n.y) < 0.9; })) break;
    }
    baseCam.copy(camera.position);
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

    // Tiempo atmosférico
    lightning = Math.max(0, lightning - dt * 3.5);
    if (storm > 0.8) {
      nextBolt -= dt;
      if (nextBolt <= 0) { lightning = 1; nextBolt = rnd(5, 10); setTimeout(() => api.onThunder?.(), 450); }
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

    for (const who of ['me', 'op']) {
      const s = ships[who];
      const k = 1 + rough * 3;
      s.wrap.position.y = Math.sin(time * (1.2 + rough) + s.phase) * 0.07 * k;
      s.wrap.rotation.z = Math.sin(time * (0.9 + rough * 0.8) + s.phase) * 0.018 * (1 + rough * 5);
      s.wrap.rotation.x = Math.sin(time * (0.7 + rough * 0.6) + s.phase) * 0.01 * (1 + rough * 5);
      s.radar.rotation.y = time * 2;
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
      } else {
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
      b.glow.material.opacity = 0.75 + Math.random() * 0.25;
      b.trail += dt;
      while (b.trail > 0.035) {
        b.trail -= 0.035;
        const p = b.holder.position.clone();
        spawn({ pos: p, tex: smokeTex, life: 1.3, s0: 0.35, s1: 1.5, color: 0xcfcfcf, op: 0.5 });
        spawn({ pos: p.clone().setZ(p.z - b.dir * 0.25), life: 0.25, s0: 0.35, s1: 0.05, add: true, color: 0xffa040 });
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
    img.src = `/flags/${code}.svg`;
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

  Object.assign(api, { setHealth, setCannons, setCannonLabels, pickFlag, subMove, subLeave, iceShow, iceClear, dud, labelCannon, moveFin, moveShip, fire, label, trackLabel, trackPoint, trackShip, setWeather, setFlag, SHIP_Z });
  return api;
}
