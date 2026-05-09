import { DurableObject } from "cloudflare:workers";
import { apiPreflight, handleApiRequest, sha256Hex } from "./api";
import type { Env } from "./env";
import {
	DAMAGE_COOLDOWN_MS,
	MAX_BOT_KILL_EVENTS_PER_SEC,
	MAX_DAMAGE_EVENTS_PER_SEC,
	MAX_JSON_BYTES,
	MAX_MESSAGES_PER_SEC,
	RESPAWN_COOLDOWN_MS,
  sanitizeAnim,
  sanitizeBloodCount,
  sanitizeDamage,
  MAX_USERNAME_LEN,
  sanitizeQuat,
  sanitizeSlot,
  sanitizeSoundName,
  sanitizeUsername,
  sanitizeVec3,
  sanitizeViewYaw,
	sanitizeViewPitch,
	sanitizeVolume,
	sanitizeWeapon,
	isValidPlayerId,
	MAX_BULLET_DIST,
	FIRE_WINDOW_MS,
} from "./validation";

export type { Env } from "./env";

type PlayerRecord = {
	id: string;
	username: string;
	pos: { x: number; y: number; z: number };
	quat: { x: number; y: number; z: number; w: number };
	viewYaw: number;
	viewPitch: number;
	kills: number;
	botKills: number;
	anim: string;
	slot: number;
	atMenu: boolean;
	health: number;
	maxHealth: number;
	lastUpdate: number;
	lastFireAt: number;
	lastDamageWeapon?: string;
	lastRespawnAt?: number;
};

type BotRecord = {
	id: string;
	health: number;
	maxHealth: number;
	pos: { x: number; y: number; z: number };
	lastRespawnAt: number;
};

function playerPublic(p: PlayerRecord): Record<string, unknown> {
	return {
		id: p.id,
		username: p.username,
		pos: p.pos,
		quat: p.quat,
		viewYaw: p.viewYaw,
		viewPitch: p.viewPitch,
		kills: p.kills,
		botKills: p.botKills,
		anim: p.anim,
		slot: p.slot,
		atMenu: p.atMenu,
		health: p.health,
		maxHealth: p.maxHealth,
		lastUpdate: p.lastUpdate,
	};
}

