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

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './assets/base.css';
import 'katex/dist/katex.min.css';
import { useWorkspaceStore } from './stores/workspace';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.mount('#app');

// Expose Pinia store globally in window object for debugging in browser console
const store = useWorkspaceStore();
window.store = store;
window.__pinia = pinia;

window.dumpStore = () => {
  console.group('📌 estat de Pinia Store (workspace)');
  console.log('📊 excelJsonData:', JSON.parse(JSON.stringify(store.excelJsonData)));
  console.log('📐 hierarchySchema:', JSON.parse(JSON.stringify(store.hierarchySchema || {})));
  console.groupEnd();
  return store.excelJsonData;
};

// Ultra-lightweight single-textarea auto-grow helper (exclusively for data form fields)
export const autoAdjustTextareaHeight = (el) => {
  if (!el || el.tagName?.toLowerCase() !== 'textarea') return;
  // Exclusively target form schema data fields (.data-input or .data-textarea)
  if (!el.classList.contains('data-input') && !el.classList.contains('data-textarea')) return;
  if (el.classList.contains('no-auto-grow') || el.classList.contains('editor-textarea') || el.classList.contains('raw-textarea')) return;

  if (el.offsetWidth === 0 && el.offsetHeight === 0) return;

  const scrollTop = el.scrollTop;
  el.style.height = '28px';
  const scrollH = el.scrollHeight;
  const targetH = Math.min(Math.max(scrollH, 28), 200);
  el.style.height = `${targetH}px`;
  
  if (scrollH > 200) {
    el.style.overflowY = 'auto';
  } else {
    el.style.overflowY = 'hidden';
  }
  el.scrollTop = scrollTop;
};

// Event-driven single-element height adjustment on user input or focus for data fields
document.addEventListener('input', (e) => {
  if (e.target && e.target.tagName && e.target.tagName.toLowerCase() === 'textarea') {
    autoAdjustTextareaHeight(e.target);
  }
});

document.addEventListener('focusin', (e) => {
  if (e.target && e.target.tagName && e.target.tagName.toLowerCase() === 'textarea') {
    autoAdjustTextareaHeight(e.target);
  }
});

// Run global auto adjust only on form data textareas
export const runGlobalAutoAdjust = () => {
  requestAnimationFrame(() => {
    document.querySelectorAll('textarea.data-input, textarea.data-textarea').forEach(autoAdjustTextareaHeight);
  });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runGlobalAutoAdjust);
} else {
  runGlobalAutoAdjust();
}
