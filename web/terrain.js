// Where things may stand on a plot of land, as rules rather than guesses. Pure.
//
// A plot is a hexagonal hill: a thin rim, a sloping skirt, and a gentle swell on top (web/world.js draws exactly these
// numbers). A hexagon is not a circle, so distance from the middle is measured the way the hexagon measures it
// (`hexNorm`: 1 at the corners, and the edges are closer in). Everything below is in units of the hex's circumradius S.

export const PLOT = { rim: 0.99, rimH: 0.6, skirtBottom: 0.96, skirtTop: 0.86, capBottom: 0.84, capTop: 0.7 };

/** Distance from the middle in a pointy-top hexagon's own measure: 1 on the boundary of a hex of circumradius 1. */
export const hexNorm = (x, z) => Math.max((2 * Math.abs(x)) / Math.sqrt(3), Math.abs(x) / Math.sqrt(3) + Math.abs(z));

/** The plot's heights for one city: `base` where the skirt meets the swell, `top` the flat summit. `hill` and `bulge` come from the biome. */
export function plotGeometry(S, biome) {
  const base = PLOT.rimH + biome.hill.height * S * 0.12, swell = biome.hill.bulge * S * 0.5;
  return { S, base, swell, top: base + swell };
}

/** Height of the ground at hex-distance `n` (in S units) from the middle. Beyond the rim there is none (-Infinity). */
export function surfaceHeight(n, g) {
  const P = PLOT;
  if (n <= P.capTop) return g.top;
  if (n <= P.capBottom) return g.top - (g.swell * (n - P.capTop)) / (P.capBottom - P.capTop);
  if (n <= P.skirtTop) return g.base;
  if (n <= P.skirtBottom) return g.base - ((g.base - P.rimH) * (n - P.skirtTop)) / (P.skirtBottom - P.skirtTop);
  if (n <= P.rim) return P.rimH;
  return -Infinity;
}

/**
 * A city stands on the flat summit, all of it. Given the city's boxes' footprint (half the width and depth, in the city's own
 * units) this is the scale that puts its farthest corner at 90% of the summit's reach, so nothing overhangs the slope.
 * Result is in S units per city unit.
 */
export function cityScale(halfW, halfD, margin = 0.9) {
  const corner = hexNorm(halfW, halfD) || 1e-9;
  return (PLOT.capTop * margin) / corner;
}

// How a prop sits on the ground. `half` is half its height as drawn at scale 1 (its middle sits that far above its feet),
// `sink` the fraction that is pressed into the ground so it never hovers, and `reach` its radius, kept inside the hexagon.
export const PROP_FIT = {
  pine: { half: 0.75, sink: 0.05, reach: 0.5 }, tree: { half: 0.62, sink: 0.12, reach: 0.62 }, bush: { half: 0.4, sink: 0.15, reach: 0.4 },
  flower: { half: 0.25, sink: 0.1, reach: 0.12 }, cactus: { half: 0.6, sink: 0.05, reach: 0.24 }, rock: { half: 0.5, sink: 0.3, reach: 0.5 },
  dune: { half: 0.36, sink: 0.25, reach: 0.8 }, lava: { half: 0.4, sink: 0.1, reach: 0.28 }, reed: { half: 0.55, sink: 0.05, reach: 0.06 },
};
/** Props live on the ring between the city's summit and the rim: hex-distance from here to here (S units), reach included. */
export const PROP_BAND = { inner: 0.74, outer: 0.9 };

/**
 * Turn a biome's props (points on a circle, radial fraction in `ring`) into places on the hexagon: moved onto the band the
 * hexagon allows, lowered onto the actual slope, and kept whole inside the rim. Returns {type, x, z, y, scale, turn} with
 * x and z in S units from the middle and y the height of the prop's middle in world units.
 */
export function placeProps(props, g, ring = { inner: 0.62, outer: 0.92 }) {
  const out = [];
  for (const p of props) {
    const fit = PROP_FIT[p.type]; if (!fit) continue;
    const ang = Math.atan2(p.z, p.x), ux = Math.cos(ang), uz = Math.sin(ang), unit = hexNorm(ux, uz);
    const radial = (Math.hypot(p.x, p.z) - ring.inner) / (ring.outer - ring.inner), reach = (fit.reach * p.scale * 0.9) / g.S;
    const fitReach = Math.min(reach, (PROP_BAND.outer - PROP_BAND.inner) / 2);        // a prop wider than the band (a big dune) is centred in it and may spill a little onto the skirt
    const lo = PROP_BAND.inner + fitReach, hi = PROP_BAND.outer - fitReach;
    const n = lo + Math.min(1, Math.max(0, radial)) * (hi - lo), t = n / unit;
    const x = ux * t, z = uz * t, ground = surfaceHeight(n, g), sc = p.scale * 0.9 * (p.type === 'dune' ? 1.3 : 1);
    out.push({ type: p.type, x, z, y: ground + fit.half * sc * (1 - 2 * fit.sink), scale: sc, turn: p.turn, n, ground, reach: reach });
  }
  return out;
}
