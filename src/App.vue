<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useWorkspaceStore } from './stores/workspace';
import { useWasmEngines } from './composables/useWasmEngines';
import { saveBinaryFile, getBinaryFile, deleteBinaryFile } from './utils/db';

// Components
import FileCard from './components/FileCard.vue';
import DataInspector from './components/DataInspector.vue';
import TemplateEditor from './components/TemplateEditor.vue';
import DocumentPreview from './components/DocumentPreview.vue';
import TerminalLog from './components/TerminalLog.vue';
import SettingsModal from './components/SettingsModal.vue';

const store = useWorkspaceStore();
const { initEngines, parseExcel, renderMarkdown, compileDocx, saveExcelData, writeVirtualExcel, isLoading } = useWasmEngines();

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

const openProjectsModal = () => {
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
  
  store.addLog(`Projecte '${cleanName}' creat i seleccionat correctament.`, 'success');
};

const loadProject = (name) => {
  if (name === currentProjectName.value) return;
  
  // Save current project and active doc state before switching
  saveCurrentProject();
  saveCurrentDocumentState(currentProjectName.value, activeDocName.value);
  
  currentProjectName.value = name;
  localStorage.setItem('currentProjectName', name);
  
  // Load the new project's document list and active document
  const list = localStorage.getItem(`${name}:documentsList`);
  documentsList.value = list ? JSON.parse(list) : ['Document Principal'];
  localStorage.setItem(`${name}:documentsList`, JSON.stringify(documentsList.value));
  
  const aDoc = localStorage.getItem(`${name}:activeDocName`) || 'Document Principal';
  activeDocName.value = aDoc;
  localStorage.setItem(`${name}:activeDocName`, aDoc);
  
  // Recover Excel fields from localStorage for this project
  const excelJsonData = localStorage.getItem(`${name}:excelJsonData`);
  const excelFileName = localStorage.getItem(`${name}:excelFileName`) || '';
  const excelFileSize = parseInt(localStorage.getItem(`${name}:excelFileSize`) || '0', 10);
  const excelB64 = localStorage.getItem(`${name}:excelFileBase64`);
  const editorMetadata = localStorage.getItem(`${name}:editorMetadata`);
  
  // Set Pinia store values
  store.excelJsonData = excelJsonData ? JSON.parse(excelJsonData) : null;
  store.excelFileName = excelFileName;
  store.excelFileSize = excelFileSize;
  if (excelB64) {
    try {
      store.excelFile = dataURLtoFile(excelB64, excelFileName);
    } catch (_) {
      store.excelFile = null;
    }
  } else {
    store.excelFile = null;
  }
  store.editorMetadata = editorMetadata ? JSON.parse(editorMetadata) : [];
  
  // Now load the active document configuration
  loadDocumentConfig(name, aDoc);
  
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

const saveCurrentProject = () => {
  const name = currentProjectName.value;
  if (!name) return;
  
  if (store.excelJsonData) {
    localStorage.setItem(`${name}:excelJsonData`, JSON.stringify(store.excelJsonData));
  } else {
    localStorage.removeItem(`${name}:excelJsonData`);
  }
  localStorage.setItem(`${name}:excelFileName`, store.excelFileName || '');
  localStorage.setItem(`${name}:excelFileSize`, store.excelFileSize || '0');
  localStorage.setItem(`${name}:editorMetadata`, JSON.stringify(store.editorMetadata || []));
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
  
  localStorage.setItem(`${pName}:doc:${dName}:templateText`, store.templateText || '');
  localStorage.setItem(`${pName}:doc:${dName}:templateFileName`, store.templateFileName || '');
  localStorage.setItem(`${pName}:doc:${dName}:templateFileSize`, store.templateFileSize || '0');
  
  localStorage.setItem(`${pName}:doc:${dName}:refDocFileName`, store.refDocFileName || '');
  localStorage.setItem(`${pName}:doc:${dName}:refDocFileSize`, store.refDocFileSize || '0');
  
  localStorage.setItem(`${pName}:doc:${dName}:outNameDocx`, store.outNameDocx || '');
  localStorage.setItem(`${pName}:doc:${dName}:outNameMd`, store.outNameMd || '');
  
  if (store.refDocFile) {
    const reader = new FileReader();
    reader.onload = () => {
      localStorage.setItem(`${pName}:doc:${dName}:refDocFileBase64`, reader.result);
    };
    reader.readAsDataURL(store.refDocFile);
  } else {
    localStorage.removeItem(`${pName}:doc:${dName}:refDocFileBase64`);
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

// Autodesat / Persistència en LocalStorage via Pinia Subscription amb desplaçament i temporitzador
store.$subscribe((mutation, state) => {
  // Mark state as modified as soon as any store state mutates
  saveStatus.value = 'modified';

  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    executeSave();
  }, 800);
}, { detached: true, deep: true });

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
    localStorage.removeItem(`${name}:doc:${dName}:refDocFileBase64`);
  }
});

