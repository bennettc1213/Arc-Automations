/**
 * the wordmark, as sand.
 *
 * the portal's background says "arc automations" in characters. this is the
 * part of it that can come apart: every cell of the wordmark is a grain with a
 * slot to stand in, a way of being knocked out of it, somewhere to land, and a
 * way back up. the field (components/AsciiField.jsx) owns the glyphs, the
 * palette and the room the wordmark stands in; this owns nothing but positions
 * and the rules that move them, which is why it can be read on its own.
 *
 * the lifecycle is three beats and they are all one mechanism:
 *
 *   pour     grains are parked above the field and called down in a wave, so
 *            the wordmark assembles out of falling numbers rather than fading
 *            in. this is the arrival.
 *   erode    the cursor breaks the bonds it passes through. broken grains fall
 *            under gravity, bounce off the walls, and pile into a drift along
 *            the bottom that slumps when it gets too steep.
 *   gather   RECALL_MS after the last bond breaks, everything still loose is
 *            thrown back up to its slot in a second wave. the pour and the
 *            gather are the same code — the pour is just a gather from a
 *            starting position nobody ever saw.
 *
 * two choices here are deliberate and worth defending:
 *
 * everything is measured in character cells, never pixels. the grid is the
 * unit the effect is composed in and a phone's cell is half a desktop's, so a
 * gravity written in pixels would have grains falling at half the apparent
 * speed on the small screen, and the sand would read as a different material
 * at every breakpoint.
 *
 * the return flight is time-parameterised, not sprung. a spring is the
 * tempting answer and it is the wrong one here: it arrives asymptotically, so
 * the last second of the reassembly is a few thousand grains each sitting a
 * fraction of a cell out of place, and the wordmark never quite comes back
 * crisp. a grain on a timed path lands exactly on its slot, on a frame you can
 * name, and cannot be stranded by a tab that lost twenty seconds in the
 * background.
 */

/* ── what a grain can be doing ──────────────────────────────────────
   every rule below is written per state, so there is one place to look when
   one of them misbehaves. */
export const HOME = 0; /* standing in its slot in the wordmark */
export const LOOSE = 1; /* knocked out, falling */
export const RESTED = 2; /* lying in the drift at the bottom */
export const BACK = 3; /* in the air on its way home */

/* ── the cursor ─────────────────────────────────────────────────────
   one model serves both halves of the interaction. everything inside the push
   ring is shoved away from the cursor; everything inside the smaller break
   ring is shoved away *and* let go of. so a cursor drifting near the wordmark
   bulges it and a cursor crossing it takes it apart, and those are not two
   separate features that have to be kept in agreement with each other. */
const BREAK_W = 0.052; /* break radius as a fraction of field width */
const BREAK_MIN = 44; /* ...floored and capped in px, so the bite is the */
const BREAK_MAX = 116; /*    same size on a phone and on a 4k display */
const PUSH_RATIO = 2.4; /* the membrane reaches this much further than the break */
const PUSH_FORCE = 0.35; /* cells/frame² at the inner edge of the push ring */
const BOND = 0.09; /* stiffness holding a grain to its slot */
const BOND_DRAG = 0.62; /* ...and its damping, just under critical */
const BURST = 0.7; /* cells/frame kick a grain takes as its bond breaks */
const SPIN = 0.22; /* ...sideways, so the spray is not a clean radial fan */
const LIFT = 0.35; /* ...and upward, so debris arcs instead of dropping */

/* ── falling ────────────────────────────────────────────────────── */
const GRAVITY = 0.035; /* cells/frame² */
const DRAG_X = 0.988;
const DRAG_Y = 0.996;
const TERMINAL = 1.5; /* cells/frame */
const WALL_BOUNCE = 0.3;

/* ── the drift at the bottom ────────────────────────────────────── */
/* the hero fades to the page background across its bottom 14%, so a drift
   lying on the true floor would build up inside a band that is painted over.
   the floor is lifted to just above the fade, which also buries the base of
   the drift softly instead of ending it on a hard line. */
