# Changelog

All notable changes to this site (portfolio + the Arc client portal) are
documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/), versioned with
[Semantic Versioning](https://semver.org/) via `package.json`.

## [Unreleased]

## [1.12.1] - 2026-09-16

### Fixed
- **A client whose n8n workflows are sending no longer shows n8n as
  "connect".** The service cards only looked at connections entered by hand,
  so a client with months of events from n8n still showed a connect button
  if nobody had added an n8n row. Every event arrives from an n8n workflow,
  so any workflow activity now marks n8n connected. The card shows how many
  workflows, how many events and when the last one was. If no row exists
  yet, its button is **record it**: it opens the form already set to
  connected, with no sign-up tab. Other services are not inferred this way,
  because a Twilio send arrives as an n8n event, not as proof of the Twilio
  account.

## [1.12.0] - 2026-09-16

### Added
- **Services & subscriptions on every ops client page.** A table of the
  accounts each client's automation runs on (n8n, Twilio, OpenAI, ...) showing
  whose account it is, the key by its last four characters, where the real key
  is stored and when it was last checked, the subscription state, cost, who
  pays, and when it renews. Renewals within 7 days are flagged amber. Past-due
  and cancelled-but-still-connected are flagged red. A renewal date that has
  passed asks you to confirm the charge rather than claiming a lapse. **paid**
  rolls the renewal forward one cycle and **key ok** stamps the key as checked.
  Monthly totals are split into what Arc pays and what the client pays.
- **Connect a service.** A grid of 15 services, each marked *connected* or
  showing **connect**. Connect opens the provider's sign-up in a new tab and
  opens a form on the page to record the account, key hint and billing. Cards
  that are already connected show **manage** instead. Each row links straight
  to the provider's billing and API-key pages.
- Migration `0006_connection_billing.sql`: `provider`, `account_ref`,
  `credential_hint` (limited to 4 characters, so a full key cannot be saved),
  `credential_location`, `verified_at`, `billing_status`, `paid_by`,
  `cost_cents`, `billing_cycle` and `renews_at` on `connections`. The console's
  Supabase page now says when it is missing.

### Fixed
- Editing a connection no longer resets its `expected_quiet_hours` to empty.
  The form never passed the value back, so every save cleared it.

## [1.10.5] - 2026-09-16

### Changed
- **The headline is big again.** 1.10.4 fixed the words breaking apart but
  sized the type at 11% of its column, which put it at 50-63px -- a third of
  the 156px billboard it was before the split. It is now as large as the
  column allows with "we don't just" still on one line: that line measures
  5.762em in Space Grotesk at weight 600 with this letter-spacing, read off
  the font file's advance widths rather than estimated, so `16cqw` fills 92%
  of the column. 122px on a 1920px screen, 82px at 1440.
- **The copy column grows faster to make room** --
  `clamp(380px, 60% - 280px, 760px)` -- and the hero now uses the full
  viewport width up to 2200px rather than sitting in a centred 1560px box, so
  most of that room comes out of the side margins rather than the film. The
  film is unchanged at 1180px (675px), about 9% narrower at 1440-1920px, and
  at its full 1160px on wider screens.
- **The location chip is back** where the column fits the button row, and
  wraps under the buttons where it does not.

### Removed
- `overflow-wrap: anywhere` on the headline. It is what split "don't" and
  "templates." mid-letter. An overflowing line now breaks at a space.

## [1.10.4] - 2026-09-16

### Fixed
- **The headline was rendering at its full billboard size inside a 360px
  column, and breaking words apart to fit.** Not the `ch` unit this time --
  that was real but it was the second bug, not the first. The `@media
  (min-width: 1180px)` block sat *above* the base rules in `Hero.css`, and a
  media query adds no specificity: `.hero__title` inside one and
  `.hero__title` outside it are the same weight, so the later of the two wins,
  and the later one was always the base rule. The split layout's
  `font-size` never applied once, at any point since it was introduced in
  1.10.0. Four rules were affected the same way -- `.hero__title`,
  `.hero__sub`, `.hero__foot` and `.hero__row`. The ones that did work
  (`.hero__grid`, `.hero__copy`, `.hero__stage`, `.hero__roam`) are exactly
  the ones whose base declarations come *before* the block, which is why the
  film kept moving and growing correctly while the headline never shrank.

  Every breakpoint block now lives at the bottom of the file, after the rules
  it overrides, with a note at the top saying why the order is load-bearing.

### Changed
- **The headline is sized against its column, not the viewport.** `11cqw` --
  eleven percent of the copy column, which is the ratio the full-width
  headline always had to the hero around it (156.8px of type in a 1432px
  container). Stating the ratio directly means the type and the column cannot
  drift apart at some width nobody checked, which is what every version of
  this bug has been. The column is `clamp(380px, 33%, 580px)`: a share of the
  grid rather than of the viewport, because between 1600px and 1680px a
  vw-sized column kept growing while the hero's capped width did not, and the
  film got *smaller* as the window got wider. It now grows monotonically from
  675px to 1104px across the whole range.
- **The hero's width cap is a clamp, not a breakpoint.**
  `clamp(1560px, 100vw - 120px, 1860px)` instead of a jump to a fixed wider
  value at 1680px, which snapped the hero 120px wider -- and the film a
  hundred pixels with it -- the moment you dragged a window past that mark.

## [1.10.3] - 2026-09-15

### Fixed
- **The headline was clipping words at the 1180px+ breakpoint.** The previous
  patch capped `.hero__copy` at `max-width: 30ch` meaning to give the shrunken
  column a floor. `ch` is the width of "0" in the element's *own* font, and
  `.hero__copy` never sets one -- it inherits the page's 16px, not the
  headline's 2.6-5.2rem. So the cap was a box sized for 16px text wrapped
  around 40-80px text: roughly a third the width the headline actually needed.
  The reveal masks around each line clip whatever doesn't fit, silently, so
  the failure was a word missing letters with nothing pointing at why.
  `.hero__title` now carries `overflow-wrap: anywhere` as a standing backstop
  -- a wrap nobody planned is a visible, harmless surprise; a clip is neither.

### Changed
- **The film's column is a fixed band now, not a fraction of the row, and
  claims everything past it.** `0.72fr`/`1.28fr` sounds pinned but isn't -- a
  fraction is a share of whatever space is left, so widening the hero itself
  (the 1680px rule two patches back) quietly widened the copy column right
  along with the film, undoing the point of narrowing it. The copy column is
  `minmax(260px, 360px)` now: a real ceiling that does not drift with the
  container. Everything past it -- `minmax(0, 1fr)` -- is the film's, which on
  a wide monitor is well over a thousand pixels, a much larger jump right than
  the fraction ever produced. The headline's clamp came down again to fit the
  new fixed column (`2.7rem` max, down from `5.2rem`), and the roaming pixel
  guy's floor is pinned to the same fixed width rather than a percentage of
  the hero that stopped meaning anything the moment the column did.

## [1.10.2] - 2026-09-15

### Changed
- **The hero's film sits further right, and bigger.** The two-column split
  above 1180px was `0.9fr`/`1.1fr`; it is `0.72fr`/`1.28fr` now, so the film's
  column -- and the card pinned to the end of it -- claims noticeably more of
  the row. Its own max-width grew with it, `1000px` to `1160px`. On monitors
  wide enough to spare it (1680px+), the hero's overall cap grew too, from
  `1560px` to `1760px`, so the extra room comes from space that was previously
  just margin rather than from squeezing the copy column further than it
  needs to shrink.

  The copy column paid for some of this: the headline's clamp came down again
  (`5.8rem` max to `5.2rem`), and the sub and copy column both capped at 30ch
  instead of 40-46ch. At that width the button row and the location chip no
  longer fit on one line, so the row wraps and the chip drops -- the same trade
  the phone layout already makes once things get this tight.

## [1.10.1] - 2026-09-15

### Fixed
- **Leaving the portal no longer flashes the homepage before the veil covers
  it.** The canvas that draws the crossing was created and given its first
  frame inside an ordinary effect, which runs after the browser has already
  painted. Going into the portal that gap was hidden behind the door's own
  `opacity: 0` starting state, but coming back out to the site the marketing
  page is already fully rendered underneath a veil that is transparent by
  design -- so for one frame the home page showed through an overlay that
  hadn't drawn anything onto it yet. Moved to a layout effect, which runs
  before paint, so the canvas's first frame (already fully covering the
  screen) is there from the moment the veil is visible at all.

