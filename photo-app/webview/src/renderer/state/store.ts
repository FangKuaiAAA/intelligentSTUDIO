// ============================================================
// renderer/state/store.ts — 全局状态存储
// ============================================================

import type { AppState, AppError, AppPhase } from '../../shared/types';

type AppAction =
  | { type: 'SET_PHASE'; phase: AppPhase }
  | { type: 'SET_INPUT_IMAGE'; path: string }
  | { type: 'SET_PLY'; path: string }
  | { type: 'SET_ERROR'; error: AppError }
  | { type: 'CLEAR_ERROR' }
  | { type: 'RESET' };

const initialState: AppState = {
  phase: 'idle',
  inputImagePath: null,
  plyPath: null,
  error: null,
};

class AppStore {
  private state: AppState = { ...initialState };
  private listeners: Array<(s: AppState) => void> = [];

  initialize(): void {
    this.state = { ...initialState };
  }

  getState(): Readonly<AppState> {
    return this.state;
  }

  dispatch(action: AppAction): void {
    switch (action.type) {
      case 'SET_PHASE':
        this.state = { ...this.state, phase: action.phase };
        break;
      case 'SET_INPUT_IMAGE':
        this.state = { ...this.state, inputImagePath: action.path };
        break;
      case 'SET_PLY':
        this.state = { ...this.state, plyPath: action.path };
        break;
      case 'SET_ERROR':
        this.state = { ...this.state, error: action.error };
        break;
      case 'CLEAR_ERROR':
        this.state = { ...this.state, error: null };
        break;
      case 'RESET':
        this.state = { ...initialState };
        break;
    }
    this.listeners.forEach((fn) => fn(this.state));
  }

  subscribe(listener: (s: AppState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}

export const appStore = new AppStore();