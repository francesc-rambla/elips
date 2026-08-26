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

// Automatic form text field height adjustment helper (caps height at 200px with vertical scrollbar)
const autoAdjustTextareaHeight = (el) => {
  if (!el || el.tagName?.toLowerCase() !== 'textarea' || el.classList.contains('no-auto-grow')) return;
  el.style.height = 'auto';
  const targetH = Math.min(Math.max(el.scrollHeight + 2, 34), 200);
  el.style.height = `${targetH}px`;
  if (el.scrollHeight > 200) {
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

// Initial & dynamic DOM pass for textareas inside form representations
const domObserver = new MutationObserver(() => {
  document.querySelectorAll('textarea:not(.no-auto-grow)').forEach(autoAdjustTextareaHeight);
});
domObserver.observe(document.body, { childList: true, subtree: true });
