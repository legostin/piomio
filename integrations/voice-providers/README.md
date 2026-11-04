# Voice providers

An optional voice integration for Pio and agents: **Built-in**, Grok (xAI), ElevenLabs and OpenAI. It ships disabled. When enabled, Built-in is the default for both synthesis and recognition: the hub’s existing local engines, with no external key or cloud request. Disabling the plugin restores the previous hub transcription setting.

## Connect

1. Open **Settings → Voice providers**, or **Plugins → Voice providers**, and enable the integration.
2. Add only the selected providers' keys in the setup card (or through `hub_secret_request`). The card writes directly to `vault://xai_api_key`, `vault://elevenlabs_api_key`, or `vault://openai_api_key`. Keys are never settings fields. Existing vault items can be reused.
3. Open the plugin's **Settings** and select speech synthesis, transcription, voices and models, then save. Synthesis and transcription may use different providers. Both default to **Built-in**; even an existing OpenAI key or the legacy hub “auto” setting cannot silently choose a cloud provider. API usage is charged to the key owner's account; a ChatGPT subscription is not an API key.
4. External-provider failures always fall back to **Built-in**. Install the local models in the hub’s voice settings. If built-in speech is unavailable too, Piomio shows the reason. There is no second cloud fallback.

Pio uses these choices for microphone recordings and spoken replies, including cancellation on interruption. Agent voice attachments and `transcribe_audio` use the same transcription selection. `voice_providers_say` creates an AI-generated audio file in the calling session's workspace on the hub; `voice_providers_status` checks choices and key presence without a paid API request. No tool sends the audio to another person.

## Provider contracts

| Provider | Synthesis default | Voice default | Transcription default |
| --- | --- | --- | --- |
| Built-in | Existing local engine | Hub voice setting | Existing local model |
| Grok (xAI) | `/v1/tts` (no model selector in this API) | `rex` | `grok-voice-transcribe-2.0` |
| ElevenLabs | `eleven_flash_v2_5` | `JBFqnCBsd6RMkjVDRZzb` | `scribe_v2` |
| OpenAI | `gpt-realtime-2.1-mini` | `cedar` | `gpt-transcribe` |

Model and voice IDs are editable. An unavailable model or a voice belonging to another API returns a configuration error. OpenAI `gpt-realtime*` models use the Realtime WebSocket API: one stateless response, no tools or conversation history, PCM wrapped as a mono 24 kHz WAV. Other OpenAI model IDs use the Speech API and return MP3. Realtime is generative: a verbatim-reading instruction is supplied, but exact spoken wording is not guaranteed. The Speech API's announced shutdown is January 6, 2027; its model IDs are retained for compatibility, not selected by default.

Requests stay inside the plugin's network sandbox and fixed provider hosts; redirects are refused. Keys, recordings and provider error bodies are not logged. Errors distinguish a missing key, rejected credentials, balance/rate limits, invalid settings, timeout and unavailable service. Limits are 1000 spoken characters, 25 MB audio, four concurrent requests and a 45-second deadline including vault access and response body. Cancellation stops the request and never starts fallback speech.

Fallback always uses the built-in local engine. It never tries another cloud provider or the browser's potentially remote speech engine. Local transcription currently requires WAV; an Ogg/M4A attachment cannot fall back without a local decoder. Missing local models or an unsupported recording produce an explicit error. Successful fallback returns a warning to Pio and agent transcription/synthesis tools.

## Verification

Contract tests cover all three HTTP adapters, OpenAI Realtime events/WAV framing, invalid audio, sanitized errors and cancellation. Service tests cover the real plugin process, vault failures/timeouts, concurrency, public-hook rejection and session file delivery. Hub tests use real authenticated Fastify routes (without opening a port), secret setup, persisted settings, keyless built-in defaults (including with a legacy cloud key present), missing built-in models, routing, disable/recovery and fallback. Pio tests cover cloud use without local models and no browser fallback on a cloud error.

```sh
npx vitest run integrations/voice-providers packages/core/test/voice-providers.test.ts packages/core/test/voice-api.test.ts plugins/pio/test/cloud-voice.test.ts
npm run typecheck
npm run typecheck -w @piomio/web
npx tsc -p plugins/pio/ui/tsconfig.json --noEmit
npm run build
```

Release acceptance: first choose Built-in for both operations with no external keys and confirm recognition and synthesis. With a cloud key present, confirm Built-in still stays local. For each external provider, save its key through the vault card, select it for both operations, speak a Russian/English sentence to Pio and listen to the reply; interrupt speech; ask an agent to transcribe a WAV and generate an audio file. Reopen settings to verify saved model/voice choices. Check a wrong key, unavailable model, no balance, disconnected network, local fallback both with/without installed models, and disable the plugin to restore the old behavior. Inspect desktop and mobile plugin settings. Automated tests use synthetic keys and recordings; they do not prove account access, live API compatibility, audio quality or latency from Almaty.

## API references checked on 2026-11-04

- [xAI speech synthesis](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech) and [transcription](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text).
- [ElevenLabs synthesis](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) and [transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).
- [OpenAI synthesis](https://developers.openai.com/api/docs/guides/text-to-speech), [transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [Realtime WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets) and [client events](https://developers.openai.com/api/reference/resources/realtime/client-events).
