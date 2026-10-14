# Koi Pond

An interactive Japanese koi pond for the browser, built for iPhone Safari. Touch the water.

- **Tap** for a ripple, **drag** to stir, **hold** to keep pressing the surface.
- **Feed** button scatters pellets; the koi come and eat them.
- **Pause** stops the simulation entirely (it also stops when the tab is in the background).

## How it works

- `pond.js`: the simulation, no DOM. A 2D wave equation on a grid (isotropic 9-point Laplacian, damping and viscosity, reflecting walls), koi steering (wander, wall avoidance, spacing, startle, food, surfacing), and floating pads, leaves and food pushed around by the waves.
- `index.html`: WebGL2 renderer. The pond floor and the koi are drawn underwater with caustics that the real ripples focus. The surface pass then refracts that image, reflects an overhanging maple canopy, and adds sun glints. Resolution drops automatically if frames run slow.

No build step and no dependencies. To run it locally, serve the folder (`python3 -m http.server`) and open it.

```
node --test pond.test.mjs
```
