import {
  Chess,
  type Color,
  type Move,
  type PieceSymbol,
  type Square,
} from './chess-core.ts';

export type AiPreset = 'easy' | 'normal' | 'hard';
export type AiDepth = 1 | 2 | 3 | 4 | 5;  
export type AiMoveCommand = {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
};
export type AiSettings = {
  preset: AiPreset;
  maxDepth: AiDepth;
  timeLimitMs: number;
  softTimeLimitMs?: number;
  randomness: number;
  quiescence: boolean;
};
export type AiRequest = {
  id: number;
  fen: string;
  settings: AiSettings;
};
export type AiResponse = {
  id: number;
  move: AiMoveCommand | null;
  depthReached: number;
  nodes: number;
  elapsedMs: number;
  score: number;
  debug?: AiDebugInfo;
};
export type AiCandidateDebug = {
  move: AiMoveCommand;
  san: string;
  score: number;
  tickets: number;
  probability: number;
  selected: boolean;
  principal: boolean;
};
export type AiDebugInfo = {
  candidates: AiCandidateDebug[];
  bestScore: number;
  windowCp: number;
  floorScore: number;
  ticketPower: number;
  totalTickets: number;
};
export type AiProgressMessage = AiResponse & { kind: 'progress' };
export type AiResultMessage = AiResponse & { kind: 'result' };
export type AiWorkerMessage = AiProgressMessage | AiResultMessage;

type SearchContext = {
  requestId: number;
  settings: AiSettings;
  deadline: number;
  startTime: number;
  nodes: number;
  onProgress?: (message: AiProgressMessage) => void;
  lastProgressAt: number;
  progressState: SearchProgressState;
};
type SearchProgressState = {
  move: AiMoveCommand | null;
  depthReached: number;
  score: number;
  debug?: AiDebugInfo;
};
type SearchResult = {
  move: AiMoveCommand;
  score: number;
};
type RootCandidate = SearchResult & {
  san: string;
};
type RootSearchResult = {
  selected: SearchResult;
  principal: SearchResult;
  debug: AiDebugInfo;
};
type RootSelection = {
  selected: SearchResult;
  debug: AiDebugInfo;
};
type PawnInfo = {
  color: Color;
  file: number;
  rank: number;
};

const MAX_RANDOMNESS = 30;

export const AI_PRESETS: Record<AiPreset, AiSettings> = {
  easy: {
    preset: 'easy',
    maxDepth: 2,
    timeLimitMs: 750,
    randomness: MAX_RANDOMNESS,
    quiescence: true,
  },
  normal: {
    preset: 'normal',
    maxDepth: 5,
    timeLimitMs: 5_000,
    randomness: MAX_RANDOMNESS,
    quiescence: true,
  },
  hard: {
    preset: 'hard',
    maxDepth: 5,
    timeLimitMs: 5_000,
    randomness: MAX_RANDOMNESS,
    quiescence: true,
  },
};
export const DEFAULT_AI_SETTINGS: AiSettings = { ...AI_PRESETS.normal };

const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};

const FILE_COUNT = 8;
const INFINITY_SCORE = 10_000_000;
const MATE_SCORE = 1_000_000;
const DRAW_SCORE = 0;
const QUIESCENCE_MAX_PLY = 6;
const TIME_CHECK_INTERVAL = 2_048;
const PROGRESS_HEARTBEAT_MS = 100;
const RANDOM_WINDOW_BASE_CP = 20;
const RANDOM_WINDOW_RANGE_CP = 150;
const RANDOM_TICKET_POWER_MAX = 4;
const RANDOM_TICKET_POWER_RANGE = 1.5;
const MATE_RANDOM_PROTECTION_SCORE = MATE_SCORE - 10_000;
const ADAPTIVE_MIN_DEPTH = 2;
const ADAPTIVE_CLEAR_GAP_CP = 120;
const ADAPTIVE_TACTICAL_GAP_CP = 220;
const ADAPTIVE_SCORE_SWING_CP = 90;
const ADAPTIVE_TACTICAL_RATIO = 0.35;

