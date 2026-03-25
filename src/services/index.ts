/**
 * Singleton service instances — import from here so that both LobbyNamespace
 * and TableNamespace share the same in-memory state (disconnect timers, etc.).
 */
import { TableService } from './TableService';
import { GameService } from './GameService';

export const tableService = new TableService();
export const gameService  = new GameService();