/**
 * Worker Entry Point
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/analytics") {
			const password = env.ANALYTICS_PASSWORD || "HannahNoah07*";
			const provided = url.searchParams.get("p");
			if (provided !== password) {
				return new Response("Unauthorized", { status: 401 });
			}

			// Get global DB stats
			const globalStats = await env.DB.prepare(`
				SELECT 
					COUNT(*) as total_players,
					SUM(total_kills) as total_kills,
					SUM(total_play_time_ms) as total_play_time_ms,
					(SELECT SUM(coins) FROM account_coins) as total_coins,
					(SELECT COUNT(*) FROM accounts WHERE created_at > ?) as new_players_24h
				FROM accounts
			`).bind(Date.now() - 86400000).first<{ 
				total_players: number; 
				total_kills: number; 
				total_play_time_ms: number; 
				total_coins: number;
				new_players_24h: number;
			}>();

			const topKillers = await env.DB.prepare(`
				SELECT username, total_kills 
				FROM accounts 
				WHERE username IS NOT NULL 
				ORDER BY total_kills DESC 
				LIMIT 5
			`).all<{ username: string; total_kills: number }>();

			const topRichest = await env.DB.prepare(`
				SELECT a.username, c.coins 
				FROM accounts a
				JOIN account_coins c ON a.id = c.account_id
				WHERE a.username IS NOT NULL
				ORDER BY c.coins DESC 
				LIMIT 5
			`).all<{ username: string; coins: number }>();

			// Get live room data
			const rooms: Array<{ name: string; count: number; players: Array<{ name: string; kills: number }> }> = [];
			for (let i = 1; i <= 20; i++) {
				const roomName = `room_${i}`;
				const id = env.GAME_ROOM.idFromName(roomName);
				const room = env.GAME_ROOM.get(id);
				try {
					const res = await room.fetch("http://game/analytics-data");
					if (res.ok) {
						const data = await res.json() as { count: number; players: Array<{ name: string; kills: number }> };
						if (data.count > 0) {
							rooms.push({ name: roomName, ...data });
						}
					}
				} catch { /* skip */ }
			}

			const totalLivePlayers = rooms.reduce((acc, r) => acc + r.count, 0);
			const totalSec = Math.floor((globalStats?.total_play_time_ms || 0) / 1000);
			const totalHrs = Math.floor(totalSec / 3600);
			const totalMin = Math.floor((totalSec % 3600) / 60);

			const html = `
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Undersphere // Enterprise Analytics</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@100;300;400;500;600;700;800;900&display=swap');
        :root {
            --background: 0 0% 2%;
            --foreground: 0 0% 98%;
            --card: 0 0% 4%;
            --card-foreground: 0 0% 98%;
            --primary: 0 0% 98%;
            --primary-foreground: 0 0% 9%;
            --secondary: 0 0% 10%;
            --secondary-foreground: 0 0% 98%;
            --muted: 0 0% 12%;
            --muted-foreground: 0 0% 60%;
            --accent: 0 0% 15%;
            --accent-foreground: 0 0% 98%;
            --border: 0 0% 15%;
            --ring: 0 0% 80%;
        }
        body {
            background-color: hsl(var(--background));
            color: hsl(var(--foreground));
            font-family: 'Geist', sans-serif;
            letter-spacing: -0.01em;
        }
        .glass-card {
            background: rgba(10, 10, 10, 0.4);
            backdrop-filter: blur(12px);
            border: 1px solid hsl(var(--border));
            border-radius: 12px;
        }
        .stat-card {
            background-color: hsl(var(--card));
            border: 1px solid hsl(var(--border));
            border-radius: 12px;
            padding: 1.5rem;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .stat-card:hover {
            border-color: hsl(var(--ring));
            transform: translateY(-2px);
        }
        .data-table th {
            font-weight: 500;
            color: hsl(var(--muted-foreground));
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            padding: 1rem 1.5rem;
        }
        .data-table td {
            padding: 1rem 1.5rem;
            border-top: 1px solid hsl(var(--border));
        }
        .badge {
            padding: 2px 8px;
            border-radius: 6px;
            font-size: 0.7rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        .badge-green { background: rgba(34, 197, 94, 0.1); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.2); }
        .badge-blue { background: rgba(59, 130, 246, 0.1); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.2); }
        .chart-wrapper { height: 240px; }
    </style>
</head>
<body class="min-h-screen">
    <!-- Sidebar / Nav Mock -->
    <div class="flex">
        <aside class="w-64 border-r border-border h-screen sticky top-0 p-6 hidden lg:block">
            <div class="flex items-center gap-3 mb-10">
                <div class="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
                    <div class="w-4 h-4 bg-black rounded-sm"></div>
                </div>
                <span class="font-bold text-xl tracking-tighter">UNDERSPHERE</span>
            </div>
            <nav class="space-y-2">
                <a href="#" class="flex items-center gap-3 px-3 py-2 bg-secondary rounded-md text-sm font-medium">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" stroke-width="2"/></svg>
                    Overview
                </a>
                <a href="#" class="flex items-center gap-3 px-3 py-2 text-muted-foreground hover:bg-secondary rounded-md text-sm font-medium transition-colors">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" stroke-width="2"/></svg>
                    Players
                </a>
                <a href="#" class="flex items-center gap-3 px-3 py-2 text-muted-foreground hover:bg-secondary rounded-md text-sm font-medium transition-colors">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" stroke-width="2"/></svg>
                    Economy
                </a>
            </nav>
        </aside>

        <main class="flex-1 p-8 lg:p-12">
            <div class="flex justify-between items-end mb-10">
                <div>
                    <h2 class="text-sm font-medium text-muted-foreground uppercase tracking-widest mb-1">Intelligence Dashboard</h2>
                    <h1 class="text-4xl font-bold tracking-tighter">Executive Overview</h1>
                </div>
                <div class="flex gap-3">
                    <div class="badge badge-green flex items-center gap-2 py-1.5 px-3">
                        <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                        Live: ${totalLivePlayers} Online
                    </div>
                </div>
            </div>

            <!-- Primary Stats -->
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-10">
                <div class="stat-card">
                    <div class="text-muted-foreground text-xs font-semibold uppercase mb-4">Total Ecosystem Value</div>
                    <div class="text-3xl font-bold mb-1">${(globalStats?.total_coins || 0).toLocaleString()}</div>
                    <div class="text-xs text-green-500 font-medium">In-game currency (Coins)</div>
                </div>
                <div class="stat-card">
                    <div class="text-muted-foreground text-xs font-semibold uppercase mb-4">User Acquisition</div>
                    <div class="text-3xl font-bold mb-1">${globalStats?.total_players || 0}</div>
                    <div class="text-xs text-blue-500 font-medium">+${globalStats?.new_players_24h || 0} in last 24h</div>
                </div>
                <div class="stat-card">
                    <div class="text-muted-foreground text-xs font-semibold uppercase mb-4">Total Engagement</div>
                    <div class="text-3xl font-bold mb-1">${totalHrs}h ${totalMin}m</div>
                    <div class="text-xs text-muted-foreground font-medium">Cumulative play time</div>
                </div>
                <div class="stat-card">
                    <div class="text-muted-foreground text-xs font-semibold uppercase mb-4">Combat Throughput</div>
                    <div class="text-3xl font-bold mb-1">${(globalStats?.total_kills || 0).toLocaleString()}</div>
                    <div class="text-xs text-red-500 font-medium">Total PvP eliminations</div>
                </div>
            </div>

            <div class="grid grid-cols-1 xl:grid-cols-3 gap-8 mb-10">
                <!-- Live Distribution -->
                <div class="xl:col-span-2 stat-card">
                    <div class="flex justify-between items-center mb-6">
                        <h3 class="font-bold text-lg">Real-time Room Distribution</h3>
                        <div class="text-xs text-muted-foreground">Load balancing across instances</div>
                    </div>
                    <div class="chart-wrapper">
                        <canvas id="mainChart"></canvas>
                    </div>
                </div>

                <!-- Top Performers -->
                <div class="stat-card">
                    <h3 class="font-bold text-lg mb-6">Top Killers (All Time)</h3>
                    <div class="space-y-5">
                        ${topKillers.results.map((p, i) => `
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-3">
                                    <div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-bold">${i+1}</div>
                                    <span class="font-medium text-sm">${p.username}</span>
                                </div>
                                <span class="text-sm font-bold">${p.total_kills.toLocaleString()}</span>
                            </div>
                        `).join('')}
                    </div>
                    <div class="mt-8 pt-6 border-t border-border">
                        <h3 class="font-bold text-lg mb-6">Richest Players</h3>
                        <div class="space-y-5">
                            ${topRichest.results.map((p, i) => `
                                <div class="flex items-center justify-between">
                                    <div class="flex items-center gap-3">
                                        <div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-bold">${i+1}</div>
                                        <span class="font-medium text-sm">${p.username}</span>
                                    </div>
                                    <span class="text-sm font-bold text-yellow-500">${p.coins.toLocaleString()}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>

            <!-- Active Sessions Table -->
            <div class="stat-card p-0 overflow-hidden">
                <div class="p-6 border-b border-border flex justify-between items-center">
                    <h3 class="font-bold text-lg">Active Match Instances</h3>
                    <div class="badge badge-blue">${rooms.length} Active Rooms</div>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full data-table text-left">
                        <thead>
                            <tr>
                                <th>Instance ID</th>
                                <th>Occupancy</th>
                                <th>Live Roster</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rooms.length === 0 ? '<tr><td colspan="4" class="text-center py-12 text-muted-foreground">No active combat sessions detected.</td></tr>' : rooms.map(r => `
                                <tr>
                                    <td class="font-mono text-xs font-bold">${r.name.toUpperCase()}</td>
                                    <td>
                                        <div class="flex items-center gap-3">
                                            <div class="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden max-w-[100px]">
                                                <div class="h-full bg-white" style="width: ${(r.count/8)*100}%"></div>
                                            </div>
                                            <span class="text-xs font-medium">${r.count}/8</span>
                                        </div>
                                    </td>
                                    <td>
                                        <div class="flex flex-wrap gap-1.5">
                                            ${r.players.map(p => `
                                                <span class="text-[10px] bg-secondary px-2 py-0.5 rounded border border-border">${p.name} (${p.kills})</span>
                                            `).join('')}
                                        </div>
                                    </td>
                                    <td>
                                        <div class="flex items-center gap-2 text-[10px] font-bold text-green-500">
                                            <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                                            STABLE
                                        </div>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </main>
    </div>

    <script>
        const ctx = document.getElementById('mainChart').getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(rooms.map(r => r.name.replace('room_', 'Instance ')))},
                datasets: [{
                    label: 'Player Count',
                    data: ${JSON.stringify(rooms.map(r => r.count))},
                    backgroundColor: '#ffffff',
                    borderRadius: 4,
                    barThickness: 24
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 8,
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#666', font: { size: 10 } }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#666', font: { size: 10 } }
                    }
                }
            }
        });
    </script>
</body>
</html>
			`;

			return new Response(html, { headers: { "Content-Type": "text/html" } });
		}

		if (url.pathname.startsWith("/api/")) {
			if (request.method === "OPTIONS") {
				return apiPreflight(request, env);
			}
			return handleApiRequest(request, env);
		}

		// Sequential Room Filling Logic (max 8 per room)
		let roomToJoin = "room_1";
		for (let i = 1; i <= 100; i++) {
			const roomName = `room_${i}`;
			const id = env.GAME_ROOM.idFromName(roomName);
			const room = env.GAME_ROOM.get(id);
			
			try {
				const countRes = await room.fetch("http://game/player-count");
				const count = parseInt(await countRes.text());
				if (count < 8) {
					roomToJoin = roomName;
					break;
				}
			} catch {
				// If room fails to respond, assume it's new/empty or just join it
				roomToJoin = roomName;
				break;
			}
		}

		const id = env.GAME_ROOM.idFromName(roomToJoin);
		const room = env.GAME_ROOM.get(id);

		// Clone request to add room name header
		const newReq = new Request(request);
		newReq.headers.set("X-Room-Name", roomToJoin);

		return room.fetch(newReq);
	},
};

