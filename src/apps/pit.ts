import type { AppManifest } from './manifest.js';

// SpectrumPit is a separate Firebase project (`spectrumpit`) with its own
// rules and its own roles; only the manifest and the deployment vars differ.
export const pitManifest: AppManifest = {
  key: 'pit',
  title: 'Spectrum Pit',
  instructions: [
    'This server exposes the Spectrum Pit inventory and logistics database for',
    'FRC team 3847. You act as the signed-in user: you can only read and change',
    'what that person could in the app, and Firestore security rules enforce it.',
    'A refusal means their role does not allow it, not that the call was malformed.',
  ].join(' '),
  collections: [
    {
      name: 'inventoryItems',
      description: 'Every tracked item in the pit and the shop: what it is, where it lives, how many.',
      writable: true,
    },
    {
      name: 'borrowRecords',
      description: 'Who took what out of the pit and whether it came back.',
      writable: true,
    },
    {
      name: 'packingRecords',
      description: 'Packing lists and their check-off state for an event.',
      writable: true,
    },
    {
      name: 'mapLocations',
      description: 'Named storage locations an inventory item can sit in.',
      writable: true,
    },
    {
      name: 'mapDiagrams',
      description: 'Pit and shop layout diagrams the locations are placed on.',
      writable: false,
    },
    {
      name: 'containerPhotos',
      description: 'Photos of containers, used to find something without opening every bin.',
      writable: false,
    },
    {
      name: 'pitShifts',
      description: 'Who is staffing the pit and when.',
      writable: false,
    },
    {
      name: 'appConfig',
      description: 'App-wide configuration documents, including the active event.',
      writable: true,
    },
    {
      name: 'userProfiles',
      description: 'Team members and their roles.',
      writable: false,
    },
  ],
};
