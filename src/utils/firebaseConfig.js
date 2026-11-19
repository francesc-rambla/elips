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
 * Configuració del projecte Firebase (Fase 24, sincronització al núvol --
 * veure .claude/plans/unified-nibbling-adleman.md). S'omple a mà des de la
 * consola de Firebase (console.firebase.google.com -> Configuració del
 * projecte -> Els teus apps -> app Web -> objecte `firebaseConfig`).
 *
 * Aquest objecte NO és secret: Firebase el dona per fet públic (qualsevol
 * app web l'exposa al navegador de totes maneres) -- la seguretat real recau
 * exclusivament en les Regles de Seguretat de Firestore (vegeu el pla,
 * secció "Regles de Seguretat de Firestore: autorització explícita per
 * projecte") i en l'Autenticació, mai en amagar aquests valors. Per això és
 * segur deixar-los tal qual al codi font d'aquest repositori, encara que
 * sigui públic.
 *
 * Mentre aquests valors siguin els de mostra ("CANVIA'M..."), la
 * sincronització al núvol queda inactiva (`isCloudSyncConfigured() ===
 * false`) -- useCloudAuth.js/useCloudSync.js ho comproven abans d'intentar
 * cap connexió, per no deixar una funcionalitat a mig configurar trencant
 * silenciosament res.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyDuboKf9Lkj527kpixJaqLGN9HIMMMBqYc",
  authDomain: "elips-ebf8b.firebaseapp.com",
  projectId: "elips-ebf8b",
  storageBucket: "elips-ebf8b.firebasestorage.app",
  messagingSenderId: "133045729264",
  appId: "1:133045729264:web:36d8a132b8081213c04f35",
};

export function isCloudSyncConfigured() {
  return !Object.values(firebaseConfig).some((v) => String(v).includes("CANVIA'M"));
}
