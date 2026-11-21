export const gatewayProtocols = [
  'anthropic-messages',
  'openai-chat-completions',
  'openai-responses',
]

export class GatewayRequestError extends Error {
  status = 400
}

const textContent = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

const chatMessage = (message) => {
  if (message.role === 'latest_reminder') {
    return { role: 'system', content: message.content }
  }
  if (message.role !== 'user' && message.role !== 'assistant') return null
  if (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.some((block) => block?.type === 'image' || block?.type === 'document')
  ) {
    throw new GatewayRequestError(
      'File attachments require Anthropic Messages or OpenAI Responses protocol'
    )
  }
  const content = textContent(message.content)
  if (message.role === 'assistant' && !content.trim()) return null
  return { role: message.role, content }
}

export const toChatCompletionsRequest = (request) => {
  const messages = []
  if (typeof request.system === 'string' && request.system) {
    messages.push({ role: 'system', content: request.system })
  }
  for (const message of request.messages || []) {
    const converted = chatMessage(message)
    if (converted) messages.push(converted)
  }
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.thinking?.type === 'enabled' ? { reasoning_effort: 'medium' } : {}),
  }
}

const responsesContent = (content, role) => {
  if (typeof content === 'string') {
    return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }]
  }
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text }]
    }
    if (role !== 'user' || block?.source?.type !== 'file') return []
    if (block.type === 'image') {
      return [{ type: 'input_image', file_id: block.source.file_id, detail: 'auto' }]
    }
    if (block.type === 'document') {
      return [{ type: 'input_file', file_id: block.source.file_id }]
    }
    return []
  })
}

export const toResponsesRequest = (request) => {
  const input = []
  for (const message of request.messages || []) {
    if (message.role === 'latest_reminder') {
      input.push({
        role: 'developer',
        content: [{ type: 'input_text', text: message.content }],
      })
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const content = responsesContent(message.content, message.role)
    if (!content.length) continue
    if (message.role === 'assistant' && !content.some((item) => item.text?.trim())) continue
    input.push({ role: message.role, content })
  }
  return {
    model: request.model,
    instructions: request.system || '',
    input,
    stream: true,
    store: false,
    max_output_tokens: Number.isInteger(request.max_tokens) ? request.max_tokens : 4096,
    ...(request.thinking?.type === 'enabled'
      ? { reasoning: { effort: 'medium', summary: 'auto' } }
      : {}),
    ...(request.tools?.length ? { tools: [{ type: 'web_search_preview' }] } : {}),
  }
}

export async function* readEventStream(body) {
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true })
    const frames = pending.split(/\r?\n\r?\n/)
    pending = frames.pop() || ''
    for (const frame of frames) {
      let event = ''
      const data = []
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (data.length) yield { event, data: data.join('\n') }
    }
  }
  pending += decoder.decode()
  if (pending.trim()) {
    const data = pending
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (data.length) yield { event: '', data: data.join('\n') }
  }
}
