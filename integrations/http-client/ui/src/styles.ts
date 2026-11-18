// The HTTP page's styles, on the page's own colors (CSS variables), so it fits light and dark.

const CSS = `
.hc-page{position:relative;display:flex;height:100%;min-height:0;color:var(--fg);font-size:13px;line-height:1.4;container-type:inline-size}
.hc-grow{flex:1;min-width:0}
.hc-row{display:flex;align-items:center;gap:8px;min-width:0}
.hc-wrap{flex-wrap:wrap}
.hc-muted{color:var(--muted);font-size:12px}
.hc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.hc-input{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 9px;color:var(--fg);font:inherit;width:100%;box-sizing:border-box;min-width:0}
select.hc-input{width:auto;max-width:100%}
.hc-input:focus{outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:-1px}
.hc-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;flex:none}
.hc-icon:hover:not(:disabled){background:var(--surface-2);color:var(--fg)}
.hc-text-button{display:inline-flex;align-items:center;gap:5px;border:0;background:none;padding:4px 6px;border-radius:6px;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.hc-text-button:hover:not(:disabled){background:var(--surface-2);color:var(--fg)}
.hc-text-button:disabled{opacity:.4;cursor:default}
.hc-method{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:700;letter-spacing:.02em;flex:none;min-width:46px}
.hc-nav{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:12px;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:500;text-align:left;cursor:pointer}
.hc-nav:hover{background:color-mix(in srgb,var(--surface) 55%,transparent);color:var(--fg)}

.hc-side{flex:0 0 320px;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--hairline)}
.hc-side-head{display:flex;align-items:center;gap:6px;padding:12px 12px 8px}
.hc-tabs{display:flex;gap:2px;padding:0 12px}
.hc-tab{border:0;background:none;padding:6px 10px;border-radius:8px;color:var(--muted);font:inherit;font-size:12px;font-weight:500;cursor:pointer}
.hc-tab:hover{color:var(--fg)}
.hc-tab.is-on{background:var(--surface-2);color:var(--fg)}
.hc-chips{display:flex;gap:4px;padding:8px 12px 0;flex-wrap:wrap}
.hc-chip{border:1px solid var(--border);background:var(--surface);border-radius:999px;padding:1px 9px;color:var(--muted);font:inherit;font-size:11px;cursor:pointer}
.hc-chip.is-on{background:var(--accent-soft);border-color:transparent;color:var(--accent-text)}
.hc-list{flex:1;min-height:0;overflow:hidden auto;padding:8px;display:flex;flex-direction:column;gap:1px}
.hc-item{display:flex;flex-direction:column;gap:2px;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0;position:relative}
.hc-item:hover{background:var(--surface-2)}
.hc-item.is-on{background:var(--accent-soft)}
.hc-item-top{display:flex;align-items:center;gap:6px;min-width:0}
.hc-item-url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hc-item-meta{display:flex;gap:8px;color:var(--muted);font-size:11px;padding-left:52px;font-variant-numeric:tabular-nums}
.hc-item-x{position:absolute;right:4px;top:4px;display:none;width:22px;height:22px;background:var(--surface)}
.hc-item:hover .hc-item-x,.hc-item:focus-within .hc-item-x{display:inline-flex}
.hc-folder{padding:10px 8px 2px;color:var(--muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.hc-status{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:600;flex:none}
.hc-tone-success{color:var(--success)}
.hc-tone-info{color:var(--info)}
.hc-tone-warning{color:var(--warning)}
.hc-tone-danger{color:var(--danger)}
.hc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex:1;min-height:160px;padding:24px;text-align:center}
.hc-empty b{font-weight:600}

.hc-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.hc-bar{display:flex;align-items:center;gap:8px;padding:12px 16px 8px}
.hc-bar .hc-url{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.hc-bar select{font-weight:600}
.hc-sub{display:flex;align-items:center;gap:4px;padding:0 16px;flex-wrap:wrap}
.hc-count{color:var(--muted);font-weight:400;margin-left:4px;font-variant-numeric:tabular-nums}
.hc-editor{padding:8px 16px 12px;display:flex;flex-direction:column;gap:6px;max-height:42%;overflow:hidden auto;flex:none}
.hc-pair{display:grid;grid-template-columns:18px minmax(0,1fr) minmax(0,2fr) 28px;gap:6px;align-items:center}
.hc-pair input[type=checkbox]{margin:0;accent-color:var(--accent)}
.hc-pair.is-off .hc-input{opacity:.5}
.hc-pair.is-plain{grid-template-columns:minmax(0,1fr) minmax(0,2fr) 28px}
.hc-editor select.hc-input{align-self:flex-start}
.hc-body{min-height:120px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5}
.hc-form{display:flex;align-items:center;gap:8px;padding:8px 16px;flex-wrap:wrap;background:var(--surface-2)}
.hc-form .hc-input{width:auto;flex:1 1 140px}

.hc-response{flex:1;min-height:0;display:flex;flex-direction:column;border-top:1px solid var(--hairline)}
.hc-response-head{display:flex;align-items:center;gap:10px;padding:10px 16px 6px;flex-wrap:wrap}
.hc-big-status{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;font-weight:700}
.hc-note{margin:0 16px 6px;padding:6px 10px;border-radius:8px;background:var(--surface-2);color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.hc-note-danger{background:var(--danger-soft);color:var(--danger)}
.hc-pre{flex:1;min-height:0;margin:0;padding:8px 16px 16px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.hc-headers{flex:1;min-height:0;overflow:auto;padding:8px 16px 16px;display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:4px 14px;align-content:start;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.hc-headers dt{color:var(--muted)}
.hc-headers dd{margin:0;overflow-wrap:anywhere}

.hc-overlay{position:absolute;inset:0;z-index:40;background:rgb(0 0 0 / .18);display:flex;justify-content:flex-end}
.hc-sheet{width:min(480px,100%);height:100%;background:var(--bg);box-shadow:var(--shadow-sheet);display:flex;flex-direction:column;min-height:0}
.hc-sheet-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--hairline);font-weight:600}
.hc-sheet-body{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px}

.hc-widget{display:flex;flex-direction:column;gap:6px;padding:12px 14px;font-size:13px;color:var(--fg);min-width:0}
.hc-widget-top{display:flex;align-items:center;gap:8px;min-width:0}
.hc-widget-url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.hc-widget-pre{margin:0;padding:8px 10px;border-radius:8px;background:var(--surface-2);max-height:260px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}

.hc-back{display:none}
/* The page's own width decides, not the window's: the app's sidebar and panels take their share first. */
@container (max-width:1040px){.hc-label{display:none}}
@container (max-width:720px){
  .hc-side{flex:1 1 auto;border-right:0}
  .hc-main{display:none}
  .hc-page.is-detail .hc-side{display:none}
  .hc-page.is-detail .hc-main{display:flex}
  .hc-back{display:inline-flex}
  .hc-bar{flex-wrap:wrap}
  .hc-bar .hc-url{flex:1 1 100%;order:3}
  .hc-pair{grid-template-columns:18px minmax(0,1fr) minmax(0,1fr) 28px}
  .hc-pair.is-plain{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 28px}
}
`;

let added = false;

export function addStyles(): void {
  if (added || typeof document === "undefined") return;
  added = true;
  const el = document.createElement("style");
  el.dataset.piomio = "http-client";
  el.textContent = CSS;
  document.head.appendChild(el);
}
