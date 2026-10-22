/*
 * elips — Editor de LIcitacions PúbliqueS
 * Copyright (C) 2026  Francesc Rambla i Marigot
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const storage = new Map();
    globalThis.localStorage = {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, val) => storage.set(key, String(val)),
      removeItem: (key) => storage.delete(key),
      clear: () => storage.clear(),
    };
  }
  globalThis.localStorage.clear();
});

import {
  getOrCreateUserId,
  getDisplayName,
  setDisplayName,
  getDisplayNameOrFallback,
} from '../src/composables/useCollabIdentity.js';

describe('useCollabIdentity', () => {
  it('getOrCreateUserId generates a stable id persisted across calls', () => {
    const id1 = getOrCreateUserId();
    const id2 = getOrCreateUserId();
    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThan(0);
  });

  it('getDisplayName is empty until explicitly set', () => {
    expect(getDisplayName()).toBe('');
    setDisplayName('Marta');
    expect(getDisplayName()).toBe('Marta');
  });

  it('setDisplayName trims whitespace and clears on empty input', () => {
    setDisplayName('  Jordi  ');
    expect(getDisplayName()).toBe('Jordi');
    setDisplayName('   ');
    expect(getDisplayName()).toBe('');
  });

  it('getDisplayNameOrFallback never returns an empty string', () => {
    expect(getDisplayNameOrFallback()).toMatch(/^Usuari /);
    setDisplayName('Anna');
    expect(getDisplayNameOrFallback()).toBe('Anna');
  });
});
