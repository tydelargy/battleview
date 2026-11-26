// A cute biome for a repo's plot of land, from a hash of "org/name": the same repo always grows the same hill. Pure.
import { hash } from './layout.js';
import { draw } from './building.js';

export const BIOMES = {
  meadow:  { label: 'Meadow',   ground: '#5d9b4a', rim: '#3f7a3a', accent: '#f2d65c', props: ['tree', 'bush', 'flower'] },
  forest:  { label: 'Forest',   ground: '#2f7a46', rim: '#1f5a34', accent: '#7fd18b', props: ['pine', 'pine', 'bush'] },
  desert:  { label: 'Desert',   ground: '#d6b36a', rim: '#b08a46', accent: '#e8734a', props: ['cactus', 'rock', 'dune'] },
  tundra:  { label: 'Tundra',   ground: '#dbe7ee', rim: '#a9bfcc', accent: '#7fb4d6', props: ['pine', 'rock', 'dune'] },
  volcano: { label: 'Volcanic', ground: '#4b4247', rim: '#2e272b', accent: '#ff7a3d', props: ['rock', 'lava', 'rock'] },
  savanna: { label: 'Savanna',  ground: '#b5a54a', rim: '#8a7c33', accent: '#e0a03a', props: ['tree', 'bush', 'rock'] },
  marsh:   { label: 'Marsh',    ground: '#5f8a6e', rim: '#3d6350', accent: '#9fd4c0', props: ['reed', 'bush', 'reed'] },
  alpine:  { label: 'Alpine',   ground: '#8a95a1', rim: '#5d6772', accent: '#e8eef2', props: ['pine', 'rock', 'rock'] },
};
export const BIOME_NAMES = Object.keys(BIOMES);

/** Props sit on the ring between the city and the edge of the hex (fractions of the hex radius), never under the buildings. */
export const PROP_RING = { inner: 0.62, outer: 0.92 };

/** Everything the world view needs to dress one plot. `key` is the repo's "org/name" (with its host, if it is not github.com). */
export function biomeFor(key) {
  const h = hash(String(key).toLowerCase()), r = (k) => draw(h, k);
  const name = BIOME_NAMES[Math.floor(r(1) * BIOME_NAMES.length)], b = BIOMES[name];
  const hill = { height: 0.5 + r(2) * 0.9, bulge: 0.12 + r(3) * 0.16 };      // how tall the plot stands, and how much it swells towards the middle
  const count = 7 + Math.floor(r(4) * 9), props = [];
  for (let i = 0; i < count; i++) {
    const ang = r(10 + i * 3) * Math.PI * 2, rad = PROP_RING.inner + r(11 + i * 3) * (PROP_RING.outer - PROP_RING.inner);
    props.push({ type: b.props[Math.floor(r(12 + i * 3) * b.props.length)], x: Math.cos(ang) * rad, z: Math.sin(ang) * rad, scale: 0.7 + r(80 + i) * 0.7, turn: r(120 + i) * Math.PI * 2 });
  }
  return { key, name, label: b.label, ground: b.ground, rim: b.rim, accent: b.accent, hill, props, seed: h };
}
