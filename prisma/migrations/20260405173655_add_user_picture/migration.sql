-- AlterTable
ALTER TABLE "customers" ALTER COLUMN "firstName" DROP DEFAULT,
ALTER COLUMN "lastName" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pictureUrl" TEXT;