## [1.10.0] - 2026-09-15

### Added
- **The hero runs a film of the portal.** A sixteen-second loop, played in a
  window card beside the headline, of somebody actually using `/demo`: a missed
  call lands in the live feed and the "missed calls answered" counter moves,
  the cursor crosses to `leads` in the rail and clicks it, the page swaps to the
  table, a row is opened to show the exact timeline underneath it -- lead,
  text, routed, replied, to the second -- and then the `replied` filter is
  clicked. Fade, loop.

  The path is chosen, not a tour. The claim above it is that leads get answered
  in seconds, and the one screen in the product that proves that claim is an
  expanded lead row with timestamps on it. Everything before the expansion
  exists to get there believably.

  It is a replica of the workspace rather than the workspace itself
  (`src/components/PortalFilm.jsx`, with its own stylesheet). The real thing is
  a lazy route carrying a Supabase client, a router and a hundred kilobytes of
  generated data; hauling all of that into the marketing bundle to play a loop
  nobody can click would cost more than the hero is worth. What it does share is
  the numbers -- 115 missed calls answered, 11.0s median, 253 leads, 99.44%
  uptime, Halstead Restoration -- which are the figures `/demo` actually
  renders, so clicking through from the film lands on the dashboard it just
  showed you.

  Every visual is derived from the current scene index rather than accumulated
  by side effects, so the loop restarts by setting a number back to zero. The
  cursor's targets are measured off the live DOM on each scene rather than
  written down as coordinates, so it keeps landing on the thing it is pointing
  at whether the card is 560px wide or 880px.

  It is the site's own square cursor, not a borrowed arrow -- an arrow here
  would be the only one on a site that replaced its pointer with a square. The
  clock stops when the film scrolls off screen, and `prefers-reduced-motion`
  gets the last frame of the film held still rather than no film at all.

### Changed
- **The hero is two columns above 1180px, and the film takes the larger half.**
  Copy left at `0.9fr`, film right at `1.1fr`, pinned to the right gutter with
  `justify-self: end` and centred on the headline's own axis. The headline gives
  up its billboard scale to make room -- `clamp(2.9rem, 4.9vw, 5.8rem)` instead
  of `clamp(3.1rem, 11.4vw, 9.8rem)` -- because eleven-and-a-half vw across half
  a screen is a word per line. The sub and the buttons stack instead of sharing a
  row, and the roaming pixel guy is kept to the copy column, since the window
  card is opaque and a mark that walks behind it has simply disappeared. Below
  1180px nothing changes except that the film stacks underneath at full width.

  The card is sized in `svh`, not pixels: `clamp(400px, 52svh, 560px)`. A fixed
  height generous enough to be worth looking at on a 1080p monitor is a hero
  taller than the fold on a 1366x768 laptop, which is the machine a contractor
  is most likely reading this on. The feed carries seven entries and the table
  seven leads to match the taller box -- a live feed with four rows and a hand of
  empty space under them is a product that looks quiet.

  The film's own breakpoints are container queries, not media queries: the card
  is about 55% of the viewport in the split hero and 100% of it when the hero
  stacks, so viewport width says nothing useful about how much room its table
  has. Under 660px the rail collapses to glyphs and the table sheds columns,
  exactly as the real workspace does.

