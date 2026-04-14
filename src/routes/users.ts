/**
 * User routes
 *
 * GET  /api/users/me        — current user profile + today's AI usage
 * GET  /api/users/me/usage  — today's AI usage detail
 */

import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { authenticate } from '../middleware/auth'
import { getRemainingQuota } from '../services/quota'

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', authenticate)

  // GET /api/users/me
  fastify.get('/me', async (request, reply) => {
    const { id: userId, tier } = request.user

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { subscription: true },
    })

    if (!user) {
      return reply.status(404).send({ error: 'user_not_found', message: 'User not found' })
    }

    const remaining = await getRemainingQuota(userId, tier)

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        tier: user.subscriptionTier,
        created_at: user.createdAt.toISOString(),
      },
      subscription: user.subscription
        ? {
            status: user.subscription.status,
            current_period_end: user.subscription.currentPeriodEnd?.toISOString() ?? null,
          }
        : null,
      usage: {
        remaining_today: tier === 'free' ? remaining : null,
        limit_today: tier === 'free' ? 10 : null,
        plan: tier,
      },
    })
  })

  // GET /api/users/me/usage
  fastify.get('/me/usage', async (request, reply) => {
    const { id: userId, tier } = request.user

    const remaining = await getRemainingQuota(userId, tier)
    const usedToday = tier === 'free' ? 10 - remaining : null

    return reply.send({
      plan: tier,
      limit_today: tier === 'free' ? 10 : null,
      used_today: usedToday,
      remaining_today: tier === 'free' ? remaining : null,
    })
  })
}
