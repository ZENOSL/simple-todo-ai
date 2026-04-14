import Redis from 'ioredis'

let redisClient: Redis | null = null

export function getRedisClient(): Redis {
  if (redisClient) return redisClient

  const url = process.env.REDIS_URL
  if (!url) throw new Error('REDIS_URL environment variable is not set')

  redisClient = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    enableReadyCheck: true,
  })

  redisClient.on('error', (err) => {
    // Log but do not crash — quota service has a PostgreSQL fallback
    console.error('[Redis] connection error:', err.message)
  })

  redisClient.on('reconnecting', () => {
    console.warn('[Redis] reconnecting...')
  })

  // Initiate the connection in the background so the caller is never blocked.
  // Any failure is surfaced through the 'error' event above rather than
  // throwing synchronously or stalling module initialisation.
  redisClient.connect().catch((err: Error) => {
    console.error('[Redis] initial connect failed:', err.message)
  })

  return redisClient
}

export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit()
    redisClient = null
  }
}