export function searchBestMove(
  request: AiRequest,
  onProgress?: (message: AiProgressMessage) => void,
): AiResponse {
  const chess = new Chess(request.fen);
  const settings = normalizeAiSettings(request.settings);
  const legalMoves = chess.moves({ verbose: true });
  const startTime = Date.now();
  const ctx: SearchContext = {
    requestId: request.id,
    settings,
    deadline: startTime + settings.timeLimitMs,
    startTime,
    nodes: 0,
    onProgress,
    lastProgressAt: startTime,
    progressState: {
      move: null,
      depthReached: 0,
      score: 0,
    },
  };

  if (legalMoves.length === 0) {
    return {
      id: request.id,
      move: null,
      depthReached: 0,
      nodes: 0,
      elapsedMs: 0,
      score: terminalScore(chess, 0),
    };
  }

  let best: SearchResult | null = null;
  let debug: AiDebugInfo | undefined;
  let previousBestMove: AiMoveCommand | null = null;
  let previousPrincipal: SearchResult | null = null;
  let depthReached = 0;

  for (let depth = 1; depth <= settings.maxDepth; depth += 1) {
    try {
      const result = searchRoot(chess, depth, ctx, previousBestMove);
      const elapsedMs = Date.now() - startTime;
      best = result.selected;
      debug = result.debug;
      previousBestMove = result.principal.move;
      depthReached = depth;
      publishSearchProgress(
        ctx,
        {
          move: best.move,
          depthReached,
          score: best.score,
          debug,
        },
        elapsedMs,
      );

      if (
        shouldStopAfterSoftLimit(
          chess,
          legalMoves,
          result,
          previousPrincipal,
          depth,
          elapsedMs,
          settings,
        )
      ) {
        break;
      }

      previousPrincipal = result.principal;
    } catch (error) {
      if (error instanceof SearchTimeout) {
        break;
      }

      throw error;
    }

    if (Date.now() >= ctx.deadline) {
      break;
    }
  }

  best ??= chooseFallbackMove(chess);

  return {
    id: request.id,
    move: best.move,
    depthReached,
    nodes: ctx.nodes,
    elapsedMs: Date.now() - startTime,
    score: best.score,
    debug,
  };
}

export function normalizeAiSettings(settings: AiSettings): AiSettings {
  const timeLimitMs = clamp(Math.round(settings.timeLimitMs), 500, 10_000);
  const softTimeLimitMs =
    settings.softTimeLimitMs === undefined
      ? undefined
      : Math.min(
          timeLimitMs,
          clamp(Math.round(settings.softTimeLimitMs), 500, 10_000),
        );

  return {
    preset: settings.preset,
    maxDepth: clampDepth(settings.maxDepth),
    timeLimitMs,
    ...(softTimeLimitMs === undefined ? {} : { softTimeLimitMs }),
    randomness: MAX_RANDOMNESS,
    quiescence: true,
  };
}

function searchRoot(
  chess: Chess,
  depth: number,
  ctx: SearchContext,
  previousBestMove: AiMoveCommand | null,
): RootSearchResult {
  const candidates: RootCandidate[] = [];
  const legalMoves = orderMoves(chess.moves({ verbose: true }), previousBestMove);

  for (const move of legalMoves) {
    checkTime(ctx);
    chess.move(toMoveCommand(move));

    const score = -negamax(
      chess,
      depth - 1,
      -INFINITY_SCORE,
      INFINITY_SCORE,
      1,
      ctx,
    );

    chess.undo();

    candidates.push({ move: toMoveCommand(move), san: move.san, score });
  }

  if (candidates.length === 0) {
    throw new SearchTimeout();
  }

  const principal = selectBestRootMove(candidates);
  const selection = selectRootMove(candidates, ctx.settings, principal);

  return {
    selected: selection.selected,
    principal,
    debug: selection.debug,
  };
}

function shouldStopAfterSoftLimit(
  chess: Chess,
  rootMoves: Move[],
  result: RootSearchResult,
  previousPrincipal: SearchResult | null,
  depth: number,
  elapsedMs: number,
  settings: AiSettings,
): boolean {
  if (
    settings.preset !== 'hard' ||
    settings.softTimeLimitMs === undefined ||
    elapsedMs < settings.softTimeLimitMs ||
    depth < ADAPTIVE_MIN_DEPTH
  ) {
    return false;
  }

  if (chess.isCheck() || result.principal.score < 0) {
    return false;
  }

  if (
    previousPrincipal === null ||
    !isSameMoveCommand(previousPrincipal.move, result.principal.move) ||
    Math.abs(previousPrincipal.score - result.principal.score) >
      ADAPTIVE_SCORE_SWING_CP
  ) {
    return false;
  }

  const scoreGap = rootScoreGap(result.debug);

  if (scoreGap < ADAPTIVE_CLEAR_GAP_CP) {
    return false;
  }

  if (
    tacticalMoveRatio(rootMoves) >= ADAPTIVE_TACTICAL_RATIO &&
    scoreGap < ADAPTIVE_TACTICAL_GAP_CP
  ) {
    return false;
  }

  return true;
}

