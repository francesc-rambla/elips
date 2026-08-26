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

// Automatic form text field height adjustment helper (default 1 single line = 28px, max 200px)
const autoAdjustTextareaHeight = (el) => {
  if (!el || el.tagName?.toLowerCase() !== 'textarea' || el.classList.contains('no-auto-grow')) return;
  // Reset to 28px (single line height) to accurately calculate needed height
  el.style.height = '28px';
  const scrollH = el.scrollHeight;
  const targetH = Math.min(Math.max(scrollH, 28), 200);
  el.style.height = `${targetH}px`;
  if (scrollH > 200) {
    el.style.overflowY = 'auto';
  } else {
    el.style.overflowY = 'hidden';
  }
};

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

// Immediate & continuous DOM pass for textareas inside form representations without user interaction
const runGlobalAutoAdjust = () => {
  requestAnimationFrame(() => {
    document.querySelectorAll('textarea:not(.no-auto-grow)').forEach(autoAdjustTextareaHeight);
  });
};

const domObserver = new MutationObserver(() => {
  runGlobalAutoAdjust();
});
domObserver.observe(document.body, { childList: true, subtree: true });

// Run initial pass on window load & ready state
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runGlobalAutoAdjust);
} else {
  runGlobalAutoAdjust();
}
