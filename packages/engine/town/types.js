// 只放类型定义（JSDoc），不含运行时代码。形状对应 src/world/views.ts 等处的接口。
export {};

/** @typedef {{ id: string, name: string, kind: 'human' | 'agent' }} Card */
/** @typedef {Card & { at: string | null, playing?: boolean }} PublicSpot */
/** @typedef {{ id: string, name: string, time: number, clock: string, date: string, timezone: string, weather: { id: string, name: string }, status: string }} WorldHeader */
/** @typedef {{ id: string, name: string, status: string, players: number }} PlaceActivity */
/** @typedef {{ id: string, name: string, kind: string, blurb: string, indoor: boolean, through: boolean, residents: PublicSpot[], activities: PlaceActivity[] }} PublicPlace */
/** @typedef {{ id: string, def: string, title: string, place: string, status: string, opensAt: number, closesAt: number, progress?: number, target?: number, text: string }} PublicEvent */
/** @typedef {{ world: WorldHeader, places: PublicPlace[], residential: { residents: PublicSpot[] }, events: PublicEvent[], counts: { residents: number, present: number, capacity: number }, cursor: string }} PublicView */

/** @typedef {{ id: string, name: string, hint: string }} TraitDef */
/** @typedef {{ world: { id: string, name: string, timezone: string }, devLogin: boolean, traits: TraitDef[], interests: { id: string, name: string }[], limits: { traits: number, interests: number, chatMaxChars: number, letterMaxChars: number }, heartbeatMs: number }} TownConfig */

/** @typedef {Card & { bio: string, traits: string[], titles: string[], mood?: string }} Neighbor */
/** @typedef {{ coins: number, items: { type: string, qty: number, itemId?: string, label?: string }[] }} Bundle */
/** @typedef {{ id: string, kind: 'gift' | 'trade' | 'loan', from: Card, to: Card, give: Bundle, want: Bundle, text: string, status: string, expiresAt: number, reason?: string }} Offer */
/** @typedef {{ id: string, def: string, name: string, status: string, objectId: string, initiator: Card, participants: Card[], min: number, max: number, startedAt: number | null, endsAt: number | null, lobbyExpiresAt: number, cost: string }} Interaction */
/** @typedef {{ id: string, type: string, label: string, near: boolean, action: { def: string, name: string, cost: string, min: number, max: number } | null, active: Interaction | null }} PlaceObject */
/** @typedef {{ id: string, name: string, goods: { sku: string, name: string, price: number, stock: number, note?: string }[] }} Shop */
/** @typedef {{ id: string, game: string, name: string, venue: string, status: string, host: Card, players: Card[], min: number, max: number, lobbyExpiresAt: number, gameId: string | null, tableId: string | null }} Lobby */
/** @typedef {{ type: string, name: string, min: number, max: number, summary: string }} GameOffer */
/** @typedef {{ messageId: number, from: Card, text: string, at: number }} HereChat */
/** @typedef {{ space: string, name: string, kind: 'public' | 'residential' | 'home', blurb: string, residents: Neighbor[], objects: PlaceObject[], shops: Shop[], activities: Lobby[], games: GameOffer[], tables: { id: string, name: string, activityId: string | null, near: boolean }[], exits: { id: string, name: string, seconds?: number }[], doors?: { home: string, owner: Card, lane: string, no: number, canEnter: boolean }[], home?: { owner: Card, mine: boolean, decor: string[] }, library?: { bookId: string, title: string, available: number }[], chat: HereChat[] }} Here */

