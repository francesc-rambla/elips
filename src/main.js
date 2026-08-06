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
  console.log('📐 hierarchySchema:', JSON.parse(JSON.stringify(store.hierarchySchema || store.excelJsonData?._hierarchy_schema || {})));
  console.groupEnd();
  return store.excelJsonData;
};
