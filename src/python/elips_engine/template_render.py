# elips — Editor de LIcitacions PúbliqueS
# Copyright (C) 2026  Francesc Rambla i Marigot
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""The document-generation pipeline: template-source pre-cleanup, the
two-pass (clean + HTML-tracked) Jinja2 render that is the app's actual
"Generate document" entry point, template syntax validation, and the
single-expression preview used by the template editor's variable modal."""

import re
import os
import json

from jinja2 import Environment, StrictUndefined
from jinja2.exceptions import TemplateSyntaxError

from .text_utils import _custom_json_default
from .excel_io import excel_to_json
from .fk_hydration import hydrate_foreign_keys
from .field_self_reference import render_field_self_references
from .template_recovery import _wrap_tracked, _wrap_safe, render_with_recovery, _get_line
from .template_filters import _register_common_filters


def sanitize_empty_jinja_tags(src):
    if not src:
        return src
    src = re.sub(r'\\{\\{\\s*\\}\\}', '[Variable sense nom]', src)
    src = re.sub(r'\\{\\%\\s*\\%\\}', '', src)
    return src


_INLINE_TRAILING_BLOCK_TAG_RE = re.compile(
    r'\{%-?\s*(for|if|elif|else|endfor|endif)\b(?:(?!%\}).)*?(-?%\}|\+%\})'
)
_INLINE_VAR_TAG_RE = re.compile(r'\{\{.*?\}\}')


def protect_inline_trailing_block_tags(template_src):
    """
    trim_blocks=True strips the newline immediately after any {% ... %}
    tag — correct when the tag stands alone on its own line (e.g. a
    DYNAMIC_TABLE's {% for %}/{% endfor %} rows), but wrong when the tag
    sits at the end of a line that carries real content of its own (e.g.
    TRANSPOSED_TABLE's inline per-row `{% for %}...{% endfor %}` loop):
    there, that line's own trailing newline separates it from the next
    row/paragraph and must survive. Jinja2 lets a single tag opt out of
    trim_blocks with a `+` right before its closing `%}`; this scans every
    line and adds it only where content precedes a tag that closes the
    line, so existing templates (written before this distinction existed)
    render correctly without the author having to know this syntax.
    """
    if not template_src:
        return template_src
    lines = template_src.split('\n')
    out_lines = []
    for line in lines:
        matches = list(_INLINE_TRAILING_BLOCK_TAG_RE.finditer(line))
        if not matches:
            out_lines.append(line)
            continue
        last = matches[-1]
        if line[last.end():].strip() != '':
            out_lines.append(line)
            continue
        if last.group(2) in ('-%}', '+%}'):
            out_lines.append(line)
            continue
        before_tag = _INLINE_TRAILING_BLOCK_TAG_RE.sub('', line[:last.start()])
        before_tag = _INLINE_VAR_TAG_RE.sub('', before_tag)
        if before_tag.strip() == '':
            out_lines.append(line)
            continue
        fixed_tag = last.group(0)[:-2] + '+%}'
        out_lines.append(line[:last.start()] + fixed_tag + line[last.end():])
    return '\n'.join(out_lines)


def render_expression_preview(ctx_json, expr_str):
    """Evaluates a single Jinja2 expression (a variable path plus an
    optional filter chain, e.g. "pres.parts | sum(attribute='import')")
    against a JSON sample context — used by the template editor's variable
    modal to show a live preview of what a filter chain actually produces,
    without needing to render a whole document. Returns the real Python
    value (not stringified), so the caller can tell a scalar apart from a
    list/dict result. Never raises: any failure (bad path, wrong filter
    arity, an iterator not present in the sample context, ...) comes back
    as {success: False, error} instead, since a preview is best-effort by
    nature — the expression may reference loop iterators the caller could
    only approximate with a sample row.
    """
    try:
        ctx = json.loads(ctx_json)
        if not isinstance(ctx, dict):
            ctx = {}
        env = Environment(undefined=StrictUndefined, autoescape=False)
        _register_common_filters(env)
        compiled = env.compile_expression(expr_str, undefined_to_none=False)
        result = compiled(**ctx)
        return json.dumps({'success': True, 'result': result}, default=_custom_json_default, ensure_ascii=False)
    except Exception as ex:
        return json.dumps({'success': False, 'error': str(ex)}, ensure_ascii=False)


