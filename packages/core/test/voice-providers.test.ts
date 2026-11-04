import { afterEach, beforeEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VoiceProviders } from "../src/speech/providers.ts";
import { Transcriber } from "../src/transcribe.ts";
import { encodeWav } from "../src/speech/wav.ts";
import { Hub, loadConfig } from "../src/index.ts";
import { buildMainApp } from "../src/server/main-app.ts";
import { createCoreCall } from "../src/core-call.ts";

const wav = encodeWav(new Float32Array(1600), 16000);
function fixture(settings: Record<string, unknown> = { ttsProvider:"xai",sttProvider:"elevenlabs" }, legacy: "off" | "auto" = "off") {
  const rec: any = { enabled:true,status:"running",settings };
  const host = { get:vi.fn(()=>rec), http:vi.fn(async(_id: string, r: any)=>({body:r.path === "/say" ? {data:wav.toString("base64"),mimeType:"audio/wav"} : {text:"hello"}})) };
  const local: any = { say:vi.fn(async()=>wav),sttReady:()=>"local-model",recognize:vi.fn(async()=>"local words") };
  const hasSecret=vi.fn(()=>true); const secret=vi.fn(()=>{throw new Error("core should not access a provider key");});
  const transcriber=new Transcriber({settings:()=>({provider:legacy}),hasSecret,secret});transcriber.local=local;
  const bridge=new VoiceProviders(host as any,local,transcriber);
  return {rec,host,local,transcriber,bridge,hasSecret,secret};
}
afterEach(()=>vi.restoreAllMocks());
describe("voice provider routing and local fallback",()=>{
  it.each([{}, {ttsProvider:"local",sttProvider:"local"}, {sttProvider:"inherit"}])("built-in is keyless with default, explicit and earlier settings %j",async(settings)=>{
    const f=fixture(settings,"auto");
    expect(f.transcriber.engine()).toEqual({label:"sherpa-onnx",model:"local-model",local:true});
    expect(await f.transcriber.transcribeBuffer(wav,"audio/wav","phrase.wav","ru")).toBe("local words");
    expect((await f.bridge.say("Привет")).data).toEqual(wav);
    expect(f.local.say).toHaveBeenCalledOnce();expect(f.local.recognize).toHaveBeenCalledOnce();
    expect(f.host.http).not.toHaveBeenCalled();expect(f.hasSecret).not.toHaveBeenCalled();expect(f.secret).not.toHaveBeenCalled();
    f.rec.enabled=false;expect(f.transcriber.engine()?.label).toBe("OpenAI");
  });
  it("never inherits a cloud key when the selected built-in recognition model is missing",async()=>{
    const f=fixture({},"auto"); f.local.sttReady=()=>undefined;
    expect(f.transcriber.engine()).toBeUndefined();
    await expect(f.transcriber.transcribeBuffer(wav)).rejects.toThrow(/no speech-to-text/);
    expect(f.host.http).not.toHaveBeenCalled();expect(f.hasSecret).not.toHaveBeenCalled();expect(f.secret).not.toHaveBeenCalled();
  });
  it.each(["xai","elevenlabs","openai"])("%s errors always fall back to built-in speech",async(id)=>{
    const f=fixture({ttsProvider:id,sttProvider:id,fallback:"none"});
    f.host.http.mockResolvedValue({status:401,body:{error:"key rejected"}} as any);
    expect((await f.bridge.say("hello")).warning).toContain("key rejected");
    expect(await f.transcriber.transcribeBuffer(wav)).toBe("local words");
    expect(f.local.say).toHaveBeenCalledOnce();expect(f.local.recognize).toHaveBeenCalledOnce();
    expect(f.secret).not.toHaveBeenCalled();
  });
  it("cloud works without installed local models and all transcription callers use the selection",async()=>{
    const f=fixture();f.local.sttReady=()=>undefined;
    expect(f.transcriber.engine()?.label).toBe("ElevenLabs");
    expect(await f.transcriber.transcribeBuffer(wav,"audio/wav","clip.wav","ru")).toBe("hello");
    expect(f.host.http.mock.calls[0][1]).toMatchObject({path:"/transcribe",public:false,body:{data:wav.toString("base64"),name:"clip.wav",language:"ru"}});
    const a=await f.bridge.say("**Привет**",{language:"ru"});expect(a.data).toEqual(wav);expect(f.local.say).not.toHaveBeenCalled();
    expect(f.host.http.mock.calls[1][1].body).toMatchObject({text:"Привет.",language:"ru"});
  });
  it("falls back only locally and reports why without trying a second cloud",async()=>{
    const f=fixture();f.host.http.mockResolvedValue({status:429,body:{error:"quota exhausted"}} as any);
    const a=await f.bridge.say("hello");expect(a.warning).toContain("quota exhausted");expect(f.local.say).toHaveBeenCalledOnce();
    const warnings:string[]=[];expect(await f.transcriber.transcribeBuffer(wav,"audio/wav","clip.wav","ru",w=>warnings.push(w))).toBe("local words");expect(warnings[0]).toContain("quota exhausted");
    expect(f.host.http).toHaveBeenCalledTimes(2);
    await expect(f.transcriber.transcribeBuffer(Buffer.from("OggS"),"audio/ogg","clip.ogg")).rejects.toThrow(/Built-in fallback is unavailable/);
  });
  it("uses built-in fallback even after a plugin crash and restores legacy selection on disable",async()=>{
    const f=fixture({ttsProvider:"xai",sttProvider:"xai",fallback:"none"});f.rec.status="crashed";
    expect((await f.bridge.say("hello")).warning).toMatch(/unavailable/);expect(f.local.say).toHaveBeenCalledOnce();
    expect(await f.transcriber.transcribeBuffer(wav)).toBe("local words");expect(f.local.recognize).toHaveBeenCalledOnce();
    f.rec.enabled=false;expect(f.transcriber.engine()).toBeUndefined();expect((await f.bridge.say("local")).data).toEqual(wav);expect(f.host.http).not.toHaveBeenCalled();
  });
  it("cancellation interrupts the RPC immediately, sends cancel once and never falls back",async()=>{
    const f=fixture();const ctl=new AbortController();let resolve:any;
    f.host.http.mockImplementation(async(_id,r)=>r.path === "/cancel" ? {body:{ok:true}} as any : new Promise(r=>{resolve=r;}));
    const p=f.bridge.say("old sentence",{signal:ctl.signal});const fail=expect(p).rejects.toThrow();ctl.abort();await fail;
    expect(f.host.http.mock.calls.map(c=>c[1].path)).toEqual(["/say","/cancel"]);expect(f.host.http.mock.calls[1][1].body.id).toBe(f.host.http.mock.calls[0][1].body.id);expect(f.local.say).not.toHaveBeenCalled();
    resolve({body:{data:wav.toString("base64"),mimeType:"audio/wav"}});
  });
  it("checks input sizes before plugin RPC and reads live selection on each request",async()=>{
    const f=fixture();await expect(f.transcriber.transcribeBuffer(Buffer.alloc(0))).rejects.toThrow(/empty/);expect(f.host.http).not.toHaveBeenCalled();
    f.rec.settings.sttProvider="local";expect(f.transcriber.engine()?.local).toBe(true);f.rec.settings.sttProvider="openai";expect(f.transcriber.engine()?.label).toBe("OpenAI");
    const ctl=new AbortController();ctl.abort();await expect(f.bridge.say("old",{signal:ctl.signal})).rejects.toThrow();expect(f.host.http).not.toHaveBeenCalled();
  });
});

