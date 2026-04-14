import { PrismaClient } from '@prisma/client'

declare global {
  // Prevent multiple instances during hot-reload in development
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined
}

export const prisma: PrismaClient =
  global.__prismaClient ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') {
  global.__prismaClient = prisma
}
