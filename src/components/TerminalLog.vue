<script setup>
import { watch, nextTick, ref } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

const store = useWorkspaceStore();
const terminalRef = ref(null);

// Automatically scroll console to bottom on new logs
watch(() => store.logs.length, () => {
  nextTick(() => {
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
    }
  });
});
</script>

<template>
  <div class="console-container">
    <div>
      <label>Terminal d'Execució</label>
      <div class="terminal-card" ref="terminalRef">
        <div 
          v-for="(log, idx) in store.logs" 
          :key="idx" 
          :class="`log-${log.type}`"
        >
          [{{ log.time }}] {{ log.text }}
        </div>
      </div>
    </div>
    
    <div>
      <label>Incidències i Validacions de la Plantilla</label>
      <div class="issues-panel">
        <div 
          v-if="store.issues.length === 0"
          style="background-color:var(--bg-tertiary); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:1.25rem; font-size:0.8rem; color:var(--text-secondary); display:flex; align-items:center; gap:0.5rem"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-success)"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
          <span>No s'ha detectat cap incidència de compilació en la plantilla.</span>
        </div>
        
        <div 
          v-else 
          v-for="(issue, idx) in store.issues" 
          :key="idx"
          class="issue-card warning"
        >
          <div class="issue-icon">⚠️</div>
          <div class="issue-details">
            <div class="issue-title">Variable Indefinida Detectada</div>
            <div class="issue-msg">{{ issue.message }}</div>
            <div class="issue-meta">Plantilla -> Línia {{ issue.line }} | Valor de substitució: &lt;&lt;{{ issue.key }}: sense dades&gt;&gt;</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
