"""
Clean Architecture — Leaderboard Domain (FastAPI + Redis)

Layers (top → bottom, each only imports from layers below it):
  HTTP (routers)  →  Service  →  Domain  →  Repository (abstract)
                                          ↑
  Infrastructure (RedisLeaderboardRepo) ──┘

Run with:
  uv add fastapi redis uvicorn
  uvicorn leaderboard_clean_arch:app --reload
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import redis.asyncio as aioredis
from fastapi import Depends, FastAPI, HTTPException, status
from pydantic import BaseModel, Field


# ─────────────────────────────────────────────
# DOMAIN LAYER
# No framework imports. No Redis. No FastAPI.
# Just pure business concepts.
# ─────────────────────────────────────────────


@dataclass(frozen=True)
class PlayerId:
    """Value object — player identity."""

    value: str

    def __post_init__(self) -> None:
        if not self.value or len(self.value) > 64:
            raise ValueError("PlayerId must be between 1 and 64 characters")


@dataclass
class PlayerScore:
    """Domain entity — a player's score on a named leaderboard."""

    player_id: PlayerId
    board_name: str
    score: float
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def add_points(self, points: float) -> "PlayerScore":
        if points < 0:
            raise ValueError("Points must be non-negative")
        return PlayerScore(
            player_id=self.player_id,
            board_name=self.board_name,
            score=self.score + points,
            updated_at=datetime.now(timezone.utc),
        )


@dataclass(frozen=True)
class RankedEntry:
    """Domain read model — a player's position in rankings."""

    player_id: PlayerId
    score: float
    rank: int


class LeaderboardDomainError(Exception):
    """Base class for all domain errors — never an HTTPException."""


class PlayerNotFoundError(LeaderboardDomainError):
    pass


class InvalidBoardError(LeaderboardDomainError):
    pass


# ─────────────────────────────────────────────
# REPOSITORY LAYER (abstract)
# Defines what the service needs. No Redis, no SQL.
# Concrete implementations live in Infrastructure.
# ─────────────────────────────────────────────


class LeaderboardRepository(abc.ABC):
    @abc.abstractmethod
    async def save(self, entry: PlayerScore) -> None: ...

    @abc.abstractmethod
    async def get(
        self, board_name: str, player_id: PlayerId
    ) -> Optional[PlayerScore]: ...

    @abc.abstractmethod
    async def top_n(self, board_name: str, n: int) -> list[RankedEntry]: ...

    @abc.abstractmethod
    async def rank_of(self, board_name: str, player_id: PlayerId) -> Optional[int]: ...


# ─────────────────────────────────────────────
# INFRASTRUCTURE LAYER
# Redis-specific. Knows about sorted sets, keys, pipelines.
# Only this layer touches `redis.asyncio`.
# ─────────────────────────────────────────────

_SCORE_KEY = "lb:{board}:scores"
_META_KEY = "lb:{board}:meta:{pid}"


class RedisLeaderboardRepository(LeaderboardRepository):
    def __init__(self, client: aioredis.Redis) -> None:
        self._r = client

    def _score_key(self, board: str) -> str:
        return _SCORE_KEY.format(board=board)

    def _meta_key(self, board: str, pid: str) -> str:
        return _META_KEY.format(board=board, pid=pid)

    async def save(self, entry: PlayerScore) -> None:
        pipe = self._r.pipeline(transaction=True)
        pipe.zadd(
            self._score_key(entry.board_name),
            {entry.player_id.value: entry.score},
        )
        pipe.hset(
            self._meta_key(entry.board_name, entry.player_id.value),
            mapping={"updated_at": entry.updated_at.isoformat()},
        )
        await pipe.execute()

    async def get(self, board_name: str, player_id: PlayerId) -> Optional[PlayerScore]:
        score = await self._r.zscore(self._score_key(board_name), player_id.value)
        if score is None:
            return None
        meta = await self._r.hgetall(self._meta_key(board_name, player_id.value))
        updated_at = (
            datetime.fromisoformat(meta[b"updated_at"].decode())
            if meta
            else datetime.now(timezone.utc)
        )
        return PlayerScore(
            player_id=player_id,
            board_name=board_name,
            score=float(score),
            updated_at=updated_at,
        )

    async def top_n(self, board_name: str, n: int) -> list[RankedEntry]:
        # ZREVRANGEBYSCORE with scores, highest first
        raw = await self._r.zrevrange(
            self._score_key(board_name), 0, n - 1, withscores=True
        )
        return [
            RankedEntry(
                player_id=PlayerId(pid.decode()),
                score=score,
                rank=rank + 1,
            )
            for rank, (pid, score) in enumerate(raw)
        ]

    async def rank_of(self, board_name: str, player_id: PlayerId) -> Optional[int]:
        rank = await self._r.zrevrank(self._score_key(board_name), player_id.value)
        return None if rank is None else rank + 1  # 1-indexed


# ─────────────────────────────────────────────
# SERVICE LAYER
# Orchestrates business logic. No HTTP. No Redis.
# Raises domain errors, never HTTPExceptions.
# ─────────────────────────────────────────────

