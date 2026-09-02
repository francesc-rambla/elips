<script setup>
/**
 * LaTeX equation editor (symbol picker + live KaTeX preview + a small
 * embedded data browser to insert Excel variables into the expression).
 * Self-contained: owns the expression text and caret position entirely
 * within its own <input>. On apply it reports { expr, type } and lets the
 * parent do the actual canvas DOM insertion/update — that logic also has to
 * know whether it's editing an existing .latex-chip node vs. inserting a new
 * one at the saved selection, which is canvas-level state the parent owns.
 */
import { ref, computed, watch, nextTick } from 'vue';
import { useWorkspaceStore } from '../../stores/workspace';
import katex from 'katex';
import { latexSymbols } from '../latexSymbols';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  initialExpr: { type: String, default: '' },
  initialType: { type: String, default: 'inline' },
  activeLoopContext: { type: Object, default: null },
});

const emit = defineEmits(['update:modelValue', 'apply']);

const store = useWorkspaceStore();

const mathExpr = ref('');
const mathType = ref('inline');
const activeMathCategory = ref(latexSymbols.categorias[0]?.id || 'basico');
const mathExprInputRef = ref(null);
const mathCaretStart = ref(0);
const mathCaretEnd = ref(0);

watch(() => props.modelValue, (open) => {
  if (!open) return;
  mathExpr.value = props.initialExpr || '';
  mathType.value = props.initialType || 'inline';
  mathCaretStart.value = mathExpr.value.length;
  mathCaretEnd.value = mathExpr.value.length;
});

const close = () => emit('update:modelValue', false);

const getCategoryNameInCatalan = (name) => {
  const translations = {
    'Basic': 'Bàsic', 'Delimiters': 'Delimitadors', 'Grouping': 'Agrupació',
    'Operators and relations': 'Operadors i relacions', 'Sets': 'Conjunts', 'Logic': 'Lògica',
    'Functions': 'Funcions', 'Calculus': 'Càlcul', 'Arrows': 'Fletxes', 'Matrices': 'Matrius',
    'Systems': 'Sistemes', 'Decorations': 'Decoracions', 'Annotations': 'Anotacions',
    'Text formatting': 'Format de text', 'Greek': 'Lletres gregues',
  };
  return translations[name] || name;
};

const renderSymbolHtml = (el) => {
  const expr = el.display || el.latex;
  try {
    return katex.renderToString(expr, { throwOnError: false, displayMode: false });
  } catch (_) {
    return expr;
  }
};

const saveMathCaret = (e) => {
  const input = e.target;
  mathCaretStart.value = input.selectionStart;
  mathCaretEnd.value = input.selectionEnd;
};

const insertAtCaret = (text, moveCaretInto) => {
  const start = mathCaretStart.value;
  const end = mathCaretEnd.value;
  const val = mathExpr.value || '';

  mathExpr.value = val.substring(0, start) + text + val.substring(end);
  mathCaretStart.value = start + text.length;
  mathCaretEnd.value = start + text.length;

  nextTick(() => {
    const input = mathExprInputRef.value;
    if (!input) return;
    input.focus();
    let newCursorPos = start + text.length;
    if (moveCaretInto) {
      const braceIndex = text.indexOf('{}');
      if (braceIndex !== -1) {
        newCursorPos = start + braceIndex + 1;
        mathCaretStart.value = newCursorPos;
        mathCaretEnd.value = newCursorPos;
      }
    }
    input.setSelectionRange(newCursorPos, newCursorPos);
  });
};

const insertLatexAtCursor = (latexCode) => insertAtCaret(latexCode, true);
const insertVarIntoMathExpr = (varPath) => insertAtCaret(`{{ ${varPath} }}`, false);

const renderWithJinjaPlaceholders = (expr, displayMode) => {
  const cleanExpr = expr.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, p1) => `\\text{[${p1.trim().replace(/_/g, '\\_')}]}`);
  return katex.renderToString(cleanExpr, { displayMode, throwOnError: false });
};

const currentMathPreview = computed(() => {
  const expr = mathExpr.value.trim();
  if (!expr) return '<span style="color:var(--text-muted); font-style:italic;">La previsualització de la fórmula es mostrarà aquí...</span>';
  try {
    return renderWithJinjaPlaceholders(expr, mathType.value === 'display');
  } catch (err) {
    return `<span style="color:var(--color-danger);">${err.message}</span>`;
  }
});

const apply = () => {
  emit('apply', { expr: mathExpr.value.trim(), type: mathType.value });
  emit('update:modelValue', false);
};

defineExpose({ apply });
</script>