function rootScoreGap(debug: AiDebugInfo): number {
  const [bestCandidate, secondCandidate] = debug.candidates;

  if (!bestCandidate || !secondCandidate) {
    return INFINITY_SCORE;
  }

  return bestCandidate.score - secondCandidate.score;
}

function tacticalMoveRatio(moves: Move[]): number {
  if (moves.length === 0) {
    return 0;
  }

  const tacticalMoveCount = moves.filter(isTacticalMove).length;

  return tacticalMoveCount / moves.length;
}

function negamax(
  chess: Chess,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  ctx: SearchContext,
): number {
  checkTime(ctx);

  if (chess.isCheckmate() || chess.isDraw()) {
    return terminalScore(chess, ply);
  }

  if (depth <= 0) {
    return ctx.settings.quiescence
      ? quiescence(chess, alpha, beta, ply, ctx)
      : evaluatePosition(chess);
  }

  let bestScore = -INFINITY_SCORE;
  let currentAlpha = alpha;
  const legalMoves = orderMoves(chess.moves({ verbose: true }), null);

  for (const move of legalMoves) {
    chess.move(toMoveCommand(move));

    const score = -negamax(
      chess,
      depth - 1,
      -beta,
      -currentAlpha,
      ply + 1,
      ctx,
    );

    chess.undo();

    bestScore = Math.max(bestScore, score);
    currentAlpha = Math.max(currentAlpha, score);

    if (currentAlpha >= beta) {
      break;
    }
  }

  return bestScore;
}

function quiescence(
  chess: Chess,
  alpha: number,
  beta: number,
  ply: number,
  ctx: SearchContext,
): number {
  checkTime(ctx);

  if (chess.isCheckmate() || chess.isDraw()) {
    return terminalScore(chess, ply);
  }

  let currentAlpha = alpha;
  const standPat = evaluatePosition(chess);

  if (standPat >= beta) {
    return beta;
  }

  currentAlpha = Math.max(currentAlpha, standPat);

  if (ply >= QUIESCENCE_MAX_PLY) {
    return currentAlpha;
  }

  const legalMoves = orderMoves(chess.moves({ verbose: true }), null);
  const tacticalMoves = chess.isCheck()
    ? legalMoves
    : legalMoves.filter(isTacticalMove);

  for (const move of tacticalMoves) {
    chess.move(toMoveCommand(move));

    const score = -quiescence(chess, -beta, -currentAlpha, ply + 1, ctx);

    chess.undo();

    if (score >= beta) {
      return beta;
    }

    currentAlpha = Math.max(currentAlpha, score);
  }

  return currentAlpha;
}

function evaluatePosition(chess: Chess): number {
  const board = chess.board();
  const pawns: PawnInfo[] = [];
  const bishops: Record<Color, number> = { w: 0, b: 0 };
  const kings: Partial<Record<Color, Square>> = {};
  let whiteScore = 0;
  let blackScore = 0;
  let nonPawnMaterial = 0;

  for (const row of board) {
    for (const pieceOnSquare of row) {
      if (pieceOnSquare === null) {
        continue;
      }

      const { color, type, square } = pieceOnSquare;
      const pieceScore = PIECE_VALUES[type] + pieceSquareScore(type, color, square);

      if (color === 'w') {
        whiteScore += pieceScore;
      } else {
        blackScore += pieceScore;
      }

      if (type === 'p') {
        pawns.push({
          color,
          file: fileIndex(square),
          rank: rankNumber(square),
        });
      } else if (type !== 'k') {
        nonPawnMaterial += PIECE_VALUES[type];
      }

      if (type === 'b') {
        bishops[color] += 1;
      }

      if (type === 'k') {
        kings[color] = square;
      }
    }
  }

  whiteScore += bishops.w >= 2 ? 35 : 0;
  blackScore += bishops.b >= 2 ? 35 : 0;

  whiteScore += pawnStructureScore(pawns, 'w');
  blackScore += pawnStructureScore(pawns, 'b');

  whiteScore += developmentScore(board, 'w');
  blackScore += developmentScore(board, 'b');

  whiteScore += kingSafetyScore(kings.w, pawns, 'w', nonPawnMaterial);
  blackScore += kingSafetyScore(kings.b, pawns, 'b', nonPawnMaterial);

  const sideFactor = chess.turn() === 'w' ? 1 : -1;
  let score = (whiteScore - blackScore) * sideFactor;

  score += chess.moves().length * 2;

  if (chess.isCheck()) {
    score -= 45;
  }

  return score;
}

