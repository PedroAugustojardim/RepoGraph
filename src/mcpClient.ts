// Cliente JSON-RPC por stdio para o servidor MCP do motor (`cgc mcp start`).
//
// O protocolo do servidor (ver codegraphcontext/server.py) é um JSON por linha em
// stdin/stdout (não é o framing Content-Length usado por LSP), processado de forma
// sequencial (uma requisição por vez). Por isso a implementação é feita à mão em
// vez de usar 'vscode-jsonrpc' — a superfície real é pequena (initialize,
// notifications/initialized, tools/call) e a lib exigiria um reader/writer
// customizado de qualquer forma para lidar com o framing por linha.
//
// Este módulo não depende de 'vscode' para poder ser testado com um processo
// Node de fixture, sem precisar do harness de extensão.

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as readline from 'readline';
import { friendlyEngineError } from './engineErrors';

export interface McpOutputSink {
	appendLine(line: string): void;
}

export interface McpClientOptions {
	command: string;
	args?: string[];
	cwd: string;
	allowedRoots: string[];
	outputChannel: McpOutputSink;
	/** Timeout do handshake inicial. O motor tenta destravar o banco com retry/backoff
	 * por até ~15.5s antes de desistir, então isso precisa ser generoso. */
	handshakeTimeoutMs?: number;
	/** Timeout por chamada de tool individual. */
	toolCallTimeoutMs?: number;
	/** Tempo de espera após stdin.end() antes de forçar kill(). */
	shutdownTimeoutMs?: number;
}

export interface McpExitInfo {
	code: number | null;
	expected: boolean;
	stderrTail: string;
}

export interface Disposable {
	dispose(): void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 25_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const STDERR_TAIL_LIMIT = 4_000;

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface JsonRpcResponse {
	jsonrpc: string;
	id?: string | number | null;
	result?: { content?: Array<{ type: string; text: string }> };
	error?: { code: number; message: string; data?: unknown };
}

export class McpClient {
	private readonly options: Required<Omit<McpClientOptions, 'args'>> & { args: string[] };
	private child: ChildProcessWithoutNullStreams | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly exitListeners = new Set<(info: McpExitInfo) => void>();
	private stderrTail = '';
	private expectedExit = false;
	private started = false;

	constructor(options: McpClientOptions) {
		this.options = {
			command: options.command,
			args: options.args ?? ['mcp', 'start'],
			cwd: options.cwd,
			allowedRoots: [...options.allowedRoots],
			outputChannel: options.outputChannel,
			handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
			toolCallTimeoutMs: options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
			shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
		};
	}

	get allowedRoots(): ReadonlySet<string> {
		return new Set(this.options.allowedRoots);
	}

	get isAlive(): boolean {
		return this.started && this.child !== undefined && this.child.exitCode === null && !this.child.killed;
	}

	onDidExit(listener: (info: McpExitInfo) => void): Disposable {
		this.exitListeners.add(listener);
		return { dispose: () => this.exitListeners.delete(listener) };
	}

	async start(): Promise<void> {
		if (this.started) {
			throw new Error('McpClient já foi iniciado. Crie uma nova instância para reiniciar.');
		}
		this.started = true;

		const separator = process.platform === 'win32' ? ';' : ':';
		const child = spawn(this.options.command, this.options.args, {
			shell: false,
			cwd: this.options.cwd,
			env: {
				...process.env,
				PYTHONIOENCODING: 'utf-8',
				CGC_ALLOWED_ROOTS: this.options.allowedRoots.join(separator),
			},
		});
		this.child = child;

		const rl = readline.createInterface({ input: child.stdout });
		rl.on('line', (line) => this.handleLine(line));

		child.stderr.on('data', (data: Buffer) => {
			const text = data.toString();
			this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_LIMIT);
			this.options.outputChannel.appendLine(text.trimEnd());
		});

		let settleStart: ((error?: Error) => void) | undefined;
		const startResult = new Promise<void>((resolve, reject) => {
			settleStart = (error) => (error ? reject(error) : resolve());
		});

		child.on('error', (error) => {
			settleStart?.(error);
			settleStart = undefined;
			this.handleExit(null);
		});

		child.on('close', (code) => {
			if (settleStart) {
				settleStart(new Error(friendlyEngineError(this.stderrTail) || `cgc mcp start terminou com código ${code}.`));
				settleStart = undefined;
			}
			this.handleExit(code);
		});

		try {
			await this.handshake(startResult);
		} catch (error) {
			// Handshake falhou (timeout ou o processo morreu antes de responder).
			// Mata o processo se ainda estiver vivo (ex: timeout com processo travado)
			// para não vazar um `cgc mcp start` órfão segurando o lock do banco.
			this.expectedExit = true;
			this.child?.kill();
			throw error;
		} finally {
			settleStart = undefined;
		}
	}

