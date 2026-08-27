<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useWorkspaceStore } from './stores/workspace';
import { useWasmEngines } from './composables/useWasmEngines';
import { saveBinaryFile, getBinaryFile, deleteBinaryFile } from './utils/db';

import { useVersionHistory } from './composables/useVersionHistory';

// Components
import FileCard from './components/FileCard.vue';
import DataInspector from './components/DataInspector.vue';
import TemplateEditor from './components/TemplateEditor.vue';
import DocumentPreview from './components/DocumentPreview.vue';
import TerminalLog from './components/TerminalLog.vue';
import SettingsModal from './components/SettingsModal.vue';
import ExcelImportModal from './components/ExcelImportModal.vue';
import VersionHistoryModal from './components/VersionHistoryModal.vue';

const store = useWorkspaceStore();
const { initEngines, parseExcel, renderMarkdown, compileDocx, saveExcelData, saveExcelHierarchy, writeVirtualExcel, isLoading } = useWasmEngines();

const {
  historyData,
  isHistoryModalOpen,
  loadHistory,
  createSnapshot,
  recordChangeDiff,
  triggerDebouncedRecord,
  pauseAutoRecording,
  resumeAutoRecording,
  restoreVersion
} = useVersionHistory();

const isSettingsOpen = ref(false);
const isThemeDark = ref(localStorage.getItem('theme') === 'dark');
const isTerminalOpen = ref(false);

const isSidebarAutoHidden = ref(localStorage.getItem('sidebarAutoHidden') === 'true');
const isSidebarHovered = ref(false);

const toggleSidebarAutoHide = () => {
  isSidebarAutoHidden.value = !isSidebarAutoHidden.value;
  localStorage.setItem('sidebarAutoHidden', String(isSidebarAutoHidden.value));
  store.addLog(
    isSidebarAutoHidden.value 
      ? "Tauler de control configurat en mode Auto-amagat (situa el cursor a l'esquerra per obrir-lo)." 
      : "Tauler de control fixat a la vista.", 
    "info"
  );
};

const buildCode = ref(typeof __BUILD_CODE__ !== 'undefined' ? __BUILD_CODE__ : 'BUILD-DEV');

// Set light/dark theme classes and data-theme attribute
if (isThemeDark.value) {
  document.body.classList.add('dark-theme');
  document.body.setAttribute('data-theme', 'dark');
  document.documentElement.setAttribute('data-theme', 'dark');
}

const toggleTheme = () => {
  isThemeDark.value = !isThemeDark.value;
  if (isThemeDark.value) {
    document.body.classList.add('dark-theme');
    document.body.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  } else {
    document.body.classList.remove('dark-theme');
    document.body.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light');
  }
};

// Projects and Documents Management State
const currentProjectName = ref(localStorage.getItem('currentProjectName') || 'Default');
const savedProjectsList = ref(JSON.parse(localStorage.getItem('savedProjectsList') || '["Default"]'));
const isProjectsModalOpen = ref(false);

const activeDocName = ref(localStorage.getItem(`${currentProjectName.value}:activeDocName`) || 'Document Principal');
const documentsList = ref(JSON.parse(localStorage.getItem(`${currentProjectName.value}:documentsList`) || '["Document Principal"]'));

// Control Panel Internal Tabs ('downloads' | 'outline')
const controlPanelTab = ref('downloads');

