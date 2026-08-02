import { PrismaClient } from "../generated/prisma/client.js";

const prisma = new PrismaClient();

await prisma.account.upsert({
  where: { email: "demo@example.test" },
  update: {},
  create: { email: "demo@example.test" },
});

await prisma.$disconnect();
