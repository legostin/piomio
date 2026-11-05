// The board's styles, on the page's own colors (CSS variables), so it fits light and dark.

const CSS = `
.kb-page{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--fg);font-size:13px;line-height:1.4}
.kb-center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;flex:1;min-height:240px;padding:24px;text-align:center}
.kb-grow{flex:1;min-width:0}
.kb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kb-stack{display:flex;flex-direction:column;gap:8px}
.kb-muted{color:var(--muted);font-size:12px}
.kb-danger{color:var(--danger)}
.kb-key{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.kb-input{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 9px;color:var(--fg);font:inherit;width:100%;box-sizing:border-box;min-width:0}
select.kb-input{width:auto;max-width:100%}
.kb-input:focus{outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:-1px}
.kb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.kb-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;flex:none}
.kb-icon:hover:not(:disabled){background:var(--surface-2);color:var(--fg)}
.kb-icon:disabled{opacity:.35;cursor:default}
.kb-text-button{border:0;background:none;padding:0;color:var(--accent-text);font:inherit;font-size:12px;cursor:pointer}
.kb-text-button:hover{text-decoration:underline}
.kb-text-button.kb-muted{color:var(--muted)}
.kb-link{display:inline-flex;align-items:center;gap:4px;color:var(--accent-text);font-size:12px;text-decoration:none}

.kb-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;flex-wrap:wrap}
.kb-project{font-weight:600;background:transparent;border-color:transparent;padding-left:4px;font-size:15px;max-width:260px}
.kb-project:hover{background:var(--surface-2)}
.kb-search{width:180px;flex:0 1 180px}
.kb-pill{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--muted);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.kb-pill:hover{color:var(--fg)}
.kb-pill.is-on{background:var(--accent-soft);border-color:transparent;color:var(--accent-text)}

.kb-columns{flex:1;min-height:0;display:flex;gap:10px;padding:0 16px 16px;overflow:auto hidden;align-items:stretch}
.kb-column{flex:0 0 272px;display:flex;flex-direction:column;min-height:0;background:var(--surface-2);border-radius:12px;padding:8px;box-sizing:border-box;transition:background .12s}
.kb-column.is-over{background:color-mix(in srgb,var(--accent) 12%,var(--surface-2))}
.kb-column-head{display:flex;align-items:center;gap:7px;margin:2px 4px 8px;font-size:12px;font-weight:600}
.kb-column-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.kb-count{color:var(--muted);font-weight:400;font-size:12px;font-variant-numeric:tabular-nums}
.kb-count.is-over{color:var(--danger);font-weight:600}
.kb-cards{flex:1;min-height:12px;overflow:hidden auto;display:flex;flex-direction:column;gap:6px;margin:0 -2px;padding:0 2px 2px}
.kb-add{display:flex;align-items:center;gap:6px;margin-top:6px;padding:6px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;text-align:left}
.kb-add:hover{background:var(--surface-3);color:var(--fg)}
.kb-add-input{margin-top:6px;resize:none}
.kb-drop{height:3px;border-radius:2px;background:var(--accent);margin:0 0 6px}

.kb-tile{background:var(--surface);border-radius:10px;padding:8px 10px;box-shadow:var(--shadow);cursor:grab;display:flex;flex-direction:column;gap:4px}
.kb-tile:hover{box-shadow:var(--shadow-pop)}
.kb-tile:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.kb-tile:active{cursor:grabbing}
.kb-tile-top{display:flex;align-items:center;gap:6px;min-height:20px}
.kb-tile-title{font-weight:500;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.kb-tile-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;color:var(--muted);font-size:11px}
.kb-tile-meta>span{display:inline-flex;align-items:center;gap:3px}
.kb-label{background:var(--surface-2);border-radius:5px;padding:0 5px;color:var(--fg)}
.kb-meta-warn{color:var(--warning)}
.kb-due-over{color:var(--danger);font-weight:600}
.kb-due-soon{color:var(--warning)}
.kb-run{border-radius:5px;padding:0 5px}
.kb-run-info{background:var(--info-soft);color:var(--info)}
.kb-run-warning{background:var(--warning-soft);color:var(--warning)}
.kb-run-danger{background:var(--danger-soft);color:var(--danger)}
.kb-run-neutral{background:var(--surface-2);color:var(--muted)}
.kb-run-success{background:var(--success-soft);color:var(--success)}
.kb-chip{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--surface-3);color:var(--fg);font-size:10px;font-weight:600;flex:none}
.kb-chip.is-busy{box-shadow:0 0 0 2px var(--accent);animation:kb-pulse 1.6s ease-in-out infinite}
@keyframes kb-pulse{50%{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 25%,transparent)}}
@media (prefers-reduced-motion:reduce){.kb-chip.is-busy{animation:none}}
.kb-urgent{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;background:var(--danger);color:#fff;font-size:10px;font-weight:700;flex:none}
.kb-bars{display:inline-flex;align-items:flex-end;gap:1px;height:12px;color:var(--muted);flex:none}
.kb-bars i{display:block;width:3px;border-radius:1px;background:currentColor}

.kb-nav{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:12px;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:500;text-align:left;cursor:pointer}
.kb-nav:hover{background:color-mix(in srgb,var(--surface) 55%,transparent);color:var(--fg)}

.kb-overlay{position:absolute;inset:0;z-index:40;background:rgb(0 0 0 / .18);display:flex;justify-content:flex-end}
.kb-sheet{width:min(460px,100%);height:100%;background:var(--bg);box-shadow:var(--shadow-sheet);display:flex;flex-direction:column;min-height:0}
.kb-sheet-card{width:min(560px,100%)}
.kb-sheet-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--hairline)}
.kb-sheet-body{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:14px}
.kb-title-input{border:0;background:transparent;color:var(--fg);font:inherit;font-size:18px;font-weight:600;width:100%;padding:2px 4px;margin:-2px -4px;border-radius:6px;box-sizing:border-box}
.kb-title-input:focus{outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);background:var(--surface)}
.kb-note{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:var(--surface-2);flex-wrap:wrap}
.kb-note-warn{background:var(--warning-soft)}
.kb-note-danger{background:var(--danger-soft);color:var(--danger)}
.kb-fields{display:grid;grid-template-columns:110px 1fr;gap:6px 10px;align-items:center;margin:0}
.kb-fields dt{color:var(--muted);font-size:12px}
.kb-fields dd{margin:0;min-width:0}
.kb-blocker{gap:4px}
.kb-closed{text-decoration:line-through;color:var(--muted)}
.kb-section{display:flex;align-items:center;gap:10px;margin:0 0 6px;font-size:12px;font-weight:600}
.kb-markdown{overflow-wrap:anywhere}
.kb-markdown>*:first-child{margin-top:0}
.kb-markdown>*:last-child{margin-bottom:0}
.kb-file{gap:6px}
.kb-file-name{max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.kb-comment{padding:8px 0;border-top:1px solid var(--hairline)}
.kb-runline{padding:6px 0;border-top:1px solid var(--hairline)}
.kb-runline summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;flex-wrap:wrap}
.kb-runline summary::-webkit-details-marker{display:none}
.kb-runline .kb-markdown{margin-top:8px}
.kb-history summary{cursor:pointer;color:var(--muted);font-size:12px}
.kb-history .kb-row{margin-top:4px;flex-wrap:nowrap;align-items:baseline}
.kb-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.kb-switch{display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer}
.kb-rule{display:flex;flex-direction:column;gap:4px;padding:10px;border-radius:10px;background:var(--surface)}
.kb-column-row{flex-wrap:nowrap;gap:4px}
.kb-limit{width:64px;flex:none}
.kb-danger-zone{border-top:1px solid var(--hairline);padding-top:12px;gap:14px}

.kb-widget{display:flex;flex-direction:column;gap:6px;padding:12px 14px;font-size:13px;color:var(--fg);min-width:0}
.kb-widget .kb-row>.kb-muted{display:inline-flex;align-items:center;gap:3px}
.kb-widget-title{display:flex;align-items:center;gap:6px;border:0;background:none;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}
.kb-widget-title:hover .kb-widget-name{text-decoration:underline}
.kb-widget-name{font-weight:600;overflow-wrap:anywhere}
.kb-mini{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px}
.kb-mini-column{flex:0 0 132px;display:flex;flex-direction:column;gap:4px;min-width:0}
.kb-mini-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.kb-mini-column .kb-row{flex-wrap:nowrap;gap:5px}
.kb-mini-card{border:0;background:var(--surface);border-radius:6px;padding:3px 6px;color:var(--fg);font:inherit;font-size:11px;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

@media (max-width:640px){
  .kb-columns{scroll-snap-type:x proximity}
  .kb-column{flex-basis:86%;scroll-snap-align:center}
  .kb-search{flex:1 1 100%;width:100%;order:3}
  .kb-column-row{flex-wrap:wrap}
}
`;

let added = false;

export function addStyles(): void {
  if (added || typeof document === "undefined") return;
  added = true;
  const el = document.createElement("style");
  el.dataset.piomio = "kanban";
  el.textContent = CSS;
  document.head.appendChild(el);
}
