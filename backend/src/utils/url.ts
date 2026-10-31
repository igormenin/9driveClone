import type { Request } from 'express'
import { env } from '../config/env.js'

export function getFrontendUrl(req?: Request): string {
  if (env.FRONTEND_URL && !env.FRONTEND_URL.includes('localhost')) {
    return env.FRONTEND_URL
  }
  if (req) {
    let proto = req.get('x-forwarded-proto') || req.protocol || 'http'
    const host = req.get('x-forwarded-host') || req.get('host')
    if (host) {
      if (host.includes('.zrok.io') || (!host.includes('localhost') && !host.startsWith('127.') && !host.startsWith('192.168.') && !host.startsWith('10.'))) {
        proto = 'https'
      }
      return `${proto}://${host}`
    }
  }
  return env.FRONTEND_URL || 'http://localhost:5173'
}