ALLOWED_BOARDS = {"global", "weekly", "monthly"}


class LeaderboardService:
    def __init__(self, repo: LeaderboardRepository) -> None:
        self._repo = repo

    def _validate_board(self, board_name: str) -> None:
        if board_name not in ALLOWED_BOARDS:
            raise InvalidBoardError(
                f"Board '{board_name}' does not exist. Allowed: {ALLOWED_BOARDS}"
            )

    async def submit_score(
        self, board_name: str, player_id_str: str, points: float
    ) -> PlayerScore:
        self._validate_board(board_name)
        pid = PlayerId(player_id_str)

        existing = await self._repo.get(board_name, pid)
        if existing:
            updated = existing.add_points(points)
        else:
            updated = PlayerScore(
                player_id=pid,
                board_name=board_name,
                score=points,
            )
        await self._repo.save(updated)
        return updated

    async def get_top(self, board_name: str, limit: int = 10) -> list[RankedEntry]:
        self._validate_board(board_name)
        return await self._repo.top_n(board_name, min(limit, 100))

    async def get_player(
        self, board_name: str, player_id_str: str
    ) -> tuple[PlayerScore, int]:
        self._validate_board(board_name)
        pid = PlayerId(player_id_str)

        entry = await self._repo.get(board_name, pid)
        if entry is None:
            raise PlayerNotFoundError(
                f"Player '{player_id_str}' not found on board '{board_name}'"
            )
        rank = await self._repo.rank_of(board_name, pid) or 0
        return entry, rank


# ─────────────────────────────────────────────
# HTTP LAYER
# Only concern: HTTP. Maps domain errors → HTTP codes.
# Request/response models live here, not in domain.
# ─────────────────────────────────────────────

# ── Pydantic I/O models (HTTP layer only) ──


class SubmitScoreRequest(BaseModel):
    player_id: str = Field(..., min_length=1, max_length=64)
    points: float = Field(..., gt=0)


class PlayerScoreResponse(BaseModel):
    player_id: str
    board_name: str
    score: float
    updated_at: datetime


class RankedEntryResponse(BaseModel):
    player_id: str
    score: float
    rank: int


class PlayerRankResponse(BaseModel):
    player_id: str
    board_name: str
    score: float
    rank: int
    updated_at: datetime


# ── Error mapping helper ──


def _to_http(exc: LeaderboardDomainError) -> HTTPException:
    if isinstance(exc, PlayerNotFoundError):
        return HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, InvalidBoardError):
        return HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))


# ── FastAPI app + DI wiring ──

app = FastAPI(title="Leaderboard API")

_redis_client: aioredis.Redis | None = None


@app.on_event("startup")
async def startup() -> None:
    global _redis_client
    _redis_client = aioredis.from_url("redis://localhost:6379", decode_responses=False)


@app.on_event("shutdown")
async def shutdown() -> None:
    if _redis_client:
        await _redis_client.aclose()


def get_repo() -> RedisLeaderboardRepository:
    return RedisLeaderboardRepository(_redis_client)


def get_service(
    repo: RedisLeaderboardRepository = Depends(get_repo),
) -> LeaderboardService:
    return LeaderboardService(repo)


# ── Route handlers ──


@app.post(
    "/leaderboards/{board_name}/scores",
    response_model=PlayerScoreResponse,
    status_code=status.HTTP_200_OK,
)
async def submit_score(
    board_name: str,
    body: SubmitScoreRequest,
    svc: LeaderboardService = Depends(get_service),
) -> PlayerScoreResponse:
    try:
        entry = await svc.submit_score(board_name, body.player_id, body.points)
    except LeaderboardDomainError as exc:
        raise _to_http(exc) from exc
    return PlayerScoreResponse(
        player_id=entry.player_id.value,
        board_name=entry.board_name,
        score=entry.score,
        updated_at=entry.updated_at,
    )


@app.get(
    "/leaderboards/{board_name}/top",
    response_model=list[RankedEntryResponse],
)
async def get_top(
    board_name: str,
    limit: int = 10,
    svc: LeaderboardService = Depends(get_service),
) -> list[RankedEntryResponse]:
    try:
        entries = await svc.get_top(board_name, limit)
    except LeaderboardDomainError as exc:
        raise _to_http(exc) from exc
    return [
        RankedEntryResponse(
            player_id=e.player_id.value,
            score=e.score,
            rank=e.rank,
        )
        for e in entries
    ]


@app.get(
    "/leaderboards/{board_name}/players/{player_id}",
    response_model=PlayerRankResponse,
)
async def get_player(
    board_name: str,
    player_id: str,
    svc: LeaderboardService = Depends(get_service),
) -> PlayerRankResponse:
    try:
        entry, rank = await svc.get_player(board_name, player_id)
    except LeaderboardDomainError as exc:
        raise _to_http(exc) from exc
    return PlayerRankResponse(
        player_id=entry.player_id.value,
        board_name=entry.board_name,
        score=entry.score,
        rank=rank,
        updated_at=entry.updated_at,
    )
