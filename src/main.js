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
export const autoAdjustTextareaHeight = (el) => {
  if (!el || el.tagName?.toLowerCase() !== 'textarea' || el.classList.contains('no-auto-grow')) return;
  
  // If element is hidden (in inactive tab), wait until visible
  if (el.offsetWidth === 0 && el.offsetHeight === 0) return;

  const scrollTop = el.scrollTop;
  // Reset style height to 1px temporarily to measure true scrollHeight
  el.style.height = '1px';
  const scrollH = el.scrollHeight;
  const targetH = Math.min(Math.max(scrollH + 2, 28), 200);
  el.style.height = `${targetH}px`;
  
  if (scrollH > 200) {
    el.style.overflowY = 'auto';
  } else {
    el.style.overflowY = 'hidden';
  }
  el.scrollTop = scrollTop;
};

// Intercept HTMLTextAreaElement.prototype.value setter so Vue v-model updates trigger height adjustment instantly!
try {
  const originalValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (originalValueSetter) {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
      set(val) {
        originalValueSetter.call(this, val);
        autoAdjustTextareaHeight(this);
      }
    });
  }
} catch (e) {
  console.warn("No s'ha pogut interceptar el setter de value per a textareas:", e);
}

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

// Immediate & continuous pass for textareas inside form representations
export const runGlobalAutoAdjust = () => {
  requestAnimationFrame(() => {
    document.querySelectorAll('textarea:not(.no-auto-grow)').forEach(autoAdjustTextareaHeight);
  });
};

const domObserver = new MutationObserver(() => {
  runGlobalAutoAdjust();
});
domObserver.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

// Run initial pass on window load & ready state
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runGlobalAutoAdjust);
} else {
  runGlobalAutoAdjust();
}

// Periodically check visible textareas during initial load to catch tab changes
setInterval(runGlobalAutoAdjust, 500);