	private async handshake(startResult: Promise<void>): Promise<void> {
		const initializeRequest = this.sendRequest('initialize', {
			protocolVersion: '2025-03-26',
			capabilities: {},
			clientInfo: { name: 'repograph-vscode', version: '0.1.0' },
		});

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(
				() => reject(new Error('Tempo limite excedido ao conectar ao motor (cgc mcp start).')),
				this.options.handshakeTimeoutMs,
			);
		});

		// `startResult` só REJEITA (nunca resolve) quando o processo morre antes/durante
		// o handshake — por isso pode entrar direto na race junto com o timeout e o
		// `initialize`, sem precisar de Promise.all: a corrida termina assim que o
		// primeiro dos três se decidir.
		try {
			await Promise.race([initializeRequest, startResult, timeout]);
		} finally {
			clearTimeout(timeoutHandle);
		}
		this.sendNotification('notifications/initialized');
	}

	async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
		if (!this.isAlive) {
			throw new Error('A conexão com o motor (cgc mcp start) não está ativa.');
		}
		const raw = await this.sendRequest('tools/call', { name, arguments: args }, this.options.toolCallTimeoutMs);
		const response = raw as JsonRpcResponse;
		return this.unwrapToolResult<T>(response);
	}

	private unwrapToolResult<T>(response: JsonRpcResponse): T {
		if (response.error) {
			const data = response.error.data as { error?: string } | undefined;
			throw new Error(data?.error ?? response.error.message ?? 'Erro desconhecido do motor.');
		}
		const text = response.result?.content?.[0]?.text;
		if (typeof text !== 'string') {
			throw new Error('Resposta inesperada do motor (formato de conteúdo ausente).');
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new Error('Não foi possível interpretar a resposta do motor.');
		}
	}

	async shutdown(): Promise<void> {
		if (!this.child || !this.isAlive) {
			return;
		}
		this.expectedExit = true;
		const child = this.child;

		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill();
				resolve();
			}, this.options.shutdownTimeoutMs);
			child.once('close', () => {
				clearTimeout(timer);
				resolve();
			});
			child.stdin.end();
		});
	}

	private sendRequest(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
		if (!this.child) {
			return Promise.reject(new Error('A conexão com o motor (cgc mcp start) não está ativa.'));
		}
		const id = this.nextId++;
		const child = this.child;

		return new Promise<unknown>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (fn: () => void) => {
				if (timer) {
					clearTimeout(timer);
				}
				this.pending.delete(id);
				fn();
			};

			this.pending.set(id, {
				resolve: (value) => settle(() => resolve(value)),
				reject: (error) => settle(() => reject(error)),
			});

			if (timeoutMs) {
				timer = setTimeout(() => {
					const entry = this.pending.get(id);
					entry?.reject(new Error(`Tempo limite excedido aguardando resposta de '${method}'.`));
				}, timeoutMs);
			}

			const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
			try {
				child.stdin.write(payload);
			} catch (error) {
				this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private sendNotification(method: string, params: Record<string, unknown> = {}): void {
		if (!this.child) {
			return;
		}
		const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
		try {
			this.child.stdin.write(payload);
		} catch {
			// Notificações não têm resposta esperada; se o processo já morreu,
			// o handler de 'close' já vai cuidar de reportar o problema.
		}
	}

	private handleLine(line: string): void {
		if (!line.trim()) {
			return;
		}
		let response: JsonRpcResponse;
		try {
			response = JSON.parse(line);
		} catch {
			// Não deveria acontecer (o console Rich do motor escreve em stderr, não
			// stdout), mas se acontecer não deve derrubar o client — só registrar.
			this.options.outputChannel.appendLine(`[mcp] linha não-JSON ignorada: ${line}`);
			return;
		}
		if (response.id === undefined || response.id === null) {
			return;
		}
		const id = typeof response.id === 'string' ? Number(response.id) : response.id;
		const entry = this.pending.get(id);
		if (entry) {
			entry.resolve(response);
		}
	}

	private handleExit(code: number | null): void {
		if (!this.started) {
			return;
		}
		const info: McpExitInfo = { code, expected: this.expectedExit, stderrTail: this.stderrTail };
		for (const [, entry] of this.pending) {
			entry.reject(new Error(friendlyEngineError(this.stderrTail) || 'A conexão com o motor foi encerrada.'));
		}
		this.pending.clear();
		for (const listener of this.exitListeners) {
			listener(info);
		}
	}
}
