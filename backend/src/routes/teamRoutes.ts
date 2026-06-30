import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { handleNotFoundError, handleServerError, handleError } from '../utils/errorHandler.ts';
import { isValidTeamCode } from '../utils/curvaValidators.ts';

export const teamRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // GET /teams
  app.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const teams = await prismaQuery.team.findMany({
        orderBy: [{ groupLabel: 'asc' }, { name: 'asc' }],
      });
      return reply.code(200).send({
        success: true,
        error: null,
        data: { teams },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  // GET /teams/:code
  app.get('/:code', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { code } = request.params as { code: string };
      if (!code || typeof code !== 'string') {
        return handleError(reply, 400, 'Invalid team code', 'VALIDATION_ERROR');
      }
      const normalized = code.toUpperCase();
      if (!isValidTeamCode(normalized)) {
        return handleError(reply, 400, 'Team code must be ISO 3 letters (e.g. ARG)', 'VALIDATION_ERROR');
      }
      const team = await prismaQuery.team.findUnique({ where: { code: normalized } });
      if (!team) return handleNotFoundError(reply, 'Team');
      return reply.code(200).send({
        success: true,
        error: null,
        data: { team },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  done();
};
