import {
  AI_PRESETS,
  DEFAULT_AI_SETTINGS,
  normalizeAiSettings,
  type AiCandidateDebug,
  type AiMoveCommand,
  type AiPreset,
  type AiResponse,
  type AiSettings,
  type AiWorkerMessage,
} from './ai.ts';
import AiWorker from './ai.worker.ts?worker&inline';
import {
  Chess,
  SQUARES,
  type Color,
  type Move,
  type PieceSymbol,
  type Square,
} from './chess-runtime.ts';

type GameMode = 'local' | 'ai';
type ClockPreset = '1/1' | '3/2' | '5/3' | '10/5' | '15/10';
type ClockConfig = {
  baseMs: number;
  incrementMs: number;
};
type BoardFile = (typeof BOARD_FILES)[number];
type BoardRank = (typeof WHITE_RANKS)[number];
type PromotionPiece = Extract<PieceSymbol, 'q' | 'r' | 'b' | 'n'>;
type PromotionRequest = {
  from: Square;
  to: Square;
  moves: Move[];
};
type WeightedOpeningMove = AiMoveCommand & {
  weight: number;
};

const BOARD_FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const BLACK_FILES = [...BOARD_FILES].reverse();
const WHITE_RANKS = [8, 7, 6, 5, 4, 3, 2, 1] as const;
const BLACK_RANKS = [...WHITE_RANKS].reverse();
const PROMOTION_PIECES: PromotionPiece[] = ['q', 'r', 'b', 'n'];
const AI_DELAY_MS = 180;
const OPENING_FULL_PLY = 20;
const OPENING_MIN_FACTOR = 0.2;
const CLOCK_TICK_MS = 100;
const DEFAULT_CLOCK_PRESET: ClockPreset = '10/5';
const DEBUG_MATE_SCORE_THRESHOLD = 900_000;
const TEXT_SEPARATOR = ' \u00B7 ';
const SQUARE_SET = new Set<string>(SQUARES);
// Weights are Stockfish cp values (depth 30) for White's first move from the standard
// start position. Moves evaluating at cp <= 0 are omitted from the pool.
const AI_WHITE_OPENING_PRESET: WeightedOpeningMove[] = [
  { from: 'e2', to: 'e4', weight: 29 },
  { from: 'd2', to: 'd4', weight: 29 },
  { from: 'g1', to: 'f3', weight: 28 },
  { from: 'c2', to: 'c4', weight: 22 },
  { from: 'g2', to: 'g3', weight: 22 },
  { from: 'e2', to: 'e3', weight: 12 },
  { from: 'c2', to: 'c3', weight: 7 },
];
const CLOCK_PRESETS: Record<ClockPreset, ClockConfig> = {
  '1/1': { baseMs: 60_000, incrementMs: 1_000 },
  '3/2': { baseMs: 180_000, incrementMs: 2_000 },
  '5/3': { baseMs: 300_000, incrementMs: 3_000 },
  '10/5': { baseMs: 600_000, incrementMs: 5_000 },
  '15/10': { baseMs: 900_000, incrementMs: 10_000 },
};

const PIECE_GLYPHS: Record<Color, Record<PieceSymbol, string>> = {
  w: {
    p: '\u2659',
    n: '\u2658',
    b: '\u2657',
    r: '\u2656',
    q: '\u2655',
    k: '\u2654',
  },
  b: {
    p: '\u265F',
    n: '\u265E',
    b: '\u265D',
    r: '\u265C',
    q: '\u265B',
    k: '\u265A',
  },
};

