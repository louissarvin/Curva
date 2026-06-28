import type { FastifyReply } from 'fastify';
import { handleError, handleValidationError } from './errorHandler.ts';

/**
 * Validates that all required fields are present on a JSON request body.
 *
 * Returns `true` if everything is present. On failure, sends a standard
 * error-envelope response via `handleError` / `handleValidationError` and
 * returns the reply so callers can `return` and stop processing.
 *
 * The envelope shape (`{ success, error, data, timestamp }`) is documented in
 * backend/CLAUDE.md. Earlier versions of this helper bypassed the envelope
 * with a bespoke `{ statusCode, error, message }` body which broke clients
 * that match on `success === false`.
 */
export const validateRequiredFields = async (
  body: Record<string, unknown> | null | undefined,
  fields: string[],
  reply: FastifyReply
): Promise<true | FastifyReply> => {
  if (!Array.isArray(fields) || fields.length === 0) {
    return handleError(
      reply,
      500,
      'Fields array is empty or undefined',
      'INTERNAL_VALIDATION_MISCONFIGURED'
    );
  }

  if (!body || Object.keys(body).length === 0) {
    return handleError(
      reply,
      400,
      'Request body is empty or undefined',
      'VALIDATION_ERROR',
      null,
      { reason: 'empty_body' }
    );
  }

  const missingParams = fields.reduce<string[]>((acc, field) => {
    return body[field] === undefined || body[field] === null || body[field] === ''
      ? [...acc, field]
      : acc;
  }, []);

  if (missingParams.length > 0) {
    return handleValidationError(reply, missingParams);
  }

  return true;
};