function pieceSquareScore(
  type: PieceSymbol,
  color: Color,
  square: Square,
): number {
  const file = fileIndex(square);
  const relativeRank = color === 'w' ? rankNumber(square) : 9 - rankNumber(square);
  const centerDistance = Math.abs(file - 3.5) + Math.abs(rankNumber(square) - 4.5);

  switch (type) {
    case 'p':
      return relativeRank * 7 + (file >= 2 && file <= 5 ? 8 : 0);
    case 'n':
      return 42 - centerDistance * 12 - (relativeRank === 1 ? 12 : 0);
    case 'b':
      return 30 - centerDistance * 7;
    case 'r':
      return (relativeRank >= 7 ? 18 : 0) + (file === 0 || file === 7 ? 4 : 0);
    case 'q':
      return 14 - centerDistance * 3;
    case 'k':
      return relativeRank >= 7 ? -18 : 0;
  }
}

function pawnStructureScore(pawns: PawnInfo[], color: Color): number {
  const ownPawns = pawns.filter((pawn) => pawn.color === color);
  const fileCounts = Array.from({ length: FILE_COUNT }, () => 0);
  let score = 0;

  for (const pawn of ownPawns) {
    fileCounts[pawn.file] += 1;
  }

  for (const pawn of ownPawns) {
    const relativeRank = color === 'w' ? pawn.rank : 9 - pawn.rank;

    if (fileCounts[pawn.file] > 1) {
      score -= 14;
    }

    if (
      (fileCounts[pawn.file - 1] ?? 0) === 0 &&
      (fileCounts[pawn.file + 1] ?? 0) === 0
    ) {
      score -= 10;
    }

    if (isPassedPawn(pawn, pawns)) {
      score += (relativeRank - 1) * (relativeRank - 1) * 9;
    }
  }

  return score;
}

function isPassedPawn(pawn: PawnInfo, pawns: PawnInfo[]): boolean {
  const enemyColor = oppositeColor(pawn.color);

  return !pawns.some((candidate) => {
    if (
      candidate.color !== enemyColor ||
      Math.abs(candidate.file - pawn.file) > 1
    ) {
      return false;
    }

    return pawn.color === 'w'
      ? candidate.rank > pawn.rank
      : candidate.rank < pawn.rank;
  });
}

function developmentScore(board: ReturnType<Chess['board']>, color: Color): number {
  const homeRank = color === 'w' ? '1' : '8';
  const knightHomeSquares = color === 'w' ? new Set(['b1', 'g1']) : new Set(['b8', 'g8']);
  const bishopHomeSquares = color === 'w' ? new Set(['c1', 'f1']) : new Set(['c8', 'f8']);
  let score = 0;

  for (const row of board) {
    for (const piece of row) {
      if (piece === null || piece.color !== color) {
        continue;
      }

      if (piece.type === 'n' && !knightHomeSquares.has(piece.square)) {
        score += 18;
      }

      if (piece.type === 'b' && !bishopHomeSquares.has(piece.square)) {
        score += 16;
      }

      if (
        piece.type === 'q' &&
        piece.square.endsWith(homeRank) &&
        hasMovedMinorPieces(board, color)
      ) {
        score -= 12;
      }
    }
  }

  return score;
}

function hasMovedMinorPieces(board: ReturnType<Chess['board']>, color: Color): boolean {
  const homeSquares = color === 'w'
    ? new Set(['b1', 'c1', 'f1', 'g1'])
    : new Set(['b8', 'c8', 'f8', 'g8']);

  for (const row of board) {
    for (const piece of row) {
      if (
        piece !== null &&
        piece.color === color &&
        (piece.type === 'n' || piece.type === 'b') &&
        homeSquares.has(piece.square)
      ) {
        return false;
      }
    }
  }

  return true;
}

