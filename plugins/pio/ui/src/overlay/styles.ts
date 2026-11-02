// The Pio window's look: the host's theme variables, its own class names (pio-*), so it needs nothing from the
// host's stylesheet. The window itself is see-through: only the face and its card draw anything.

export const CSS = `
.pio-root{position:fixed;inset:0;display:flex;font-family:var(--font-sans,-apple-system,system-ui,sans-serif);color:var(--fg,#1d1a17);user-select:none;-webkit-user-select:none}
.pio-root[data-x=right]{justify-content:flex-end}
.pio-root[data-y=bottom]{align-items:flex-end}
.pio-root *{box-sizing:border-box}
.pio-stack{display:flex;gap:10px;align-items:flex-end;padding:11px;width:100%;max-width:100%}
.pio-root[data-x=right] .pio-stack{flex-direction:row-reverse}
.pio-root[data-y=top] .pio-stack{align-items:flex-start}
.pio-face{position:relative;flex:none;width:50px;height:50px;border-radius:50%;cursor:grab;
  background:radial-gradient(circle at 35% 28%,#ffe2a8 0,#ffb547 38%,#e8891a 72%,#c96d0e 100%);
  box-shadow:0 3px 8px rgba(80,40,0,.26),inset 0 -4px 9px rgba(120,50,0,.25);transition:transform .25s ease}
.pio-face:hover{transform:scale(1.06)}
.pio-face::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2.5px solid transparent;transition:border-color .3s,opacity .3s}
.pio-face[data-state=watching]::after{border-color:rgba(20,160,150,.55)}
.pio-face[data-state=listening]::after{border-color:rgba(20,160,150,.75);border-style:dashed}
.pio-face[data-state=hearing]::after{border-color:#14a096;animation:pio-pulse 1s ease-in-out infinite}
.pio-face[data-state=thinking]::after{border-color:#e8891a transparent #e8891a transparent;animation:pio-spin 1.1s linear infinite}
.pio-face[data-state=speaking]::after{border-color:#ffb547;animation:pio-pulse .7s ease-in-out infinite}
.pio-face[data-state=driving]::after{border-color:#e5484d;border-width:3px;animation:pio-pulse 1.4s ease-in-out infinite}
.pio-eye{position:absolute;top:18px;width:8px;height:11px;border-radius:50%;background:#fff;animation:pio-blink 5.5s infinite}
.pio-eye::after{content:"";position:absolute;left:2px;top:3px;width:4.5px;height:5.5px;border-radius:50%;background:#2b1a08}
.pio-eye.l{left:14px}.pio-eye.r{right:14px}
.pio-face[data-state=thinking] .pio-eye::after{top:1.5px}
.pio-face[data-state=driving] .pio-eye{height:8px;top:20px}
@keyframes pio-blink{0%,94%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}
@keyframes pio-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(1.07)}}
@keyframes pio-spin{to{transform:rotate(360deg)}}
.pio-card{flex:1;min-width:0;background:var(--surface,#fff);border-radius:18px;box-shadow:0 2px 8px rgba(0,0,0,.14),0 0 0 1px rgba(0,0,0,.07);
  padding:14px;display:flex;flex-direction:column;gap:10px;max-height:calc(100vh - 22px);overflow:hidden;animation:pio-in .18s ease-out}
@keyframes pio-in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
.pio-line{flex:1;min-width:0;background:var(--surface,#fff);border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,.14),0 0 0 1px rgba(0,0,0,.07);
  padding:11px 14px;font-size:13.5px;line-height:1.4;max-height:calc(100vh - 22px);overflow:hidden;overflow-wrap:anywhere;animation:pio-in .18s ease-out;cursor:pointer}
.pio-head{display:flex;align-items:center;gap:8px}
.pio-name{font-weight:650;font-size:14px}
.pio-state{font-size:12px;color:var(--muted,#8a817a);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pio-x{border:0;background:transparent;color:var(--muted,#8a817a);font-size:12px;padding:4px 6px;border-radius:8px;cursor:pointer}
.pio-x:hover{background:rgba(127,127,127,.12);color:var(--fg,#1d1a17)}
.pio-switch{display:flex;align-items:center;gap:10px;padding:7px 4px;border-radius:12px;cursor:pointer}
.pio-switch:hover{background:rgba(127,127,127,.08)}
.pio-switch b{display:block;font-size:13.5px;font-weight:560}
.pio-switch small{display:block;font-size:11.5px;color:var(--muted,#8a817a);margin-top:1px}
.pio-switch span{flex:1;min-width:0}
.pio-toggle{flex:none;width:34px;height:20px;border-radius:10px;background:rgba(127,127,127,.3);position:relative;transition:background .2s}
.pio-toggle::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .2s}
.pio-toggle[data-on=true]{background:#14a096}
.pio-toggle[data-on=true]::after{transform:translateX(14px)}
.pio-toggle.red[data-on=true]{background:#e5484d}
.pio-note{font-size:12px;line-height:1.35;color:var(--muted,#8a817a);background:rgba(127,127,127,.08);border-radius:10px;padding:7px 9px;display:flex;gap:8px;align-items:center}
.pio-note span{flex:1}
.pio-note button,.pio-send{border:0;border-radius:9px;background:var(--accent,#e8891a);color:#fff;font-size:12px;font-weight:600;padding:5px 9px;cursor:pointer}
.pio-lines{flex:1;min-height:40px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:1.38;user-select:text;-webkit-user-select:text}
.pio-msg{max-width:88%;padding:6px 10px;border-radius:14px;background:rgba(127,127,127,.1);white-space:pre-wrap;overflow-wrap:anywhere}
.pio-msg.me{align-self:flex-end;background:rgba(232,137,26,.16)}
.pio-hearing{align-self:flex-end;font-size:12px;color:var(--muted,#8a817a);font-style:italic}
.pio-form{display:flex;gap:6px;align-items:center}
.pio-input{flex:1;min-width:0;border:1px solid rgba(127,127,127,.25);background:transparent;color:inherit;border-radius:12px;padding:8px 10px;font-size:13.5px;outline:none}
.pio-input:focus{border-color:var(--accent,#e8891a)}
`;
