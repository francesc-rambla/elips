<!--
  elips — Editor de LIcitacions PúbliqueS
  Copyright (C) 2026  Francesc Rambla i Marigot

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
-->

<script setup>
// Fase 21 (vegeu el pla): bombolla petita amb les inicials de qui, a la
// sessió en viu, té enfocat ara mateix aquest camp del model de dades --
// substitueix l'indicador anterior (una simple vora de color + `title`
// natiu de l'input, poc visible). Reutilitzat tal qual des de
// DataInspector.vue, NestedDataNode.vue i NestedItemForm.vue: cadascun
// només ha de posicionar un contenidor `position: relative` al voltant del
// camp i passar-hi `editors` (el resultat de `remoteEditorsFor(path)`,
// `{displayName, color}[]` -- `color` ve de `getUserColor`,
// useCollabIdentity.js, el mateix color estable per persona que ja fa
// servir el cursor remot de l'editor de plantilla, Fase 20).
defineProps({
  editors: { type: Array, default: () => [] }
});

const initialsFor = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
};
</script>

<template>
  <div
    v-if="editors.length > 0"
    class="remote-editing-badges"
    :title="editors.map((e) => e.displayName).join(', ')"
  >
    <span
      v-for="(e, i) in editors.slice(0, 3)"
      :key="i"
      class="remote-editing-badge"
      :style="{ background: e.color, zIndex: 10 - i, marginLeft: i > 0 ? '-8px' : '0' }"
    >{{ initialsFor(e.displayName) }}</span>
  </div>
</template>

<style scoped>
.remote-editing-badges {
  position: absolute;
  top: -8px;
  right: -6px;
  display: flex;
  align-items: center;
}
.remote-editing-badge {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: #fff;
  font-size: 0.58rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--bg-primary, #fff);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  line-height: 1;
  flex-shrink: 0;
}
</style>
