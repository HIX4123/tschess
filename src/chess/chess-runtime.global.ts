type SharedChessCore = Pick<typeof import('./chess-core.ts'), 'Chess' | 'SQUARES'>;

const sharedGlobal = globalThis as typeof globalThis & {
  TSChessShared?: SharedChessCore;
};

const sharedCore = sharedGlobal.TSChessShared;

if (!sharedCore) {
  throw new Error('Missing shared chess runtime: TSChessShared');
}

export const Chess: SharedChessCore['Chess'] = sharedCore.Chess;
export const SQUARES: SharedChessCore['SQUARES'] = sharedCore.SQUARES;
export type { Color, Move, PieceSymbol, Square } from './chess-core.ts';
