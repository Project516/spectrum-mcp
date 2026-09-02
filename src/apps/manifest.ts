// A manifest is the whole difference between the SpectrumStrategy deployment
// and the SpectrumPit one: which Firestore collections the tools may touch and
// what each holds. Access is still decided by `firestore.rules` at request
// time; the manifest only bounds the surface and gives the model a map.
export interface CollectionSpec {
  name: string;
  description: string;
  // Writable collections are reachable from create/update/delete tools. A
  // false here is a product decision (agents have no business writing this),
  // not a security control -- rules are the control.
  writable: boolean;
}

export interface AppManifest {
  key: string;
  title: string;
  instructions: string;
  collections: CollectionSpec[];
}

export function collectionSpec(
  manifest: AppManifest,
  name: string,
): CollectionSpec | undefined {
  return manifest.collections.find((c) => c.name === name);
}
