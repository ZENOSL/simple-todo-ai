/**
 * JWT authentication middleware (Fastify plugin)
 *
 * Validates Bearer token from Authorization header.
 * Attaches decoded payload to request.user.
 *
 * Usage: fastify.addHook('preHandler', authenticate)
 * Or register as a scoped plugin and apply only to protected routes.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import jwt from 'jsonwebtoken'
import type { JwtPayload, AuthenticatedUser } from '../types'

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET environment variable is not set')
  return secret
}

function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  return token.length > 0 ? token : null
}

/**
 * Verify and decode a JWT access token.
 * Throws on invalid/expired token.
 */
export function verifyAccessToken(token: string): JwtPayload {
  const secret = getJwtSecret()
  const decoded = jwt.verify(token, secret) as JwtPayload
  if (!decoded.sub) throw new Error('Token missing subject claim')
  return decoded
}

/**
 * Sign a new access token (short-lived, 15 minutes).
 */
export function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const secret = getJwtSecret()
  return jwt.sign(payload, secret, { expiresIn: '15m' })
}

/**
 * Sign a new refresh token (long-lived, 30 days).
 */
export function signRefreshToken(userId: string): string {
  const secret = process.env.JWT_REFRESH_SECRET ?? getJwtSecret() + '_refresh'
  return jwt.sign({ sub: userId }, secret, { expiresIn: '30d' })
}

/**
 * Fastify preHandler: authenticate incoming request.
 * Rejects with 401 if token is missing or invalid.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = extractBearerToken(request)
  if (!token) {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'Missing or malformed Authorization header',
    })
  }

  try {
    const payload = verifyAccessToken(token)
    request.user = {
      id: payload.sub,
      tier: payload.tier,
      email: payload.email,
    } satisfies AuthenticatedUser
  } catch (err) {
    const isExpired = err instanceof jwt.TokenExpiredError
    return reply.status(401).send({
      error: isExpired ? 'token_expired' : 'unauthorized',
      message: isExpired
        ? 'Access token has expired, please refresh'
        : 'Invalid access token',
    })
  }
}

/**
 * Fastify plugin: decorates the instance with an `authenticate` hook
 * and adds the user property to the request type.
 */
const authPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.decorate('authenticate', authenticate)
}

export default fp(authPlugin, {
  name: 'auth',
  fastify: '4.x',
})
