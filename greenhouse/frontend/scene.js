import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.querySelector('#space');
const loading = document.querySelector('#scene-loading');
const fallback = document.querySelector('#scene-fallback');
const motionButton = document.querySelector('#motion-toggle');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
} catch {
  loading.hidden = true;
  fallback.hidden = false;
  document.querySelectorAll('.camera-controls button').forEach(button => { button.disabled = true; });
}

if (renderer) {
  const boot = () => setTimeout(initialize, 100);
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
}

function initialize() {
  const mobile = () => innerWidth < 701;
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : '';
  const software = /swiftshader|llvmpipe|software|softpipe/i.test(gpu);
  const pixelRatio = () => software ? .8 : Math.min(devicePixelRatio, mobile() ? 1.2 : 1.5);
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = !software;
  renderer.shadowMap.type = software ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(mobile() ? 50 : 39, innerWidth / innerHeight, .1, 350);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.maxTargetRadius = 4;
  controls.enableDamping = !reducedMotion.matches;
  controls.dampingFactor = .065;
  controls.minPolarAngle = .22;
  controls.maxPolarAngle = Math.PI * .61;
  controls.minDistance = 2.4;
  controls.maxDistance = 48;
  controls.rotateSpeed = .5;
  controls.zoomSpeed = .65;
  controls.target.set(0, .9, 0);
  let paused = reducedMotion.matches;
  let elapsed = 0;
  let previous = 0;
  let lastPaint = 0;
  let paintCount = 0;
  let gpuFence = null;
  const frameInterval = 1000 / (software ? 24 : 30);
  let frame = 0;
  let interacting = false;
  let hidden = document.hidden;
  let contextLost = false;
  const station = new THREE.Group(); scene.add(station);
  station.rotation.y = -.2;

  let seed = 212607;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  function material(color, metalness = .6, roughness = .4, emissive = 0, emissiveIntensity = 0) {
    return software ? new THREE.MeshPhongMaterial({ color, shininess: (1 - roughness) * 50, specular: 0x40505a, emissive, emissiveIntensity }) : new THREE.MeshStandardMaterial({ color, metalness, roughness, emissive, emissiveIntensity });
  }
  const titanium = material(0x799398, .8, .3);
  const darkMetal = material(0x162b36, .8, .38);
  const ceramic = material(0xa9bbb4, .5, .36);
  const gold = material(0xb49a64, .72, .36);
  const black = material(0x0a141c, .55, .52);
  const mint = material(0x82ffcf, .2, .25, 0x67ffc1, 3);
  const amber = material(0xffc473, .2, .3, 0xffa94f, 2.8);
  const blue = material(0x97d9ff, .2, .25, 0x54baff, 2);
  const mesh = (geo, mat, parent = station, position = [0, 0, 0]) => {
    const object = new THREE.Mesh(geo, mat); object.position.set(...position); parent.add(object);
    object.castShadow = true; object.receiveShadow = true; return object;
  };
  const box = (size, mat, parent, position) => mesh(new THREE.BoxGeometry(...size), mat, parent, position);
  const cylinder = (top, bottom, height, mat, parent, position, segments = 48) => mesh(new THREE.CylinderGeometry(top, bottom, height, segments), mat, parent, position);
  function torus(radius, tube, mat, parent = station, y = 0, arc = Math.PI * 2) {
    const object = mesh(new THREE.TorusGeometry(radius, tube, 6, 96, arc), mat, parent, [0, y, 0]); object.rotation.x = Math.PI / 2; return object;
  }
  function beam(start, end, thickness, mat, parent = station) {
    const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end), direction = b.clone().sub(a);
    const object = mesh(new THREE.CylinderGeometry(thickness, thickness, direction.length(), 6), mat, parent);
    object.position.copy(a.add(b).multiplyScalar(.5)); object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()); return object;
  }
  function glowTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d'), gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(.07, 'rgba(230,255,249,.85)'); gradient.addColorStop(.23, 'rgba(140,233,217,.22)'); gradient.addColorStop(1, 'rgba(90,170,190,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }
  const glowMap = glowTexture();
  function glow(parent, position, color, size, opacity = .7) {
    const object = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    object.position.set(...position); object.scale.setScalar(size); parent.add(object); return object;
  }

  scene.add(new THREE.HemisphereLight(0x94cfdf, 0x1e3335, 1.5));
  const sun = new THREE.DirectionalLight(0xffe3ad, 4.8); sun.position.set(-8, 13, 7); sun.castShadow = true;
  sun.shadow.mapSize.set(software || mobile() ? 512 : 1024, software || mobile() ? 512 : 1024); sun.shadow.camera.left = -10; sun.shadow.camera.right = 10; sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10; sun.shadow.camera.far = 55; sun.shadow.normalBias = .025; sun.shadow.bias = -.0002; scene.add(sun);
  const rim = new THREE.DirectionalLight(0x60c7fa, 3.5); rim.position.set(6, 4, -9); scene.add(rim);
  const underlight = new THREE.PointLight(0x31dfc6, 35, 18, 2); underlight.position.set(0, -3, 2); scene.add(underlight);

  const backgroundSeed = seed;

  const skyCanvas = document.createElement('canvas'); skyCanvas.width = 2048; skyCanvas.height = 1024;
  const skyContext = skyCanvas.getContext('2d'); skyContext.scale(2, 2); skyContext.fillStyle = '#030914'; skyContext.fillRect(0, 0, 1024, 512);
  for (let i = 0; i < 60; i++) {
    const x = random() * 1024, y = 180 + Math.sin(x * .007) * 90 + random() * 100, r = 50 + random() * 170;
    const gradient = skyContext.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, i % 3 ? 'rgba(20,66,70,.15)' : 'rgba(46,33,74,.12)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
    skyContext.fillStyle = gradient; skyContext.fillRect(x-r, y-r, r*2, r*2);
  }

  skyContext.setTransform(1, 0, 0, 1, 0, 0);
  for (let i = 0; i < 2800; i++) {
    const x = random() * 2048, y = (Math.asin(random()*2-1)/Math.PI+.5) * 1024;
    const radius = .45 + random()*.38, opacity = .25 + random()*.55;
    skyContext.fillStyle = `rgba(193,210,226,${opacity})`;
    skyContext.beginPath(); skyContext.arc(x,y,radius,0,Math.PI*2); skyContext.fill();
    if (i % 55 === 0) {
      const halo=skyContext.createRadialGradient(x,y,0,x,y,4.5);
      halo.addColorStop(0,'rgba(215,231,242,.72)'); halo.addColorStop(.22,'rgba(155,184,211,.17)'); halo.addColorStop(1,'rgba(130,160,190,0)');
      skyContext.fillStyle=halo;skyContext.fillRect(x-4.5,y-4.5,9,9);
    }
  }
  const skyTexture = new THREE.CanvasTexture(skyCanvas); skyTexture.colorSpace = THREE.SRGBColorSpace;
  skyTexture.magFilter = THREE.LinearFilter; skyTexture.minFilter = THREE.LinearMipmapLinearFilter; skyTexture.generateMipmaps = true;
  const skyMaterial = new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide, depthWrite: false, toneMapped: false });
  const sky = mesh(new THREE.SphereGeometry(140, 32, 20), skyMaterial, scene); sky.castShadow = false; sky.receiveShadow = false; sky.renderOrder = -10;

  const planetCanvas=document.createElement('canvas');planetCanvas.width=1024;planetCanvas.height=512;
  const pc=planetCanvas.getContext('2d');pc.fillStyle='#173a50';pc.fillRect(0,0,1024,512);
  const elevationCanvas=document.createElement('canvas');elevationCanvas.width=1024;elevationCanvas.height=512;
  const elevation=elevationCanvas.getContext('2d');elevation.fillStyle='#151515';elevation.fillRect(0,0,1024,512);
  for(let i=0;i<26;i++){
    const cx=random()*1024,cy=50+random()*412,rx=30+random()*95,ry=18+random()*52,phase=random()*6.28;
    const outline=new Path2D();
    for(let j=0;j<=54;j++){const a=j/54*Math.PI*2;const r=1+.2*Math.sin(a*3+phase)+.12*Math.cos(a*7-phase);const x=cx+Math.cos(a)*rx*r,y=cy+Math.sin(a)*ry*r;j?outline.lineTo(x,y):outline.moveTo(x,y);}outline.closePath();
    pc.strokeStyle='#355e64';pc.lineWidth=8;pc.stroke(outline);
    const land=pc.createLinearGradient(cx-rx,cy-ry,cx+rx,cy+ry);land.addColorStop(0,'#748273');land.addColorStop(.5,'#465f55');land.addColorStop(1,'#263f40');pc.fillStyle=land;pc.fill(outline);
    elevation.fillStyle='#929292';elevation.fill(outline);
    for(let j=0;j<6;j++){pc.save();pc.clip(outline);pc.beginPath();pc.moveTo(cx-rx,cy+j*4-14);pc.bezierCurveTo(cx-rx*.4,cy-ry*.5+j*4,cx+rx*.3,cy+ry*.4+j*2,cx+rx,cy+j*3);pc.strokeStyle='rgba(183,179,151,.15)';pc.lineWidth=1.5;pc.stroke();pc.restore();}
  }
  const polar=pc.createLinearGradient(0,0,0,512);polar.addColorStop(0,'rgba(173,196,194,.8)');polar.addColorStop(.1,'rgba(173,196,194,0)');polar.addColorStop(.9,'rgba(173,196,194,0)');polar.addColorStop(1,'rgba(173,196,194,.65)');pc.fillStyle=polar;pc.fillRect(0,0,1024,512);
  const planetTexture=new THREE.CanvasTexture(planetCanvas);planetTexture.colorSpace=THREE.SRGBColorSpace;
  const reliefTexture=new THREE.CanvasTexture(elevationCanvas);
  const planetMaterial=new THREE.MeshPhongMaterial({map:planetTexture,color:0xacc5ce,emissive:0x416071,emissiveMap:planetTexture,emissiveIntensity:.3,bumpMap:reliefTexture,bumpScale:.085,shininess:12,specular:0x294452});
  const planet=mesh(new THREE.SphereGeometry(17,48,32),planetMaterial,scene,[21,-15,-43]);planet.castShadow=false;planet.receiveShadow=false;
  const cloudCanvas=document.createElement('canvas');cloudCanvas.width=1024;cloudCanvas.height=512;
  const cc=cloudCanvas.getContext('2d');
  for(let i=0;i<230;i++){
    const x=random()*1024,y=random()*512,len=12+random()*100;
    cc.beginPath();cc.moveTo(x,y);cc.bezierCurveTo(x+len*.3,y-15,x+len*.65,y+19,x+len,y-3);
    cc.strokeStyle=`rgba(203,219,221,${.06+random()*.25})`;cc.lineWidth=1+random()*6;cc.lineCap='round';cc.stroke();
  }
  const cloudTexture=new THREE.CanvasTexture(cloudCanvas);cloudTexture.colorSpace=THREE.SRGBColorSpace;
  const clouds=mesh(new THREE.SphereGeometry(17.1,48,32),new THREE.MeshLambertMaterial({map:cloudTexture,transparent:true,opacity:.6,depthWrite:false}),scene,[21,-15,-43]);clouds.castShadow=false;clouds.receiveShadow=false;
  const atmosphereMaterial = new THREE.ShaderMaterial({ transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: `varying vec3 n;varying vec3 v;void main(){vec4 p=modelViewMatrix*vec4(position,1.);n=normalize(normalMatrix*normal);v=normalize(-p.xyz);gl_Position=projectionMatrix*p;}`,
    fragmentShader: `varying vec3 n;varying vec3 v;void main(){float rim=pow(1.-abs(dot(normalize(n),normalize(v))),4.);gl_FragColor=vec4(.08,.46,.62,rim*.52);}` });
  const atmosphere = mesh(new THREE.SphereGeometry(17.22, 48, 32), atmosphereMaterial, scene, [21, -15, -43]); atmosphere.castShadow = false;

  seed = backgroundSeed;
  for (let i=0;i<15688;i++) random();

  cylinder(4.55, 4.08, .55, darkMetal, station, [0, -.25, 0]);
  cylinder(4.58, 4.58, .14, ceramic, station, [0, .095, 0]);
  cylinder(4.05, 3.45, .42, titanium, station, [0, -.73, 0]);
  cylinder(2.75, 2.05, .55, darkMetal, station, [0, -1.15, 0]);
  torus(4.48, .045, mint, station, -.13); torus(4.13, .06, gold, station, -.61); torus(3.5, .035, blue, station, -.92);
  cylinder(4.33, 4.33, .08, black, station, [0, .23, 0]);
  const flooring = material(0x617973, .4, .65);
  cylinder(4.2, 4.2, .07, flooring, station, [0, .3, 0]);
  torus(4.24, .035, mint, station, .34);
  for (let i = 0; i < 64; i++) {
    const angle = i / 64 * Math.PI * 2;
    const rib = box([.12, .34, .17], i % 8 ? titanium : gold, station, [Math.cos(angle) * 4.35, -.37, Math.sin(angle) * 4.35]); rib.rotation.y = -angle;
    if (i % 4 === 0) { const light = box([.25, .09, .065], i % 8 ? amber : mint, station, [Math.cos(angle) * 4.53, -.23, Math.sin(angle) * 4.53]); light.rotation.y = -angle + Math.PI / 2; }
  }
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    beam([Math.cos(a) * .8, .36, Math.sin(a) * .8], [Math.cos(a) * 4.1, .36, Math.sin(a) * 4.1], .026, ceramic);
    const stripe = box([.045, .012, 3.1], mint, station, [Math.sin(a) * 2.5, .35, Math.cos(a) * 2.5]); stripe.rotation.y = a;
  }

  const fans = [];
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3 + .3, unit = new THREE.Group();
    unit.position.set(Math.cos(a) * 3.45, 1.3, Math.sin(a) * 3.45); unit.rotation.y = -a + Math.PI / 2; station.add(unit);
    box([.52, .55, .15], darkMetal, unit); const housing = torus(.205, .03, ceramic, unit); housing.rotation.x = 0; housing.position.z = .09;
    const rotor = new THREE.Group(); rotor.position.z = .105; unit.add(rotor);
    for (let blade = 0; blade < 4; blade++) { const fin = box([.07, .19, .016], titanium, rotor, [0, .09, 0]); fin.rotation.z = blade * Math.PI / 2; fin.position.set(Math.sin(blade * Math.PI / 2) * .085, Math.cos(blade * Math.PI / 2) * .085, 0); }
    fans.push(rotor);
    beam([-.24, -.72, 0], [-.24, -.25, 0], .025, titanium, unit); beam([.24, -.72, 0], [.24, -.25, 0], .025, titanium, unit);
  }
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + .12, pipe = new THREE.Group(); pipe.rotation.y = a; station.add(pipe);
    beam([1.4, .7, 0], [3.85, .7, 0], .025, darkMetal, pipe);
    for (let j = 0; j < 6; j++) { beam([1.55 + j * .39, .69, 0], [1.55 + j * .39, .66, -.15], .012, titanium, pipe); }
    beam([3.82, .37, 0], [3.82, 1.65, 0], .026, titanium, pipe);
    box([.72, .075, .2], darkMetal, pipe, [3.45, 1.65, 0]); box([.61, .012, .14], mint, pipe, [3.45, 1.603, 0]);
    for (let j = 0; j < 4; j++) box([.018, .6, .03], titanium, pipe, [2.05 + j * .25, .94, -.5]);
    beam([2.02, 1.2, -.5], [2.85, 1.2, -.5], .012, ceramic, pipe);
  }

  const bench = new THREE.Group(); bench.position.set(-1.05, 0, -.9); bench.rotation.y = -.35; station.add(bench);
  box([1.05, .065, .7], darkMetal, bench, [0, 1.30, 0]);
  for (const x of [-.45, .45]) for (const z of [-.28, .28]) box([.045, .94, .045], titanium, bench, [x, .81, z]);
  box([.22, .035, .14], gold, bench, [.23, 1.36, -.13]);
  box([.30, .02, .21], ceramic, bench, [-.21, 1.35, .07]);
  const packageGroup = new THREE.Group(); packageGroup.position.set(-1.1, .64, -.78); packageGroup.rotation.y = -.35; station.add(packageGroup);
  box([.68, .035, .52], ceramic, packageGroup, [0, -.02, 0]);
  const cardboard = material(0x9d764b, .02, .86);
  const labelCanvas = document.createElement('canvas'); labelCanvas.width = 512; labelCanvas.height = 256;
  const lc = labelCanvas.getContext('2d'); lc.fillStyle = '#b49160'; lc.fillRect(0, 0, 512, 256);
  lc.fillStyle = '#eadab5'; lc.fillRect(30, 35, 452, 178); lc.strokeStyle = '#705c42'; lc.lineWidth = 3; lc.strokeRect(30,35,452,178);
  lc.fillStyle = '#302c25'; lc.font = 'bold 54px sans-serif'; lc.textAlign = 'center'; lc.fillText('ЧАК ЧАК', 256, 139); lc.font = '22px sans-serif'; lc.fillText('к чаю',256,181);
  const labelTexture = new THREE.CanvasTexture(labelCanvas); labelTexture.colorSpace = THREE.SRGBColorSpace;
  const labelMaterial = new THREE.MeshLambertMaterial({ map: labelTexture });
  box([.56, .04, .42], cardboard, packageGroup, [0, .02, 0]);
  for (const x of [-.265, .265]) box([.03, .25, .42], cardboard, packageGroup, [x, .135, 0]);
  for (const z of [-.195, .195]) box([.53, .25, .03], cardboard, packageGroup, [0, .135, z]);
  mesh(new THREE.PlaneGeometry(.48, .18), labelMaterial, packageGroup, [0, .15, .212]);
  const lid = new THREE.Group(); lid.position.set(0, .27, -.21); packageGroup.add(lid);
  box([.58, .03, .44], cardboard, lid, [0, 0, .21]);
  const topLabel = mesh(new THREE.PlaneGeometry(.53, .36), labelMaterial, lid, [0, .016, .21]); topLabel.rotation.x = -Math.PI / 2;
  const bites = new THREE.InstancedMesh(new THREE.CylinderGeometry(.026,.024,.08,5),gold,18); const biteTransform = new THREE.Object3D();
  for(let i=0;i<18;i++){biteTransform.position.set((random()-.5)*.4,.095+random()*.07,(random()-.5)*.28);biteTransform.rotation.set(random()*Math.PI,random()*Math.PI,random()*Math.PI);biteTransform.updateMatrix();bites.setMatrixAt(i,biteTransform.matrix);}packageGroup.add(bites);
  let packageOpen = false;

  const soilCanvas = document.createElement('canvas'); soilCanvas.width = soilCanvas.height = 128; const soilContext = soilCanvas.getContext('2d');
  soilContext.fillStyle = '#31271b'; soilContext.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2000; i++) { const b = 25 + random() * 70; soilContext.fillStyle = `rgb(${b + 12},${b},${b * .65})`; soilContext.fillRect(random() * 128, random() * 128, 1 + random() * 2, 1 + random() * 2); }
  const soilTexture = new THREE.CanvasTexture(soilCanvas); soilTexture.wrapS = soilTexture.wrapT = THREE.RepeatWrapping; soilTexture.repeat.set(2, 2); soilTexture.colorSpace = THREE.SRGBColorSpace;
  const soil = (software ? new THREE.MeshLambertMaterial({ map: soilTexture }) : new THREE.MeshStandardMaterial({ map: soilTexture, roughness: 1 }));
  const leafGeometry = new THREE.BufferGeometry();
  const leafVertices = [], leafIndices = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8, width = Math.pow(Math.sin(t * Math.PI), .85) * .27; for (const side of [-1, 0, 1]) leafVertices.push(side * width, t * .9, Math.sin(t * Math.PI) * .19 - t * t * .18 + (side === 0 ? .055 : 0)); }
  for (let i = 0; i < 8; i++) for (let j = 0; j < 2; j++) { const a = i * 3 + j; leafIndices.push(a, a + 1, a + 3, a + 1, a + 4, a + 3); }
  leafGeometry.setAttribute('position', new THREE.Float32BufferAttribute(leafVertices, 3)); leafGeometry.setIndex(leafIndices); leafGeometry.computeVertexNormals();
  const leafMaterials = [0x70b940, 0xa2c866, 0x358251, 0x509847].map(color => software ? new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }) : new THREE.MeshStandardMaterial({ color, roughness: .52, metalness: .02, side: THREE.DoubleSide }));
  const stemMat = material(0x5e8641, .02, .9);
  const vegetation = [];
  const fruitMaterials = [material(0xaf482b, .05, .6), material(0xe8a846, .05, .6)];
  function plant(parent, x, z, size, species) {
    const plantGroup = new THREE.Group(); plantGroup.position.set(x, .62, z); plantGroup.scale.setScalar(size); parent.add(plantGroup);
    cylinder(.024, .037, .9, stemMat, plantGroup, [0, .43, 0], 5);
    for (let j = 0; j < 7; j++) {
      const leaf = mesh(leafGeometry, leafMaterials[(j + species) % 4], plantGroup, [0, .18 + j * .093, 0]);
      leaf.rotation.set(.55 + j * .08, j * 2.4 + species, -.25); leaf.scale.setScalar(1.05 - j * .055);
    }
    if (species % 3 === 0) for (let j = 0; j < 3; j++) { const a = j * 2.1; mesh(new THREE.SphereGeometry(.09, 8, 6), fruitMaterials[j % 2], plantGroup, [Math.cos(a) * .15, .62 + j * .07, Math.sin(a) * .15]); }
    vegetation.push({ group: plantGroup, phase: random() * Math.PI * 2 });
  }
  for (let bed = 0; bed < 6; bed++) {
    const angle = bed * Math.PI / 3 + .11;
    const bedGroup = new THREE.Group(); bedGroup.rotation.y = angle; station.add(bedGroup);
    const shape = new THREE.Shape(); const start = .08, end = Math.PI / 3 - .12;
    shape.absarc(0, 0, 3.77, start, end, false); shape.lineTo(Math.cos(end) * 1.35, Math.sin(end) * 1.35); shape.absarc(0, 0, 1.35, end, start, true); shape.closePath();
    const bedGeo = new THREE.ExtrudeGeometry(shape, { depth: .23, bevelEnabled: true, bevelSize: .035, bevelThickness: .025, bevelSegments: 1, steps: 1, curveSegments: 12 }); bedGeo.rotateX(-Math.PI / 2);
    mesh(bedGeo, ceramic, bedGroup, [0, .35, 0]);
    const soilGeo = new THREE.ShapeGeometry(shape, 12); soilGeo.rotateX(-Math.PI / 2); const ground = mesh(soilGeo, soil, bedGroup, [0, .618, 0]); ground.scale.set(.965, 1, .965);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3 + row; col++) {
      const a = start + .11 + col / (2 + row) * (end - start - .23), r = 1.8 + row * .75;
      plant(bedGroup, Math.cos(a) * r, -Math.sin(a) * r, .63 + random() * .6, bed);
    }
  }

  cylinder(.7, .85, .32, ceramic, station, [0, .47, 0], 32);
  cylinder(.31, .45, 1.55, darkMetal, station, [0, 1.38, 0], 16);
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; beam([Math.cos(a) * .33, .7, Math.sin(a) * .33], [Math.cos(a) * .27, 2.12, Math.sin(a) * .27], .027, mint); }
  torus(.36, .055, gold, station, 2.13);
  const crown = new THREE.Group(); crown.position.y = 1.5; station.add(crown);
  for (let i = 0; i < 12; i++) { const leaf = mesh(leafGeometry, leafMaterials[i % 4], crown, [0, .6 + (i % 3) * .18, 0]); leaf.rotation.set(.75 + (i % 4) * .2, i * 2.4, 0); leaf.scale.set(1.5, 1.65, 1.5); }

  const domeRadius = 4.22, domeY = .39;
  const ico = new THREE.IcosahedronGeometry(domeRadius, 2); const positions = ico.attributes.position;
  const triangles = [];
  for (let i = 0; i < positions.count; i += 3) {
    let polygon = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(positions, i + j));
    const clipped = [];
    for (let j = 0; j < polygon.length; j++) {
      const a = polygon[j], b = polygon[(j + 1) % polygon.length], insideA = a.y >= -.00001, insideB = b.y >= -.00001;
      if (insideA) clipped.push(a);
      if (insideA !== insideB) clipped.push(a.clone().lerp(b, -a.y / (b.y - a.y)));
    }
    for (let j = 1; j < clipped.length - 1; j++) for (const vertex of [clipped[0], clipped[j], clipped[j + 1]]) triangles.push(vertex.x, Math.max(0, vertex.y), vertex.z);
  }
  ico.dispose();
  const domeGeo = new THREE.BufferGeometry(); domeGeo.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3)); domeGeo.computeVertexNormals();
  const glassMat = software ? new THREE.MeshPhongMaterial({ color: 0x9dcfc6, transparent: true, opacity: .1, shininess: 90, side: THREE.DoubleSide, depthWrite: false }) : new THREE.MeshPhysicalMaterial({ color: 0xa8d9d1, transparent: true, opacity: .095, roughness: .13, metalness: .42, clearcoat: 1, clearcoatRoughness: .15, side: THREE.DoubleSide, depthWrite: false });
  const glass = mesh(domeGeo, glassMat, station, [0, domeY, 0]); glass.castShadow = false; glass.receiveShadow = false; glass.renderOrder = 3;
  const edges = new THREE.EdgesGeometry(domeGeo, 1); const edgePos = edges.attributes.position;
  const struts = new THREE.InstancedMesh(new THREE.CylinderGeometry(.018, .018, 1, 5), titanium, edgePos.count / 2);
  const dummy = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0), joints = new Map();
  for (let i = 0; i < edgePos.count; i += 2) {
    const a = new THREE.Vector3().fromBufferAttribute(edgePos, i), b = new THREE.Vector3().fromBufferAttribute(edgePos, i + 1);
    const direction = b.clone().sub(a); dummy.position.copy(a).add(b).multiplyScalar(.5); dummy.position.y += domeY; dummy.quaternion.setFromUnitVectors(up, direction.clone().normalize()); dummy.scale.set(1, direction.length(), 1); dummy.updateMatrix(); struts.setMatrixAt(i / 2, dummy.matrix);
    for (const vertex of [a, b]) joints.set(vertex.toArray().map(n => n.toFixed(3)).join(','), vertex);
  }
  struts.castShadow = true; station.add(struts);
  const nodes = new THREE.InstancedMesh(new THREE.SphereGeometry(.043, 6, 5), gold, joints.size); let jointIndex = 0;
  for (const vertex of joints.values()) { dummy.position.copy(vertex); dummy.position.y += domeY; dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); nodes.setMatrixAt(jointIndex++, dummy.matrix); } station.add(nodes);
  edges.dispose();
  torus(4.22, .073, ceramic, station, domeY);
  torus(4.28, .025, amber, station, domeY + .02);
  cylinder(.19, .25, .2, gold, station, [0, 4.65, 0], 16); beam([0, 4.7, 0], [0, 5.38, 0], .024, titanium);
  const beacon = mesh(new THREE.SphereGeometry(.07, 12, 8), amber, station, [0, 5.38, 0]);
  const beaconGlow = glow(station, [0, 5.38, 0], 0xffc989, 1.1, .9);
  const beaconLight = new THREE.PointLight(0xffc175, 5, 5); beaconLight.position.copy(beacon.position); station.add(beaconLight);

  const ring = new THREE.Group(); ring.position.y = -.42; station.add(ring);
  torus(6.03, .095, titanium, ring); torus(6.53, .065, gold, ring); torus(6.5, .022, amber, ring, .1); torus(6.03, .018, mint, ring, -.15);
  const ringDeck = mesh(new THREE.RingGeometry(6.07, 6.47, 128), (software ? new THREE.MeshPhongMaterial({ color: 0x43575b, shininess: 30, side: THREE.DoubleSide }) : new THREE.MeshStandardMaterial({ color: 0x43575b, metalness: .8, roughness: .4, side: THREE.DoubleSide })), ring); ringDeck.rotation.x = -Math.PI / 2;
  for (let i = 0; i < 48; i++) {
    const a = i * Math.PI / 24, b = a + Math.PI / 24;
    beam([Math.cos(a) * 6.05, 0, Math.sin(a) * 6.05], [Math.cos(b) * 6.5, 0, Math.sin(b) * 6.5], .026, ceramic, ring);
    if (i % 4 === 0) { const lamp = box([.12, .04, .35], i % 8 ? mint : amber, ring, [Math.cos(a) * 6.29, .055, Math.sin(a) * 6.29]); lamp.rotation.y = -a; }
  }
  const pods = new THREE.Group(); station.add(pods);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4, pod = new THREE.Group(); pod.rotation.y = a; pods.add(pod);
    box([.6, .24, 2.25], titanium, pod, [0, -.5, 5.35]); box([.3, .05, 2.0], black, pod, [0, -.355, 5.4]);
    for (const side of [-1, 1]) beam([side * .2, -.8, 4], [side * .32, -.5, 6.2], .045, gold, pod);
    const tube = cylinder(.42, .42, 1.55, ceramic, pod, [0, -.35, 6.24], 20); tube.rotation.x = Math.PI / 2;
    for (const z of [5.6, 6.0, 6.6, 6.9]) { const collar = torus(.43, .035, titanium, pod); collar.position.set(0, -.35, z); collar.rotation.x = 0; }
    const hatch = cylinder(.3, .3, .1, darkMetal, pod, [0, -.35, 7.05], 16); hatch.rotation.x = Math.PI / 2;
    glow(pod, [0, -.35, 7.13], 0x72f6d0, .5, .6);
  }

  const solarMat = material(0x173c59, .72, .26);
  const solarLines = material(0x53838c, .55, .45);
  for (const sign of [-1, 1]) {
    const wing = new THREE.Group(); wing.position.set(sign * 6.7, -.65, -.65); wing.rotation.z = sign * .1; station.add(wing);
    box([3.9, .14, .22], gold, wing, [sign * .35, 0, 0]);
    for (const z of [-1.05, 1.05]) {
      box([3.0, .09, 1.72], titanium, wing, [sign * .55, 0, z]); box([2.9, .02, 1.62], solarMat, wing, [sign * .55, .058, z]);
      for (let i = 0; i < 10; i++) box([.012, .015, 1.6], solarLines, wing, [sign * .55 - 1.4 + i * .31, .074, z]);
      for (let j = 0; j < 5; j++) box([2.9, .015, .009], solarLines, wing, [sign * .55, .075, z - .8 + j * .4]);
    }
  }

  const orbit = new THREE.Group(); orbit.rotation.z = .16; station.add(orbit);
  const orbitRail = torus(7.32, .012, material(0x3d6e73, .4, .6), orbit, .15);
  const dronePivot = new THREE.Group(); orbit.add(dronePivot);
  const drone = new THREE.Group(); drone.position.set(7.32, .15, 0); dronePivot.add(drone);
  mesh(new THREE.OctahedronGeometry(.21), ceramic, drone); box([.95, .04, .25], solarMat, drone); glow(drone, [0, 0, .22], 0x8fdfff, 1, .8);
  const dish = mesh(new THREE.SphereGeometry(.43, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), ceramic, station, [-3.5, -.6, 4.5]); dish.rotation.z = -.6; dish.rotation.x = .8;

  const windTime = { value: 0 };
  for (const leafMaterial of leafMaterials) {
    leafMaterial.onBeforeCompile = shader => {
      shader.uniforms.windTime = windTime;
      shader.vertexShader = 'uniform float windTime;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.x += sin(windTime*.9+position.x*1.7+position.z)*.035*max(0.,position.y-.65);');
    };
    leafMaterial.customProgramCacheKey = () => 'greenhouse-wind-v1';
  }
  function batch(root, excluded = new Set()) {
    scene.updateMatrixWorld(true);
    const inverse = root.matrixWorld.clone().invert(), groups = new Map(), sources = [];
    function visit(object) {
      if (excluded.has(object)) return;
      if (object.isMesh && !object.isInstancedMesh && !Array.isArray(object.material)) {
        const key = object.material.uuid;
        if (!groups.has(key)) groups.set(key, { material: object.material, position: [], normal: [], uv: [], cast: false, receive: false });
        const group = groups.get(key), geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
        geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld));
        const attributes = geometry.attributes;
        for (let i = 0; i < attributes.position.array.length; i++) group.position.push(attributes.position.array[i]);
        for (let i = 0; i < attributes.normal.array.length; i++) group.normal.push(attributes.normal.array[i]);
        if (attributes.uv) for (let i = 0; i < attributes.uv.array.length; i++) group.uv.push(attributes.uv.array[i]);
        else for (let i = 0; i < attributes.position.count * 2; i++) group.uv.push(0);
        group.cast ||= object.castShadow; group.receive ||= object.receiveShadow;
        sources.push(object); geometry.dispose();
      }
      for (const child of object.children) visit(child);
    }
    for (const child of root.children) visit(child);
    for (const source of sources) source.removeFromParent();
    for (const group of groups.values()) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.position, 3)); geometry.setAttribute('normal', new THREE.Float32BufferAttribute(group.normal, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(group.uv, 2));
      const merged = new THREE.Mesh(geometry, group.material); merged.castShadow = group.cast; merged.receiveShadow = group.receive; root.add(merged);
    }
  }
  batch(station, new Set([glass, ring, orbit, crown, packageGroup, ...fans])); batch(ring); batch(crown); batch(drone); fans.forEach(fan => batch(fan));

  let interior = false;
  let inspectingPackage = false;
  let inspectionTween = null;
  const normalMinDistance = 2.4;
  const lidOpenAngle = -.65;
  function endInspection() {
    inspectingPackage = false; inspectionTween = null;
    controls.enabled = true; controls.enableDamping = !paused;
    controls.minDistance = normalMinDistance;
    camera.fov = mobile() ? 50 : 39; camera.updateProjectionMatrix();
  }
  function focusPackage() {
    interior = true; inspectingPackage = true;
    controls.minDistance = .7;
    camera.fov = 65; camera.updateProjectionMatrix();
    controls.enableDamping = false;
    scene.updateMatrixWorld(true);
    const destination = packageGroup.localToWorld(new THREE.Vector3(0, .45, .9));
    const target = packageGroup.localToWorld(new THREE.Vector3(0, .2, 0));
    if (paused || reducedMotion.matches) {
      inspectionTween = null; camera.position.copy(destination); controls.target.copy(target);
      controls.enabled = true; controls.update();
    } else {
      inspectionTween = { from: camera.position.clone(), fromTarget: controls.target.clone(), to: destination, target, start: performance.now() };
      controls.enabled = false;
    }
    requestRender();
  }
  function updateInspection(now) {
    if (!inspectionTween) return;
    const t = paused || reducedMotion.matches ? 1 : Math.min(1, (now - inspectionTween.start) / 650);
    const eased = t*t*(3-2*t);
    camera.position.lerpVectors(inspectionTween.from, inspectionTween.to, eased);
    controls.target.lerpVectors(inspectionTween.fromTarget, inspectionTween.target, eased);
    if(t === 1) { inspectionTween = null; controls.enabled = true; controls.enableDamping = !paused; }
  }
  function interiorCamera() {
    endInspection();
    interior = true;
    scene.updateMatrixWorld(true);
    controls.target.copy(station.localToWorld(new THREE.Vector3(0, .95, -.15)));
    camera.position.copy(station.localToWorld(new THREE.Vector3(2.6, 2.25, 3.2)));
    controls.update(); requestRender();
  }
  canvas.addEventListener('dblclick', event => { event.preventDefault(); if (!packageHit(pointAt(event))) interiorCamera(); });
  const hint = document.querySelector('#object-hint'), raycaster = new THREE.Raycaster();
  const opaque = [];
  station.traverse(object => { if (object.isMesh && object !== glass && !object.material?.transparent) opaque.push(object); });
  function packageHit(point) {
    if (camera.position.distanceTo(controls.target) > 16) return false;
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(); raycaster.setFromCamera(point, camera);
    const candidate = raycaster.intersectObject(packageGroup, true)[0];
    if (!candidate) return false;
    raycaster.far = candidate.distance + .02;
    const first = raycaster.intersectObjects(opaque, false)[0]; raycaster.far = Infinity;
    return !first || first.distance >= candidate.distance - .025;
  }
  function pointAt(event) { const b=canvas.getBoundingClientRect();return new THREE.Vector2((event.clientX-b.left)/b.width*2-1,-(event.clientY-b.top)/b.height*2+1); }
  function inspectPackage() {
    packageOpen = !packageOpen; canvas.dataset.discovered = 'true';
    if (paused || reducedMotion.matches) lid.rotation.x = packageOpen ? lidOpenAngle : 0;
    if (packageOpen) focusPackage();
    hint.textContent = packageOpen ? 'ЧАК ЧАК. Коробка открыта. К чаю.' : 'ЧАК ЧАК. Коробка закрыта.'; hint.hidden=false; requestRender();
  }
  let down = null, hoverTime = 0;
  canvas.addEventListener('pointerdown', event => { down={x:event.clientX,y:event.clientY}; });
  canvas.addEventListener('pointerup', event => { if(down && Math.hypot(event.clientX-down.x,event.clientY-down.y)<5 && packageHit(pointAt(event))) inspectPackage(); down=null; });
  canvas.addEventListener('pointercancel',()=>{down=null;});
  canvas.addEventListener('pointermove',event=>{
    if(down || performance.now()-hoverTime<150)return;hoverTime=performance.now();
    const hit=packageHit(pointAt(event)); canvas.style.cursor=hit?'pointer':'';
    if(hit){hint.textContent='Коробка под столом · нажмите, чтобы осмотреть';hint.hidden=false;}
    else if(!packageOpen)hint.hidden=true;
  },{passive:true});
  canvas.addEventListener('pointerleave',()=>{canvas.style.cursor='';if(!packageOpen)hint.hidden=true;});
  canvas.addEventListener('keydown',event=>{if(event.key==='Enter'&&packageHit(new THREE.Vector2(0,0))){event.preventDefault();inspectPackage();}});
  function resetCamera() {
    endInspection();
    interior = false;
    controls.target.set(0, mobile() ? .2 : .9, 0);
    const distance = mobile() ? 42 : (innerWidth / innerHeight < 1.35 ? 26 : 23);
    const vector = new THREE.Vector3(10.5, 9, 15.5).normalize().multiplyScalar(distance);
    camera.position.copy(controls.target).add(vector); controls.update(); requestRender();
  }
  function zoom(factor) { const offset = camera.position.clone().sub(controls.target); offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance)); camera.position.copy(controls.target).add(offset); controls.update(); requestRender(); }
  function rotateCamera(horizontal, vertical) { const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target)); spherical.theta += horizontal; spherical.phi = THREE.MathUtils.clamp(spherical.phi + vertical, controls.minPolarAngle, controls.maxPolarAngle); camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); controls.update(); requestRender(); }
  function syncMotion() {
    motionButton.setAttribute('aria-pressed', String(paused)); motionButton.textContent = paused ? 'Анимация' : 'Пауза';
    motionButton.setAttribute('aria-label', paused ? 'Включить анимацию' : 'Остановить анимацию'); motionButton.title = paused ? 'Включить анимацию' : 'Остановить анимацию';
    controls.enableDamping = !paused; previous = 0; requestRender();
  }
  document.querySelector('#camera-zoom-in').addEventListener('click', () => zoom(.86));
  document.querySelector('#camera-zoom-out').addEventListener('click', () => zoom(1.16));
  motionButton.addEventListener('click', () => { paused = !paused; syncMotion(); });
  reducedMotion.addEventListener('change', () => { paused = reducedMotion.matches; syncMotion(); });
  canvas.addEventListener('keydown', event => {
    const orbitStep = event.shiftKey ? .002 : .1;
    const actions = { i: interiorCamera, I: interiorCamera, ArrowLeft: () => rotateCamera(-orbitStep, 0), ArrowRight: () => rotateCamera(orbitStep, 0), ArrowUp: () => rotateCamera(0, -.08), ArrowDown: () => rotateCamera(0, .08), '+': () => zoom(.9), '=': () => zoom(.9), '-': () => zoom(1.1), Home: resetCamera, ' ': () => { paused = !paused; syncMotion(); } };
    if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
  });
  controls.addEventListener('start', () => { interacting = true; });
  controls.addEventListener('end', () => { interacting = false; });
  controls.addEventListener('change', requestRender);
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); contextLost = true; gpuFence = null; cancelAnimationFrame(frame); frame = 0; fallback.hidden = false; fallback.querySelector('strong').textContent = 'Визуальный канал приостановлен'; fallback.querySelector('p').textContent = 'Графический контекст потерян. Перезагрузите страницу, чтобы восстановить сцену. Терминал доступен.'; });
  canvas.addEventListener('webglcontextrestored', () => { contextLost = false; fallback.hidden = true; requestRender(); });
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; if (hidden) { cancelAnimationFrame(frame); frame = 0; } else { previous = 0; requestRender(); } });
  let wasMobile = mobile();
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.fov = inspectingPackage ? 65 : (mobile() ? 50 : 39); camera.updateProjectionMatrix(); renderer.setPixelRatio(pixelRatio()); renderer.setSize(innerWidth, innerHeight, false); if (wasMobile !== mobile()) { wasMobile = mobile(); resetCamera(); } requestRender(); });
  function requestRender() { if (!frame && !hidden && !contextLost) frame = requestAnimationFrame(render); }
  function render(now) {
    frame = 0;

    if (gpuFence) {
      const ready = gl.clientWaitSync(gpuFence, 0, 0);
      if (ready === gl.TIMEOUT_EXPIRED) { requestRender(); return; }
      gl.deleteSync(gpuFence); gpuFence = null;
    }
    if (!paused && now - lastPaint < frameInterval) { requestRender(); return; }
    lastPaint = now;
    const delta = previous ? Math.min((now - previous) / 1000, .05) : 0; previous = now;
    if (!paused) {
      elapsed += delta;
      if (!interacting && !interior) station.rotation.y += delta * .019;
      if (!inspectingPackage) station.position.y = Math.sin(elapsed * .36) * .06;
      dronePivot.rotation.y = elapsed * .13;
      ring.rotation.y = -elapsed * .013;
      beaconGlow.material.opacity = .42 + (Math.sin(elapsed * 2.2) + 1) * .26;
      beaconLight.intensity = 3 + (Math.sin(elapsed * 2.2) + 1) * 2;
      windTime.value = elapsed;
      fans.forEach((fan, i) => { fan.rotation.z = elapsed * (2.3 + i*.3); });
      lid.rotation.x += ((packageOpen ? lidOpenAngle : 0) - lid.rotation.x) * Math.min(1, delta * 8);
      drone.rotation.y = Math.sin(elapsed*.4)*.2;
      crown.rotation.y = Math.sin(elapsed * .35) * .06;
      planet.rotation.y = elapsed * .003;
      clouds.rotation.y = elapsed * .0038;
      underlight.intensity = 32 + Math.sin(elapsed * .5) * 4;
    }
    updateInspection(now);
    controls.update();
    if (paintCount++ % 6 === 0 || paused) renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    if (software) { gpuFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); }
    canvas.dataset.ready = 'true'; loading.hidden = true; fallback.hidden = true;
    if (!paused) requestRender();
  }
  function inspectionView() {
    const samples = [[0,.15,.214],[-.19,.09,.214],[.19,.09,.214],[-.19,.21,.214],[.19,.21,.214]];
    const projected = samples.map(point => packageGroup.localToWorld(new THREE.Vector3(...point)).project(camera));
    const corners = projected.slice(1).map(p=>({x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2}));
    return { focused: inspectingPackage, open: packageOpen, labelCenterVisible: packageHit(new THREE.Vector2(projected[0].x, projected[0].y)), tweening: Boolean(inspectionTween), visibleSamples: projected.filter(p=>Math.abs(p.x)<1 && Math.abs(p.y)<1 && p.z<1 && packageHit(new THREE.Vector2(p.x,p.y))).length, labelWidth: Math.max(...corners.map(p=>p.x))-Math.min(...corners.map(p=>p.x)), labelHeight: Math.max(...corners.map(p=>p.y))-Math.min(...corners.map(p=>p.y)), corners };
  }

  window.greenhouseScene = { getInspectionView: inspectionView, getInspectionPoint: () => { const v=packageGroup.localToWorld(new THREE.Vector3(0,.15,.23)).project(camera);return {x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2,visible:packageHit(new THREE.Vector2(v.x,v.y))}; }, getStats: () => ({ revision: THREE.REVISION, starfield: { mode: 'baked-texture', width: skyCanvas.width, height: skyCanvas.height, version: skyTexture.version }, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, paused, software, orbitMinDistance: controls.minDistance, fov: camera.fov, inspectingPackage, pixelRatio: renderer.getPixelRatio(), shadows: renderer.shadowMap.enabled, frameLimit: software ? 24 : 30, frames: paintCount, camera: camera.position.toArray(), rotation: station.rotation.y, contextLost }) };
  resetCamera(); syncMotion(); requestRender();
}
