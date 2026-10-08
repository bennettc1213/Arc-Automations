import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STATIONS, STATION_BY_ID } from './model';

const colors = { ok: '#88d9b0', error: '#ff657b', warn: '#f7b65f', muted: '#718294' };

export default function MissionScene({
  mode,
  activeStation,
  selected,
  onSelect,
  reduced,
  statuses,
  zoom,
  reset,
  onFailure,
}) {
  const host = useRef(null);
  const labels = useRef({});
  const agentLabel = useRef(null);
  const state = useRef({});
  state.current = { activeStation, selected, reduced, statuses, zoom, onSelect };
  useEffect(() => {
    if (mode === 'map') return;
    const element = host.current;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' });
    } catch {
      onFailure();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x080e19, 0);
    element.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-28, 28, 22, -22, 0.1, 180);
    camera.position.set(32, 37, 42);
    camera.lookAt(0, 0, 1);
    scene.add(new THREE.AmbientLight(0xc2d5fa, 2.2));
    const sun = new THREE.DirectionalLight(0xffcf99, 3);
    sun.position.set(-15, 35, 15);
    scene.add(sun);
    const blue = new THREE.DirectionalLight(0x678dff, 1.6);
    blue.position.set(20, 10, -20);
    scene.add(blue);
    const geometries = new Set(),
      materials = new Set();
    const materialCache = new Map();
    function material(color, glow = false) {
      const key = `${color}-${glow}`;
      if (!materialCache.has(key)) {
        const m = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.82,
          metalness: 0.22,
          ...(glow ? { emissive: color, emissiveIntensity: 1.3 } : {}),
        });
        materials.add(m);
        materialCache.set(key, m);
      }
      return materialCache.get(key);
    }
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    geometries.add(boxGeo);
    function box(parent, x, y, z, w, h, d, color, glow = false) {
      const m = new THREE.Mesh(boxGeo, material(color, glow));
      m.position.set(x, y, z);
      m.scale.set(w, h, d);
      parent.add(m);
      return m;
    }
    function cylinder(parent, x, y, z, r, h, color, sides = 8) {
      const g = new THREE.CylinderGeometry(r, r, h, sides);
      geometries.add(g);
      const m = new THREE.Mesh(g, material(color));
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    }
    // A stepped orbital deck with exposed ribs and luminous corridor inlays.
    cylinder(scene, 0, -1.2, 1, 17.9, 0.8, 0x111b2a, 8);
    cylinder(scene, 0, -0.7, 1, 17.6, 0.35, 0x344153, 8);
    cylinder(scene, 0, -0.42, 1, 17.4, 0.3, 0x1d2939, 8);
    for (let i = -14; i <= 14; i += 2) {
      const span = Math.sqrt(16 * 16 - i * i) * 2;
      box(scene, i, -0.22, 1, 0.035, 0.02, span, 0x39475a);
      box(scene, 0, -0.22, i + 1, span, 0.02, 0.035, 0x39475a);
    }
    for (let a = 0; a < 8; a++) {
      const angle = (a * Math.PI) / 4;
      const rib = box(
        scene,
        Math.cos(angle) * 17.3,
        -0.65,
        1 + Math.sin(angle) * 17.3,
        4,
        0.16,
        0.18,
        0x7191a5,
      );
      rib.rotation.y = -angle + Math.PI / 2;
      const light = box(
        scene,
        Math.cos(angle) * 16.8,
        -0.16,
        1 + Math.sin(angle) * 16.8,
        2.1,
        0.07,
        0.12,
        0xffa566,
        true,
      );
      light.rotation.y = -angle + Math.PI / 2;
    }
    // Solar arrays, air ducts and docking outriggers give the station a physical silhouette.
    for (const side of [-1, 1]) {
      box(scene, side * 19, -1.1, 1, 5, 0.25, 1, 0x667389);
      for (const z of [-5, 0, 5]) {
        box(scene, side * 21, -0.7, z + 1, 4, 0.2, 4.5, 0x243d60);
        for (let i = 0; i < 5; i++) box(scene, side * 21, -0.58, z - 1 + i, 3.8, 0.02, 0.04, 0x5b80a0);
        box(scene, side * 21, -0.5, z + 1, 0.06, 0.03, 4.5, 0x698aa4);
      }
    }
    const nodes = [],
      hits = [];
    for (const station of STATIONS) {
      const g = new THREE.Group();
      g.position.set(station.x, 0, station.z);
      scene.add(g);
      const base = box(g, 0, 0.12, 0, 4.4, 0.35, 3.6, 0x435065);
      base.userData.station = station.id;
      hits.push(base);
      box(g, 0, 0.36, 0, 4.15, 0.17, 3.35, 0x202d40);
      box(g, 0, 0.46, 1.6, 3.9, 0.09, 0.1, station.color, true);
      box(g, -1.96, 0.46, 0, 0.08, 0.07, 3.1, station.color, true);
      // Different machinery per station, built out of crisp voxel geometry.
      if (['signal', 'n8n'].includes(station.id)) {
        cylinder(g, -0.6, 0.85, 0, 0.7, 0.7, 0x53627a);
        box(g, -0.6, 1.9, 0, 0.12, 1.7, 0.12, 0xc6d3da);
        const dish = cylinder(g, -0.6, 2.7, 0, 1.2, 0.18, station.color, 8);
        dish.rotation.z = 0.4;
        box(g, 1, 1.2, -0.6, 0.85, 1.5, 0.7, 0x485369);
        for (let j = 0; j < 4; j++) box(g, 1, 0.7 + j * 0.3, -0.23, 0.6, 0.09, 0.04, station.color, true);
      } else if (['memory', 'proof'].includes(station.id)) {
        for (let i = -1; i <= 1; i++) {
          box(g, i, 1.4, -0.6, 0.74, 1.9, 0.85, 0x536079);
          for (let j = 0; j < 5; j++) box(g, i, 0.7 + j * 0.31, -0.16, 0.52, 0.08, 0.03, station.color, true);
        }
      } else if (station.id === 'command') {
        cylinder(g, 0, 0.65, 0, 1.2, 0.45, 0x66758c);
        cylinder(g, 0, 0.95, 0, 1, 0.1, station.color);
        box(g, 0, 1.25, 0, 0.55, 0.5, 0.55, station.color, true).rotation.y = 0.65;
      } else if (station.id === 'voice') {
        box(g, 0, 1.35, -0.3, 1.4, 1.9, 1.4, 0x384158);
        box(g, 0, 1.45, 0.42, 1, 1.2, 0.05, 0x647389);
        box(g, 0, 2.45, -0.3, 1.8, 0.25, 1.8, 0x738093);
      } else {
        box(g, 0, 0.8, -0.6, 2.9, 0.7, 1.2, 0x53617a);
        for (const x of [-0.75, 0.75]) {
          box(g, x, 1.65, -0.85, 1.2, 1, 0.15, 0x8397aa);
          box(g, x, 1.66, -0.75, 1.05, 0.78, 0.06, 0x172939);
          for (let j = 0; j < 3; j++)
            box(g, x, 1.43 + j * 0.19, -0.7, 0.65 - (j % 2) * 0.25, 0.045, 0.03, station.color, true);
        }
        box(g, 0, 1.19, -0.1, 2.5, 0.06, 0.35, 0x899bad);
      }
      const beacon = box(g, 1.8, 0.85, 1.28, 0.18, 0.7, 0.18, station.color, true);
      // Wall ribs and console stools; the front stays open for Damon's approach.
      for (const x of [-2, 2]) {
        box(g, x, 1.1, -1.5, 0.18, 1.5, 0.18, 0x68778b);
        box(g, x, 1.9, -1.5, 0.25, 0.12, 0.3, station.color, true);
      }
      box(g, 0, 1.7, -1.6, 3.9, 0.18, 0.15, 0x586579);
      if (!['command', 'voice', 'signal', 'n8n'].includes(station.id)) {
        cylinder(g, 0.5, 0.65, 0.9, 0.3, 0.4, 0x54647b, 4);
        box(g, 0.5, 0.92, 1.03, 0.55, 0.35, 0.12, 0x84939e);
      }
      nodes.push({ station, beacon });
      // Corridor stripes stop short of each workbench.
      const length = Math.hypot(station.x, station.z - 4);
      if (length > 3) {
        const lane = box(scene, station.x / 2, -0.15, (station.z + 4) / 2, 0.16, 0.025, length - 3, 0x655443);
        lane.rotation.y = Math.atan2(station.x, station.z - 4);
      }
    }
    // Damon: a pixel astronaut with an orange suit, visor, backpack and jointed legs.
    const agent = new THREE.Group();
    scene.add(agent);
    agent.position.set(0, 0.1, 6.8);
    agent.scale.setScalar(1.3);
    box(agent, 0, 1, 0, 0.72, 0.8, 0.44, 0xf79449);
    box(agent, 0, 1.65, 0, 0.72, 0.6, 0.6, 0xe0e5dc);
    box(agent, 0, 1.68, 0.32, 0.58, 0.28, 0.05, 0x1b3549);
    box(agent, -0.12, 1.75, 0.36, 0.21, 0.06, 0.02, 0x8fe5ed, true);
    box(agent, 0, 1, -0.32, 0.58, 0.66, 0.27, 0x657185);
    box(agent, -0.49, 0.94, 0, 0.2, 0.65, 0.28, 0xf7af60);
    box(agent, 0.49, 0.94, 0, 0.2, 0.65, 0.28, 0xf7af60);
    const legs = [-0.22, 0.22].map((x) => box(agent, x, 0.34, 0, 0.26, 0.54, 0.3, 0xc8d3d5));
    const ringGeo = new THREE.RingGeometry(0.68, 0.75, 16);
    geometries.add(ringGeo);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffa05e, side: THREE.DoubleSide });
    materials.add(ringMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    agent.add(ring);
    for (const [x, z] of [
      [-8, 4],
      [3, -4],
      [7, 8],
      [-5, -7],
    ]) {
      box(scene, x, 0.1, z, 0.7, 0.5, 0.7, 0x5b6575);
      box(scene, x, 0.4, z, 0.75, 0.12, 0.75, 0x88919c);
      box(scene, x + 0.5, -0.1, z + 0.8, 0.9, 0.12, 0.55, 0x7e6f4d);
    }
    const raycaster = new THREE.Raycaster();
    function click(event) {
      const r = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - r.left) / r.width) * 2 - 1,
          (-(event.clientY - r.top) / r.height) * 2 + 1,
        ),
        camera,
      );
      const hit = raycaster.intersectObjects(hits)[0];
      if (hit) state.current.onSelect(hit.object.userData.station);
    }
    renderer.domElement.addEventListener('click', click);
    const lost = (e) => {
      e.preventDefault();
      onFailure();
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    let width = 1,
      height = 1;
    const resize = new ResizeObserver((entries) => {
      width = entries[0].contentRect.width;
      height = entries[0].contentRect.height;
      renderer.setSize(width, height);
      camera.left = (-23 * width) / height;
      camera.right = (23 * width) / height;
      camera.top = 23;
      camera.bottom = -23;
      camera.updateProjectionMatrix();
    });
    resize.observe(element);
    let last = 0;
    const follow = new THREE.Vector3(),
      look = new THREE.Vector3(),
      projected = new THREE.Vector3();
    function place(label, x, y, z) {
      if (!label) return;
      projected.set(x, y, z).project(camera);
      label.style.transform = `translate(${((projected.x + 1) * width) / 2}px,${((-projected.y + 1) * height) / 2}px) translate(-50%,-50%)`;
    }
    renderer.setAnimationLoop((time) => {
      if (document.hidden || time - last < 32) return;
      const dt = Math.min((time - last) / 1000, 0.05);
      last = time;
      const s = state.current,
        target = STATION_BY_ID[s.activeStation] ?? STATION_BY_ID.command;
      const dx = target.x - agent.position.x,
        dz = target.z + 2.6 - agent.position.z,
        distance = Math.hypot(dx, dz);
      if (s.reduced) agent.position.set(target.x, 0.1, target.z + 2.6);
      else if (distance > 0.06) {
        const step = Math.min(dt * 5, distance);
        agent.position.x += (dx / distance) * step;
        agent.position.z += (dz / distance) * step;
        agent.rotation.y = Math.atan2(dx, dz);
      }
      legs.forEach(
        (leg, i) =>
          (leg.rotation.x = !s.reduced && distance > 0.1 ? Math.sin(time * 0.013 + i * Math.PI) * 0.45 : 0),
      );
      // Gentle tracking keeps the full ecosystem legible while following the agent.
      follow.lerp(
        new THREE.Vector3(agent.position.x * 0.25, 0, agent.position.z * 0.25),
        s.reduced ? 1 : 0.035,
      );
      camera.position.set(32 + follow.x, 37, 42 + follow.z);
      look.set(follow.x, 0, 1 + follow.z);
      camera.lookAt(look);
      camera.zoom = s.zoom;
      camera.updateProjectionMatrix();
      nodes.forEach(({ station, beacon }) => {
        beacon.material = material(colors[s.statuses[station.id]?.tone] || station.color, true);
        place(labels.current[station.id], station.x, 3.4, station.z);
      });
      place(agentLabel.current, agent.position.x, 3.3, agent.position.z);
      renderer.render(scene, camera);
    });
    return () => {
      resize.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener('click', click);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [mode, reset, onFailure]);
  if (mode === 'map')
    return <TacticalMap {...{ activeStation, selected, onSelect, reduced, statuses, zoom, reset }} />;
  return (
    <div
      className="mc-scene"
      ref={host}
      aria-label="3D orbital station. Select a station label to inspect it."
    >
      <div className="mc-planet" aria-hidden="true" />
      {STATIONS.map((s) => (
        <button
          key={s.id}
          ref={(el) => (labels.current[s.id] = el)}
          className={`mc-scene-label ${selected === s.id ? 'is-selected' : ''} ${activeStation === s.id ? 'is-active' : ''}`}
          onClick={() => onSelect(s.id)}
          style={{ '--station': s.color }}
          aria-label={`Inspect ${s.name}: ${statuses[s.id]?.label}`}
        >
          <span>{s.code}</span> {s.name}
          <i className={`mc-dot mc-dot--${statuses[s.id]?.tone}`} />
        </button>
      ))}
      <div ref={agentLabel} className="mc-agent-label">
        DAMON <span>◆</span>
      </div>
    </div>
  );
}

