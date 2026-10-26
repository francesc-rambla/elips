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
 * Fase 10 del pla "Alternativa complementària: sessió en viu amb WebRTC +
 * Yjs" -- prova de concepte del canal `template` en temps real de debò
 * (no sondeig), funcionant a qualsevol navegador amb WebRTC, no només
 * Chrome/Edge com la carpeta de col·laboració (useCollabFolder.js/
 * useCollabSync.js). És additiu: pot coexistir amb la carpeta sense
 * coordinar-s'hi, perquè totes dues vies acaben escrivint a
 * store.templateText amb el mateix flag `store.collabApplyingRemoteTemplate`
 * que TemplateEditor.vue ja sap interpretar (preserva l'historial de
 * desfer, mostra l'avís de fusió remota de la Fase 9) -- zero canvis a
 * TemplateEditor.vue calen per a aquest canal nou.
 *
 * A diferència del canal `template` de useCollabSync.js (última-escriptura-
 * guanya sobre tot el text, via `computeDataPatch({text:...})`), aquí es
 * fa servir `Y.Text`, que dona fusió real caràcter a caràcter entre
 * participants connectats alhora.
 *
 * `yjs`/`y-webrtc` es carreguen de manera diferida (import() dinàmic),
 * només en iniciar una sessió, seguint el mateix criteri que
 * useWasmEngines.js aplica a Pyodide: no augmentar el pes del paquet
 * inicial per a qui no usi mai aquesta funcionalitat.
 *
 * El nom de sala és l'únic control d'accés del servidor de senyalització
 * públic (hi viatja en clar) -- ha de ser un identificador aleatori, mai el
 * nom humà del projecte -- i la contrasenya és obligatòria perquè y-webrtc
 * xifri els payloads abans d'enviar-los, de manera que ni el servidor de
 * senyalització els pugui llegir.
 */

import { ref, watch, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

const DEFAULT_SIGNALING_SERVERS = ['wss://y-webrtc-eu.fly.dev'];

/** Genera un identificador de sala i una contrasenya nous, per a qui inicia
 * una sessió en viu i els ha de compartir (fora de banda) amb la resta. */
export function generateSessionCredentials() {
  return {
    roomId: `elips-${crypto.randomUUID()}`,
    password: crypto.randomUUID(),
  };
}

/** Converteix un reemplaçament sencer de cadena (oldStr -> newStr) en el
 * mínim parell esborra/insereix posicional que Y.Text necessita, per
 * aprofitar la fusió caràcter a caràcter en lloc de substituir tot el text
 * a cada edició local (que fora última-escriptura-guanya disfressada). */
export function applyStringDiffToYText(ytext, oldStr, newStr) {
  if (oldStr === newStr) return;
  const maxPrefix = Math.min(oldStr.length, newStr.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldStr[prefix] === newStr[prefix]) prefix++;
  let oldEnd = oldStr.length;
  let newEnd = newStr.length;
  while (oldEnd > prefix && newEnd > prefix && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const deleteLen = oldEnd - prefix;
  const insertText = newStr.slice(prefix, newEnd);
  if (deleteLen > 0) ytext.delete(prefix, deleteLen);
  if (insertText.length > 0) ytext.insert(prefix, insertText);
}

/**
 * Connecta `store.templateText` a un `Y.Text` ja creat: repropaga les
 * edicions locals cap al Y.Text (com a diff posicional, no reemplaçament
 * sencer) i les fusions remotes cap a `store.templateText` (mateix flag
 * `store.collabApplyingRemoteTemplate` que ja interpreta TemplateEditor.vue).
 * Extret com a peça independent del transport (`WebrtcProvider`) perquè es
 * pugui provar amb dos `Y.Doc` en memòria sincronitzats directament via
 * `Y.applyUpdate`, sense xarxa real -- veure tests/collab_realtime.test.js.
 *
 * Retorna una funció per desconnectar (atura el watcher; no toca el Y.Doc).
 */
export function attachTemplateBridge(ydoc, ytext, store, localOrigin) {
  const observer = (event) => {
    if (event.transaction.origin === localOrigin) return; // eco de la pròpia escriptura
    const merged = ytext.toString();
    if (merged === store.templateText) return;
    store.collabApplyingRemoteTemplate = true;
    store.templateText = merged;
    nextTick(() => {
      store.collabApplyingRemoteTemplate = false;
    });
  };
  ytext.observe(observer);

  const stopWatch = watch(() => store.templateText, (newVal) => {
    if (store.collabApplyingRemoteTemplate) return; // és el nostre propi merge remot acabat d'aplicar
    const current = ytext.toString();
    if (current === (newVal || '')) return;
    ydoc.transact(() => {
      applyStringDiffToYText(ytext, current, newVal || '');
    }, localOrigin);
  });

  return () => {
    ytext.unobserve(observer);
    stopWatch();
  };
}

export function useCollabRealtime() {
  const store = useWorkspaceStore();

  const sessionStatus = ref('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'error'
  const lastRealtimeError = ref(null);

  let ydoc = null;
  let ytext = null;
  let provider = null;
  let stopLocalWatch = null;
  // Marca les transaccions pròpies perquè l'observer de ytext les pugui
  // distingir de canvis arribats d'altres participants (mateix propòsit que
  // la bandera isApplyingRemote del motor de useCollabSync.js, però aquí
  // expressada com a origen de transacció Yjs en lloc d'una bandera externa).
  const localOrigin = Symbol('elips-collab-realtime-local');

  function teardown() {
    if (stopLocalWatch) {
      stopLocalWatch();
      stopLocalWatch = null;
    }
    if (provider) {
      provider.destroy();
      provider = null;
    }
    if (ydoc) {
      ydoc.destroy();
      ydoc = null;
    }
    ytext = null;
  }

  async function startRealtimeSession({ roomId, password, signaling }) {
    if (!roomId || !password) {
      throw new Error("Calen un identificador de sala i una contrasenya per iniciar una sessió en viu.");
    }
    if (sessionStatus.value === 'connected' || sessionStatus.value === 'connecting') {
      stopRealtimeSession();
    }
    sessionStatus.value = 'connecting';
    lastRealtimeError.value = null;
    try {
      const [Y, { WebrtcProvider }] = await Promise.all([
        import('yjs'),
        import('y-webrtc'),
      ]);

      ydoc = new Y.Doc();
      ytext = ydoc.getText('template');
      const thisYdoc = ydoc; // per detectar un stopRealtimeSession() concurrent durant l'espera de més avall

      provider = new WebrtcProvider(roomId, ydoc, {
        signaling: signaling || DEFAULT_SIGNALING_SERVERS,
        password,
      });

      // Sembra el document compartit amb el text local actual perquè qui
      // inicia la sessió en solitari no comenci des d'una plantilla buida
      // -- però NOMÉS després d'una petita espera (aleatoritzada, per
      // reduir -- no eliminar del tot -- la col·lisió), per donar temps a
      // sincronitzar-se amb algú que ja hi fos. Sense aquesta espera, dos
      // participants connectant-se gairebé alhora amb el MATEIX text local
      // (p. ex. el mateix projecte carregat per tots dos) inserteixen cada
      // un la seva pròpia còpia en un Y.Doc encara buit i no connectat:
      // Yjs no deduplica per contingut, són dues insercions concurrents
      // genuïnes, i el resultat és el text duplicat, no un no-op.
      await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 400));
      if (ydoc !== thisYdoc) return; // stopRealtimeSession() ha corregut mentrestant
      if (ytext.length === 0 && store.templateText) {
        ydoc.transact(() => {
          if (ytext.length === 0) ytext.insert(0, store.templateText);
        }, localOrigin);
      }

      stopLocalWatch = attachTemplateBridge(ydoc, ytext, store, localOrigin);

      sessionStatus.value = 'connected';
    } catch (err) {
      teardown();
      lastRealtimeError.value = err?.message || String(err);
      sessionStatus.value = 'error';
      throw err;
    }
  }

  function stopRealtimeSession() {
    teardown();
    sessionStatus.value = 'disconnected';
  }

  return {
    sessionStatus,
    lastRealtimeError,
    startRealtimeSession,
    stopRealtimeSession,
  };
}
