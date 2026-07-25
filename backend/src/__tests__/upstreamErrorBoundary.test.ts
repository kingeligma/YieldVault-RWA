import { CircuitOpenError } from '../circuitBreaker';
import { SorobanSimulationError } from '../sorobanClient';

jest.mock('../middleware/structuredLogging', () => ({
  logger: { log: jest.fn() },
}));

jest.mock('../tracing', () => ({
  getCurrentTraceId: () => 'test-trace-id',
}));

import { classifyUpstreamError, sendUpstreamErrorResponse } from '../middleware/upstreamErrorBoundary';

function makeResponse() {
  const res: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined,
    headersSent: false,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
  return res;
}

describe('upstreamErrorBoundary', () => {
  it('classifies Redis connectivity failures as retryable service unavailable errors', () => {
    const typed = classifyUpstreamError(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    expect(typed).toMatchObject({
      status: 503,
      error: 'Service Unavailable',
      code: 'REDIS_UNAVAILABLE',
      dependency: 'redis',
      retryable: true,
    });
    expect(typed?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('classifies Prisma-style database failures as retryable service unavailable errors', () => {
    const err = new Error('Prisma query timed out after 5000ms (Transaction.findMany)');
    const typed = classifyUpstreamError(err);

    expect(typed).toMatchObject({
      status: 503,
      error: 'Service Unavailable',
      code: 'DATABASE_UNAVAILABLE',
      dependency: 'database',
      retryable: true,
    });
  });

  it('classifies circuit open errors with retry-after metadata', () => {
    const typed = classifyUpstreamError(new CircuitOpenError(4100));

    expect(typed).toMatchObject({
      status: 503,
      error: 'Service Unavailable',
      code: 'RPC_CIRCUIT_OPEN',
      dependency: 'rpc',
      retryable: true,
      retryAfterSeconds: 5,
    });
  });

  it('writes a typed JSON response for upstream failures', () => {
    const res = makeResponse();
    const req = { method: 'GET', path: '/api/v1/vault/summary' } as any;

    const handled = sendUpstreamErrorResponse(res, req, new Error('connect ECONNRESET'), 'Failed to fetch summary');

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body).toMatchObject({
      error: 'Service Unavailable',
      status: 503,
      code: 'REDIS_UNAVAILABLE',
      dependency: 'redis',
      retryable: true,
    });
  });

  it('maps Soroban simulation restore requirements to retryable RPC errors', () => {
    const typed = classifyUpstreamError(new SorobanSimulationError('restore required', 'RESTORE_REQUIRED', 503));

    expect(typed).toMatchObject({
      status: 503,
      error: 'Service Unavailable',
      code: 'RPC_RESTORE_REQUIRED',
      dependency: 'rpc',
      retryable: true,
    });
  });
});