export function createChessApp(): void {
  const root = requireElement<HTMLElement>('#chess-app', document);

  const boardElement = requireElement<HTMLDivElement>('#chess-board', root);
  const colorControlsElement = requireElement<HTMLElement>('#color-controls', root);
  const aiControlsElement = requireElement<HTMLElement>('#ai-controls', root);
  const statusElement = requireElement<HTMLElement>('#game-status', root);
  const turnMetaElement = requireElement<HTMLElement>('#turn-meta', root);
  const modeMetaElement = requireElement<HTMLElement>('#mode-meta', root);
  const moveMetaElement = requireElement<HTMLElement>('#move-meta', root);
  const aiCandidatePanelElement = requireElement<HTMLElement>('#ai-candidate-panel', root);
  const aiCandidateMetaElement = requireElement<HTMLElement>('#ai-candidate-meta', root);
  const aiInfoStatusElement = requireElement<HTMLElement>('#ai-info-status', root);
  const aiInfoPresetElement = requireElement<HTMLElement>('#ai-info-preset', root);
  const aiInfoHumanElement = requireElement<HTMLElement>('#ai-info-human', root);
  const aiInfoDepthElement = requireElement<HTMLElement>('#ai-info-depth', root);
  const aiInfoNodesElement = requireElement<HTMLElement>('#ai-info-nodes', root);
  const aiInfoScoreElement = requireElement<HTMLElement>('#ai-info-score', root);
  const aiCandidateListElement = requireElement<HTMLDivElement>('#ai-candidate-list', root);
  const moveListElement = requireElement<HTMLDivElement>('#move-list', root);
  const clockDisplayElement = requireElement<HTMLElement>('#clock-display', root);
  const whiteClockElement = requireElement<HTMLElement>('#white-clock', root);
  const blackClockElement = requireElement<HTMLElement>('#black-clock', root);
  const whiteClockTimeElement = requireElement<HTMLElement>('#white-clock-time', root);
  const blackClockTimeElement = requireElement<HTMLElement>('#black-clock-time', root);
  const newGameButton = requireElement<HTMLButtonElement>('#new-game-button', root);
  const undoButton = requireElement<HTMLButtonElement>('#undo-button', root);
  const aiDepthInput = requireElement<HTMLInputElement>('#ai-depth-input', root);
  const aiDepthValue = requireElement<HTMLElement>('#ai-depth-value', root);
  const aiTimeInput = requireElement<HTMLInputElement>('#ai-time-input', root);
  const aiTimeValue = requireElement<HTMLElement>('#ai-time-value', root);
  const promotionOverlay = requireElement<HTMLDivElement>('#promotion-overlay', root);
  const promotionChoices = requireElement<HTMLDivElement>('#promotion-choices', root);
  const modeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-mode]'));
  const colorButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-color]'));
  const presetButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-preset]'));
  const clockPresetButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[data-clock-preset]'),
  );

  const game = new Chess();
  let mode: GameMode = 'local';
  let clockPreset: ClockPreset = DEFAULT_CLOCK_PRESET;
  let clockMs: Record<Color, number> = createClockState(clockPreset);
  let clockHistory: Record<Color, number>[] = [];
  let activeClockColor: Color | null = null;
  let lastClockTick = Date.now();
  let clockTimerId: number | null = null;
  let timedOutColor: Color | null = null;
  let humanColor: Color = 'w';
  let selectedSquare: Square | null = null;
  let legalMoves: Move[] = [];
  let pendingPromotion: PromotionRequest | null = null;
  let aiThinking = false;
  let aiTimerId: number | null = null;
  let aiWorker: Worker | null = null;
  let aiRequestId = 0;
  let activeAiRequestId: number | null = null;
  let activeAiFen: string | null = null;
  let aiSettings: AiSettings = { ...DEFAULT_AI_SETTINGS };
  let aiProgress: AiResponse | null = null;

  boardElement.addEventListener('click', (event) => {
    const button = getSquareButton(event.target, boardElement);

    if (!button || !isSquare(button.dataset.square)) {
      return;
    }

    handleSquareClick(button.dataset.square);
  });

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const nextMode = button.dataset.mode;

      if (isGameMode(nextMode) && nextMode !== mode) {
        mode = nextMode;
        resetGame();
      }
    });
  });

  colorButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const nextColor = button.dataset.color;

      if (isColor(nextColor) && nextColor !== humanColor) {
        humanColor = nextColor;
        resetGame();
      }
    });
  });

  presetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const preset = button.dataset.preset;

      if (isAiPreset(preset)) {
        updateAiSettings({ ...AI_PRESETS[preset] });
      }
    });
  });

  clockPresetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const preset = button.dataset.clockPreset;

      if (isClockPreset(preset) && preset !== clockPreset) {
        clockPreset = preset;
        resetGame();
      }
    });
  });

  aiDepthInput.addEventListener('input', () => {
    updateAiSettings({
      ...aiSettings,
      maxDepth: toAiDepth(aiDepthInput.valueAsNumber),
    });
  });

  aiTimeInput.addEventListener('input', () => {
    updateAiSettings({
      ...aiSettings,
      timeLimitMs: aiTimeInput.valueAsNumber,
    });
  });

  newGameButton.addEventListener('click', resetGame);
  undoButton.addEventListener('click', undoLastTurn);

  promotionChoices.addEventListener('click', (event) => {
    const target = event.target;

    if (!(target instanceof Element)) {
      return;
    }

    const button = target.closest<HTMLButtonElement>('[data-promotion]');
    const promotion = button?.dataset.promotion;

    if (isPromotionPiece(promotion)) {
      finishPromotion(promotion);
    }
  });

  resetClockState();
  restartClockForCurrentTurn();
  render();

  function handleSquareClick(square: Square): void {
    if (!canUseBoard()) {
      return;
    }

    const piece = game.get(square);

    if (selectedSquare) {
      const movesToDestination = legalMoves.filter((move) => move.to === square);

      if (movesToDestination.length > 0) {
        if (movesToDestination.some((move) => move.isPromotion())) {
          pendingPromotion = {
            from: selectedSquare,
            to: square,
            moves: movesToDestination,
          };
          render();
          return;
        }

        playMove({ from: selectedSquare, to: square });
        return;
      }

      if (piece?.color === game.turn()) {
        selectSquare(square);
        return;
      }

      clearSelection();
      render();
      return;
    }

    if (piece?.color === game.turn()) {
      selectSquare(square);
    }
  }

  function selectSquare(square: Square): void {
    selectedSquare = square;
    legalMoves = game.moves({ verbose: true, square });
    render();
  }

  function playMove(moveCommand: AiMoveCommand): void {
    if (!commitMove(moveCommand)) {
      clearSelection();
      render();
      return;
    }

    pendingPromotion = null;
    clearSelection();
    render();
    scheduleAiIfNeeded();
  }

  function finishPromotion(promotion: PromotionPiece): void {
    if (!pendingPromotion) {
      return;
    }

    const matchingMove = pendingPromotion.moves.find((move) => move.promotion === promotion);

    if (!matchingMove) {
      return;
    }

    const { from, to } = pendingPromotion;
    pendingPromotion = null;
    playMove({ from, to, promotion });
  }

  function undoLastTurn(): void {
    cancelAiMove();
    pendingPromotion = null;

    if (game.history().length === 0) {
      render();
      return;
    }

    const desiredUndoCount = mode === 'ai' ? (game.turn() === humanColor ? 2 : 1) : 1;
    const undoCount = Math.min(desiredUndoCount, game.history().length);
    let restoredClockMs: Record<Color, number> | undefined;

    for (let i = 0; i < undoCount; i += 1) {
      game.undo();
      restoredClockMs = clockHistory.pop() ?? restoredClockMs;
    }

    if (restoredClockMs) {
      clockMs = restoredClockMs;
    }

    timedOutColor = null;
    clearSelection();
    restartClockForCurrentTurn();
    render();
  }

  function resetGame(): void {
    cancelAiMove();
    game.reset();
    pendingPromotion = null;
    clearSelection();
    resetClockState();
    restartClockForCurrentTurn();
    render();
    scheduleAiIfNeeded();
  }

  function scheduleAiIfNeeded(): void {
    if (
      mode !== 'ai' ||
      game.isGameOver() ||
      timedOutColor !== null ||
      game.turn() === humanColor ||
      aiThinking ||
      pendingPromotion
    ) {
      return;
    }

    if (tryCommitAiWhiteOpeningPreset()) {
      return;
    }

    aiThinking = true;
    aiProgress = null;
    render();

    aiTimerId = window.setTimeout(() => {
      aiTimerId = null;
      startAiSearch();
    }, AI_DELAY_MS);
  }

  function tryCommitAiWhiteOpeningPreset(): boolean {
    if (humanColor !== 'b' || game.turn() !== 'w' || game.history().length > 0) {
      return false;
    }

    const legalPresetMoves = AI_WHITE_OPENING_PRESET.filter((presetMove) =>
      game
        .moves({ verbose: true, square: presetMove.from })
        .some((move) => isSameMoveCommand(move, presetMove)),
    );
    const selectedMove = pickWeightedOpeningMove(legalPresetMoves);

    if (!selectedMove || !commitMove(selectedMove)) {
      return false;
    }

    aiProgress = null;
    clearSelection();
    render();

    return true;
  }

  function cancelAiMove(): void {
    aiRequestId += 1;
    activeAiRequestId = null;
    activeAiFen = null;
    aiProgress = null;

    if (aiTimerId !== null) {
      window.clearTimeout(aiTimerId);
      aiTimerId = null;
    }

    if (aiWorker) {
      aiWorker.terminate();
      aiWorker = null;
    }

    aiThinking = false;
  }

  function startAiSearch(): void {
    aiWorker?.terminate();

    const requestId = aiRequestId + 1;
    const fen = game.fen();
    aiRequestId = requestId;
    activeAiRequestId = requestId;
    activeAiFen = fen;
    aiWorker = new AiWorker();

    aiWorker.addEventListener('message', (event: MessageEvent<AiWorkerMessage>) => {
      handleAiMessage(event.data);
    });
    aiWorker.addEventListener('error', () => {
      if (activeAiRequestId === requestId) {
        aiThinking = false;
        activeAiRequestId = null;
        activeAiFen = null;
        aiWorker?.terminate();
        aiWorker = null;
        render();
      }
    });
    aiWorker.postMessage({
      id: requestId,
      fen,
      settings: resolveAiSettingsForSearch(),
    });
  }

  function handleAiMessage(message: AiWorkerMessage): void {
    if (message.id !== activeAiRequestId || activeAiFen === null || game.fen() !== activeAiFen) {
      return;
    }

    aiProgress = message;

    if (message.kind === 'progress') {
      renderStatus();
      renderAiCandidateDebug();
      return;
    }

    aiThinking = false;
    activeAiRequestId = null;
    activeAiFen = null;
    aiWorker?.terminate();
    aiWorker = null;

    if (message.move) {
      commitMove(message.move);
    }

    clearSelection();
    render();
  }

  function commitMove(moveCommand: AiMoveCommand): boolean {
    const movingColor = game.turn();
    const clockSnapshot = { ...clockMs };

    if (!flushClockElapsed()) {
      return false;
    }

    try {
      game.move(moveCommand);
    } catch {
      return false;
    }

    clockHistory.push(clockSnapshot);
    clockMs[movingColor] += CLOCK_PRESETS[clockPreset].incrementMs;
    restartClockForCurrentTurn();

    return true;
  }

  function updateAiSettings(settings: AiSettings): void {
    aiSettings = normalizeAiSettings(settings);

    if (aiThinking) {
      cancelAiMove();
    }

    render();
    scheduleAiIfNeeded();
  }

  function resolveAiSettingsForSearch(): AiSettings {
    const settings = normalizeAiSettings(aiSettings);

    if (settings.preset !== 'hard') {
      return settings;
    }

    const aiColor = game.turn();
    const remainingMs = clockMs[aiColor];
    const incrementMs = CLOCK_PRESETS[clockPreset].incrementMs;

    const ply = game.history().length;
    const hasCastled = game
      .history({ verbose: true })
      .some(
        (move) =>
          move.color === aiColor && (move.isKingsideCastle() || move.isQueensideCastle()),
      );
    const factor = openingTimeFactor(ply, hasCastled);

    const targetMs = (remainingMs / 30) * factor + incrementMs * 0.8;
    const timeLimitMs =
      remainingMs <= 3_000 ? Math.min(targetMs, remainingMs * 0.35) : targetMs;

    return normalizeAiSettings({
      ...settings,
      timeLimitMs,
    });
  }

  function resetClockState(): void {
    clockMs = createClockState(clockPreset);
    clockHistory = [];
    timedOutColor = null;
    activeClockColor = null;
    lastClockTick = Date.now();
  }

  function restartClockForCurrentTurn(): void {
    clearClockTimer();

    if (game.isGameOver() || timedOutColor !== null) {
      activeClockColor = null;
      renderClocks();
      return;
    }

    activeClockColor = game.turn();
    lastClockTick = Date.now();
    clockTimerId = window.setInterval(tickClock, CLOCK_TICK_MS);
    renderClocks();
  }

  function clearClockTimer(): void {
    if (clockTimerId !== null) {
      window.clearInterval(clockTimerId);
      clockTimerId = null;
    }
  }

  function tickClock(): void {
    if (flushClockElapsed()) {
      renderClocks();
    }
  }

  function flushClockElapsed(): boolean {
    if (activeClockColor === null || timedOutColor !== null || game.isGameOver()) {
      return true;
    }

    const now = Date.now();
    const elapsedMs = Math.max(0, now - lastClockTick);
    lastClockTick = now;

    if (elapsedMs === 0) {
      return true;
    }

    clockMs[activeClockColor] = Math.max(0, clockMs[activeClockColor] - elapsedMs);

    if (clockMs[activeClockColor] === 0) {
      handleClockTimeout(activeClockColor);
      return false;
    }

    return true;
  }

  function handleClockTimeout(color: Color): void {
    timedOutColor = color;
    activeClockColor = null;
    clockMs[color] = 0;
    clearClockTimer();
    cancelAiMove();
    clearSelection();
    render();
  }

  function clearSelection(): void {
    selectedSquare = null;
    legalMoves = [];
  }

  function render(): void {
    renderControls();
    renderClocks();
    renderBoard();
    renderStatus();
    renderAiCandidateDebug();
    renderMoveList();
    renderPromotionDialog();
  }

  function renderControls(): void {
    modeButtons.forEach((button) => {
      const isActive = button.dataset.mode === mode;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });

    colorButtons.forEach((button) => {
      const isActive = button.dataset.color === humanColor;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });

    colorControlsElement.hidden = mode !== 'ai';
    aiControlsElement.hidden = mode !== 'ai';
    renderAiSettingsControls();
    renderClockSettingsControls();
    undoButton.disabled = game.history().length === 0;
  }

  function renderAiSettingsControls(): void {
    presetButtons.forEach((button) => {
      const isActive = button.dataset.preset === aiSettings.preset;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });

    aiDepthInput.value = aiSettings.preset === 'hard' ? aiDepthInput.max : String(aiSettings.maxDepth);
    aiDepthInput.disabled = aiSettings.preset === 'hard';
    aiDepthValue.textContent = aiSettings.preset === 'hard' ? '무제한' : `${aiSettings.maxDepth}`;
    aiTimeInput.value = String(aiSettings.timeLimitMs);
    aiTimeInput.disabled = aiSettings.preset === 'hard';
    aiTimeValue.textContent =
      aiSettings.preset === 'hard' ? '자동' : `${formatSeconds(aiSettings.timeLimitMs)}`;
  }

  function renderClockSettingsControls(): void {
    clockPresetButtons.forEach((button) => {
      const isActive = button.dataset.clockPreset === clockPreset;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  function renderClocks(): void {
    const bottomColor = getBoardOrientation();
    const topColor = oppositeColor(bottomColor);
    const topClockElement = topColor === 'w' ? whiteClockElement : blackClockElement;
    const bottomClockElement = bottomColor === 'w' ? whiteClockElement : blackClockElement;

    if (
      clockDisplayElement.children[0] !== topClockElement ||
      clockDisplayElement.children[1] !== bottomClockElement
    ) {
      clockDisplayElement.replaceChildren(topClockElement, bottomClockElement);
    }

    renderClockPosition('w', bottomColor);
    renderClockPosition('b', bottomColor);
    renderClock('w', whiteClockElement, whiteClockTimeElement);
    renderClock('b', blackClockElement, blackClockTimeElement);
  }

  function renderClockPosition(color: Color, bottomColor: Color): void {
    const clockElement = color === 'w' ? whiteClockElement : blackClockElement;
    const isBottom = color === bottomColor;

    clockElement.classList.toggle('is-bottom', isBottom);
    clockElement.classList.toggle('is-top', !isBottom);
  }

  function renderClock(color: Color, clockElement: HTMLElement, timeElement: HTMLElement): void {
    const remainingMs = clockMs[color];
    const isActive = activeClockColor === color && timedOutColor === null;
    const isTimedOut = timedOutColor === color;

    clockElement.classList.toggle('is-active', isActive);
    clockElement.classList.toggle('is-warning', remainingMs <= 30_000);
    clockElement.classList.toggle('is-danger', remainingMs <= 10_000);
    clockElement.classList.toggle('is-timeout', isTimedOut);
    timeElement.textContent = formatClockTime(remainingMs);
  }

  function renderBoard(): void {
    const fragment = document.createDocumentFragment();
    const orientation = getBoardOrientation();
    const files = orientation === 'w' ? BOARD_FILES : BLACK_FILES;
    const ranks = orientation === 'w' ? WHITE_RANKS : BLACK_RANKS;
    const lastMove = getLastMove();

    boardElement.classList.toggle('is-locked', !canUseBoard());

    for (const rank of ranks) {
      for (const file of files) {
        const square = toSquare(file, rank);
        const piece = game.get(square);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = getSquareClasses(square, lastMove);
        button.dataset.square = square;
        button.disabled = !canUseBoard();
        button.setAttribute('role', 'gridcell');
        button.setAttribute('aria-label', getSquareLabel(square, piece));

        if (file === files[0]) {
          button.appendChild(createCoordinate('rank', String(rank)));
        }

        if (rank === ranks[ranks.length - 1]) {
          button.appendChild(createCoordinate('file', file));
        }

        if (piece) {
          const pieceElement = document.createElement('span');
          pieceElement.className = 'piece';
          pieceElement.textContent = PIECE_GLYPHS[piece.color][piece.type];
          button.appendChild(pieceElement);
        }

        fragment.appendChild(button);
      }
    }

    boardElement.replaceChildren(fragment);
  }

  function renderStatus(): void {
    const historyLength = game.history().length;

    statusElement.textContent = getStatusText();
    turnMetaElement.textContent = colorName(game.turn());
    modeMetaElement.textContent =
      mode === 'local'
        ? '로컬 2인'
        : ['AI 상대', `인간 ${colorName(humanColor)}`, presetName(aiSettings.preset)].join(
            TEXT_SEPARATOR,
          );
    moveMetaElement.textContent = [`${game.moveNumber()}수`, `${historyLength} half-move`].join(
      TEXT_SEPARATOR,
    );
  }

  function renderAiCandidateDebug(): void {
    if (mode !== 'ai') {
      aiCandidatePanelElement.hidden = true;
      aiCandidateMetaElement.textContent = '';
      aiInfoStatusElement.textContent = '';
      aiInfoPresetElement.textContent = '';
      aiInfoHumanElement.textContent = '';
      aiInfoDepthElement.textContent = '';
      aiInfoNodesElement.textContent = '';
      aiInfoScoreElement.textContent = '';
      aiCandidateListElement.replaceChildren();
      return;
    }

    const debug = aiProgress?.debug;
    aiCandidatePanelElement.hidden = false;
    aiCandidateMetaElement.textContent = aiProgress
      ? `경과 ${formatSeconds(aiProgress.elapsedMs)}`
      : '';
    aiInfoStatusElement.textContent = getAiInfoStatusText();
    aiInfoPresetElement.textContent = presetName(aiSettings.preset);
    aiInfoHumanElement.textContent = colorName(humanColor);
    aiInfoDepthElement.textContent = aiProgress ? String(aiProgress.depthReached) : '-';
    aiInfoNodesElement.textContent = aiProgress ? `${formatNodes(aiProgress.nodes)} nodes` : '-';
    aiInfoScoreElement.textContent = aiProgress ? formatDebugScore(aiProgress.score) : '-';

    if (!debug || debug.candidates.length === 0) {
      aiCandidateListElement.replaceChildren();
      return;
    }

    aiCandidateMetaElement.textContent = [
      aiCandidateMetaElement.textContent,
      `best ${formatDebugScore(debug.bestScore)}`,
      `창 ${Math.round(debug.windowCp)}`,
      `p ${debug.ticketPower.toFixed(2)}`,
    ].join(TEXT_SEPARATOR);

    const fragment = document.createDocumentFragment();

    for (const candidate of debug.candidates) {
      fragment.appendChild(createAiCandidateRow(candidate));
    }

    aiCandidateListElement.replaceChildren(fragment);
  }

  function getAiInfoStatusText(): string {
    if (game.isGameOver() || timedOutColor !== null) {
      return '대국 종료';
    }

    if (aiThinking) {
      return aiProgress ? '계산 중' : '계산 준비 중';
    }

    return game.turn() === humanColor ? '대기 중' : '응수 대기';
  }

  function createAiCandidateRow(candidate: AiCandidateDebug): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'ai-candidate-row';
    row.classList.toggle('is-selected', candidate.selected);
    row.classList.toggle('is-principal', candidate.principal);
    row.setAttribute('role', 'row');

    const sanCell = createAiCandidateCell('ai-candidate-san', candidate.san);

    if (candidate.selected) {
      sanCell.appendChild(createAiCandidateBadge('선택'));
    }

    if (candidate.principal) {
      sanCell.appendChild(createAiCandidateBadge('최선'));
    }

    row.append(
      sanCell,
      createAiCandidateCell('ai-candidate-score', formatDebugScore(candidate.score)),
      createAiCandidateCell('ai-candidate-weight', formatDebugWeight(candidate.tickets)),
      createAiCandidateCell(
        'ai-candidate-probability',
        formatDebugProbability(candidate.probability),
      ),
    );

    return row;
  }

  function createAiCandidateCell(className: string, text: string): HTMLSpanElement {
    const cell = document.createElement('span');
    cell.className = className;
    cell.setAttribute('role', 'cell');
    cell.textContent = text;

    return cell;
  }

  function createAiCandidateBadge(text: string): HTMLSpanElement {
    const badge = document.createElement('span');
    badge.className = 'ai-candidate-badge';
    badge.textContent = text;

    return badge;
  }

  function renderMoveList(): void {
    const history = game.history({ verbose: true });
    const fragment = document.createDocumentFragment();

    if (history.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'move-empty';
      empty.textContent = '아직 둔 수가 없습니다.';
      fragment.appendChild(empty);
      moveListElement.replaceChildren(fragment);
      return;
    }

    for (let index = 0; index < history.length; index += 2) {
      const row = document.createElement('div');
      const moveNumber = document.createElement('span');
      const whiteMove = document.createElement('span');
      const blackMove = document.createElement('span');

      row.className = 'move-row';
      moveNumber.className = 'move-number';
      whiteMove.className = 'move-san';
      blackMove.className = 'move-san';

      moveNumber.textContent = `${Math.floor(index / 2) + 1}.`;
      whiteMove.textContent = history[index]?.san ?? '';
      blackMove.textContent = history[index + 1]?.san ?? '';

      row.append(moveNumber, whiteMove, blackMove);
      fragment.appendChild(row);
    }

    moveListElement.replaceChildren(fragment);
    moveListElement.scrollTop = moveListElement.scrollHeight;
  }

  function renderPromotionDialog(): void {
    promotionOverlay.hidden = pendingPromotion === null;
    promotionChoices.replaceChildren();

    if (!pendingPromotion) {
      return;
    }

    for (const piece of PROMOTION_PIECES) {
      const button = document.createElement('button');
      button.className = 'promotion-button';
      button.type = 'button';
      button.dataset.promotion = piece;
      button.setAttribute('aria-label', `${pieceName(piece)} 승격`);
      button.textContent = PIECE_GLYPHS[game.turn()][piece];
      promotionChoices.appendChild(button);
    }
  }

  function getSquareClasses(square: Square, lastMove: Move | null): string {
    const squareColor = game.squareColor(square);
    const classes = ['board-square', squareColor === 'light' ? 'is-light' : 'is-dark'];
    const destinationMove = legalMoves.find((move) => move.to === square);

    if (selectedSquare === square) {
      classes.push('is-selected');
    }

    if (destinationMove) {
      classes.push(destinationMove.isCapture() ? 'is-capture' : 'is-legal');
    }

    if (lastMove && (lastMove.from === square || lastMove.to === square)) {
      classes.push('is-last-move');
    }

    if (isCheckedKing(square)) {
      classes.push('is-check');
    }

    return classes.join(' ');
  }

  function getStatusText(): string {
    if (game.isCheckmate()) {
      return `${colorName(oppositeColor(game.turn()))} 체크메이트 승리`;
    }

    if (game.isStalemate()) {
      return '스테일메이트 무승부';
    }

    if (game.isInsufficientMaterial()) {
      return '기물 부족 무승부';
    }

    if (game.isThreefoldRepetition()) {
      return '3회 반복 무승부';
    }

    if (game.isDrawByFiftyMoves()) {
      return '50수 규칙 무승부';
    }

    if (game.isDraw()) {
      return '무승부';
    }

    if (timedOutColor) {
      return [
        `${colorName(timedOutColor)} 시간 초과`,
        `${colorName(oppositeColor(timedOutColor))} 승리`,
      ].join(TEXT_SEPARATOR);
    }

    if (aiThinking) {
      return 'AI 계산 중';
    }

    if (game.isCheck()) {
      return `${colorName(game.turn())} 체크`;
    }

    return `${colorName(game.turn())} 차례`;
  }

  function getBoardOrientation(): Color {
    return mode === 'ai' ? humanColor : game.turn();
  }

  function canUseBoard(): boolean {
    if (game.isGameOver() || timedOutColor !== null || aiThinking || pendingPromotion) {
      return false;
    }

    return mode === 'local' || game.turn() === humanColor;
  }

  function getLastMove(): Move | null {
    return game.history({ verbose: true }).at(-1) ?? null;
  }

  function isCheckedKing(square: Square): boolean {
    const piece = game.get(square);

    return Boolean(piece && piece.type === 'k' && piece.color === game.turn() && game.isCheck());
  }
}

function requireElement<T extends Element>(selector: string, root: ParentNode): T {
  const element = root.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

function getSquareButton(
  target: EventTarget | null,
  boardElement: HTMLElement,
): HTMLButtonElement | null {
  if (!(target instanceof Element)) {
    return null;
  }

  const button = target.closest<HTMLButtonElement>('.board-square');

  return button && boardElement.contains(button) ? button : null;
}

function createCoordinate(type: 'file' | 'rank', label: string): HTMLSpanElement {
  const coordinate = document.createElement('span');
  coordinate.className = `coordinate coordinate-${type}`;
  coordinate.textContent = label;

  return coordinate;
}

function toSquare(file: BoardFile, rank: BoardRank): Square {
  return `${file}${rank}` as Square;
}

function pickWeightedOpeningMove(moves: WeightedOpeningMove[]): AiMoveCommand | null {
  const totalWeight = moves.reduce((total, move) => total + move.weight, 0);

  if (totalWeight <= 0) {
    return null;
  }

  let draw = Math.random() * totalWeight;

  for (const move of moves) {
    draw -= move.weight;

    if (draw <= 0) {
      return { from: move.from, to: move.to, promotion: move.promotion };
    }
  }

  const fallback = moves.at(-1);

  return fallback ? { from: fallback.from, to: fallback.to, promotion: fallback.promotion } : null;
}

function isSquare(value: string | undefined): value is Square {
  return typeof value === 'string' && SQUARE_SET.has(value);
}

function isGameMode(value: string | undefined): value is GameMode {
  return value === 'local' || value === 'ai';
}

function isColor(value: string | undefined): value is Color {
  return value === 'w' || value === 'b';
}

function isPromotionPiece(value: string | undefined): value is PromotionPiece {
  return value === 'q' || value === 'r' || value === 'b' || value === 'n';
}

function isAiPreset(value: string | undefined): value is AiPreset {
  return value === 'easy' || value === 'normal' || value === 'hard';
}

function isClockPreset(value: string | undefined): value is ClockPreset {
  return (
    value === '1/1' || value === '3/2' || value === '5/3' || value === '10/5' || value === '15/10'
  );
}

function toAiDepth(value: number): AiSettings['maxDepth'] {
  return Math.min(5, Math.max(1, Math.round(value)));
}

function createClockState(preset: ClockPreset): Record<Color, number> {
  const baseMs = CLOCK_PRESETS[preset].baseMs;

  return { w: baseMs, b: baseMs };
}

// Opening moves rarely benefit from deep search, so spend less of the clock early
// and ramp back to the full budget by OPENING_FULL_PLY. The ramp is geometric rather
// than linear — the earliest moves are held down harder and the factor accelerates
// toward 1.0 — because deep search has the least marginal value at the very start.
// Castling marks the opening as effectively over (king safety + development done), so
// it returns the full budget immediately, while the ply ramp still covers games where
// castling never happens.
function openingTimeFactor(ply: number, hasCastled: boolean): number {
  if (hasCastled) {
    return 1;
  }

  const progress = Math.min(ply / OPENING_FULL_PLY, 1);

  // Geometric interpolation from OPENING_MIN_FACTOR (progress 0) to 1.0 (progress 1).
  return OPENING_MIN_FACTOR ** (1 - progress);
}

function isSameMoveCommand(move: Move, command: AiMoveCommand): boolean {
  return (
    move.from === command.from &&
    move.to === command.to &&
    (move.promotion ?? undefined) === (command.promotion ?? undefined)
  );
}

function colorName(color: Color): string {
  return color === 'w' ? '백' : '흑';
}

function presetName(preset: AiPreset): string {
  switch (preset) {
    case 'easy':
      return '쉬움';
    case 'normal':
      return '보통';
    case 'hard':
      return '어려움';
  }
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(milliseconds % 1_000 === 0 ? 0 : 2)}초`;
}

function formatClockTime(milliseconds: number): string {
  const safeMilliseconds = Math.max(0, milliseconds);

  if (safeMilliseconds < 10_000) {
    const seconds = (safeMilliseconds / 1_000).toFixed(1).padStart(4, '0');

    return `0:${seconds}`;
  }

  const totalSeconds = Math.ceil(safeMilliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatNodes(nodes: number): string {
  if (nodes >= 1_000_000) {
    return `${Math.round(nodes / 1_000)}k`;
  }

  return String(nodes);
}

function formatDebugScore(score: number): string {
  if (Math.abs(score) >= DEBUG_MATE_SCORE_THRESHOLD) {
    return score > 0 ? '+mate' : '-mate';
  }

  return score > 0 ? `+${Math.round(score)}` : String(Math.round(score));
}

function formatDebugWeight(weight: number): string {
  if (weight === 0) {
    return '0';
  }

  if (weight < 0.001) {
    return '<0.001';
  }

  return weight.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatDebugProbability(probability: number): string {
  const percent = probability * 100;

  if (percent === 0) {
    return '0%';
  }

  if (percent < 0.1) {
    return '<0.1%';
  }

  return `${percent.toFixed(1)}%`;
}

function oppositeColor(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function getSquareLabel(
  square: Square,
  piece: { color: Color; type: PieceSymbol } | undefined,
): string {
  if (!piece) {
    return `${square} 빈 칸`;
  }

  return `${square} ${colorName(piece.color)} ${pieceName(piece.type)}`;
}

function pieceName(piece: PieceSymbol): string {
  switch (piece) {
    case 'p':
      return '폰';
    case 'n':
      return '나이트';
    case 'b':
      return '비숍';
    case 'r':
      return '룩';
    case 'q':
      return '퀸';
    case 'k':
      return '킹';
  }
}
