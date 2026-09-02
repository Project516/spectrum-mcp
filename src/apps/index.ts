import type { AppManifest } from './manifest.js';
import { pitManifest } from './pit.js';
import { strategyManifest } from './strategy.js';

const MANIFESTS: Record<string, AppManifest> = {
  strategy: strategyManifest,
  pit: pitManifest,
};

export function manifestFor(app: string): AppManifest {
  const manifest = MANIFESTS[app];
  if (!manifest) throw new Error(`unknown APP binding: ${app}`);
  return manifest;
}

export type { AppManifest, CollectionSpec } from './manifest.js';
export { collectionSpec } from './manifest.js';
