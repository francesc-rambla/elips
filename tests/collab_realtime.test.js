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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reactive, watch, nextTick } from 'vue';
import * as Y from 'yjs';
import {
  applyStringDiffToYText,
  attachTemplateBridge,
  attachJsonChannelBridge,
  generateSessionCredentials,
  mapAwarenessStatesToPeers,
  waitForRemoteProjectName,
  checkProjectMatch,
  classifyProjectMismatch,
  templateYTextName,
  normalizeSignalingServers,
  findWorkingSignalingServer,
  KNOWN_SIGNALING_SERVERS,
  chunkBytes,
  concatChunks,
  attachProjectTransferResponder,
  requestProjectTransfer,
  PROJECT_TRANSFER_CHUNK_SIZE,
} from '../src/composables/useCollabRealtime.js';
import { computeDataPatch } from '../src/utils/dataPatch.js';

/** Simulates what WebrtcProvider does under the hood (exchange + apply Yjs
 * update vectors), without any real network -- same spirit as the fake
 * collab folder already used in tests/collab_sync.test.js. */
function syncDocs(a, b) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

/** A minimal duck-typed stand-in for the workspace store: attachTemplateBridge
 * only ever reads/writes `templateText`/`collabApplyingRemoteTemplate`, so a
 * plain reactive object is enough to simulate one independent "peer" -- no
 * need for two real Pinia instances (Pinia only supports one active app-wide
 * instance at a time anyway). The Y.Doc starts empty and unconnected --
 * callers wire up the shared starting text via `seedBaseline()` below,
 * NOT by inserting it independently on every peer (see that helper's
 * comment for why that would silently duplicate the text). */
function makePeer(initialText) {
  const store = reactive({ templateText: initialText, collabApplyingRemoteTemplate: false });
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('template');
  const localOrigin = Symbol('local');
  const stop = attachTemplateBridge(ydoc, ytext, store, localOrigin);
  return { store, ydoc, ytext, stop };
}

/** Establishes the shared starting text across peers by inserting it once
 * (on the first peer only) and letting every other peer adopt that exact
 * CRDT state via syncDocs, instead of each independently inserting
 * "the same" text into their own empty, as-yet-unconnected Y.Doc -- Yjs
 * does not deduplicate by content, so two independent inserts of "same
 * looking" text are two distinct concurrent insertions that both survive a
 * later merge (producing duplicated text), exactly the race
 * `startRealtimeSession`'s seeding step (useCollabRealtime.js) guards
 * against with its post-connect grace delay. */
function seedBaseline(peers) {
  const [first, ...rest] = peers;
  if (first.store.templateText) {
    first.ydoc.transact(() => {
      first.ytext.insert(0, first.store.templateText);
    });
  }
  for (const other of rest) {
    syncDocs(first.ydoc, other.ydoc);
    other.store.templateText = other.ytext.toString();
  }
}

describe('generateSessionCredentials', () => {
  it('generates a non-guessable room id (never the project name) and a separate password', () => {
    const a = generateSessionCredentials();
    const b = generateSessionCredentials();
    expect(a.roomId).toMatch(/^elips-[0-9a-f-]{36}$/);
    expect(a.password).toBeTruthy();
    expect(a.roomId).not.toBe(b.roomId);
    expect(a.password).not.toBe(b.password);
  });
});

