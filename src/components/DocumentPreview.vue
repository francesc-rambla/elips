<script setup>
import { computed } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { marked } from 'marked';
import katex from 'katex';

const store = useWorkspaceStore();

const isGenerated = computed(() => !!store.renderedMarkdown);

const htmlContent = computed(() => {
  if (!store.renderedMarkdown) return '';
  try {
    let md = store.renderedMarkdown;
    
    // 1. Compile display math formulas (double dollars $$ ... $$)
    md = md.replace(/\$\$(.*?)\$\$/g, (m, expr) => {
      let render = '';
      try {
        render = katex.renderToString(expr, { displayMode: true, throwOnError: false });
      } catch (_) {
        render = expr;
      }
      return `<div class="latex-chip display-math" data-type="display" data-expr="${expr}">${render}</div>\n`;
    });
    
    // 2. Compile inline math formulas (single dollar $ ... $)
    md = md.replace(/\$(.*?)\$/g, (m, expr) => {
      let render = '';
      try {
        render = katex.renderToString(expr, { displayMode: false, throwOnError: false });
      } catch (_) {
        render = expr;
      }
      return `<span class="latex-chip inline-math" data-type="inline" data-expr="${expr}">${render}</span>`;
    });
    
    return marked.parse(md);
  } catch (e) {
    return `<span style="color:var(--color-danger)">Error parsejant Markdown: ${e.message}</span>`;
  }
});

const handlePreviewClick = (e) => {
  const link = e.target.closest('a');
  if (link) {
    const href = link.getAttribute('href') || link.hash;
    if (href && (href.startsWith('#dades.') || href.startsWith('#doc.') || href.startsWith('dades.') || href.startsWith('doc.'))) {
      e.preventDefault();
      store.navigateToDataPath(href);
    }
  }
};

const copyMd = () => {
  const text = store.cleanMarkdown || store.renderedMarkdown;
  if (!text) return;
  const el = document.createElement('textarea');
  el.value = text;
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
  store.addLog("Markdown copiat al porta-retalls!", 'success');
};
</script>

<template>
  <div class="preview-container">
    <!-- Visual HTML Rendering -->
    <div class="preview-pane">
      <div class="preview-header">
        <span>Document Formatat</span>
        <span style="font-size: 0.75rem; color: var(--color-success)">Previsualització HTML (Interactiva)</span>
      </div>
      
      <div class="preview-body markdown-preview" id="previewHtml" @click="handlePreviewClick">
        <div v-if="!isGenerated" style="text-align:center; padding:5rem 1rem; color:var(--text-muted)">
          <p>No hi ha cap document generat encara.</p>
          <p style="font-size:0.8rem; margin-top:0.5rem">Fes clic al botó "Genera Documents" al panell esquerre.</p>
        </div>
        <div v-else v-html="htmlContent"></div>
      </div>
    </div>
    
    <!-- Raw Markdown Text -->
    <div class="preview-pane">
      <div class="preview-header">
        <span>Codi Markdown (.md)</span>
        <button 
          v-if="isGenerated"
          class="btn-icon-only" 
          style="width:26px; height:26px;" 
          @click="copyMd"
          title="Copia tot el text net"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        </button>
      </div>
      <textarea 
        class="raw-textarea" 
        readonly 
        :value="store.cleanMarkdown || store.renderedMarkdown"
        placeholder="El markdown generat apareixerà aquí..."
      ></textarea>
    </div>
  </div>
</template>

<style>
.latex-chip {
  cursor: default;
  user-select: none;
}

.latex-chip.inline-math {
  display: inline-block;
  background-color: var(--color-warning-light);
  border: 1px solid var(--color-warning);
  color: #b45309;
  padding: 2px 6px;
  border-radius: 4px;
  margin: 0 4px;
}

.latex-chip.display-math {
  display: block;
  background-color: var(--color-warning-light);
  border: 2px solid var(--color-warning);
  color: #b45309;
  padding: 0.75rem;
  border-radius: 6px;
  margin: 1rem auto;
  text-align: center;
  width: fit-content;
  max-width: 90%;
}
</style>
