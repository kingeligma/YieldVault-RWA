import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export type ApiKeyRole = 'viewer' | 'operator' | 'admin' | 'super-admin';

interface ApiKeyMetadata {
  createdAt: Date;
  rotatedAt?: Date;
  role: ApiKeyRole;
}

const API_KEYS = new Map<string, ApiKeyMetadata>(); // hash -> key metadata

declare global {
  namespace Express {
    interface Request {
      authApiKeyHash?: string;
      authApiKeyRole?: ApiKeyRole;
    }
  }
}

function normalizeRole(role?: string): ApiKeyRole {
  if (role === 'viewer' || role === 'operator' || role === 'admin' || role === 'super-admin') {
    return role;
  }

  return 'admin';
}

export function validateApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.get?.('Authorization') || '';
  const match = authHeader.match(/^ApiKey\s+(.+)$/);

  if (!match) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid API key',
    });
    return;
  }

  const providedKey = match[1];
  const hash = hashApiKey(providedKey);
  const metadata = API_KEYS.get(hash);

  if (!metadata) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key',
    });
    return;
  }

  req.authApiKeyHash = hash;
  req.authApiKeyRole = metadata.role;

  next();
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function registerApiKey(key: string, options: { role?: ApiKeyRole } = {}): string {
  const hash = hashApiKey(key);
  API_KEYS.set(hash, { createdAt: new Date(), role: options.role ?? 'admin' });
  return hash;
}

export function revokeApiKey(hash: string): boolean {
  return API_KEYS.delete(hash);
}

export function authenticateApiKeyValue(key: string): { hash: string; role: ApiKeyRole } | null {
  const hash = hashApiKey(key);
  const metadata = API_KEYS.get(hash);
  if (!metadata) {
    return null;
  }

  return { hash, role: metadata.role };
}

export function getApiKeyMetadata(hash: string): ApiKeyMetadata | null {
  return API_KEYS.get(hash) ?? null;
}

export function restoreApiKey(hash: string, metadata: ApiKeyMetadata): void {
  API_KEYS.set(hash, metadata);
}

export function normalizeApiKeyRole(role?: string): ApiKeyRole | null {
  return role ? normalizeRole(role) : null;
}

export function hasRequiredApiKeyRole(req: Request, requiredRole: ApiKeyRole): boolean {
  const hierarchy: ApiKeyRole[] = ['viewer', 'operator', 'admin', 'super-admin'];
  const current = req.authApiKeyRole ?? 'admin';

  return hierarchy.indexOf(current) >= hierarchy.indexOf(requiredRole);
}

export function rotateApiKey(oldHash: string, newKey: string): string | null {
  const metadata = API_KEYS.get(oldHash);
  if (!metadata) {
    return null;
  }

  API_KEYS.delete(oldHash);

  const newHash = hashApiKey(newKey);
  API_KEYS.set(newHash, {
    createdAt: metadata.createdAt,
    rotatedAt: new Date(),
    role: metadata.role,
  });

  return newHash;
}

export function clearApiKeysForTests(): void {
  API_KEYS.clear();
}