### Added
- **The hero runs a film of the portal.** A sixteen-second loop, played in a
  window card beside the headline, of somebody actually using `/demo`: a missed
  call lands in the live feed and the "missed calls answered" counter moves,
  the cursor crosses to `leads` in the rail and clicks it, the page swaps to the
  table, a row is opened to show the exact timeline underneath it -- lead,
  text, routed, replied, to the second -- and then the `replied` filter is
  clicked. Fade, loop.

  The path is chosen, not a tour. The claim above it is that leads get answered
  in seconds, and the one screen in the product that proves that claim is an
  expanded lead row with timestamps on it. Everything before the expansion
  exists to get there believably.

  It is a replica of the workspace rather than the workspace itself
  (`src/components/PortalFilm.jsx`, with its own stylesheet). The real thing is
  a lazy route carrying a Supabase client, a router and a hundred kilobytes of
  generated data; hauling all of that into the marketing bundle to play a loop
  nobody can click would cost more than the hero is worth. What it does share is
  the numbers -- 115 missed calls answered, 11.0s median, 253 leads, 99.44%
  uptime, Halstead Restoration -- which are the figures `/demo` actually
  renders, so clicking through from the film lands on the dashboard it just
  showed you.

  Every visual is derived from the current scene index rather than accumulated
  by side effects, so the loop restarts by setting a number back to zero. The
  cursor's targets are measured off the live DOM on each scene rather than
  written down as coordinates, so it keeps landing on the thing it is pointing
  at whether the card is 560px wide or 880px.

  It is the site's own square cursor, not a borrowed arrow -- an arrow here
  would be the only one on a site that replaced its pointer with a square. The
  clock stops when the film scrolls off screen, and `prefers-reduced-motion`
  gets the last frame of the film held still rather than no film at all.

### Changed
- **The hero is two columns above 1180px, and the film takes the larger half.**
  Copy left at `0.9fr`, film right at `1.1fr`, pinned to the right gutter with
  `justify-self: end` and centred on the headline's own axis. The headline gives
  up its billboard scale to make room -- `clamp(2.9rem, 4.9vw, 5.8rem)` instead
  of `clamp(3.1rem, 11.4vw, 9.8rem)` -- because eleven-and-a-half vw across half
  a screen is a word per line. The sub and the buttons stack instead of sharing a
  row, and the roaming pixel guy is kept to the copy column, since the window
  card is opaque and a mark that walks behind it has simply disappeared. Below
  1180px nothing changes except that the film stacks underneath at full width.

  The card is sized in `svh`, not pixels: `clamp(400px, 52svh, 560px)`. A fixed
  height generous enough to be worth looking at on a 1080p monitor is a hero
  taller than the fold on a 1366x768 laptop, which is the machine a contractor
  is most likely reading this on. Row counts were raised to match the taller box
  -- seven feed entries and seven leads -- because a live feed with four rows and
  a hand of empty space under them is a product that looks quiet.

  The film's own breakpoints are container queries, not media queries: the card
  is about 46% of the viewport in the split hero and 100% of it when the hero
  stacks, so viewport width says nothing useful about how much room its table
  has. Under 660px the rail collapses to glyphs and the table sheds columns,
  exactly as the real workspace does.

## [1.9.0] - 2026-09-15

### Added
- **Leaving the portal plays the crossing in reverse.** Going in, the entrance
  sheet leaves to the right. Coming back out to the marketing site it now leaves
  to the left -- the same sheet, the same fray, the same seam and falling
  digits, mirrored about the vertical axis -- so the two halves of the product
  sit on either side of you and the transition says which way you just moved.

  It is modelled as an *arrival* on the site rather than an exit from the
  portal, which is what makes the browser's back button work. An exit animation
  has to hold the navigation open while it plays and there is no holding a
  popstate open -- by the time you hear about it the URL has already changed. An
  arrival that knows where it came from needs no such cooperation, so the back
  button, the link in the portal's bar, the one in its button row, the one in
  the ops door and the one in the workspace account menu are all one code path
  with nothing to intercept.

  It plays only for visitors who actually came from over there. `src/lib/crossing.js`
  remembers the last route; an arrival at `/` from a search result or a bookmark
  gets no wipe at all, because putting a full-screen animation in front of every
  first visit is the same mistake the tunnel made.

### Changed
- **The veil sits at `z-index: 1500`, up from 60.** 60 cleared the portal door
  (which tops out at 20) but not the marketing site's nav (100) or its pilot
  overlay (1000), so the sheet would have swept *under* the nav on the way out.
  Still below the cursor square and focus ring at 9990/9999, which are the one
  pair of layers that should keep drawing over a transition.

## [1.8.1] - 2026-09-15

### Changed
- **The wordmark comes back three seconds after it is broken, down from six.**
  End to end, from the cursor leaving the letters to the wordmark standing
  again: ~4.4s, against ~7.1s before and ~32.5s two versions ago.

  This is close to the floor, and the floor is set by the fall rather than by
  taste. A grain knocked off the wordmark in the top right corner takes about
  nine tenths of a second to reach the drift, so a quiet time much under 2.5s is
  mostly spent watching sand that is still in the air -- the pile it lands in
  never gets a moment to exist, and the erode half of the effect gets paid for
  and then thrown away.