describe('mapAwarenessStatesToPeers (Fase 11: participants des de l\'Awareness de Yjs)', () => {
  it('maps user state entries and flags the self entry', () => {
    const states = new Map([
      [1, { user: { userId: 'u1', displayName: 'Anna' } }],
      [2, { user: { userId: 'u2', displayName: 'Bernat' } }],
    ]);
    const peers = mapAwarenessStatesToPeers(states, 2);
    expect(peers).toEqual([
      { userId: 'u1', displayName: 'Anna', isSelf: false },
      { userId: 'u2', displayName: 'Bernat', isSelf: true },
    ]);
  });

  it('ignores awareness entries with no user field (e.g. a peer that has not set it yet)', () => {
    const states = new Map([
      [1, {}],
      [2, { user: { userId: 'u2', displayName: 'Bernat' } }],
    ]);
    const peers = mapAwarenessStatesToPeers(states, 1);
    expect(peers).toEqual([{ userId: 'u2', displayName: 'Bernat', isSelf: false }]);
  });

  it('falls back to a generic label and the raw clientId when userId/displayName are missing', () => {
    const states = new Map([[42, { user: {} }]]);
    const peers = mapAwarenessStatesToPeers(states, 1);
    expect(peers).toEqual([{ userId: '42', displayName: 'Algú', isSelf: false }]);
  });

  it('returns an empty list for an empty states map', () => {
    expect(mapAwarenessStatesToPeers(new Map(), 1)).toEqual([]);
  });

  it('includes docName (Fase 11.2) when a peer has published which document it is on', () => {
    const states = new Map([[1, { user: { userId: 'u1', displayName: 'Anna', docName: 'Memòria justificativa' } }]]);
    const peers = mapAwarenessStatesToPeers(states, 2);
    expect(peers).toEqual([{ userId: 'u1', displayName: 'Anna', isSelf: false, docName: 'Memòria justificativa' }]);
  });
});

describe('templateYTextName (Fase 11.2: un Y.Text per document, no un de sol per sessió)', () => {
  it('derives a distinct, deterministic name per document', () => {
    expect(templateYTextName('Document Principal')).toBe('template:Document Principal');
    expect(templateYTextName('Memòria justificativa')).not.toBe(templateYTextName('Plec de prescripcions'));
  });
});

describe('multi-document isolation (Fase 11.2: la sincronització ha d\'anar amb el document, no amb "el que estigui obert")', () => {
  it('keeps two documents of the same project from bleeding into each other over the same Y.Doc', async () => {
    const localOriginA = Symbol('a');
    const localOriginB = Symbol('b');

    const docA = new Y.Doc();
    const storeA = reactive({ templateText: 'Memòria v1', collabApplyingRemoteTemplate: false });
    const ytextMemoriaOnA = docA.getText(templateYTextName('Memòria justificativa'));
    ytextMemoriaOnA.insert(0, storeA.templateText);
    const stopA = attachTemplateBridge(docA, ytextMemoriaOnA, storeA, localOriginA);

    const storeB = reactive({ templateText: 'Plec v1', collabApplyingRemoteTemplate: false });
    const ytextPlecOnA = docA.getText(templateYTextName('Plec de prescripcions'));
    ytextPlecOnA.insert(0, storeB.templateText);
    const stopB = attachTemplateBridge(docA, ytextPlecOnA, storeB, localOriginB);

    // Edita el document de la memòria -- el del plec, al mateix Y.Doc, no s'ha de tocar.
    storeA.templateText = 'Memòria v2';
    await nextTick();

    expect(storeA.templateText).toBe('Memòria v2');
    expect(storeB.templateText).toBe('Plec v1');
    expect(ytextPlecOnA.toString()).toBe('Plec v1');

    stopA();
    stopB();
  });
});

