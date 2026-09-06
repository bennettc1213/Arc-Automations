import { useEffect, useRef, useState } from 'react';
import {
  Scene,
  WebGLRenderer,
  PerspectiveCamera,
  Object3D,
  BoxGeometry,
  MeshBasicMaterial,
  InstancedMesh,
  DynamicDrawUsage,
  CanvasTexture,
  SRGBColorSpace,
  Color,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import './HoleTunnel.css';

/**
 * the doorway between the marketing site and the portal.
 *
 * a cylinder of wireframe boxes recedes into a hole. scrolling scales the whole
 * scene up so the mouth of the hole grows past the viewport, and at the moment
 * it swallows the screen the portal is already behind it. the canvas then fades
 * and tears itself down — this is an entrance, not a permanent layer, and a
 * WebGL context left running under a dashboard is a battery leak.
 *
 * driven by raw wheel/touch/key deltas rather than real scroll: the page must
 * not actually move, because there is nothing below yet. that also rules out
 * ScrollTrigger and ScrollSmoother, which would be managing a scroll position
 * pinned at zero by design.
 *
 * eased with a per-frame lerp inside the render loop that already exists,
 * rather than a tween library racing itself on every wheel event.
 */

const MIN_SCALE = 1.5;
const BREACH_SCALE = 2.7;
const MAX_SCALE = 8;

/* deltaY units needed to cross the gap — roughly seven notches of a mouse wheel. */
const SPEED = 0.0016;

const ROWS = 36;
const COLUMNS = 30;
const LAYERS = 3;

/* the pieces flung closest to the camera take the lightest tint and the far
   wall of the tunnel falls away to grey, so depth is read as temperature.
   all three warm stops are the site's own accent tokens — going straight to
   --accent for the nearest geometry made the whole entrance read as an alarm
   state rather than as a brand colour. */
const NEAR = new Color(0xffa366);
const MID = new Color(0xff4d00);
const FAR = new Color(0x26262c);

const GRAIN_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* film grain plus a horizontal RGB split that widens with scroll speed, so
   pushing harder visibly tears the image. */
const GRAIN_FRAG = `
  uniform float amount;
  uniform sampler2D tDiffuse;
  varying vec2 vUv;

  float random(vec2 p) {
    vec2 k = vec2(23.14069263277926, 2.665144142690225);
    return fract(cos(dot(p, k)) * 12345.6789);
  }

  void main() {
    vec2 uv = vUv;
    float lineHash = random(vec2(floor(uv.y * 180.0), amount));
    uv.x += (lineHash * 2.0 - 1.0) * amount * 0.010;

    /* kept deliberately small. a wide split stops reading as a camera artifact
       and starts reading as a broken driver, and it drags the accent orange
       apart into red and green fringes. */
    float split = amount * 0.0042;
    vec4 cR = texture2D(tDiffuse, uv + vec2(split, 0.0));
    vec4 cG = texture2D(tDiffuse, uv);
    vec4 cB = texture2D(tDiffuse, uv - vec2(split, 0.0));
    vec4 col = vec4(cR.r, cG.g, cB.b, cG.a);

    vec2 uvNoise = vec2(uv.x, uv.y * random(vec2(uv.y, amount)));
    col.rgb += random(uvNoise) * (0.05 + amount * 0.09);

    gl_FragColor = col;
  }
`;

export default function HoleTunnel({ onBreach, onDone }) {
  const hostRef = useRef(null);
  const barRef = useRef(null);
  /* phase is React state, never a dataset written from inside the effect. an
     attribute stamped on the host survives a remount; state does not, and under
     StrictMode the mount/cleanup/mount cycle would otherwise leave the second
     scene rendering into a host the first one had already marked as finished. */
  const [phase, setPhase] = useState('flying');
  /* read through refs so a re-rendering parent never re-runs the effect and
     rebuilds the whole scene mid-animation. */
  const breachRef = useRef(onBreach);
  const doneRef = useRef(onDone);
  breachRef.current = onBreach;
  doneRef.current = onDone;

  useEffect(() => {
    const host = hostRef.current;
    const bar = barRef.current;
    if (!host) return undefined;

    let renderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      /* no WebGL: the portal still has to open. skip straight through. */
      breachRef.current?.();
      return undefined;
    }

    const size = () => ({
      width: host.clientWidth || window.innerWidth,
      height: host.clientHeight || window.innerHeight,
    });
    let { width, height } = size();

    const camera = new PerspectiveCamera(60, width / height, 1, 1000);
    camera.position.set(0.3, 0.3, -13.34);
    camera.lookAt(0, 0, 0);

    const scene = new Scene();
    scene.background = new Color(0x0a0a0b);
    scene.rotation.x = -Math.PI / 2;
    scene.scale.setScalar(MIN_SCALE);

    /* a white square with its middle punched out: mapped onto every face of
       every box it reads as wireframe, for the cost of one texture fetch. */
    const texCanvas = document.createElement('canvas');
    const tsize = (texCanvas.width = texCanvas.height = 32);
    const ctx = texCanvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, tsize, tsize);
      ctx.clearRect(1, 1, tsize - 2, tsize - 2);
    }
    const map = new CanvasTexture(texCanvas);
    map.colorSpace = SRGBColorSpace;
    map.anisotropy = renderer.capabilities.getMaxAnisotropy?.() ?? 1;

    const geom = new BoxGeometry(1, 1, 1);
    const material = new MeshBasicMaterial({ map, transparent: true });
    const mesh = new InstancedMesh(geom, material, ROWS * COLUMNS * LAYERS);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    scene.add(mesh);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    host.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const grain = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, amount: { value: 0 } },
      vertexShader: GRAIN_VERT,
      fragmentShader: GRAIN_FRAG,
    });
    grain.renderToScreen = true;
    composer.addPass(grain);

    const dummy = new Object3D();
    const tint = new Color();

    let raf = 0;
    let disposed = false;
    let locked = false;
    let fading = false;
    let fadeTimer = 0;
    const start = performance.now();

    let scale = MIN_SCALE;
    let target = MIN_SCALE;
    let approach = 0.08;
    let kick = 0;
    let opacity = 1;

    const setProgress = () => {
      const p = Math.min(1, Math.max(0, (target - MIN_SCALE) / (BREACH_SCALE - MIN_SCALE)));
      if (bar) bar.style.transform = `scaleX(${p})`;
    };

    const breach = () => {
      if (locked || disposed) return;
      locked = true;
      target = BREACH_SCALE;
      approach = 0.14;
      setProgress();
      setPhase('locked');
      /* the portal starts fading up now, underneath, so the canvas is never
         hiding a blank page while it dies. */
      breachRef.current?.();
      fadeTimer = window.setTimeout(() => {
        fading = true;
        /* keep flying for the length of the fade rather than stopping dead. */
        target = MAX_SCALE;
        approach = 0.05;
      }, 420);
    };

    const push = (delta) => {
      if (disposed) return;
      kick = Math.min(1, Math.max(kick, Math.abs(delta) * 0.0016));
      if (locked) return;
      target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, target + delta * SPEED));
      setProgress();
      if (target >= BREACH_SCALE) breach();
    };

    const onWheel = (e) => {
      e.preventDefault();
      push(e.deltaY || 0);
    };

    let touchY = null;
    const onTouchStart = (e) => {
      touchY = e.touches?.[0]?.clientY ?? null;
    };
    const onTouchMove = (e) => {
      if (touchY == null) return;
      e.preventDefault();
      const y = e.touches[0].clientY;
      push((touchY - y) * 2.2);
      touchY = y;
    };
    const onTouchEnd = () => {
      touchY = null;
    };

    /* a scroll-gated door that only answers to a wheel is a door with no handle
       for anyone on a keyboard. */
    const onKey = (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
        e.preventDefault();
        breach();
      } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        push(340);
      }
    };

    const onResize = () => {
      if (disposed) return;
      ({ width, height } = size());
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      composer.setSize(width, height);
    };

    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: false });
    host.addEventListener('touchend', onTouchEnd, { passive: true });
    host.addEventListener('click', breach);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);

    const teardown = () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      clearTimeout(fadeTimer);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
      host.removeEventListener('touchend', onTouchEnd);
      host.removeEventListener('click', breach);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      composer.dispose?.();
      geom.dispose();
      material.dispose();
      map.dispose();
      renderer.dispose();
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;

      const time = (performance.now() - start) / 1000;
      scale += (target - scale) * approach;
      kick *= 0.9;
      scene.scale.setScalar(scale);

      if (fading) {
        opacity -= 0.035;
        if (opacity <= 0) {
          /* release the GPU first, then ask the parent to drop us from the
             tree. the unmount runs teardown again and it no-ops. */
          teardown();
          doneRef.current?.();
          return;
        }
        renderer.domElement.style.opacity = String(opacity);
      }

      let i = 0;
      for (let x = 0; x < ROWS; x++) {
        const a = (x / ROWS) * Math.PI * 2;
        const cx = Math.cos(a) / 2;
        const cz = Math.sin(a) / 2;
        const t = time % 1;
        for (let y = 0; y < LAYERS; y++) {
          const shift =
            y * Math.abs(Math.sin(x / 1.3)) + Math.sin(x / 1.3) + Math.cos(x / 1.7) - LAYERS;
          for (let z = 0; z < COLUMNS; z++) {
            const fall = Math.max(0, 3 - z + t - shift);
            const depth = z + 4 - t;
            /* the innermost ring is culled — that gap is the hole itself. */
            if (Math.abs(depth) * 0.5 < 3) continue;

            dummy.position.set(cx * depth, y - fall ** 5, cz * depth);
            dummy.rotation.y = -a;
            dummy.scale.set(0.5, 1, 0.5);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);

            const f = z / COLUMNS;
            if (f < 0.5) tint.copy(NEAR).lerp(MID, f * 2);
            else tint.copy(MID).lerp(FAR, (f - 0.5) * 2);
            mesh.setColorAt(i, tint);

            i++;
          }
        }
      }
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      const reach = (scale - MIN_SCALE) / (BREACH_SCALE - MIN_SCALE);
      grain.uniforms.amount.value = Math.min(0.75, 0.05 + reach * 0.18 + kick * 0.5);

      composer.render();
    };

    raf = requestAnimationFrame(frame);
    setProgress();

    return teardown;
  }, []);

  return (
    <div className="tunnel" ref={hostRef} data-phase={phase}>
      <div className="tunnel__cue">
        <span className="tunnel__label">scroll to enter</span>
        <span className="tunnel__track">
          <span className="tunnel__bar" ref={barRef} />
        </span>
        <span className="tunnel__hint">wheel, drag, or press enter</span>
      </div>
    </div>
  );
}
