# Koi Pond

An interactive Japanese koi pond for the browser, built for iPhone Safari. Touch the water.

**Live:** https://koi-pond-theta.vercel.app

- **Tap** for a ripple, **drag** to stir, **hold** to keep pressing the surface.
- **Feed** button scatters pellets; the koi come and eat them.
- **Pause** stops the simulation entirely (it also stops when the tab is in the background).

## How it works

- `pond.js`: the simulation, no DOM. A 2D wave equation on a grid (isotropic 9-point Laplacian, damping and viscosity, reflecting walls) with rocks that pin the surface, so ripples bounce off them. Koi swim in bursts of tail beats and glides, drift between cruising, dawdling and hovering low, loosely school, steer around walls and rocks, whip into a C-start when startled, and come for food. Pads, leaves and pellets ride the waves.
- `index.html`: WebGL2 renderer. The bed (sand, gravel, pebbles, sunken leaves, boulders) is baked once; each frame it is lit by caustics that the real ripples focus, under dappled shade from an overhanging maple whose shadows shift with depth. Koi are drawn with scales, gill covers, eyes, translucent fins and lighting that follows their turns. The surface pass refracts all of that by the local water depth, reflects the canopy, and adds wind chop and sun glints. Resolution drops automatically if frames run slow.

No build step and no dependencies. To run it locally, serve the folder (`python3 -m http.server`) and open it.

```
node --test pond.test.mjs
```
