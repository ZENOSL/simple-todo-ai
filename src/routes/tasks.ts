/**
 * Task routes
 *
 * POST   /api/tasks/parse        — AI parse (no DB write, no quota deduction)
 * POST   /api/tasks/confirm      — Write parsed task to DB, deduct quota
 * GET    /api/tasks/today        — Today's tasks sorted by priority + sort_order
 * GET    /api/tasks/week         — This week's tasks
 * PATCH  /api/tasks/:id/complete — Mark task complete
 * DELETE /api/tasks/:id          — Delete task
 *
 * Abort mechanism (BE-01):
 *   request.raw.on('close') → abortController.abort() → AI SDK cancels HTTP call
 *   Aborted parse requests do NOT deduct quota (quota deducted only on confirm)
 *
 * Quota (BE-02):
 *   Free tier: 10 AI confirms/day — enforced with Redis Lua atomic script
 *   Stored in Redis key: ai_usage:{userId}:{utc_date}
 */

import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { getRedisClient } from '../lib/redis'
import { authenticate } from '../middleware/auth'
import { checkAndReserveQuota, getRemainingQuota } from '../services/quota'
import { parseTaskWithAI } from '../services/ai'
import type { ParsedTask, TaskPriority, TaskCategory } from '../types'

const PARSE_CACHE_TTL_SECONDS = 300 // 5 minutes — window to confirm after parse

function buildParseCacheKey(requestId: string): string {
  return `parse_cache:${requestId}`
}

/**
 * Compute a sort_order weight from priority.
 * Used for ordering tasks within a day view.
 */
function priorityToSortWeight(priority: TaskPriority): number {
  const weights: Record<TaskPriority, number> = {
    high: 1.0,
    medium: 0.5,
    low: 0.1,
  }
  return weights[priority] ?? 0.5
}

/**
 * Determine whether a task's due_date falls within today (UTC).
 */
function isTodayUtc(dueDateStr: string | null): boolean {
  if (!dueDateStr) return false
  const today = new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
  return dueDateStr.startsWith(today)
}

/**
 * Determine whether a task's due_date falls within the current UTC week
 * (Monday 00:00 to Sunday 23:59).
 */