const FLOOR = 0.9;
const PACK = 0.74; /* height one grain adds to its column, in cells */
const REPOSE = 1.1; /* a column this much prouder than its neighbour spills */
const ROLL = 0.4; /* sideways push a spilling grain gets, cells/frame */
const SLUMP = 0.3; /* ...and how much of its fall it keeps while it rolls */
/* contact friction, and the reason the drift ever stops moving. a rolling
   grain is touching the surface, and without friction it keeps nearly all its
   sideways speed — which lets it skate back and forth across a hollow for as
   long as the page is open, because rolling does not change the slope it is
   rolling down. at 0.6 a grain reaches a terminal roll of about one column per
   frame and comes to rest at the first place the slope will hold it. */
const ROLL_DRAG = 0.6;
/* how many times in a row a grain may be told to roll before it just stops.
   a slope is not always solvable: a grain can end up straddling two columns
   that each point it at the other, and it will roll off one, land on the next,
   be sent straight back, and keep that up for as long as the page is open —
   travelling two pixels a frame and arriving nowhere. the budget ends that. it
   leaves the drift one grain out of true in one place, which is a far better
   bargain than a grain that visibly vibrates. */
const ROLL_BUDGET = 24;
/* how many grains of the drift are re-examined for an over-steep face each
   frame. a slice rather than the whole drift: a full pass costs little at these
   counts, but it would drop an entire face on one frame, and a face that comes
   down over a second in a trickle of grains is both cheaper and a great deal
   more like sand. */
const SLUMP_SCAN = 64;
/* and it only lets go of a face that is a whole grain steeper than the one
   settle() is willing to build. without that margin the two rules disagree by
   exactly the height of one grain and the drift trickles forever — the slump
   releases a grain for standing too steep, settle() puts it straight back into
   a face just as steep, and neither rule is wrong on its own terms. */
const SLUMP_BIAS = 1;

/* ── going home ───────────────────────────────────────────────────
   the quiet time is the whole feel of the thing. too long and the wordmark is
   simply missing: a visitor who brushes past the letters gets a pile of sand
   and a page that appears to have broken, because nothing on screen suggests
   the state is temporary. short enough to read as recovery rather than damage
   is the target, and the clock restarts on every bond that breaks, so this is
   never a countdown anybody is fighting — it only begins once they have
   stopped. */
const RECALL_MS = 6000; /* quiet time before the field gathers itself back up */
const SWEEP_MS = 620; /* the wave crosses the field in this long */
const FALL_MS = 190; /* ...tilted by height, so it reads as a diagonal */
const JITTER_MS = 300; /* per-grain scatter, so the wave has a soft edge */
const FLIGHT_MS = 470; /* base flight time */
const FLIGHT_SPAN = 320; /* ...plus this much, scaled by distance travelled */
const THROW = 0.35; /* arc height as a fraction of the climb */
const THROW_MAX = 16; /* ...capped, in cells */

/* the pour is the same wave played slower and from further away: it is the
   first thing anybody sees of the portal, so it is allowed the extra beat. */
/* and it waits a beat before it starts. being armed means the door has begun
   to open, not that it is open — the tunnel is still fading out over it and the
   page behind is still fading in. without the lead the wave starts under an
   opaque overlay and the visitor's first sight of the field is a wordmark that
   has already finished assembling, which is the one thing the arrival exists
   not to be. tuned against the 0.7s stage fade in PortalHome.css. */
const POUR_LEAD = 620;
const POUR_SWEEP = 1150;
const POUR_JITTER = 520;
const POUR_DROP = 58; /* cells above the top edge the grains wait at */
const POUR_SCATTER = 5; /* ...and how far sideways of their slot, in cells */

/* how fast a grain's colour catches up with what it is doing. smoothed rather
   than switched, so a grain breaking loose cools over a few frames instead of
   changing colour on one. */
const HEAT_LERP = 0.11;
const HEAT_OF = [1, 0.34, 0.2, 0]; /* HOME, LOOSE, RESTED, (BACK is computed) */

