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

import { describe, it, expect } from 'vitest';
import { reactive, watch, nextTick } from 'vue';
import * as Y from 'yjs';
import {
  applyStringDiffToYText,
  attachTemplateBridge,
  generateSessionCredentials,
  mapAwarenessStatesToPeers,
  waitForRemoteProjectName,
  checkProjectMatch,
  templateYTextName,
} from '../src/composables/useCollabRealtime.js';

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