function kingSafetyScore(
  kingSquare: Square | undefined,
  pawns: PawnInfo[],
  color: Color,
  nonPawnMaterial: number,
): number {
  if (!kingSquare || nonPawnMaterial < 1_800) {
    return 0;
  }

  const kingFile = fileIndex(kingSquare);
  const kingRank = rankNumber(kingSquare);
  const shieldRank = color === 'w' ? kingRank + 1 : kingRank - 1;
  let score = kingFile === 2 || kingFile === 6 ? 28 : -18;

  for (let file = kingFile - 1; file <= kingFile + 1; file += 1) {
    if (file < 0 || file >= FILE_COUNT) {
      continue;
    }

    const hasShieldPawn = pawns.some(
      (pawn) =>
        pawn.color === color && pawn.file === file && pawn.rank === shieldRank,
    );

    score += hasShieldPawn ? 14 : -10;
  }

  return score;
}

function terminalScore(chess: Chess, ply: number): number {
  if (chess.isCheckmate()) {
    return -MATE_SCORE + ply;
  }

  if (chess.isDraw()) {
    return DRAW_SCORE;
  }

  return evaluatePosition(chess);
}

function orderMoves(moves: Move[], preferredMove: AiMoveCommand | null): Move[] {
  return [...moves].sort(
    (left, right) =>
      moveOrderingScore(right, preferredMove) -
      moveOrderingScore(left, preferredMove),
  );
}

function moveOrderingScore(move: Move, preferredMove: AiMoveCommand | null): number {
  let score = 0;

  if (preferredMove && isSameMove(move, preferredMove)) {
    score += 2_000_000;
  }

  if (move.san.includes('#')) {
    score += 1_500_000;
  } else if (move.san.includes('+')) {
    score += 16_000;
  }

  if (move.isCapture()) {
    const capturedValue = move.captured ? PIECE_VALUES[move.captured] : PIECE_VALUES.p;
    score += capturedValue * 12 - PIECE_VALUES[move.piece];
  }

  if (move.isPromotion() && move.promotion) {
    score += PIECE_VALUES[move.promotion] + 8_000;
  }

  if (move.isKingsideCastle() || move.isQueensideCastle()) {
    score += 1_500;
  }

  score += pieceSquareScore(move.piece, move.color, move.to) * 2;

  return score;
}

function chooseFallbackMove(chess: Chess): SearchResult {
  const [move] = orderMoves(chess.moves({ verbose: true }), null);

  if (!move) {
    return { move: nullMove(), score: terminalScore(chess, 0) };
  }

  chess.move(toMoveCommand(move));
  const score = -evaluatePosition(chess);
  chess.undo();

  return { move: toMoveCommand(move), score };
}

function checkTime(ctx: SearchContext): void {
  ctx.nodes += 1;

  if (ctx.nodes % TIME_CHECK_INTERVAL !== 0) {
    return;
  }

  const now = Date.now();

  if (now - ctx.lastProgressAt >= PROGRESS_HEARTBEAT_MS) {
    publishSearchProgress(ctx, ctx.progressState, now - ctx.startTime, now);
  }

  if (now >= ctx.deadline) {
    throw new SearchTimeout();
  }
}

function publishSearchProgress(
  ctx: SearchContext,
  progressState: SearchProgressState,
  elapsedMs = Date.now() - ctx.startTime,
  progressAt = Date.now(),
): void {
  ctx.progressState = progressState;
  ctx.lastProgressAt = progressAt;
  ctx.onProgress?.({
    kind: 'progress',
    id: ctx.requestId,
    move: progressState.move,
    depthReached: progressState.depthReached,
    nodes: ctx.nodes,
    elapsedMs,
    score: progressState.score,
    debug: progressState.debug,
  });
}

function isTacticalMove(move: Move): boolean {
  return (
    move.isCapture() ||
    move.isPromotion() ||
    move.san.includes('+') ||
    move.san.includes('#')
  );
}

function selectRootMove(
  candidates: RootCandidate[],
  settings: AiSettings,
  best: SearchResult,
): RootSelection {
  const level = settings.randomness / MAX_RANDOMNESS;
  const windowCp = RANDOM_WINDOW_BASE_CP + RANDOM_WINDOW_RANGE_CP * level;
  const floorScore = best.score - windowCp;
  const ticketPower =
    RANDOM_TICKET_POWER_MAX - RANDOM_TICKET_POWER_RANGE * level;

  if (shouldForceBestMove(settings, best)) {
    return {
      selected: best,
      debug: createDeterministicDebug(
        candidates,
        best,
        best,
        windowCp,
        floorScore,
        ticketPower,
      ),
    };
  }

  const weightedCandidates = candidates
    .map((candidate) => ({
      candidate,
      tickets:
        (Math.max(0, candidate.score - floorScore) / windowCp) ** ticketPower,
    }))
    .filter(({ tickets }) => tickets > 0);
  const totalTickets = weightedCandidates.reduce(
    (total, { tickets }) => total + tickets,
    0,
  );

  if (totalTickets <= 0) {
    return {
      selected: best,
      debug: createDeterministicDebug(
        candidates,
        best,
        best,
        windowCp,
        floorScore,
        ticketPower,
      ),
    };
  }

  let draw = Math.random() * totalTickets;
  let selected = best;

  for (const { candidate, tickets } of weightedCandidates) {
    draw -= tickets;

    if (draw <= 0) {
      selected = candidate;
      break;
    }
  }

  return {
    selected,
    debug: createWeightedDebug(
      candidates,
      best,
      selected,
      weightedCandidates,
      windowCp,
      floorScore,
      ticketPower,
      totalTickets,
    ),
  };
}

