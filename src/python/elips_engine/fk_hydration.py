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

"""Turns a dynamic-Select foreign-key field's plain scalar value (an id) into
the related row's full data, so a Jinja2 template can write `field.otherCol`
directly. Used by render_md_two_pass_with_report (document generation).

The live-editing counterpart, hydrateModelWithForeignKeys, is JS-side
(src/composables/useWasmEngines.js) and runs before Pyodide is even called —
kept separate rather than shared, since it needs to run before there is any
Python data to hand this module. Extracted here as top-level functions
(rather than staying nested inside render_md_two_pass_with_report, as they
originally were) specifically so each can be called and tested on its own —
a lesson from a real bug this exact hydration step had while it was still an
unreachable closure (see run_custom_pass/run_agg_pass in calc_fields.py for
the matching story on the calculated-fields side)."""


def resolve_fk_table(root, vec_path, depth=0):
    """Resolves a dynamic-Select field's `vectorPath` (the name of the array
    to read candidate rows from) against `root`, trying progressively looser
    strategies -- `vec_path` is normally just the bare array key even when
    that array is nested inside a key-value group, because that's what the
    config UI's own table picker offers. Mirrors resolveVectorList in
    src/composables/useSchemaResolver.js (JS side, used by the live
    dropdown) -- kept as a separate implementation since one runs in the
    browser before any Python is involved and the other runs here."""
    if not vec_path or not isinstance(root, (dict, list)) or depth > 10:
        return None
    if isinstance(root, dict):
        if isinstance(root.get(vec_path), list):
            return root[vec_path]
        if isinstance(root.get(f"OUT_{vec_path}"), list):
            return root[f"OUT_{vec_path}"]
        if '.' in vec_path:
            parts = vec_path.replace('doc.', '').replace('dades.', '').split('.')
            curr = root
            for p in parts:
                curr = curr.get(p) if isinstance(curr, dict) else None
            if isinstance(curr, list):
                return curr
    children = root if isinstance(root, list) else root.values()
    for val in children:
        if isinstance(val, (dict, list)):
            found = resolve_fk_table(val, vec_path, depth + 1)
            if found is not None:
                return found
    return None


def _process_fk_item(fk_map, doc_dict, group_name, item):
    if isinstance(item, list):
        for row in item:
            _process_fk_item(fk_map, doc_dict, group_name, row)
    elif isinstance(item, dict):
        for k, v in list(item.items()):
            meta_key = f"{group_name}.{k}"
            meta = None
            if meta_key in fk_map:
                meta = fk_map[meta_key]
            else:
                for fk_k, fk_m in fk_map.items():
                    if fk_k.endswith(f".{k}") or fk_k == k or (isinstance(fk_m, dict) and fk_m.get('element') == k):
                        meta = fk_m
                        break
            if meta and v is not None and v != '' and not isinstance(v, (dict, list)):
                tbl = resolve_fk_table(doc_dict, meta.get('vectorPath'))
                if tbl and isinstance(tbl, list):
                    v_field = str(meta.get('valueField', ''))
                    d_field = str(meta.get('displayField', ''))
                    matched = None
                    for target_row in tbl:
                        if isinstance(target_row, dict):
                            v_k = v_field if (v_field and v_field in target_row) else (list(target_row.keys())[0] if target_row else '')
                            d_k = d_field if (d_field and d_field in target_row) else v_k
                            target_val = str(target_row.get(v_k, ''))
                            target_disp = str(target_row.get(d_k, ''))
                            if target_val == str(v) or target_disp == str(v):
                                matched = target_row
                                break
                    if matched:
                        hydrated = dict(matched)
                        hydrated['_default_val'] = v
                        hydrated['value'] = v
                        hydrated['val'] = v
                        item[k] = hydrated
            if isinstance(v, (dict, list)) and k not in ('editor_metadata', '_hierarchy_schema'):
                child_path = f"{group_name}.{k}"
                _process_fk_item(fk_map, doc_dict, child_path, v)


def hydrate_foreign_keys(doc_dict, meta_list):
    if not isinstance(doc_dict, dict) or not isinstance(meta_list, list) or not meta_list:
        return doc_dict
    fk_map = {}
    for meta in meta_list:
        if isinstance(meta, dict):
            m_type = str(meta.get('type', ''))
            m_src = str(meta.get('sourceType', ''))
            m_vec = str(meta.get('vectorPath', ''))
            grp = str(meta.get('group', ''))
            elem = str(meta.get('element', ''))
            if m_type == 'Select' and m_src == 'dynamic' and m_vec and grp and elem:
                fk_map[f"{grp}.{elem}"] = meta
                short_grp = grp.split('.')[-1]
                fk_map[f"{short_grp}.{elem}"] = meta
                clean_grp = grp.replace('OUT_', '')
                fk_map[f"{clean_grp}.{elem}"] = meta
                clean_short = short_grp.replace('OUT_', '')
                fk_map[f"{clean_short}.{elem}"] = meta
    if not fk_map:
        return doc_dict

    for sheet_name, sheet_val in list(doc_dict.items()):
        if sheet_name not in ('editor_metadata', '_hierarchy_schema'):
            _process_fk_item(fk_map, doc_dict, sheet_name, sheet_val)
    return doc_dict