/**
 * Durable Object: GameRoom
 */
const MATCH_DURATION_MS = 3 * 60 * 1000;
const RESET_DELAY_MS = 10000;

export class GameRoom extends DurableObject<Env> {
	private env: Env;
	private players = new Map<string, PlayerRecord>();
	private bots = new Map<string, BotRecord>();
	private sessions = new Set<WebSocket>();
	private playerSockets = new Map<string, WebSocket>();
	private matchStartTime: number;
	private readonly treeLayout: Array<{ phi: number; theta: number; scale: number }>;
	private readonly initialTrainPhase: number;
	private readonly tentLayout: Array<{ phi: number; theta: number }>;
	private readonly barrierLayout: Array<{ phi: number; theta: number }>;
	/** General inbound rate: timestamps (ms) in the last 1s per player */
	private inboundTs = new Map<string, number[]>();
	/** Damage events per attacker per rolling second */
	private damageTs = new Map<string, number[]>();
	/** Last damage time attacker→target to block burst exploits */
	private lastDamagePairMs = new Map<string, number>();
	private botKillTs = new Map<string, number[]>();
	private joinTimes = new Map<string, number>();
	private accountIds = new Map<string, string>();

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.env = env;
		this.matchStartTime = Date.now();
		this.treeLayout = this.generateTreeLayout(80, 50, 8);
		this.tentLayout = this.generateTentLayout(3, 50, 8);
		this.barrierLayout = this.generateBarrierLayout(6, 50, 8);
		this.initialTrainPhase = Math.random() * Math.PI * 2;
		