## [1.8.0] - 2026-09-15

### Changed
- **The wordmark is small now, and it stands in the upper right.** It used to
  be the size of the hero -- roughly 1150x410px of "arc automations" across the
  middle of the field. It is about a third of that area now, tucked into the
  top right corner, with the gap between the two lines pulled in from 0.42 cap
  heights to 0.20.

  The corner is the upper one on purpose. The effect needs two things from
  wherever the wordmark lives: cursor traffic, and a drop. The upper right has
  both -- it sits on the diagonal between the nav in the top corner and the
  sign-in button down on the left, which is the path nearly every visitor's
  cursor actually takes, and it leaves the whole height of the hero underneath
  it for the sand to fall through. The lower right has the traffic and none of
  the drop: grains knocked off a wordmark already sitting on the floor fall a
  few pixels and stop.

  Placement and size are five named constants at the top of the file
  (`WORD_W`, `ARC_RATIO`, `WORD_X`, `WORD_Y`, `LINE_GAP`) rather than numbers
  buried in the rasteriser, so this is now tunable without reading the mask
  code.

- **The character cell is finer: 10px on desktop, 9px on phones, down from
  12/11/10.** This is what makes the small wordmark possible rather than a
  separate decision. These are letters drawn out of character cells, so
  legibility is a function of cells-per-letter, not of pixels -- at the old
  cell size a corner-sized "automations" had about three cells of cap height
  and came out as texture rather than as a word. The finer cell buys back the
  rows the smaller wordmark gave away. The drift is finer grained for it too,
  which reads rather more like sand and rather less like gravel.

- **Letterform coverage is gamma-corrected (`INK_GAMMA`).** A cell a stroke only
  half fills scores 0.5 and drew a `;`, and a word built out of `;` does not
  resolve as a word. The curve lifts the middle of the density ramp and leaves
  both ends alone, so the fringe stays soft and the interior stays at `@`. This
  is most of what makes "automations" readable at the new size.

## [1.7.0] - 2026-09-15

### Changed
- **The entrance is a slide now, not a tunnel.** Both front doors (`/portal`
  and `/ops`) used to fly you down a WebGL tunnel on every arrival. It was the
  right amount of spectacle for a thing you see once and the wrong amount for a
  thing you cross several times a session -- and the portal is a place people
  go back and forth from, so it got crossed a lot.

  What replaces it: a sheet the colour of the page slides off to the right in
  760ms, led by a lit orange seam. Behind the seam the sheet frays into
  character cells and comes apart, and what breaks off is left behind as a trail
  of digits that drift back, fall, and burn out -- the same ramp, the same
  accent stops and the same "the wordmark is made of numbers" conceit as the
  character field the door hands off to. The page settles in from the left as
  the seam crosses to the right, so the wipe and the reveal are one movement.

  There is no progress bar, no scroll-to-advance and no skip button, because at
  760ms there is nothing to skip. `prefers-reduced-motion` still bypasses it
  entirely.

### Removed
- **three.js, and the machinery that existed to load it.** The tunnel was the
  only thing in the project using it; the new entrance is one canvas-2d file
  drawing a character grid, which is what the rest of the portal's motion is
  already made of. Knock-on effects:
  - the ~470 kB `HoleTunnel` chunk is gone from the build, along with `three`
    as a dependency;
  - `lib/entrance.js` loses the dynamic import, the stale-deploy chunk retry and
    the eight-second "a slow chunk must not become a locked door" deadline --
    the entrance is now bundled, so there is no fetch that can stall in front of
    it. The two-second safety that drops a veil which never asked to be removed
    stays;
  - the `.ph__veil` placeholder (what you looked at while the tunnel chunk
    downloaded) has nothing left to stand in for.

### Fixed
- **The wordmark's pour is no longer half over before you can see it.** Both
  doors armed the character field on `entered` -- the moment the door *began* to
  open -- so the pour played its first 600ms under an opaque overlay. It is
  armed on `flown` now, the frame the veil actually leaves, and `POUR_LEAD`
  drops from 620ms to 150ms accordingly: just enough to keep the wave clear of
  the wipe's last falling debris.

## [1.6.1] - 2026-09-15

### Changed
- **The wordmark comes back a lot sooner after it is broken.** The quiet time
  before the field gathers itself up was thirty seconds, which was long enough
  that a visitor who brushed past the letters got a pile of sand and a page
  that looked broken -- nothing on screen says the state is temporary, so the
  only way to learn it recovers was to wait half a minute and find out. Six
  seconds now. The gather itself is tightened to match (the wave crosses in
  620ms rather than 900ms, and the flight home is shorter), so it still reads
  as a wave sweeping the field rather than a snap.

  End to end, from the cursor leaving the letters to the wordmark standing
  again: ~7.4s, down from ~32.5s. The clock still restarts on every bond that
  breaks, so this is never a countdown anybody is fighting -- it only begins
  once they have stopped.

## [1.6.0] - 2026-09-14

