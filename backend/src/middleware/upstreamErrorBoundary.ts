import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { CircuitOpenError } from '../circuitBreaker';
import { SorobanSimulationError } from '../sorobanClient';
import { getCurrentTraceId } from '../tracing';
import { logger } from './structuredLogging';

export type UpstreamDependency = 'redis' | 'database' | 'rpc';

export type UpstreamErrorCode =
  | 'REDIS_UNAVAILABLE'
  | 'DATABASE_UNAVAILABLE'
  | 'RPC_CIRCUIT_OPEN'
  | 'RPC_RESTORE_REQUIRED'
  | 'RPC_SIMULATION_FAILED'
  | 'RPC_SUBMISSION_FAILED'
  | 'RPC_UNEXPECTED_FAILURE';

export interface TypedUpstreamError {
  status: number;
  error: 'Bad Gateway' | 'Service Unavailable';
  code: UpstreamErrorCode;
  dependency: UpstreamDependency;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isRedisConnectivityError(err: unknown): boolean {
  const message = getErrorMessage(err).toLowerCase();
  return /econnrefused|econnreset|etimedout|connection is closed|socket closed|read only|readonly|loading|misconf|ehostunreach|enetunreach|epipe|timeout|connection reset|the client is closed/.test(
    message,
  );
}

function isDatabaseConnectivityError(err: unknown): boolean {
  if (isRedisConnectivityError(err)) return false;

  const message = getErrorMessage(err).toLowerCase();
  if (/prisma query timed out|timed out|timeout|connection refused|econnrefused|ehostunreach|enetunreach|connection terminated|connection reset/.test(message)) {
    return true;
  }

  const code = isObjectLike(err) ? err.code : undefined;
  return typeof code === 'string' && ['P1001', 'P1002', 'P2024', 'P2028'].includes(code);
}

export function classifyUpstreamError(err: unknown): TypedUpstreamError | null {
  if (err instanceof CircuitOpenError) {
    return {
      status: 503,
      error: 'Service Unavailable',
      code: 'RPC_CIRCUIT_OPEN',
      dependency: 'rpc',
      message: 'Soroban RPC is temporarily unavailable. Please retry later.',
      retryable: true,
      retryAfterSeconds: Math.max(1, Math.ceil(err.retryAfterMs / 1000)),
    };
  }

  if (err instanceof SorobanSimulationError) {
    switch (err.code) {
      case 'RESTORE_REQUIRED':
        return {
          status: 503,
          error: 'Service Unavailable',
          code: 'RPC_RESTORE_REQUIRED',
          dependency: 'rpc',
          message: 'Soroban state restoration is required. Please retry later.',
          retryable: true,
          retryAfterSeconds: 60,
        };
      case 'SIMULATION_ERROR':
        return {
          status: 502,
          error: 'Bad Gateway',
          code: 'RPC_SIMULATION_FAILED',
          dependency: 'rpc',
          message: 'Soroban RPC simulation failed.',
          retryable: false,
        };
      case 'RPC_ERROR':
        return {
          status: 502,
          error: 'Bad Gateway',
          code: 'RPC_SUBMISSION_FAILED',
          dependency: 'rpc',
          message: 'Soroban RPC rejected the transaction.',
          retryable: false,
        };
      case 'SUBMISSION_FAILED':
      case 'INTERNAL_ERROR':
      default:
        return {
          status: 502,
          error: 'Bad Gateway',
          code: 'RPC_UNEXPECTED_FAILURE',
          dependency: 'rpc',
          message: 'Soroban RPC request failed unexpectedly.',
          retryable: false,
        };
    }
  }

  if (isRedisConnectivityError(err)) {
    return {
      status: 503,
      error: 'Service Unavailable',
      code: 'REDIS_UNAVAILABLE',
      dependency: 'redis',
      message: 'Redis is temporarily unavailable. Please retry later.',
      retryable: true,
      retryAfterSeconds: 5,
    };
  }

  if (isDatabaseConnectivityError(err)) {
    return {
      status: 503,
      error: 'Service Unavailable',
      code: 'DATABASE_UNAVAILABLE',
      dependency: 'database',
      message: 'Database is temporarily unavailable. Please retry later.',
      retryable: true,
      retryAfterSeconds: 5,
    };
  }

  return null;
}

export function sendUpstreamErrorResponse(
  res: Response,
  req: Request,
  err: unknown,
  fallbackMessage = 'An upstream dependency failed',
): boolean {
  const typed = classifyUpstreamError(err);
  if (!typed) return false;

  if (!res.headersSent) {
    if (typed.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(typed.retryAfterSeconds));
    }

    logger.log('error', 'Upstream dependency failure', {
      dependency: typed.dependency,
      code: typed.code,
      retryable: typed.retryable,
      retryAfterSeconds: typed.retryAfterSeconds ?? null,
      traceId: getCurrentTraceId(),
      error: getErrorMessage(err),
      path: req.path,
      method: req.method,
    });

    res.status(typed.status).json({
      error: typed.error,
      status: typed.status,
      code: typed.code,
      dependency: typed.dependency,
      message:
        process.env.NODE_ENV === 'production'
          ? fallbackMessage
          : getErrorMessage(err) || fallbackMessage,
      retryable: typed.retryable,
      retryAfterSeconds: typed.retryAfterSeconds,
      correlationId: (req as Request & { correlationId?: string }).correlationId,
    });
  }

  return true;
}

export function withUpstreamErrorBoundary(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      if (sendUpstreamErrorResponse(res, req, err)) return;
      next(err);
    });
  };
}

export const upstreamErrorBoundary: ErrorRequestHandler = (err, req, res, next) => {
  if (sendUpstreamErrorResponse(res, req, err)) return;
  next(err);
};