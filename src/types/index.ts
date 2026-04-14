// Shared domain types for Simple Todo AI backend

export type SubscriptionTier = 'free' | 'pro'

export type TaskPriority = 'high' | 'medium' | 'low'

export type TaskCategory = 'work' | 'life' | 'study'

export interface ParsedTask {
  title: string
  due_date: string | null  // ISO8601 or null
  priority: TaskPriority
  category: TaskCategory
}

export interface QuotaResult {
  allowed: boolean
  remaining: number
  usedToday: number
  limitToday: number
}

export interface JwtPayload {
  sub: string            // user id (UUID)
  tier: SubscriptionTier
  email?: string
  iat?: number
  exp?: number
}

export interface AuthenticatedUser {
  id: string
  tier: SubscriptionTier
  email?: string
}

// Augment Fastify request with authenticated user
declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser
  }
}