### Added
- **The portal's wordmark is made of sand.** The character field behind both
  front doors (`/portal` and `/ops`) still says "arc automations" and still
  bulges away from the cursor, but the wordmark is now a few thousand
  independent grains with a life of their own:
  - **it pours in.** The letters assemble out of a wave of falling digits,
    staggered left-to-right across the field, each grain flipping from a number
    to its letter on the frame it lands. Held back until the entrance tunnel
    has actually cleared -- an arrival played under an opaque overlay is an
    arrival nobody sees.
  - **it comes apart.** Running the cursor over the letters breaks the bonds it
    passes through. Loose grains take a kick, fall under gravity, bounce off
    the walls, and pile into a drift along the bottom of the hero that slumps
    when it gets too steep. The drift is kickable too. The old membrane push
    survives as the outer ring of the same model: drift near the letters and
    they bulge, cross them and they break.
  - **it gathers itself back up.** Thirty seconds after the last bond breaks,
    everything still loose is thrown back to its slot in a second wave and the
    wordmark reassembles exactly -- the return is a timed flight, not a spring,
    so every grain lands *on* its cell rather than asymptotically near it.

  The simulation is a new module, `src/portal/lib/sand.js`, with no DOM and no
  React in it. `AsciiField.jsx` keeps what is actually about characters -- the
  glyphs, the palette, and the starfield "room" the wordmark stands in. The two
  meet only through an occupancy grid, which is what now lets the room show
  through the holes as the letters are eroded away.

### Fixed
- The field read its pointer position straight from `clientY`, ignoring that
  the canvas starts below the page's own header, so every interaction was off
  by the height of the bar. It reads the canvas rect now. Invisible when the
  whole wordmark answered to a soft falloff; not invisible now that a radius
  decides what comes apart.
- `AsciiField` rebuilt its entire grid on every `ResizeObserver` callback, even
  when the cell count had not changed. The entrance toggles `body` overflow,
  which moves the scrollbar, which fired one halfway through the arrival; a
  phone's address bar does the same thing on scroll. It now rebuilds only when
  the grid actually changes.

### Changed
- On coarse pointers the field pours and stands but no longer erodes. A scroll
  gesture arrives as a `pointermove` across the hero and used to tear the
  wordmark down on the way past -- leaving sand with no visible cause, since
  the mobile scrim covers the wordmark almost entirely anyway.

## [1.5.4] - 2026-09-13

### Added
- **Booking is wired up (part of S3/pilot flow).** `pilot.booking` now points at
  a real Cal.com event (`provider: 'calcom'`, `embedUrl` set). A completed pilot
  intake now lands on an actual calendar, prefilled with the visitor's name,
  email, and answers, instead of the "pick a provider" placeholder. This was the
  last gap between a filled-out pilot form and a booked call.

## [1.5.3] - 2026-09-13

### Added
- **The pilot form now actually captures leads.** `pilot.captureUrl` was empty
  since 1.5.0, so every completed intake was thrown away. It now points at a
  live n8n webhook (`arc-pilot-intake`) that emails the full submission --
  trade, pain, volume, name, business, email, phone, page and timestamp --
  the moment someone finishes the form. Built and verified end to end: a test
  payload matching the site's exact shape returned HTTP 200 and all three
  workflow nodes reported success.

### Security
- Gitignored `n8n.env`. A file holding a live n8n API key had been dropped into
  `src/portal/n8n.env/` inside this **public** repo. It was still untracked so
  nothing leaked, but a single `git add -A` would have published a credential
  granting full control of the n8n account. Ignored now -- though it should be
  moved out of the repo entirely, and the key rotated if there is any doubt.

## [1.5.2] - 2026-09-11

### Changed
- "What we build with" shows all 18 tools again instead of the 7 core ones
  behind a "the rest of the stack" toggle. The toggle is gone. Core tools (n8n,
  Claude Code, GoHighLevel, Twilio, webhooks, REST APIs, RAG) keep the accent
  style so they still stand out. matter.js still loads lazily, so the 1.5.0
  bundle saving is unaffected.

## [1.5.1] - 2026-09-11

### Changed
- The nine services cut from "what we build" in 1.5.0 are back, behind a
  "see 9 more services" toggle under the three core tabs, so the full menu is
  one click away. Warranty tracker, workflow automations, AI chat bots, websites,
  CRM & data, business process, marketing automation, AI analytics and custom
  SaaS render as normal selectable tabs when it's open. They moved from
  commented-out blocks in `site.js` to a live `site.workflowsMore` array. The
  one-line "we also build..." footnote is gone, since the toggle does its job.
- The workflows CTA opens a tab's own intake when it has one (marketing
  automation), and the generic trade/pain/volume intake otherwise.

## [1.5.0] - 2026-09-09

Phase 1 of the honesty pass (`ARC_FIX_CHECKLIST.md`): the marketing site, the
demo, the client dashboard and the operator console, worked in order of damage.
18 of 21 items. Three are blocked on things no code change can produce — real
n8n screenshots (S1), a domain mailbox (S7), and a Supabase dashboard setting
(O5) — and are listed at the bottom.

### Added
- **Lead capture on the pilot overlay (S2).** A completed intake now POSTs the
  full payload — answers, contact, page, timestamp — to `site.pilot.captureUrl`
  before the visitor reaches the booking step. Fire-and-forget with `keepalive`,
  so a failed capture never blocks anyone and a closed tab still sends. Paste an
  n8n production webhook URL into `captureUrl` and it is live. **Until that
  string is filled in nothing is captured**, and the overlay says so honestly
  rather than claiming a send it did not make.
- **A price on the page (S3).** "flat $1,500 to build it — then $500/mo if it
  earns its keep" now sits under *one pilot, one week*, rendered outside the
  accordion body — a price you have to click to find is the same as no price.
- **Early-data and empty states on every dashboard page (P1A).** `EarlyData` was
  rendered on Overview and nowhere else, so a client on day three clicked Leads,
  Activity, Automations, Reliability and Reports and got five blank screens. It
  now takes per-page copy and appears on all of them, with the tenant's age
  always attached — the fact that turns an empty page from "broken" into "new".
  Two genuinely wrong states went with it: a zero-event tenant was told to
  "clear the search or widen the filters" on a table with nothing behind it, and
  an empty uptime strip rendered as thirty grey cells that read as thirty days
  of outage.