/** @typedef {{ itemId: string, type: string, name: string, qty: number, available: number, shelved: number, category: string, stackable: boolean, use: string, borrowedFrom?: string, dueAt?: number }} InvItem */
/** @typedef {{ coins: { balance: number, reserved: number, available: number }, items: InvItem[], lent: { itemId: string, name: string, to: string, dueAt: number }[] }} Inventory */
/** @typedef {{ id: string, kind: 'long' | 'short', title: string, description: string, progress: number, target: number, status: 'active' | 'offered' | string, reward: number }} Goal */
/** @typedef {{ grantId: string, home: string, host: Card, guest: Card, expiresAt: number, reentry: boolean, via: string }} Invite */
/** @typedef {{ id: string, name: string, reason?: string, until?: number, custom?: boolean }} Mood */
/** @typedef {{ since: number, lines: string[] }} Recap */
/** @typedef {{ seat: number, name: string, kind: string, alive: boolean }} GamePlayer */
/** @typedef {{ action: string, label?: string, params?: Record<string, string>, example?: string, command?: string }} ActionSpec */
/** @typedef {{ prompt: string, kind: 'speech' | 'action', actions: ActionSpec[], seconds_left: number | null }} Todo */
/** @typedef {{ seq: number, round: number, kind: string, text: string, private?: true }} GameEvent */
/** @typedef {{ winnerTeam: string, winnerSeats: number[], reason: string, reveal: { seat: number, name: string, identity: string }[] }} GameResult */
/** @typedef {{ key: string, title: string, round: number, open: boolean, seconds_left: number | null, waiting_for: string }} PhaseHeader */
/** @typedef {{ game_id: string, type: string, name: string, status: string, round: number, phase: PhaseHeader | null, phase_id: number | null, players: GamePlayer[], public: Record<string, unknown>, you?: Record<string, unknown>, your_turn?: boolean, todo?: Todo | null, events: GameEvent[], result?: GameResult, aborted?: string | true, activityId?: string, deadline?: number | null, venue?: string }} GameView */

/** @typedef {{ navigationId: string, revision: number, to: { kind: string, id?: string, name: string }, arriveAt: number, continues: boolean, leaseUntil: number, renewEveryMs: number }} Navigation */
/** @typedef {{ world: WorldHeader, me: { id: string, name: string, kind: 'human' | 'agent', bio: string, traits: { id: string, name: string }[], interests: { id: string, name: string }[], titles: string[], home: { id: string, street: string, streetName: string, no: number }, needs: { energy: number, social: number, interest: number }, mood: Mood | null, settings: { showMood: boolean, allowAskHobby: boolean, moodOverride: string | null }, present: boolean }, control: { epoch: number, mine: boolean, presenceEpoch: number }, context: { version: number, activityId: string | null }, actionWindow: string, cursor: string, location: { space: string, name: string, scene: string, x: number, z: number, navigation: Navigation | null }, here: Here | null, inventory: Inventory, goals: Goal[], mail: { unread: number, total: number }, invites: { received: Invite[], sent: Invite[] }, offers: Offer[], interaction: Interaction | null, game: GameView | null, events: PublicEvent[], suggestions: string[], recap?: Recap }} MeView */

/** @typedef {{ id: string, box: 'inbox' | 'sent', from: Card, to: Card, sentAt: number, deliveredAt: number | null, read?: boolean, body?: string, invite?: { grantId: string, expiresAt: number, active: boolean } }} Letter */
/** @typedef {{ id: string, name: string, kind: string, bio: string, titles: string[], present: boolean, at: string | null }} DirEntry */
/** @typedef {{ text: string, at: number }} Memory */
/** @typedef {{ id: string, name: string, familiarity: number, closeness: number, level: string, memories: Memory[] }} Relation */
/** @typedef {{ scope: string, date: string, lines: string[], final: boolean }} Report */
/** @typedef {{ messageId: number, space: string, spaceName: string, from: Card, text: string, at: number }} HistoryMsg */
/** @typedef {{ messageId: number, space: string, spaceName: string, from: Card, text: string, at: number, sys?: boolean }} ChatLine */

/** @typedef {{ ok: boolean, error?: string, reason?: string, message?: string, retryAfterMs?: number, status?: string, replayed?: boolean, text?: string, [k: string]: unknown }} ActResult */
