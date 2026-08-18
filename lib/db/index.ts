import { PrismaClient } from '@/app/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createPrismaClient() {
  // Config form, NOT `new PrismaPg(pool)` (o3d-4ajo) — the same trap the
  // concurrency tests already guard against, which this runtime path never
  // got. The adapter decides between "this is my pool" and "this is my
  // config" with `instanceof pg.Pool`, so a Pool built from a second copy of
  // `pg` fails that check and the adapter treats the Pool OBJECT as its
  // config. It then hands the Pool's own `options` object to postgres as the
  // startup `options` parameter, pg-protocol calls Buffer.byteLength() on it,
  // and it throws ERR_INVALID_ARG_TYPE from the socket connect callback —
  // uncaught, so the request promise never settles. Letting the adapter build
  // its own pool removes the instanceof branch entirely.
  //
  // This is not hypothetical here: the checkout carries a duplicated
  // node_modules/node_modules tree, which is exactly the second `pg` identity
  // that triggers it.
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    max: 20,
  })
  return new PrismaClient({ adapter })
}

export const db = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
