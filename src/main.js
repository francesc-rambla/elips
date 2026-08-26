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

// Ultra-lightweight single-textarea auto-grow helper (zero reflow of other elements)
export const autoAdjustTextareaHeight = (el) => {
  if (!el || el.tagName?.toLowerCase() !== 'textarea' || el.classList.contains('no-auto-grow')) return;
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

// Event-driven single-element height adjustment on user input or focus (zero continuous polling)
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

// Run global auto adjust only on explicit tab switches or initial load
export const runGlobalAutoAdjust = () => {
  requestAnimationFrame(() => {
    document.querySelectorAll('textarea:not(.no-auto-grow)').forEach(autoAdjustTextareaHeight);
  });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runGlobalAutoAdjust);
} else {
  runGlobalAutoAdjust();
}
