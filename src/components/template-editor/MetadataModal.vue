<!--
  elips — Editor de LIcitacions PúbliqueS
  Copyright (C) 2026  Francesc Rambla i Marigot

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
-->

<script setup>
/**
 * Pandoc YAML front-matter editor (title/author/date/toc/abstract/keywords +
 * free-form extra lines). Fully self-contained: unlike the other extracted
 * modals it never touches canvas selection/DOM — it only reads the current
 * template source (to parse an existing YAML header, if any) and emits the
 * new full template text on apply. The parent owns writing that into
 * editorText/store.templateText and re-rendering the canvas.
 */
import { ref, watch } from 'vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  templateText: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue', 'apply']);

const DEFAULT_FORM = () => ({
  title: '', subtitle: '', author: '', date: '', lang: 'ca',
  toc: false, tocTitle: 'Índex de continguts', abstract: '', keywords: '', customYamlText: '',
});

const metadataForm = ref(DEFAULT_FORM());

const parseYamlHeader = (mdText) => {
  const match = (mdText || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { header: null, body: mdText || '' };

  const yamlContent = match[1];
  const body = (mdText || '').slice(match[0].length);

  const fields = {
    title: '', subtitle: '', author: '', date: '', lang: 'ca',
    toc: false, tocTitle: 'Índex de continguts', abstract: '', keywords: '', customYaml: [],
  };

  const lines = yamlContent.split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const kvMatch = line.match(/^([a-zA-Z0-9_\-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let val = kvMatch[2].trim();
      val = val.replace(/^["'](.*)["']$/, '$1');

      if (key === 'title') fields.title = val;
      else if (key === 'subtitle') fields.subtitle = val;
      else if (key === 'author') fields.author = val;
      else if (key === 'date') fields.date = val;
      else if (key === 'lang') fields.lang = val;
      else if (key === 'toc') fields.toc = (val === 'true' || val === '1' || val === 'yes');
      else if (key === 'toc-title') fields.tocTitle = val;
      else if (key === 'abstract') fields.abstract = val;
      else if (key === 'keywords') fields.keywords = val;
      else fields.customYaml.push(line);
    } else {
      fields.customYaml.push(line);
    }
  });

  return { header: fields, body };
};

watch(() => props.modelValue, (open) => {
  if (!open) return;
  const parsed = parseYamlHeader(props.templateText || '');
  if (parsed.header) {
    metadataForm.value = {
      title: parsed.header.title,
      subtitle: parsed.header.subtitle,
      author: parsed.header.author,
      date: parsed.header.date,
      lang: parsed.header.lang || 'ca',
      toc: parsed.header.toc,
      tocTitle: parsed.header.tocTitle || 'Índex de continguts',
      abstract: parsed.header.abstract,
      keywords: parsed.header.keywords,
      customYamlText: parsed.header.customYaml.join('\n'),
    };
  } else {
    metadataForm.value = { ...DEFAULT_FORM(), date: new Date().toLocaleDateString('ca-ES') };
  }
});

const close = () => emit('update:modelValue', false);

const apply = () => {
  const customLines = (metadataForm.value.customYamlText || '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  const lines = ['---'];
  if (metadataForm.value.title) lines.push(`title: "${metadataForm.value.title.replace(/"/g, '\\"')}"`);
  if (metadataForm.value.subtitle) lines.push(`subtitle: "${metadataForm.value.subtitle.replace(/"/g, '\\"')}"`);
  if (metadataForm.value.author) lines.push(`author: "${metadataForm.value.author.replace(/"/g, '\\"')}"`);
  if (metadataForm.value.date) lines.push(`date: "${metadataForm.value.date.replace(/"/g, '\\"')}"`);
  if (metadataForm.value.lang) lines.push(`lang: "${metadataForm.value.lang}"`);
  if (metadataForm.value.toc) {
    lines.push('toc: true');
    if (metadataForm.value.tocTitle) lines.push(`toc-title: "${metadataForm.value.tocTitle.replace(/"/g, '\\"')}"`);
  }
  if (metadataForm.value.abstract) lines.push(`abstract: "${metadataForm.value.abstract.replace(/"/g, '\\"')}"`);
  if (metadataForm.value.keywords) lines.push(`keywords: "${metadataForm.value.keywords.replace(/"/g, '\\"')}"`);
  if (customLines.length > 0) customLines.forEach((l) => lines.push(l));
  lines.push('---');

  const yamlHeaderStr = lines.join('\n');
  const parsed = parseYamlHeader(props.templateText || '');
  const newText = yamlHeaderStr + '\n\n' + parsed.body.trimStart();

  emit('apply', newText);
  emit('update:modelValue', false);
};

defineExpose({ apply });
</script>

<template>
  <div class="modal-overlay" v-if="modelValue" style="display: flex; z-index: 1060;">
    <div class="modal-content" style="max-width: 650px; width: 90%; max-height: 85vh; display: flex; flex-direction: column;">
      <div class="modal-header">
        <h3 style="border: none; padding-bottom: 0; margin: 0; display: flex; align-items: center; gap: 0.5rem;">
          🏷️ Configurar Metadades Pandoc (YAML)
        </h3>
        <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="close">&times;</button>
      </div>

      <div class="modal-body" style="flex-grow: 1; overflow-y: auto; padding: 1rem 0; display: flex; flex-direction: column; gap: 1rem;">
        <p style="margin: 0; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.4;">
          Pandoc utilitza aquestes metadades YAML al principi del document per generar automàticament la portada, l'autor, la data, l'índex i l'estructura del document Word final.
        </p>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
          <div class="form-row" style="grid-column: span 2;">
            <label style="font-weight: 600; font-size: 0.8rem;">Títol Principal del Document (title)</label>
            <input type="text" v-model="metadataForm.title" placeholder="ex: Memòria Justificativa de la Licitació">
          </div>

          <div class="form-row">
            <label style="font-weight: 600; font-size: 0.8rem;">Subtítol (subtitle)</label>
            <input type="text" v-model="metadataForm.subtitle" placeholder="ex: Contracte de Serveis Informàtics">
          </div>

          <div class="form-row">
            <label style="font-weight: 600; font-size: 0.8rem;">Autor / Organisme (author)</label>
            <input type="text" v-model="metadataForm.author" placeholder="ex: Òrgan de Contractació">
          </div>

          <div class="form-row">
            <label style="font-weight: 600; font-size: 0.8rem;">Data del Document (date)</label>
            <input type="text" v-model="metadataForm.date" placeholder="ex: 31 de juliol de 2026">
          </div>

          <div class="form-row">
            <label style="font-weight: 600; font-size: 0.8rem;">Idioma Principal (lang)</label>
            <select v-model="metadataForm.lang">
              <option value="ca">Català (ca)</option>
              <option value="es">Castellà (es)</option>
              <option value="en">Anglès (en)</option>
              <option value="fr">Francès (fr)</option>
              <option value="de">Alemany (de)</option>
            </select>
          </div>
        </div>

        <!-- Table of Contents configuration -->
        <div style="border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 0.75rem; background: var(--bg-tertiary); display: flex; flex-direction: column; gap: 0.5rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <input type="checkbox" id="chkToc" v-model="metadataForm.toc">
            <label for="chkToc" style="display: inline; margin: 0; font-weight: 600; font-size: 0.85rem; cursor: pointer;">
              📑 Genera automàticament l'Índex de Continguts (toc: true)
            </label>
          </div>

          <div v-if="metadataForm.toc" class="form-row" style="margin-top: 0.4rem;">
            <label style="font-weight: 600; font-size: 0.8rem;">Títol de l'Índex (toc-title)</label>
            <input type="text" v-model="metadataForm.tocTitle" placeholder="ex: Índex de continguts">
          </div>
        </div>

        <div class="form-row">
          <label style="font-weight: 600; font-size: 0.8rem;">Resum del Document / Introducció (abstract)</label>
          <textarea v-model="metadataForm.abstract" rows="2" placeholder="Resum executiu del tràmit o objecte de la contractació..."></textarea>
        </div>

        <div class="form-row">
          <label style="font-weight: 600; font-size: 0.8rem;">Paraules Clau (keywords)</label>
          <input type="text" v-model="metadataForm.keywords" placeholder="ex: contractació, licitació, plec de clàusules">
        </div>

        <!-- Advanced Custom YAML -->
        <div style="border-top: 1px dashed var(--border-color); padding-top: 0.5rem;">
          <label style="font-weight: 600; font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.25rem;">
            ⚙️ Línies YAML Addicionals Personalitzades (opcional)
          </label>
          <textarea v-model="metadataForm.customYamlText" rows="3" style="font-family: var(--font-mono); font-size: 0.75rem;" placeholder="geometry: margin=2.5cm&#10;fontsize: 11pt"></textarea>
        </div>
      </div>

      <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 0.5rem; padding-top: 0.75rem; border-top: 1px solid var(--border-color); margin-top: 0.5rem;">
        <button class="btn btn-secondary" style="width: auto;" @click="close">Cancel·lar</button>
        <button class="btn btn-primary" style="width: auto;" @click="apply">Aplicar Metadades a la Plantilla</button>
      </div>
    </div>
  </div>
</template>
