import { GameClient } from '@/components/game-client';
import type { ArenaId, JetModel } from '@/lib/protocol';

type HomePageProps = {
  searchParams: Promise<{ mode?: string | string[]; arena?: string | string[]; model?: string | string[]; pilot?: string | string[]; role?: string | string[] }>;
};

function first(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const isTraining = first(params.mode) === 'training';
  const initialTraining = isTraining ? {
    arenaId: first(params.arena) as ArenaId | undefined,
    model: first(params.model) as JetModel | undefined,
    callsign: first(params.pilot),
    role: first(params.role),
  } : null;

  return <GameClient initialTraining={initialTraining} />;
}
