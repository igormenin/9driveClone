import type { Request } from 'express'
import { env } from '../config/env.js'

export function getFrontendUrl(req?: Request): string {
  if (env.FRONTEND_URL && !env.FRONTEND_URL.includes('localhost')) {
    return env.FRONTEND_URL
  }
  if (req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http'
    const host = req.get('x-forwarded-host') || req.get('host')
    if (host) {
      return `${proto}://${host}`
    }
  }
  return env.FRONTEND_URL || 'http://localhost:5173'
}
