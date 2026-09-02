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
import { ref } from 'vue';

const props = defineProps({
  title: String,
  accept: String,
  helperText: String,
  file: File
});

const emit = defineEmits(['file-loaded', 'file-removed']);

const isDragover = ref(false);
const fileInputRef = ref(null);

const onCardClick = () => {
  fileInputRef.value.click();
};

const onFileChange = (e) => {
  if (e.target.files.length > 0) {
    emit('file-loaded', e.target.files[0]);
  }
};

const onDragOver = (e) => {
  isDragover.value = true;
};

const onDragLeave = () => {
  isDragover.value = false;
};

const onDrop = (e) => {
  isDragover.value = false;
  if (e.dataTransfer.files.length > 0) {
    emit('file-loaded', e.dataTransfer.files[0]);
  }
};

const onRemoveClick = (e) => {
  e.stopPropagation();
  fileInputRef.value.value = '';
  emit('file-removed');
};

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};
</script>

<template>
  <div 
    class="upload-card" 
    :class="{ 'success-state': file, 'dragover': isDragover }"
    @dragover.prevent="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
    @click="onCardClick"
  >
    <!-- Hidden input -->
    <input 
      type="file" 
      ref="fileInputRef" 
      :accept="accept" 
      style="display: none;" 
      @change="onFileChange"
    />
    
    <div class="upload-icon">
      <!-- Slot for Icon or standard SVG -->
      <slot name="icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-text"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
      </slot>
    </div>
    
    <p v-if="!file">{{ title }}</p>
    <p v-else>{{ file.name }} ({{ formatBytes(file.size) }})</p>
    
    <span v-if="!file">{{ helperText }}</span>
    <span v-else style="color: var(--color-success); font-weight: bold;">Carregat satisfactòriament</span>
    
    <!-- File Info Box with Delete Button -->
    <div class="file-info" v-if="file" @click.stop>
      <span class="file-info-name">{{ file.name }}</span>
      <button class="file-info-remove" @click="onRemoveClick" title="Elimina fitxer">&times;</button>
    </div>
  </div>
</template>
