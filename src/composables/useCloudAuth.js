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
 * Autenticació real per correu/contrasenya (Fase 24, sincronització al
 * núvol -- veure .claude/plans/unified-nibbling-adleman.md), via Firebase
 * Authentication. A diferència de useCollabIdentity.js (una identitat
 * autodeclarada, sense cap verificació), aquí `currentUser.email` és
 * l'identificador que les Regles de Seguretat de Firestore comproven
 * contra `memberEmails` de cada projecte -- és el que dona accés (o no) a
 * res, no és només cosmètic.
 *
 * `firebase/app`/`firebase/auth` es carreguen de manera diferida (import()
 * dinàmic), mateix patró ja establert per a `yjs`/`y-webrtc`
 * (useCollabRealtime.js) -- només es paga el cost d'inicialitzar-los quan
 * aquesta funcionalitat s'usa de debò.
 */
import { ref } from 'vue';
import { firebaseConfig, isCloudSyncConfigured } from '../utils/firebaseConfig';

let appPromise = null;
// Exportada perquè useCloudSync.js (Fase 25) reutilitzi la MATEIXA app
// Firebase (singleton a nivell de mòdul) en lloc d'inicialitzar-ne una
// segona -- `getApps().length ? getApp() : initializeApp(...)` ja ho
// protegeix igualment, però compartir la promesa evita una doble
// inicialització concurrent en arrencar.
export function getFirebaseApp() {
  if (!appPromise) {
    appPromise = import('firebase/app').then(({ initializeApp, getApps, getApp }) => (
      getApps().length ? getApp() : initializeApp(firebaseConfig)
    ));
  }
  return appPromise;
}

export function useCloudAuth() {
  // 'unconfigured' (firebaseConfig.js encara té els valors de mostra) |
  // 'signed-out' | 'signing-in' | 'signed-in' | 'error'.
  const authStatus = ref(isCloudSyncConfigured() ? 'signed-out' : 'unconfigured');
  const currentUser = ref(null); // { uid, email } | null
  const lastAuthError = ref(null);

  let authModulePromise = null;
  function getAuthModule() {
    if (!authModulePromise) {
      authModulePromise = Promise.all([getFirebaseApp(), import('firebase/auth')]).then(([app, authMod]) => {
        const auth = authMod.getAuth(app);
        // Firebase ja persisteix la sessió al navegador de fàbrica
        // (IndexedDB) -- aquest listener és el que la restaura en silenci
        // en recarregar la pàgina, mateix criteri "reconnexió transparent,
        // sense cap clic" ja establert a la Fase 15 per a la sessió en viu.
        authMod.onAuthStateChanged(auth, (user) => {
          currentUser.value = user ? { uid: user.uid, email: user.email } : null;
          authStatus.value = user ? 'signed-in' : 'signed-out';
        });
        return { auth, authMod };
      });
    }
    return authModulePromise;
  }

  if (isCloudSyncConfigured()) {
    getAuthModule().catch((e) => {
      lastAuthError.value = e.message;
      authStatus.value = 'error';
    });
  }

  async function signIn(email, password) {
    if (!isCloudSyncConfigured()) {
      throw new Error("La sincronització al núvol encara no està configurada (cal omplir src/utils/firebaseConfig.js).");
    }
    authStatus.value = 'signing-in';
    lastAuthError.value = null;
    try {
      const { auth, authMod } = await getAuthModule();
      await authMod.signInWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged ja actualitza currentUser/authStatus -- no cal
      // fer-ho aquí també.
    } catch (e) {
      lastAuthError.value = e.message;
      authStatus.value = 'error';
      throw e;
    }
  }

  async function signOut() {
    const { auth, authMod } = await getAuthModule();
    await authMod.signOut(auth);
  }

  return { authStatus, currentUser, lastAuthError, signIn, signOut };
}
