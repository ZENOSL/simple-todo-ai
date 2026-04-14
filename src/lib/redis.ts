import Redis from 'ioredis'

let redisClient: Redis | null = null

export function getRedisClient(): Redis {
  if (redisClient) return redisClient

  const url = process.env.REDIS_URL
  if (!url) throw new Error('REDIS_URL environment variable is not set')

  redisClient = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    enableReadyCheck: true,
  })

  redisClient.on('error', (err) => {
    // Log but do not crash — quota service has a PostgreSQL fallback
    console.error('[Redis] connection error:', err.message)
  })

  return redisClient
}

export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit()
    redisClient = null
  }
}
