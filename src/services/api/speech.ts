import { ApiError, API_ORIGIN, request } from './client.js'

/**
 * The gateway's OpenAI-compatible audio endpoints.
 */
const AUDIO_BASE_URL = `${API_ORIGIN}/v1/audio`

export type TtsVoice = 'stella' | 'tide'

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端 */
export const TTS_SAMPLE_RATE = 24000

/** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus，时长不超过 120 秒、大小不超过 8 MiB */
export const transcribe = async (
  model: string,
  audio: Blob,
  signal?: AbortSignal
): Promise<string> => {
  const form = new FormData()
  form.append('file', audio, 'recording.wav')
  form.append('model', model)
  const response = await request(`${AUDIO_BASE_URL}/transcriptions`, {
    method: 'POST',
    body: form,
    signal,
  })
  const raw = await response.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', raw)
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new ApiError('protocol', raw)
  }
  return body.text
}

/** 语音合成：返回裸 PCM 字节流；服务端默认过滤代码块、表格、引用标记与长公式 */
export const synthesize = async (
  text: string,
  model: string,
  voice: TtsVoice,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  const response = await request(`${AUDIO_BASE_URL}/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text, voice, response_format: 'pcm' }),
    signal,
  })
  if (!response.body) {
    throw new ApiError('protocol', await response.text())
  }
  return response.body
}
