import type { FastifyReply } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { IS_DEV } from '../config/main-config.ts';
import { t, DEFAULT_LANG, isSupportedLang, type Lang } from '../lib/i18n/index.ts';

/**
 * Resolve the language to use when localising the outbound error message.
 *
 * Order: explicit override > request.lang (populated by the global preHandler) >
 * DEFAULT_LANG. Errors that fire BEFORE the preHandler runs (rare — Fastify's
 * onRequest level) gracefully degrade to the default language.
 */
const resolveOutboundLang = (reply: FastifyReply, override?: Lang): Lang => {
  if (override && isSupportedLang(override)) return override;
  const requestLang = (reply.request as { lang?: unknown } | undefined)?.lang;
  if (isSupportedLang(requestLang)) return requestLang;
  return DEFAULT_LANG;
};

interface ErrorContext {
  [key: string]: unknown;
}

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: string;
    stack?: string;
  };
  data: null;
  timestamp?: string;
}

/**
 * Main error handler - logs to database and returns standardized error response
 */
export const handleError = async (
  reply: FastifyReply,
  statusCode: number,
  message: string,
  errorCode: string,
  originalError: Error | null = null,
  context: ErrorContext | null = null,
  lang?: Lang
): Promise<FastifyReply> => {
  try {
    const request = reply.request;
    const userId = (request as { user?: { id: string } }).user?.id || null;

    // Translate the user-facing message via the JSON tables. The original
    // English string acts as a hard fallback if the translation lookup misses
    // (which preserves the byte-for-byte messages the existing 96 tests assert).
    const outboundLang = resolveOutboundLang(reply, lang);
    const translationKey = `errors.${errorCode}`;
    const translated = t(translationKey, outboundLang);
    const outboundMessage = translated === translationKey ? message : translated;

    // Fastify with the configured numeric trustProxy already resolves
    // request.ip from X-Forwarded-For. We trust that and skip the
    // string|string[]|undefined header gymnastics.
    const requestInfo = {
      method: request.method,
      path: request.url,
      userAgent: request.headers['user-agent'] || null,
      ip: request.ip || request.socket?.remoteAddress || null,
    };

    // Prepare error log data
    const errorLogData = {
      errorCode,
      message,
      statusCode,
      stack: originalError?.stack || null,
      context: context ? JSON.stringify(context) : null,
      userId,
      ...requestInfo,
    };

    // Log to database (non-blocking)
    prismaQuery.errorLog
      .create({ data: errorLogData })
      .catch((dbError: unknown) => {
        console.error('Failed to log error to database:', dbError);
      });

    // Log to console for development
    console.error(`[${errorCode}] ${message}`, {
      statusCode,
      userId,
      path: requestInfo.path,
      method: requestInfo.method,
      originalError: originalError?.message,
      stack: originalError?.stack,
    });

    // Send standardized error response
    const response: ErrorResponse = {
      success: false,
      error: {
        code: errorCode,
        message: outboundMessage,
        ...(IS_DEV &&
          originalError && {
            details: originalError.message,
            stack: originalError.stack,
          }),
      },
      data: null,
      timestamp: new Date().toISOString(),
    };

    return reply.code(statusCode).send(response);
  } catch (handlerError) {
    console.error('Error in error handler:', handlerError);

    // Fallback response if error handler fails
    return reply.code(statusCode).send({
      success: false,
      error: {
        code: errorCode,
        message,
      },
      data: null,
    });
  }
};

/**
 * Handle validation errors (missing/invalid fields)
 */
export const handleValidationError = (reply: FastifyReply, missingFields: string[]): Promise<FastifyReply> => {
  return handleError(reply, 400, `Missing required fields: ${missingFields.join(', ')}`, 'VALIDATION_ERROR', null, {
    missingFields,
  });
};

/**
 * Handle resource not found errors
 */
export const handleNotFoundError = (reply: FastifyReply, resource: string): Promise<FastifyReply> => {
  return handleError(reply, 404, `${resource} not found`, 'NOT_FOUND', null, { resource });
};

/**
 * Handle unauthorized errors (401)
 */
export const handleUnauthorizedError = (reply: FastifyReply, reason: string = 'Unauthorized'): Promise<FastifyReply> => {
  return handleError(reply, 401, reason, 'UNAUTHORIZED');
};

/**
 * Handle forbidden errors (403)
 */
export const handleForbiddenError = (reply: FastifyReply, reason: string = 'Forbidden'): Promise<FastifyReply> => {
  return handleError(reply, 403, reason, 'FORBIDDEN');
};

/**
 * Handle database errors
 */
export const handleDatabaseError = (
  reply: FastifyReply,
  operation: string,
  originalError: Error
): Promise<FastifyReply> => {
  return handleError(reply, 500, `Database error during ${operation}`, 'DATABASE_ERROR', originalError, { operation });
};

/**
 * Handle internal server errors
 */
export const handleServerError = (reply: FastifyReply, originalError: Error): Promise<FastifyReply> => {
  return handleError(reply, 500, 'Internal server error', 'INTERNAL_ERROR', originalError);
};