// Watch Excel JSON data for embedded editor_metadata sheet configs and hierarchy schema
watch(() => store.excelJsonData, (newVal) => {
  if (newVal) {
    if (newVal.editor_metadata) {
      store.editorMetadata = newVal.editor_metadata;
    }
    if (newVal._hierarchy_schema) {
      delete newVal._hierarchy_schema;
    }
  }
}, { immediate: true, deep: true });

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
  
  // Restore Excel sheets JSON data
  const excelJsonData = localStorage.getItem(`${pName}:excelJsonData`);
  if (excelJsonData) {
    store.excelJsonData = JSON.parse(excelJsonData);
  }
  
  const editorMetadata = localStorage.getItem(`${pName}:editorMetadata`);
  if (editorMetadata) {
    store.editorMetadata = JSON.parse(editorMetadata);
  }

  // Restore active document states (template text, ref document)
  loadDocumentConfig(pName, aDoc);

  // Restore raw Excel File object from IndexedDB
  try {
    const excelBuf = await getBinaryFile(`${pName}:excelFileBuffer`);
    if (excelBuf && store.excelFileName) {
      const file = new File([excelBuf], store.excelFileName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      store.excelFile = file;
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

const processExcelFile = async (file) => {
  store.setExcelFile(file);
  const buffer = await file.arrayBuffer();
  const pName = currentProjectName.value || 'Default';
  
  // Store raw ArrayBuffer in IndexedDB for 100% persistent reload
  await saveBinaryFile(`${pName}:excelFileBuffer`, buffer);

  if (store.enginesReady) {
    try {
      const parsedData = await parseExcel(buffer);
      store.excelJsonData = parsedData;
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

const generateDocuments = async () => {
  store.generating = true;
  store.clearLogs();
  store.addLog("Iniciant pipeline de generació automatitzada de contractes públics...", "info");
  
  try {
    // 1. Jinja2 Compile
    store.addLog("Processant codi Jinja2 en dues passades...", "info");
    const payload = await renderMarkdown(store.templateText);
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
    store.addLog(`El procés ha fallat catastròficament: ${e.message}`, "error");
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
          <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.72rem; width: auto; height: 26px; font-weight: 500;" @click="openProjectsModal" title="Gestiona projectes">
            📂 Gestiona
          </button>
          <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.72rem; width: auto; height: 26px; font-weight: 500;" @click="loadDemo" :disabled="loadingDemo" title="Carrega dades de demostració per provar l'aplicació">
            ✨ Demo
          </button>
          <button class="btn btn-primary" style="padding: 3px 8px; font-size: 0.72rem; width: auto; height: 26px; display: inline-flex; align-items: center; gap: 4px; font-weight: 600;" @click="downloadAllProjectFiles" title="Descarrega tots els fitxers originals del projecte actiu">
            📥 Desar fitxers
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

    <!-- Microsoft Office Desktop App Ribbon Tab Bar (Fitxers, Dades, Plantilla, Previsualització) -->
    <div v-show="!store.isMaximized" class="office-ribbon-bar" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); padding: 0 1.25rem; flex-shrink: 0; box-shadow: var(--shadow-sm); gap: 1rem; flex-wrap: wrap;">
      <!-- Office Tabs (Left) -->
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        <div class="office-tabs" style="display: flex; align-items: stretch; gap: 4px; margin-bottom: -1px;">
          <button 
            class="office-tab-btn" 
            :class="{ active: store.activeTab === 'upload' }" 
            @click="store.setActiveTab('upload')"
            title="Carregar fitxers Excel, Plantilles i Document de referència"
          >
            📁 Fitxers
          </button>
          <button 
            class="office-tab-btn" 
            :class="{ active: store.activeTab === 'data' }" 
            @click="store.setActiveTab('data')"
            title="Inspector i editor de dades Excel"
          >
            📊 Dades
          </button>
          <button 
            class="office-tab-btn" 
            :class="{ active: store.activeTab === 'template' }" 
            @click="store.setActiveTab('template')"
            title="Editor de la plantilla Jinja2"
          >
            📝 Plantilla
          </button>
          <button 
            class="office-tab-btn" 
            :class="{ active: store.activeTab === 'preview' }" 
            @click="store.setActiveTab('preview')"
            title="Previsualització del document i compilació"
          >
            👁️ Previsualització
          </button>
        </div>

        <!-- MS Office Style Ribbon Action Groups based on activeTab -->

        <!-- Contextual Groups for Dades Tab -->
        <template v-if="store.activeTab === 'data'">
          <div class="office-ribbon-group" style="display: flex; align-items: center; gap: 6px; border-left: 1px solid var(--border-color); padding-left: 8px;">
            <span style="font-size: 0.68rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Vista:</span>
            <div class="segmented-control" style="display: inline-flex; border: 1px solid var(--border-color); border-radius: 4px; padding: 1px; background: var(--bg-tertiary);">
              <button 
                class="btn-segment" 
                :class="{ active: store.dataActions?.getViewMode && store.dataActions.getViewMode() === 'complete' }"
                @click="store.dataActions?.setViewMode && store.dataActions.setViewMode('complete')"
                style="padding: 3px 8px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px; color: var(--text-primary);"
                title="Mostra tots els fulls de dades desglossats"
              >
                📋 Complet
              </button>
              <button 
                class="btn-segment" 
                :class="{ active: store.dataActions?.getViewMode && store.dataActions.getViewMode() === 'compact' }"
                @click="store.dataActions?.setViewMode && store.dataActions.setViewMode('compact')"
                style="padding: 3px 8px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px; color: var(--text-primary);"
                title="Mostra el full seleccionat en mode de fitxa compacta"
              >
                🔍 Compacte
              </button>
            </div>

            <button 
              class="btn btn-secondary" 
              style="padding: 3px 8px; font-size: 0.72rem; height: 28px;"
              @click="store.dataActions?.toggleJsonView && store.dataActions.toggleJsonView()"
              title="Commuta entre la vista estructurada per fulls i la vista del JSON natiu"
            >
              {{ store.dataActions?.getShowJsonView && store.dataActions.getShowJsonView() ? 'Mostra per fulls' : 'Mostra JSON' }}
            </button>
          </div>

          <div class="office-ribbon-group" style="display: flex; align-items: center; gap: 6px; border-left: 1px solid var(--border-color); padding-left: 8px;">
            <span style="font-size: 0.68rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Dades:</span>
            <button 
              class="btn btn-secondary" 
              style="padding: 3px 8px; font-size: 0.72rem; height: 28px; background-color: var(--color-primary-light, #e0f2fe); color: var(--color-primary, #0284c7); border-color: var(--color-primary, #0284c7);"
              @click="store.dataActions?.loadMockData && store.dataActions.loadMockData()"
              title="Carrega dades de prova en l'esquema jeràrquic"
            >
              🧪 Carrega Dades de Prova
            </button>

            <button 
              class="btn btn-primary" 
              style="padding: 3px 10px; font-size: 0.72rem; height: 28px; background-color: var(--color-success); border-color: var(--color-success);"
              :disabled="store.dataActions?.savingExcel && store.dataActions.savingExcel()"
              @click="store.dataActions?.exportExcel && store.dataActions.exportExcel()"
              title="Exporta les dades de tornada a un fitxer d'Excel (.xlsx)"
            >
              {{ store.dataActions?.savingExcel && store.dataActions.savingExcel() ? 'Guardant...' : 'Desa i baixa a Excel 📥' }}
            </button>
          </div>
        </template>

        <!-- Contextual Groups for Plantilla Tab -->
        <template v-else-if="store.activeTab === 'template'">
          <!-- Group Visualització -->
          <div class="office-ribbon-group" style="display: flex; align-items: center; gap: 4px; border-left: 1px solid var(--border-color); padding-left: 8px;">
            <span style="font-size: 0.68rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Visualització:</span>
            <div class="segmented-control" style="display: inline-flex; border: 1px solid var(--border-color); border-radius: 4px; padding: 1px; background: var(--bg-tertiary);">
              <button 
                class="btn-segment" 
                :class="{ active: store.editorActions?.getActiveTab && store.editorActions.getActiveTab() === 'visual' }"
                @click="store.editorActions?.switchEditorTab && store.editorActions.switchEditorTab('visual')"
                style="padding: 3px 8px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px; color: var(--text-primary);"
                title="Editor Visual (WYSIWYG)"
              >
                👁️ Visual
              </button>
              <button 
                class="btn-segment" 
                :class="{ active: store.editorActions?.getActiveTab && store.editorActions.getActiveTab() === 'code' }"
                @click="store.editorActions?.switchEditorTab && store.editorActions.switchEditorTab('code')"
                style="padding: 3px 8px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px; color: var(--text-primary);"
                title="Codi Markdown + Jinja2"
              >
                📄 Codi
              </button>
            </div>
          </div>

          <!-- Group Metadades -->
          <div class="office-ribbon-group" style="display: flex; align-items: center; gap: 4px; border-left: 1px solid var(--border-color); padding-left: 8px;">
            <span style="font-size: 0.68rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Metadades:</span>
            <button 
              class="btn btn-secondary" 
              style="padding: 3px 8px; font-size: 0.72rem; height: 28px;"
              @click="store.editorActions?.openMetadataModal && store.editorActions.openMetadataModal()"
              title="Metadades Pandoc (Títol, autor, data, índex...)"
            >
              🏷️ Metadades
            </button>
          </div>

          <!-- Group Format -->
          <div class="office-ribbon-group" style="display: flex; align-items: center; gap: 4px; border-left: 1px solid var(--border-color); padding-left: 8px;">
            <span style="font-size: 0.68rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Format:</span>
            <select style="width: auto; height: 28px; padding: 1px 4px; font-size: 0.75rem;" @change="store.editorActions?.formatBlock && store.editorActions.formatBlock($event.target.value); $event.target.value = '';" title="Format de paràgraf">
              <option value="">Format...</option>
              <option value="H1">Títol 1 (#)</option>
              <option value="H2">Títol 2 (##)</option>
              <option value="H3">Títol 3 (###)</option>
              <option value="H4">Títol 4 (####)</option>
              <option value="H5">Títol 5 (#####)</option>
              <option value="H6">Títol 6 (######)</option>
              <option value="P">Paràgraf normal (p)</option>
            </select>
            <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; height: 28px; font-weight: bold;" @click="store.editorActions?.formatDoc && store.editorActions.formatDoc('bold')" title="Negreta (Ctrl+B)"><b>B</b></button>
            <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; height: 28px; font-style: italic;" @click="store.editorActions?.formatDoc && store.editorActions.formatDoc('italic')" title="Cursiva (Ctrl+I)"><i>I</i></button>
            <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; height: 28px;" @click="store.editorActions?.insertList && store.editorActions.insertList('unordered')" title="Llista de punts">•</button>
            <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; height: 28px;" @click="store.editorActions?.insertList && store.editorActions.insertList('ordered')" title="Llista numerada">1.</button>
          </div>

          <!-- Group Insereix -->
          <div class="office-ribbon-group" style="display: flex; align-items: center; gap: 4px; border-left: 1px solid var(--border-color); padding-left: 8px;">
            <span style="font-size: 0.68rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Insereix:</span>
            <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.72rem; height: 28px;" @click="store.editorActions?.openTableModal && store.editorActions.openTableModal()" title="Insereix taula automàtica">📊 Taula automàtica</button>
            <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.72rem; height: 28px;" @click="store.editorActions?.openBlockModal && store.editorActions.openBlockModal('for_row')" title="Insereix bucle de fila per a taules manuals">🔁 Bucle de fila</button>
            <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.72rem; height: 28px;" @click="store.editorActions?.openMathModal && store.editorActions.openMathModal()" title="Insereix o edita fórmula d'equació LaTeX / KaTeX">∑ Equació</button>
          </div>

          <!-- Group Estructura -->
          <div class="office-ribbon-group" style="display: flex; align-items: center; gap: 4px; border-left: 1px solid var(--border-color); padding-left: 8px;">
            <span style="font-size: 0.68rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Estructura:</span>
            <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.72rem; height: 28px;" @click="store.editorActions?.openBlockModal && store.editorActions.openBlockModal('if')" title="Insereix condicional IF">🔀 IF</button>
            <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.72rem; height: 28px;" @click="store.editorActions?.openBlockModal && store.editorActions.openBlockModal('for')" title="Insereix bucle FOR de text">🔁 FOR</button>
          </div>
        </template>
      </div>

      <!-- Right Side: Document Toolbar -->
      <div style="display: flex; align-items: center; gap: 8px; padding: 4px 0;">
        <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">📄 Doc:</span>
        <select 
          :value="activeDocName" 
          @change="switchActiveDocument($event.target.value)" 
          class="data-input" 
          style="width: 170px; height: 28px; font-size: 0.8rem; font-weight: bold; padding: 2px 6px;"
        >
          <option v-for="dName in documentsList" :key="dName" :value="dName">
            {{ dName }}
          </option>
        </select>
        
        <button class="btn btn-secondary" style="padding: 2px 7px; font-size: 0.72rem; height: 28px; font-weight: 500;" @click="createNewDocument" title="Crea un nou document en aquest projecte">
          ➕ Nou
        </button>
        <button 
          v-if="activeDocName !== 'Document Principal'"
          class="btn btn-secondary text-danger" 
          style="padding: 2px 7px; font-size: 0.72rem; height: 28px; border-color: rgba(239, 68, 68, 0.2); background: transparent;" 
          @click="deleteDocument(activeDocName)"
          title="Elimina el document actual"
        >
          🗑️
        </button>

        <button 
          class="btn btn-primary" 
          :style="saveStatus === 'modified' ? 'padding: 2px 9px; font-size: 0.72rem; height: 28px; font-weight: 700; background: #d97706; color: white; border: none;' : 'padding: 2px 9px; font-size: 0.72rem; height: 28px; font-weight: 600; border: none; background: var(--color-primary);'" 
          @click="manualSave" 
          title="Desa manualment el document i projecte actuals (Ctrl+S)"
        >
          💾 Desa
        </button>

        <span 
          v-if="saveStatus === 'saved'" 
          style="display: inline-flex; align-items: center; font-size: 0.7rem; font-weight: 600; color: var(--color-success); background: var(--color-success-light); padding: 2px 6px; border-radius: 10px; border: 1px solid var(--color-success);" 
          title="Tots els canvis desats"
        >
          🟢
        </span>
        <span 
          v-else-if="saveStatus === 'modified'" 
          style="display: inline-flex; align-items: center; font-size: 0.7rem; font-weight: 600; color: #b45309; background: #fef3c7; padding: 2px 6px; border-radius: 10px; border: 1px solid #f59e0b;" 
          title="Modificat"
        >
          🟠
        </span>
        <span 
          v-else-if="saveStatus === 'saving'" 
          style="display: inline-flex; align-items: center; font-size: 0.7rem; font-weight: 600; color: var(--color-primary); background: var(--color-primary-light); padding: 2px 6px; border-radius: 10px; border: 1px solid var(--color-primary);" 
          class="loading-pulse" 
          title="Desant..."
        >
          🔵
        </span>
      </div>
    </div>

    <!-- Single Unified 36px Super-Toolbar (Maximized Mode: 3 Horizontal Groups) -->
    <div v-if="store.isMaximized" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-secondary); border-bottom: 2px solid var(--border-color); padding: 0 8px; flex-shrink: 0; min-height: 36px; height: 36px; box-shadow: var(--shadow-sm); gap: 8px; flex-wrap: nowrap; overflow-x: auto; white-space: nowrap;">
      
      <!-- GRUP 1: Projecte / Fitxer (Esquerra) -->
      <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
        <button class="btn btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px; font-weight: 700; display: inline-flex; align-items: center; gap: 3px;" @click="openProjectsModal" title="Gestiona Projectes (Projecte actual: {{ currentProjectName }})">
          📂 <span style="font-family: monospace; font-size: 0.78rem;">{{ currentProjectName }}</span>
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
        
        <button class="btn btn-secondary" style="padding: 2px 5px; font-size: 0.72rem; height: 26px;" @click="createNewDocument" title="Crea un nou document en aquest projecte">
          ➕
        </button>

        <button 
          v-if="activeDocName !== 'Document Principal'" 
          class="btn btn-secondary text-danger" 
          style="padding: 2px 5px; font-size: 0.72rem; height: 26px; border-color: rgba(239, 68, 68, 0.2); background: transparent;" 
          @click="deleteDocument(activeDocName)"
          title="Elimina el document actual"
        >
          🗑️
        </button>

        <button 
          class="btn btn-primary" 
          :style="saveStatus === 'modified' ? 'padding: 2px 7px; font-size: 0.72rem; height: 26px; font-weight: 700; background: #d97706; color: white; border: none;' : 'padding: 2px 7px; font-size: 0.72rem; height: 26px; font-weight: 600; border: none; background: var(--color-primary);'" 
          @click="manualSave" 
          title="Desa el document (Ctrl+S)"
        >
          💾
        </button>

        <span 
          v-if="saveStatus === 'saved'" 
          style="display: inline-flex; align-items: center; font-size: 0.7rem; font-weight: 600; color: var(--color-success); background: var(--color-success-light); padding: 1px 6px; border-radius: 10px; border: 1px solid var(--color-success);"
          title="Desat"
        >
          🟢
        </span>
        <span 
          v-else-if="saveStatus === 'modified'" 
          style="display: inline-flex; align-items: center; font-size: 0.7rem; font-weight: 600; color: #b45309; background: #fef3c7; padding: 1px 6px; border-radius: 10px; border: 1px solid #f59e0b;"
          title="Modificat"
        >
          🟠
        </span>
        <span 
          v-else-if="saveStatus === 'saving'" 
          style="display: inline-flex; align-items: center; font-size: 0.7rem; font-weight: 600; color: var(--color-primary); background: var(--color-primary-light); padding: 1px 6px; border-radius: 10px; border: 1px solid var(--color-primary);" 
          class="loading-pulse"
        >
          🔵
        </span>
      </div>

      <span style="border-left: 1px solid var(--border-color); height: 18px; flex-shrink: 0;"></span>

      <!-- GRUP 2: Eina Activa (Accions Contextuals de Plantilla o Dades) (Centre) -->
      <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0; flex: 1; justify-content: center;">
        
        <!-- Contextual Actions when Tab is Plantilla (Jinja2) -->
        <template v-if="store.activeTab === 'template'">
          <button 
            class="btn-secondary" 
            style="padding: 2px 6px; font-size: 0.72rem; height: 26px;"
            :class="{ 'btn-primary': store.editorActions?.getActiveTab && store.editorActions.getActiveTab() === 'visual' }"
            @click="store.editorActions?.switchEditorTab && store.editorActions.switchEditorTab('visual')"
            title="Editor Visual (WYSIWYG)"
          >
            👁️
          </button>

          <button 
            class="btn-secondary" 
            style="padding: 2px 6px; font-size: 0.72rem; height: 26px;"
            :class="{ 'btn-primary': store.editorActions?.getActiveTab && store.editorActions.getActiveTab() === 'code' }"
            @click="store.editorActions?.switchEditorTab && store.editorActions.switchEditorTab('code')"
            title="Codi Markdown + Jinja2"
          >
            📄
          </button>

          <button 
            class="btn-secondary" 
            style="padding: 2px 6px; font-size: 0.72rem; height: 26px;"
            @click="store.editorActions?.openMetadataModal && store.editorActions.openMetadataModal()"
            title="Metadades Pandoc (Títol, autor, data, índex...)"
          >
            🏷️
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
            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px;" @click="store.editorActions?.openTableModal && store.editorActions.openTableModal()" title="Insereix taula dinàmica o manual">📊</button>
            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px;" @click="store.editorActions?.openBlockModal && store.editorActions.openBlockModal('for')" title="Insereix bucle FOR">🔁</button>
            <button class="btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px;" @click="store.editorActions?.openBlockModal && store.editorActions.openBlockModal('if')" title="Insereix condicional IF">🔀</button>
          </template>

          <button 
            class="btn btn-success" 
            style="padding: 2px 7px; font-size: 0.72rem; height: 26px; font-weight: 700; border: none; display: inline-flex; align-items: center;"
            :disabled="store.generating"
            @click="store.editorActions?.emitGenerate && store.editorActions.emitGenerate()"
            title="Genera els documents finals a partir d'aquesta plantilla"
          >
            ⚡
          </button>
        </template>

        <!-- Contextual Actions when Tab is Dades (Excel) -->
        <template v-else-if="store.activeTab === 'data'">
          <div class="segmented-control" style="display: inline-flex; border: 1px solid var(--border-color); border-radius: 4px; padding: 1px; background: var(--bg-tertiary);">
            <button 
              class="btn-segment" 
              :class="{ active: !store.dataActions?.getViewMode || store.dataActions.getViewMode() === 'complete' }"
              @click="store.dataActions?.setViewMode && store.dataActions.setViewMode('complete')"
              style="padding: 2px 6px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px;"
              title="Vista completa per fulls"
            >
              📋
            </button>
            <button 
              class="btn-segment" 
              :class="{ active: store.dataActions?.getViewMode && store.dataActions.getViewMode() === 'compact' }"
              @click="store.dataActions?.setViewMode && store.dataActions.setViewMode('compact')"
              style="padding: 2px 6px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px;"
              title="Vista compacta de fulls"
            >
              🔍
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
            style="padding: 2px 7px; font-size: 0.72rem; height: 26px; font-weight: 600; background-color: var(--color-success); border-color: var(--color-success);"
            @click="store.dataActions?.exportExcel && store.dataActions.exportExcel()"
            title="Desa els canvis i descarrega el fitxer Excel d'entrada actualitzat"
          >
            📥
          </button>
        </template>

        <template v-else-if="store.activeTab === 'upload'">
          <button class="btn btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px;" @click="loadDemo" :disabled="loadingDemo" title="Carrega fitxers de demostració per provar l'aplicació">
            ✨
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
          <option value="upload">1. 📁 Carregar Fitxers</option>
          <option value="data">2. 📊 Dades (Excel)</option>
          <option value="template">3. 📝 Plantilla (Jinja2)</option>
          <option value="preview">4. 👁️ Previsualització</option>
        </select>

        <button class="btn btn-secondary" style="padding: 2px 6px; font-size: 0.72rem; height: 26px;" @click="downloadAllProjectFiles" title="Descarrega tots els fitxers originals del projecte (ZIP)">
          📥
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

    <div class="container" :style="store.isMaximized ? 'padding: 6px 12px; gap: 0; height: calc(100vh - 42px);' : ''">

      <!-- Main Workspace Grid -->
      <div 
        class="main-grid" 
        :class="{ 'editor-maximized': store.isMaximized, 'sidebar-auto-hidden': isSidebarAutoHidden && !store.isMaximized }"
      >
        <!-- Control Card Panel -->
        <div 
          class="card control-panel-card" 
          v-show="!store.isMaximized"
          :class="{ 'auto-hidden': isSidebarAutoHidden, 'hovered': isSidebarHovered }"
          @mouseenter="isSidebarHovered = true"
          @mouseleave="isSidebarHovered = false"
        >
          <div class="card-title" style="display: flex; justify-content: space-between; align-items: center;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sliders-horizontal"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="12" x2="12" y1="18" y2="22"/></svg>
              <span>Tauler de Control</span>
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

        <!-- Main Display Card Panel -->
        <div class="card" style="flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0;">
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
          <div class="tab-content" :class="{ active: store.activeTab === 'preview' }" style="overflow-y: auto; padding-right: 6px;">
            <DocumentPreview />
          </div>
        </div>

      </div>
    </div>

    <!-- Advanced Configuration Modal -->
    <SettingsModal :isOpen="isSettingsOpen" @close="isSettingsOpen = false" />

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

    <!-- Footer with Build Code badge -->
    <footer style="text-align: center; padding: 10px 1.5rem; font-size: 0.75rem; color: var(--text-muted); border-top: 1px solid var(--border-color); background: var(--bg-secondary); margin-top: auto; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; flex-shrink: 0;">
      <div>
        <strong>Generador de Contractes Públics</strong> • Vue 3 Single-File App
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-family: monospace; font-weight: 700; background: var(--bg-tertiary); padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border-color); color: var(--text-primary);" title="Codi únic de compilació per identificar la versió distribuïda">
          🏷️ Compilació: {{ buildCode }}
        </span>
      </div>
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
