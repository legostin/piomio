import { afterEach, describe, expect, it, vi } from "vitest";
import { startPlugin } from "@piomio/testkit";
import { readPluginLayout, catalogProblems } from "@piomio/shared";
import plugin from "../server/index.ts";
import { resolve } from "node:path";

// Exercise the actual activation, settings access, vault lookup, HTTP validation and cancellation.
function service(settings?: Record<string,unknown>, secret = "test-key") {
  let handler: any; const tools = new Map<string,any>();
  const ctx: any = { settings:settings ?? { ttsProvider:"xai",sttProvider:"xai" }, onSettingsChange:vi.fn(),events:{on:vi.fn()},ui:{emit:vi.fn()},http:{handle:(h:any)=>{handler=h;}},
    i18n:{locale:()=>"en",t:(k:string)=>k},vault:{get:vi.fn(async()=>({value:secret}))},tools:{register:(t:any)=>tools.set(t.name,t)},core:{call:vi.fn()} };
  plugin.activate(ctx);
  return { ctx, tools, call:(path:string,body:unknown,isPublic=false)=>handler({method:"POST",path,body,query:{},headers:{},public:isPublic,locale:"en"}) };
}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
const tick = async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
describe("voice integration",()=>{
  it("manifest and locale keys match and keys are vault inputs, not settings",()=>{
    const l=readPluginLayout(resolve("integrations/voice-providers")); expect(catalogProblems(l.messages)).toEqual([]);
    expect(l.manifest.permissions.network).toEqual(["api.x.ai","api.elevenlabs.io","api.openai.com"]);
    expect(l.manifest.contributes.setup?.secrets).toHaveLength(3);
    const fields=(l.manifest.contributes.settings as any).properties;
    for(const key of ["ttsProvider","sttProvider"]) {
      expect(fields[key].enum).toEqual(["local","xai","elevenlabs","openai"]);
      expect(fields[key].default).toBe("local");
    }
    expect(fields.fallback).toBeUndefined();
    expect(JSON.stringify(l.manifest.contributes.settings)).not.toMatch(/apiKey|keyRef/);
  });
  it("reports built-in defaults and built-in fallback without requiring any keys",async()=>{
    const s=service({},"");
    const status=JSON.parse(await s.tools.get("status").handler());
    expect(status).toMatchObject({tts:"local",stt:"local",fallback:"local"});
    expect(status.connected.every((p:any)=>p.connected===false)).toBe(true);
  });
  it("refuses public hooks and invalid input before reading a secret",async()=>{
    const s=service();
    expect((await s.call("/say",{id:"a",text:"x"},true)).status).toBe(403);
    for(const body of [{text:"x"},{id:"a",text:""},{id:"a",text:"x".repeat(1001)}]) expect((await s.call("/say",body)).status).toBe(400);
    expect((await s.call("/transcribe",{id:"a",data:"%%%"})).status).toBe(400); expect(s.ctx.vault.get).not.toHaveBeenCalled();
  });
  it("returns a recoverable missing-key error, never a vault message",async()=>{
    const s=service();s.ctx.vault.get.mockRejectedValue(new Error("sensitive secret text")); const send=vi.fn();vi.stubGlobal("fetch",send);
    expect(await s.call("/say",{id:"a",text:"Hi"})).toEqual({status:409,body:{code:"key",error:"error.key"}});expect(send).not.toHaveBeenCalled();
  });
  it("cancels only the named synthesis and keeps transcription alive",async()=>{
    const pending: any[]=[];
    vi.stubGlobal("fetch",vi.fn((_url,req)=>new Promise((resolve,reject)=>{pending.push({resolve,req});req.signal.addEventListener("abort",()=>reject(req.signal.reason));})));
    const s=service();const say=s.call("/say",{id:"say",text:"Hi"});const hear=s.call("/transcribe",{id:"hear",data:"AQID",name:"x.wav"});await tick();
    await s.call("/cancel",{id:"say"});expect((await say).status).toBe(499);expect(pending[1].req.signal.aborted).toBe(false);
    pending[1].resolve(Response.json({text:"new words"}));expect((await hear).body.text).toBe("new words");
  });
  it("times out stalled response headers, sanitizes failures and releases capacity",async()=>{
    vi.useFakeTimers();vi.stubGlobal("fetch",vi.fn((_url,req)=>new Promise((_resolve,reject)=>req.signal.addEventListener("abort",()=>reject(req.signal.reason)))));
    const s=service();const pending=s.call("/say",{id:"a",text:"Hi"});await tick();await vi.advanceTimersByTimeAsync(45_001);
    expect((await pending).body.code).toBe("timeout");vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("test-key")));
    expect((await s.call("/say",{id:"a",text:"Hi"})).body).toEqual({code:"unavailable",error:"error.unavailable"});
  });
  it("bounds a stalled vault lookup and response body by the same deadline", async()=>{
    vi.useFakeTimers();
    const s=service();s.ctx.vault.get.mockImplementationOnce(()=>new Promise(()=>{}));
    const vault=s.call("/say",{id:"vault",text:"Hi"}); await tick(); await vi.advanceTimersByTimeAsync(45_001);
    expect((await vault).body.code).toBe("timeout");
    vi.stubGlobal("fetch",vi.fn(async(_url,req)=>new Response(new ReadableStream({start(c){req.signal.addEventListener("abort",()=>c.error(req.signal.reason));}}),{headers:{"content-type":"audio/mpeg"}})));
    const body=s.call("/say",{id:"body",text:"Hi"}); await tick(); await vi.advanceTimersByTimeAsync(45_001);
    expect((await body).body.code).toBe("timeout");
  });
  it("limits concurrency and delivers an agent's audio only into its own session",async()=>{
    const s=service();
    vi.stubGlobal("fetch",vi.fn((_url,req)=>new Promise((_resolve,reject)=>req.signal.addEventListener("abort",()=>reject(req.signal.reason)))));
    const pending=Array.from({length:4},(_,i)=>s.call("/say",{id:`q${i}`,text:"Hi"})); await tick();
    expect((await s.call("/say",{id:"extra",text:"Hi"})).body.code).toBe("busy");
    for(let i=0;i<4;i++) await s.call("/cancel",{id:`q${i}`});
    expect((await Promise.all(pending)).every(r=>r.status===499)).toBe(true);
    s.ctx.core.call.mockResolvedValueOnce({data:"AQID",mimeType:"audio/wav",warning:"local fallback"}).mockResolvedValueOnce({path:"/session/speech.wav"});
    const r=await s.tools.get("say").handler({text:"Hello"},{sessionId:"own-session",machineId:"local"});
    expect(JSON.parse(r)).toEqual({path:"/session/speech.wav",aiGenerated:true,warning:"local fallback"});
    expect(s.ctx.core.call).toHaveBeenLastCalledWith("files.deliver",{sessionId:"own-session",name:"speech.wav",data:"AQID"});
  });
  it("runs in the real plugin process and exposes non-secret status and localized setup errors",async()=>{
    const h=await startPlugin({dir:"integrations/voice-providers",settings:{ttsProvider:"xai"},locale:"ru"});
    try {
      expect(h.tools.has("say")).toBe(true);expect(h.tools.has("status")).toBe(true);
      const status=await h.invokeText("status",{});expect(status).toContain('"connected":false');
      const r=await h.http({method:"POST",path:"/say",body:{id:"test",text:"Привет"}});
      expect(r.status).toBe(409);expect(JSON.stringify(r.body)).toContain("API-ключ");
    } finally {await h.stop();}
  });
});
