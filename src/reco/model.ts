/**
 * Online logistic regression with per-feature adaptive learning rates.
 *
 * Why this and not something fancier: a contextual bandit with Thompson sampling
 * is the textbook answer for explore/exploit, but it needs far more data than one
 * person listening to music will ever produce. At a few hundred plays the posterior
 * variance swamps the signal, and the sampler becomes the thing you debug instead
 * of the features. AdaGrad logistic regression learns from a single example, needs
 * no batch step, and stays inspectable — which is what lets the UI answer "why was
 * I served this?".
 *
 * It is still strictly stronger than the affinity counters most simple players use:
 * counters are the degenerate case where the feature vector is a one-hot genre and
 * no credit is shared between correlated tags.
 *
 * Cost per update is proportional to the number of non-zero features — typically
 * 10-25 multiply-adds — so it is effectively free even on watch hardware.
 */

import { FEATURE_DIM, unitFeature, seedFeatureKey, type SparseVec } from './features.ts';
import type { PlayEvent } from '../types.ts';

export const MODEL_VERSION = 2;

/**
 * Weights are stored as base64 of the raw float bytes rather than as a JSON
 * array of numbers.
 *
 * The array form was about forty kilobytes of text that had to be parsed into
 * four thousand numbers and then copied into typed arrays, every launch. The
 * bytes are eight kilobytes, and decoding them is a loop over a string. On a
 * watch that difference is felt at startup.
 */
