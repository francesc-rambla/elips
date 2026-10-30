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
 * Fase 16 del pla (.claude/plans/unified-nibbling-adleman.md): un `Y.Doc`
 * PERSISTENT per projecte -- no un d'efímer per sessió com fins a la Fase
 * 15 (`new Y.Doc()` a cada `startRealtimeSession`, destruït a `teardown()`).
 * Gràcies a això, el canal `template` (`Y.Text`, `useCollabRealtime.js`)
 * pot capturar edicions com a operacions Yjs reals INDEPENDENTMENT de si hi
 * ha cap sessió en viu activa -- un cop un projecte s'ha connectat almenys
 * una vegada, les edicions posteriors (connectat o no, en aquesta mateixa
 * pestanya o després de recarregar-la) s'acumulen aquí, i Yjs les fusiona
 * soles la propera vegada que hi hagi una connexió real: és el cas d'ús
 * exacte per al qual Yjs existeix, no cap lògica de fusió nova.
 *
 * `Y` (el mòdul `yjs`) es passa com a argument en lloc d'importar-lo aquí
 * -- aquest fitxer no ha de forçar la càrrega de `yjs` per si sol per a qui
 * mai arriba a fer servir la sessió en viu; qui el carrega de manera
 * diferida (`import()`) és `useCollabRealtime.js`, com ja feia abans
 * d'aquesta fase. `getItem`/`setItem` són injectables (per defecte
 * `getDbItem`/`saveDbItem`, `src/utils/db.js`) perquè es puguin provar
 * sense IndexedDB real -- mateix idioma de dependències injectables que
 * `findWorkingSignalingServer` a `useCollabRealtime.js`.
 */
import { getDbItem, saveDbItem } from '../utils/db';

const DOC_DB_KEY_PREFIX = 'collabRealtimeDoc:';

// Cache en memòria -- com a molt una entrada per projecte OBERT en aquesta
// pestanya; closeProjectDoc() n'elimina l'entrada en tancar/canviar de
// projecte. En ús normal de l'aplicació només hi ha un projecte obert
// alhora, així que no cal cap límit de mida ni expulsió per LRU.
const cache = new Map();

/** Comprova, SENSE carregar `yjs`, si ja existeix algun estat desat per a
 * aquest projecte -- permet decidir si val la pena carregar `yjs` (en obrir
 * un projecte que potser mai ha fet servir la sessió en viu) abans de
 * fer-ho de debò. */
export async function hasPersistedProjectDoc(projectName, { getItem = getDbItem } = {}) {
  const bytes = await getItem(DOC_DB_KEY_PREFIX + projectName);
  return !!bytes;
}

/** Retorna el `Y.Doc` persistent d'aquest projecte: el reutilitza si ja
 * està carregat en aquesta pestanya (p. ex. una crida des de
 * `startRealtimeSession` després que `resumeOfflineCapture` ja l'hagi
 * carregat, o viceversa), o el carrega d'IndexedDB -- buit si no hi havia
 * res desat (primera vegada que aquest projecte fa servir la sessió en
 * viu). Cada actualització del doc es desa de tornada, amb un `debounceMs`
 * perquè no s'escrigui a IndexedDB a cada caràcter (mateix idioma de
 * debounce que la resta de l'aplicació, `autoSaveDebounceSeconds`). */
export async function getOrCreateProjectDoc(Y, projectName, { getItem = getDbItem, setItem = saveDbItem, debounceMs = 2000 } = {}) {
  const cached = cache.get(projectName);
  if (cached) return cached.doc;

  const doc = new Y.Doc();
  const key = DOC_DB_KEY_PREFIX + projectName;
  const bytes = await getItem(key);
  if (bytes) {
    Y.applyUpdate(doc, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  const entry = { Y, doc, key, setItem, debounceTimer: null };
  entry.onUpdate = () => {
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => flushEntry(entry), debounceMs);
  };
  doc.on('update', entry.onUpdate);
  cache.set(projectName, entry);
  ensureFlushOnHide();
  return doc;
}

function flushEntry(entry) {
  clearTimeout(entry.debounceTimer);
  entry.debounceTimer = null;
  entry.setItem(entry.key, entry.Y.encodeStateAsUpdate(entry.doc));
}

// Un `setTimeout` pendent (el debounce de dalt) NO s'executa si la pestanya
// es tanca o es recarrega abans que venci -- una edició feta pocs segons
// abans de marxar es perdria de l'IndexedDB (encara que
// store.templateText, desat de seguida per la via ordinària de
// localStorage, sobrevisqui igualment com a text pla: donaria la falsa
// impressió que tot està bé, quan en realitat l'operació Yjs d'aquella
// edició concreta no s'hauria arribat a fusionar amb ningú més).
// `visibilitychange`/`pagehide` flushen de seguida (no debounced) TOTS els
// docs amb un flush pendent en aquell moment -- cobreix bé el cas normal
// (canviar de pestanya, tancar el navegador un moment després d'editar),
// però NO garanteix res si l'edició i el tancament passen pràcticament
// d'un sol cop (confirmat empíricament: `indexedDB.open()` -- vegeu
// `src/utils/db.js` -- és asíncron i pot no arribar a completar-se abans
// que el navegador destrueixi la pàgina). És un límit acceptat, no un bug
// a perseguir més: el pitjor cas és perdre la darrera fracció de segon
// d'edició Yjs d'una sessió MOLT curta, mai contingut ja fusionat amb
// altres peers. Registrat UN SOL COP, la primera vegada que es carrega
// algun doc.
let flushOnHideRegistered = false;
function ensureFlushOnHide() {
  if (flushOnHideRegistered || typeof document === 'undefined') return;
  flushOnHideRegistered = true;
  const flushAllPending = () => {
    for (const entry of cache.values()) {
      if (entry.debounceTimer) flushEntry(entry);
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAllPending();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushAllPending);
  }
}

/** Fa un darrer flush a IndexedDB (immediat, no debounced) i allibera el
 * `Y.Doc` d'aquest projecte -- cridat NOMÉS en canviar o tancar el
 * projecte (`closeRealtimeForProject`, `useCollabRealtime.js`), MAI en una
 * simple desconnexió de xarxa (`stopRealtimeSession`): el `Y.Doc` ha de
 * sobreviure a una desconnexió perquè les edicions fetes mentrestant no es
 * perdin (Fase 16). No-op si aquest projecte no té cap doc carregat (p. ex.
 * mai ha fet servir la sessió en viu). */
export async function closeProjectDoc(projectName) {
  const entry = cache.get(projectName);
  if (!entry) return;
  cache.delete(projectName);
  await entry.setItem(entry.key, entry.Y.encodeStateAsUpdate(entry.doc));
  clearTimeout(entry.debounceTimer);
  entry.doc.off('update', entry.onUpdate);
  entry.doc.destroy();
}
