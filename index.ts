/**
 * 2048 for pi
 *
 * Usage:
 *   /play-2048    Open 2048 in a same-window overlay
 *
 * The current board is saved to ~/.pi/agent/state/2048-save.json,
 * so you can reopen it and keep playing.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type Direction = "up" | "down" | "left" | "right";

type Board = number[][];

interface GameState {
	board: Board;
	score: number;
	highScore: number;
	won: boolean;
	gameOver: boolean;
}

interface MoveOverlay {
	direction: Direction;
	sourceCells: Set<string>;
	destinationCells: Set<string>;
	mergedCells: Set<string>;
}

interface AnimatedTile {
	value: number;
	fromRow: number;
	fromCol: number;
	toRow: number;
	toCol: number;
	merged?: boolean;
}

interface MoveAnimation {
	direction: Direction;
	baseBoard: Board;
	movingTiles: AnimatedTile[];
	startedAt: number;
	durationMs: number;
}

const SAVE_TYPE = "2048-save";
const BOARD_SIZE = 4;
const SAVE_FILE = join(homedir(), ".pi", "agent", "state", "2048-save.json");

let gameOpen = false;

function emptyBoard(): Board {
	return Array.from({ length: BOARD_SIZE }, () =>
		Array.from({ length: BOARD_SIZE }, () => 0),
	);
}

function cloneBoard(board: Board): Board {
	return board.map((row) => [...row]);
}

function maxTile(board: Board): number {
	return Math.max(...board.flat(), 0);
}

function getEmptyCells(board: Board): Array<{ row: number; col: number }> {
	const cells: Array<{ row: number; col: number }> = [];
	for (let row = 0; row < BOARD_SIZE; row++) {
		for (let col = 0; col < BOARD_SIZE; col++) {
			if (board[row]?.[col] === 0) {
				cells.push({ row, col });
			}
		}
	}
	return cells;
}

function spawnTile(board: Board): { row: number; col: number } | undefined {
	const empties = getEmptyCells(board);
	if (empties.length === 0) return undefined;
	const choice = empties[Math.floor(Math.random() * empties.length)]!;
	board[choice.row]![choice.col] = Math.random() < 0.9 ? 2 : 4;
	return choice;
}

function createInitialState(highScore = 0): GameState {
	const board = emptyBoard();
	spawnTile(board);
	spawnTile(board);
	return {
		board,
		score: 0,
		highScore,
		won: false,
		gameOver: false,
	};
}

function lineForDirection(
	board: Board,
	direction: Direction,
	index: number,
): number[] {
	switch (direction) {
		case "left":
			return [...board[index]!];
		case "right":
			return [...board[index]!].reverse();
		case "up":
			return board.map((row) => row[index]!);
		case "down":
			return board.map((row) => row[index]!).reverse();
	}
}

function writeLineForDirection(
	board: Board,
	direction: Direction,
	index: number,
	line: number[],
): void {
	switch (direction) {
		case "left":
			for (let col = 0; col < BOARD_SIZE; col++)
				board[index]![col] = line[col]!;
			return;
		case "right": {
			const reversed = [...line].reverse();
			for (let col = 0; col < BOARD_SIZE; col++)
				board[index]![col] = reversed[col]!;
			return;
		}
		case "up":
			for (let row = 0; row < BOARD_SIZE; row++)
				board[row]![index] = line[row]!;
			return;
		case "down": {
			const reversed = [...line].reverse();
			for (let row = 0; row < BOARD_SIZE; row++)
				board[row]![index] = reversed[row]!;
			return;
		}
	}
}

function collapseLine(line: number[]): {
	line: number[];
	moved: boolean;
	gained: number;
} {
	const compact = line.filter((value) => value !== 0);
	const merged: number[] = [];
	let gained = 0;

	for (let i = 0; i < compact.length; i++) {
		const current = compact[i]!;
		const next = compact[i + 1];
		if (next === current) {
			const value = current * 2;
			merged.push(value);
			gained += value;
			i++;
		} else {
			merged.push(current);
		}
	}

	while (merged.length < BOARD_SIZE) merged.push(0);

	return {
		line: merged,
		moved: merged.some((value, index) => value !== line[index]),
		gained,
	};
}

function coordForDirection(
	direction: Direction,
	index: number,
	offset: number,
): { row: number; col: number } {
	switch (direction) {
		case "left":
			return { row: index, col: offset };
		case "right":
			return { row: index, col: BOARD_SIZE - 1 - offset };
		case "up":
			return { row: offset, col: index };
		case "down":
			return { row: BOARD_SIZE - 1 - offset, col: index };
	}
}

function keyForCell(row: number, col: number): string {
	return `${row},${col}`;
}

function planMove(
	board: Board,
	direction: Direction,
): {
	moved: boolean;
	gained: number;
	collapsedBoard: Board;
	animationBaseBoard: Board;
	movingTiles: AnimatedTile[];
	overlay?: MoveOverlay;
} {
	const collapsedBoard = emptyBoard();
	const animationBaseBoard = emptyBoard();
	const movingTiles: AnimatedTile[] = [];
	const sourceCells = new Set<string>();
	const destinationCells = new Set<string>();
	const mergedCells = new Set<string>();
	let moved = false;
	let gained = 0;

	for (let index = 0; index < BOARD_SIZE; index++) {
		const line = lineForDirection(board, direction, index);
		const compact = line
			.map((value, offset) => ({ value, offset }))
			.filter((entry) => entry.value !== 0);
		let outOffset = 0;

		for (let i = 0; i < compact.length; i++) {
			const current = compact[i]!;
			const next = compact[i + 1];
			const dest = coordForDirection(direction, index, outOffset);
			const destKey = keyForCell(dest.row, dest.col);

			if (next && next.value === current.value) {
				const mergedValue = current.value * 2;
				gained += mergedValue;
				collapsedBoard[dest.row]![dest.col] = mergedValue;
				destinationCells.add(destKey);
				mergedCells.add(destKey);

				for (const sourceOffset of [current.offset, next.offset]) {
					const source = coordForDirection(direction, index, sourceOffset);
					sourceCells.add(keyForCell(source.row, source.col));
					movingTiles.push({
						value: current.value,
						fromRow: source.row,
						fromCol: source.col,
						toRow: dest.row,
						toCol: dest.col,
						merged: true,
					});
				}
				moved = true;
				i++;
				outOffset++;
				continue;
			}

			const source = coordForDirection(direction, index, current.offset);
			collapsedBoard[dest.row]![dest.col] = current.value;
			if (current.offset === outOffset) {
				animationBaseBoard[dest.row]![dest.col] = current.value;
			} else {
				moved = true;
				sourceCells.add(keyForCell(source.row, source.col));
				destinationCells.add(destKey);
				movingTiles.push({
					value: current.value,
					fromRow: source.row,
					fromCol: source.col,
					toRow: dest.row,
					toCol: dest.col,
				});
			}
			outOffset++;
		}
	}

	return {
		moved,
		gained,
		collapsedBoard,
		animationBaseBoard,
		movingTiles,
		overlay: moved
			? { direction, sourceCells, destinationCells, mergedCells }
			: undefined,
	};
}

function hasMoves(board: Board): boolean {
	if (getEmptyCells(board).length > 0) return true;

	for (let row = 0; row < BOARD_SIZE; row++) {
		for (let col = 0; col < BOARD_SIZE; col++) {
			const value = board[row]?.[col];
			if (value === board[row]?.[col + 1] || value === board[row + 1]?.[col]) {
				return true;
			}
		}
	}

	return false;
}

function applyMove(
	state: GameState,
	direction: Direction,
): { state: GameState; overlay?: MoveOverlay; animation?: MoveAnimation } {
	const plan = planMove(state.board, direction);
	if (!plan.moved) return { state };

	const board = cloneBoard(plan.collapsedBoard);
	spawnTile(board);
	const score = state.score + plan.gained;
	const highScore = Math.max(state.highScore, score);
	const won = state.won || maxTile(board) >= 2048;
	const gameOver = !hasMoves(board);

	return {
		state: {
			board,
			score,
			highScore,
			won,
			gameOver,
		},
		overlay: plan.overlay,
		animation: {
			direction,
			baseBoard: plan.animationBaseBoard,
			movingTiles: plan.movingTiles,
			startedAt: Date.now(),
			durationMs: 150,
		},
	};
}

function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function centerVisible(text: string, width: number): string {
	const remaining = Math.max(0, width - visibleWidth(text));
	const left = Math.floor(remaining / 2);
	const right = remaining - left;
	return " ".repeat(left) + text + " ".repeat(right);
}

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

function fg256(code: number, text: string): string {
	return `\x1b[38;5;${code}m${text}\x1b[39m`;
}

function bg256(code: number, text: string): string {
	return `\x1b[48;5;${code}m${text}\x1b[49m`;
}

function tileColors(value: number): { bg: number; fg: number } {
	const palette: Record<number, { bg: number; fg: number }> = {
		0: { bg: 236, fg: 244 },
		2: { bg: 230, fg: 235 },
		4: { bg: 223, fg: 235 },
		8: { bg: 215, fg: 231 },
		16: { bg: 209, fg: 231 },
		32: { bg: 203, fg: 231 },
		64: { bg: 221, fg: 235 },
		128: { bg: 149, fg: 235 },
		256: { bg: 114, fg: 235 },
		512: { bg: 75, fg: 231 },
		1024: { bg: 69, fg: 231 },
		2048: { bg: 141, fg: 231 },
	};
	return palette[value] ?? { bg: 177, fg: 231 };
}

function styleTile(value: number, text: string): string {
	const colors = tileColors(value);
	return bg256(colors.bg, fg256(colors.fg, text));
}

function styleTileChar(
	value: number,
	char: string,
	emphasized = false,
): string {
	const colors = tileColors(value);
	const content = emphasized && char.trim() ? bold(char) : char;
	return bg256(colors.bg, fg256(colors.fg, content));
}

function renderTileSegments(
	value: number,
	label: string,
	width: number,
): string[][] {
	const middle = centerVisible(label, width);
	return [
		Array.from({ length: width }, () => styleTileChar(value, " ")),
		Array.from(middle).map((char) => styleTileChar(value, char, true)),
		Array.from({ length: width }, () => styleTileChar(value, " ")),
	];
}

function renderAnimatedBoardLines(
	animation: MoveAnimation,
	progress: number,
	tileWidth: number,
	tileGap: string,
): string[] {
	const strideX = tileWidth + visibleWidth(tileGap);
	const strideY = 4;
	const boardWidth =
		tileWidth * BOARD_SIZE + visibleWidth(tileGap) * (BOARD_SIZE - 1);
	const boardHeight = BOARD_SIZE * 3 + (BOARD_SIZE - 1);
	const canvas: string[][] = Array.from({ length: boardHeight }, () =>
		Array.from({ length: boardWidth }, () => " "),
	);

	const drawTile = (value: number, row: number, col: number, label: string) => {
		const top = Math.round(row);
		const left = Math.round(col);
		const tile = renderTileSegments(value, label, tileWidth);
		for (let y = 0; y < tile.length; y++) {
			const canvasRow = canvas[top + y];
			if (!canvasRow) continue;
			for (let x = 0; x < tile[y]!.length; x++) {
				const canvasCol = left + x;
				if (canvasCol < 0 || canvasCol >= boardWidth) continue;
				canvasRow[canvasCol] = tile[y]![x]!;
			}
		}
	};

	for (let row = 0; row < BOARD_SIZE; row++) {
		for (let col = 0; col < BOARD_SIZE; col++) {
			const value = animation.baseBoard[row]![col]!;
			drawTile(
				value,
				row * strideY,
				col * strideX,
				value === 0 ? "·" : String(value),
			);
		}
	}

	for (const tile of animation.movingTiles) {
		const eased = 1 - (1 - progress) * (1 - progress);
		const row = (tile.fromRow + (tile.toRow - tile.fromRow) * eased) * strideY;
		const col = (tile.fromCol + (tile.toCol - tile.fromCol) * eased) * strideX;
		drawTile(tile.value, row, col, String(tile.value));
	}

	return canvas.map((row) => row.join(""));
}

class Game2048Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private moveOverlay?: MoveOverlay;
	private moveOverlayTimer?: ReturnType<typeof setTimeout>;
	private animation?: MoveAnimation;
	private animationTimer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: { requestRender: () => void },
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly onSave: (state: GameState) => void,
		private state: GameState,
	) {}

	private clearMotionState(): void {
		if (this.moveOverlayTimer) clearTimeout(this.moveOverlayTimer);
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.moveOverlayTimer = undefined;
		this.animationTimer = undefined;
		this.animation = undefined;
		this.moveOverlay = undefined;
	}

	private startAnimation(
		animation: MoveAnimation,
		overlay?: MoveOverlay,
	): void {
		this.animation = animation;
		this.moveOverlay = undefined;
		if (this.moveOverlayTimer) clearTimeout(this.moveOverlayTimer);
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.animationTimer = setInterval(() => {
			const progress = Math.min(
				1,
				(Date.now() - animation.startedAt) / animation.durationMs,
			);
			if (progress >= 1) {
				if (this.animationTimer) clearInterval(this.animationTimer);
				this.animationTimer = undefined;
				this.animation = undefined;
				this.moveOverlay = overlay;
				if (overlay) {
					if (this.moveOverlayTimer) clearTimeout(this.moveOverlayTimer);
					this.moveOverlayTimer = setTimeout(() => {
						this.moveOverlay = undefined;
						this.invalidate();
						this.tui.requestRender();
					}, 220);
				}
			}
			this.invalidate();
			this.tui.requestRender();
		}, 33);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.clearMotionState();
			this.onSave(this.state);
			this.done();
			return;
		}

		if (data === "n" || data === "N" || data === "r" || data === "R") {
			this.clearMotionState();
			this.state = createInitialState(this.state.highScore);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		let direction: Direction | undefined;
		if (
			matchesKey(data, "up") ||
			data === "w" ||
			data === "W" ||
			data === "k" ||
			data === "K"
		) {
			direction = "up";
		} else if (
			matchesKey(data, "down") ||
			data === "s" ||
			data === "S" ||
			data === "j" ||
			data === "J"
		) {
			direction = "down";
		} else if (
			matchesKey(data, "left") ||
			data === "a" ||
			data === "A" ||
			data === "h" ||
			data === "H"
		) {
			direction = "left";
		} else if (
			matchesKey(data, "right") ||
			data === "d" ||
			data === "D" ||
			data === "l" ||
			data === "L"
		) {
			direction = "right";
		}

		if (!direction || this.state.gameOver || this.animation) return;

		const result = applyMove(this.state, direction);
		if (result.state !== this.state) {
			this.state = result.state;
			if (result.animation) {
				this.startAnimation(result.animation, result.overlay);
			} else {
				this.moveOverlay = result.overlay;
			}
			this.invalidate();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		const theme = this.theme;
		const innerWidth = Math.max(20, width - 2);
		const lines: string[] = [];
		const dim = (s: string) => theme.fg("dim", s);
		const muted = (s: string) => theme.fg("muted", s);
		const accent = (s: string) => theme.fg("accent", s);
		const success = (s: string) => theme.fg("success", s);
		const error = (s: string) => theme.fg("error", s);
		const text = (s: string) => theme.fg("text", s);
		const row = (content = "") => padVisible(content, innerWidth);
		const tileWidth = 10;
		const tileGap = "  ";
		const boardWidth =
			tileWidth * BOARD_SIZE + visibleWidth(tileGap) * (BOARD_SIZE - 1);

		const chip = (
			label: string,
			value: string,
			tone: "selectedBg" | "toolPendingBg" = "selectedBg",
		) => theme.bg(tone, ` ${dim(label)} ${bold(value)} `);

		const isMerged = (row: number, col: number) => {
			if (!this.moveOverlay) return false;
			return this.moveOverlay.mergedCells.has(keyForCell(row, col));
		};
		const tileCell = (
			value: number,
			content: string,
			row: number,
			col: number,
		): string => {
			let display = content;
			if (isMerged(row, col) && content.trim()) {
				display = success("✦") + (value === 0 ? "" : " " + bold(String(value)));
			}
			return styleTile(value, centerVisible(display, tileWidth));
		};
		const boardLines: string[] = this.animation
			? renderAnimatedBoardLines(
					this.animation,
					Math.min(
						1,
						(Date.now() - this.animation.startedAt) / this.animation.durationMs,
					),
					tileWidth,
					tileGap,
				)
			: (() => {
					const lines: string[] = [];
					for (let rowIndex = 0; rowIndex < BOARD_SIZE; rowIndex++) {
						const values = this.state.board[rowIndex]!;
						lines.push(
							values
								.map((value, colIndex) =>
									tileCell(value, "", rowIndex, colIndex),
								)
								.join(tileGap),
						);
						lines.push(
							values
								.map((value, colIndex) =>
									tileCell(
										value,
										value === 0 ? dim("·") : bold(String(value)),
										rowIndex,
										colIndex,
									),
								)
								.join(tileGap),
						);
						lines.push(
							values
								.map((value, colIndex) =>
									tileCell(value, "", rowIndex, colIndex),
								)
								.join(tileGap),
						);
						if (rowIndex < BOARD_SIZE - 1) lines.push("");
					}
					return lines;
				})();

		const title = `${bold(accent("2048"))} ${muted("for when pi is thinking")}`;
		const statLine = `${chip("score", String(this.state.score))}  ${chip("best", String(this.state.highScore))}  ${chip("tile", String(maxTile(this.state.board) || 0), "toolPendingBg")}`;

		let status = muted("Merge matching tiles. First one to 2048 wins.");
		if (this.animation) {
			status = muted("Sliding tiles...");
		} else if (this.moveOverlay) {
			status = muted("Recent merge highlighted.");
		}
		if (this.state.gameOver && !this.animation) {
			status = error(
				`${bold("No moves left.")} Press ${bold("N")} to start fresh.`,
			);
		} else if (this.state.won) {
			status = success(
				`${bold("2048 reached.")} You can keep going or press ${bold("N")}.`,
			);
		}

		if (innerWidth < boardWidth) {
			this.cachedLines = [
				row(""),
				row(centerVisible(accent(bold("2048")), innerWidth)),
				row(""),
				row(
					centerVisible(dim("Window is too narrow for the board."), innerWidth),
				),
				row(centerVisible(dim("Widen pi or close with Q / Esc."), innerWidth)),
			];
			this.cachedWidth = width;
			return this.cachedLines;
		}

		lines.push(row(""));
		lines.push(row(centerVisible(title, innerWidth)));
		lines.push(row(""));
		lines.push(row(centerVisible(statLine, innerWidth)));
		lines.push(row(""));
		for (const boardLine of boardLines) {
			lines.push(row(centerVisible(boardLine, innerWidth)));
		}
		lines.push(row(""));
		lines.push(row(centerVisible(status, innerWidth)));
		lines.push(
			row(
				centerVisible(
					text(
						`Move ${bold("← ↑ ↓ →")} or ${bold("WASD")} • ${bold("N")} new game • ${bold("Q / Esc")} close`,
					),
					innerWidth,
				),
			),
		);
		lines.push(row(""));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.clearMotionState();
	}
}

function isGameState(value: unknown): value is GameState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as GameState;
	return (
		Array.isArray(candidate.board) &&
		typeof candidate.score === "number" &&
		typeof candidate.highScore === "number"
	);
}

function persistSavedState(state: GameState): void {
	mkdirSync(dirname(SAVE_FILE), { recursive: true });
	writeFileSync(SAVE_FILE, JSON.stringify(state, null, 2));
}

function loadSavedState(ctx: ExtensionContext): GameState {
	if (existsSync(SAVE_FILE)) {
		try {
			const parsed = JSON.parse(readFileSync(SAVE_FILE, "utf8"));
			if (isGameState(parsed)) return parsed;
		} catch {
			// fall through to session state
		}
	}

	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "custom" && entry.customType === SAVE_TYPE) {
			return entry.data as GameState;
		}
	}
	return createInitialState();
}

async function openGame(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<void> {
	if (!ctx.hasUI) return;
	if (gameOpen) {
		ctx.ui.notify("2048 is already open", "info");
		return;
	}

	gameOpen = true;
	const savedState = loadSavedState(ctx);
	persistSavedState(savedState);

	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new Game2048Component(
					{ requestRender: () => tui.requestRender() },
					theme,
					() => done(),
					(state) => {
						persistSavedState(state);
						pi.appendEntry(SAVE_TYPE, state);
					},
					savedState,
				),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: 58,
					minWidth: 58,
					margin: 1,
					visible: (termWidth, termHeight) =>
						termWidth >= 60 && termHeight >= 18,
				},
			},
		);
	} finally {
		gameOpen = false;
	}
}

export default function (pi: ExtensionAPI) {
	const setHint = (ctx: ExtensionContext, working: boolean) => {
		if (!ctx.hasUI) return;
		const label = working
			? ctx.ui.theme.fg("accent", "⌛ 2048")
			: ctx.ui.theme.fg("dim", "2048");
		ctx.ui.setStatus("2048", label);
	};

	pi.on("session_start", async (_event, ctx) => {
		setHint(ctx, false);
	});

	pi.on("agent_start", async (_event, ctx) => {
		setHint(ctx, true);
	});

	pi.on("agent_end", async (_event, ctx) => {
		setHint(ctx, false);
	});

	pi.registerCommand("play-2048", {
		description: "Open 2048 in an in-app overlay",
		handler: async (_args, ctx) => {
			await openGame(ctx, pi);
		},
	});
}