<template>
  <div class="modal-overlay" :style="{ display: modelValue ? 'flex' : 'none' }">
    <div class="modal-content" style="max-width: 1200px; width: 98%;">
      <div class="modal-header">
        <h3 style="border: none; padding-bottom: 0; margin: 0;">Editor d'Equacions LaTeX</h3>
        <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="close">&times;</button>
      </div>

      <div class="modal-body" style="display: grid; grid-template-columns: 200px 1fr 280px; gap: 1.5rem; height: 500px; max-height: 70vh;">
        <!-- Left side: Categories list -->
        <div style="border-right: 1px solid var(--border-color); padding-right: 1rem; display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto;">
          <button
            v-for="cat in latexSymbols.categorias"
            :key="cat.id"
            class="btn"
            :class="activeMathCategory === cat.id ? 'btn-primary' : 'btn-secondary'"
            style="width: 100%; text-align: left; padding: 8px 12px; font-size: 0.85rem;"
            @click="activeMathCategory = cat.id"
          >
            {{ getCategoryNameInCatalan(cat.nombre) }}
          </button>
        </div>

        <!-- Middle side: Symbols Grid and Input/Preview -->
        <div style="display: flex; flex-direction: column; gap: 1.25rem; overflow-y: auto; padding-right: 0.5rem;">
          <!-- Symbols Grid -->
          <div style="background-color: var(--bg-tertiary); padding: 1rem; border-radius: 6px; border: 1px solid var(--border-color); flex-grow: 1; overflow-y: auto;">
            <div
              v-for="cat in latexSymbols.categorias"
              :key="cat.id"
              v-show="activeMathCategory === cat.id"
              style="display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); gap: 8px;"
            >
              <button
                v-for="(el, idx) in cat.elementos"
                :key="idx"
                class="btn btn-secondary"
                style="height: 50px; padding: 4px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: white;"
                :title="el.title"
                @click="insertLatexAtCursor(el.latex)"
              >
                <span v-html="renderSymbolHtml(el)" style="font-size: 1.15rem; color: #1e293b;"></span>
              </button>
            </div>
          </div>

          <!-- Real-time Preview Box -->
          <div style="border: 1px solid var(--border-color); border-radius: 6px; padding: 1rem; background-color: var(--bg-card); display: flex; align-items: center; justify-content: center; min-height: 80px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.05);">
            <div v-html="currentMathPreview" style="font-size: 1.25rem;"></div>
          </div>

          <!-- Input control -->
          <div style="display: grid; grid-template-columns: 1fr 240px; gap: 1rem; align-items: end;">
            <div class="form-row" style="margin: 0;">
              <label for="mathExprInput">Expressió LaTeX</label>
              <input
                type="text"
                id="mathExprInput"
                ref="mathExprInputRef"
                v-model="mathExpr"
                placeholder="e = mc^2"
                style="font-family: monospace; font-size: 1.05rem; padding: 8px;"
                @blur="saveMathCaret"
                @keyup="saveMathCaret"
                @click="saveMathCaret"
                @focus="saveMathCaret"
              >
            </div>

            <div class="form-row" style="margin: 0;">
              <label for="mathTypeSelect">Tipus de Fórmula</label>
              <select
                id="mathTypeSelect"
                v-model="mathType"
                style="padding: 6px; border: 1px solid var(--border-color); border-radius: 4px; height: 42px; font-size: 0.9rem;"
              >
                <option value="inline">En línia ($ ... $)</option>
                <option value="display">Independent / Bloc ($$ ... $$)</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Right side: Data Browser (Grouped, contextual tree matching main sidebar) -->
        <div style="border-left: 1px solid var(--border-color); padding-left: 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto;">
          <div style="font-size: 0.8rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 0.5rem; letter-spacing: 0.05em;">
            Navegador de Dades
          </div>

          <!-- Contextual loop variables banner in equation modal -->
          <div v-if="activeLoopContext" style="background-color: var(--color-primary-light); padding: 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-focus); margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.35rem;">
            <div style="font-size: 0.65rem; font-weight: bold; color: var(--color-primary); text-transform: uppercase;">
              📌 Dins del bucle actiu:
            </div>
            <code style="font-family: var(--font-mono); font-size: 0.7rem; font-weight: bold; color: var(--text-primary);">
              for {{ activeLoopContext.iterator }} in {{ activeLoopContext.arrayPath }}
            </code>
            <div style="display:flex; flex-direction:column; gap:0.3rem; margin-top:0.15rem;">
              <div
                v-for="col in activeLoopContext.columns"
                :key="col"
                class="variable-item present"
                style="background-color: var(--bg-card); margin: 0; font-size: 0.75rem; padding: 4px 6px; justify-content: space-between;"
                @click="insertVarIntoMathExpr(`${activeLoopContext.iterator}.${col}`)"
                title="Insereix variable contextual del bucle"
              >
                <span style="font-weight: 600;">{{ activeLoopContext.iterator }}.{{ col }}</span>
                <span class="variable-badge present" style="background-color: var(--color-primary); color: white;">bucle</span>
              </div>
            </div>
          </div>

          <div v-if="!store.excelJsonData" style="font-size:0.75rem; color:var(--text-muted); font-style:italic">
            Carrega un Excel per activar el navegador.
          </div>
          <div v-else style="display:flex; flex-direction:column; gap:0.6rem;">
            <div v-for="(item, rootKey) in store.excelJsonData" :key="rootKey" style="margin-bottom:0.25rem;">
              <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); margin-bottom: 0.25rem; border-bottom: 1px solid var(--border-color); padding-bottom: 2px;">
                {{ rootKey }}
              </div>

              <template v-if="Array.isArray(item)">
                <template v-if="item.length > 0">
                  <div
                    v-for="subKey in Object.keys(item[0])"
                    v-show="subKey !== rootKey"
                    :key="subKey"
                    class="variable-item present"
                    style="margin: 0; font-size: 0.75rem; padding: 4px 6px; justify-content: space-between;"
                    @click="insertVarIntoMathExpr(`${rootKey}.${subKey}`)"
                    title="Clica per inserir variable"
                  >
                    <span>{{ subKey }}</span>
                    <span class="variable-badge present">Columna</span>
                  </div>
                </template>
              </template>

              <template v-else>
                <div
                  v-for="(val, k) in item"
                  :key="k"
                  class="variable-item present"
                  style="margin: 0; font-size: 0.75rem; padding: 4px 6px; justify-content: space-between;"
                  @click="insertVarIntoMathExpr(`${rootKey}.${k}`)"
                  title="Clica per inserir variable"
                >
                  <span>{{ k }}</span>
                  <span class="variable-badge present">Clau</span>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" style="width: auto;" @click="close">Cancel·lar</button>
        <button class="btn btn-primary" style="width: auto;" @click="apply">Aplicar</button>
      </div>
    </div>
  </div>
</template>
