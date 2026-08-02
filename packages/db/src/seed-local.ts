import { createPrismaClient } from "./client.js";

const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const LOCAL_USER_ID = "local-demo-user";

const prisma = createPrismaClient();

try {
  const workspace = await prisma.workspace.upsert({
    where: { id: LOCAL_WORKSPACE_ID },
    update: {
      name: "Atoms local workspace",
      deletedAt: null,
    },
    create: {
      id: LOCAL_WORKSPACE_ID,
      name: "Atoms local workspace",
      slug: "atoms-local",
    },
  });
  await prisma.membership.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: LOCAL_USER_ID,
      },
    },
    update: { role: "OWNER" },
    create: {
      workspaceId: workspace.id,
      userId: LOCAL_USER_ID,
      role: "OWNER",
    },
  });
  console.log(
    JSON.stringify({
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      userId: LOCAL_USER_ID,
    }),
  );
} finally {
  await prisma.$disconnect();
}
