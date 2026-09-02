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
import { computed } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

const store = useWorkspaceStore();

const currentStep = computed(() => {
  if (store.activeTab === 'upload') return 1;
  if (store.activeTab === 'data') return 2;
  if (store.activeTab === 'template') return 3;
  if (store.activeTab === 'preview' || store.activeTab === 'logs') return 4;
  return 1;
});

const isStep1Completed = computed(() => !!(store.excelFile && store.templateText));
const isStep2Completed = computed(() => !!store.excelJsonData);
const isStep3Completed = computed(() => store.templateText.trim().length > 0);
const isStep4Completed = computed(() => !!store.renderedMarkdown);

const setTab = (tab) => {
  store.setActiveTab(tab);
};
</script>

<template>
  <div class="stepper">
    <div class="step" :class="{ active: currentStep === 1, completed: isStep1Completed }" @click="setTab('upload')">
      <div class="step-num">1</div>
      <span>Carregar Fitxers</span>
    </div>
    
    <div class="step" :class="{ active: currentStep === 2, completed: isStep2Completed }" @click="setTab('data')">
      <div class="step-num">2</div>
      <span>Dades (Excel)</span>
    </div>
    
    <div class="step" :class="{ active: currentStep === 3, completed: isStep3Completed }" @click="setTab('template')">
      <div class="step-num">3</div>
      <span>Plantilla (Jinja2)</span>
    </div>
    
    <div class="step" :class="{ active: currentStep === 4, completed: isStep4Completed }" @click="setTab('preview')">
      <div class="step-num">4</div>
      <span>Previsualització i Generació</span>
    </div>
  </div>
</template>