def validate_template_syntax(template_src):
    """Parses template_src with the real Jinja2 parser -- no rendering, no
    data context needed -- to catch structural syntax errors (mismatched or
    unclosed {% %} blocks, a stray {% elif %}/{% else %} where the block
    type doesn't support one, a malformed expression, ...): the same errors
    the actual document-generation pass would eventually hit, surfaced
    immediately from the template editor's "Comprova Plantilla" button
    instead. This is the authoritative check -- the visual canvas's own
    compiler (useMarkdownJinjaCompiler.js) is a best-effort approximation
    that never raises (a malformed block is just left as literal text), so
    it can't itself tell the user *why* something didn't render as expected.
    Never raises: any problem comes back as {valid: False, error: {...}}.
    """
    try:
        env = Environment(trim_blocks=True, lstrip_blocks=True)
        env.parse(template_src)
        return json.dumps({'valid': True, 'error': None})
    except TemplateSyntaxError as e:
        lineno = getattr(e, 'lineno', None)
        return json.dumps({
            'valid': False,
            'error': {
                'line': lineno,
                'message': e.message or str(e),
                'lineText': _get_line(template_src, lineno),
            },
        }, ensure_ascii=False)
    except Exception as ex:
        return json.dumps({'valid': False, 'error': {'line': None, 'message': str(ex), 'lineText': ''}}, ensure_ascii=False)


def render_json_text(excel_path, date_format='iso', strict=False):
    doc = excel_to_json(excel_path, date_format=date_format, strict=strict)
    return json.dumps(doc, ensure_ascii=False, default=_custom_json_default)


def _merge_live_json_into_doc(doc_val, live_val, depth=0, max_depth=20):
    """Recursively backfills doc_val (freshly re-parsed from the .xlsx) with
    anything present in live_val (the live in-browser JSON) that is missing
    or falsy on the doc side. Never removes or renames real data; only adds
    keys the Excel re-read couldn't have produced (e.g. calculated fields),
    at any nesting depth and inside tabular (list) rows."""
    if depth > max_depth:
        return doc_val
    if isinstance(doc_val, dict) and isinstance(live_val, dict):
        for k, v in live_val.items():
            if isinstance(k, str) and (k.startswith('_') or k in ('editor_metadata', 'editormetadata', '_hierarchy_schema', 'hierarchy_schema')):
                continue
            if k not in doc_val or not doc_val[k]:
                doc_val[k] = v
            else:
                doc_val[k] = _merge_live_json_into_doc(doc_val[k], v, depth + 1, max_depth)
        return doc_val
    if isinstance(doc_val, list) and isinstance(live_val, list):
        if len(doc_val) != len(live_val):
            # Row count diverged since the Excel was last regenerated (e.g. a
            # row was added/removed live): trust the live data wholesale.
            return live_val
        return [_merge_live_json_into_doc(d, l, depth + 1, max_depth) for d, l in zip(doc_val, live_val)]
    return doc_val


def _is_value_empty(val):
    if val is None:
        return True
    if isinstance(val, str):
        return val.strip() == ''
    if isinstance(val, (list, dict)):
        return len(val) == 0
    return False


def _is_row_empty(item, visited=None, depth=0, max_depth=15):
    if depth > max_depth:
        return False
    if visited is None:
        visited = set()
    if isinstance(item, (dict, list)):
        item_id = id(item)
        if item_id in visited:
            return True
        visited.add(item_id)

    if not isinstance(item, dict):
        return _is_value_empty(item)
    for k, v in item.items():
        if k in ('editor_metadata', '_hierarchy_schema', '_path'):
            continue
        if isinstance(v, list):
            non_empty_children = [child for child in v if not _is_row_empty(child, visited, depth + 1, max_depth)]
            if non_empty_children:
                return False
        elif isinstance(v, dict):
            if not _is_row_empty(v, visited, depth + 1, max_depth):
                return False
        else:
            if not _is_value_empty(v):
                return False
    return True


