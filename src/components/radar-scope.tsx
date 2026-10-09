'use client';

import { useEffect, useRef } from 'react';
import { ARENA, type RoomState } from '@/lib/protocol';

const COLORS = { azure: '#5fd4ff', ember: '#ff5a6e' } as const;

/**
 * Top-down tactical radar, drawn straight to a canvas every frame. Shows the
 * towers and gun stations, your team, and enemies your side has detected
 * (defender radar around crewed stations, or a jet's own sensors).
 */
export function RadarScope({ readState, readSelfId }: { readState: () => RoomState | null; readSelfId: () => string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let frame = 0;
    const width = canvas.width;
    const height = canvas.height;
    const pad = 8;
    const scale = Math.min((width - pad * 2) / (ARENA.halfWidth * 2), (height - pad * 2) / (ARENA.halfDepth * 2));
    const toX = (x: number) => width / 2 + x * scale;
    const toY = (z: number) => height / 2 + z * scale;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const state = readState();
      context.clearRect(0, 0, width, height);
      context.fillStyle = 'rgba(4, 12, 20, .78)';
      context.fillRect(0, 0, width, height);
      // Stadium outline and centre line.
      context.strokeStyle = 'rgba(150, 210, 235, .35)';
      context.lineWidth = 1;
      context.beginPath();
      context.ellipse(width / 2, height / 2, ARENA.halfWidth * scale, ARENA.halfDepth * scale, 0, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([3, 4]);
      context.beginPath(); context.moveTo(width / 2, pad); context.lineTo(width / 2, height - pad); context.stroke();
      context.setLineDash([]);
      // Sweep.
      const sweep = (now / 1_400) % (Math.PI * 2);
      const gradient = context.createConicGradient(sweep, width / 2, height / 2);
      gradient.addColorStop(0, 'rgba(120, 230, 255, .16)');
      gradient.addColorStop(.12, 'rgba(120, 230, 255, 0)');
      gradient.addColorStop(1, 'rgba(120, 230, 255, 0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
      if (!state) return;
      const selfId = readSelfId();
      const self = state.players.find((player) => player.id === selfId);
      const myTeam = self?.team ?? 'azure';

      for (const station of state.stations) {
        context.fillStyle = station.occupantId ? COLORS[station.team] : 'rgba(200, 220, 230, .35)';
        context.fillRect(toX(station.x) - 1.5, toY(station.z) - 1.5, 3, 3);
      }
      context.font = '700 9px Rajdhani, Arial, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const tower of state.towers) {
        const x = toX(tower.x); const y = toY(tower.z);
        const health = tower.hp / tower.maxHp;
        context.strokeStyle = tower.hp > 0 ? COLORS[tower.team] : 'rgba(160, 160, 160, .6)';
        context.fillStyle = tower.hp > 0 ? `rgba(${tower.team === 'azure' ? '60, 170, 230' : '230, 60, 80'}, ${.25 + health * .5})` : 'rgba(40, 40, 40, .7)';
        context.beginPath(); context.arc(x, y, 6, 0, Math.PI * 2); context.fill(); context.stroke();
        context.fillStyle = '#f2fbff';
        context.fillText(tower.label[0], x, y + .5);
      }
      for (const player of state.players) {
        if (!player.alive) continue;
        const friendly = player.team === myTeam;
        if (!friendly && !player.spotted) continue;
        const x = toX(player.x); const y = toY(player.z);
        context.fillStyle = COLORS[player.team];
        if (player.role === 'ground') {
          context.fillRect(x - 3, y - 3, 6, 6);
          continue;
        }
        // A jet: an arrow along its heading. Screen +x is world +x, screen +y is world +z.
        const dx = Math.sin(player.yaw); const dy = Math.cos(player.yaw);
        const size = player.id === selfId ? 6 : 4.5;
        context.beginPath();
        context.moveTo(x + dx * size, y + dy * size);
        context.lineTo(x - dx * size * .6 - dy * size * .55, y - dy * size * .6 + dx * size * .55);
        context.lineTo(x - dx * size * .6 + dy * size * .55, y - dy * size * .6 - dx * size * .55);
        context.closePath();
        context.fill();
        if (player.id === selfId) { context.strokeStyle = '#ffffff'; context.lineWidth = 1.2; context.stroke(); context.lineWidth = 1; }
      }
      // Defenders lose their long-range picture with the Radar Tower.
      const radar = state.towers.find((tower) => tower.kind === 'radar');
      if (self && radar && radar.team === self.team && radar.hp <= 0) {
        context.fillStyle = 'rgba(255, 110, 100, .9)';
        context.fillText('RADAR TOWER DOWN', width / 2, 12);
      }
      if (self && !self.alive) {
        context.fillStyle = 'rgba(255, 255, 255, .7)';
        context.fillText('SPECTATING', width / 2, height - 10);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [readState, readSelfId]);

  return <div className="radar-scope" aria-label="Tactical radar"><span>RADAR</span><canvas ref={canvasRef} width={208} height={164} /></div>;
}
