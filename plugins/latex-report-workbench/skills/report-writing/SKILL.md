---
name: report-writing
description: Use when reading or editing reports managed by the LaTeX report workbench, including its chapter selections and PDF text edit sessions.
---

# LaTeX report workbench

Use the current Codex chat for writing. The plugin connects to a configured workspace; its cache directory is not the report directory. Start with `workspace_status` and `report_list`, then use the returned `reportId`. `workbench_open` requests the panel; `report_open` returns metadata only.

Check `workspace_status.features`: `implemented`, `defined`, and `unverified` have different meanings. Local write, compile, outline, selection and PDF tools are implemented. The actual native desktop bridge and image attachment channel remain unverified. Do not report a placeholder as success or replace an unavailable selection with a guessed paragraph.

`report_tree` supports `kind: files` and `kind: outline`. `report_read` uses report-relative paths and returns normalized LF text plus the hash of original bytes, BOM and EOL information. Text ranges are zero-based, left-closed/right-open UTF-16 offsets in the normalized text, not byte positions.

Read `report_context_get` before selection-scoped changes. In copy-credential mode, use the user's explicit contextId/selectionId; never choose a context from another chat. Preserve `contextId`, `selectionId`, file version hashes, and operation IDs through the transaction. For an explicitly requested whole-report edit, use `scope: report` with `scopeReason` derived from that request. A stale or ambiguous selection needs refreshed evidence rather than guessing. On a version conflict, re-read before proposing a new patch.

PDF direct editing persists through `pdf_edit_open` and `pdf_edit_commit`, reversible source projection, and successful recompilation. The server owns source ranges; the view submits edited run IDs and text with immutable build and file versions. Formulas and citation commands remain protected. Unsupported macros or ambiguous mappings need the source editing path. A changed browser text layer is not a saved report. Read build status to distinguish source saved from PDF successfully rebuilt; export a specific successful build when its exact revision matters.

Selecting an object updates context only when the host bridge is verified; it does not send a user message or begin an edit. If a required tool is unavailable, explain the missing capability and ask for the text or explicit source location needed to continue that modification.