def _filter_empty_rows(data, visited=None, depth=0, max_depth=15):
    if depth > max_depth:
        return data
    if visited is None:
        visited = set()
    if isinstance(data, (dict, list)):
        data_id = id(data)
        if data_id in visited:
            return data
        visited.add(data_id)

    if isinstance(data, dict):
        new_dict = {}
        for k, v in data.items():
            if k in ('editor_metadata', '_hierarchy_schema'):
                new_dict[k] = v
            else:
                new_dict[k] = _filter_empty_rows(v, visited, depth + 1, max_depth)
        return new_dict
    elif isinstance(data, list):
        filtered_list = []
        for item in data:
            if isinstance(item, dict):
                if not _is_row_empty(item, visited.copy(), depth + 1, max_depth):
                    filtered_list.append(_filter_empty_rows(item, visited, depth + 1, max_depth))
            else:
                if not _is_value_empty(item):
                    filtered_list.append(_filter_empty_rows(item, visited, depth + 1, max_depth))
        return filtered_list
    return data


def render_md_two_pass_with_report(excel_path, template_path, date_format='iso', strict=False):
    import traceback
    try:
        raw_doc = excel_to_json(excel_path, date_format=date_format, strict=strict)
        if isinstance(raw_doc, dict) and 'data' in raw_doc and isinstance(raw_doc['data'], dict):
            raw_data = raw_doc['data']
        else:
            raw_data = raw_doc
        doc = _filter_empty_rows(raw_data)

        # Foreign-key hydration (Select/dynamic fields, below) needs the
        # editor_metadata rows to know which fields are FKs and how to resolve
        # them — keep a reference to it *before* it gets popped off the tree
        # that Jinja2 actually sees. It may be replaced with a fresher copy
        # from /work/in.json below (see the live-state merge).
        fk_meta_list = doc.get('editor_metadata') or doc.get('editormetadata') or []

        # Remove internal metadata keys from main data model so Jinja2 context never sees them as data nodes
        doc.pop('_sheet_info', None)
        doc.pop('editor_metadata', None)
        doc.pop('_hierarchy_schema', None)
        doc.pop('editormetadata', None)
        doc.pop('hierarchy_schema', None)

        # Merge latest JSON from /work/in.json if present. This backfills anything
        # present in the live in-browser state (store.excelJsonData) but absent from
        # a fresh re-read of the .xlsx — most importantly, calculated/virtual fields
        # (editor_metadata type "Computed" or row-level CUSTOM formulas), which are
        # never written back as real Excel columns and so never survive excel_to_json
        # on their own. Recurses through nested groups and tabular (list) rows at any
        # depth, not just the top level, so calculated fields inside a `{% for %}`
        # loop over a sub-table are picked up too.
        try:
            if os.path.exists('/work/in.json'):
                with open('/work/in.json', 'r', encoding='utf-8') as f:
                    json_data = json.load(f)
                    if isinstance(json_data, dict):
                        if 'data' in json_data and isinstance(json_data['data'], dict):
                            json_data = json_data['data']
                        live_meta = json_data.get('editor_metadata') or json_data.get('editorMetadata')
                        if isinstance(live_meta, list) and live_meta:
                            fk_meta_list = live_meta
                        for k, v in json_data.items():
                            if k.startswith('_') or k in ('editor_metadata', 'editormetadata', '_hierarchy_schema', 'hierarchy_schema'):
                                continue
                            if k not in doc or not doc[k]:
                                doc[k] = v
                            else:
                                doc[k] = _merge_live_json_into_doc(doc[k], v)
        except Exception:
            pass

        doc = hydrate_foreign_keys(doc, fk_meta_list)

        # A field's own stored text may itself contain embedded Jinja2 (see
        # field_self_reference.py's module docstring) -- rendered here, once,
        # against a context scoped to the row that field lives on (`parent`/
        # `parent.parent`... for the nested-table ancestor chain, its own
        # sibling fields as bare names), BEFORE the whole-document clean_ctx/
        # html_ctx wraps below are built from the same tree, so both passes
        # see the field's final, already-resolved text.
        doc, self_ref_issues = render_field_self_references(doc)

        with open(template_path, 'r', encoding='utf-8') as f:
            tpl_src = f.read()

        # Clean non-breaking spaces ( ) that might be attached to Jinja2 tags
        tpl_src = tpl_src.replace(' ', ' ')

        # See protect_inline_trailing_block_tags: keeps trim_blocks (below)
        # from eating row-separating newlines in TRANSPOSED_TABLE's inline
        # per-row {% for %}...{% endfor %} loops.
        tpl_src = protect_inline_trailing_block_tags(tpl_src)

        def _normalize_markdown_headings(text):
            if not text:
                return text
            lines = text.split('\\n')
            out = []
            for i, line in enumerate(lines):
                stripped = line.lstrip()
                if stripped.startswith('#') and i > 0:
                    if out and out[-1].strip() != '':
                        out.append('')
                out.append(line)
            return '\\n'.join(out)

        # Pass 1: Clean Context without HTML links (for Pandoc / Word export)
        clean_ctx = _wrap_safe(doc, '')
        if 'doc' not in clean_ctx:
            clean_ctx['doc'] = clean_ctx

        # trim_blocks/lstrip_blocks=True: a block tag's own trailing newline
        # (and, for lstrip_blocks, its leading indentation) is stripped
        # instead of ending up in the output — otherwise every
        # {% for %}/{% endfor %}/{% if %}/{% endif %} leaves a blank line
        # behind, which breaks any Markdown table generated by looping over
        # its rows (a blank line ends a table) and adds unwanted spacing
        # around conditionally-included paragraphs.
        env_clean = Environment(undefined=StrictUndefined, autoescape=False, trim_blocks=True, lstrip_blocks=True)
        _register_common_filters(env_clean)

        out1_clean, issues1 = render_with_recovery(env_clean, tpl_src, clean_ctx, 'primera')
        if '{{' in out1_clean or '{%' in out1_clean:
            out2_clean, issues2 = render_with_recovery(env_clean, out1_clean, clean_ctx, 'segona')
        else:
            out2_clean = out1_clean
            issues2 = []
        all_issues = self_ref_issues + issues1 + issues2

        # Pass 2: Tracked Context with HTML links (for HTML preview)
        html_ctx = _wrap_tracked(doc, '', enable_links=True)
        if 'doc' not in html_ctx:
            html_ctx['doc'] = html_ctx

        # trim_blocks/lstrip_blocks=True: see env_clean above.
        env_html = Environment(undefined=StrictUndefined, autoescape=False, trim_blocks=True, lstrip_blocks=True)
        _register_common_filters(env_html)

        out1_html, _ = render_with_recovery(env_html, tpl_src, html_ctx, 'primera_html')
        if '{{' in out1_html or '{%' in out1_html:
            out2_html, _ = render_with_recovery(env_html, out1_html, html_ctx, 'segona_html')
        else:
            out2_html = out1_html

        out2_clean = _normalize_markdown_headings(out2_clean)
        out2_html = _normalize_markdown_headings(out2_html)

        return json.dumps({
            'success': True,
            'markdown': out2_clean,
            'htmlMarkdown': out2_html,
            'issues': all_issues
        }, ensure_ascii=False, default=_custom_json_default)
    except Exception as ex:
        tb_str = traceback.format_exc()
        lineno = getattr(ex, 'lineno', None)
        msg = str(ex)
        return json.dumps({
            'success': False,
            'error': f"Error de conversió Jinja2: {msg}",
            'message': msg,
            'traceback': tb_str,
            'line': lineno
        }, ensure_ascii=False, default=_custom_json_default)