function shouldForceBestMove(
  settings: AiSettings,
  best: SearchResult,
): boolean {
  return (
    settings.randomness === 0 ||
    isMateProtectedScore(best.score) ||
    (settings.preset === 'hard' && best.score < 0)
  );
}

function selectBestRootMove(candidates: RootCandidate[]): SearchResult {
  return candidates.reduce((currentBest, candidate) =>
    candidate.score > currentBest.score ? candidate : currentBest,
  );
}

function createDeterministicDebug(
  candidates: RootCandidate[],
  principal: SearchResult,
  selected: SearchResult,
  windowCp: number,
  floorScore: number,
  ticketPower: number,
): AiDebugInfo {
  return {
    candidates: sortCandidatesByScore(candidates).map((candidate) => ({
      move: candidate.move,
      san: candidate.san,
      score: candidate.score,
      tickets: isSameMoveCommand(candidate.move, selected.move) ? 1 : 0,
      probability: isSameMoveCommand(candidate.move, selected.move) ? 1 : 0,
      selected: isSameMoveCommand(candidate.move, selected.move),
      principal: isSameMoveCommand(candidate.move, principal.move),
    })),
    bestScore: principal.score,
    windowCp,
    floorScore,
    ticketPower,
    totalTickets: 1,
  };
}

function createWeightedDebug(
  candidates: RootCandidate[],
  principal: SearchResult,
  selected: SearchResult,
  weightedCandidates: Array<{ candidate: RootCandidate; tickets: number }>,
  windowCp: number,
  floorScore: number,
  ticketPower: number,
  totalTickets: number,
): AiDebugInfo {
  return {
    candidates: sortCandidatesByScore(candidates).map((candidate) => {
      const weightedCandidate = weightedCandidates.find(({ candidate: weighted }) =>
        isSameMoveCommand(weighted.move, candidate.move),
      );
      const tickets = weightedCandidate?.tickets ?? 0;

      return {
        move: candidate.move,
        san: candidate.san,
        score: candidate.score,
        tickets,
        probability: totalTickets > 0 ? tickets / totalTickets : 0,
        selected: isSameMoveCommand(candidate.move, selected.move),
        principal: isSameMoveCommand(candidate.move, principal.move),
      };
    }),
    bestScore: principal.score,
    windowCp,
    floorScore,
    ticketPower,
    totalTickets,
  };
}

function sortCandidatesByScore(candidates: RootCandidate[]): RootCandidate[] {
  return [...candidates].sort((left, right) => right.score - left.score);
}

function isMateProtectedScore(score: number): boolean {
  return Math.abs(score) >= MATE_RANDOM_PROTECTION_SCORE;
}

function toMoveCommand(move: Move): AiMoveCommand {
  if (move.promotion) {
    return { from: move.from, to: move.to, promotion: move.promotion };
  }

  return { from: move.from, to: move.to };
}

function nullMove(): AiMoveCommand {
  return { from: 'a1', to: 'a1' };
}

function isSameMove(move: Move, command: AiMoveCommand): boolean {
  return (
    move.from === command.from &&
    move.to === command.to &&
    (move.promotion ?? undefined) === (command.promotion ?? undefined)
  );
}

function isSameMoveCommand(
  left: AiMoveCommand,
  right: AiMoveCommand,
): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    (left.promotion ?? undefined) === (right.promotion ?? undefined)
  );
}

function fileIndex(square: Square): number {
  return square.charCodeAt(0) - 97;
}

function rankNumber(square: Square): number {
  return Number(square[1]);
}

function oppositeColor(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function clampDepth(depth: number): AiDepth {
  return clamp(Math.round(depth), 1, 5) as AiDepth;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

class SearchTimeout extends Error {}
