import { describe, expect, it, vi } from "vitest";
import { speakWithProvider, needsLocalVoice } from "../ui/src/voice/provider.ts";
const status:any={runtime:"missing",voices:[],voice:"",cloud:{tts:"xai",fallback:"local"}};
function io(){return{say:vi.fn().mockResolvedValue(new ArrayBuffer(8)),play:vi.fn().mockResolvedValue(true),system:vi.fn().mockResolvedValue(true),warning:vi.fn()};}
describe("Pio cloud voice",()=>{
 it("uses cloud without a downloaded voice or an installation prompt",async()=>{const s=io();expect(await speakWithProvider("Привет",new AbortController().signal,status,s)).toBe(true);expect(s.say).toHaveBeenCalledWith("Привет",undefined,expect.any(AbortSignal),"ru");expect(s.play).toHaveBeenCalledOnce();expect(s.system).not.toHaveBeenCalled();expect(needsLocalVoice(status,false,false)).toBe(false);});
 it("shows cloud errors and never silently invokes browser speech",async()=>{const s=io();s.say.mockRejectedValue(new Error("check key"));expect(await speakWithProvider("Hello",new AbortController().signal,status,s)).toBe(false);expect(s.warning).toHaveBeenCalledWith("check key");expect(s.system).not.toHaveBeenCalled();});
 it("does not play a late response after interruption",async()=>{const s=io();const ctl=new AbortController();s.say.mockImplementation(async()=>{ctl.abort();return new ArrayBuffer(8);});await expect(speakWithProvider("Hello",ctl.signal,status,s)).rejects.toThrow();expect(s.play).not.toHaveBeenCalled();expect(s.system).not.toHaveBeenCalled();expect(s.warning).not.toHaveBeenCalled();});
 it("preserves the existing system voice in local mode",async()=>{const s=io();await speakWithProvider("Hello",new AbortController().signal,undefined,s);expect(s.system).toHaveBeenCalledWith("Hello","en");expect(s.say).not.toHaveBeenCalled();expect(needsLocalVoice({...status,cloud:undefined},false,false)).toBe(true);});
});
