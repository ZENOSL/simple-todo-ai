/**
 * Authentication routes
 *
 * POST /api/auth/register   — email + password registration
 * POST /api/auth/login      — email + password login
 * POST /api/auth/refresh    — refresh token → new access token
 * POST /api/auth/logout     — invalidate refresh token
 * POST /api/auth/anonymous  — create anonymous device user
 */

import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma'
import { getRedisClient } from '../lib/redis'
import { signAccessToken, signRefreshToken, authenticate } from '../middleware/auth'
import jwt from 'jsonwebtoken'
import type { JwtPayload } from '../types'

const BCRYPT_ROUNDS = 12
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

function buildRefreshWhitelistKey(userId: string, token: string): string {
  // Store only a short hash identifier, not the full token
  const hash = Buffer.from(token).toString('base64').slice(-16)
  return `refresh_whitelist:${userId}:${hash}`
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/auth/register
  fastify.post<{
    Body: { email: string; password: string }
  }>(
    '/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 255 },
            password: { type: 'string', minLength: 8, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body
      const normalizedEmail = email.toLowerCase().trim()

      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } })
      if (existing) {
        return reply.status(409).send({ error: 'email_taken', message: 'Email already registered' })
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
      const user = await prisma.user.create({
        data: { email: normalizedEmail, passwordHash },
      })

      const accessToken = signAccessToken({ sub: user.id, tier: user.subscriptionTier, email: user.email ?? undefined })
      const refreshToken = signRefreshToken(user.id)

      const redis = getRedisClient()
      await redis.setex(
        buildRefreshWhitelistKey(user.id, refreshToken),
        REFRESH_TOKEN_TTL_SECONDS,
        '1',
      )

      reply.setCookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/api/auth/refresh',
        maxAge: REFRESH_TOKEN_TTL_SECONDS,
      })

      return reply.status(201).send({
        access_token: accessToken,
        user: {
          id: user.id,
          email: user.email,
          tier: user.subscriptionTier,
        },
      })
    },
  )

  // POST /api/auth/login
  fastify.post<{
    Body: { email: string; password: string }
  }>(
    '/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body
      const normalizedEmail = email.toLowerCase().trim()

      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } })
      const isValid =
        user?.passwordHash && (await bcrypt.compare(password, user.passwordHash))

      if (!user || !isValid) {
        // Constant-time response to prevent user enumeration
        return reply.status(401).send({ error: 'invalid_credentials', message: 'Invalid email or password' })
      }

      const accessToken = signAccessToken({ sub: user.id, tier: user.subscriptionTier, email: user.email ?? undefined })
      const refreshToken = signRefreshToken(user.id)

      const redis = getRedisClient()
      await redis.setex(
        buildRefreshWhitelistKey(user.id, refreshToken),
        REFRESH_TOKEN_TTL_SECONDS,
        '1',
      )

      reply.setCookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/api/auth/refresh',
        maxAge: REFRESH_TOKEN_TTL_SECONDS,
      })

      return reply.send({
        access_token: accessToken,
        user: {
          id: user.id,
          email: user.email,
          tier: user.subscriptionTier,
        },
      })
    },
  )

  // POST /api/auth/refresh
  fastify.post('/refresh', async (request, reply) => {
    const refreshToken = request.cookies?.refresh_token
    if (!refreshToken) {
      return reply.status(401).send({ error: 'no_refresh_token', message: 'Refresh token not provided' })
    }

    const refreshSecret = process.env.JWT_REFRESH_SECRET ?? (process.env.JWT_SECRET ?? '') + '_refresh'
    let payload: JwtPayload
    try {
      payload = jwt.verify(refreshToken, refreshSecret) as JwtPayload
    } catch {
      return reply.status(401).send({ error: 'invalid_refresh_token', message: 'Invalid or expired refresh token' })
    }

    const userId = payload.sub
    const whitelistKey = buildRefreshWhitelistKey(userId, refreshToken)
    const redis = getRedisClient()
    const exists = await redis.exists(whitelistKey)
    if (!exists) {
      return reply.status(401).send({ error: 'refresh_token_revoked', message: 'Refresh token has been revoked' })
    }

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      return reply.status(401).send({ error: 'user_not_found', message: 'User no longer exists' })
    }

    const accessToken = signAccessToken({ sub: user.id, tier: user.subscriptionTier, email: user.email ?? undefined })
    return reply.send({ access_token: accessToken })
  })

  // POST /api/auth/logout
  fastify.post('/logout', { preHandler: authenticate }, async (request, reply) => {
    const refreshToken = request.cookies?.refresh_token
    if (refreshToken) {
      const redis = getRedisClient()
      await redis.del(buildRefreshWhitelistKey(request.user.id, refreshToken))
    }

    reply.clearCookie('refresh_token', { path: '/api/auth/refresh' })
    return reply.send({ success: true })
  })

  // POST /api/auth/anonymous — create an anonymous device-bound user
  fastify.post<{
    Body: { device_id: string }
  }>(
    '/anonymous',
    {
      schema: {
        body: {
          type: 'object',
          required: ['device_id'],
          properties: {
            device_id: { type: 'string', minLength: 1, maxLength: 255 },
          },
        },
      },
    },
    async (request, reply) => {
      const { device_id } = request.body

      let user = await prisma.user.findUnique({ where: { deviceId: device_id } })
      if (!user) {
        user = await prisma.user.create({ data: { deviceId: device_id } })
      }

      const accessToken = signAccessToken({ sub: user.id, tier: user.subscriptionTier })
      return reply.status(201).send({ access_token: accessToken, user: { id: user.id, tier: user.subscriptionTier } })
    },
  )
}
