# Voice (issue #332, phase 1)

Push-to-talk (`voice-input@1`) and read aloud (`voice-output@1`) for chats. **Prepared, not mounted (U-22):** nothing in the product imports this folder yet; the gallery (`/__gallery` in the `test:csp` build) shows every state. Contract: [voice.md](../../../../../docs/engine-integration/voice.md).

## Layers

| File                                                 | What                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `voice-media.ts`                                     | The port: microphone, `MediaRecorder`, Web Audio output, clock. `AppBrowser.voiceMedia` injects it; the window's own otherwise.          |
| `voice-support.ts`                                   | `useVoiceInputSupport()` / `useVoiceOutputSupport()`: `available` only with the capability, the permission and a browser that can do it. |
| `voice-api.ts`                                       | `transcribeClip()` / `speakMessage()` over `client.voice`, as a `VoiceResult` value with a 60 s timeout.                                 |
| `voice-problems.ts`                                  | Every failure as a closed `VoiceProblem` with its own sentence (en, cs). The engine's `detail` is never shown.                           |
| `push-to-talk.ts`, `speech-player.ts`                | The state machines, without React. They release the microphone and close the audio output on stop, failure and cancel.                   |
| `use-voice.ts`                                       | `usePushToTalk()` / `useReadAloud()`: the machines for one chat or message; unmounting or switching cancels.                             |
| `push-to-talk-button.tsx`, `read-aloud-button.tsx`   | Presentational: state and callbacks in, nothing else.                                                                                    |
| `composer-voice-input.tsx`, `message-read-aloud.tsx` | Wired: support check, hook and button. They render nothing when voice is not available, so mounting them is safe on every engine.        |

## Mounting it

**Composer** (`features/chat/composer.tsx`): put `ComposerVoiceInput` beside Send, inside the box.

```tsx
<ComposerVoiceInput chatId={chatId} onDraft={insertDraft} disabled={locked} size="sm" />
```

- `Composer` keeps its text in local state, so it needs one small addition: an `insertDraft(text)` that puts the transcript at the caret (or after the text, with a space) and focuses the box. The draft is never sent by itself; Send stays the member's action.
- `Composer` has no `chatId` today; pass it from `chat-panel.tsx` (or render the button there and pass `insertDraft` down).
- Pass `language` only if the UI ever knows what the member speaks; without it the engine detects it.

**Message row** (`features/chat/message-row.tsx`, `MessageBody`): put `MessageReadAloud` in the agent message's quiet actions, next to Copy.

```tsx
<MessageReadAloud
  chatId={chatId}
  messageId={MessageId.parse(view.id)}
  content={rawContent}
  completed={view.state === null}
/>
```

- `content` must be the message's `content` as the API sent it (the engine counts `MAX_SPEECH_TEXT_LENGTH` on that), not the rendered text.
- `completed`: a `MessageView` with `state === null` is the stored, finished message.

Tests that render the whole app inject a fake with `voiceMedia: createFakeVoiceMedia()` (`src/testing/fake-voice-media.ts`) and enable the capabilities on the in-memory engine; the mock engine advertises both with `MOCK_VOICE=enabled`.

## Rules it keeps

- Audio and transcripts are content: never logged, never put in a query or mutation cache, an error or analytics. The clip exists only in the recorder's chunks and the request body; the transcript goes straight to `onDraft`.
- Playback decodes with `AudioContext.decodeAudioData`, never an `<audio>` with a `blob:` URL: `ENGINE_UI_CSP` has no `media-src`, so one would be refused (`test/csp/voice.spec.ts` shows both). No object URLs are created.
- The microphone is asked for only on the member's click and released the moment a recording stops, fails, is cancelled or the component unmounts. The engine sends `Permissions-Policy: microphone=(self)` only while it advertises `voice-input@1`.
- Clips stay within `MAX_VOICE_CLIP_MS` (the recorder stops itself half a second early, since the engine measures the decoded clip) and `MAX_VOICE_CLIP_BYTES` (checked per one-second chunk; over it, the clip is dropped, not sent).

## Not covered yet

- Browsers whose `MediaRecorder` makes none of `VOICE_CLIP_FORMATS` (older Safari records only `audio/mp4`) get no button. The contract's WAV fallback would need an `AudioWorklet` encoder; `audio/mp4` could be added to the contract instead (voice.md, "Open for the engine team").
