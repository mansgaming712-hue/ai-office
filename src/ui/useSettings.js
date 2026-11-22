import { useSyncExternalStore } from 'react';
import { settingsStore } from '../settings.js';

/** Pengaturan aktif (komponen dirender ulang saat berubah). */
export function useSettings(store = settingsStore) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
