/**
 * Simple Todo AI — Fastify application entry point
 *
 * Startup sequence:
 *   1. Build Fastify instance with structured logging
 *   2. Register plugins (CORS, cookie, rate-limit, auth)
 *   3. Register route prefixes
 *   4. Connect to DB (Prisma) and Redis on startup
 *   5. Graceful shutdown on SIGTERM / SIGINT
 */

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import { authRoutes } from './routes/auth'
import { taskRoutes } from './routes/tasks'
import { userRoutes } from './routes/users'
import { prisma } from './lib/prisma'
import { getRedisClient, closeRedisClient } from './lib/redis'

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    // Expose request ID in response headers for distributed tracing
    genReqId: (req) =>
      (req.headers['x-request-id'] as string | undefined) ??
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    // Disallow unknown content types for body parsing security
    ajv: {
      customOptions: {
        coerceTypes: 'array',
        useDefaults: true,
        removeAdditional: true,
        allErrors: false,
      },
    },
  })

  // ---------------------------------------------------------------------------
  // Plugins
  // ---------------------------------------------------------------------------

  await fastify.register(fastifyCors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  await fastify.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET ?? process.env.JWT_SECRET ?? 'change-me-in-production',
    parseOptions: {},
  })

  // Global rate limiter — prevents brute-force and abuse at the network edge
  await fastify.register(fastifyRateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    redis: getRedisClient(),
    keyGenerator: (req) => req.user?.id ?? req.ip,
    errorResponseBuilder: (_req, context) => ({
      error: 'rate_limit_exceeded',
      message: `请求过于频繁，请 ${context.after} 后重试`,
    }),
  })

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  await fastify.register(authRoutes, { prefix: '/api/auth' })
  await fastify.register(taskRoutes, { prefix: '/api/tasks' })
  await fastify.register(userRoutes, { prefix: '/api/users' })

  // ---------------------------------------------------------------------------
  // Health check (unauthenticated)
  // ---------------------------------------------------------------------------

  // /health — Railway healthcheck path (simple liveness, no external deps)
  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

  // /healthz — deep readiness check: verifies DB + Redis connectivity
  fastify.get('/healthz', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      await getRedisClient().ping()
      return reply.send({ status: 'ok', timestamp: new Date().toISOString() })
    } catch (err) {
      fastify.log.error({ err }, 'Health check failed')
      return reply.status(503).send({ status: 'degraded', timestamp: new Date().toISOString() })
    }
  })

  // ---------------------------------------------------------------------------
  // Global error handler
  // ---------------------------------------------------------------------------

  fastify.setErrorHandler(async (error, request, reply) => {
    const statusCode = error.statusCode ?? 500

    // Validation errors from ajv schema
    if (error.validation) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Request validation failed',
        details: error.validation,
      })
    }

    if (statusCode >= 500) {
      fastify.log.error(
        { err: error, requestId: request.id, path: request.url },
        'Unhandled server error',
      )
      return reply.status(500).send({
        error: 'internal_server_error',
        message: 'An unexpected error occurred',
      })
    }

    return reply.status(statusCode).send({
      error: error.code ?? 'request_error',
      message: error.message,
    })
  })

  // ---------------------------------------------------------------------------
  // Lifespan: connect on startup, disconnect on shutdown
  // ---------------------------------------------------------------------------

  fastify.addHook('onReady', async () => {
    await prisma.$connect()
    fastify.log.info('PostgreSQL connected via Prisma')

    getRedisClient() // initialize connection
    fastify.log.info('Redis client initialized')
  })

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect()
    await closeRedisClient()
    fastify.log.info('Connections closed gracefully')
  })

  return fastify
}

// ---------------------------------------------------------------------------
// Entry point — only runs when this file is executed directly
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  console.log('[server] Building application...')
  const app = await buildApp()

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutdown signal received')
    console.log(`[server] Shutdown signal received: ${signal}`)
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.log(`[server] Attempting to listen on ${HOST}:${PORT}...`)
  try {
    await app.listen({ port: PORT, host: HOST })
    console.log(`[server] Server started successfully on http://${HOST}:${PORT}`)
    console.log(`[server] Health check available at http://${HOST}:${PORT}/health`)
  } catch (err) {
    console.error('[server] Failed to start server:', err)
    app.log.fatal({ err }, 'Failed to start server')
    process.exit(1)
  }
}

start()
