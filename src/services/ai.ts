/**
 * AI parsing service — GLM-4-Flash (primary) with GLM-4-Air fallback
 *
 * Output contract (four fields, must match ai-engineer spec):
 *   title:    string           — task title, non-empty
 *   due_date: string | null    — ISO8601 date/datetime string or null
 *   priority: "high"|"medium"|"low"
 *   category: "work"|"life"|"study"
 */

import { log } from 'node:console'
import type { ParsedTask } from '../types'

const GLM_API_BASE = process.env.GLM_API_BASE ?? 'https://open.bigmodel.cn/api/paas/v4'
const PRIMARY_MODEL = process.env.GLM_PRIMARY_MODEL ?? 'GLM-4.7'
const FALLBACK_MODEL = process.env.GLM_FALLBACK_MODEL ?? 'glm-4.7'
const REQUEST_TIMEOUT_MS = 8_000

const SYSTEM_PROMPT = `你是一个任务解析助手。将用户的自然语言输入解析为结构化的任务数据。

严格按照以下 JSON 格式输出，不要输出任何其他内容：
{
  "title": "任务标题（简洁明确，不超过100字）",
  "due_date": "ISO8601格式日期时间 或 null",
  "priority": "high 或 medium 或 low",
  "category": "work 或 life 或 study"
}

规则：
1. title: 提炼核心任务，去除时间/优先级修饰语
2. due_date: 解析相对时间（明天/下周/后天等）为绝对 ISO8601 格式。今天基准日期为当前 UTC 时间。无明确时间时返回 null
3. priority: 含"紧急/重要/马上/立刻/必须"→high；含"有空/有时间/随便/不急"→low；其余→medium
4. category: 工作/会议/项目/代码/报告→work；学习/课程/考试/读书→study；其余生活类→life

仅输出合法 JSON，不含 markdown 代码块。`

interface GlmMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface GlmResponse {
  choices: Array<{
    message: {
      content: string
    }
    finish_reason: string
  }>
}

const VALID_PRIORITIES = new Set(['high', 'medium', 'low'])
const VALID_CATEGORIES = new Set(['work', 'life', 'study'])

function sanitizeParsedTask(raw: Record<string, unknown>, input: string): ParsedTask {
  const title =
    typeof raw.title === 'string' && raw.title.trim().length > 0
      ? raw.title.trim().slice(0, 500)
      : input.slice(0, 100)

  const due_date =
    typeof raw.due_date === 'string' && raw.due_date.trim().length > 0
      ? raw.due_date.trim()
      : null

  const priority = VALID_PRIORITIES.has(raw.priority as string)
    ? (raw.priority as ParsedTask['priority'])
    : 'medium'

  const category = VALID_CATEGORIES.has(raw.category as string)
    ? (raw.category as ParsedTask['category'])
    : 'life'

  return { title, due_date, priority, category }
}

async function callGlmApi(
  model: string,
  messages: GlmMessage[],
  signal: AbortSignal,
): Promise<string> {
  const apiKey = process.env.GLM_API_KEY
  if (!apiKey) throw new Error('GLM_API_KEY environment variable is not set')

  const response = await fetch(`${GLM_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      temperature: 0.1,
      max_tokens: 256,
    }),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error')
    throw new Error(`GLM API error ${response.status}: ${errorText}`)
  }

  const data = (await response.json()) as GlmResponse
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('GLM API returned empty content')

  return content
}

/**
 * Parse natural language task input using GLM.
 * Automatically falls back to GLM-4-Air if the primary model fails.
 *
 * @param input   - raw user text (1-1000 chars)
 * @param signal  - AbortSignal from the HTTP request (BE-01 abort propagation)
 */
export async function parseTaskWithAI(
  input: string,
  signal: AbortSignal,
): Promise<ParsedTask> {
  const messages: GlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `当前时间：${new Date().toISOString()}\n\n任务输入：${input}`,
    },
  ]

  // Add a local timeout on top of the caller's signal
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS)

  // Compose signals: abort if either fires
  const composedSignal = AbortSignal.any
    ? AbortSignal.any([signal, timeoutController.signal])
    : signal // Node 18 fallback — just use caller signal

  try {
    let rawContent: string

    try {
      rawContent = await callGlmApi(PRIMARY_MODEL, messages, composedSignal)
    } catch (primaryErr) {
      console.log("primaryerr", primaryErr);

      // Do not fall back on AbortError — the client cancelled the request
      if (

        primaryErr instanceof Error &&
        (primaryErr.name === 'AbortError' || primaryErr.name === 'TimeoutError')
      ) {
        throw primaryErr
      }

      console.warn(
        `[ai] primary model ${PRIMARY_MODEL} failed, trying ${FALLBACK_MODEL}:`,
        (primaryErr as Error).message,
      )
      rawContent = await callGlmApi(FALLBACK_MODEL, messages, composedSignal)
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawContent) as Record<string, unknown>
    } catch {
      throw new Error(`AI returned invalid JSON: ${rawContent.slice(0, 200)}`)
    }

    return sanitizeParsedTask(parsed, input)
  } finally {
    clearTimeout(timeoutId)
  }
}