function encodeFloats(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function decodeFloats(encoded: string, length: number): Float32Array | null {
  try {
    const binary = atob(encoded);
    if (binary.length !== length * 4) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  } catch {
    return null;
  }
}

export interface ModelSnapshot {
  version: number;
  /** Learned weights, one per hashed feature slot. */
  w: Float32Array;
  /** AdaGrad accumulator of squared gradients. */
  accum: Float32Array;
  /** Number of training updates applied. Drives exploration decay. */
  n: number;
}

export interface Label {
  /** 1 = positive, 0 = negative. */
  y: number;
  /** Importance of this example. 0 means "do not train on this". */
  weight: number;
}

const LEARNING_RATE = 0.25;
const L2 = 1e-5;
const EPSILON = 1e-8;

/** Below this fraction a skip is more likely a mis-tap than a judgement. */
const MISTAP_FRACTION = 0.03;
const MISTAP_WEIGHT = 0.3;
/** At or above this fraction, the track effectively finished. */
const COMPLETION_FRACTION = 0.9;

export function sigmoid(z: number): number {
  // Branch to avoid overflow in Math.exp for large |z|.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Converts an observed play into a training label.
 *
 * The important part is that a skip is not binary. Abandoning a track three
 * seconds in and abandoning it at the 85% mark are close to opposite signals, so
 * the negative is weighted by how much was left unplayed.
 */
export function labelFor(event: PlayEvent): Label {
  const f = clamp01(event.playedFraction);

  switch (event.outcome) {
    case 'liked':
      return { y: 1, weight: 3 };
    case 'disliked':
      return { y: 0, weight: 3 };
    case 'replayed':
      return { y: 1, weight: 2 };
    case 'completed':
      return { y: 1, weight: 1 };
    case 'error':
      // A dead stream says nothing about taste.
      return { y: 0, weight: 0 };
    case 'skipped': {
      if (f >= COMPLETION_FRACTION) return { y: 1, weight: 1 };
      if (f < MISTAP_FRACTION) return { y: 0, weight: MISTAP_WEIGHT };
      return { y: 0, weight: 1 - f };
    }
    default:
      return { y: 0, weight: 0 };
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class TasteModel {
  private w: Float32Array;
  private accum: Float32Array;
  private updates: number;

  constructor(snapshot?: ModelSnapshot) {
    if (snapshot && snapshot.version === MODEL_VERSION && snapshot.w.length === FEATURE_DIM) {
      this.w = snapshot.w;
      this.accum = snapshot.accum;
      this.updates = snapshot.n;
    } else {
      this.w = new Float32Array(FEATURE_DIM);
      this.accum = new Float32Array(FEATURE_DIM);
      this.updates = 0;
    }
  }

  get n(): number {
    return this.updates;
  }

  /** Raw linear score. Useful for ranking, where the sigmoid is monotonic anyway. */
  private dot(x: SparseVec): number {
    let z = 0;
    for (let i = 0; i < x.idx.length; i++) {
      z += this.w[x.idx[i]!]! * x.val[i]!;
    }
    return z;
  }

  /** Predicted probability the user will like this, 0..1. */
  score(x: SparseVec): number {
    return sigmoid(this.dot(x));
  }

  /** Learned weight for one hashed feature slot, for the "why this track" view. */
  weightAt(index: number): number {
    return this.w[index] ?? 0;
  }

  /** One gradient step. Touches only the non-zero features. */
  update(x: SparseVec, label: Label): void {
    if (label.weight <= 0) return;

    const p = sigmoid(this.dot(x));
    const err = (p - label.y) * label.weight;

    for (let i = 0; i < x.idx.length; i++) {
      const j = x.idx[i]!;
      const g = err * x.val[i]! + L2 * this.w[j]!;
      this.accum[j] = this.accum[j]! + g * g;
      this.w[j] = this.w[j]! - (LEARNING_RATE * g) / (Math.sqrt(this.accum[j]!) + EPSILON);
    }

    this.updates++;
  }

  /**
   * Cold start by data augmentation.
   *
   * Rather than starting from a zero vector and waiting for real plays, the genres
   * and artists the user picked up front are injected as synthetic positive
   * observations. This is a Bayesian prior expressed as pseudo-data, and it is the
   * difference between a first session that feels personalized and one that feels
   * random. The low weight means a handful of real plays will override it.
   */
  seed(tags: string[], artists: string[], repeats = 4, weight = 0.5): void {
    const keys = [
      ...tags.map((t) => seedFeatureKey('tag', t)),
      ...artists.map((a) => seedFeatureKey('artist', a)),
    ];
    for (let r = 0; r < repeats; r++) {
      for (const key of keys) {
        this.update(unitFeature(key), { y: 1, weight });
      }
    }
    // Seeding is not evidence of engagement, so it must not age the explore rate.
    this.updates = 0;
  }

  /**
   * Inspect which features drove a score, so the UI can explain a recommendation.
   * Returns contributions sorted by absolute influence.
   */
  explain(x: SparseVec, keyForIndex: (i: number) => string | undefined): Array<{ feature: string; contribution: number }> {
    const out: Array<{ feature: string; contribution: number }> = [];
    for (let i = 0; i < x.idx.length; i++) {
      const j = x.idx[i]!;
      const name = keyForIndex(j);
      if (!name) continue;
      out.push({ feature: name, contribution: this.w[j]! * x.val[i]! });
    }
    out.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    return out;
  }

  snapshot(): ModelSnapshot {
    return { version: MODEL_VERSION, w: this.w, accum: this.accum, n: this.updates };
  }

  /** Plain-array form for the localStorage mirror, where typed arrays don't survive. */
  toJSON(): { version: number; w: string; accum: string; n: number } {
    return {
      version: MODEL_VERSION,
      w: encodeFloats(this.w),
      accum: encodeFloats(this.accum),
      n: this.updates,
    };
  }

  static fromJSON(raw: unknown): TasteModel | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as { version?: number; w?: unknown; accum?: unknown; n?: number };
    const n = typeof o.n === 'number' ? o.n : 0;

    if (o.version === MODEL_VERSION && typeof o.w === 'string' && typeof o.accum === 'string') {
      const w = decodeFloats(o.w, FEATURE_DIM);
      const accum = decodeFloats(o.accum, FEATURE_DIM);
      if (!w || !accum) return null;
      return new TasteModel({ version: MODEL_VERSION, w, accum, n });
    }

    // Version 1 kept plain arrays. Read them so nothing already learned is
    // thrown away; it is written back in the compact form on the next save.
    if (o.version === 1 && Array.isArray(o.w) && Array.isArray(o.accum)) {
      if (o.w.length !== FEATURE_DIM || o.accum.length !== FEATURE_DIM) return null;
      return new TasteModel({
        version: MODEL_VERSION,
        w: Float32Array.from(o.w as number[]),
        accum: Float32Array.from(o.accum as number[]),
        n,
      });
    }
    return null;
  }
}
