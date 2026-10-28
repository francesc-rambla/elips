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

/**
 * Fase 13 del pla "Alternativa complementària: sessió en viu amb WebRTC +
 * Yjs": "els dos transports (carpeta OneDrive i sessió en viu WebRTC)
 * connectats alhora al mateix projecte -- no se suposa segur, cal un test
 * explícit". A diferència de la resta de tests d'aquest motor de sessió en
 * viu (collab_realtime.test.js), aquí es fa servir el motor REAL de la
 * carpeta (useCollabSync.js, amb una carpeta falsa en memòria, mateix
 * patró que collab_sync.test.js) en lloc d'un simulacre simplificat --
 * ambdós transports, codi de producció real, observant el mateix camp
 * `store.excelJsonData`/`store.editorMetadata` d'un únic Pinia store real,
 * cadascun amb la seva pròpia bandera `isApplyingRemote`/`applyingRemote`
 * interna (mai compartida entre tots dos).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import * as Y from 'yjs';

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
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

import { useWorkspaceStore } from '../src/stores/workspace.js';
import { useCollabSync } from '../src/composables/useCollabSync.js';
import { attachJsonChannelBridge } from '../src/composables/useCollabRealtime.js';
import { computeDataPatch } from '../src/utils/dataPatch.js';

/** Minimal in-memory stand-in for useCollabFolder.js's returned API -- same
 * helper as tests/collab_sync.test.js (kept self-contained per file, same
 * convention already used there). */
function makeFakeCollabFolder() {
  const files = new Map();
  return {
    async readTextFile(name) {
      return files.has(name) ? files.get(name) : null;
    },
    async readJsonFile(name) {
      const text = files.has(name) ? files.get(name) : null;
      return text === null ? null : JSON.parse(text);
    },
    async writeJsonFile(name, obj) {
      files.set(name, JSON.stringify(obj));
    },
    async appendLinesToFile(name, entries) {
      const addition = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      files.set(name, (files.get(name) || '') + addition);
    },
    async writeTextFile(name, text) {
      files.set(name, text);
    },
    async writeBinaryFile(name, blob) {
      files.set(name, blob);
    },
    async listDeltaFileUserIds(prefix = '') {
      const re = prefix
        ? new RegExp(`^collab_deltas_${prefix}_(.+)\\.jsonl$`)
        : /^collab_deltas_(?!(?:schema|template)_)(.+)\.jsonl$/;
      const ids = [];
      for (const name of files.keys()) {
        const m = re.exec(name);
        if (m) ids.push(m[1]);
      }
      return ids;
    },
    async listPresenceFileUserIds() {
      return [];
    },
    _files: files,
  };
}

function readDeltaEntries(fakeFolder, userId) {
  const text = fakeFolder._files.get(`collab_deltas_${userId}.jsonl`) || '';
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('dual transport (Fase 13, motors reals): carpeta OneDrive (useCollabSync.js) + sessió en viu WebRTC (attachJsonChannelBridge) connectades alhora', () => {
  it('bridges a WebRTC-originated data change into the real folder engine, without a feedback loop', async () => {
    const store = useWorkspaceStore();
    // Comença sense dades locals pròpies (null): el pas de sembra
    // d'attachJsonChannelBridge no té res a escriure, de manera que el
    // valor que arribarà tot seguit d'un peer WebRTC independent no
    // competeix amb cap escriptura local pel seu propi rellotge intern de
    // Yjs -- dos Y.Doc mai fusionats abans no tenen cap ordre determinista
    // de "qui ha escrit primer", cosa que faria aquest test inestable si
    // tots dos costats haguessin escrit la mateixa clau.
    store.excelJsonData = null;
    store.config.collabCaptureDebounceSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    const { startCollabSync } = useCollabSync(fakeFolder, () => null);
    await startCollabSync();
    // Deixa que el primer cicle de sondeig assenti la base abans de
    // provocar cap canvi -- mateix ordre que collab_sync.test.js ja fa
    // servir (el motor sondeja la carpeta de seguida en arrencar).
    await vi.advanceTimersByTimeAsync(10);

    const ydoc = new Y.Doc();
    const ymap = ydoc.getMap('jsonChannels');
    const localOrigin = Symbol('realtime-local');
    const stopRealtime = await attachJsonChannelBridge(ydoc, ymap, 'data', {
      getLocal: () => store.excelJsonData,
      setLocal: (v) => { store.excelJsonData = v; },
      computePatch: computeDataPatch,
    }, localOrigin, 1000);

    // Un altre participant connectat només per WebRTC (Y.Doc independent)
    // envia un canvi.
    const remoteDoc = new Y.Doc();
    remoteDoc.getMap('jsonChannels').set('data', { pres: { import: 200 } });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));

    await vi.advanceTimersByTimeAsync(1100);

    expect(store.excelJsonData).toEqual({ pres: { import: 200 } });

    // El motor REAL de la carpeta (useCollabSync.js), sense saber res del
    // WebRTC, ha de veure aquest canvi com una edició local pròpia i
    // escriure'l al seu propi fitxer de deltes -- comportament de pont
    // previst, no un bucle.
    const userId = localStorage.getItem('elipsCollabUserId');
    const entries = readDeltaEntries(fakeFolder, userId);
    expect(entries.length).toBe(1);

    // Cap soroll addicional un cop assentat -- ni un bucle, ni una segona
    // entrada fantasma.
    await vi.advanceTimersByTimeAsync(2000);
    expect(readDeltaEntries(fakeFolder, userId).length).toBe(1);

    stopRealtime();
  });

  it('bridges a folder-originated data change out through the real WebRTC channel too', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { import: 100 } };
    store.config.collabCaptureDebounceSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    const { startCollabSync } = useCollabSync(fakeFolder, () => null);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(10);

    const ydoc = new Y.Doc();
    const ymap = ydoc.getMap('jsonChannels');
    const localOrigin = Symbol('realtime-local');
    const stopRealtime = await attachJsonChannelBridge(ydoc, ymap, 'data', {
      getLocal: () => store.excelJsonData,
      setLocal: (v) => { store.excelJsonData = v; },
      computePatch: computeDataPatch,
    }, localOrigin, 1000);

    // Simula el que useCollabSync.js fa en reconstruir l'estat fusionat
    // d'un cicle de sondeig: un altre usuari ha editat la carpeta
    // compartida. Escrivim directament el seu baseline/delta tal com ho
    // faria aquella altra persona, i deixem que el PROPI motor de la
    // carpeta d'aquest peer el reculli al seu proper cicle.
    await fakeFolder.writeJsonFile('collab_baseline.json', { pres: { import: 300 } });
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 2, updatedAt: new Date().toISOString(), updatedBy: 'una-altra-persona' });

    // Avança fins al pròxim cicle de sondeig (collabPollIntervalSeconds, 5s
    // per defecte) perquè useCollabSync.js detecti la nova base.
    await vi.advanceTimersByTimeAsync((store.config.collabPollIntervalSeconds || 5) * 1000 + 500);

    expect(store.excelJsonData).toEqual({ pres: { import: 300 } });

    // El canal WebRTC, sense saber res de la carpeta, ha de rebre aquest
    // mateix canvi i publicar-lo al Y.Map compartit.
    await vi.advanceTimersByTimeAsync(1100);
    expect(ymap.get('data')).toEqual({ pres: { import: 300 } });

    stopRealtime();
  });
});
