/**
 * Free-tier AI quota service
 *
 * Authoritative counter: Redis (atomic Lua script)
 * Fallback when Redis is unavailable: PostgreSQL AiUsageLog table
 *
 * Key design:
 *   ai_usage:{userId}:{utc_date}  →  integer count
 *   TTL: 90,000 seconds (~25 hours) — spans midnight safely across timezones
 */

import { getRedisClient } from '../lib/redis'
import { prisma } from '../lib/prisma'
import type { QuotaResult } from '../types'

const FREE_TIER_DAILY_LIMIT = 10
const QUOTA_TTL_SECONDS = 90_000 // 25 hours

/**
 * Atomic Lua script: INCR → check → DECR on overflow
 *
 * KEYS[1]: redis key  (ai_usage:{userId}:{date})
 * ARGV[1]: daily limit (integer)
 * ARGV[2]: TTL in seconds
 *
 * Returns: [current_count: number, is_allowed: 0|1]
 *   - is_allowed=1 means the slot was reserved successfully
 *   - is_allowed=0 means the limit was exceeded; DECR has already been applied
 */
const QUOTA_GATE_LUA = `
local key   = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl   = tonumber(ARGV[2])

local current = redis.call('INCR', key)

if current == 1 then
  redis.call('EXPIRE', key, ttl)
end

if current > limit then
  redis.call('DECR', key)
  return {current - 1, 0}
else
  return {current, 1}
end
`

function getUtcDateString(): string {
  return new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
}

function buildRedisKey(userId: string): string {
  return `ai_usage:${userId}:${getUtcDateString()}`
}

/**
 * Atomically reserve one quota slot for a free-tier user.
 * Pro users always pass through.
 *
 * @returns QuotaResult — if allowed=false the caller must return HTTP 429
 */
export async function checkAndReserveQuota(
  userId: string,
  tier: 'free' | 'pro',
): Promise<QuotaResult> {
  if (tier === 'pro') {
    return { allowed: true, remaining: Infinity, usedToday: 0, limitToday: Infinity }
  }

  try {
    const redis = getRedisClient()
    const key = buildRedisKey(userId)

    const result = (await redis.eval(
      QUOTA_GATE_LUA,
      1,
      key,
      String(FREE_TIER_DAILY_LIMIT),
      String(QUOTA_TTL_SECONDS),
    )) as [number, number]

    const [count, isAllowed] = result
    const allowed = isAllowed === 1
    const usedToday = allowed ? count : count
    const remaining = Math.max(0, FREE_TIER_DAILY_LIMIT - usedToday)

    return {
      allowed,
      usedToday,
      remaining,
      limitToday: FREE_TIER_DAILY_LIMIT,
    }
  } catch (err) {
    // Redis unavailable — fall back to PostgreSQL count (eventually consistent)
    console.warn('[quota] Redis unavailable, falling back to PostgreSQL:', (err as Error).message)
    return checkAndReserveQuotaFallback(userId)
  }
}

/**
 * Release a previously reserved quota slot.
 * Called when an AI request is aborted before confirm — the parse was cancelled
 * so the user should not be charged.
 *
 * Note: this is only called from the parse abort path, never from confirm.
 * Confirm does not reserve a slot upfront; it only consumes on success.
 */
export async function releaseQuota(userId: string): Promise<void> {
  try {
    const redis = getRedisClient()
    const key = buildRedisKey(userId)

    // Only decrement if key exists and count > 0 to avoid going negative
    const releaseScript = `
      local key = KEYS[1]
      local current = redis.call('GET', key)
      if current and tonumber(current) > 0 then
        return redis.call('DECR', key)
      end
      return 0
    `
    await redis.eval(releaseScript, 1, key)
  } catch (err) {
    // Non-fatal: worst case user loses one slot on the daily counter
    console.error('[quota] Failed to release quota slot:', (err as Error).message)
  }
}

/**
 * Return the remaining quota for a user without modifying the counter.
 */
export async function getRemainingQuota(
  userId: string,
  tier: 'free' | 'pro',
): Promise<number> {
  if (tier === 'pro') return Infinity

  try {
    const redis = getRedisClient()
    const key = buildRedisKey(userId)
    const raw = await redis.get(key)
    const used = raw ? parseInt(raw, 10) : 0
    return Math.max(0, FREE_TIER_DAILY_LIMIT - used)
  } catch {
    // Fall back to PostgreSQL
    const used = await countTodayUsageFromDb(userId)
    return Math.max(0, FREE_TIER_DAILY_LIMIT - used)
  }
}

// ---------------------------------------------------------------------------
// Private: PostgreSQL fallback helpers
// ---------------------------------------------------------------------------

async function countTodayUsageFromDb(userId: string): Promise<number> {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const count = await prisma.aiUsageLog.count({
    where: {
      userId,
      date: today,
    },
  })
  return count
}

async function checkAndReserveQuotaFallback(userId: string): Promise<QuotaResult> {
  const usedToday = await countTodayUsageFromDb(userId)
  const allowed = usedToday < FREE_TIER_DAILY_LIMIT

  if (allowed) {
    // Write the log entry so subsequent fallback reads are consistent
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    await prisma.aiUsageLog.create({
      data: {
        userId,
        action: 'parse_task',
        date: today,
      },
    })
  }

  return {
    allowed,
    usedToday: allowed ? usedToday + 1 : usedToday,
    remaining: Math.max(0, FREE_TIER_DAILY_LIMIT - (allowed ? usedToday + 1 : usedToday)),
    limitToday: FREE_TIER_DAILY_LIMIT,
  }
}