describe("authenticated speech API without listening on a network port",()=>{
  let hub:Hub; let app:Awaited<ReturnType<typeof buildMainApp>>;let cookie="";let csrf="";
  const req=async(method:string,url:string,payload?:any,type="application/json",signed=true)=>{
    const r=await app.inject({method:method as any,url,headers:{host:"localhost:8080",origin:"http://localhost:8080",...(signed?{cookie,"x-csrf":csrf}:{}),"content-type":type},payload});
    if(r.headers["set-cookie"]) cookie=String(r.headers["set-cookie"]).split(";")[0];return r;
  };
  beforeAll(async()=>{
    hub=new Hub(loadConfig({PIOMIO_DEVICES:"0",TZ:"UTC"},{dataDir:mkdtempSync(join(tmpdir(),"voice-inject-")),builtinPluginsDirs:[resolve("integrations")],builtinAgentsDir:join(import.meta.dirname,"fixtures/agents")}));
    hub.plugins.discover();
    app=await buildMainApp(hub);
    const setup=await req("POST","/api/auth/setup",{token:hub.auth.setupToken,password:"test-voice-password-1"});expect(setup.statusCode).toBe(200);
    csrf=(await req("GET","/api/bootstrap")).json().csrf;
    const plugin = hub.plugins.get("voice-providers")!;
    expect(plugin.enabled).toBe(false);
    Object.assign(plugin, {enabled:true,status:"running",settings:{ttsProvider:"xai",sttProvider:"xai"}});
  });
  beforeEach(()=>{hub.plugins.get("voice-providers")!.settings={ttsProvider:"xai",sttProvider:"xai"};});
  afterAll(async()=>{await app?.close();await hub?.stop();});
  it("keeps authentication and CSRF gates and returns cloud audio with its actual MIME type",async()=>{
    const http=vi.spyOn(hub.plugins,"http").mockResolvedValue({body:{data:Buffer.from("ID3fake").toString("base64"),mimeType:"audio/mpeg"}});
    expect((await req("POST","/api/speech/say",{text:"hello"},"application/json",false)).statusCode).toBe(401);
    const r=await req("POST","/api/speech/say",{text:"hello",language:"en"});expect(r.statusCode).toBe(200);expect(r.headers["content-type"]).toBe("audio/mpeg");expect(r.rawPayload.toString()).toBe("ID3fake");expect(http).toHaveBeenCalledOnce();
    const status=await req("GET","/api/speech");expect(status.json().cloud).toEqual({tts:"xai",stt:"xai",fallback:"local"});
  });
  it("connects all three vault keys through the real setup API and persists provider choices", async () => {
    expect((await req("POST", "/api/vault/init", {passphrase:"voice-test-passphrase",remember:false})).statusCode).toBe(200);
    for (const id of ["xai_api_key", "elevenlabs_api_key", "openai_api_key"]) {
      const saved=await req("POST", `/api/plugins/voice-providers/secrets/${id}`, {value:`test-only-${id}`});
      expect(saved.statusCode).toBe(200);
      expect(saved.json().secrets.find((s:any)=>s.vaultId===id).present).toBe(true);
      expect(saved.body).not.toContain(`test-only-${id}`);
    }
    const settings={ttsProvider:"openai",sttProvider:"elevenlabs",openaiVoice:"marin",openaiTtsModel:"gpt-realtime-2.1"};
    expect((await req("PUT", "/api/plugins/voice-providers/settings", settings)).statusCode).toBe(200);
    const view=(await req("GET", "/api/plugins")).json().find((p:any)=>p.id==="voice-providers");
    expect(view.settings).toEqual(settings);
    for(const op of ["ttsProvider","sttProvider"]) {
      expect(view.contributes.settings.properties[op].enum).toEqual(["local","xai","elevenlabs","openai"]);
      expect(view.contributes.settings.properties[op].enumNames[0]).toBe("Built-in");
      expect(view.contributes.settings.properties[op].default).toBe("local");
    }
    expect(view.contributes.settings.properties.fallback).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("test-only-");
    expect((await req("GET","/api/speech")).json().cloud).toEqual({tts:"openai",stt:"elevenlabs",fallback:"local"});
    await req("PUT","/api/plugins/voice-providers/settings",{ttsProvider:"xai",sttProvider:"xai"});
  });
  it("uses saved Built-in choices over legacy auto even when cloud keys exist",async()=>{
    expect((await req("PUT","/api/plugins/voice-providers/settings",{ttsProvider:"local",sttProvider:"local"})).statusCode).toBe(200);
    const http=vi.spyOn(hub.plugins,"http");
    vi.spyOn(hub.speech,"sttReady").mockReturnValue("builtin-model");
    vi.spyOn(hub.speech,"recognize").mockResolvedValue("built-in words");
    vi.spyOn(hub.speech,"say").mockResolvedValue(wav);
    const status=(await req("GET","/api/speech")).json();
    expect(status.transcriptionManaged).toBe(true);expect(status.cloud).toBeUndefined();
    expect((await req("GET","/api/transcription")).json().engine).toEqual({label:"sherpa-onnx",model:"builtin-model"});
    expect((await req("POST","/api/speech/transcribe",wav,"audio/wav")).json()).toEqual({text:"built-in words"});
    expect((await req("POST","/api/speech/say",{text:"hello"})).rawPayload).toEqual(wav);
    expect(http).not.toHaveBeenCalled();
    await req("PUT","/api/plugins/voice-providers/settings",{ttsProvider:"xai",sttProvider:"xai"});
  });
  it("uses the same provider for microphone transcription and plugin core calls",async()=>{
    vi.spyOn(hub.plugins,"http").mockResolvedValue({body:{text:"spoken words"}});
    expect((await req("POST","/api/speech/transcribe?lang=ru",wav,"audio/wav")).json()).toEqual({text:"spoken words"});
    expect((await req("GET","/api/transcription")).json().engine.label).toBe("Grok (xAI)");
    vi.spyOn(hub.plugins,"http").mockResolvedValue({body:{data:wav.toString("base64"),mimeType:"audio/wav"}});
    const a=await createCoreCall(hub)("voice-providers","speech.say",{text:"hello"}) as any;expect(a.data).toBe(wav.toString("base64"));
  });
});