function isThisWeekUtc(dueDateStr: string | null): boolean {
  if (!dueDateStr) return false
  const now = new Date()
  const day = now.getUTCDay() // 0=Sun, 1=Mon...
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7))
  monday.setUTCHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  sunday.setUTCHours(23, 59, 59, 999)

  const due = new Date(dueDateStr)
  return due >= monday && due <= sunday
}

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
  // All task routes require authentication
  fastify.addHook('preHandler', authenticate)

  // ---------------------------------------------------------------------------
  // POST /api/tasks/parse
  // Call AI, check Free quota eligibility (but do NOT deduct), cache result.
  // ---------------------------------------------------------------------------
  fastify.post<{
    Body: { input: string; request_id: string }
  }>(
    '/parse',
    {
      schema: {
        body: {
          type: 'object',
          required: ['input', 'request_id'],
          properties: {
            input: { type: 'string', minLength: 1, maxLength: 1000 },
            request_id: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { input, request_id } = request.body
      const { id: userId, tier } = request.user

      // Check quota without reserving — parse itself is free, confirm costs quota
      if (tier === 'free') {
        const remaining = await getRemainingQuota(userId, tier)
        if (remaining <= 0) {
          return reply.status(429).send({
            error: 'quota_exceeded',
            message: '今日 AI 解析次数已用完（10/10），升级 Pro 享受无限次数',
            usage: {
              used_today: 10,
              limit_today: 10,
              remaining_today: 0,
              plan: 'free',
            },
            upgrade_url: '/subscriptions/checkout',
          })
        }
      }

      // BE-01: propagate client abort to AI SDK
      const abortController = new AbortController()
      let clientAborted = false

      request.raw.on('close', () => {
        if (!reply.sent) {
          clientAborted = true
          abortController.abort()
        }
      })

      try {
        const parsed: ParsedTask = await parseTaskWithAI(input, abortController.signal)

        // Cache parse result keyed by request_id — confirm step reads from here
        const redis = getRedisClient()
        await redis.setex(
          buildParseCacheKey(request_id),
          PARSE_CACHE_TTL_SECONDS,
          JSON.stringify({ ...parsed, raw_input: input }),
        )

        const remaining = await getRemainingQuota(userId, tier)

        return reply.send({
          request_id,
          parsed,
          raw_input: input,
          usage: {
            used_today: tier === 'free' ? 10 - remaining : null,
            limit_today: tier === 'free' ? 10 : null,
            remaining_today: tier === 'free' ? remaining : null,
            plan: tier,
          },
        })
      } catch (err) {
        if (clientAborted || (err instanceof Error && err.name === 'AbortError')) {
          fastify.log.info({ request_id, userId }, 'AI parse aborted by client — no quota charged')
          // Connection already closed; Fastify will handle the dead socket gracefully
          return
        }

        if (err instanceof Error && err.message.includes('timeout')) {
          return reply.status(504).send({
            error: 'ai_timeout',
            message: 'AI 解析超时，请稍后重试或直接手动填写',
            request_id,
          })
        }

        fastify.log.error({ err, request_id, userId }, 'AI parse failed')
        return reply.status(500).send({
          error: 'ai_error',
          message: 'AI 解析失败，请稍后重试',
          request_id,
        })
      }
    },
  )

  // ---------------------------------------------------------------------------
  // POST /api/tasks/confirm
  // Read cached parse result, deduct quota, write Task to DB.
  // ---------------------------------------------------------------------------
  fastify.post<{
    Body: {
      request_id: string
      task: {
        title: string
        due_date?: string | null
        priority: TaskPriority
        category: TaskCategory
        raw_input?: string
      }
    }
  }>(
    '/confirm',
    {
      schema: {
        body: {
          type: 'object',
          required: ['request_id', 'task'],
          properties: {
            request_id: { type: 'string', minLength: 1, maxLength: 100 },
            task: {
              type: 'object',
              required: ['title', 'priority', 'category'],
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 500 },
                due_date: { type: ['string', 'null'] },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                category: { type: 'string', enum: ['work', 'life', 'study'] },
                raw_input: { type: 'string', maxLength: 1000 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { request_id, task } = request.body
      const { id: userId, tier } = request.user

      // Deduct quota atomically — reject if over limit
      const quota = await checkAndReserveQuota(userId, tier)
      if (!quota.allowed) {
        return reply.status(429).send({
          error: 'quota_exceeded',
          message: '今日 AI 解析确认次数已用完，升级 Pro 享受无限次数',
          usage: {
            used_today: quota.usedToday,
            limit_today: quota.limitToday,
            remaining_today: 0,
            plan: tier,
          },
          upgrade_url: '/subscriptions/checkout',
        })
      }

      // Attempt to retrieve the cached parse result (optional integrity check)
      const redis = getRedisClient()
      const cachedRaw = await redis.get(buildParseCacheKey(request_id)).catch(() => null)

      // Front-end may have edited the parsed fields — trust the request body as authoritative
      // The cache is used only for audit/anti-replay; missing cache is not an error
      if (cachedRaw) {
        // Invalidate cache immediately after confirm — one-time use
        await redis.del(buildParseCacheKey(request_id)).catch(() => null)
      }

      const sortOrder = priorityToSortWeight(task.priority)

      const created = await prisma.task.create({
        data: {
          userId,
          title: task.title,
          dueDate: task.due_date ?? null,
          priority: task.priority,
          category: task.category,
          rawInput: task.raw_input ?? null,
          sortOrder,
        },
      })

      // Write async audit log — non-blocking, failure tolerated
      const today = new Date()
      today.setUTCHours(0, 0, 0, 0)
      prisma.aiUsageLog
        .create({ data: { userId, action: 'parse_task', date: today } })
        .catch((err) => fastify.log.warn({ err }, 'Failed to write AiUsageLog'))

      return reply.status(201).send({
        task: {
          id: created.id,
          title: created.title,
          due_date: created.dueDate,
          priority: created.priority,
          category: created.category,
          is_completed: created.isCompleted,
          sort_order: created.sortOrder,
          raw_input: created.rawInput,
          created_at: created.createdAt.toISOString(),
        },
        usage: {
          remaining_today: quota.remaining,
          used_today: quota.usedToday,
          limit_today: quota.limitToday,
          plan: tier,
        },
      })
    },
  )

  // ---------------------------------------------------------------------------
  // GET /api/tasks/today
  // Returns today's tasks sorted by sort_order desc (high priority first).
  // Includes tasks with no due_date that were created today.
  // Response includes summary: { total, completed }.
  // ---------------------------------------------------------------------------
  fastify.get('/today', async (request, reply) => {
    const { id: userId } = request.user
    const todayStr = new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"

    const todayFilter = {
      OR: [
        { dueDate: { startsWith: todayStr } },
        { dueDate: null, createdAt: { gte: new Date(`${todayStr}T00:00:00.000Z`) } },
      ],
    }

    // Fetch all of today's tasks (both complete and incomplete) for summary
    const allTodayTasks = await prisma.task.findMany({
      where: { userId, ...todayFilter },
      orderBy: [{ sortOrder: 'desc' }, { createdAt: 'asc' }],
    })

    const completed = allTodayTasks.filter((t) => t.isCompleted).length

    return reply.send({
      tasks: allTodayTasks.map((t) => ({
        id: t.id,
        title: t.title,
        due_date: t.dueDate,
        priority: t.priority,
        category: t.category,
        is_completed: t.isCompleted,
        sort_order: t.sortOrder,
        created_at: t.createdAt.toISOString(),
      })),
      total: allTodayTasks.length,
      completed,
      date: todayStr,
    })
  })

  // ---------------------------------------------------------------------------
  // GET /api/tasks/week
  // Returns this week's tasks (Mon-Sun UTC), sorted by due_date then priority.
  // ---------------------------------------------------------------------------
  fastify.get('/week', async (request, reply) => {
    const { id: userId } = request.user

    const now = new Date()
    const day = now.getUTCDay()
    const monday = new Date(now)
    monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7))
    monday.setUTCHours(0, 0, 0, 0)
    const sunday = new Date(monday)
    sunday.setUTCDate(monday.getUTCDate() + 6)
    sunday.setUTCHours(23, 59, 59, 999)

    const mondayStr = monday.toISOString().slice(0, 10)
    const sundayStr = sunday.toISOString().slice(0, 10)

    // Use string prefix comparison since dueDate is stored as ISO8601 string
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        isCompleted: false,
        dueDate: {
          gte: mondayStr,
          lte: sundayStr + 'Z', // covers up to end of day
        },
      },
      orderBy: [{ dueDate: 'asc' }, { sortOrder: 'desc' }],
    })

    return reply.send({
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        due_date: t.dueDate,
        priority: t.priority,
        category: t.category,
        is_completed: t.isCompleted,
        sort_order: t.sortOrder,
        created_at: t.createdAt.toISOString(),
      })),
      week_start: mondayStr,
      week_end: sundayStr,
    })
  })

  // ---------------------------------------------------------------------------
  // PATCH /api/tasks/:id/complete
  // Body: { undo?: boolean }
  //   undo=false (default): mark complete
  //   undo=true: revert to incomplete, clear completedAt, no quota impact
  // ---------------------------------------------------------------------------
  fastify.patch<{ Params: { id: string }; Body: { undo?: boolean } }>(
    '/:id/complete',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            undo: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const { id: userId } = request.user
      const undo = request.body?.undo === true

      const existing = await prisma.task.findUnique({ where: { id } })
      if (!existing || existing.userId !== userId) {
        return reply.status(404).send({ error: 'not_found', message: 'Task not found' })
      }

      if (undo) {
        // Revert completion — no quota deduction
        if (!existing.isCompleted) {
          return reply.status(409).send({ error: 'not_completed', message: 'Task is not completed' })
        }

        const updated = await prisma.task.update({
          where: { id },
          data: { isCompleted: false, completedAt: null },
        })

        return reply.send({
          task: {
            id: updated.id,
            is_completed: updated.isCompleted,
            completed_at: null,
          },
        })
      }

      if (existing.isCompleted) {
        return reply.status(409).send({ error: 'already_completed', message: 'Task is already completed' })
      }

      const updated = await prisma.task.update({
        where: { id },
        data: { isCompleted: true, completedAt: new Date() },
      })

      return reply.send({
        task: {
          id: updated.id,
          is_completed: updated.isCompleted,
          completed_at: updated.completedAt?.toISOString() ?? null,
        },
      })
    },
  )

  // ---------------------------------------------------------------------------
  // DELETE /api/tasks/:id
  // ---------------------------------------------------------------------------
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const { id: userId } = request.user

      const existing = await prisma.task.findUnique({ where: { id } })
      if (!existing || existing.userId !== userId) {
        return reply.status(404).send({ error: 'not_found', message: 'Task not found' })
      }

      await prisma.task.delete({ where: { id } })
      return reply.status(204).send()
    },
  )
}
