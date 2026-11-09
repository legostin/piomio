// The browser's stylesheet, added to the page once: classes (hover, focus, sticky headers, touch tweaks) on the host's
// theme variables, so light and dark follow the app. Everything is prefixed obb-.

const CSS = `
.obb{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--fg)}
.obb-frame{display:flex;flex-direction:column;flex:1;min-height:0;border:1px solid var(--border);border-radius:14px;overflow:hidden;background:var(--surface)}
.obb-ib{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;border:0;border-radius:9px;background:transparent;color:var(--fg);cursor:pointer;transition:background .12s}
.obb-ib:hover{background:var(--surface-2)}
.obb-ib:disabled{opacity:.35;cursor:default;background:transparent}
.obb-ib[aria-pressed=true]{background:var(--surface-3)}
.obb-ib svg{width:18px;height:18px}
.obb-btn{display:inline-flex;align-items:center;gap:6px;flex:none;height:32px;padding:0 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--fg);font:inherit;font-weight:500;white-space:nowrap;cursor:pointer;transition:background .12s}
.obb-btn:hover{background:var(--surface-2)}
.obb-btn svg{width:16px;height:16px}
.obb-btn.is-on{background:var(--warning-soft);border-color:transparent;color:var(--warning)}
.obb-btn.is-accent{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.obb-icon{width:16px;height:16px;flex:none;border-radius:3px;object-fit:contain}
.obb-glyph{width:16px;height:16px;flex:none;color:var(--muted)}
.obb-spin{animation:obb-spin .8s linear infinite}
@keyframes obb-spin{to{transform:rotate(360deg)}}
.obb-trunc{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.obb-muted{color:var(--muted)}

.obb-tabs{display:flex;align-items:flex-end;gap:2px;padding:6px 6px 0;background:var(--surface-2);overflow-x:auto;scrollbar-width:none}
.obb-tabs::-webkit-scrollbar{display:none}
.obb-tab{display:flex;align-items:center;gap:7px;flex:0 1 210px;min-width:76px;height:34px;padding:0 4px 0 11px;border-radius:10px 10px 0 0;color:var(--muted);cursor:default;user-select:none;-webkit-user-select:none;transition:background .12s,color .12s}
.obb-tab:hover{background:color-mix(in srgb,var(--surface) 55%,transparent);color:var(--fg)}
.obb-tab[aria-selected=true]{background:var(--surface);color:var(--fg)}
.obb-tab .obb-ib{width:22px;height:22px;border-radius:6px;opacity:0}
.obb-tab .obb-ib svg{width:14px;height:14px}
.obb-tab:hover .obb-ib,.obb-tab[aria-selected=true] .obb-ib{opacity:1}
.obb-tab-title{flex:1}
.obb-newtab{margin:0 0 3px 2px}

.obb-toolbar{display:flex;align-items:center;gap:2px;padding:6px 8px;border-bottom:1px solid var(--border)}
.obb-toolbar .obb-btn{margin-left:4px}
.obb-omni{position:relative;flex:1;min-width:0;margin:0 4px}
.obb-omni-field{display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;border:1px solid transparent;border-radius:17px;background:var(--surface-2);cursor:text}
.obb-omni-field:focus-within{background:var(--surface);border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.obb-omni-field input{flex:1;min-width:0;height:100%;padding:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:14px}
.obb-omni-field input::placeholder,.obb-search input::placeholder{color:var(--muted);opacity:1}
.obb-omni-show{flex:1;min-width:0;font-size:14px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.obb-omni-show b{font-weight:500;color:var(--fg)}
.obb-omni-show span{color:var(--muted)}
.obb-sugg{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:20;padding:6px;border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:var(--shadow)}
.obb-sugg-row{display:flex;align-items:center;gap:10px;min-height:34px;padding:6px 10px;border-radius:9px;cursor:pointer}
.obb-sugg-row[aria-selected=true]{background:var(--surface-2)}
.obb-sugg-main{flex:0 1 auto;max-width:65%}
.obb-sugg-sub{flex:1 1 0;color:var(--muted)}

.obb-body{position:relative;display:flex;flex:1;min-height:0}
.obb-area{position:relative;display:flex;flex:1;min-width:0;min-height:0;align-items:center;justify-content:center;overflow:hidden;background:var(--surface-2)}
.obb-screen{position:relative;overflow:hidden;outline:none;background:var(--surface-2)}
.obb-layer{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:0 0}
.obb-layer img{display:block;width:100%;height:100%;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.obb-kbfield{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px;pointer-events:none}
.obb-center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:12px;text-align:center}
.obb-zoomchip{position:absolute;right:10px;bottom:10px;z-index:4;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:1px solid var(--border);border-radius:15px;background:var(--surface);color:var(--fg);font:inherit;font-size:12px;font-weight:600;box-shadow:var(--shadow);cursor:pointer}
.obb-zoomchip svg{width:14px;height:14px}
.obb-foot{display:flex;align-items:center;gap:8px;min-height:36px;padding:5px 10px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}
.obb-error{padding:6px 12px;color:var(--danger);font-size:12px;border-bottom:1px solid var(--border)}

.obb-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;min-width:230px;padding:4px;border:1px solid var(--border);border-radius:12px;background:var(--surface);box-shadow:var(--shadow)}
.obb-menu button{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.obb-menu button:hover{background:var(--surface-2)}
.obb-menu svg{width:16px;height:16px;color:var(--muted)}

.obb-side{display:flex;flex-direction:column;flex:none;width:340px;min-height:0;border-left:1px solid var(--border);background:var(--surface)}
.obb-sheet{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;min-height:0;background:var(--surface)}
.obb-head{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 14px;font-weight:600;font-size:14px}
.obb-head-title{flex:1}
.obb-search{display:flex;align-items:center;gap:8px;height:36px;margin:0 10px 6px;padding:0 10px;border-radius:10px;background:var(--surface-2)}
.obb-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:14px}
.obb-list{flex:1;min-height:0;overflow-y:auto;padding:0 6px 10px;overscroll-behavior:contain}
.obb-day{position:sticky;top:0;z-index:1;padding:10px 8px 4px;background:var(--surface);color:var(--muted);font-size:12px;font-weight:600}
.obb-visit{display:flex;align-items:center;gap:10px;padding:6px 4px 6px 8px;border-radius:9px;cursor:pointer}
.obb-visit:hover{background:var(--surface-2)}
.obb-visit-time{flex:none;width:38px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.obb-visit-text{flex:1;min-width:0}
.obb-visit-sub{color:var(--muted);font-size:12px}
.obb-visit .obb-ib{width:26px;height:26px;opacity:0}
.obb-visit .obb-ib svg{width:14px;height:14px}
.obb-visit:hover .obb-ib{opacity:1}
.obb-empty{padding:28px 16px;color:var(--muted);text-align:center}
.obb-list-foot{display:flex;justify-content:center;padding:8px}
.obb-panel-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--border)}
.obb-danger{color:var(--danger)}
.obb-link{padding:6px 4px;border:0;background:transparent;color:var(--muted);font:inherit;cursor:pointer}
.obb-link:hover{color:var(--fg)}
.obb-link.obb-danger:hover{color:var(--danger)}

.obb-ntp{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;gap:28px;padding:11vh 16px 24px;overflow-y:auto;background:var(--surface)}
.obb-ntp .obb-omni{flex:none;width:min(560px,100%);margin:0}
.obb-ntp .obb-omni-field{height:46px;padding:0 16px;border-radius:23px;border-color:var(--border);background:var(--surface)}
.obb-ntp .obb-omni-field:focus-within{border-color:var(--accent)}
.obb-ntp-mark{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:18px;background:var(--accent-soft);color:var(--accent-text)}
.obb-ntp-mark svg{width:28px;height:28px}
.obb-ntp-machine{font-size:13px;text-align:center;max-width:min(560px,100%)}
.obb-machine{display:inline-flex;align-items:center;gap:5px;flex:none;max-width:140px;height:26px;padding:0 9px;border-radius:999px;background:var(--surface-2);color:var(--muted);font-size:12px;cursor:default}
.obb-machine svg{width:13px;height:13px;flex:none}
.obb-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;width:min(560px,100%)}
.obb-tile{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:0;padding:14px 6px 10px;border:0;border-radius:14px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.obb-tile:hover{background:var(--surface-2)}
.obb-tile-icon{display:flex;align-items:center;justify-content:center;width:46px;height:46px;border-radius:50%;background:var(--surface-2)}
.obb-tile-icon .obb-icon,.obb-tile-icon .obb-glyph{width:22px;height:22px}
.obb-tile-name{width:100%;font-size:12px}

.obb-phone{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;border-radius:14px;background:var(--surface)}
.obb-omni-top{display:flex;align-items:center;gap:8px}
.obb-omni.is-phone{flex:none;margin:2px 4px 8px}
.is-phone .obb-omni-field{height:42px;padding:0 4px 0 12px;border-radius:21px}
.obb-omni.obb-sheet{margin:0}
.obb-sheet .obb-omni-top{padding:8px 10px}
.obb-sheet .obb-omni-field{justify-content:flex-start}
.obb-phone .obb-area{border-radius:10px}
.obb-pstatus{display:flex;align-items:center;gap:6px;min-height:26px;padding:4px 10px 0;color:var(--muted);font-size:12px}
.obb-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--success);animation:obb-blink 1.4s ease-in-out infinite}
.obb-dot.is-user{background:var(--warning)}
@keyframes obb-blink{50%{opacity:.35}}
.obb-sheet .obb-sugg{flex:1;min-height:0;overflow-y:auto}
.obb-bar{display:flex;align-items:center;justify-content:space-around;padding:4px 0 2px}
.obb-bar .obb-ib{width:46px;height:44px;border-radius:12px}
.obb-bar .obb-ib svg{width:22px;height:22px}
.obb-bar .obb-ib.is-on{color:var(--warning);background:var(--warning-soft)}
.obb-bar .obb-ib.is-hint{animation:obb-pulse 1.1s ease-in-out infinite}
@keyframes obb-pulse{50%{background:var(--accent-soft);color:var(--accent-text)}}
.obb-count{display:inline-flex;align-items:center;justify-content:center;min-width:21px;height:21px;padding:0 4px;border:2px solid currentColor;border-radius:6px;font-size:11px;font-weight:700}
.obb-sheet .obb-sugg{position:static;padding:0 4px;border:0;border-radius:0;box-shadow:none}
.obb-sheet .obb-sugg-row{min-height:46px}
.obb-cards{display:flex;flex:1;flex-direction:column;gap:8px;min-height:0;padding:4px 12px 12px;overflow-y:auto}
.obb-card{display:flex;align-items:center;gap:12px;padding:10px 6px 10px 12px;border:1px solid var(--border);border-radius:14px;cursor:pointer}
.obb-card[aria-selected=true]{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.obb-card .obb-icon,.obb-card .obb-glyph{width:20px;height:20px}
.obb-sheet-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-top:1px solid var(--border)}

.obb-menu.is-up{top:auto;bottom:calc(100% + 6px)}

.obb-teach{display:flex;align-items:center;gap:6px;min-height:42px;padding:5px 8px 5px 12px;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--accent-soft) 55%,var(--surface))}
.obb-teach.is-phone{margin:0 4px 8px;padding:4px 4px 4px 12px;border:0;border-radius:14px}
.obb-teach.is-phone .obb-ib{width:38px;height:38px}
.obb-files{display:flex;align-items:center;gap:8px;min-height:42px;padding:5px 8px 5px 12px;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--warning) 14%,var(--surface))}
.obb-files.is-phone{margin:0 4px 8px;border:0;border-radius:14px}
.obb-files-icon{flex:none;width:16px;height:16px;color:var(--warning)}
.obb-files-text{flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.obb-rec{flex:none;width:9px;height:9px;border-radius:50%;background:var(--danger);animation:obb-rec 1.6s ease-out infinite}
@keyframes obb-rec{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--danger) 55%,transparent)}70%,100%{box-shadow:0 0 0 6px transparent}}
.obb-teach-text{display:flex;align-items:baseline;gap:8px;flex:1;min-width:0;margin-left:4px}
.obb-teach-goal{flex:0 1 auto;font-weight:600}
.obb-teach-sub{flex:1 1 0;color:var(--muted);font-size:12px}
.obb-teach.is-phone .obb-teach-text{flex-direction:column;align-items:stretch;gap:1px;line-height:1.25}
.obb-teach.is-phone .obb-teach-sub{flex:none;font-size:11.5px}
.obb-mic{transition:background .12s,box-shadow .09s linear}
.obb-mic.is-off{color:var(--muted)}
.obb-mic.is-starting{animation:obb-blink 1.4s ease-in-out infinite}
.obb-mic.is-on,.obb-mic.is-on:hover{background:var(--accent-soft);color:var(--accent-text);box-shadow:inset 0 0 0 1.5px var(--accent),0 0 0 calc(var(--lvl,0) * 6px) color-mix(in srgb,var(--accent) 40%,transparent)}
.obb-ib.obb-hl-btn[aria-pressed=true]{background:var(--accent-soft);color:var(--accent-text);box-shadow:inset 0 0 0 1.5px var(--accent)}

.obb-hl{position:absolute;inset:0;z-index:6;pointer-events:none}
.obb-hl.is-on{pointer-events:auto;cursor:crosshair;touch-action:none;background:color-mix(in srgb,var(--fg) 6%,transparent)}
.obb-hl-hint{position:absolute;left:50%;top:10px;max-width:calc(100% - 24px);padding:6px 12px;border-radius:15px;background:var(--surface);color:var(--fg);font-size:12px;font-weight:500;box-shadow:var(--shadow);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transform:translateX(-50%);pointer-events:none}
.obb-hl-frame{position:absolute;box-sizing:border-box;border:2px solid var(--accent);border-radius:4px;background:color-mix(in srgb,var(--accent) 16%,transparent);pointer-events:none}
.obb-hl-frame.is-sent{opacity:.85}
.obb-hl-frame.is-ok{animation:obb-flash .7s ease-out forwards}
@keyframes obb-flash{0%{background:color-mix(in srgb,var(--accent) 50%,transparent);box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 60%,transparent)}45%{box-shadow:0 0 0 8px transparent}100%{opacity:0;box-shadow:0 0 0 8px transparent}}

@media (hover:none){.obb-tab .obb-ib,.obb-visit .obb-ib{opacity:.7}}
`;

let added = false;

export function addStyles(): void {
  if (added || typeof document === "undefined") return;
  added = true;
  const el = document.createElement("style");
  el.dataset.piomio = "browser";
  el.textContent = CSS;
  document.head.appendChild(el);
}
