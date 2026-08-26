import { defineStore } from 'pinia';

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    // Uploaded raw files (live File objects)
    excelFile: null,
    templateFile: null,
    refDocFile: null,
    extraFiles: [],
    
    // Autodesat names/sizes (recovered from localStorage)
    excelFileName: localStorage.getItem('excelFileName') || '',
    excelFileSize: parseInt(localStorage.getItem('excelFileSize') || '0', 10),
    templateFileName: localStorage.getItem('templateFileName') || '',
    templateFileSize: parseInt(localStorage.getItem('templateFileSize') || '0', 10),
    refDocFileName: localStorage.getItem('refDocFileName') || '',
    refDocFileSize: parseInt(localStorage.getItem('refDocFileSize') || '0', 10),

    // Core data outputs (restored from localStorage)
    excelJsonData: (() => {
      try {
        return JSON.parse(localStorage.getItem('excelJsonData') || 'null');
      } catch (e) {
        return null;
      }
    })(),
    templateText: localStorage.getItem('templateText') || '',
    editorMetadata: (() => {
      try {
        return JSON.parse(localStorage.getItem('editorMetadata') || '[]');
      } catch (e) {
        return [];
      }
    })(),
    sheetInfo: (() => {
      try {
        const pName = localStorage.getItem('currentProjectName') || 'Default';
        return JSON.parse(localStorage.getItem(`${pName}:sheetInfo`) || localStorage.getItem('sheetInfo') || '[]');
      } catch (e) {
        return [];
      }
    })(),
    renderedMarkdown: '',
    cleanMarkdown: '',
    targetDataPath: null,
    hierarchySchema: (() => {
      try {
        const pName = localStorage.getItem('currentProjectName') || 'Default';
        return JSON.parse(localStorage.getItem(`${pName}:hierarchySchema`) || localStorage.getItem('hierarchySchema') || '{}');
      } catch (e) {
        return {};
      }
    })(),
    
    // UI state
    enginesReady: false,
    generating: false,
    rawPythonJsonStr: '',
    excelImportInspection: null,
    showExcelImportModal: false,
    activeTab: (() => {
      const pName = localStorage.getItem('currentProjectName') || 'Default';
      const tab = localStorage.getItem(`${pName}:activeTab`);
      return (tab && ['upload', 'data', 'template', 'preview'].includes(tab)) ? tab : 'upload';
    })(),
    isMaximized: (() => {
      const pName = localStorage.getItem('currentProjectName') || 'Default';
      return localStorage.getItem(`${pName}:isMaximized`) === 'true';
    })(),
    debugComputedFields: (() => {
      return localStorage.getItem('debugComputedFields') === 'true';
    })(),
    
    // Active Tool Action Handlers (for super-toolbar integration)
    editorActions: {
      switchEditorTab: null,
      openMetadataModal: null,
      formatBlock: null,
      formatDoc: null,
      insertList: null,
      openTableModal: null,
      openBlockModal: null,
      emitGenerate: null,
      activeEditorTab: 'visual',
    },
    dataActions: {
      setViewMode: null,
      toggleJsonView: null,
      exportExcel: null,
      viewMode: 'complete',
      showJsonView: false,
    },
    
    // Console logs & errors
    logs: [
      { time: new Date().toLocaleTimeString(), text: 'Preparat. Pugeu fitxers d\'entrada per començar.', type: 'info' }
    ],
    issues: [],
    lastConversionError: null,
    isConversionErrorModalOpen: false,
    
    // Output names configurations
    outNameDocx: 'memoria_justificativa.docx',
    outNameMd: 'memoria_justificativa.md',
    
    // System Advanced configuration parameters
    config: {
      pyIndex: 'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/',
      pandocUrl: 'https://cdn.jsdelivr.net/npm/pandoc-wasm@1.0.1/pandoc.js',
      pandocWasmUrl: 'https://cdn.jsdelivr.net/npm/pandoc-wasm@1.0.1/pandoc.wasm',
      dateFormat: 'iso',
      strictMode: false,
      useDefaultRef: true,
      mainThreadPandoc: true,
      showButtonTexts: localStorage.getItem('showButtonTexts') !== 'false',
      labelPosition: localStorage.getItem('labelPosition') || 'top', // 'top' (default) or 'left'
      autoSaveDebounceSeconds: parseInt(localStorage.getItem('autoSaveDebounceSeconds') || '5', 10) // 5 seconds default
    }
  }),
  
  getters: {
    excelFileFake: (state) => state.excelFileName ? { name: `${state.excelFileName} (Autodesat)`, size: state.excelFileSize } : null,
    templateFileFake: (state) => state.templateFileName ? { name: `${state.templateFileName} (Autodesat)`, size: state.templateFileSize } : null,
    refDocFileFake: (state) => state.refDocFileName ? { name: `${state.refDocFileName} (Autodesat)`, size: state.refDocFileSize } : null,
  },
  
  actions: {
    addLog(text, type = 'info') {
      const time = new Date().toLocaleTimeString();
      this.logs.push({ time, text, type });
      console.log(`[${type.toUpperCase()}] ${text}`);
    },
    
    clearLogs() {
      this.logs = [];
    },
    
    setActiveTab(tab) {
      if (['upload', 'data', 'template', 'preview'].includes(tab)) {
        this.activeTab = tab;
        const pName = localStorage.getItem('currentProjectName') || 'Default';
        localStorage.setItem(`${pName}:activeTab`, tab);
      }
    },

    navigateToDataPath(path) {
      if (!path) return;
      const cleanPath = String(path).replace(/^#?(dades|doc)\./, '').replace(/\[(\d+)\]/g, '.$1');
      this.targetDataPath = cleanPath;
      this.setActiveTab('data');
      this.addLog(`Navegant als dades de l'Excel: ${cleanPath}`, 'info');
    },
    
    toggleMaximize() {
      this.isMaximized = !this.isMaximized;
      const pName = localStorage.getItem('currentProjectName') || 'Default';
      localStorage.setItem(`${pName}:isMaximized`, this.isMaximized ? 'true' : 'false');
      this.addLog(this.isMaximized ? "S'ha maximitzat la vista a pantalla completa." : "S'ha restaurat el disseny estàndard.", "info");
    },
    
    setExcelFile(file) {
      this.excelFile = file;
      this.excelFileName = file.name;
      this.excelFileSize = file.size;
      this.addLog(`Excel seleccionat: ${file.name} (${this.formatBytes(file.size)})`, 'info');
    },
    
    setTemplateFile(file, content) {
      this.templateFile = file;
      this.templateFileName = file.name;
      this.templateFileSize = file.size;
      this.templateText = content;
      this.addLog(`Plantilla Jinja2 seleccionada: ${file.name} (${this.formatBytes(file.size)})`, 'info');
    },
    
    setRefDocFile(file) {
      this.refDocFile = file;
      this.refDocFileName = file.name;
      this.refDocFileSize = file.size;
      this.addLog(`Document de referència custom seleccionat: ${file.name} (${this.formatBytes(file.size)})`, 'info');
    },
    
    resetExcel() {
      this.excelFile = null;
      this.excelJsonData = null;
      this.excelFileName = '';
      this.excelFileSize = 0;
      this.addLog('S\'ha eliminat el fitxer Excel.', 'info');
    },
    
    resetTemplate() {
      this.templateFile = null;
      this.templateText = '';
      this.templateFileName = '';
      this.templateFileSize = 0;
      this.addLog('S\'ha eliminat la plantilla.', 'info');
    },
    
    resetRefDoc() {
      this.refDocFile = null;
      this.refDocFileName = '';
      this.refDocFileSize = 0;
      this.addLog('S\'ha restablert el document de referència al corporatiu.', 'info');
    },

    setConversionError(errData) {
      this.lastConversionError = errData;
      this.isConversionErrorModalOpen = !!errData;
    },

    clearConversionError() {
      this.lastConversionError = null;
      this.isConversionErrorModalOpen = false;
    },
    
    formatBytes(bytes) {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
  }
});