- **Alert write path and operator UI (P2A, Phase 1 half).** `alerts` was the
  only mutable table in the schema, the reliability page rendered incidents from
  it, the support page promised clients "we get paged" — and nothing anywhere
  inserted a row. `raise-alert`, `acknowledge-alert` and `resolve-alert` are now
  actions on the `ops` edge function (service-role, admin-checked, audited),
  with a console page at `/ops/alerts`. **Detection is still not built** — the
  poller that finds a silent tenant is N4 and needs n8n — and the page carries a
  banner saying exactly that rather than implying the monitoring is live.
- **Audit log (O4).** `supabase/migrations/0004_audit_log.sql` adds an
  append-only `admin_actions` table: actor, action, target, metadata, timestamp.
  Written from inside the edge functions rather than the browser, so an action
  cannot succeed and go unlogged; the actor is read from the caller's verified
  token, never from the request body. Append-only is enforced rather than
  promised — there is no update policy and no delete policy for any role, and
  RLS denies by default. Readable at `/ops/audit`.
- **Per-connection staleness thresholds (O3).** `connectionLiveness()` used a
  flat 48 hours for every client. It now derives the threshold from each
  workflow's own observed cadence — twice its p90 quiet stretch, floored at 6h —
  so a restoration client taking four leads a day flags in hours rather than
  days, while a plumber who genuinely sleeps through a weekend does not cry wolf
  every Monday. `expected_quiet_hours` (migration 0005) is the fallback when
  there is too little history to describe a cadence, and the ceiling, so a
  hand-set value always tightens rather than loosens.
- **"Changing the operator email" runbook** in the console, next to "adding
  another operator". The ordered procedure for S7, written down because the
  change looks like editing one string and the wrong order locks the only
  operator out of the only console.

### Changed
- **The demo rebuilds nightly (D1).** `deploy.yml` only ran on push, and the
  demo is generated against `DateTime.now()` at build time — so six days without
  a commit published a demo reading "last check 6 days ago", every automation
  badged `quiet`, and every trend negative. A prospect opening it saw an
  abandoned, declining system. Now on a `0 9 * * *` schedule.
- **The demo trends the right way (D2).** Freshness alone did not fix it: with a
  flat generator the rolling 30-day deltas landed negative on roughly half of
  all possible build dates, and it rebuilds nightly, so "roughly half" means a
  prospect eventually opens it on a bad day. Three changes, each verified by
  simulating **every build date the cron could fire on for the next 70 days**: a
  gentle upward volume drift (~+11% median, deliberately not a hockey stick);
  the missed-call/form channel mix modelled as a stable share of each day rather
  than a per-lead coin flip, which was manufacturing ±10% swings in the headline
  figure that said nothing about the business; and a higher weekend floor plus a
  higher reply rate on missed calls, because at the old volumes *missed-call
  text-back* genuinely went 26 hours quiet every Saturday and *reply capture*
  every Sunday — that yellow badge was correct behaviour reporting a generator
  that understated weekend emergencies. Result across all 70 dates: leads and
  missed-calls deltas non-negative on every one, every automation `healthy`,
  exactly one resolved incident in the window, last check under 5 minutes old.
  `generateDemoData()` now takes an injectable `now`, which is what made any of
  this testable.
- **Overview leads with the number that maps to money (P1D).** The largest
  figure was "leads this month" — a partial month, and a number their CRM
  already tells them. Missed calls answered now leads and carries the hero tone:
  every one is a job that would have gone to voicemail and died. Median response
  stays second, since it is the number the system exists to move.
- **Plain language on the client dashboard (P1C).** `p90 31.1s` → "9 in 10
  answered within 31.1s". `130 sends` → "130 texts sent". "pipeline uptime"
  keeps its name but never appears without the sentence that says what it
  measures — *not "the server is up" — a lead sent right now would have been
  answered* — on Overview and Reports, not only Reliability. The raw event
  strings stay on the Activity run log, which is the raw log and should read
  like one. The new wording lives in `format.js`, so two pages cannot come to
  write the same statistic two different ways.
- **Eleven service tabs cut to three (S4).** Speed-to-lead, missed-call
  text-back, lead qualification. A full-service agency menu from a solo operator
  undercut the "one narrow offer, in production" position the rest of the site
  works to establish. The other eight are commented out in `site.js`, not
  deleted — each comes back the day there is a case study behind it — and
  everything they covered is now one quiet line under the tabs. This exposed a
  bug: every tab's CTA opened the *marketing automation* intake, which asks
  about ad channels and photo libraries. All three now open the generic
  trade/pain/volume intake.
- **Work index trimmed from seven rows to five (S5).** `pale ember espresso` is
  gone — a local-only coffee build means nothing to a restoration contractor —
  and so is `home-service crm`. One row now carries a not-yet-live label instead
  of four; the cumulative read of the old list was "mostly hasn't happened". A
  side effect worth having: S1 is five screenshots now, not seven.
- **Toolkit split by audience (S6).** Seven core chips show by default — n8n,
  Claude Code, GoHighLevel, Twilio, webhooks, REST APIs, RAG — and the rest of
  the stack sits behind a toggle. A restoration owner reading "rapier" and
  "lenis" learns only that somebody likes graphics libraries.
- **The ops door moved out of the primary nav (S10).** It is in the footer now.
  Not a security change — `/ops` is gated on `arc_admins` and RLS, and hiding a
  link has never guarded anything — but a staff entrance advertised on every
  page of a sales site is furniture the customer did not come to look at. The
  nav is down to two actions: portal, and start a pilot.
- **The contact address is read from `site.js` everywhere.** `Login.jsx` and
  `Portal.jsx` had the gmail address hardcoded in three `mailto:` links, so S7
  would have left them pointing at the old inbox. `grep -rn "gmail" src/` is now
  the two lines in `site.js` itself.
