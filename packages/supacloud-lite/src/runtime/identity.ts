import { ApiError } from './types.js'
import { decodeJwt, type JwtClaims } from './jwt.js'

export type ExternalIdentityVerifier = (request: Request) => Promise<JwtClaims>

/** Structurally compatible with @supacloud/elysia's SupAuthRequestContext. */
export interface VerifiedSupAuthContext {
  identity: { authenticated: true; subject: string; issuer: string; clientId: string }
  access: { projectId: string; tenantId: string; permissions: readonly string[] }
}

/**
 * Bridge an application's createSupAuthRequestContext into Lite's SQL claims.
 * Verification and access remain in the shared adapter/application, not Lite.
 */
export function createSupAuthLiteIdentity(options: {
  context: (request: Request) => Promise<VerifiedSupAuthContext>
  projectId: string
  resolveLocalSubject: (identity: VerifiedSupAuthContext['identity']) => Promise<string | null>
}): ExternalIdentityVerifier {
  if (!options.projectId.trim()) throw new Error('SupAuth Lite projectId is required')
  return async (request) => {
    try {
      const context = await options.context(request)
      const { identity, access } = context
      if (identity.authenticated !== true || !identity.subject || !identity.clientId ||
        new URL(identity.issuer).protocol !== 'https:' ||
        access.projectId !== options.projectId || !access.tenantId ||
        !Array.isArray(access.permissions) || access.permissions.some((value) => typeof value !== 'string' || !value.trim())) {
        throw new ApiError(403, { message: 'Application access denied' })
      }
      const subject = await options.resolveLocalSubject(identity)
      if (!subject || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(subject)) {
        throw new ApiError(403, { message: 'External identity has no local subject mapping' })
      }
      // The context verifier has already authenticated this exact bearer token.
      const bearer = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1]
      const payload = bearer ? decodeJwt(bearer) : null
      if (typeof payload?.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
        throw new ApiError(401, { message: 'External identity expired' })
      }
      return {
        role: 'authenticated', sub: subject, external_sub: identity.subject,
        iss: identity.issuer, client_id: identity.clientId, exp: payload.exp,
        project_id: access.projectId, tenant_id: access.tenantId,
        permissions: [...new Set(access.permissions)],
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      const status = (error as { status?: number })?.status
      throw new ApiError(status === 401 || status === 403 ? status : 503, {
        message: status === 401 ? 'Authentication required' : status === 403 ? 'Application access denied' : 'Identity verification unavailable',
      })
    }
  }
}
