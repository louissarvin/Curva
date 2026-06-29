import { PrismaClient } from '../../prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { DATABASE_URL } from '../config/main-config.ts';

// Why import from main-config instead of reading process.env directly: keeps
// the "no process.env outside main-config" rule (backend/CLAUDE.md) and
// guarantees the env validation runs before the pool is constructed.
const adapter = new PrismaPg({
  connectionString: DATABASE_URL,
});

export const prismaQuery = new PrismaClient({ adapter });