- **`ASSETS.md` rewritten.** It listed files nothing references any more
  (`rue-noir-01..04.jpg`, stats that no longer exist on the page). Only
  `WorkGrid` renders slots, so the manifest is now exactly the five files the
  site is actually waiting on, plus the console check to verify it.
- **School line removed from the footer (S8).** Landed in 1.4.5; recorded here
  as the deliberate call the checklist asked for. It is a positioning decision,
  not an honesty one — nobody is owed an enrollment status in an agency footer,
  and it belongs on a personal page if anywhere.

### Fixed
- **Physics engine off the marketing critical path (S9).** `matter-js` — a full
  2D physics engine, loaded for a decorative chip effect — was in the initial
  bundle on a site contractors open on phones on bad service. It is now a
  dynamic import that fires only when the toolkit scrolls into view, on a device
  that is not mobile, not reduced-motion, and not asking for data saver.
  **Initial JS: 804.87 kB → 719.87 kB raw, 257.65 kB → 230.17 kB gzipped**
  (−85 kB / −27.5 kB, −10.7%). The engine is an 85.96 kB chunk fetched on
  demand, or never.
- **"Direct booking is being wired up" is gone (S2).** An automation company
  telling a prospect its own booking is not wired up is self-refuting copy, and
  the `mailto:` behind it did nothing for anyone reading webmail in a browser —
  which is most contractors on a phone.
- **Tables restack as cards under 720px (P1B).** `overflow-x: auto` was the
  entire mobile strategy and the leads table has seven columns. Leads is the
  page a contractor actually opens, and they open it from a truck. Rows are now
  cards — customer and phone as the heading, source and loss type as a subline,
  response, outcome and tech as a footer — each value carrying its own label,
  since the header row is hidden once the table is unstacked. Same treatment for
  the ops clients table.
- **Expandable rows look expandable (P1E).** The per-lead timeline is the most
  persuasive thing in the product and the only affordance was a chevron painted
  in `--faint`, the colour this system uses for text nobody needs to read. The
  chevron is `--muted` now, the row has a pointer cursor and a left accent rule
  on hover, and a one-line hint sits above the table until a row has been opened
  once.

### Still open — nothing in this repo can close these
- **S1:** the five n8n canvas screenshots. See `ASSETS.md`. Until they exist,
  `document.querySelectorAll('.slot').length` is 5, not 0.
- **S7:** register the domain mailbox, create the Supabase auth user, add it to
  `arc_admins`, verify sign-in, *then* edit `site.js`. Runbook in the console.
- **O5:** enable MFA on the Supabase account.
- **Migrations 0004 and 0005** need applying before `/ops/audit` and the derived
  staleness thresholds do anything. Both are safe to run on an existing project.

## [1.4.5] - 2026-09-09

### Changed
- Nav wordmark reads "arc" instead of "ben" — the site is Arc Automations
  branding now, not a personal mark.
- Removed the footer meta bar entirely (`ben* — arc automations`, the
  university/AI-minor line, `northern utah, mst`, and the copyright line) —
  personal-brand and school copy that didn't belong on a business site.

## [1.4.4] - 2026-09-08

### Security
- Removed the magic-link fallback from `/ops`. It needed no password to fire —
  any visitor could trigger a real sign-in email with no credentials at all —
  and the "not you? sign in as someone else" toggle added in 1.4.2 made it
  worse by pre-filling that action's target with the primary operator's real
  address the instant the toggle was clicked, before any login. Both are gone:
  the toggle now reveals a blank field, and there is no email-sending code path
  left anywhere on the page.
- A wrong password now shows one flat message ("that password is wrong.") and
  stops — no navigation, no email, no further page. Recovering a forgotten or
  never-set password happens directly in Supabase (authentication → users),
  documented in the console's "adding another operator" panel and in
  OperatorAccount's own copy.

## [1.4.3] - 2026-09-08

### Added
- "Adding another operator" — a closed-by-default reference panel on the
  console's Supabase page (`Disclosure` in `ops-ui.jsx`), spelling out the
  4-step procedure end to end: create their auth user, confirm migration 0003
  is applied, add them to `arc_admins`, sign in as them at `/ops`.

### Fixed
- The `/ops` door authenticated against a fixed address (`site.opsEmail`) no
  matter who was added to `arc_admins` — a second operator could be granted
  access and still never get past the door. Added a "not you? sign in as
  someone else" toggle that reveals an email field, so any admin can sign in
  as themselves; the single-field fast path stays the default.

## [1.4.2] - 2026-09-08

### Changed
- The operator door at `/ops` is now a single password field. The account the
  password belongs to is a constant (`site.opsEmail`) rather than an input —
  there is one operator, and the address is already public in the footer and
  every mailto on the site, so it was never acting as a second factor.
- The magic-link fallback is one click instead of a second form, since there is
  no longer an address to type into it.

## [1.4.1] - 2026-09-08

### Added
- Password sign-in for the operator console at `/ops` — email and password via
  `signInWithPassword`, with the magic link kept as the first-time and
  forgotten-password path.
- "Your operator account" panel on the console's Supabase page, for setting
  that password without touching the Supabase dashboard.

### Security
- The password is a real Supabase auth credential, set on the auth user and
  hashed server-side. It is deliberately **not** in this repository: the site
  is a static bundle served from a public repo, so a password compared in
  front-end code would be a published one — and it would protect nothing
  anyway, since `arc_admins` plus row level security are what actually empty
  the console for a non-admin.

## [1.4.0] - 2026-09-08