const documentOutline = computed(() => {
  // Context A: Mode Plantilla (Plantilles / Template Editor)
  if (store.activeTab === 'template') {
    const rawText = store.templateText || '';
    if (!rawText) return [];
    
    const lines = rawText.split(/\r?\n/);
    const outline = [];
    let headingCount = 0;
    
    lines.forEach((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        const level = match[1].length;
        const rawTitle = match[2].trim();
        const hasVariables = /\{\{|\{%/.test(rawTitle);
        
        outline.push({
          id: `tpl-heading-${headingCount}`,
          index: headingCount,
          lineIndex: index,
          level,
          rawTitle,
          text: rawTitle,
          isTemplate: true,
          hasVariables
        });
        headingCount++;
      }
    });
    return outline;
  }
  
  // Context B: Mode Previsualització o altres pestanyes (Document renderitzat processat amb bucles expandits)
  const renderedText = store.cleanMarkdown || store.renderedMarkdown || store.templateText || '';
  if (!renderedText) return [];

  const lines = renderedText.split(/\r?\n/);
  const outline = [];
  let headingCount = 0;

  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const rawTitle = match[2].trim();
      
      let cleanText = rawTitle
        .replace(/<[^>]*>/g, '')
        .replace(/[*_~`]/g, '')
        .trim();
        
      if (!cleanText) cleanText = rawTitle;

      outline.push({
        id: `rendered-heading-${headingCount}`,
        index: headingCount,
        lineIndex: index,
        level,
        rawTitle,
        text: cleanText,
        isTemplate: false,
        hasVariables: false
      });
      headingCount++;
    }
  });

  return outline;
});

const scrollToHeading = (item) => {
  if (item.isTemplate || store.activeTab === 'template') {
    // Mode Plantilla: Desplaça el cursor directament a l'editor Monaco / Codi
    if (store.activeTab !== 'template') {
      store.activeTab = 'template';
    }
    setTimeout(() => {
      if (store.editorActions && typeof store.editorActions.scrollToLine === 'function') {
        store.editorActions.scrollToLine(item);
      }
    }, 100);
  } else {
    // Mode Previsualització: Desplaça la vista fins al títol processat a l'HTML
    if (store.activeTab !== 'preview') {
      store.activeTab = 'preview';
    }
    setTimeout(() => {
      const previewEl = document.getElementById('previewHtml');
      if (previewEl) {
        const headings = Array.from(previewEl.querySelectorAll('h1, h2, h3, h4, h5, h6, .metadata-card-title'));
        if (headings.length > 0) {
          let target = headings[item.index];
          if (!target) {
            target = headings.find(h => h.textContent.includes(item.text));
          }
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            target.classList.add('heading-highlight');
            setTimeout(() => {
              target.classList.remove('heading-highlight');
            }, 2000);
          }
        }
      }
    }, 120);
  }
};

const openProjectsModal = () => {
  savedProjectsList.value = JSON.parse(localStorage.getItem('savedProjectsList') || '["Default"]');
  isProjectsModalOpen.value = true;
};

const createNewProject = () => {
  const name = prompt("Introdueix el nom del nou projecte:");
  if (!name) return;
  const cleanName = name.trim();
  if (!cleanName) return;
  
  if (savedProjectsList.value.includes(cleanName)) {
    alert("Ja existeix un projecte amb aquest nom.");
    return;
  }

  pauseAutoRecording();
  if (window.__flushGlobalSave) window.__flushGlobalSave();
  
  // Save current project and active doc state before switching
  saveCurrentProject();
  saveCurrentDocumentState(currentProjectName.value, activeDocName.value);
  
  // Add to list
  const newList = [...savedProjectsList.value, cleanName];
  savedProjectsList.value = newList;
  localStorage.setItem('savedProjectsList', JSON.stringify(newList));
  
  // Clear Pinia store to start fresh
  store.clearLogs();
  store.excelJsonData = null;
  store.excelFileName = '';
  store.excelFileSize = 0;
  store.excelFile = null;
  store.editorMetadata = [];
  store.sheetInfo = [];
  store.hierarchySchema = {};
  store.issues = [];
  
  // Set as current project
  currentProjectName.value = cleanName;
  localStorage.setItem('currentProjectName', cleanName);
  
  // Initialize documents list for new project
  documentsList.value = ['Document Principal'];
  localStorage.setItem(`${cleanName}:documentsList`, JSON.stringify(['Document Principal']));
  activeDocName.value = 'Document Principal';
  localStorage.setItem(`${cleanName}:activeDocName`, 'Document Principal');
  
  // Load and save default blank states
  loadDocumentConfig(cleanName, 'Document Principal');
  saveCurrentProject();
  saveCurrentDocumentState(cleanName, 'Document Principal');
  
  // Initialize version history baseline for new project
  loadHistory();
  if (historyData.value.length === 0) {
    createSnapshot('init', 'Punt de control inicial del projecte');
  }

  resumeAutoRecording();
  isProjectsModalOpen.value = false;
  store.addLog(`Projecte '${cleanName}' creat i seleccionat correctament.`, 'success');
};

const loadProject = async (name) => {
  if (name === currentProjectName.value) {
    isProjectsModalOpen.value = false;
    return;
  }

  pauseAutoRecording();
  if (window.__flushGlobalSave) window.__flushGlobalSave();
  
  // Save current project and active doc state before switching
  saveCurrentProject();
  saveCurrentDocumentState(currentProjectName.value, activeDocName.value);
  
  currentProjectName.value = name;
  localStorage.setItem('currentProjectName', name);
  
  const list = localStorage.getItem(`${name}:documentsList`);
  documentsList.value = list ? JSON.parse(list) : ['Document Principal'];
  localStorage.setItem(`${name}:documentsList`, JSON.stringify(documentsList.value));
  
  const aDoc = localStorage.getItem(`${name}:activeDocName`) || 'Document Principal';
  activeDocName.value = aDoc;
  localStorage.setItem(`${name}:activeDocName`, aDoc);
  
  // Recover Excel fields & schemas from localStorage for this project
  const excelJsonData = localStorage.getItem(`${name}:excelJsonData`);
  const excelFileName = localStorage.getItem(`${name}:excelFileName`) || '';
  const excelFileSize = parseInt(localStorage.getItem(`${name}:excelFileSize`) || '0', 10);
  const editorMetadata = localStorage.getItem(`${name}:editorMetadata`);
  const sheetInfo = localStorage.getItem(`${name}:sheetInfo`);
  const hierarchySchema = localStorage.getItem(`${name}:hierarchySchema`);
  
  // Set Pinia store values
  store.excelJsonData = excelJsonData ? JSON.parse(excelJsonData) : null;
  store.excelFileName = excelFileName;
  store.excelFileSize = excelFileSize;
  store.editorMetadata = editorMetadata ? JSON.parse(editorMetadata) : [];
  store.sheetInfo = sheetInfo ? JSON.parse(sheetInfo) : [];
  store.hierarchySchema = hierarchySchema ? JSON.parse(hierarchySchema) : {};

  // Restore raw Excel File object from IndexedDB
  try {
    const excelBuf = await getBinaryFile(`${name}:excelFileBuffer`);
    if (excelBuf) {
      const fName = store.excelFileName || `${name}.xlsx`;
      store.excelFileName = fName;
      store.excelFileSize = excelBuf.byteLength;
      store.excelFile = new File([excelBuf], fName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      if (store.enginesReady) {
        writeVirtualExcel(excelBuf);
      }
    } else {
      store.excelFile = null;
      if (store.enginesReady && _pyodide) {
        try {
          if (_pyodide.FS.analyzePath('/work/in.xlsx').exists) {
            _pyodide.FS.unlink('/work/in.xlsx');
          }
          if (_pyodide.FS.analyzePath('/work/in.json').exists) {
            _pyodide.FS.unlink('/work/in.json');
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    console.warn("Error restaurant Excel des d'IndexedDB:", e);
    store.excelFile = null;
  }
  
  // Now load the active document configuration
  loadDocumentConfig(name, aDoc);

  // Load version history timeline for target project
  loadHistory();
  if (historyData.value.length === 0) {
    createSnapshot('init', 'Punt de control inicial de la sessió');
  }

  resumeAutoRecording();
  store.issues = [];
  store.addLog(`Projecte '${name}' carregat correctament amb ${documentsList.value.length} documents.`, 'success');
  isProjectsModalOpen.value = false;
};

const deleteProject = (name) => {
  if (name === 'Default') {
    alert("No es pot eliminar el projecte 'Default'.");
    return;
  }
  if (!confirm(`Segur que vols eliminar el projecte '${name}' i totes les seves dades del navegador?`)) {
    return;
  }
  
  // Clean localStorage keys
  const projDocs = JSON.parse(localStorage.getItem(`${name}:documentsList`) || '["Document Principal"]');
  projDocs.forEach(dName => {
    localStorage.removeItem(`${name}:doc:${dName}:templateText`);
    localStorage.removeItem(`${name}:doc:${dName}:templateFileName`);
    localStorage.removeItem(`${name}:doc:${dName}:templateFileSize`);
    localStorage.removeItem(`${name}:doc:${dName}:refDocFileName`);
    localStorage.removeItem(`${name}:doc:${dName}:refDocFileSize`);
    localStorage.removeItem(`${name}:doc:${dName}:refDocFileBase64`);
    localStorage.removeItem(`${name}:doc:${dName}:outNameDocx`);
    localStorage.removeItem(`${name}:doc:${dName}:outNameMd`);
  });
  localStorage.removeItem(`${name}:documentsList`);
  localStorage.removeItem(`${name}:activeDocName`);
  
  localStorage.removeItem(`${name}:excelJsonData`);
  localStorage.removeItem(`${name}:excelFileName`);
  localStorage.removeItem(`${name}:excelFileSize`);
  localStorage.removeItem(`${name}:excelFileBase64`);
  localStorage.removeItem(`${name}:editorMetadata`);
  localStorage.removeItem(`${name}:sheetInfo`);
  localStorage.removeItem(`${name}:hierarchySchema`);
  localStorage.removeItem(`${name}:version_history_v1`);
  
  // Remove from list
  const newList = savedProjectsList.value.filter(x => x !== name);
  savedProjectsList.value = newList;
  localStorage.setItem('savedProjectsList', JSON.stringify(newList));
  
  // If the active project was deleted, switch back to Default
  if (currentProjectName.value === name) {
    loadProject('Default');
  }
  
  store.addLog(`Projecte '${name}' eliminat.`, 'info');
};

const lastSavedStateCache = new Map();

const setItemIfChanged = (key, value) => {
  const strVal = value !== null && value !== undefined ? String(value) : '';
  if (lastSavedStateCache.get(key) !== strVal) {
    localStorage.setItem(key, strVal);
    lastSavedStateCache.set(key, strVal);
  }
};

const removeItemIfExist = (key) => {
  if (localStorage.getItem(key) !== null || lastSavedStateCache.has(key)) {
    localStorage.removeItem(key);
    lastSavedStateCache.delete(key);
  }
};

const saveCurrentProject = () => {
  const name = currentProjectName.value;
  if (!name) return;
  
  if (store.excelJsonData) {
    setItemIfChanged(`${name}:excelJsonData`, JSON.stringify(store.excelJsonData));
  } else {
    removeItemIfExist(`${name}:excelJsonData`);
  }
  setItemIfChanged(`${name}:excelFileName`, store.excelFileName || '');
  setItemIfChanged(`${name}:excelFileSize`, store.excelFileSize || '0');
  setItemIfChanged(`${name}:editorMetadata`, JSON.stringify(store.editorMetadata || []));
  setItemIfChanged(`${name}:sheetInfo`, JSON.stringify(store.sheetInfo || []));
  setItemIfChanged(`${name}:hierarchySchema`, JSON.stringify(store.hierarchySchema || {}));
};

const loadDocumentConfig = (pName, dName) => {
  const templateText = localStorage.getItem(`${pName}:doc:${dName}:templateText`) || '';
  const templateFileName = localStorage.getItem(`${pName}:doc:${dName}:templateFileName`) || '';
  const templateFileSize = parseInt(localStorage.getItem(`${pName}:doc:${dName}:templateFileSize`) || '0', 10);
  
  const refDocFileName = localStorage.getItem(`${pName}:doc:${dName}:refDocFileName`) || '';
  const refDocFileSize = parseInt(localStorage.getItem(`${pName}:doc:${dName}:refDocFileSize`) || '0', 10);
  const refB64 = localStorage.getItem(`${pName}:doc:${dName}:refDocFileBase64`);
  
  const outNameDocx = localStorage.getItem(`${pName}:doc:${dName}:outNameDocx`) || 'memoria_justificativa.docx';
  const outNameMd = localStorage.getItem(`${pName}:doc:${dName}:outNameMd`) || 'memoria_justificativa.md';
  
  // Set store states
  store.templateText = templateText;
  store.templateFileName = templateFileName;
  store.templateFileSize = templateFileSize;
  if (templateFileName && templateText) {
    store.templateFile = new File([templateText], templateFileName, { type: 'text/markdown' });
  } else {
    store.templateFile = null;
  }
  
  store.refDocFileName = refDocFileName;
  store.refDocFileSize = refDocFileSize;
  if (refB64) {
    try {
      store.refDocFile = dataURLtoFile(refB64, refDocFileName);
    } catch (_) {
      store.refDocFile = null;
    }
  } else {
    store.refDocFile = null;
  }

  // Asynchronously attempt IndexedDB binary restore for refDocFile
  getBinaryFile(`${pName}:doc:${dName}:refDocBuffer`).then((buf) => {
    if (buf && refDocFileName) {
      store.refDocFile = new File([buf], refDocFileName, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }
  }).catch(() => {});
  
  store.outNameDocx = outNameDocx;
  store.outNameMd = outNameMd;
  store.renderedMarkdown = '';
};

const switchActiveDocument = (newDocName) => {
  const pName = currentProjectName.value;
  const oldDocName = activeDocName.value;
  
  // 1. Save current document state first
  saveCurrentDocumentState(pName, oldDocName);
  
  // 2. Set new document name
  activeDocName.value = newDocName;
  localStorage.setItem(`${pName}:activeDocName`, newDocName);
  
  // 3. Load document state
  loadDocumentConfig(pName, newDocName);
  
  store.addLog(`S'ha canviat al document '${newDocName}'.`, 'info');
};

const saveCurrentDocumentState = (pName, dName) => {
  if (!pName || !dName) return;
  
  setItemIfChanged(`${pName}:doc:${dName}:templateText`, store.templateText || '');
  setItemIfChanged(`${pName}:doc:${dName}:templateFileName`, store.templateFileName || '');
  setItemIfChanged(`${pName}:doc:${dName}:templateFileSize`, store.templateFileSize || '0');
  
  setItemIfChanged(`${pName}:doc:${dName}:refDocFileName`, store.refDocFileName || '');
  setItemIfChanged(`${pName}:doc:${dName}:refDocFileSize`, store.refDocFileSize || '0');
  
  setItemIfChanged(`${pName}:doc:${dName}:outNameDocx`, store.outNameDocx || '');
  setItemIfChanged(`${pName}:doc:${dName}:outNameMd`, store.outNameMd || '');
  
  if (store.refDocFile) {
    store.refDocFile.arrayBuffer().then((buf) => {
      saveBinaryFile(`${pName}:doc:${dName}:refDocBuffer`, buf);
    }).catch(() => {});
  } else {
    deleteBinaryFile(`${pName}:doc:${dName}:refDocBuffer`);
    removeItemIfExist(`${pName}:doc:${dName}:refDocFileBase64`);
  }
};

const createNewDocument = () => {
  const name = prompt("Introdueix el nom del nou document (ex: Plec de Clàusules):");
  if (!name) return;
  const cleanName = name.trim();
  if (!cleanName) return;
  
  if (documentsList.value.includes(cleanName)) {
    alert("Ja existeix un document amb aquest nom en aquest projecte.");
    return;
  }
  
  const pName = currentProjectName.value;
  
  // Save current active doc state
  saveCurrentDocumentState(pName, activeDocName.value);
  
  // Update list
  const newList = [...documentsList.value, cleanName];
  documentsList.value = newList;
  localStorage.setItem(`${pName}:documentsList`, JSON.stringify(newList));
  
  // Set default blank state for new document
  localStorage.setItem(`${pName}:doc:${cleanName}:templateText`, '');
  localStorage.setItem(`${pName}:doc:${cleanName}:templateFileName`, '');
  localStorage.setItem(`${pName}:doc:${cleanName}:templateFileSize`, '0');
  localStorage.setItem(`${pName}:doc:${cleanName}:refDocFileName`, '');
  localStorage.setItem(`${pName}:doc:${cleanName}:refDocFileSize`, '0');
  
  const defaultFileBase = cleanName.toLowerCase().replace(/\s+/g, '_');
  localStorage.setItem(`${pName}:doc:${cleanName}:outNameDocx`, `${defaultFileBase}.docx`);
  localStorage.setItem(`${pName}:doc:${cleanName}:outNameMd`, `${defaultFileBase}.md`);
  
  // Switch to it
  activeDocName.value = cleanName;
  localStorage.setItem(`${pName}:activeDocName`, cleanName);
  loadDocumentConfig(pName, cleanName);
  
  store.addLog(`Document '${cleanName}' creat correctament.`, 'success');
};

const deleteDocument = (dName) => {
  if (dName === 'Document Principal') {
    alert("No es pot eliminar el 'Document Principal'.");
    return;
  }
  if (!confirm(`Segur que vols eliminar el document '${dName}' i tots els seus fitxers associats (plantilla i referència) d'aquest projecte?`)) {
    return;
  }
  
  const pName = currentProjectName.value;
  
  // Clean localStorage
  localStorage.removeItem(`${pName}:doc:${dName}:templateText`);
  localStorage.removeItem(`${pName}:doc:${dName}:templateFileName`);
  localStorage.removeItem(`${pName}:doc:${dName}:templateFileSize`);
  localStorage.removeItem(`${pName}:doc:${dName}:refDocFileName`);
  localStorage.removeItem(`${pName}:doc:${dName}:refDocFileSize`);
  localStorage.removeItem(`${pName}:doc:${dName}:refDocFileBase64`);
  localStorage.removeItem(`${pName}:doc:${dName}:outNameDocx`);
  localStorage.removeItem(`${pName}:doc:${dName}:outNameMd`);
  
  // Update list
  const newList = documentsList.value.filter(x => x !== dName);
  documentsList.value = newList;
  localStorage.setItem(`${pName}:documentsList`, JSON.stringify(newList));
  
  // If active was deleted, switch back to Document Principal
  if (activeDocName.value === dName) {
    activeDocName.value = 'Document Principal';
    localStorage.setItem(`${pName}:activeDocName`, 'Document Principal');
    loadDocumentConfig(pName, 'Document Principal');
  }
  
  store.addLog(`Document '${dName}' eliminat d'aquest projecte.`, 'info');
};

const saveStatus = ref('saved'); // 'saved', 'modified', 'saving'
let autoSaveTimer = null;

const executeSave = () => {
  const pName = currentProjectName.value;
  const dName = activeDocName.value;
  if (!pName || !dName) return;

  saveStatus.value = 'saving';

  // Save shared project state
  saveCurrentProject();

  // Save active document state
  saveCurrentDocumentState(pName, dName);

  setTimeout(() => {
    saveStatus.value = 'saved';
  }, 250);
};

const manualSave = () => {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  executeSave();
  store.addLog(`✓ Canvis del document '${activeDocName.value}' desats correctament a la sessió local.`, 'success');
};

// Autodesat / Persistència en LocalStorage via Pinia Subscription amb temporitzador configurable (per defecte 5 segons)
store.$subscribe((mutation, state) => {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  const delayMs = Math.max(1, (store.config?.autoSaveDebounceSeconds || 5)) * 1000;
  autoSaveTimer = setTimeout(() => {
    saveStatus.value = 'modified';
    executeSave();
    autoSaveTimer = null;
  }, delayMs);
}, { detached: true });

window.__flushGlobalSave = () => {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  executeSave();
};

// Watch main active tab & isMaximized to persist
watch(() => store.activeTab, (newTab) => {
  const pName = currentProjectName.value;
  if (pName) {
    localStorage.setItem(`${pName}:activeTab`, newTab);
  }
});

watch(() => store.isMaximized, (newMax) => {
  const pName = currentProjectName.value;
  if (pName) {
    localStorage.setItem(`${pName}:isMaximized`, newMax ? 'true' : 'false');
  }
});

import JSZip from 'jszip';

const watchExcelFile = watch(() => store.excelFile, (newFile) => {
  const name = currentProjectName.value;
  if (!newFile && name) {
    localStorage.removeItem(`${name}:excelFileBase64`);
  }
});
const watchRefDocFile = watch(() => store.refDocFile, (newFile) => {
  const pName = currentProjectName.value;
  const dName = activeDocName.value;
  if (!newFile && pName && dName) {
    localStorage.removeItem(`${pName}:doc:${dName}:refDocFileBase64`);
  }
});

// Watch Excel JSON data reference changes for embedded editor_metadata sheet configs and hierarchy schema
watch(() => store.excelJsonData, (newVal) => {
  if (newVal) {
    if (newVal.editor_metadata) {
      store.editorMetadata = newVal.editor_metadata;
      delete newVal.editor_metadata;
    }
    if (newVal._sheet_info) {
      store.sheetInfo = newVal._sheet_info;
      delete newVal._sheet_info;
    }
    if (newVal._hierarchy_schema) {
      delete newVal._hierarchy_schema;
    }
  }
}, { immediate: true });

watch(() => store.hierarchySchema, (newSchema) => {
  if (newSchema && typeof newSchema === 'object' && Object.keys(newSchema).length > 0) {
    const pName = localStorage.getItem('currentProjectName') || 'Default';
    localStorage.setItem(`${pName}:hierarchySchema`, JSON.stringify(newSchema));
  }
}, { immediate: true, deep: true });

// Convert Base64 data URL back to a File object
const dataURLtoFile = (dataurl, filename) => {
  const arr = dataurl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new File([u8arr], filename, { type: mime });
};

const triggerDownload = (url, filename) => {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Export entire project into a portable ZIP archive
const downloadAllProjectFiles = async () => {
  const pName = currentProjectName.value || 'projecte';
  store.addLog(`Generant paquet ZIP complet del projecte '${pName}'...`, 'info');
  
  try {
    const zip = new JSZip();
    
    // 1. Manifest file with project structure
    const manifest = {
      projectName: pName,
      activeDocName: activeDocName.value,
      documentsList: documentsList.value,
      excelFileName: store.excelFileName || `${pName}.xlsx`,
      created: new Date().toISOString()
    };
    zip.file("project.json", JSON.stringify(manifest, null, 2));

    // 2. Export updated Excel file (.xlsx) into the ZIP archive
    const xFileName = store.excelFileName || `${pName}.xlsx`;
    try {
      if (store.enginesReady && store.excelJsonData) {
        store.addLog("Generant fitxer Excel (.xlsx) actualitzat per al paquet ZIP...", "info");
        const excelBlob = await saveExcelData(store.excelJsonData);
        const excelBuffer = await excelBlob.arrayBuffer();
        zip.file(xFileName, excelBuffer);
      } else if (store.excelFile) {
        const excelBuffer = await store.excelFile.arrayBuffer();
        zip.file(xFileName, excelBuffer);
      } else if (store.excelJsonData) {
        zip.file("dades_excel.json", JSON.stringify(store.excelJsonData, null, 2));
      }
    } catch (e) {
      store.addLog(`Avís en incloure Excel al ZIP: ${e.message}`, 'warning');
      if (store.excelJsonData) {
        zip.file("dades_excel.json", JSON.stringify(store.excelJsonData, null, 2));
      }
    }

    // 3. Add all Documents (.md.j2 templates & .docx reference files)
    const docsFolder = zip.folder("documents");
    for (const docName of documentsList.value) {
      const cleanDocName = docName.replace(/[/\\?%*:|"<>]/g, '_');
      const tText = localStorage.getItem(`${pName}:doc:${docName}:templateText`);
      const tFileName = localStorage.getItem(`${pName}:doc:${docName}:templateFileName`) || `${cleanDocName}.md.j2`;
      const rFileName = localStorage.getItem(`${pName}:doc:${docName}:refDocFileName`);
      const rB64 = localStorage.getItem(`${pName}:doc:${docName}:refDocFileBase64`);

      if (tText !== null && tText !== undefined) {
        docsFolder.file(tFileName, tText);
      }

      if (rB64 && rFileName) {
        const arr = rB64.split(',');
        const bstr = atob(arr[1] || arr[0]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
          u8arr[n] = bstr.charCodeAt(n);
        }
        docsFolder.file(rFileName, u8arr);
      }
    }

    // Generate and trigger download of the ZIP file
    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    triggerDownload(url, `projecte_${pName}.zip`);
    store.addLog(`Paquet ZIP del projecte '${pName}' descarregat satisfactòriament.`, 'success');
  } catch (err) {
    store.addLog(`Error al generar el paquet ZIP del projecte: ${err.message}`, 'error');
    alert(`Error al generar el paquet ZIP: ${err.message}`);
  }
};

// Import a complete project from a uploaded ZIP archive
const importProjectZip = async (file) => {
  store.addLog(`Descomprimint i restaurant projecte des del fitxer ZIP '${file.name}'...`, 'info');
  try {
    const zip = await JSZip.loadAsync(file);
    
    const manifestFile = zip.file("project.json");
    let manifest = {};
    if (manifestFile) {
      const text = await manifestFile.async("string");
      manifest = JSON.parse(text);
    }

    let pName = manifest.projectName || file.name.replace(/\.zip$/i, '');
    pName = pName.replace(/[^a-zA-Z0-9_\-\s]/g, '_');

    if (!savedProjectsList.value.includes(pName)) {
      savedProjectsList.value.push(pName);
      localStorage.setItem('savedProjectsList', JSON.stringify(savedProjectsList.value));
    }
    currentProjectName.value = pName;
    localStorage.setItem('currentProjectName', pName);

    const docsList = manifest.documentsList || ['Document Principal'];
    documentsList.value = docsList;
    localStorage.setItem(`${pName}:documentsList`, JSON.stringify(docsList));

    const aDoc = manifest.activeDocName || docsList[0] || 'Document Principal';
    activeDocName.value = aDoc;
    localStorage.setItem(`${pName}:activeDocName`, aDoc);

    // Process Excel spreadsheet if included
    const excelFiles = Object.keys(zip.files).filter(f => f.endsWith('.xlsx') && !f.startsWith('__MACOSX'));
    if (excelFiles.length > 0) {
      const xFileName = excelFiles[0];
      const blob = await zip.files[xFileName].async("blob");
      const excelFileObj = new File([blob], xFileName, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      await processExcelFile(excelFileObj);
    } else {
      const jsonFile = zip.file("dades_excel.json");
      if (jsonFile) {
        const jText = await jsonFile.async("string");
        store.excelJsonData = JSON.parse(jText);
        localStorage.setItem(`${pName}:excelJsonData`, jText);
      }
    }

    // Extract Templates and Reference DOCX files
    for (const docName of docsList) {
      const cleanDocName = docName.replace(/[/\\?%*:|"<>]/g, '_');
      
      let tFile = zip.file(`documents/${cleanDocName}.md.j2`) || zip.file(`documents/${docName}.md.j2`);
      if (!tFile) {
        const matches = Object.keys(zip.files).filter(f => f.startsWith('documents/') && (f.endsWith('.md.j2') || f.endsWith('.j2') || f.endsWith('.md')));
        if (matches.length > 0) tFile = zip.files[matches[0]];
      }

      if (tFile) {
        const tContent = await tFile.async("string");
        localStorage.setItem(`${pName}:doc:${docName}:templateText`, tContent);
        localStorage.setItem(`${pName}:doc:${docName}:templateFileName`, tFile.name.split('/').pop());
      }

      const refMatches = Object.keys(zip.files).filter(f => f.startsWith('documents/') && f.endsWith('.docx'));
      if (refMatches.length > 0) {
        const rFile = zip.files[refMatches[0]];
        const rBlob = await rFile.async("blob");
        const reader = new FileReader();
        reader.onload = (e) => {
          localStorage.setItem(`${pName}:doc:${docName}:refDocFileBase64`, e.target.result);
          localStorage.setItem(`${pName}:doc:${docName}:refDocFileName`, rFile.name.split('/').pop());
        };
        reader.readAsDataURL(rBlob);
      }
    }

    loadDocumentConfig(pName, aDoc);
    store.addLog(`Projecte '${pName}' restaurat correctament des del fitxer ZIP.`, 'success');
    alert(`El projecte '${pName}' s'ha carregat i restaurat satisfactòriament!`);
  } catch (err) {
    store.addLog(`Error al carregar el paquet ZIP: ${err.message}`, 'error');
    alert(`Error al carregar el paquet ZIP del projecte: ${err.message}`);
  }
};

onMounted(async () => {
  // Ensure default project is loaded if it's the first run
  if (!savedProjectsList.value.includes(currentProjectName.value)) {
    currentProjectName.value = 'Default';
    localStorage.setItem('currentProjectName', 'Default');
  }
  
  const pName = currentProjectName.value;
  
  // Load documents list and active document name
  const list = localStorage.getItem(`${pName}:documentsList`);
  documentsList.value = list ? JSON.parse(list) : ['Document Principal'];
  localStorage.setItem(`${pName}:documentsList`, JSON.stringify(documentsList.value));
  
  const aDoc = localStorage.getItem(`${pName}:activeDocName`) || 'Document Principal';
  activeDocName.value = aDoc;
  localStorage.setItem(`${pName}:activeDocName`, aDoc);
  
  // Restore active document states immediately (template text, ref document)
  loadDocumentConfig(pName, aDoc);
  
  // Restore Excel fields for current project
  const excelFileName = localStorage.getItem(`${pName}:excelFileName`) || '';
  const excelFileSize = parseInt(localStorage.getItem(`${pName}:excelFileSize`) || '0', 10);
  store.excelFileName = excelFileName;
  store.excelFileSize = excelFileSize;

  // Restore Excel sheets JSON data
  const excelJsonData = localStorage.getItem(`${pName}:excelJsonData`);
  if (excelJsonData) {
    try {
      store.excelJsonData = JSON.parse(excelJsonData);
    } catch (_) {}
  }
  
  const editorMetadata = localStorage.getItem(`${pName}:editorMetadata`);
  if (editorMetadata) {
    try {
      store.editorMetadata = JSON.parse(editorMetadata);
    } catch (_) {}
  }

  // Restore active document states (template text, ref document)
  loadDocumentConfig(pName, aDoc);

  // Restore raw Excel File object from IndexedDB
  try {
    const excelBuf = await getBinaryFile(`${pName}:excelFileBuffer`);
    if (excelBuf) {
      const fName = store.excelFileName || `${pName}.xlsx`;
      store.excelFileName = fName;
      store.excelFileSize = excelBuf.byteLength;
      const file = new File([excelBuf], fName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      store.excelFile = file;
      if (store.enginesReady) {
        writeVirtualExcel(excelBuf);
      }
    }
  } catch (e) {
    console.warn("Error restaurant Excel des d'IndexedDB:", e);
  }

  if (store.excelJsonData || store.templateText) {
    store.addLog(`Projecte '${pName}' restaurat correctament amb el document '${aDoc}'.`, "success");
  }
  
  // Tecles de drecera (Ctrl+S per desar manualment)
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      manualSave();
    }
  });

  // Autodesat abans de tancar o recarregar la pestanya
  window.addEventListener('beforeunload', () => {
    if (currentProjectName.value && activeDocName.value) {
      saveCurrentProject();
      saveCurrentDocumentState(currentProjectName.value, activeDocName.value);
    }
  });

  window.__openExcelHierarchyModal = openHierarchyModal;
  window.__openVersionHistoryModal = () => { isHistoryModalOpen.value = true; };

  // Version History Initialization & Automatic Hourly Checkpoint Tracking
  loadHistory();
  if (historyData.value.length === 0) {
    createSnapshot('init', 'Punt de control inicial de la sessió');
  }

  // Periodic hourly check timer (every 5 minutes check if 1 hour has elapsed)
  setInterval(() => {
    recordChangeDiff('Comprovació automàtica horària');
  }, 300000);

  // Watchers for automatic change differential recording (debounced by autoSaveDebounceSeconds)
  watch(() => store.templateText, () => {
    triggerDebouncedRecord('Modificació a la plantilla Jinja2');
  });
  watch(() => store.excelJsonData, () => {
    triggerDebouncedRecord('Modificació a les dades del model Excel');
  });
  watch(() => store.editorMetadata, () => {
    triggerDebouncedRecord('Modificació a l\'esquema de metadades');
  });

  // Inicialitza automàticament els motors WASM al carregar la pàgina
  try {
    await initEngines();
  } catch (err) {
    isTerminalOpen.value = true;
  }
});

const showWarningModal = ref(false);
const pendingFile = ref(null);
const isDownloadingExcel = ref(false);

const closeWarning = () => {
  showWarningModal.value = false;
  pendingFile.value = null;
};

const confirmOverwrite = async () => {
  if (pendingFile.value) {
    await processExcelFile(pendingFile.value);
  }
  showWarningModal.value = false;
  pendingFile.value = null;
};

const downloadBackupJson = () => {
  const jsonStr = JSON.stringify(store.excelJsonData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `copia_seguretat_dades_${store.excelFileName.replace('.xlsx', '') || 'contractes'}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  store.addLog("Còpia de seguretat en format JSON descarregada correctament.", "success");
};

const downloadBackupExcel = async () => {
  if (isDownloadingExcel.value) return;
  isDownloadingExcel.value = true;
  try {
    store.addLog("Generant fitxer Excel de còpia de seguretat...", "info");
    const blob = await saveExcelData(store.excelJsonData);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = store.excelFileName || 'fitxer_modificat.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    store.addLog("Còpia de seguretat en format Excel descarregada correctament.", "success");
  } catch (err) {
    store.addLog(`Error al generar còpia de seguretat Excel: ${err.message}`, "error");
    alert(`Error al generar còpia de seguretat Excel: ${err.message}`);
  } finally {
    isDownloadingExcel.value = false;
  }
};

const bindExcelAsTemplateOnly = async (file) => {
  if (!file) return;
  store.setExcelFile(file);
  const buffer = await file.arrayBuffer();
  const pName = currentProjectName.value || 'Default';
  
  // Save raw ArrayBuffer in IndexedDB
  await saveBinaryFile(`${pName}:excelFileBuffer`, buffer);
  saveCurrentProject();
  
  if (store.enginesReady) {
    try {
      writeVirtualExcel(buffer);
      store.addLog(`Fitxer Excel plantilla '${file.name}' vinculat satisfactòriament. S'han conservat intactes totes les dades del projecte.`, "success");
    } catch (e) {
      console.warn("Error escrivint virtual FS in.xlsx:", e);
    }
  }
  showWarningModal.value = false;
  pendingFile.value = null;
};

const isHierarchyModalOpen = ref(false);
const hierarchyRows = ref([]);
const savingHierarchy = ref(false);

const getRowHeaders = (row) => {
  if (row.headers && row.headers.length > 0) return row.headers;
  if (!store.excelJsonData) return [];
  const fullPath = row.parent_path ? `${row.parent_path}.${row.clean_name}` : row.clean_name;
  const data = store.excelJsonData[fullPath] || store.excelJsonData[row.raw_name];
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
    return Object.keys(data[0]);
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    return Object.keys(data);
  }
  return [];
};

const getParentHeadersFor = (row) => {
  if (!row.parent_path) return [];
  const parentRow = hierarchyRows.value.find(p => {
    const pFull = p.parent_path ? `${p.parent_path}.${p.clean_name}` : p.clean_name;
    return pFull === row.parent_path;
  });
  return parentRow ? getRowHeaders(parentRow) : [];
};

const openHierarchyModal = () => {
  if (!store.excelJsonData) {
    alert("Primer heu de carregar un fitxer Excel.");
    return;
  }
  const infoList = store.sheetInfo && store.sheetInfo.length > 0 ? store.sheetInfo : (store.excelJsonData ? store.excelJsonData._sheet_info : null);
  if (infoList && Array.isArray(infoList)) {
    hierarchyRows.value = infoList.map(item => ({
      raw_name: item.raw_name,
      prefix: item.prefix || '',
      clean_name: item.clean_name || '',
      parent_path: item.parent_path || '',
      kind: item.kind || 'tabular',
      headers: item.headers || [],
      parent_ref_key: item.parent_ref_key || '',
      child_ref_key: item.child_ref_key || ''
    }));
  } else {
    const keys = Object.keys(store.excelJsonData).filter(k => k !== 'editor_metadata' && k !== '_hierarchy_schema' && k !== '_sheet_info');
    hierarchyRows.value = keys.map(k => {
      const parts = k.split('.');
      return {
        raw_name: k,
        prefix: k.toUpperCase().startsWith('OUT_') ? 'OUT_' : '',
        clean_name: parts[parts.length - 1],
        parent_path: parts.slice(0, -1).join('.'),
        kind: Array.isArray(store.excelJsonData[k]) ? 'tabular' : 'kv',
        headers: [],
        parent_ref_key: '',
        child_ref_key: ''
      };
    });
  }

  // Auto-detect default parent and child ref keys if not explicitly set
  hierarchyRows.value.forEach(row => {
    if (row.parent_path) {
      const parentRow = hierarchyRows.value.find(p => {
        const pFull = p.parent_path ? `${p.parent_path}.${p.clean_name}` : p.clean_name;
        return pFull === row.parent_path;
      });
      
      if (parentRow) {
        const parentHeaders = getRowHeaders(parentRow);
        const childHeaders = row.headers || [];
        
        if (!row.parent_ref_key && parentHeaders.length > 0) {
          const common = childHeaders.filter(ch => parentHeaders.includes(ch));
          const idCommon = common.filter(ch => ['id', 'codi', 'code', 'ref', 'key', 'num'].some(t => ch.toLowerCase().includes(t)));
          row.parent_ref_key = idCommon[0] || common[0] || parentHeaders[0] || '';
        }
        if (!row.child_ref_key && childHeaders.length > 0) {
          if (childHeaders.includes(row.parent_ref_key)) {
            row.child_ref_key = row.parent_ref_key;
          } else {
            const common = childHeaders.filter(ch => parentHeaders.includes(ch));
            const idCommon = common.filter(ch => ['id', 'codi', 'code', 'ref', 'key', 'num'].some(t => ch.toLowerCase().includes(t)));
            row.child_ref_key = idCommon[0] || common[0] || childHeaders[0] || '';
          }
        }
      }
    }
  });

  isHierarchyModalOpen.value = true;
};

const getAvailableParents = (currentRawName) => {
  return hierarchyRows.value
    .filter(row => row.raw_name !== currentRawName)
    .map(row => {
      const full = row.parent_path ? `${row.parent_path}.${row.clean_name}` : row.clean_name;
      return {
        path: full,
        label: `${row.clean_name} (${full})`
      };
    });
};

const computeJinjaPath = (row) => {
  if (!row.clean_name) return '';
  return row.parent_path ? `${row.parent_path}.${row.clean_name}` : row.clean_name;
};

const applyHierarchyChanges = async () => {
  savingHierarchy.value = true;
  try {
    const renamesMap = {};
    const customKeysMap = {};

    for (const item of hierarchyRows.value) {
      const fullPath = item.parent_path ? `${item.parent_path}.${item.clean_name}` : item.clean_name;
      const expectedRaw = item.prefix ? `${item.prefix}${fullPath}` : fullPath;
      if (expectedRaw !== item.raw_name) {
        renamesMap[item.raw_name] = expectedRaw;
      }

      if (item.parent_path && item.parent_ref_key && item.child_ref_key) {
        customKeysMap[fullPath] = {
          parent_key: item.parent_ref_key,
          child_key: item.child_ref_key
        };
      }
    }
    
    const configPayload = {
      renames: renamesMap,
      custom_keys: customKeysMap
    };

    await saveExcelHierarchy(configPayload);
    saveCurrentProject();
    store.addLog("S'ha desat la nova jerarquia i les relacions de columnes pare-fill a l'Excel.", "success");
    isHierarchyModalOpen.value = false;
  } catch (e) {
    store.addLog(`Error desant la jerarquia de l'Excel: ${e.message}`, "error");
    alert(`Error desant la jerarquia de l'Excel: ${e.message}`);
  } finally {
    savingHierarchy.value = false;
  }
};

const processExcelFile = async (file) => {
  store.setExcelFile(file);
  const buffer = await file.arrayBuffer();
  const pName = currentProjectName.value || 'Default';
  
  // Store raw ArrayBuffer in IndexedDB for 100% persistent reload
  await saveBinaryFile(`${pName}:excelFileBuffer`, buffer);
  saveCurrentProject();

  if (store.enginesReady) {
    try {
      const parsedData = await parseExcel(buffer);
      if (parsedData._sheet_info) {
        store.sheetInfo = parsedData._sheet_info;
        delete parsedData._sheet_info;
      }
      if (parsedData.editor_metadata) {
        store.editorMetadata = parsedData.editor_metadata;
        delete parsedData.editor_metadata;
      }
      if (parsedData._hierarchy_schema) {
        delete parsedData._hierarchy_schema;
      }

      store.excelJsonData = parsedData;
      saveCurrentProject();
      store.addLog("Dades de l'Excel interpretades correctament. Podeu consultar l'esquema.", "success");
    } catch (e) {
      store.addLog(`Error parsejant Excel: ${e.message}`, "error");
    }
  } else {
    store.addLog("Avís: Inicialitza els motors WASM per poder processar l'Excel.", "warning");
  }
};

// File handlers
const onExcelLoaded = async (file) => {
  if (store.excelJsonData) {
    pendingFile.value = file;
    showWarningModal.value = true;
  } else {
    await processExcelFile(file);
  }
};

const onTemplateLoaded = async (file) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    store.setTemplateFile(file, e.target.result);
  };
  reader.readAsText(file);
};

const onRefDocLoaded = async (file) => {
  store.setRefDocFile(file);
  const buffer = await file.arrayBuffer();
  const pName = currentProjectName.value || 'Default';
  const dName = activeDocName.value || 'Document Principal';
  
  // Store raw ArrayBuffer in IndexedDB for 100% persistent reload
  await saveBinaryFile(`${pName}:doc:${dName}:refDocBuffer`, buffer);
  store.addLog(`Document de referència '${file.name}' desat correctament per a '${dName}'.`, 'success');
};

// Demo Data Loader from workspace
const loadingDemo = ref(false);
const loadDemo = async () => {
  loadingDemo.value = true;
  store.addLog("Carregant fitxers de demostració des del directori local...", "info");
  
  try {
    // 1. Excel
    const excelRes = await fetch("plantilla_memoria_justificativa_PROVA.xlsx");
    if (!excelRes.ok) throw new Error("No s'ha trobat plantilla_memoria_justificativa_PROVA.xlsx al directori.");
    const excelBlob = await excelRes.blob();
    const excelFile = new File([excelBlob], "plantilla_memoria_justificativa_PROVA.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await onExcelLoaded(excelFile);

    // 2. Template
    const tplRes = await fetch("memoria_justificativa.md.j2");
    if (!tplRes.ok) throw new Error("No s'ha trobat memoria_justificativa.md.j2 al directori.");
    const tplBlob = await tplRes.blob();
    const tplFile = new File([tplBlob], "memoria_justificativa.md.j2", { type: "text/plain" });
    await onTemplateLoaded(tplFile);

    // 3. Reference DOCX
    const docxRes = await fetch("corporatiu-reference.docx");
    if (docxRes.ok) {
      const docxBlob = await docxRes.blob();
      const docxFile = new File([docxBlob], "corporatiu-reference.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      onRefDocLoaded(docxFile);
    }
    
    store.addLog("Tots els fitxers de demostració s'han carregat correctament.", "success");
  } catch (e) {
    store.addLog(`Error carregant demo: ${e.message}`, "error");
  } finally {
    loadingDemo.value = false;
  }
};

// Document Generation Pipeline
const dlJsonUrl = ref('');
const dlMdUrl = ref('');
const dlDocxUrl = ref('');

const latestLog = computed(() => {
  if (store.logs && store.logs.length > 0) {
    return store.logs[store.logs.length - 1];
  }
  return null;
});

const isGenerateReady = computed(() => {
  return (store.excelFile || store.excelJsonData) && store.templateText.trim().length > 0 && store.enginesReady;
});

const errorCopied = ref(false);
const copyErrorToClipboard = async () => {
  if (!store.lastConversionError) return;
  const err = store.lastConversionError;
  const textToCopy = `[ERROR CONVERSIÓ JINJA2 - ELIPS]\nTítol: ${err.title}\nMissatge: ${err.message}\nLínia afectada: ${err.line || 'N/A'}\n\nTraceback Tècnic:\n${err.traceback}`;
  try {
    await navigator.clipboard.writeText(textToCopy);
    errorCopied.value = true;
    setTimeout(() => {
      errorCopied.value = false;
    }, 2500);
  } catch (e) {
    console.error("Error en copiar al portaretalls:", e);
  }
};

const generateDocuments = async () => {
  store.generating = true;
  store.clearLogs();
  store.clearConversionError();
  store.addLog("Iniciant pipeline de generació automatitzada de contractes públics...", "info");
  
  try {
    // 1. Jinja2 Compile
    store.addLog("Processant codi Jinja2 en dues passades...", "info");
    const resPayload = await renderMarkdown(store.templateText);
    let payload = null;
    if (typeof resPayload === 'string') {
      try {
        payload = JSON.parse(resPayload);
      } catch (_) {
        payload = { success: true, markdown: resPayload, htmlMarkdown: resPayload, issues: [] };
      }
    } else {
      payload = resPayload || {};
    }

    if (payload.success === false) {
      const errMsg = payload.error || payload.message || "Error desconegut en la conversió de Jinja2";
      store.addLog(`Error de conversió Jinja2: ${errMsg}`, "error");
      store.setConversionError({
        title: "Error de renderitzat / conversió Jinja2",
        message: payload.message || errMsg,
        traceback: payload.traceback || errMsg,
        line: payload.line || null
      });
      return;
    }

    store.renderedMarkdown = payload.htmlMarkdown || payload.markdown;
    store.cleanMarkdown = payload.markdown;
    store.issues = payload.issues || [];
    
    if (store.issues.length > 0) {
      store.addLog(`S'han detectat ${store.issues.length} incidències de variables no definides.`, "warning");
    } else {
      store.addLog("La plantilla s'ha renderitzat completament sense errors de claus buides.", "success");
    }

    // 2. Compile DOCX via Pandoc (utilitzant el markdown net sense enllaços intern HTML)
    store.addLog("Preparant document Word...", "info");
    let refBuf = null;
    if (store.refDocFile) {
      refBuf = await store.refDocFile.arrayBuffer();
    } else if (store.config.useDefaultRef) {
      store.addLog("Descarregant corporatiu-reference.docx per defecte...", "info");
      try {
        const res = await fetch("corporatiu-reference.docx");
        if (res.ok) refBuf = await res.arrayBuffer();
      } catch (_) {}
    }
    
    const docxBlob = await compileDocx(store.cleanMarkdown || store.renderedMarkdown, refBuf, {});
    
    // Create Download Blobs
    if (dlDocxUrl.value) URL.revokeObjectURL(dlDocxUrl.value);
    if (dlMdUrl.value) URL.revokeObjectURL(dlMdUrl.value);
    if (dlJsonUrl.value) URL.revokeObjectURL(dlJsonUrl.value);
    
    dlDocxUrl.value = URL.createObjectURL(docxBlob);
    
    const mdBlob = new Blob([store.cleanMarkdown || store.renderedMarkdown], { type: 'text/markdown' });
    dlMdUrl.value = URL.createObjectURL(mdBlob);
    
    const jsonBlob = new Blob([JSON.stringify(store.excelJsonData, null, 2)], { type: 'application/json' });
    dlJsonUrl.value = URL.createObjectURL(jsonBlob);
    
    store.addLog("Tots els fitxers transpilats correctament. Baixeu-los al panell lateral.", "success");
    store.activeTab = 'preview';
    
  } catch (e) {
    const errText = e.message || String(e);
    store.addLog(`El procés ha fallat catastròficament: ${errText}`, "error");
    store.setConversionError({
      title: "Fallada en la generació del document",
      message: errText,
      traceback: e.stack || errText,
      line: null
    });
  } finally {
    store.generating = false;
  }
};
</script>

<template>
  <div class="app-viewport">
    <!-- Loading Screen Overlay -->
    <div v-if="isLoading" class="loading-screen">
      <div class="loading-card">
        <div class="loading-logo">elips</div>
        <h2 class="loading-title">elips — Editor de LIcitacions PúbliqueS</h2>
        <p class="loading-subtitle">S'estan carregant Pyodide, Pandoc i l'entorn de compilació regional en local...</p>
        
        <div class="loading-spinner-container">
          <div class="loading-spinner"></div>
          <div class="loading-spinner-inner"></div>
        </div>
        
        <div class="loading-status-box" v-if="latestLog">
          <span class="status-dot"></span>
          <span class="status-text">{{ latestLog.text }}</span>
        </div>
      </div>
    </div>

    <!-- Main Workspace UI (hidden during loading) -->
    <div v-else class="app-main-layout">
      <!-- Standard Header (hidden in Maximized Mode) -->
      <header v-show="!store.isMaximized">
        <div class="brand">
          <div class="brand-logo" title="elips: Editor de LIcitacions PúbliqueS">elips</div>
          <div class="brand-title">
            <h1>elips</h1>
            <p>Editor de LIcitacions PúbliqueS</p>
          </div>
        </div>
        
        <div style="display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.06); padding: 4px 10px; border-radius: 16px; border: 1px solid var(--border-color); margin-left: auto; margin-right: 16px;">
          <span style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase;">PROJECTE:</span>
          <span style="font-size: 0.82rem; color: var(--text-primary); font-weight: 700; font-family: monospace; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" :title="currentProjectName">
            {{ currentProjectName }}
          </span>
          <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.72rem; width: auto; height: 26px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px;" @click="openProjectsModal" title="📂 Gestiona els projectes locals de dades">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span v-if="store.config.showButtonTexts">Gestiona</span>
          </button>
          <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.72rem; width: auto; height: 26px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px;" @click="loadDemo" :disabled="loadingDemo" title="✨ Carrega dades de demostració per provar l'aplicació">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3z"/></svg>
            <span v-if="store.config.showButtonTexts">Demo</span>
          </button>
          <button class="btn btn-primary" style="padding: 3px 8px; font-size: 0.72rem; width: auto; height: 26px; display: inline-flex; align-items: center; gap: 4px; font-weight: 600;" @click="downloadAllProjectFiles" title="📥 Descarrega tots els fitxers originals del projecte actiu">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span v-if="store.config.showButtonTexts">Desar fitxers</span>
          </button>
        </div>
        
        <div class="header-actions">
          <!-- Universal Maximize / Restore Toggle Button (Icon only) -->
          <button 
            class="btn-icon-only" 
            @click="store.toggleMaximize" 
            :title="store.isMaximized ? 'Restaura la mida de la finestra' : 'Maximitza la finestra'"
            style="width: 32px; height: 32px;"
          >
            <svg v-if="!store.isMaximized" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg>
          </button>

          <!-- Terminal Logs Drawer Toggle -->
          <button class="btn-icon-only" :class="{ 'btn-active': isTerminalOpen }" @click="isTerminalOpen = !isTerminalOpen" title="Mostra la terminal de logs i incidències" style="position: relative; width: 32px; height: 32px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>
            <span v-if="store.issues.length > 0" class="badge-dot"></span>
          </button>

          <!-- Theme Toggle -->
          <button class="btn-icon-only" @click="toggleTheme" title="Canvia el tema (Clar/Fosc)" style="width: 32px; height: 32px;">
            <svg v-if="!isThemeDark" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 0 1 1-9-9Z"/></svg>
          </button>
          
          <!-- Settings toggle -->
          <button class="btn-icon-only" @click="isSettingsOpen = true" title="Configuració avançada" style="width: 32px; height: 32px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 1 1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
      </header>

    <!-- Microsoft Office Ribbon Part 1: Tab Selector & Quick Action Bar -->
    <div v-show="!store.isMaximized" class="office-tab-bar" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); padding: 0 1rem; flex-shrink: 0; min-height: 38px;">
      <!-- Office Tabs (Left) -->
      <div class="office-tabs" style="display: flex; align-items: stretch; gap: 4px; margin-bottom: -1px;">
        <button 
          class="office-tab-btn" 
          :class="{ active: store.activeTab === 'upload' }" 
          @click="store.setActiveTab('upload')"
          title="📁 Carregar fitxers Excel, Plantilles i Document de referència"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>Fitxers</span>
        </button>
        <button 
          class="office-tab-btn" 
          :class="{ active: store.activeTab === 'data' }" 
          @click="store.setActiveTab('data')"
          title="📊 Inspector i editor de dades Excel"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h18v18H3z"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
          <span>Dades</span>
        </button>
        <button 
          class="office-tab-btn" 
          :class="{ active: store.activeTab === 'template' }" 
          @click="store.setActiveTab('template')"
          title="📝 Editor de la plantilla Jinja2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span>Plantilla</span>
        </button>
        <button 
          class="office-tab-btn" 
          :class="{ active: store.activeTab === 'preview' }" 
          @click="store.setActiveTab('preview')"
          title="👁️ Previsualització del document i compilació"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          <span>Previsualització</span>
        </button>
      </div>

      <!-- Right Side: Document Toolbar -->
      <div style="display: flex; align-items: center; gap: 8px; padding: 2px 0;">
        <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Doc:</span>
        <select 
          :value="activeDocName" 
          @change="switchActiveDocument($event.target.value)" 
          class="data-input" 
          style="width: 170px; height: 26px; font-size: 0.8rem; font-weight: bold; padding: 1px 6px;"
          title="Selecciona el document de treball actiu"
        >
          <option v-for="dName in documentsList" :key="dName" :value="dName">
            {{ dName }}
          </option>
        </select>
        
        <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; height: 26px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px;" @click="createNewDocument" title="➕ Crea un nou document en aquest projecte">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span v-if="store.config.showButtonTexts">Nou</span>
        </button>
        <button 
          v-if="activeDocName !== 'Document Principal'"
          class="btn btn-secondary text-danger" 
          style="padding: 2px 7px; font-size: 0.72rem; height: 26px; border-color: rgba(239, 68, 68, 0.2); background: transparent; display: inline-flex; align-items: center; gap: 4px;" 
          @click="deleteDocument(activeDocName)"
          title="🗑️ Elimina el document actual"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          <span v-if="store.config.showButtonTexts">Elimina</span>
        </button>

        <button 
          class="btn btn-primary" 
          :style="saveStatus === 'modified' ? 'padding: 2px 9px; font-size: 0.72rem; height: 26px; font-weight: 700; background: #d97706; color: white; border: none; display: inline-flex; align-items: center; gap: 4px;' : 'padding: 2px 9px; font-size: 0.72rem; height: 26px; font-weight: 600; border: none; background: var(--color-primary); display: inline-flex; align-items: center; gap: 4px;'" 
          @click="manualSave" 
          title="💾 Desa manualment el document i projecte actuals (Ctrl+S)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          <span v-if="store.config.showButtonTexts">Desa</span>
        </button>

        <span 
          v-if="saveStatus === 'saved'" 
          style="display: inline-flex; align-items: center; font-size: 0.7rem; font-weight: 600; color: var(--color-success); background: var(--color-success-light); padding: 1px 6px; border-radius: 8px; border: 1px solid var(--color-success);" 
          title="Tots els canvis desats"
        >
          🟢
        </span>
        <span 
          v-else-if="saveStatus === 'modified'" 
          style="display: inline-flex; align-items: center; font-size: 0.7rem; font-weight: 600; color: #b45309; background: #fef3c7; padding: 1px 6px; border-radius: 8px; border: 1px solid #f59e0b;" 
          title="Modificat"
        >
          🟠
        </span>
        <span 
          v-else-if="saveStatus === 'saving'" 
          style="display: inline-flex; align-items: center; font-size: 0.7rem; font-weight: 600; color: var(--color-primary); background: var(--color-primary-light); padding: 1px 6px; border-radius: 8px; border: 1px solid var(--color-primary);" 
          class="loading-pulse" 
          title="Desant..."
        >
          🔵
        </span>
      </div>
    </div>

    <!-- Microsoft Office Ribbon Part 2: Tool Content Groups (Organized in Columns with max 2 rows) -->
    <div v-show="!store.isMaximized" class="office-tools-bar" style="display: flex; align-items: stretch; background: var(--bg-tertiary); border-bottom: 1px solid var(--border-color); padding: 4px 1rem; flex-shrink: 0; min-height: 64px; overflow-x: auto; gap: 12px;">

      <!-- TOOLS FOR DADES TAB -->
      <template v-if="store.activeTab === 'data'">
        <!-- Group: Vista -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: grid; grid-template-rows: repeat(2, 28px); grid-auto-flow: column; gap: 4px;">
            <div class="segmented-control" style="display: inline-flex; border: 1px solid var(--border-color); border-radius: 4px; padding: 1px; background: var(--bg-primary); grid-row: 1;">
              <button 
                class="btn-segment" 
                :class="{ active: store.dataActions?.getViewMode && store.dataActions.getViewMode() === 'complete' }"
                @click="store.dataActions?.setViewMode && store.dataActions.setViewMode('complete')"
                style="padding: 2px 6px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px; color: var(--text-primary); display: inline-flex; align-items: center; gap: 4px;"
                title="📋 Mode Complet: Mostra tots els fulls de dades desglossats"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                <span v-if="store.config.showButtonTexts">Complet</span>
              </button>
              <button 
                class="btn-segment" 
                :class="{ active: store.dataActions?.getViewMode && store.dataActions.getViewMode() === 'compact' }"
                @click="store.dataActions?.setViewMode && store.dataActions.setViewMode('compact')"
                style="padding: 2px 6px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px; color: var(--text-primary); display: inline-flex; align-items: center; gap: 4px;"
                title="🔍 Mode Compacte: Mostra el full seleccionat en mode de fitxa compacta"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                <span v-if="store.config.showButtonTexts">Compacte</span>
              </button>
            </div>
            <button 
              class="btn btn-secondary" 
              style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 2; display: inline-flex; align-items: center; gap: 4px;"
              @click="store.dataActions?.toggleJsonView && store.dataActions.toggleJsonView()"
              title="📄 Commuta entre la vista estructurada per fulls i la vista del JSON natiu"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              <span v-if="store.config.showButtonTexts">{{ store.dataActions?.getShowJsonView && store.dataActions.getShowJsonView() ? 'Fulls' : 'Mostra JSON' }}</span>
            </button>
          </div>
          <div class="ribbon-group-label">VISTA</div>
        </div>

        <!-- Group: Conjunt de Dades Actiu (Mode Compacte) -->
        <div v-if="store.dataActions?.getViewMode && store.dataActions.getViewMode() === 'compact'" class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: flex; align-items: center; justify-content: center; height: 100%; min-width: 170px;">
            <select 
              :value="store.dataActions?.getSelectedCompactSheet && store.dataActions.getSelectedCompactSheet()"
              @change="store.dataActions?.setSelectedCompactSheet && store.dataActions.setSelectedCompactSheet($event.target.value)"
              class="data-input" 
              style="height: 28px; font-size: 0.75rem; padding: 2px 6px; width: 100%; border-color: var(--border-color); background: var(--bg-primary); color: var(--text-primary); border-radius: 4px;"
              title="Selecciona el conjunt de dades actiu per editar en mode compacte"
            >
              <option 
                v-for="sheetName in (store.dataActions?.getRootSheetNames ? store.dataActions.getRootSheetNames() : [])" 
                :key="sheetName" 
                :value="sheetName"
              >
                {{ sheetName }}
              </option>
            </select>
          </div>
          <div class="ribbon-group-label">CONJUNT ACTIU</div>
        </div>

        <!-- Group: Estructura (Nou Full i Configura Tipus) -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: grid; grid-template-rows: repeat(2, 28px); grid-auto-flow: column; gap: 4px;">
            <button 
              class="btn btn-secondary" 
              style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 1; display: inline-flex; align-items: center; gap: 4px;"
              @click="store.dataActions?.openNewSheetModal && store.dataActions.openNewSheetModal()"
              title="Crea un nou full o conjunt de dades des de l'aplicació"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span v-if="store.config.showButtonTexts">Nou Conjunt</span>
            </button>

            <button 
              class="btn btn-secondary" 
              style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 2; display: inline-flex; align-items: center; gap: 4px;"
              @click="store.dataActions?.openGroupConfigActive && store.dataActions.openGroupConfigActive()"
              title="Configura tipus de dades i format del conjunt actual"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 1 1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              <span v-if="store.config.showButtonTexts">Configura Tipus</span>
            </button>
          </div>
          <div class="ribbon-group-label">ESTRUCTURA</div>
        </div>

        <!-- Group: Portaretalls de Configuració -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: grid; grid-template-rows: repeat(2, 28px); grid-auto-flow: column; gap: 4px;">
            <button 
              class="btn btn-secondary" 
              style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 1; display: inline-flex; align-items: center; gap: 4px;"
              @click="store.dataActions?.copyGlobalConfig && store.dataActions.copyGlobalConfig()"
              title="Copia la configuració de TOTS els conjunts de dades al portaretalls"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span v-if="store.config.showButtonTexts">Copia Config</span>
            </button>

            <button 
              class="btn btn-secondary" 
              style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 2; display: inline-flex; align-items: center; gap: 4px;"
              @click="store.dataActions?.pasteGlobalConfig && store.dataActions.pasteGlobalConfig()"
              title="Enganxa la configuració global de dades des del portaretalls"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
              <span v-if="store.config.showButtonTexts">Enganxa Config</span>
            </button>
          </div>
          <div class="ribbon-group-label">PORTARETALLS</div>
        </div>

        <!-- Group: Dades -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: grid; grid-template-rows: repeat(2, 28px); grid-auto-flow: column; gap: 4px;">
            <button 
              class="btn btn-secondary" 
              style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 1; display: inline-flex; align-items: center; gap: 4px;"
              @click="store.dataActions?.loadMockData && store.dataActions.loadMockData()"
              title="Carrega dades de prova en l'esquema jeràrquic"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><line x1="8.5" y1="2" x2="15.5" y2="2"/></svg>
              <span v-if="store.config.showButtonTexts">Dades de Prova</span>
            </button>
            <button 
              class="btn btn-secondary" 
              style="padding: 2px 10px; font-size: 0.72rem; height: 28px; grid-row: 2; display: inline-flex; align-items: center; gap: 4px;"
              :disabled="store.dataActions?.savingExcel && store.dataActions.savingExcel()"
              @click="store.dataActions?.exportExcel && store.dataActions.exportExcel()"
              title="Exporta les dades de tornada a un fitxer d'Excel (.xlsx)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span v-if="store.config.showButtonTexts">{{ store.dataActions?.savingExcel && store.dataActions.savingExcel() ? 'Guardant...' : 'Baixa Excel' }}</span>
            </button>

            <!-- Checkbox Depuració Càlculs -->
            <label 
              style="display: inline-flex; align-items: center; gap: 5px; font-size: 0.72rem; font-weight: 600; cursor: pointer; color: var(--text-primary); padding: 0 8px; grid-row: 1 / span 2; height: 100%; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-primary); user-select: none;"
              title="Activa o desactiva els missatges detallats de depuració de càlculs al registre del terminal"
            >
              <input 
                type="checkbox" 
                v-model="store.debugComputedFields" 
                @change="localStorage.setItem('debugComputedFields', String(store.debugComputedFields))"
                style="cursor: pointer;"
              />
              <span v-if="store.config.showButtonTexts">Depura Càlculs</span>
            </label>
          </div>
          <div class="ribbon-group-label">DADES</div>
        </div>
      </template>

      <!-- TOOLS FOR PLANTILLA TAB -->
      <template v-else-if="store.activeTab === 'template'">
        <!-- Group: Visualització -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: grid; grid-template-rows: repeat(2, 28px); grid-auto-flow: column; gap: 4px;">
            <button 
              class="btn btn-secondary" 
              :class="{ 'btn-primary': store.editorActions?.getActiveTab && store.editorActions.getActiveTab() === 'visual' }"
              style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 1; display: inline-flex; align-items: center; gap: 4px;" 
              @click="store.editorActions?.switchEditorTab && store.editorActions.switchEditorTab('visual')"
              title="👁️ Editor Visual (WYSIWYG)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              <span v-if="store.config.showButtonTexts">Visual</span>
            </button>
            <button 
              class="btn btn-secondary" 
              :class="{ 'btn-primary': store.editorActions?.getActiveTab && store.editorActions.getActiveTab() === 'code' }"
              style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 2; display: inline-flex; align-items: center; gap: 4px;" 
              @click="store.editorActions?.switchEditorTab && store.editorActions.switchEditorTab('code')"
              title="📄 Codi Markdown + Jinja2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              <span v-if="store.config.showButtonTexts">Codi</span>
            </button>
          </div>
          <div class="ribbon-group-label">VISUALITZACIÓ</div>
        </div>

        <!-- Group: Metadades -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: flex; align-items: center; height: 60px;">
            <button 
              class="btn btn-secondary" 
              style="padding: 4px 10px; font-size: 0.75rem; height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;"
              @click="store.editorActions?.openMetadataModal && store.editorActions.openMetadataModal()"
              title="🏷️ Metadades Pandoc (Títol, autor, data, índex...)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
              <span v-if="store.config.showButtonTexts" style="font-size: 0.72rem;">Metadades</span>
            </button>
          </div>
          <div class="ribbon-group-label">METADADES</div>
        </div>

        <!-- Group: Format -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: grid; grid-template-rows: repeat(2, 28px); grid-auto-flow: column; gap: 4px;">
            <select 
              style="width: 110px; height: 28px; padding: 1px 4px; font-size: 0.75rem; grid-row: 1; grid-column: 1;" 
              @change="store.editorActions?.formatBlock && store.editorActions.formatBlock($event.target.value); $event.target.value = '';" 
              title="Format de paràgraf (Títols H1-H6 o Paràgraf)"
            >
              <option value="">Format...</option>
              <option value="H1">Títol 1 (#)</option>
              <option value="H2">Títol 2 (##)</option>
              <option value="H3">Títol 3 (###)</option>
              <option value="H4">Títol 4 (####)</option>
              <option value="H5">Títol 5 (#####)</option>
              <option value="H6">Títol 6 (######)</option>
              <option value="P">Paràgraf (p)</option>
            </select>
            <div style="display: flex; gap: 3px; grid-row: 2; grid-column: 1;">
              <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; height: 28px; font-weight: bold; flex: 1;" @click="store.editorActions?.formatDoc && store.editorActions.formatDoc('bold')" title="Negreta (Ctrl+B)"><b>B</b></button>
              <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; height: 28px; font-style: italic; flex: 1;" @click="store.editorActions?.formatDoc && store.editorActions.formatDoc('italic')" title="Cursiva (Ctrl+I)"><i>I</i></button>
              <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; height: 28px; flex: 1;" @click="store.editorActions?.insertList && store.editorActions.insertList('unordered')" title="Llista de punts">•</button>
              <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; height: 28px; flex: 1;" @click="store.editorActions?.insertList && store.editorActions.insertList('ordered')" title="Llista numerada">1.</button>
            </div>
          </div>
          <div class="ribbon-group-label">FORMAT</div>
        </div>

        <!-- Group: Insereix -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: grid; grid-template-rows: repeat(2, 28px); grid-auto-flow: column; gap: 4px;">
            <button class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 1; display: inline-flex; align-items: center; gap: 4px;" @click="store.editorActions?.openTableModal && store.editorActions.openTableModal()" title="📊 Insereix taula automàtica des de l'Excel">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
              <span v-if="store.config.showButtonTexts">Taula</span>
            </button>
            <button class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 2; display: inline-flex; align-items: center; gap: 4px;" @click="store.editorActions?.openBlockModal && store.editorActions.openBlockModal('for_row')" title="🔁 Insereix bucle de fila per a taules manuals">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
              <span v-if="store.config.showButtonTexts">Bucle de Fila</span>
            </button>
            <button class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 1; grid-column: 2; display: inline-flex; align-items: center; gap: 4px;" @click="store.editorActions?.openMathModal && store.editorActions.openMathModal()" title="∑ Insereix o edita fórmula d'equació LaTeX / KaTeX">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 4H6l6 8-6 8h12"/></svg>
              <span v-if="store.config.showButtonTexts">Equació</span>
            </button>
            <button class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 2; grid-column: 2; display: inline-flex; align-items: center; gap: 4px;" @click="store.editorActions?.openSpecialCharModal && store.editorActions.openSpecialCharModal()" title="Ω Insereix caràcters especials (guió llarg, espai no separable, etc.)">
              <span style="font-weight: bold; font-size: 0.85rem; color: var(--color-primary);">Ω</span>
              <span v-if="store.config.showButtonTexts">Caràcters</span>
            </button>
          </div>
          <div class="ribbon-group-label">INSEREIX</div>
        </div>

        <!-- Group: Estructura -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: grid; grid-template-rows: repeat(2, 28px); grid-auto-flow: column; gap: 4px;">
            <button class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 1; display: inline-flex; align-items: center; gap: 4px;" @click="store.editorActions?.openBlockModal && store.editorActions.openBlockModal('if')" title="🔀 Insereix condicional IF">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              <span v-if="store.config.showButtonTexts">IF</span>
            </button>
            <button class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.72rem; height: 28px; grid-row: 2; display: inline-flex; align-items: center; gap: 4px;" @click="store.editorActions?.openBlockModal && store.editorActions.openBlockModal('for')" title="🔁 Insereix bucle FOR de text">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
              <span v-if="store.config.showButtonTexts">FOR</span>
            </button>
          </div>
          <div class="ribbon-group-label">ESTRUCTURA</div>
        </div>

        <!-- Group: Verificació de Plantilla -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: flex; align-items: center; gap: 6px; height: 60px;">
            <button 
              class="btn btn-secondary" 
              style="padding: 4px 10px; font-size: 0.72rem; height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; border-color: var(--color-primary); color: var(--color-primary); font-weight: 700;"
              @click="store.editorActions?.checkTemplateVariables && store.editorActions.checkTemplateVariables()"
              title="🔍 Executa la verificació sota demanda de totes les variables i bucles de la plantilla"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <span v-if="store.config.showButtonTexts">Comprova Plantilla</span>
            </button>
          </div>
          <div class="ribbon-group-label">VERIFICACIÓ</div>
        </div>

        <!-- Group: Històric i Versions (Always accessible) -->
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: flex; align-items: center; gap: 6px; height: 60px;">
            <button 
              class="btn btn-secondary" 
              style="padding: 4px 10px; font-size: 0.72rem; height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;"
              @click="isHistoryModalOpen = true"
              title="📜 Navegador d'Històric de versions, diferencials i punts de control"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary);"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span v-if="store.config.showButtonTexts" style="font-weight: 700;">Històric</span>
            </button>
          </div>
          <div class="ribbon-group-label">HISTÒRIC</div>
        </div>
      </template>

      <!-- TOOLS FOR FITXERS TAB -->
      <template v-else-if="store.activeTab === 'upload'">
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: flex; align-items: center; gap: 6px; height: 60px;">
            <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.72rem; height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;" @click="loadDemo" :disabled="loadingDemo" title="✨ Carrega fitxers de demostració per provar l'aplicació">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3z"/></svg>
              <span v-if="store.config.showButtonTexts">Carrega Demo</span>
            </button>
            <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.72rem; height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;" @click="store.showExcelImportModal = true" :disabled="!store.excelJsonData" title="🔍 Inspecciona el resum d'importació i les dades d'Excel carregades">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="M13.3 16.3 15 18"/></svg>
              <span v-if="store.config.showButtonTexts">Inspecciona Excel</span>
            </button>
            <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.72rem; height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;" @click="openHierarchyModal" :disabled="!store.excelJsonData" title="⚙️ Configura les relacions pare-fill i la jerarquia dels fulls d'Excel">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              <span v-if="store.config.showButtonTexts">Relacions Excel</span>
            </button>
            <button class="btn btn-primary" style="padding: 4px 10px; font-size: 0.72rem; height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;" @click="downloadAllProjectFiles" title="📥 Descarrega el paquet ZIP del projecte sencer">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span v-if="store.config.showButtonTexts">Exporta ZIP</span>
            </button>
          </div>
          <div class="ribbon-group-label">ACCIONS FITXERS</div>
        </div>
      </template>

      <!-- TOOLS FOR PREVISUALITZACIÓ TAB -->
      <template v-else-if="store.activeTab === 'preview'">
        <div class="ribbon-group-card">
          <div class="ribbon-group-body" style="display: flex; align-items: center; gap: 6px; height: 60px;">
            <button class="btn btn-success" style="padding: 4px 12px; font-size: 0.75rem; height: 48px; font-weight: bold; display: flex; align-items: center; gap: 6px;" :disabled="store.generating" @click="store.editorActions?.emitGenerate && store.editorActions.emitGenerate()" title="⚡ Compila la plantilla i genera els documents finals">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              <span v-if="store.config.showButtonTexts">Genera Documents Finals</span>
            </button>
          </div>
          <div class="ribbon-group-label">COMPILACIÓ</div>
        </div>
      </template>

    </div>

    <!-- Single Unified 36px Super-Toolbar (Maximized Mode: 3 Horizontal Groups) -->
    <div v-if="store.isMaximized" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-secondary); border-bottom: 2px solid var(--border-color); padding: 0 8px; flex-shrink: 0; min-height: 36px; height: 36px; box-shadow: var(--shadow-sm); gap: 8px; flex-wrap: nowrap; overflow-x: auto; white-space: nowrap;">
      
      <!-- GRUP 1: Projecte / Fitxer (Esquerra) -->
      <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
        <button class="btn btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;" @click="openProjectsModal" title="Gestiona Projectes (Projecte actual: {{ currentProjectName }})">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span style="font-family: monospace; font-size: 0.78rem;">{{ currentProjectName }}</span>
        </button>

        <span style="color: var(--text-muted); font-size: 0.75rem;">/</span>

        <select 
          :value="activeDocName" 
          @change="switchActiveDocument($event.target.value)" 
          class="data-input" 
          style="width: 155px; height: 26px; font-size: 0.78rem; font-weight: bold; padding: 1px 4px;"
          title="Document de Treball"
        >
          <option v-for="dName in documentsList" :key="dName" :value="dName">
            {{ dName }}
          </option>
        </select>
        
        <button class="btn btn-secondary" style="padding: 2px 5px; font-size: 0.72rem; height: 26px; display: inline-flex; align-items: center;" @click="createNewDocument" title="Crea un nou document en aquest projecte">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>

        <button 
          v-if="activeDocName !== 'Document Principal'" 
          class="btn btn-secondary text-danger" 
          style="padding: 2px 5px; font-size: 0.72rem; height: 26px; border-color: rgba(239, 68, 68, 0.2); background: transparent; display: inline-flex; align-items: center;" 
          @click="deleteDocument(activeDocName)"
          title="Elimina el document actual"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>

        <button 
          class="btn btn-primary" 
          :style="saveStatus === 'modified' ? 'padding: 2px 7px; font-size: 0.72rem; height: 26px; font-weight: 700; background: #d97706; color: white; border: none; display: inline-flex; align-items: center;' : 'padding: 2px 7px; font-size: 0.72rem; height: 26px; font-weight: 600; border: none; background: var(--color-primary); display: inline-flex; align-items: center;'" 
          @click="manualSave" 
          title="Desa el document (Ctrl+S)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        </button>

        <!-- Version History Navigator Button (Prominent next to Save) -->
        <button 
          type="button"
          class="btn btn-secondary" 
          style="padding: 2px 8px; font-size: 0.72rem; height: 26px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px; background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-primary);" 
          @click="isHistoryModalOpen = true" 
          title="Obre el navegador d'històric de versions i punts de control"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary);"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>Històric</span>
        </button>

        <span 
          v-if="saveStatus === 'saved'" 
          style="display: inline-flex; align-items: center; font-size: 0.68rem; font-weight: 600; color: var(--color-success); background: var(--color-success-light); padding: 1px 5px; border-radius: 8px; border: 1px solid var(--color-success);"
          title="Desat"
        >
          Desat
        </span>
        <span 
          v-else-if="saveStatus === 'modified'" 
          style="display: inline-flex; align-items: center; font-size: 0.68rem; font-weight: 600; color: #b45309; background: #fef3c7; padding: 1px 5px; border-radius: 8px; border: 1px solid #f59e0b;"
          title="Modificat"
        >
          Modificat
        </span>
        <span 
          v-else-if="saveStatus === 'saving'" 
          style="display: inline-flex; align-items: center; font-size: 0.68rem; font-weight: 600; color: var(--color-primary); background: var(--color-primary-light); padding: 1px 5px; border-radius: 8px; border: 1px solid var(--color-primary);" 
          class="loading-pulse"
        >
          Desant...
        </span>
      </div>

      <span style="border-left: 1px solid var(--border-color); height: 18px; flex-shrink: 0;"></span>

      <!-- GRUP 2: Eina Activa (Accions Contextuals de Plantilla o Dades) (Centre) -->
      <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0; flex: 1; justify-content: center;">
        
        <!-- Contextual Actions when Tab is Plantilla (Jinja2) -->
        <template v-if="store.activeTab === 'template'">
          <button 
            class="btn-secondary" 
            style="padding: 2px 6px; font-size: 0.72rem; height: 26px; display: inline-flex; align-items: center;"
            :class="{ 'btn-primary': store.editorActions?.getActiveTab && store.editorActions.getActiveTab() === 'visual' }"
            @click="store.editorActions?.switchEditorTab && store.editorActions.switchEditorTab('visual')"
            title="Editor Visual (WYSIWYG)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>

          <button 
            class="btn-secondary" 
            style="padding: 2px 6px; font-size: 0.72rem; height: 26px; display: inline-flex; align-items: center;"
            :class="{ 'btn-primary': store.editorActions?.getActiveTab && store.editorActions.getActiveTab() === 'code' }"
            @click="store.editorActions?.switchEditorTab && store.editorActions.switchEditorTab('code')"
            title="Codi Markdown + Jinja2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          </button>

          <button 
            class="btn-secondary" 
            style="padding: 2px 6px; font-size: 0.72rem; height: 26px; display: inline-flex; align-items: center;"
            @click="store.editorActions?.openMetadataModal && store.editorActions.openMetadataModal()"
            title="Metadades Pandoc (Títol, autor, data, índex...)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
          </button>

          <template v-if="!store.editorActions?.getActiveTab || store.editorActions.getActiveTab() === 'visual'">
            <select style="width: auto; height: 26px; padding: 1px 4px; font-size: 0.75rem;" @change="store.editorActions?.formatBlock && store.editorActions.formatBlock($event.target.value); $event.target.value = '';" title="Format de paràgraf">
              <option value="">Format...</option>
              <option value="H1">Títol 1 (#)</option>
              <option value="H2">Títol 2 (##)</option>
              <option value="H3">Títol 3 (###)</option>
              <option value="H4">Títol 4 (####)</option>
              <option value="H5">Títol 5 (#####)</option>
              <option value="H6">Títol 6 (######)</option>
              <option value="P">Paràgraf normal (p)</option>
            </select>

            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px; font-weight: bold;" @click="store.editorActions?.formatDoc && store.editorActions.formatDoc('bold')" title="Negreta (Ctrl+B)"><b>B</b></button>
            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px; font-style: italic;" @click="store.editorActions?.formatDoc && store.editorActions.formatDoc('italic')" title="Cursiva (Ctrl+I)"><i>I</i></button>
            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px;" @click="store.editorActions?.insertList && store.editorActions.insertList('unordered')" title="Llista de punts">•</button>
            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px;" @click="store.editorActions?.insertList && store.editorActions.insertList('ordered')" title="Llista numerada">1.</button>
            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px; display: inline-flex; align-items: center;" @click="store.editorActions?.openTableModal && store.editorActions.openTableModal()" title="Insereix taula dinàmica o manual"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg></button>
            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px; display: inline-flex; align-items: center;" @click="store.editorActions?.openBlockModal && store.editorActions.openBlockModal('for')" title="Insereix bucle FOR"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg></button>
            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px; display: inline-flex; align-items: center;" @click="store.editorActions?.openBlockModal && store.editorActions.openBlockModal('if')" title="Insereix condicional IF"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg></button>
            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px; font-weight: bold; color: var(--color-primary);" @click="store.editorActions?.openSpecialCharModal && store.editorActions.openSpecialCharModal()" title="Ω Insereix caràcters especials (guió llarg, espai no separable, etc.)">Ω</button>
          </template>

          <button 
            class="btn btn-success" 
            style="padding: 2px 7px; font-size: 0.72rem; height: 26px; font-weight: 700; border: none; display: inline-flex; align-items: center;"
            :disabled="store.generating"
            @click="store.editorActions?.emitGenerate && store.editorActions.emitGenerate()"
            title="Genera els documents finals a partir d'aquesta plantilla"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          </button>
        </template>

        <!-- Contextual Actions when Tab is Dades (Excel) -->
        <template v-else-if="store.activeTab === 'data'">
          <div class="segmented-control" style="display: inline-flex; border: 1px solid var(--border-color); border-radius: 4px; padding: 1px; background: var(--bg-tertiary);">
            <button 
              class="btn-segment" 
              :class="{ active: !store.dataActions?.getViewMode || store.dataActions.getViewMode() === 'complete' }"
              @click="store.dataActions?.setViewMode && store.dataActions.setViewMode('complete')"
              style="padding: 2px 6px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px; display: inline-flex; align-items: center;"
              title="Vista completa per fulls"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            </button>
            <button 
              class="btn-segment" 
              :class="{ active: store.dataActions?.getViewMode && store.dataActions.getViewMode() === 'compact' }"
              @click="store.dataActions?.setViewMode && store.dataActions.setViewMode('compact')"
              style="padding: 2px 6px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px; display: inline-flex; align-items: center;"
              title="Vista compacta de fulls"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </button>
          </div>

          <button 
            class="btn btn-secondary" 
            style="padding: 2px 6px; font-size: 0.72rem; height: 26px; font-family: monospace; font-weight: bold;"
            @click="store.dataActions?.toggleJsonView && store.dataActions.toggleJsonView()"
            title="Commuta entre vista de taula i vista de codi JSON brut"
          >
            { }
          </button>

          <button 
            class="btn btn-primary" 
            style="padding: 2px 7px; font-size: 0.72rem; height: 26px; font-weight: 600; background-color: var(--color-success); border-color: var(--color-success); display: inline-flex; align-items: center;"
            @click="store.dataActions?.exportExcel && store.dataActions.exportExcel()"
            title="Desa els canvis i descarrega el fitxer Excel d'entrada actualitzat"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
        </template>

        <template v-else-if="store.activeTab === 'upload'">
          <button class="btn btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px; display: inline-flex; align-items: center;" @click="loadDemo" :disabled="loadingDemo" title="Carrega fitxers de demostració per provar l'aplicació">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3z"/></svg>
          </button>
        </template>
      </div>

      <span style="border-left: 1px solid var(--border-color); height: 18px; flex-shrink: 0;"></span>

      <!-- GRUP 3: Aplicació (Dreta) -->
      <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
        <!-- Active Workspace Tab Selector Dropdown -->
        <select 
          :value="store.activeTab" 
          @change="store.setActiveTab($event.target.value)" 
          class="data-input" 
          style="width: 175px; height: 26px; font-size: 0.78rem; font-weight: 700; padding: 1px 4px; background: var(--bg-tertiary); color: var(--color-primary); border-color: var(--color-primary);"
          title="Canvia de pestanya de treball"
        >
          <option value="upload">1. Fitxers</option>
          <option value="data">2. Dades (Excel)</option>
          <option value="template">3. Plantilla (Jinja2)</option>
          <option value="preview">4. Previsualització</option>
        </select>

        <button class="btn btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px; display: inline-flex; align-items: center;" @click="downloadAllProjectFiles" title="Descarrega tots els fitxers originals del projecte (ZIP)">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>

        <!-- Version History Navigator Button -->
        <button 
          type="button"
          class="btn btn-secondary" 
          style="padding: 2px 8px; font-size: 0.72rem; height: 26px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;" 
          @click="isHistoryModalOpen = true" 
          title="Obre el navegador d'històric de versions i punts de control"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary);"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>Històric</span>
        </button>

        <!-- Terminal Drawer Toggle -->
        <button class="btn-icon-only" :class="{ 'btn-active': isTerminalOpen }" @click="isTerminalOpen = !isTerminalOpen" title="Logs i incidències" style="width: 26px; height: 26px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>
        </button>

        <!-- Theme Toggle -->
        <button class="btn-icon-only" @click="toggleTheme" title="Canvia el tema (Clar/Fosc)" style="width: 26px; height: 26px;">
          <svg v-if="!isThemeDark" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
          <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
        </button>

        <!-- Settings toggle -->
        <button class="btn-icon-only" @click="isSettingsOpen = true" title="Configuració avançada" style="width: 26px; height: 26px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>

        <!-- Restore Normal View Toggle Button -->
        <button 
          class="btn btn-secondary" 
          style="padding: 2px 6px; font-size: 0.72rem; height: 26px; font-weight: 600; display: inline-flex; align-items: center; gap: 3px;"
          @click="store.toggleMaximize"
          title="Restaura la vista normal de dues columnes"
        >
          🗗 Restaurar
        </button>
      </div>
    </div>

    <div class="container" :style="store.isMaximized ? 'padding: 6px 12px; gap: 0; height: calc(100vh - 42px);' : ''">

      <!-- Main Workspace Grid -->
      <div 
        class="main-grid" 
        :class="{ 'editor-maximized': store.isMaximized, 'sidebar-auto-hidden': isSidebarAutoHidden && !store.isMaximized }"
      >
        <!-- Sidebar Edge Hover Trigger Bar when Auto-Hidden -->
        <div 
          v-if="isSidebarAutoHidden && !store.isMaximized" 
          class="sidebar-edge-trigger" 
          @mouseenter="isSidebarHovered = true"
          title="Passa el cursor per mostrar el Tauler de Control"
        >
          <div style="writing-mode: vertical-rl; text-transform: uppercase; font-size: 0.65rem; font-weight: 700; color: var(--color-primary); letter-spacing: 1px; padding: 10px 2px; transform: rotate(180deg); user-select: none;">
            ◀ TAULER
          </div>
        </div>
        <!-- Control Card Panel -->
        <div 
          class="card control-panel-card" 
          v-show="!store.isMaximized"
          :class="{ 'auto-hidden': isSidebarAutoHidden, 'hovered': isSidebarHovered }"
          @mouseenter="isSidebarHovered = true"
          @mouseleave="isSidebarHovered = false"
        >
          <div class="card-title" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; margin-bottom: 0.25rem;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sliders-horizontal"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="12" x2="12" y1="18" y2="22"/></svg>
              <span style="font-weight: 700; font-size: 0.95rem;">Tauler de Control</span>
            </div>
            <button 
              type="button" 
              class="btn-icon-only" 
              style="width: 24px; height: 24px; font-size: 0.75rem; border: none; background: transparent;"
              @click="toggleSidebarAutoHide"
              :title="isSidebarAutoHidden ? 'Fixa el tauler de control' : 'Auto-amaga el tauler de control'"
            >
              📌
            </button>
          </div>

          <!-- Segmented Tab Switcher for Control Panel -->
          <div class="control-tab-switcher" style="margin-bottom: 0.5rem;">
            <button 
              type="button" 
              class="control-tab-btn" 
              :class="{ active: controlPanelTab === 'downloads' }"
              @click="controlPanelTab = 'downloads'"
            >
              📥 Descàrregues
            </button>
            <button 
              type="button" 
              class="control-tab-btn" 
              :class="{ active: controlPanelTab === 'outline' }"
              @click="controlPanelTab = 'outline'"
            >
              📑 Esquema <span v-if="documentOutline.length > 0" class="tab-badge">{{ documentOutline.length }}</span>
            </button>
          </div>

          <!-- Control Panel Content Container -->
          <div class="control-panel-body" style="flex: 1; display: flex; flex-direction: column; gap: 0.75rem; overflow-y: auto; min-height: 0;">
            
            <!-- Tab 1: Descàrregues -->
            <div v-if="controlPanelTab === 'downloads'" style="display: flex; flex-direction: column; gap: 0.75rem;">
              <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                <button 
                  v-if="!store.enginesReady"
                  class="btn btn-secondary" 
                  @click="initEngines" 
                  :disabled="isLoading"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ 'loading-pulse': isLoading }"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  {{ isLoading ? 'Inicialitzant...' : 'Inicialitza Motors (WASM)' }}
                </button>
                <span v-else style="font-size: 0.8rem; font-weight: bold; color: var(--color-success); text-align: center; display: block; padding: 0.4rem; background: var(--color-success-light); border: 1px solid var(--color-success); border-radius: 4px;">
                  ✓ Motors Inicialitzats (Pyodide + Pandoc)
                </span>

                <button 
                  class="btn btn-success" 
                  :disabled="!isGenerateReady || store.generating"
                  @click="generateDocuments"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ 'loading-pulse': store.generating }"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                  {{ store.generating ? 'Generant...' : 'Genera Documents' }}
                </button>
              </div>

              <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 0.5rem 0;">

              <!-- Downloads Area -->
              <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                <label>Descàrregues Disponibles</label>
                <a v-if="dlJsonUrl" :href="dlJsonUrl" :download="'dades.json'" class="btn btn-secondary" style="justify-content: flex-start;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-primary)"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                  Baixa dades JSON
                </a>
                <a v-if="dlMdUrl" :href="dlMdUrl" :download="store.outNameMd" class="btn btn-secondary" style="justify-content: flex-start;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-success)"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                  Baixa Markdown (.md)
                </a>
                <a v-if="dlDocxUrl" :href="dlDocxUrl" :download="store.outNameDocx" class="btn btn-primary" style="justify-content: flex-start;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:white"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                  Baixa Document Word
                </a>
                <span v-if="!dlDocxUrl" style="font-size: 0.75rem; color: var(--text-muted); text-align: center;">
                  Executeu la generació per descarregar fitxers de sortida.
                </span>
              </div>

              <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 0.5rem 0;">

              <!-- File configuration -->
              <div class="form-row">
                <label for="outNameDocx">Nom del fitxer de sortida DOCX</label>
                <input type="text" id="outNameDocx" v-model="store.outNameDocx">
              </div>
              <div class="form-row">
                <label for="outNameMd">Nom del fitxer de sortida MD</label>
                <input type="text" id="outNameMd" v-model="store.outNameMd">
              </div>
            </div>

            <!-- Tab 2: Esquema -->
            <div v-else-if="controlPanelTab === 'outline'" style="display: flex; flex-direction: column; gap: 0.5rem; height: 100%;">
              <div style="display: flex; flex-direction: column; gap: 2px; margin-bottom: 0.25rem;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <label style="margin: 0; font-size: 0.82rem;">Estructura del Document</label>
                  <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 600;">{{ documentOutline.length }} elements</span>
                </div>
                <div style="font-size: 0.72rem; color: var(--color-primary); display: flex; align-items: center; gap: 4px; font-weight: 500;">
                  <span v-if="store.activeTab === 'template'" style="color: var(--color-warning);">📝 Mode Plantilla (variables Jinja2)</span>
                  <span v-else style="color: var(--color-success);">👁️ Mode Previsualització (processat)</span>
                </div>
              </div>

              <div v-if="documentOutline.length === 0" style="padding: 1.5rem 0.5rem; text-align: center; color: var(--text-muted); font-size: 0.8rem; background: var(--bg-tertiary); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">
                <div style="font-size: 1.5rem; margin-bottom: 0.5rem;">📄</div>
                <p style="margin: 0; font-weight: 600; color: var(--text-primary);">Sense encapçalaments</p>
                <p style="margin: 0.35rem 0 0 0; line-height: 1.4;">
                  <span v-if="store.activeTab === 'template'">Afegiu encapçalaments (<code># H1</code>, <code>## H2</code>) a la plantilla.</span>
                  <span v-else>Genereu el document per veure l'arbre d'encapçalaments processat.</span>
                </p>
              </div>

              <div v-else class="outline-tree-container">
                <div 
                  v-for="item in documentOutline" 
                  :key="item.id"
                  class="outline-tree-item"
                  :class="`level-${item.level}`"
                  :style="{ paddingLeft: `${(item.level - 1) * 12 + 6}px` }"
                  @click="scrollToHeading(item)"
                  :title="item.isTemplate ? `Anar a la línia ${item.lineIndex + 1} de la plantilla` : `Anar a la secció: ${item.text}`"
                >
                  <span class="outline-level-badge" :class="`lvl-${item.level}`">H{{ item.level }}</span>
                  <span v-if="item.hasVariables" class="outline-var-badge" title="Conté variables dinàmiques Jinja2">{ }</span>
                  <span class="outline-item-text">{{ item.text }}</span>
                </div>
              </div>
            </div>

          </div>
        </div>

        <!-- Main Display Card Panel -->
        <div class="card main-display-card" style="flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; padding: 0.25rem 0.5rem;">
          <!-- Tab: Uploads panel -->
          <div class="tab-content" :class="{ active: store.activeTab === 'upload' }" style="overflow-y: auto; padding-right: 6px;">
            <div class="upload-group">
              <div>
                <label>1. Full de càlcul de licitació (.xlsx)</label>
                <FileCard 
                  title="Arrossega l'Excel normalitzat aquí o fes clic per buscar-lo"
                  accept=".xlsx"
                  helperText="Format acceptat: .xlsx"
                  :file="store.excelFile || store.excelFileFake"
                  @file-loaded="onExcelLoaded"
                  @file-removed="store.resetExcel()"
                />
              </div>

              <div>
                <label>2. Plantilla Markdown amb Jinja2 (.md.j2)</label>
                <FileCard 
                  title="Arrossega la plantilla de Jinja2 aquí o fes clic per buscar-la"
                  accept=".j2,.md,.txt,.md.j2"
                  helperText="Formats acceptats: .md.j2, .j2, .md, .txt"
                  :file="store.templateFile || store.templateFileFake"
                  @file-loaded="onTemplateLoaded"
                  @file-removed="store.resetTemplate()"
                />
              </div>

              <div>
                <label>3. Document de referència d'estils (.docx - Opcional)</label>
                <FileCard 
                  title="Arrossega the document custom-reference aquí o fes clic"
                  accept=".docx"
                  helperText="Per defecte s'utilitzarà corporatiu-reference.docx si no es carrega cap fitxer"
                  :file="store.refDocFile || store.refDocFileFake"
                  @file-loaded="onRefDocLoaded"
                  @file-removed="store.resetRefDoc()"
                />
                <div class="checkbox-row" style="margin-top: 0.5rem;">
                  <input type="checkbox" id="chkUseDefaultRef" v-model="store.config.useDefaultRef">
                  <label for="chkUseDefaultRef" style="display:inline; margin:0; text-transform:none; font-weight:500; font-size:0.8rem;">
                    Usa automàticament corporatiu-reference.docx si no es proporciona cap document
                  </label>
                </div>
              </div>

              <div>
                <label>4. Restablir o Importar Projecte Sencer (.zip - Opcional)</label>
                <FileCard 
                  title="Arrossega o cerca un paquet ZIP de projecte descarregat"
                  accept=".zip"
                  helperText="Carrega i restaura automàticament l'estructura del projecte, l'Excel i totes les plantilles .md.j2"
                  @file-loaded="importProjectZip"
                />
              </div>
            </div>
          </div>

          <!-- Tab: Data Inspector -->
          <div class="tab-content" :class="{ active: store.activeTab === 'data' }" style="overflow-y: auto; height: 100%; min-height: 0; padding-right: 6px;">
            <DataInspector />
          </div>

          <!-- Tab: Template Editor -->
          <div class="tab-content" :class="{ active: store.activeTab === 'template' }" style="overflow: hidden; height: 100%; min-height: 0;">
            <TemplateEditor @generate="generateDocuments" />
          </div>

          <!-- Tab: Document Previews -->
          <div class="tab-content" :class="{ active: store.activeTab === 'preview' }" style="overflow: hidden; height: 100%; min-height: 0;">
            <DocumentPreview />
          </div>
        </div>

      </div>
    </div>

    <!-- Advanced Configuration Modal -->
    <SettingsModal :isOpen="isSettingsOpen" @close="isSettingsOpen = false" />

    <!-- Post-Import Excel Inspection Modal -->
    <ExcelImportModal :isOpen="store.showExcelImportModal" @close="store.showExcelImportModal = false" @confirm="saveCurrentProject" />

    <!-- Warn Overwrite / Bind Excel Template Modal -->
    <div class="modal-overlay" v-if="showWarningModal" style="display: flex;">
      <div class="modal-content" style="max-width: 580px;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0; color: var(--color-primary); display: flex; align-items: center; gap: 0.5rem;">
            📊 Carregar / Vincular fitxer Excel (.xlsx)
          </h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="closeWarning">&times;</button>
        </div>
        <div class="modal-body" style="padding-top: 0.5rem; display: flex; flex-direction: column; gap: 1rem;">
          <p style="margin: 0; font-size: 0.95rem; line-height: 1.5; color: var(--text-primary);">
            Ja hi ha dades al projecte actual. Com voleu procedir amb el nou fitxer Excel <strong style="color: var(--color-primary);">{{ pendingFile?.name }}</strong>?
          </p>
          
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <!-- Option A: Bind as Template only -->
            <button 
              class="btn btn-primary" 
              style="padding: 0.85rem 1rem; text-align: left; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; background: var(--bg-tertiary); border: 2px solid var(--color-primary); color: var(--text-primary); cursor: pointer;"
              @click="bindExcelAsTemplateOnly(pendingFile)"
            >
              <div style="font-weight: 700; font-size: 0.9rem; color: var(--color-primary); display: flex; align-items: center; gap: 6px;">
                🔗 Opció A: Vincular com a plantilla Excel conservant les dades actuals
              </div>
              <div style="font-size: 0.8rem; color: var(--text-secondary); font-weight: normal; line-height: 1.4;">
                Substitueix el fitxer .xlsx original de referència per a les exportacions, però manté intactes totes les dades i canvis actuals de l'aplicació.
              </div>
            </button>

            <!-- Option B: Overwrite everything -->
            <button 
              class="btn btn-secondary" 
              style="padding: 0.85rem 1rem; text-align: left; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; border: 1px solid var(--color-danger); background: rgba(239, 68, 68, 0.05); cursor: pointer;"
              @click="confirmOverwrite"
            >
              <div style="font-weight: 700; font-size: 0.9rem; color: var(--color-danger); display: flex; align-items: center; gap: 6px;">
                🔄 Opció B: Carregar i sobreescriure totes les dades des del nou Excel
              </div>
              <div style="font-size: 0.8rem; color: var(--text-secondary); font-weight: normal; line-height: 1.4;">
                Parseja de nou el fitxer Excel del disc i reemplaça totes les dades de l'Inspector de Dades pel contingut d'aquest nou fitxer.
              </div>
            </button>
          </div>

          <div style="background-color: var(--bg-tertiary); padding: 0.75rem; border-radius: 6px; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 0.5rem;">
            <div style="font-size: 0.75rem; font-weight: bold; text-transform: uppercase; color: var(--text-muted); text-align: left;">
              Còpia de seguretat de les dades actuals:
            </div>
            <div style="display: flex; gap: 0.75rem;">
              <button class="btn btn-secondary" style="flex: 1; font-size: 0.8rem;" @click="downloadBackupJson">
                📦 Descarrega JSON
              </button>
              <button class="btn btn-secondary" style="flex: 1; font-size: 0.8rem;" @click="downloadBackupExcel" :disabled="isDownloadingExcel">
                {{ isDownloadingExcel ? '⚙️ Generant...' : '📊 Descarrega Excel' }}
              </button>
            </div>
          </div>
        </div>
        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border-color); margin-top: 0.5rem;">
          <button class="btn btn-secondary" @click="closeWarning">Cancel·la</button>
        </div>
      </div>
    </div>

    <!-- Projects Manager Modal -->
    <div class="modal-overlay" v-if="isProjectsModalOpen" style="display: flex; z-index: 1050;">
      <div class="modal-content" style="max-width: 500px; width: 90%; max-height: 80vh; display: flex; flex-direction: column;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0; display: flex; align-items: center; gap: 0.5rem;">
            📂 Gestió de Projectes (Local)
          </h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="isProjectsModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="flex-grow: 1; overflow-y: auto; padding: 1rem 0; display: flex; flex-direction: column; gap: 1rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0 1.25rem;">
            <span style="font-size: 0.85rem; color: var(--text-secondary); font-weight: 500;">Crea un projecte de dades net:</span>
            <button class="btn btn-primary" style="width: auto; padding: 6px 14px; font-size: 0.8rem; display: flex; align-items: center; gap: 4px;" @click="createNewProject">
              ➕ Nou Projecte
            </button>
          </div>
          
          <div style="border-top: 1px solid var(--border-color); padding: 1rem 1.25rem 0;">
            <div style="font-size: 0.8rem; font-weight: bold; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; text-align: left;">
              Projectes Desats:
            </div>
            
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div 
                v-for="pName in savedProjectsList" 
                :key="pName" 
                style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border-color); transition: background 0.15s; background: var(--bg-secondary);"
                :style="{ borderColor: pName === currentProjectName ? 'var(--color-primary)' : 'var(--border-color)', background: pName === currentProjectName ? 'rgba(59, 130, 246, 0.05)' : 'var(--bg-secondary)' }"
              >
                <div style="display: flex; flex-direction: column; gap: 2px;">
                  <span style="font-size: 0.95rem; font-weight: 600; font-family: monospace; color: var(--text-primary);">
                    {{ pName }}
                    <span v-if="pName === currentProjectName" style="color: var(--color-primary); font-size: 0.75rem; font-weight: bold; margin-left: 6px;">
                      (Actiu)
                    </span>
                  </span>
                </div>
                
                <div style="display: flex; gap: 6px;">
                  <button 
                    class="btn btn-secondary" 
                    style="padding: 4px 8px; font-size: 0.75rem; width: auto;" 
                    @click="loadProject(pName)"
                    :disabled="pName === currentProjectName"
                  >
                    Carrega
                  </button>
                  <button 
                    class="btn btn-secondary text-danger" 
                    style="padding: 4px 8px; font-size: 0.75rem; width: auto; border-color: rgba(239, 68, 68, 0.2); background: transparent;" 
                    @click="deleteProject(pName)"
                    v-if="pName !== 'Default'"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <div class="modal-footer" style="display: flex; justify-content: flex-end; padding-top: 1rem; border-top: 1px solid var(--border-color); margin-top: 1rem;">
          <button class="btn btn-secondary" @click="isProjectsModalOpen = false">Tanca</button>
        </div>
      </div>
    </div>

    </div>

    <!-- Terminal Logs Sliding Side Drawer -->
    <div 
      class="logs-drawer-overlay" 
      :class="{ open: isTerminalOpen }" 
      @click="isTerminalOpen = false"
    >
      <div 
        class="logs-drawer-content" 
        @click.stopPropagation
      >
        <div class="logs-drawer-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>
            <h3 style="margin: 0; font-size: 1.1rem; border: none; padding-bottom: 0;">Terminal de Logs i Incidències</h3>
          </div>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isTerminalOpen = false">&times;</button>
        </div>
        
        <div class="logs-drawer-body">
          <TerminalLog />
        </div>
      </div>
    </div>

    <!-- Conversion Error Modal with Copy to Clipboard -->
    <div v-if="store.isConversionErrorModalOpen && store.lastConversionError" class="modal-overlay error-modal-overlay" @click.self="store.clearConversionError()">
      <div class="modal-card conversion-error-card">
        <div class="modal-header conversion-error-header">
          <div class="error-header-title">
            <span class="error-icon">⚠️</span>
            <h3>{{ store.lastConversionError.title || 'Error de conversió Jinja2' }}</h3>
          </div>
          <button class="btn-icon" style="background:none; border:none; font-size:1.4rem; cursor:pointer;" @click="store.clearConversionError()" title="Tancar">✕</button>
        </div>

        <div class="modal-body conversion-error-body">
          <div v-if="store.lastConversionError.line" class="error-line-badge">
            📍 Línia afectada a la plantilla: <strong>Línia {{ store.lastConversionError.line }}</strong>
          </div>

          <div class="error-message-box">
            <p class="error-message-text">{{ store.lastConversionError.message }}</p>
          </div>

          <div class="error-traceback-section">
            <div class="traceback-header">
              <span>Detall tècnic de l'error (Traceback Python):</span>
              <button class="btn btn-sm btn-secondary copy-error-btn" @click="copyErrorToClipboard">
                <span v-if="errorCopied">✓ Copiat al portaretalls!</span>
                <span v-else>📋 Copiar error al portaretalls</span>
              </button>
            </div>
            <pre class="traceback-content"><code>{{ store.lastConversionError.traceback }}</code></pre>
          </div>
        </div>

        <div class="modal-footer conversion-error-footer">
          <button class="btn btn-secondary" @click="copyErrorToClipboard">
            <span v-if="errorCopied">✓ Error Copiat</span>
            <span v-else>📋 Copiar al portaretalls</span>
          </button>
          <button class="btn btn-primary" @click="store.clearConversionError()">
            Tancar i revisar plantilla
          </button>
        </div>
      </div>
    </div>

    <!-- Hierarchy & Relationship Configuration Modal -->
    <div class="modal-overlay" :style="{ display: isHierarchyModalOpen ? 'flex' : 'none' }" style="z-index: 1050;">
      <div class="modal-content" style="max-width: 960px; width: 95%; max-height: 88vh; display: flex; flex-direction: column;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0; display: flex; align-items: center; gap: 8px;">
            <span style="color: var(--color-primary); font-size: 1.2rem;">⚙️</span>
            <span>Configuració i Reconciliació de Relacions d'Excel</span>
          </h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isHierarchyModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="display: flex; flex-direction: column; gap: 1rem; overflow-y: auto; padding: 1rem 0;">
          <div style="padding: 10px 14px; background: rgba(0, 122, 255, 0.08); border: 1px solid rgba(0, 122, 255, 0.25); border-radius: 8px; font-size: 0.82rem; color: var(--text-primary); line-height: 1.5;">
            ℹ️ <b>Reconciliació de Relacions Pare-Fill i Columnes de Vinculació:</b> Selecciona l'<b>Entitat Pare</b> per a cada full i indica quina <b>Columna Pare</b> es relaciona amb quina <b>Columna Fill</b> (ex: <i>idPartida</i> ➔ <i>idPartida</i> o <i>refPartida</i>). En desar, els canvis es gravaran directament a les pestanyes i metadades del teu full d'Excel (.xlsx).
          </div>

          <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
            <thead>
              <tr style="background: var(--bg-tertiary); text-align: left;">
                <th style="padding: 8px; border: 1px solid var(--border-color); width: 140px;">Full a l'Excel</th>
                <th style="padding: 8px; border: 1px solid var(--border-color); width: 100px;">Nom Entitat</th>
                <th style="padding: 8px; border: 1px solid var(--border-color); width: 150px;">Entitat Pare</th>
                <th style="padding: 8px; border: 1px solid var(--border-color);">Relació de Columnes (Pare ➔ Fill)</th>
                <th style="padding: 8px; border: 1px solid var(--border-color); width: 160px;">Ruta Jinja2</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in hierarchyRows" :key="item.raw_name">
                <td style="padding: 8px; border: 1px solid var(--border-color); font-family: var(--font-mono); font-weight: 600;">
                  {{ item.raw_name }}
                </td>
                <td style="padding: 8px; border: 1px solid var(--border-color);">
                  <input type="text" v-model="item.clean_name" style="width: 100%; padding: 4px 6px; font-family: var(--font-mono); font-size: 0.8rem; border-radius: 4px; border: 1px solid var(--border-color);">
                </td>
                <td style="padding: 8px; border: 1px solid var(--border-color);">
                  <select v-model="item.parent_path" style="width: 100%; padding: 4px 6px; font-size: 0.8rem; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary);">
                    <option value="">-- Primer Nivell (Arrel) --</option>
                    <option v-for="p in getAvailableParents(item.raw_name)" :key="p.path" :value="p.path">
                      {{ p.label }}
                    </option>
                  </select>
                </td>
                <td style="padding: 8px; border: 1px solid var(--border-color);">
                  <div v-if="item.parent_path" style="display: flex; align-items: center; gap: 6px; flex-wrap: nowrap;">
                    <select v-model="item.parent_ref_key" style="flex: 1; padding: 4px 6px; font-size: 0.78rem; font-family: var(--font-mono); border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary);" title="Columna Clau de l'Entitat Pare">
                      <option value="">-- Columna Pare --</option>
                      <option v-for="col in getParentHeadersFor(item)" :key="col" :value="col">{{ col }}</option>
                    </select>

                    <span style="font-weight: bold; color: var(--color-primary); font-size: 0.9rem;">➔</span>

                    <select v-model="item.child_ref_key" style="flex: 1; padding: 4px 6px; font-size: 0.78rem; font-family: var(--font-mono); border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary);" title="Columna Clau de l'Entitat Fill">
                      <option value="">-- Columna Fill --</option>
                      <option v-for="col in getRowHeaders(item)" :key="col" :value="col">{{ col }}</option>
                    </select>
                  </div>
                  <div v-else style="color: var(--text-muted); font-size: 0.75rem; font-style: italic;">
                    -- Primer Nivell (Sense pare) --
                  </div>
                </td>
                <td style="padding: 8px; border: 1px solid var(--border-color); font-family: var(--font-mono); font-weight: bold; color: var(--color-primary);">
                  {{ computeJinjaPath(item) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center; margin-top: 1rem;">
          <span style="font-size: 0.75rem; color: var(--text-muted);">Els canvis es desaran directament a les pestanyes i metadades del full d'Excel (.xlsx).</span>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary" style="width: auto;" @click="isHierarchyModalOpen = false">Cancel·lar</button>
            <button class="btn btn-primary" style="width: auto; display: flex; align-items: center; gap: 6px;" @click="applyHierarchyChanges" :disabled="savingHierarchy">
              <span>💾 Desar Canvis a l'Excel (.xlsx) i Re-aplicar</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Version History Navigator Modal -->
    <VersionHistoryModal 
      :is-open="isHistoryModalOpen"
      :history-data="historyData"
      @close="isHistoryModalOpen = false"
      @restore="restoreVersion($event.entry, $event.mode)"
      @create-snapshot="createSnapshot('manual', $event)"
    />

    <!-- Ultra-Compact Minimal Footer -->
    <footer style="text-align: left; padding: 2px 0.75rem; font-size: 0.65rem; color: var(--text-muted); border-top: 1px solid var(--border-color); background: var(--bg-secondary); margin-top: auto; display: flex; align-items: center; justify-content: flex-start; flex-shrink: 0; min-height: 20px; height: 20px; box-sizing: border-box;">
      <span style="font-family: monospace; font-weight: 600; color: var(--text-muted); font-size: 0.65rem; display: inline-flex; align-items: center; gap: 4px;" title="Codi de compilació d'elips">
        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
        <span>{{ buildCode }}</span>
      </span>
    </footer>
  </div>
</template>

<style scoped>
.loading-screen {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 99999;
  font-family: system-ui, -apple-system, sans-serif;
  color: #f8fafc;
}

.error-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(15, 23, 42, 0.8);
  backdrop-filter: blur(6px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10000;
}

.conversion-error-card {
  background: var(--bg-card, #1e293b);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 16px;
  width: 90%;
  max-width: 680px;
  max-height: 85vh;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.conversion-error-header {
  background: rgba(239, 68, 68, 0.1);
  border-bottom: 1px solid rgba(239, 68, 68, 0.25);
  padding: 1rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.error-header-title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.error-header-title h3 {
  margin: 0;
  font-size: 1.15rem;
  color: #ef4444;
  font-weight: 700;
}

.error-icon {
  font-size: 1.4rem;
}

.conversion-error-body {
  padding: 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.error-line-badge {
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: #f59e0b;
  padding: 0.5rem 0.85rem;
  border-radius: 8px;
  font-size: 0.88rem;
}

.error-message-box {
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  padding: 0.85rem 1rem;
}

.error-message-text {
  margin: 0;
  font-size: 0.92rem;
  color: var(--text-color, #f8fafc);
  font-weight: 500;
  line-height: 1.5;
}

.error-traceback-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.traceback-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-muted, #94a3b8);
}

.copy-error-btn {
  padding: 3px 10px;
  font-size: 0.75rem;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.traceback-content {
  background: #0f172a;
  color: #f8fafc;
  padding: 1rem;
  border-radius: 10px;
  max-height: 260px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.5;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.conversion-error-footer {
  padding: 0.85rem 1.25rem;
  border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  background: var(--bg-secondary, #0f172a);
}

.loading-card {
  background: rgba(30, 41, 59, 0.7);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  padding: 3rem;
  border-radius: 20px;
  width: 90%;
  max-width: 500px;
  text-align: center;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
}

.loading-logo {
  width: 60px;
  height: 60px;
  background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.75rem;
  font-weight: 800;
  color: white;
  box-shadow: 0 8px 16px rgba(59, 130, 246, 0.25);
  margin-bottom: 0.5rem;
}

.loading-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: #ffffff;
  margin: 0;
}

.loading-subtitle {
  font-size: 0.875rem;
  color: #94a3b8;
  line-height: 1.6;
  margin: 0;
}

.loading-spinner-container {
  position: relative;
  width: 80px;
  height: 80px;
  margin: 1rem 0;
}

.loading-spinner {
  position: absolute;
  width: 100%;
  height: 100%;
  border: 4px solid rgba(59, 130, 246, 0.1);
  border-top: 4px solid #3b82f6;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.loading-spinner-inner {
  position: absolute;
  top: 10px;
  left: 10px;
  width: 60px;
  height: 60px;
  border: 4px solid transparent;
  border-bottom: 4px solid #60a5fa;
  border-radius: 50%;
  animation: spin-reverse 1.5s linear infinite;
}

.loading-status-box {
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.05);
  padding: 0.75rem 1.25rem;
  border-radius: 10px;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  box-sizing: border-box;
}

.status-dot {
  width: 8px;
  height: 8px;
  background-color: #3b82f6;
  border-radius: 50%;
  flex-shrink: 0;
  animation: pulse-dot 1.5s infinite ease-in-out;
}

.status-text {
  font-size: 0.8rem;
  font-family: monospace;
  color: #cbd5e1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-grow: 1;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@keyframes spin-reverse {
  0% { transform: rotate(360deg); }
  100% { transform: rotate(0deg); }
}

@keyframes pulse-dot {
  0%, 100% { transform: scale(0.8); opacity: 0.5; }
  50% { transform: scale(1.2); opacity: 1; }
}

.logs-drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background-color: rgba(0, 0, 0, 0.4);
  z-index: 1000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}

.logs-drawer-overlay.open {
  opacity: 1;
  pointer-events: auto;
}

.logs-drawer-content {
  position: absolute;
  top: 0;
  right: -520px;
  width: 500px;
  max-width: 90%;
  height: 100%;
  background-color: var(--bg-card);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  transition: right 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  border-left: 1px solid var(--border-color);
}

.logs-drawer-overlay.open .logs-drawer-content {
  right: 0;
}

.logs-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.logs-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  min-height: 0;
}

.badge-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 8px;
  height: 8px;
  background-color: var(--color-warning);
  border-radius: 50%;
  border: 1.5px solid var(--bg-card);
}

.btn-active {
  background-color: var(--color-primary-light) !important;
  color: var(--color-primary) !important;
  border-color: var(--color-primary) !important;
}
</style>