function TacticalMap({ activeStation, selected, onSelect, reduced, statuses, zoom, reset }) {
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef(null);
  const [position, setPosition] = useState({ x: 0, z: 6.6 });
  const target = STATION_BY_ID[activeStation] ?? STATION_BY_ID.command;
  useEffect(() => setPan({ x: 0, y: 0 }), [reset]);
  useEffect(() => {
    if (reduced) {
      setPosition({ x: target.x, z: target.z + 2.6 });
      return;
    }
    const timer = setInterval(
      () =>
        setPosition((p) => {
          const dx = target.x - p.x,
            dz = target.z + 2.6 - p.z,
            dist = Math.hypot(dx, dz);
          const step = Math.min(0.22, dist);
          return dist < 0.02 ? p : { x: p.x + (dx / dist) * step, z: p.z + (dz / dist) * step };
        }),
      40,
    );
    return () => clearInterval(timer);
  }, [target, reduced]);
  return (
    <div
      className="mc-map"
      tabIndex={0}
      role="group"
      aria-label="2D station map. Drag to pan, arrow keys to pan, use zoom buttons to zoom."
      onKeyDown={(e) => {
        const delta = { ArrowLeft: [25, 0], ArrowRight: [-25, 0], ArrowUp: [0, 25], ArrowDown: [0, -25] }[
          e.key
        ];
        if (delta) {
          e.preventDefault();
          setPan((p) => ({
            x: Math.max(-400, Math.min(400, p.x + delta[0])),
            y: Math.max(-300, Math.min(300, p.y + delta[1])),
          }));
        }
      }}
      onPointerDown={(e) => {
        if (e.target.closest('button')) return;
        drag.current = { x: e.clientX, y: e.clientY, pan };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current)
          setPan({
            x: Math.max(-400, Math.min(400, drag.current.pan.x + e.clientX - drag.current.x)),
            y: Math.max(-300, Math.min(300, drag.current.pan.y + e.clientY - drag.current.y)),
          });
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <div className="mc-map-world" style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}>
        <svg viewBox="-210 -170 420 370" aria-hidden="true">
          <path
            d="M-130 -150 H130 L195 -90 V110 L120 185 H-130 L-195 110 V-80Z"
            fill="#131e2c"
            stroke="#475366"
            strokeWidth="2"
          />
          {STATIONS.map((s) => (
            <path
              key={s.id}
              d={`M0 40 H${s.x * 11} V${s.z * 11}`}
              fill="none"
              stroke={activeStation === s.id ? '#ffa15c' : '#384456'}
              strokeWidth="2"
              strokeDasharray="5 5"
            />
          ))}
        </svg>
        {STATIONS.map((s) => (
          <button
            key={s.id}
            className={`mc-map-node ${selected === s.id ? 'is-selected' : ''}`}
            style={{ left: `${50 + s.x * 2.4}%`, top: `${43 + s.z * 2.5}%`, '--station': s.color }}
            onClick={() => onSelect(s.id)}
          >
            <span className="mc-map-machine">
              {s.code}
              <i className={`mc-dot mc-dot--${statuses[s.id]?.tone}`} />
            </span>
            <b>{s.name}</b>
            <small>{s.tool}</small>
          </button>
        ))}
        <div
          className="mc-map-agent"
          style={{ left: `${50 + position.x * 2.4}%`, top: `${43 + position.z * 2.5}%` }}
        >
          <span className="mc-map-sprite">
            <i />
            <b />
            <em />
            <s />
          </span>
          <b>DAMON</b>
        </div>
      </div>
    </div>
  );
}
