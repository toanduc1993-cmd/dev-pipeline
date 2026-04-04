import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.pipelineConfig.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {
      id: 'singleton',
      maxParallelAgents: 1,
      maxRetryRounds: 3,
      taskTimeoutMins: 45,
      qaChunkSize: 5,
      masterMaxTokens: 3000,
      telegramEnabled: false,
    },
  });
  console.log('Seeded PipelineConfig singleton');

  const project = await prisma.project.upsert({
    where: { slug: 'demo-project' },
    update: {},
    create: {
      name: 'Demo Project',
      slug: 'demo-project',
      description: 'A demo project for testing the pipeline',
      repoPath: '/tmp/demo-project',
      language: 'javascript',
    },
  });
  console.log(`Seeded project: ${project.name} (${project.id})`);

  console.log('Seed completed');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