describe('checkProjectMatch (Fase 11.1: comprovació de sala/projecte en unir-se)', () => {
  it('returns no error when the remote project matches the one open locally', () => {
    expect(checkProjectMatch('Expedient A', 'Expedient A', ['Expedient A'])).toBeNull();
  });

  it('tells the user to open the matching project first when it is saved but not open', () => {
    const msg = checkProjectMatch('Expedient B', 'Expedient A', ['Expedient A', 'Expedient B']);
    expect(msg).toMatch(/Expedient B/);
    expect(msg).toMatch(/Gestiona Projectes/);
  });

  it('tells the user to request the zip when the remote project is not saved locally at all', () => {
    const msg = checkProjectMatch('Expedient Desconegut', 'Expedient A', ['Expedient A']);
    expect(msg).toMatch(/Expedient Desconegut/);
    expect(msg).toMatch(/collab_project\.zip/);
  });

  it('reports an error when the remote project name never arrived (no silent pass-through)', () => {
    expect(checkProjectMatch(null, 'Expedient A', ['Expedient A'])).toMatch(/No s'ha pogut confirmar/);
  });
});

describe('waitForRemoteProjectName', () => {
  it('resolves immediately when the value is already set', async () => {
    const doc = new Y.Doc();
    const ymeta = doc.getMap('meta');
    ymeta.set('projectName', 'Expedient A');
    await expect(waitForRemoteProjectName(ymeta, 1000)).resolves.toBe('Expedient A');
  });

  it('resolves once the value arrives via a remote sync', async () => {
    const hostDoc = new Y.Doc();
    hostDoc.getMap('meta').set('projectName', 'Expedient A');

    const joinerDoc = new Y.Doc();
    const joinerMeta = joinerDoc.getMap('meta');
    const pending = waitForRemoteProjectName(joinerMeta, 1000);

    syncDocs(hostDoc, joinerDoc);

    await expect(pending).resolves.toBe('Expedient A');
  });

  it('resolves to null if nothing arrives before the timeout, without hanging', async () => {
    const doc = new Y.Doc();
    const ymeta = doc.getMap('meta');
    await expect(waitForRemoteProjectName(ymeta, 20)).resolves.toBeNull();
  });
});

describe('applyStringDiffToYText', () => {
  function makeYText(initial) {
    const doc = new Y.Doc();
    const ytext = doc.getText('t');
    if (initial) ytext.insert(0, initial);
    return ytext;
  }

  it('is a no-op when the strings are equal', () => {
    const ytext = makeYText('abc');
    applyStringDiffToYText(ytext, 'abc', 'abc');
    expect(ytext.toString()).toBe('abc');
  });

  it('appends text at the end', () => {
    const ytext = makeYText('Hola');
    applyStringDiffToYText(ytext, 'Hola', 'Hola món');
    expect(ytext.toString()).toBe('Hola món');
  });

  it('inserts text in the middle, touching only the changed span', () => {
    const ytext = makeYText('abc def');
    applyStringDiffToYText(ytext, 'abc def', 'abcXYZ def');
    expect(ytext.toString()).toBe('abcXYZ def');
  });

  it('deletes a chunk from the middle', () => {
    const ytext = makeYText('abcXYZ def');
    applyStringDiffToYText(ytext, 'abcXYZ def', 'abc def');
    expect(ytext.toString()).toBe('abc def');
  });

  it('replaces the whole string when there is no common prefix/suffix', () => {
    const ytext = makeYText('abc');
    applyStringDiffToYText(ytext, 'abc', 'xyz');
    expect(ytext.toString()).toBe('xyz');
  });
});

describe('attachTemplateBridge (Fase 10: canal de plantilla en temps real via Y.Text)', () => {
  it('propagates a local edit from one peer to the other', async () => {
    const a = makePeer('Hola');
    const b = makePeer('Hola');
    seedBaseline([a, b]);

    a.store.templateText = 'Hola món';
    await nextTick();
    syncDocs(a.ydoc, b.ydoc);
    await nextTick();

    expect(b.store.templateText).toBe('Hola món');
  });

  it('toggles collabApplyingRemoteTemplate around a remote merge (same flag TemplateEditor.vue already understands)', async () => {
    const a = makePeer('X');
    const b = makePeer('X');
    seedBaseline([a, b]);

    const transitions = [];
    watch(() => b.store.collabApplyingRemoteTemplate, (v) => transitions.push(v), { flush: 'sync' });

    a.store.templateText = 'XY';
    await nextTick();
    syncDocs(a.ydoc, b.ydoc);
    await nextTick();

    expect(transitions).toEqual([true, false]);
  });

  it('merges concurrent edits at different positions (character-level merge, not whole-text last-write-wins)', async () => {
    const a = makePeer('abc def');
    const b = makePeer('abc def');
    seedBaseline([a, b]);

    a.store.templateText = 'abcXYZ def'; // edits the first word
    b.store.templateText = 'abc def123'; // edits the second word, concurrently
    await nextTick();

    syncDocs(a.ydoc, b.ydoc);
    await nextTick();
    syncDocs(a.ydoc, b.ydoc); // settle any trailing remote-apply echo
    await nextTick();

    expect(a.store.templateText).toBe(b.store.templateText);
    expect(a.store.templateText).toContain('XYZ');
    expect(a.store.templateText).toContain('123');
  });

  it('does not keep generating outgoing changes once both peers have converged (no feedback loop)', async () => {
    const a = makePeer('same');
    const b = makePeer('same');
    seedBaseline([a, b]);

    a.store.templateText = 'same text';
    await nextTick();
    syncDocs(a.ydoc, b.ydoc);
    await nextTick();
    expect(a.store.templateText).toBe(b.store.templateText);

    const stateBefore = Y.encodeStateAsUpdate(a.ydoc);
    syncDocs(a.ydoc, b.ydoc); // sync again at a fixpoint
    await nextTick();
    const stateAfter = Y.encodeStateAsUpdate(a.ydoc);

    expect(stateAfter).toEqual(stateBefore);
    expect(a.store.templateText).toBe(b.store.templateText);
  });

  it('stop() detaches both the Y.Text observer and the local watcher', async () => {
    const a = makePeer('abc');
    const b = makePeer('abc');
    seedBaseline([a, b]);
    a.stop();

    a.store.templateText = 'changed locally after stop';
    await nextTick();
    // No watcher left on peer A -- its ytext must stay untouched.
    expect(a.ytext.toString()).toBe('abc');

    b.store.templateText = 'changed on peer B after peer A stopped';
    await nextTick();
    syncDocs(a.ydoc, b.ydoc);
    await nextTick();
    // No observer left on peer A -- store.templateText must stay untouched.
    expect(a.store.templateText).toBe('changed locally after stop');
  });
});

describe('normalizeSignalingServers (Fase 11.3: llista configurable de servidors de senyalització)', () => {
  it('passes through {url, label} objects unchanged', () => {
    expect(normalizeSignalingServers([{ url: 'wss://a', label: 'A' }])).toEqual([{ url: 'wss://a', label: 'A' }]);
  });

  it('wraps plain string URLs into {url, label}', () => {
    expect(normalizeSignalingServers(['wss://a'])).toEqual([{ url: 'wss://a', label: 'wss://a' }]);
  });

  it('drops entries with no url', () => {
    expect(normalizeSignalingServers([{ label: 'sense url' }, null, { url: 'wss://a' }])).toEqual([{ url: 'wss://a' }]);
  });

  it('returns an empty list for null/undefined input', () => {
    expect(normalizeSignalingServers(null)).toEqual([]);
    expect(normalizeSignalingServers(undefined)).toEqual([]);
  });
});

describe('findWorkingSignalingServer (Fase 11.3)', () => {
  it('returns the first server that responds when there is no preferred one, without asking anything', async () => {
    const probeFn = vi.fn(async (url) => url === 'wss://b');
    const confirmFn = vi.fn();
    const result = await findWorkingSignalingServer(['wss://a', 'wss://b', 'wss://c'], '', probeFn, confirmFn);
    expect(result).toBe('wss://b');
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('returns null when nothing responds and there is no preferred server', async () => {
    const probeFn = vi.fn(async () => false);
    const result = await findWorkingSignalingServer(['wss://a', 'wss://b'], '', probeFn);
    expect(result).toBeNull();
    expect(probeFn).toHaveBeenCalledTimes(2);
  });

  it('uses the preferred server directly when it responds, without probing the rest', async () => {
    const probeFn = vi.fn(async (url) => url === 'wss://preferred');
    const confirmFn = vi.fn();
    const result = await findWorkingSignalingServer(['wss://a', 'wss://preferred', 'wss://b'], 'wss://preferred', probeFn, confirmFn);
    expect(result).toBe('wss://preferred');
    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('asks before falling back when the preferred server fails, and tries the rest in order if accepted', async () => {
    const probeFn = vi.fn(async (url) => url === 'wss://b');
    const confirmFn = vi.fn(() => true);
    const result = await findWorkingSignalingServer(['wss://preferred', 'wss://a', 'wss://b'], 'wss://preferred', probeFn, confirmFn);
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(confirmFn.mock.calls[0][0]).toMatch(/wss:\/\/preferred/);
    expect(result).toBe('wss://b');
  });

  it('gives up without probing anything else when the user declines to try the rest', async () => {
    const probeFn = vi.fn(async (url) => url === 'wss://b');
    const confirmFn = vi.fn(() => false);
    const result = await findWorkingSignalingServer(['wss://preferred', 'wss://b'], 'wss://preferred', probeFn, confirmFn);
    expect(result).toBeNull();
    expect(probeFn).toHaveBeenCalledTimes(1); // només el preferit -- mai s'arriba a provar wss://b
  });

  it('falls back to sequential order (ignoring the stale preference) when the preferred URL is no longer in the list', async () => {
    const probeFn = vi.fn(async (url) => url === 'wss://a');
    const confirmFn = vi.fn();
    const result = await findWorkingSignalingServer(['wss://a', 'wss://b'], 'wss://removed', probeFn, confirmFn);
    expect(result).toBe('wss://a');
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('returns null without asking when the preferred server fails and there is nothing else configured', async () => {
    const probeFn = vi.fn(async () => false);
    const confirmFn = vi.fn();
    const result = await findWorkingSignalingServer(['wss://preferred'], 'wss://preferred', probeFn, confirmFn);
    expect(result).toBeNull();
    expect(confirmFn).not.toHaveBeenCalled();
  });
});

/** A thin peer helper for attachJsonChannelBridge tests, mirroring
 * makePeer()/seedBaseline() above but for a plain-value field (`store.value`)
 * instead of templateText -- attach happens eagerly (it's async because the
 * bridge's own reconciliation step may await a nextTick). */
async function makeJsonPeer(key, initialVal, computePatch, debounceMs = 20) {
  const store = reactive({ value: initialVal });
  const ydoc = new Y.Doc();
  const ymap = ydoc.getMap('jsonChannels');
  const localOrigin = Symbol('local');
  const stop = await attachJsonChannelBridge(ydoc, ymap, key, {
    getLocal: () => store.value,
    setLocal: (v) => { store.value = v; },
    computePatch,
  }, localOrigin, debounceMs);
  return { store, ydoc, ymap, stop };
}

describe('attachJsonChannelBridge (Fases 12/13: canals schema/data com a mirall de transport)', () => {
  it('propagates a local edit from one peer to the other after the debounce', async () => {
    const a = await makeJsonPeer('data', { foo: 1 }, computeDataPatch, 15);
    const b = await makeJsonPeer('data', { foo: 1 }, computeDataPatch, 15);
    syncDocs(a.ydoc, b.ydoc);

    a.store.value = { foo: 2 };
    await nextTick();
    await new Promise((r) => setTimeout(r, 30));
    syncDocs(a.ydoc, b.ydoc);
    await nextTick();

    expect(b.store.value).toEqual({ foo: 2 });
    a.stop();
    b.stop();
  });

  it('waits for the debounce before writing a local change to the shared Y.Map', async () => {
    const a = await makeJsonPeer('data', { n: 1 }, computeDataPatch, 50);
    a.store.value = { n: 2 };
    await nextTick();
    expect(a.ymap.get('data')).toEqual({ n: 1 }); // encara no ha passat el debounce
    await new Promise((r) => setTimeout(r, 70));
    expect(a.ymap.get('data')).toEqual({ n: 2 });
    a.stop();
  });

  it('reconciles remote content that had already synced before the bridge was attached', async () => {
    const hostDoc = new Y.Doc();
    hostDoc.getMap('jsonChannels').set('data', { foo: 'remot' });

    const joinerDoc = new Y.Doc();
    syncDocs(hostDoc, joinerDoc); // el valor ja hi és abans d'adjuntar el pont
    const joinerMap = joinerDoc.getMap('jsonChannels');
    const joinerStore = reactive({ value: { foo: 'local' } });

    const stop = await attachJsonChannelBridge(joinerDoc, joinerMap, 'data', {
      getLocal: () => joinerStore.value,
      setLocal: (v) => { joinerStore.value = v; },
      computePatch: computeDataPatch,
    }, Symbol('local'));

    expect(joinerStore.value).toEqual({ foo: 'remot' });
    stop();
  });

  it('does not keep generating outgoing changes once both peers have converged (no feedback loop)', async () => {
    const a = await makeJsonPeer('data', { n: 1 }, computeDataPatch, 10);
    const b = await makeJsonPeer('data', { n: 1 }, computeDataPatch, 10);
    syncDocs(a.ydoc, b.ydoc);

    a.store.value = { n: 2 };
    await new Promise((r) => setTimeout(r, 25));
    syncDocs(a.ydoc, b.ydoc);
    await nextTick();
    expect(b.store.value).toEqual({ n: 2 });

    const stateBefore = Y.encodeStateAsUpdate(a.ydoc);
    await new Promise((r) => setTimeout(r, 25)); // cap canvi pendent als dos costats
    syncDocs(a.ydoc, b.ydoc);
    const stateAfter = Y.encodeStateAsUpdate(a.ydoc);
    expect(stateAfter).toEqual(stateBefore);
    a.stop();
    b.stop();
  });

  it('stop() detaches both the Y.Map observer and the local watcher', async () => {
    const a = await makeJsonPeer('data', { n: 1 }, computeDataPatch, 10);
    const b = await makeJsonPeer('data', { n: 1 }, computeDataPatch, 10);
    syncDocs(a.ydoc, b.ydoc);
    a.stop();

    a.store.value = { n: 99 };
    await new Promise((r) => setTimeout(r, 20));
    expect(a.ymap.get('data')).toEqual({ n: 1 }); // no watcher left -- no capture

    b.store.value = { n: 42 };
    await new Promise((r) => setTimeout(r, 20));
    syncDocs(a.ydoc, b.ydoc);
    await nextTick();
    // No observer left on peer A -- store.value must stay whatever it was
    // set to locally (99), untouched by B's incoming change.
    expect(a.store.value).toEqual({ n: 99 });
    b.stop();
  });
});

describe('dual transport (Fase 13): carpeta OneDrive + sessió en viu WebRTC connectades alhora al mateix camp', () => {
  /** A deliberately minimal stand-in for useCollabSync.js's createDocChannel
   * engine: a debounced watcher + an `applyingRemote` flag local to ITSELF
   * (never shared with the WebRTC bridge), using the SAME computeDataPatch
   * used in production -- enough to exercise the actual interaction
   * contract (two independent watchers on the same reactive field) without
   * dragging in useCollabFolder.js/File System Access mocking, already
   * covered on its own in collab_sync.test.js. */
  function makeFolderLikeChannel(getLocal, setLocal, computePatch, debounceMs) {
    let applyingRemote = false;
    let lastKnown = JSON.parse(JSON.stringify(getLocal() ?? null));
    let debounceTimer = null;
    const capturedLog = [];

    const captureLocalChange = () => {
      if (applyingRemote) return;
      const patch = computePatch(lastKnown, getLocal());
      if (!patch) return;
      capturedLog.push(patch);
      lastKnown = JSON.parse(JSON.stringify(getLocal()));
    };
    const stopWatch = watch(getLocal, () => {
      if (applyingRemote) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(captureLocalChange, debounceMs);
    }, { deep: true });

    return {
      capturedLog,
      applyRemote(value) {
        applyingRemote = true;
        setLocal(value);
        nextTick(() => {
          applyingRemote = false;
          lastKnown = JSON.parse(JSON.stringify(value));
        });
      },
      stop: () => { clearTimeout(debounceTimer); stopWatch(); },
    };
  }

  it('bridges a WebRTC-originated change into the folder-style channel without an infinite loop', async () => {
    // Comença sense contingut local propi (store.value = null) perquè el
    // pas de sembra d'attachJsonChannelBridge no competeixi amb el valor
    // remot que arribarà tot seguit -- dos Y.Doc independents mai fusionats
    // abans no tenen cap ordre determinista de "qui ha escrit primer" pel
    // seu propi rellotge intern, cosa que faria aquest test inestable si
    // tots dos costats haguessin escrit la mateixa clau.
    const store = reactive({ value: null });
    const ydoc = new Y.Doc();
    const ymap = ydoc.getMap('jsonChannels');
    const localOrigin = Symbol('local');

    const stopRealtime = await attachJsonChannelBridge(ydoc, ymap, 'data', {
      getLocal: () => store.value,
      setLocal: (v) => { store.value = v; },
      computePatch: computeDataPatch,
    }, localOrigin, 15);

    const folder = makeFolderLikeChannel(() => store.value, (v) => { store.value = v; }, computeDataPatch, 15);

    // Un altre participant WebRTC (un Y.Doc independent) envia un canvi.
    const remoteDoc = new Y.Doc();
    remoteDoc.getMap('jsonChannels').set('data', { n: 2 });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc));

    await new Promise((r) => setTimeout(r, 40));
    await nextTick();

    expect(store.value).toEqual({ n: 2 });
    // El canal de carpeta (independent, sense saber res del WebRTC) ha
    // repropagat aquest canvi -- comportament previst, no un bucle: hi ha
    // d'haver EXACTAMENT una entrada capturada, no una cascada contínua.
    expect(folder.capturedLog.length).toBe(1);

    const logLengthAfterSettling = folder.capturedLog.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(folder.capturedLog.length).toBe(logLengthAfterSettling); // sense soroll addicional

    stopRealtime();
    folder.stop();
  });

  it('bridges a folder-originated change out through the WebRTC channel too', async () => {
    const store = reactive({ value: { n: 1 } });
    const ydoc = new Y.Doc();
    const ymap = ydoc.getMap('jsonChannels');
    const localOrigin = Symbol('local');

    const stopRealtime = await attachJsonChannelBridge(ydoc, ymap, 'data', {
      getLocal: () => store.value,
      setLocal: (v) => { store.value = v; },
      computePatch: computeDataPatch,
    }, localOrigin, 15);

    const folder = makeFolderLikeChannel(() => store.value, (v) => { store.value = v; }, computeDataPatch, 15);

    // Algú ha editat la carpeta compartida -- aplica la fusió com faria
    // useCollabSync.js en acabar un cicle de sondeig.
    folder.applyRemote({ n: 3 });
    await nextTick();
    await new Promise((r) => setTimeout(r, 40));

    expect(ymap.get('data')).toEqual({ n: 3 });

    stopRealtime();
    folder.stop();
  });
});

describe('KNOWN_SIGNALING_SERVERS', () => {
  it('is a non-empty, well-formed default list', () => {
    expect(KNOWN_SIGNALING_SERVERS.length).toBeGreaterThan(0);
    for (const s of KNOWN_SIGNALING_SERVERS) {
      expect(s.url).toMatch(/^wss?:\/\//);
      expect(typeof s.label).toBe('string');
    }
  });
});

describe('classifyProjectMismatch (Fase 14: base de checkProjectMatch)', () => {
  it('returns the same four classifications checkProjectMatch already relies on', () => {
    expect(classifyProjectMismatch('Default', 'Default', ['Default'])).toBe('match');
    expect(classifyProjectMismatch(null, 'Default', ['Default'])).toBe('no-remote-name');
    expect(classifyProjectMismatch('Altre', 'Default', ['Default', 'Altre'])).toBe('saved-not-open');
    expect(classifyProjectMismatch('Desconegut', 'Default', ['Default'])).toBe('not-local');
  });
});

describe('chunkBytes / concatChunks (Fase 14: transferència del ZIP)', () => {
  it('splits bytes into chunks of at most chunkSize and reconstructs them exactly', () => {
    const bytes = new Uint8Array(100);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const chunks = chunkBytes(bytes, 30);
    expect(chunks.length).toBe(4); // 30+30+30+10
    expect(chunks.map((c) => c.length)).toEqual([30, 30, 30, 10]);
    expect(concatChunks(chunks)).toEqual(bytes);
  });

  it('handles empty input as zero chunks', () => {
    expect(chunkBytes(new Uint8Array(0), 16384)).toEqual([]);
    expect(concatChunks([])).toEqual(new Uint8Array(0));
  });

  it('produces independent copies, not views sharing the original buffer', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const [chunk] = chunkBytes(bytes, 4);
    bytes[0] = 99;
    expect(chunk[0]).toBe(1); // no afectat per la mutació posterior de l'original
  });
});

describe('attachProjectTransferResponder / requestProjectTransfer (Fase 14: sol·licitud i transferència del ZIP)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeFakeZipBytes(label, repeat = 2000) {
    return new TextEncoder().encode(`ZIP-${label}-`.repeat(repeat));
  }

  function syncAll(docs) {
    for (const a of docs) {
      for (const b of docs) {
        if (a !== b) Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      }
    }
  }

  async function pump(docs, ticks = 20, stepMs = 100) {
    for (let i = 0; i < ticks; i++) {
      syncAll(docs);
      await vi.advanceTimersByTimeAsync(stepMs);
      syncAll(docs);
    }
  }

  it('transfers the project zip from the single peer that has it, reconstructing it byte-for-byte', async () => {
    const requesterDoc = new Y.Doc();
    const responderDoc = new Y.Doc();
    const docs = [requesterDoc, responderDoc];

    const zipBytes = makeFakeZipBytes('A');
    const stopResponder = attachProjectTransferResponder(
      responderDoc, responderDoc.getMap('projectTransfer'), responderDoc.getArray('projectTransferChunks'),
      { myUserId: 'responder-1', buildProjectZipBlob: async () => new Blob([zipBytes]) },
    );

    const progressSamples = [];
    const requestPromise = requestProjectTransfer(
      requesterDoc, requesterDoc.getMap('projectTransfer'), requesterDoc.getArray('projectTransferChunks'),
      { myUserId: 'requester-1', timeoutMs: 10000, onProgress: (p) => progressSamples.push(p) },
    );

    await pump(docs);

    const result = await requestPromise;
    expect(new Uint8Array(result.bytes)).toEqual(zipBytes);
    expect(result.zipFileName).toBe('collab_project.zip');
    expect(progressSamples.some((p) => p.totalChunks > 0)).toBe(true);
    expect(progressSamples[progressSamples.length - 1].receivedChunks).toBe(progressSamples[progressSamples.length - 1].totalChunks);

    stopResponder();
  });

  it('ignores its own request (a peer never responds to a request it posted itself)', async () => {
    const soloDoc = new Y.Doc();
    const stopResponder = attachProjectTransferResponder(
      soloDoc, soloDoc.getMap('projectTransfer'), soloDoc.getArray('projectTransferChunks'),
      { myUserId: 'same-user', buildProjectZipBlob: async () => new Blob([makeFakeZipBytes('X')]) },
    );

    const requestPromise = requestProjectTransfer(
      soloDoc, soloDoc.getMap('projectTransfer'), soloDoc.getArray('projectTransferChunks'),
      { myUserId: 'same-user', timeoutMs: 500 },
    );
    const assertion = expect(requestPromise).rejects.toThrow(/Ning./);
    await vi.advanceTimersByTimeAsync(600);
    await assertion;

    stopResponder();
  });

  it('rejects with a clear error if nobody responds within the timeout', async () => {
    const requesterDoc = new Y.Doc();
    const requestPromise = requestProjectTransfer(
      requesterDoc, requesterDoc.getMap('projectTransfer'), requesterDoc.getArray('projectTransferChunks'),
      { myUserId: 'requester-1', timeoutMs: 300 },
    );
    const assertion = expect(requestPromise).rejects.toThrow(/Ning./);
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
  });

  it('resolves to exactly one coherent zip even if two matching peers race to claim the same request', async () => {
    const requesterDoc = new Y.Doc();
    const responderADoc = new Y.Doc();
    const responderBDoc = new Y.Doc();
    const docs = [requesterDoc, responderADoc, responderBDoc];

    const zipA = makeFakeZipBytes('A');
    const zipB = makeFakeZipBytes('B');
    const stopA = attachProjectTransferResponder(
      responderADoc, responderADoc.getMap('projectTransfer'), responderADoc.getArray('projectTransferChunks'),
      { myUserId: 'responder-A', buildProjectZipBlob: async () => new Blob([zipA]) },
    );
    const stopB = attachProjectTransferResponder(
      responderBDoc, responderBDoc.getMap('projectTransfer'), responderBDoc.getArray('projectTransferChunks'),
      { myUserId: 'responder-B', buildProjectZipBlob: async () => new Blob([zipB]) },
    );

    const requestPromise = requestProjectTransfer(
      requesterDoc, requesterDoc.getMap('projectTransfer'), requesterDoc.getArray('projectTransferChunks'),
      { myUserId: 'requester-1', timeoutMs: 10000 },
    );

    await pump(docs, 40, 50);

    const result = await requestPromise;
    const resultBytes = new Uint8Array(result.bytes);
    const matchesA = resultBytes.length === zipA.length && resultBytes.every((b, i) => b === zipA[i]);
    const matchesB = resultBytes.length === zipB.length && resultBytes.every((b, i) => b === zipB[i]);
    expect(matchesA || matchesB).toBe(true); // exactament un dels dos, mai barrejats

    stopA();
    stopB();
  });

  it('exports a 16 KiB default chunk size', () => {
    expect(PROJECT_TRANSFER_CHUNK_SIZE).toBe(16384);
  });
});