		// Initialize bots
		for (let i = 0; i < 12; i++) {
			const id = `bot_${i}`;
			this.bots.set(id, {
				id,
				health: 100,
				maxHealth: 100,
				pos: { x: 0, y: -50, z: 0 },
				lastRespawnAt: 0
			});
		}
	}

	private generateTentLayout(count: number, sphereRadius: number, safeZoneRadius: number) {
		const tents: Array<{ phi: number; theta: number }> = [];
		const spawnPos = { x: 0, y: -sphereRadius, z: 0 };
		const trainPhi = Math.PI / 2;
		const trainHalfWidth = 0.36;

		while (tents.length < count) {
			const phi = Math.random() * Math.PI;
			const theta = Math.random() * Math.PI * 2;
			if (Math.abs(phi - trainPhi) < trainHalfWidth) continue;
			
			const x = sphereRadius * Math.sin(phi) * Math.cos(theta);
			const y = sphereRadius * Math.cos(phi);
			const z = sphereRadius * Math.sin(phi) * Math.sin(theta);
			
			const dx = x - spawnPos.x;
			const dy = y - spawnPos.y;
			const dz = z - spawnPos.z;
			const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
			if (dist < safeZoneRadius) continue;

			tents.push({ phi, theta });
		}
		return tents;
	}

	private generateBarrierLayout(count: number, sphereRadius: number, safeZoneRadius: number) {
		const barriers: Array<{ phi: number; theta: number }> = [];
		const spawnPos = { x: 0, y: -sphereRadius, z: 0 };
		const trainPhi = Math.PI / 2;
		const trainHalfWidth = 0.36;

		while (barriers.length < count) {
			const phi = Math.random() * Math.PI;
			const theta = Math.random() * Math.PI * 2;
			if (Math.abs(phi - trainPhi) < trainHalfWidth) continue;

			const x = sphereRadius * Math.sin(phi) * Math.cos(theta);
			const y = sphereRadius * Math.cos(phi);
			const z = sphereRadius * Math.sin(phi) * Math.sin(theta);

			const dx = x - spawnPos.x;
			const dy = y - spawnPos.y;
			const dz = z - spawnPos.z;
			const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
			if (dist < safeZoneRadius) continue;

			barriers.push({ phi, theta });
		}
		return barriers;
	}

	private getCurrentTrainPhase(): number {
		const speed = 1.0; // Keep in sync with TRAIN_VEHICLE_SPEED in client
		// Use a fixed epoch (Date.now() / 1000) for global synchronization.
		// This ensures the phase is identical for all players and stable across match resets.
		return (this.initialTrainPhase - (Date.now() / 1000) * speed);
	}

	async fetch(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url);
			if (url.pathname === "/player-count") {
				return new Response(this.players.size.toString());
			}

			if (url.pathname === "/analytics-data") {
				const playerList = Array.from(this.players.values())
					.filter(p => !p.atMenu)
					.map(p => ({ name: p.username, kills: p.kills }));
				
				return new Response(JSON.stringify({
					count: playerList.length,
					players: playerList
				}), { headers: { "Content-Type": "application/json" } });
			}

			const roomName = request.headers.get("X-Room-Name") ?? "global";

			const upgradeHeader = request.headers.get("Upgrade");
			if (!upgradeHeader || upgradeHeader !== "websocket") {
				return new Response("Expected Upgrade: websocket", { status: 426 });
			}

			const [client, server] = new WebSocketPair();
			const token = url.searchParams.get("token");
			this.handleSession(server, roomName, token);

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		} catch (err) {
			console.error("GameRoom.fetch failed", err);
			return new Response("Internal error", { status: 500 });
		}
	}

	private allowInbound(playerId: string): boolean {
		const now = Date.now();
		let a = this.inboundTs.get(playerId) ?? [];
		a = a.filter((t) => now - t < 1000);
		if (a.length >= MAX_MESSAGES_PER_SEC) return false;
		a.push(now);
		this.inboundTs.set(playerId, a);
		return true;
	}

	private allowDamage(attackerId: string): boolean {
		const now = Date.now();
		let a = this.damageTs.get(attackerId) ?? [];
		a = a.filter((t) => now - t < 1000);
		if (a.length >= MAX_DAMAGE_EVENTS_PER_SEC) return false;
		a.push(now);
		this.damageTs.set(attackerId, a);
		return true;
	}

	private allowBotKill(playerId: string): boolean {
		const now = Date.now();
		let a = this.botKillTs.get(playerId) ?? [];
		a = a.filter((t) => now - t < 1000);
		if (a.length >= MAX_BOT_KILL_EVENTS_PER_SEC) return false;
		a.push(now);
		this.botKillTs.set(playerId, a);
		return true;
	}

	private cleanupRateState(playerId: string) {
		this.inboundTs.delete(playerId);
		this.damageTs.delete(playerId);
		this.botKillTs.delete(playerId);
		for (const k of [...this.lastDamagePairMs.keys()]) {
			if (k.startsWith(`${playerId}:`) || k.endsWith(`:${playerId}`)) {
				this.lastDamagePairMs.delete(k);
			}
		}
	}

	private isUsernameTaken(name: string, excludePlayerId: string): boolean {
		const key = name.toLowerCase();
		for (const [id, rec] of this.players) {
			if (id === excludePlayerId) continue;
			if (rec.username.toLowerCase() === key) return true;
		}
		return false;
	}

	/** Random unused `Player_XXX` with XXX in 001–999 (3 digits, no shared prefix + _2). */
	private pickUnusedPlayerTag(excludePlayerId: string): string {
		const used = new Set<number>();
		for (const [id, rec] of this.players) {
			if (id === excludePlayerId) continue;
			const m = rec.username.match(/^Player_(\d{3})$/i);
			if (m) used.add(parseInt(m[1]!, 10));
		}
		const pool: number[] = [];
		for (let n = 1; n <= 999; n++) {
			if (!used.has(n)) pool.push(n);
		}
		if (pool.length === 0) return this.emergencyUsername(excludePlayerId);
		const pick = pool[Math.floor(Math.random() * pool.length)]!;
		return `Player_${pick.toString().padStart(3, "0")}`;
	}

	private emergencyUsername(excludePlayerId: string): string {
		const slug = excludePlayerId.replace(/-/g, "").slice(0, 12);
		let fallback = `P_${slug}`.slice(0, MAX_USERNAME_LEN);
		if (!this.isUsernameTaken(fallback, excludePlayerId)) return fallback;
		for (let n = 2; n < 100; n++) {
			const suffix = `_${n}`;
			fallback = (`P_${slug}`).slice(0, MAX_USERNAME_LEN - suffix.length) + suffix;
			if (!this.isUsernameTaken(fallback, excludePlayerId)) return fallback;
		}
		return excludePlayerId.slice(0, MAX_USERNAME_LEN);
	}

	/**
	 * Case-insensitive uniqueness. `Player_<any digits>` collisions get a new free 3-digit tag,
	 * not `Player_1234_2`. Custom names still use numeric suffixes.
	 */
	private uniqueUsername(desired: string, excludePlayerId: string): string {
		let base = desired.trim().slice(0, MAX_USERNAME_LEN);
		if (!base) base = "Player";
		if (!this.isUsernameTaken(base, excludePlayerId)) return base;
		if (/^Player_\d+$/i.test(base)) {
			return this.pickUnusedPlayerTag(excludePlayerId);
		}
		for (let n = 2; n <= 9999; n++) {
			const suffix = `_${n}`;
			const maxBase = MAX_USERNAME_LEN - suffix.length;
			if (maxBase < 1) break;
			const candidate = base.slice(0, maxBase) + suffix;
			if (!this.isUsernameTaken(candidate, excludePlayerId)) return candidate;
		}
		return this.emergencyUsername(excludePlayerId);
	}

	handleSession(ws: WebSocket, roomName: string, token: string | null) {
		const playerId = crypto.randomUUID();
		this.sessions.add(ws);
		this.playerSockets.set(playerId, ws);
		this.joinTimes.set(playerId, Date.now());

		if (token) {
			void (async () => {
				const hash = await sha256Hex(token);
				const row = await this.env.DB.prepare("SELECT id FROM accounts WHERE token_hash = ? LIMIT 1").bind(hash).first<{ id: string }>();
				if (row) {
					this.accountIds.set(playerId, row.id);
				}
			})();
		}

		ws.accept();

		void this.sendDiscordNotification(
			"🎮 Player Joined",
			`A new player has entered the sphere.`,
			0x44ff44,
			[
				{ name: "Player ID", value: `\`${playerId.slice(0, 8)}\``, inline: true },
				{ name: "Room", value: `\`${roomName}\``, inline: true },
				{ name: "Players in Room", value: `\`${this.players.size}/8\``, inline: true }
			]
		);

		ws.addEventListener("error", (e) => {
			console.error("WebSocket error", playerId, e);
		});

		const initial: PlayerRecord = {
			id: playerId,
			username: this.pickUnusedPlayerTag(playerId),
			pos: { x: 0, y: 0, z: 0 },
			quat: { x: 0, y: 0, z: 0, w: 1 },
			viewYaw: 0,
			viewPitch: 0,
			kills: 0,
			botKills: 0,
			anim: "idle",
			slot: 0,
			atMenu: true,
			health: 100,
			maxHealth: 100,
			lastUpdate: Date.now(),
			lastFireAt: 0,
		};
		this.players.set(playerId, initial);

		void this.sendDiscordNotification(
			"🎮 Player Joined",
			`A new player has entered the sphere.`,
			0x44ff44,
			[
				{ name: "Player ID", value: `\`${playerId.slice(0, 8)}\``, inline: true },
				{ name: "Room", value: `\`${roomName}\``, inline: true },
				{ name: "Players in Room", value: `\`${this.players.size}/8\``, inline: true }
			]
		);

		// If this is the 2nd player, start the match timer now for PvP
		if (this.players.size === 2) {
			this.matchStartTime = Date.now();
			// Broadcast the new start time to everyone already in
			this.broadcast({
				type: "match_start",
				matchStartTime: this.matchStartTime
			});
		}

		try {
			ws.send(JSON.stringify({
				type: "init",
				playerId,
				roomId: roomName,
				players: Array.from(this.players.entries()).map(([id, p]) => [id, playerPublic(p)]),
				matchStartTime: this.matchStartTime,
				treeLayout: this.treeLayout,
				tentLayout: this.tentLayout,
				barrierLayout: this.barrierLayout,
				trainPhase: this.getCurrentTrainPhase(),
			}));
		} catch (err) {
			console.error("init send failed", playerId, err);
			try {
				ws.close();
			} catch {
				/* noop */
			}
			return;
		}

		ws.addEventListener("message", (msg) => {
			try {
				const raw = msg.data;
				const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
				if (text.length > MAX_JSON_BYTES) return;
				const data = JSON.parse(text) as unknown;
				this.handleMessage(playerId, data, ws);
			} catch {
				// ignore malformed
			}
		});

		ws.addEventListener("close", () => {
			const p = this.players.get(playerId);
			const username = p?.username ?? "Unknown";
			const joinTime = this.joinTimes.get(playerId) ?? Date.now();
			const durationMs = Date.now() - joinTime;
			const durationSec = Math.floor(durationMs / 1000);
			const durationStr = durationSec > 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`;

			const accountId = this.accountIds.get(playerId);
			if (accountId && p) {
				void this.env.DB.prepare(`
					UPDATE accounts 
					SET total_kills = total_kills + ?, 
					    total_play_time_ms = total_play_time_ms + ?,
					    username = ?
					WHERE id = ?
				`).bind(p.kills, durationMs, p.username, accountId).run();
			}

		void this.sendDiscordNotification(
			"👋 Player Left",
			`A player has exited the sphere.`,
			0xff4444,
			[
				{ name: "Username", value: `\`${username}\``, inline: true },
				{ name: "Play Time", value: `\`${durationStr}\``, inline: true },
				{ name: "Players Remaining", value: `\`${this.players.size - 1}/8\``, inline: true }
			]
		);

		this.players.delete(playerId);
			this.sessions.delete(ws);
			this.playerSockets.delete(playerId);
			this.joinTimes.delete(playerId);
			this.accountIds.delete(playerId);
			this.cleanupRateState(playerId);
			this.broadcast({
				type: "player_left",
				playerId
			});
		});
	}

	handleMessage(playerId: string, data: unknown, ws: WebSocket) {
		try {
			this.checkMatchLifecycle();
			if (!this.allowInbound(playerId)) return;
			if (Math.random() < 0.05) this.pruneStalePlayers();

			if (!data || typeof data !== "object") return;
			const d = data as Record<string, unknown>;
			const type = d.type;
			if (typeof type !== "string") return;

			switch (type) {
				case "move":
					this.handleMove(playerId, d, ws);
					break;
				case "damage":
					this.handleDamage(playerId, d);
					break;
				case "blood":
					this.handleBlood(playerId, d, ws);
					break;
				case "sound":
					this.handleSound(playerId, d, ws);
					break;
				case "respawn":
					this.handleRespawn(playerId);
					break;
				case "local_death":
					this.handleLocalSimDeath(playerId);
					break;
				default:
					return;
			}
		} catch (err) {
			console.error("handleMessage error", playerId, err);
		}
	}

	private handleMove(playerId: string, d: Record<string, unknown>, ws: WebSocket) {
		const p = this.players.get(playerId);
		if (!p) return;

		const pos = sanitizeVec3(d.pos);
		const quat = sanitizeQuat(d.quat);
		if (!pos || !quat) return;

		const uname = sanitizeUsername(d.username);
		if (uname) {
			const resolved = this.uniqueUsername(uname, playerId);
			if (resolved !== uname) {
				try {
					ws.send(JSON.stringify({ type: "username_sync", username: resolved }));
				} catch {
					/* noop */
				}
			}
			p.username = resolved;
		}

		p.pos = pos;
		p.quat = quat;
		p.viewYaw = sanitizeViewYaw(d.viewYaw);
		p.viewPitch = sanitizeViewPitch(d.viewPitch);
		p.anim = sanitizeAnim(d.anim);
		if (p.anim === "firing") {
			p.lastFireAt = Date.now();
		}
		p.slot = sanitizeSlot(d.slot);
		p.atMenu = !!d.atMenu;
		p.lastUpdate = Date.now();

		this.broadcast({
			type: "player_moved",
			playerId,
			pos: p.pos,
			quat: p.quat,
			viewYaw: p.viewYaw,
			viewPitch: p.viewPitch,
			username: p.username,
			kills: p.kills,
			botKills: p.botKills,
			anim: p.anim,
			slot: p.slot,
			atMenu: p.atMenu,
		}, ws);
	}

	private handleDamage(attackerId: string, d: Record<string, unknown>) {
		const targetId = String(d.targetId);
		if (targetId === attackerId) return;

		const attacker = this.players.get(attackerId);
		if (!attacker) return;

		// 1. Fire Window Check
		const now = Date.now();
		const timeSinceFire = now - attacker.lastFireAt;
		// Special case: Grenades/Melee might not have an "anim: firing" at the exact moment
		// but for Undersphere, shots are frequent. We allow a 1.2s window.
		if (timeSinceFire > FIRE_WINDOW_MS) {
			return; // Reject damage if attacker hasn't "fired" recently
		}

		const dmg = sanitizeDamage(d.damage);
		if (dmg <= 0) return;

		if (!this.allowDamage(attackerId)) return;

		const pairKey = `${attackerId}:${targetId}`;
		const last = this.lastDamagePairMs.get(pairKey) ?? 0;
		if (now - last < DAMAGE_COOLDOWN_MS) return;
		this.lastDamagePairMs.set(pairKey, now);

		const isBot = targetId.startsWith("bot_");
		let prevHealth = 0;
		let nextHealth = 0;
		let maxHealth = 100;
		let username = "Unknown";

		if (isBot) {
			const bot = this.bots.get(targetId);
			if (!bot) return;
			prevHealth = bot.health;
			nextHealth = Math.max(0, prevHealth - dmg);
			bot.health = nextHealth;
			maxHealth = bot.maxHealth;
			const botIdx = parseInt(targetId.split("_")[1] || "0");
			username = `BOT-${String(botIdx + 1).padStart(2, '0')}`;
			// If bot was killed, we'll respawn it in a bit (client usually handles, but we track health)
			if (nextHealth <= 0 && prevHealth > 0) {
				bot.lastRespawnAt = now;
				// Auto-respawn bot health after 5s so it can be killed again authoritative-ly
				setTimeout(() => {
					bot.health = bot.maxHealth;
				}, 5000);
			}
		} else {
			const target = this.players.get(targetId);
			if (!target) return;
			
			// 2. Distance Check (PvP only)
			const distSq = Math.pow(attacker.pos.x - target.pos.x, 2) + 
			               Math.pow(attacker.pos.y - target.pos.y, 2) + 
						   Math.pow(attacker.pos.z - target.pos.z, 2);
			if (distSq > MAX_BULLET_DIST * MAX_BULLET_DIST) {
				return; // Target too far
			}

			prevHealth = target.health;
			nextHealth = Math.max(0, prevHealth - dmg);
			target.health = nextHealth;
			target.lastDamageWeapon = sanitizeWeapon(d.weapon);
			target.lastUpdate = now;
			maxHealth = target.maxHealth;
			username = target.username;
		}

		let incoming: { x: number; y: number; z: number } | undefined;
		if (d.incoming && typeof d.incoming === "object") {
			const inc = d.incoming as Record<string, unknown>;
			const v = sanitizeVec3({ x: inc.x, y: inc.y, z: inc.z });
			if (v) incoming = v;
		}

		this.broadcast({
			type: "player_damaged",
			attackerId,
			targetId,
			damage: dmg,
			health: nextHealth,
			maxHealth: maxHealth,
			...(incoming ? { incoming } : {}),
		});

		if (nextHealth <= 0 && prevHealth > 0) {
			const weapon = sanitizeWeapon(d.weapon) || "unknown";
			const victimName = username;

			if (isBot) {
				attacker.botKills += 1;
				attacker.lastUpdate = now;
				this.broadcast({
					type: "player_killed",
					attackerId,
					targetId,
					killerName: attacker.username,
					victimName,
					weapon,
					killerKills: attacker.kills,
					killerBotKills: attacker.botKills,
					...(incoming ? { deathIncoming: incoming } : {}),
				});
				// Sync updated stats
				this.broadcast({
					type: "player_stats",
					playerId: attackerId,
					kills: attacker.kills,
					botKills: attacker.botKills,
				});
			} else {
				attacker.kills += 1;
				attacker.lastUpdate = now;
				this.broadcast({
					type: "player_killed",
					attackerId,
					targetId,
					killerName: attacker.username,
					victimName,
					weapon,
					killerKills: attacker.kills,
					killerBotKills: attacker.botKills,
					...(incoming ? { deathIncoming: incoming } : {}),
				});
			}
		}
	}

	private handleBlood(_playerId: string, d: Record<string, unknown>, ws: WebSocket) {
		const point = sanitizeVec3(d.point);
		const dir = sanitizeVec3(d.dir);
		if (!point || !dir) return;
		const count = sanitizeBloodCount(d.count);
		this.broadcast({
			type: "blood_spawn",
			point,
			dir,
			count,
		}, ws);
	}

	private handleSound(_playerId: string, d: Record<string, unknown>, ws: WebSocket) {
		const sound = sanitizeSoundName(d.sound);
		if (!sound) return;
		const pos = sanitizeVec3(d.pos);
		if (!pos) return;
		const volume = sanitizeVolume(d.volume);
		this.broadcast({
			type: "sound_play",
			sound,
			pos,
			volume,
		}, ws);
	}

	/**
	 * Client-side bot damage does not go through `damage`; keep server health in sync so respawn works.
	 */
	private handleLocalSimDeath(playerId: string) {
		const me = this.players.get(playerId);
		if (!me) return;
		if (me.health <= 0) return;
		me.health = 0;
		me.lastUpdate = Date.now();
		this.players.set(playerId, me);
	}

	private handleRespawn(playerId: string) {
		const me = this.players.get(playerId);
		if (!me) return;
		if (me.health > 0) return;

		const now = Date.now();
		if (now - (me.lastRespawnAt ?? 0) < RESPAWN_COOLDOWN_MS) return;
		me.lastRespawnAt = now;

		me.health = me.maxHealth;
		const radius = 50 - 0.9;
		const phi = Math.PI - Math.random() * 0.9;
		const theta = Math.random() * Math.PI * 2;
		const x = radius * Math.sin(phi) * Math.cos(theta);
		const y = radius * Math.cos(phi);
		const z = radius * Math.sin(phi) * Math.sin(theta);
		me.pos = { x, y, z };
		me.lastUpdate = now;
		this.players.set(playerId, me);

		this.broadcast({
			type: "player_respawn",
			playerId,
			health: me.health,
			maxHealth: me.maxHealth,
			pos: me.pos
		});
	}

	private checkMatchLifecycle() {
		if (this.matchStartTime <= 0) return;
		const elapsed = Date.now() - this.matchStartTime;
		if (elapsed > MATCH_DURATION_MS + RESET_DELAY_MS) {
			this.resetMatch();
		}
	}

	private resetMatch() {
		this.matchStartTime = 0;
		for (const p of this.players.values()) {
			p.kills = 0;
			p.botKills = 0;
			p.health = 100;
			p.atMenu = true;
		}
		this.broadcast({
			type: "match_reset",
			matchStartTime: 0
		});
	}

	private pruneStalePlayers() {
		const now = Date.now();
		const timeout = 60000;
		for (const [id, p] of this.players.entries()) {
			if (now - p.lastUpdate > timeout) {
				const sock = this.playerSockets.get(id);
				if (sock) {
					try { sock.close(); } catch { /* noop */ }
					this.sessions.delete(sock);
				}
				this.players.delete(id);
				this.playerSockets.delete(id);
				this.cleanupRateState(id);
				this.broadcast({ type: "player_left", playerId: id });
			}
		}
	}

	broadcast(message: Record<string, unknown>, exclude?: WebSocket) {
		let data: string;
		try {
			data = JSON.stringify(message);
		} catch (err) {
			console.error("broadcast stringify failed", err);
			return;
		}
		for (const session of [...this.sessions]) {
			if (session === exclude) continue;
			try {
				session.send(data);
			} catch (err) {
				console.warn("broadcast send failed, closing socket", err);
				this.sessions.delete(session);
				for (const [pid, sock] of [...this.playerSockets.entries()]) {
					if (sock === session) {
						this.playerSockets.delete(pid);
						break;
					}
				}
				try {
					session.close();
				} catch {
					/* noop */
				}
			}
		}
	}

	private async sendDiscordNotification(title: string, description: string, color: number, fields: { name: string; value: string; inline?: boolean }[]) {
		const url = this.env.DISCORD_WEBHOOK_URL;
		if (!url) return;
		try {
			await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: "Undersphere Logs",
					embeds: [{
						title,
						description,
						color,
						fields,
						timestamp: new Date().toISOString(),
						footer: { text: "Undersphere Match Server" }
					}],
				}),
			});
		} catch (err) {
			console.error("Discord notification failed", err);
		}
	}

	private generateTreeLayout(count: number, sphereRadius: number, safeZoneRadius: number) {
		const trees: Array<{ phi: number; theta: number; scale: number }> = [];
		const spawnPos = { x: 0, y: -sphereRadius, z: 0 };
		/** Keep in sync with client `src/core/Utils.ts` train corridor (xz great circle, phi = π/2). */
		const trainPhi = Math.PI / 2;
		const trainHalfWidth = 0.36;

		while (trees.length < count) {
			const phi = Math.random() * Math.PI;
			const theta = Math.random() * Math.PI * 2;
			if (Math.abs(phi - trainPhi) < trainHalfWidth) continue;
			const x = sphereRadius * Math.sin(phi) * Math.cos(theta);
			const y = sphereRadius * Math.cos(phi);
			const z = sphereRadius * Math.sin(phi) * Math.sin(theta);
			const dx = x - spawnPos.x;
			const dy = y - spawnPos.y;
			const dz = z - spawnPos.z;
			const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
			if (dist < safeZoneRadius) continue;

			trees.push({
				phi,
				theta,
				scale: 1.2 + Math.random() * 2.0,
			});
		}
		return trees;
	}
}