Client IDs replace email sign-in, and the operator console arrives alongside
the portal workspace rearchitecture.

### Changed
- Rebuilt the signed-in dashboard around a shared `Workspace` shell
  (`Sidebar`, `Topbar`, `CommandPalette`) instead of a single
  `Dashboard`/`Metrics` pair; the eight dashboard pages now live under
  `src/portal/pages/dash/`.
- Reworked the portal data layer: `derive.js` and `dashboard-data.js` now sit
  between `metrics.js` and the pages, with `nav.js` as the single source of
  truth for sidebar, topbar, and command-palette entries.
- Routed the dashboard and demo bundle through `src/lib/lazyRoute.jsx` so the
  marketing site no longer loads them.
- Extracted the portal entrance into `lib/entrance.js` so `/portal` and `/ops`
  share one transition rather than two copies of it.
- Generalised `Sidebar`, `Topbar` and `CommandPalette` over a nav declaration
  and a record set, so the console renders the same shell as the client
  workspace instead of growing its own.
- `/auth/callback` now resolves where to land: an explicit `?next=`, a
  remembered destination, then an admin check — so an operator is not dropped
  on "no portal linked yet".

### Added
- **Client IDs.** Clients sign in at `/login` with an `ARC-XXXX-XXXX` ID
  instead of an email address. Resolution from ID to mailbox happens in the
  `client-login` edge function under the service role, so the browser is never
  handed an address — only a masked hint. Crockford base32 minus I, L, O and U;
  40 bits, generated with `crypto.getRandomValues`.
- **The operator console** at `/ops` (door) and `/ops/console` (workspace) —
  eight pages behind an `arc_admins` check in Postgres: roster, clients, client
  detail, add-a-client, client IDs, connections & servers, a live Supabase
  probe, and a cross-client activity log.
- Per-client detail: identity and reissue, an editable account row, the
  client's own dashboard figures, declared connections checked against the
  event log, ingest-token minting, and their activity feed.
- `connections` table and registry — what each client is wired to (n8n,
  Twilio, GHL, webhooks), with declared status shown beside observed liveness
  matched on `workflow_id`.
- `ops` edge function: invites a client's address into auth and links it to a
  tenant, the one step that cannot run in the browser.
- Migration `0003_client_ids_and_ops.sql`: `client_id` and contact columns on
  `tenants`, `arc_admins`, `is_arc_admin()`, `gen_client_id()`, an `archived`
  status, and admin policies layered onto the existing per-tenant ones.
- A small `ops` chip in the site nav, left of the portal button.
- Command palette (⌘K) for jumping between dashboard pages.
- CSV export (`src/portal/lib/csv.js`) and a per-source unit breakdown
  (`SourceUnits.jsx`).
- Hour-of-day activity chart (`HourChart.jsx`) and an uptime strip
  (`UptimeStrip.jsx`).

## [1.3.2] - 2026-09-07

### Changed
- Sped up the portal entrance animation further.

## [1.3.1] - 2026-09-07

### Changed
- Reordered the "our specialty" and "five things we shipped" homepage
  sections.
- Removed the self-taught/receipts section from the homepage.

## [1.3.0] - 2026-09-06

### Added
- Client portal: magic-link auth, tenant dashboard, n8n event ingest.
- WebGL tunnel entrance animation for the portal front door at `/portal`.
- Animated glow nav buttons and a portal link in the site nav.

### Changed
- Drove the entrance on elapsed time instead of frame count, then tuned it to
  be steadier, more cinematic, and faster.

### Fixed
- Entrance overlay could outlive itself.
- A negative first frame drove the entrance scale to NaN, causing a black
  screen.

## [1.2.0] - 2026-08-13

### Changed
- Replaced the Embertithe portfolio card (which had replaced the YouTube
  card) with a home-service CRM card and an animated missed-call
  text-back demo.

## [1.1.0] - 2026-08-12

### Changed
- Rebuilt the workflows section as a full offering list with per-tab
  descriptions, renamed to "our specialty."
- Presets the marketing-automation pilot flow from the workflows CTA and
  adds a website field.
- Pointed the rue noir card at its live site with an accessible visit
  button, and linked it to its GitHub repo.

## [1.0.0] - 2026-08-12

### Added
- Initial commit: portfolio site deployed to GitHub Pages via Actions.

[Unreleased]: https://github.com/bennettc1213/Arc-Automations/compare/a63ad8a...HEAD
[1.4.5]: https://github.com/bennettc1213/Arc-Automations/compare/a63ad8a...HEAD
[1.4.4]: https://github.com/bennettc1213/Arc-Automations/compare/a3d6e43...a63ad8a
[1.4.3]: https://github.com/bennettc1213/Arc-Automations/compare/59f982c...a3d6e43
[1.4.2]: https://github.com/bennettc1213/Arc-Automations/compare/d2db0cc...59f982c
[1.4.1]: https://github.com/bennettc1213/Arc-Automations/compare/a3b23eb...d2db0cc
[1.4.0]: https://github.com/bennettc1213/Arc-Automations/compare/21bb26b...HEAD
[1.3.2]: https://github.com/bennettc1213/Arc-Automations/commit/21bb26b
[1.3.1]: https://github.com/bennettc1213/Arc-Automations/compare/4ff072f...7437bb8
[1.3.0]: https://github.com/bennettc1213/Arc-Automations/compare/3e61cd8...4ff072f
[1.2.0]: https://github.com/bennettc1213/Arc-Automations/compare/386398e...3e61cd8
[1.1.0]: https://github.com/bennettc1213/Arc-Automations/compare/4d55b04...386398e
[1.0.0]: https://github.com/bennettc1213/Arc-Automations/commit/4d55b04
