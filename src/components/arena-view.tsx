'use client';

import { useEffect, useRef, useState } from 'react';
import type { RoomState } from '@/lib/protocol';
import { mountArena, type ReadAim, type ReadViewId } from '@/lib/arena3d';

type ArenaViewProps = { readState: () => RoomState | null; readSelfId: () => string; mode?: 'arena' | 'training'; readAim?: ReadAim; readViewId?: ReadViewId };

export function ArenaView({ readState, readSelfId, mode = 'arena', readAim, readViewId }: ArenaViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [sceneStatus, setSceneStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [sceneError, setSceneError] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cleanup: (() => void) | undefined;
    let active = true;
    try {
      cleanup = mountArena(host, readState, readSelfId, mode, (error) => {
        console.error('3D stadium build failed', error);
        if (!active) return;
        setSceneError(error instanceof Error ? error.message : String(error));
        setSceneStatus('error');
      }, readAim, readViewId);
      setSceneStatus('ready');
    } catch (error: unknown) {
      console.error('3D arena failed to start', error);
      setSceneError(error instanceof Error ? error.message : String(error));
      setSceneStatus('error');
    }
    return () => {
      active = false;
      cleanup?.();
    };
  }, [mode, readSelfId, readState, readAim, readViewId]);

  return <div className={`arena-view arena-view-${sceneStatus}`} ref={hostRef} aria-label="Skyforge Stadium 3D view">
    {sceneStatus === 'loading' && <div className="arena-view-state" role="status">INITIALIZING 3D STADIUM</div>}
    {sceneStatus === 'error' && <div className="arena-view-state arena-view-error" role="alert">3D STADIUM ERROR: {sceneError || 'WEBGL INITIALIZATION FAILED'}</div>}
  </div>;
}
