'use client';

import { useEffect, useRef } from 'react';
import type { RoomState } from '@/lib/protocol';

type AttitudeIndicatorProps = { readState: () => RoomState | null; readSelfId: () => string };

/** Pixels the horizon moves per degree of pitch. */
const PITCH_SCALE = .9;

/**
 * Artificial horizon. It reads the jet's orientation every animation frame
 * and writes the transform straight to the DOM, so it stays smooth while the
 * rest of the HUD re-renders at 10Hz.
 */
export function AttitudeIndicator({ readState, readSelfId }: AttitudeIndicatorProps) {
  const horizonRef = useRef<SVGGElement>(null);
  const bankRef = useRef<SVGGElement>(null);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const jet = readState()?.players.find((player) => player.id === readSelfId());
      if (!jet?.q || !horizonRef.current || !bankRef.current) return;
      const [x, y, z, w] = jet.q;
      // Body forward and up from the quaternion (nose is +Z).
      const fx = 2 * (x * z + y * w); const fy = 2 * (y * z - x * w); const fz = 1 - 2 * (x * x + y * y);
      const ux = 2 * (x * y - z * w); const uy = 1 - 2 * (x * x + z * z); const uz = 2 * (y * z + x * w);
      // Horizon-relative bank: body up measured against the level right axis.
      const rx = -fz; const rz = fx; const rl = Math.hypot(rx, rz) || 1;
      const lux = -(rz / rl) * fy; const luy = (rz / rl) * fx - (rx / rl) * fz; const luz = (rx / rl) * fy;
      const bank = Math.atan2(ux * (rx / rl) + uz * (rz / rl), ux * lux + uy * luy + uz * luz) * 180 / Math.PI;
      const pitch = Math.asin(Math.max(-1, Math.min(1, fy))) * 180 / Math.PI;
      horizonRef.current.setAttribute('transform', `rotate(${-bank} 50 50) translate(0 ${pitch * PITCH_SCALE})`);
      bankRef.current.setAttribute('transform', `rotate(${-bank} 50 50)`);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [readState, readSelfId]);

  return (
    <svg className="attitude-indicator" viewBox="0 0 100 100" role="img" aria-label="Artificial horizon">
      <defs><clipPath id="attitude-clip"><circle cx="50" cy="50" r="46" /></clipPath></defs>
      <g clipPath="url(#attitude-clip)">
        <g ref={horizonRef}>
          <rect x="-100" y="-150" width="300" height="200" className="attitude-sky" />
          <rect x="-100" y="50" width="300" height="200" className="attitude-ground" />
          <line x1="-100" y1="50" x2="200" y2="50" className="attitude-horizon" />
          {[-30, -20, -10, 10, 20, 30].map((degrees) => (
            <line key={degrees} x1={degrees % 20 ? 40 : 34} x2={degrees % 20 ? 60 : 66} y1={50 - degrees * PITCH_SCALE} y2={50 - degrees * PITCH_SCALE} className="attitude-ladder" />
          ))}
        </g>
      </g>
      <g ref={bankRef}><path d="M50 6 l-3.5 -5 h7 z" className="attitude-pointer" /></g>
      <path d="M28 50 h14 l4 5 l4 -5 h14" className="attitude-aircraft" />
      <circle cx="50" cy="50" r="46" className="attitude-bezel" />
    </svg>
  );
}