const NOT_CALLED = Infinity; /* wake sentinel: this grain is in no wave */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* slow out of the drift, fast across, gentle onto the slot. */
function ease(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

export default function createSand() {
  let n = 0;
  let g = null; /* the grain arrays, replaced whole when the count changes */
  let pile = new Float32Array(0);

  let width = 0;
  let height = 0;
  let cellW = 1;
  let cellH = 1;
  let floorY = 0;
  let pileCols = 0;

  let lastBreak = -Infinity;
  let waving = false;
  let scan = 0; /* where the slump pass got to last frame */

  /* struct-of-arrays, and no object per grain. at full width the wordmark is a
     few thousand grains, and the difference between this and an array of
     little objects is the difference between the effect and a dropped frame. */
  function alloc(count) {
    n = count;
    g = {
      count,
      x: new Float32Array(count),
      y: new Float32Array(count),
      vx: new Float32Array(count),
      vy: new Float32Array(count),
      hx: new Float32Array(count) /* the slot in the wordmark */,
      hy: new Float32Array(count),
      sx: new Float32Array(count) /* where the current flight started */,
      sy: new Float32Array(count),
      cover: new Float32Array(count) /* how much of this cell the letter fills */,
      rnd: new Float32Array(count) /* stable per-grain randomness */,
      heat: new Float32Array(count) /* 0 spent … 1 standing in the wordmark */,
      glow: new Float32Array(count) /* how hard the cursor is leaning on it */,
      arc: new Float32Array(count),
      dur: new Float32Array(count),
      wake: new Float64Array(count) /* when this grain is called home */,
      t0: new Float64Array(count) /* ...and when it actually left */,
      state: new Uint8Array(count),
      roll: new Uint8Array(count) /* rolls spent since it was last let go */,
      col: new Int32Array(count) /* which pile column it lies in, or -1 */,
    };
  }

  /* ── taking a new set of slots ──────────────────────────────────
     called on the first build and on every resize, in one of three moods:

       park   place every grain above the top edge, motionless and uncalled.
              this is the arrival, held: the portal's door animation is still
              covering the screen at this point and a pour played underneath it
              is a pour nobody sees. `pour()` releases it.
       keep   carry the positions and states the grains already had, re-aim
              them at the new slots, and gather. this is a resize.
       set    stand everything in the wordmark, finished. reduced motion, and
              the fallback when there is nothing to carry. */
  function adopt(homes, geom, mode) {
    width = geom.width;
    height = geom.height;
    cellW = geom.cellW;
    cellH = geom.cellH;
    floorY = height * FLOOR;
    pileCols = Math.max(1, Math.ceil(width / cellW));
    pile = new Float32Array(pileCols);

    const count = homes.count;
    const old = g;
    const carry = mode === 'keep' && old ? Math.min(old.count, count) : 0;
    alloc(count);

    for (let i = 0; i < count; i++) {
      g.hx[i] = homes.hx[i];
      g.hy[i] = homes.hy[i];
      g.cover[i] = homes.cover[i];
      g.rnd[i] = homes.rnd[i];
      g.col[i] = -1;
      g.wake[i] = NOT_CALLED;

      if (i < carry) {
        /* the drift went with the old geometry, so anything that was lying
           down is put back in the air and called home with everything else. */
        g.x[i] = old.x[i];
        g.y[i] = old.y[i];
        g.heat[i] = old.heat[i];
        g.state[i] = old.state[i] === HOME ? HOME : LOOSE;
      } else if (mode === 'park') {
        /* parked, not falling. a grain waiting its turn above the top edge is
           off-screen and motionless, and is called down by the same wave that
           gathers the drift later. one mechanism, two uses. */
        g.x[i] = g.hx[i] + (homes.rnd[i] - 0.5) * cellW * POUR_SCATTER * 2;
        g.y[i] = -cellH * (4 + homes.rnd[i] * POUR_DROP);
        g.state[i] = RESTED;
        g.heat[i] = 0;
      } else {
        g.x[i] = g.hx[i];
        g.y[i] = g.hy[i];
        g.state[i] = HOME;
        g.heat[i] = 1;
      }
    }

    waving = false;
    if (carry) {
      /* a resize leaves grains aimed at slots that have moved. gather at once
         rather than waiting out the quiet timer — the alternative is half a
         minute of a wordmark assembled in the wrong place. */
      call(performance.now(), SWEEP_MS, JITTER_MS);
    }
  }

  /* the door has opened: let the parked grains down. deliberately separate
     from adopt() so a resize while the door is still shut re-parks without
     spending the arrival. */
  function pour(now) {
    lastBreak = -Infinity;
    call(now + POUR_LEAD, POUR_SWEEP, POUR_JITTER);
  }

  /* ── the wave ───────────────────────────────────────────────────
     every grain that is not home gets a moment to leave. the moment is its
     slot's position across the field, plus its height, plus a little of its
     own randomness — which is what turns a few thousand simultaneous
     departures into something that crosses the screen. */
  function call(now, sweep, jitter) {
    if (!g) return;
    let called = 0;
    for (let i = 0; i < n; i++) {
      if (g.state[i] === HOME) continue;
      const across = width > 0 ? g.hx[i] / width : 0;
      const down = height > 0 ? g.hy[i] / height : 0;
      g.wake[i] = now + across * sweep + down * FALL_MS + g.rnd[i] * jitter;
      called++;
    }
    waving = called > 0;
  }

  /* a grain leaving the ground: the whole flight is decided here and then
     simply played out, so it cannot fail to arrive. */
  function launch(i, now) {
    if (g.col[i] >= 0) {
      /* it was holding up part of the drift, so the drift loses that height.
         grains do not necessarily leave in the order they landed, so this is
         an approximation — but it is one that reaches zero exactly as the last
         grain leaves, which is the only property that shows. */
      pile[g.col[i]] = Math.max(0, pile[g.col[i]] - PACK * cellH);
      g.col[i] = -1;
    }
    const dx = g.hx[i] - g.x[i];
    const dy = g.hy[i] - g.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);
    const span = width + height;

    g.sx[i] = g.x[i];
    g.sy[i] = g.y[i];
    g.t0[i] = now;
    g.dur[i] = FLIGHT_MS + (span > 0 ? dist / span : 0) * FLIGHT_SPAN + g.rnd[i] * 180;
    /* the throw. a grain climbing out of the drift is tossed above its slot and
       drops onto it, which is what makes the gather read as sand being lifted
       rather than sand being teleported. a grain pouring in from above is
       already falling, so it gets a bob and nothing more. */
    const climb = Math.max(0, g.sy[i] - g.hy[i]);
    g.arc[i] =
      Math.min(climb * THROW, cellH * THROW_MAX) * (0.35 + g.rnd[i] * 0.5) +
      cellH * (0.4 + g.rnd[i]);
    g.vx[i] = 0;
    g.vy[i] = 0;
    g.state[i] = BACK;
  }

  function land(i, now) {
    g.state[i] = HOME;
    g.x[i] = g.hx[i];
    g.y[i] = g.hy[i];
    g.vx[i] = 0;
    g.vy[i] = 0;
    g.wake[i] = NOT_CALLED;
    g.t0[i] = now;
  }

  /* ── the drift ──────────────────────────────────────────────────
     the angle of repose, done the cheap and honest way. a grain that lands on
     a column standing well proud of its neighbour does not stay on top of it,
     it rolls down the slope — one column per frame, so a steep drift slumps
     over several frames the way a real one does. */
  function settle(i, c, surface, nx) {
    const h = pile[c];
    const l = c > 0 ? pile[c - 1] : Infinity;
    const r = c < pileCols - 1 ? pile[c + 1] : Infinity;
    const repose = REPOSE * cellH;

    if (h - l > repose || h - r > repose) {
      if (g.roll[i] < ROLL_BUDGET) {
        g.roll[i]++;
        const dir = h - l > h - r ? -1 : 1;
        g.vx[i] = g.vx[i] * ROLL_DRAG + dir * ROLL * cellW;
        g.vy[i] *= SLUMP;
        g.x[i] = nx;
        g.y[i] = surface - cellH * 0.5;
        return; /* still loose, still moving, one column further downhill */
      }
      /* out of budget. it comes to rest on the lowest column within reach
         rather than wherever it happened to give up, so a grain that could not
         solve its slope at least does not leave that slope any worse. */
      if (l < h && l <= r) c -= 1;
      else if (r < h) c += 1;
    }

    /* snapped to the column centre. this is a field of characters and
       characters sit on a grid — a drift of grains at arbitrary sub-cell
       offsets reads as blur rather than as sand. */
    g.x[i] = c * cellW + cellW * 0.5;
    g.y[i] = floorY - pile[c] - cellH * 0.5;
    g.vx[i] = 0;
    g.vy[i] = 0;
    g.col[i] = c;
    g.roll[i] = 0;
    g.state[i] = RESTED;
    pile[c] += PACK * cellH;
  }

  /* ── one frame ──────────────────────────────────────────────────
     `dt` is scaled against a 60hz frame rather than used raw, and capped: a
     tab returning from the background hands over a delta worth several
     seconds, and an uncapped step would throw every grain through the floor on
     the frame the visitor comes back. */
  function step(now, dtMs, ptr) {
    if (!g || n === 0) return;
    const k = clamp(dtMs / 16.667, 0.2, 2.5);

    const grav = GRAVITY * cellH * k;
    const term = TERMINAL * cellH;
    const dragX = DRAG_X ** k;
    const dragY = DRAG_Y ** k;
    const bondDrag = BOND_DRAG ** k;

    const brk = clamp(width * BREAK_W, BREAK_MIN, BREAK_MAX);
    const push = brk * PUSH_RATIO;
    const push2 = push * push;
    const live = ptr.active;

    let waiting = 0;
    let flying = 0;

    for (let i = 0; i < n; i++) {
      let st = g.state[i];
      let pressed = 0;

      /* ── the cursor ── */
      if (live) {
        const dx = g.x[i] - ptr.x;
        const dy = g.y[i] - ptr.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < push2) {
          const d = Math.sqrt(d2) || 0.001;
          const nx = dx / d;
          const ny = dy / d;

          if (d < brk) {
            pressed = 1;
            const bite = 1 - d / brk;
            if (st === HOME || st === BACK) {
              /* the bond goes. this is the only event that resets the quiet
                 timer — stirring the drift is not the wordmark coming apart
                 and should not hold off its reassembly. */
              lastBreak = now;
              g.wake[i] = NOT_CALLED;
              g.roll[i] = 0;
              st = LOOSE;
              g.state[i] = LOOSE;
              const kick = BURST * (0.6 + g.rnd[i] * 0.8) * (0.4 + bite);
              g.vx[i] += (nx * kick + (g.rnd[i] - 0.5) * SPIN) * cellW;
              g.vy[i] += ny * kick * cellH * 0.5 - LIFT * cellH * (0.3 + bite);
            } else if (st === RESTED && g.col[i] >= 0) {
              /* the drift is kickable too. it costs five lines, and it is the
                 difference between a pile of sand and a picture of one. */
              pile[g.col[i]] = Math.max(0, pile[g.col[i]] - PACK * cellH);
              g.col[i] = -1;
              g.roll[i] = 0;
              st = LOOSE;
              g.state[i] = LOOSE;
              g.vx[i] += nx * BURST * cellW * bite;
              g.vy[i] += -LIFT * cellH * bite * 1.4;
            }
          } else if (st !== RESTED) {
            /* the membrane: bulge, do not break. the field had this before it
               could come apart, and it is kept deliberately — it is the cue
               that tells a visitor the wordmark is worth touching at all. */
            const f = ((push - d) / (push - brk)) ** 2 * PUSH_FORCE;
            pressed = f / PUSH_FORCE;
            g.vx[i] += nx * f * cellW * k;
            g.vy[i] += ny * f * cellH * k;
          }
        }
      }

      /* ── called home ── */
      if (waving && st !== HOME && st !== BACK && g.wake[i] !== NOT_CALLED) {
        if (now >= g.wake[i]) {
          launch(i, now);
          st = BACK;
        } else {
          waiting++;
        }
      }

      /* ── what it does with the frame ── */
      if (st === HOME) {
        /* held to its slot by a stiff, heavily damped spring, so the cursor's
           push displaces it and letting go returns it exactly. */
        g.vx[i] = (g.vx[i] + (g.hx[i] - g.x[i]) * BOND * k) * bondDrag;
        g.vy[i] = (g.vy[i] + (g.hy[i] - g.y[i]) * BOND * k) * bondDrag;
        g.x[i] += g.vx[i] * k;
        g.y[i] += g.vy[i] * k;
      } else if (st === BACK) {
        flying++;
        const p = (now - g.t0[i]) / g.dur[i];
        if (p >= 1) {
          land(i, now);
        } else {
          const e = ease(p);
          g.x[i] = g.sx[i] + (g.hx[i] - g.sx[i]) * e;
          g.y[i] = g.sy[i] + (g.hy[i] - g.sy[i]) * e - g.arc[i] * Math.sin(Math.PI * p);
        }
      } else if (st === LOOSE) {
        g.vx[i] *= dragX;
        g.vy[i] = g.vy[i] * dragY + grav;
        if (g.vy[i] > term) g.vy[i] = term;

        let nx = g.x[i] + g.vx[i] * k;
        const ny = g.y[i] + g.vy[i] * k;

        /* the field has edges, and a grain that leaves through one never comes
           back. bounce, losing most of the speed. */
        if (nx < 0) {
          nx = 0;
          g.vx[i] = -g.vx[i] * WALL_BOUNCE;
        } else if (nx > width) {
          nx = width;
          g.vx[i] = -g.vx[i] * WALL_BOUNCE;
        }

        /* swept against the top of the drift rather than against the floor, so
           nothing can fall through a column however fast it is going. */
        const c = clamp((nx / cellW) | 0, 0, pileCols - 1);
        const surface = floorY - pile[c];
        if (ny >= surface) settle(i, c, surface, nx);
        else {
          g.x[i] = nx;
          g.y[i] = ny;
        }
      }

      /* ── colour follows conduct ──
         a grain in flight warms from spent toward the brightness its own cell
         will have once it is standing in the letter. aiming at `cover` rather
         than at a flat maximum is what makes the landing continuous: the field
         lights a homed grain from its coverage, so a grain that arrives at
         full heat would dim on the frame it touched down, and the last beat of
         the reassembly would be a few thousand tiny flickers. */
      const target =
        g.state[i] === BACK
          ? 0.28 +
            (Math.min(1, g.cover[i] + 0.1) - 0.28) * clamp((now - g.t0[i]) / g.dur[i], 0, 1)
          : HEAT_OF[g.state[i]];
      g.heat[i] += (target - g.heat[i]) * HEAT_LERP * k;
      g.glow[i] += (pressed - g.glow[i]) * 0.2 * k;
    }

    /* ── the slump ──
       settle() decides where an arriving grain comes to rest, and that is all
       it can do: it has no say over a face that is already too steep. two
       things build those — the cursor scooping a crater out of the drift, and a
       wave lifting one column clear while its neighbours stay put — and left
       alone they stand there as vertical walls of sand, which is the one thing
       a heap of sand cannot be. so a slice of the drift is re-examined every
       frame and anything overhanging is let go to find a lower column. it is
       self-limiting: once nothing overhangs, nothing is released. */
    const shed = REPOSE * cellH + SLUMP_BIAS * PACK * cellH;
    for (let s = 0; s < SLUMP_SCAN; s++) {
      const i = (scan + s) % n;
      if (g.state[i] !== RESTED) continue;
      const c = g.col[i];
      if (c < 0) continue;
      const h = pile[c];
      const l = c > 0 ? pile[c - 1] : Infinity;
      const r = c < pileCols - 1 ? pile[c + 1] : Infinity;
      if (h - l <= shed && h - r <= shed) continue;

      /* it leaves from the top of its column, not from wherever in the stack it
         happened to be sitting — so what the eye sees is a grain coming off the
         face and tumbling down the slope, rather than one materialising out of
         the middle of the heap. */
      pile[c] = Math.max(0, h - PACK * cellH);
      g.y[i] = floorY - pile[c] - cellH * 0.5;
      g.vx[i] = (h - l > h - r ? -1 : 1) * ROLL * cellW * 1.6;
      g.vy[i] = 0;
      g.col[i] = -1;
      g.roll[i] = 0;
      g.state[i] = LOOSE;
    }
    scan = (scan + SLUMP_SCAN) % n;

    /* the wave is over when nobody is still waiting for it and nobody is still
       in the air because of it. grains broken loose *during* a wave were taken
       out of it as their bond went, so they cannot hold it open — they wait out
       their own quiet period and go home in the next one. */
    if (waving && waiting === 0 && flying === 0) waving = false;

    if (!waving && now - lastBreak > RECALL_MS) {
      let adrift = 0;
      for (let i = 0; i < n; i++) if (g.state[i] !== HOME) adrift++;
      if (adrift > 0) call(now, SWEEP_MS, JITTER_MS);
    }
  }

  return {
    adopt,
    pour,
    step,
    get grains() {
      return g;
    },
  };
}
