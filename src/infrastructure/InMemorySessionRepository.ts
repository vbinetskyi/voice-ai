// ─── INFRASTRUCTURE LAYER ────────────────────────────────────────────────────
// In-memory implementation of SessionRepository using a plain Map.
// All data is lost on server restart — for development only.
// To use a real database, implement SessionRepository with e.g. Postgres/Redis
// and swap it in index.ts without touching any other file.
// ─────────────────────────────────────────────────────────────────────────────

import type { Session } from "../domain/entities";
import type { SessionRepository } from "../repository";

export class InMemorySessionRepository implements SessionRepository {
	private readonly store = new Map<string, Session>();

	create(session: Session): void {
		this.store.set(session.id, session);
	}

	get(id: string): Session | undefined {
		return this.store.get(id);
	}

	// The mutator receives the stored object directly and modifies it in place.
	// This works because JavaScript objects are passed by reference —
	// mutations to the argument are immediately visible in the Map.
	update(id: string, mutator: (session: Session) => void): Session | undefined {
		const session = this.store.get(id);
		if (!session) return undefined;
		mutator(session);
		return session;
	}

	delete(id: string): void {
		this.store.delete(id);
	}
}
