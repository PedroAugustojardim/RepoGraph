// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { spawn } from 'child_process';

const REPOSITORIES_KEY = 'repograph.repositories';
const STATUS_KEY = 'repograph.status';
const ENGINE_COMMAND = 'cgc';

type RepoStatus = 'pending' | 'indexed' | 'error';

function getRepositories(context: vscode.ExtensionContext): string[] {
	return context.globalState.get<string[]>(REPOSITORIES_KEY, []);
}

function getStatuses(context: vscode.ExtensionContext): Record<string, RepoStatus> {
	return context.globalState.get<Record<string, RepoStatus>>(STATUS_KEY, {});
}

async function setStatus(context: vscode.ExtensionContext, folderPath: string, status: RepoStatus): Promise<void> {
	const statuses = getStatuses(context);
	statuses[folderPath] = status;
	await context.globalState.update(STATUS_KEY, statuses);
}

async function clearStatus(context: vscode.ExtensionContext, folderPath: string): Promise<void> {
	const statuses = getStatuses(context);
	delete statuses[folderPath];
	await context.globalState.update(STATUS_KEY, statuses);
}

class RepositoryTreeProvider implements vscode.TreeDataProvider<string> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(folderPath: string): vscode.TreeItem {
		const status = getStatuses(this.context)[folderPath] ?? 'pending';
		const statusLabel = { pending: 'pendente', indexed: 'indexado', error: 'erro' }[status];

		const item = new vscode.TreeItem(folderPath.split(/[\\/]/).pop() ?? folderPath);
		item.description = statusLabel;
		item.tooltip = folderPath;
		item.iconPath = new vscode.ThemeIcon(
			status === 'indexed' ? 'check' : status === 'error' ? 'error' : 'clock',
		);
		return item;
	}

	getChildren(): string[] {
		return getRepositories(this.context);
	}
}

function runEngineCommand(args: string[], outputChannel: vscode.OutputChannel): Promise<void> {
	return new Promise((resolve, reject) => {
		outputChannel.show(true);
		outputChannel.appendLine(`\n> cgc ${args.join(' ')}`);

		// Args passados como array (não concatenados em string) para evitar injeção de comando.
		// PYTHONIOENCODING força UTF-8 na saída do processo Python: sem isso, no Windows,
		// stdout redirecionado (pipe) cai para a codepage ANSI do sistema e o CLI trava com
		// UnicodeEncodeError ao imprimir emojis/símbolos nas mensagens.
		const child = spawn(ENGINE_COMMAND, args, {
			shell: false,
			env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
		});
		let stderrOutput = '';

		child.stdout.on('data', (data: Buffer) => outputChannel.append(data.toString()));
		child.stderr.on('data', (data: Buffer) => {
			stderrOutput += data.toString();
			outputChannel.append(data.toString());
		});

		child.on('error', (error) => reject(error));

		child.on('close', (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(stderrOutput.trim() || `cgc ${args[0]} terminou com código ${code}`));
			}
		});
	});
}

async function indexRepository(folderPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	await runEngineCommand(['index', folderPath], outputChannel);
	outputChannel.appendLine(`Indexação concluída: ${folderPath}`);
}

async function deleteRepositoryIndex(folderPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	await runEngineCommand(['delete', folderPath], outputChannel);
	outputChannel.appendLine(`Índice removido do code graph: ${folderPath}`);
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "repograph" is now active!');

	const outputChannel = vscode.window.createOutputChannel('RepoGraph');
	context.subscriptions.push(outputChannel);

	const treeProvider = new RepositoryTreeProvider(context);
	context.subscriptions.push(vscode.window.registerTreeDataProvider('repograph.repositoriesView', treeProvider));

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('repograph.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from RepoGraph!');
	});

	const addRepository = vscode.commands.registerCommand('repograph.addRepository', async () => {
		const selection = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Adicionar repositório',
		});

		if (!selection || selection.length === 0) {
			return;
		}

		const folderPath = selection[0].fsPath;
		const repositories = getRepositories(context);

		if (repositories.includes(folderPath)) {
			vscode.window.showInformationMessage(`Repositório já cadastrado: ${folderPath}`);
			return;
		}

		await context.globalState.update(REPOSITORIES_KEY, [...repositories, folderPath]);
		await setStatus(context, folderPath, 'pending');
		treeProvider.refresh();
		vscode.window.showInformationMessage(`Repositório adicionado: ${folderPath}`);

		try {
			await indexRepository(folderPath, outputChannel);
			await setStatus(context, folderPath, 'indexed');
			vscode.window.showInformationMessage(`Repositório indexado: ${folderPath}`);
		} catch (error) {
			await setStatus(context, folderPath, 'error');
			const message = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`Erro ao indexar: ${message}`);
			vscode.window.showErrorMessage(`Falha ao indexar repositório: ${message}`);
		} finally {
			treeProvider.refresh();
		}
	});

	const removeRepository = vscode.commands.registerCommand('repograph.removeRepository', async () => {
		const repositories = getRepositories(context);

		if (repositories.length === 0) {
			vscode.window.showInformationMessage('Nenhum repositório cadastrado.');
			return;
		}

		const folderPath = await vscode.window.showQuickPick(repositories, {
			placeHolder: 'Escolha o repositório para remover',
		});

		if (!folderPath) {
			return;
		}

		await context.globalState.update(
			REPOSITORIES_KEY,
			repositories.filter((repo) => repo !== folderPath),
		);
		await clearStatus(context, folderPath);
		treeProvider.refresh();
		vscode.window.showInformationMessage(`Repositório removido da lista: ${folderPath}`);

		try {
			await deleteRepositoryIndex(folderPath, outputChannel);
			vscode.window.showInformationMessage(`Índice removido do code graph: ${folderPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`Aviso: não foi possível remover o índice: ${message}`);
			vscode.window.showWarningMessage(
				`Repositório removido da lista, mas o índice não pôde ser apagado do code graph: ${message}`,
			);
		}
	});

	const configureMcp = vscode.commands.registerCommand('repograph.configureMcp', () => {
		// O motor já fala MCP sozinho (um único servidor cobre todos os repositórios
		// indexados), então aqui só orientamos o assistente oficial de configuração
		// em vez de reescrever a lógica de detecção de cliente (VS Code, Cursor, etc.).
		const terminal = vscode.window.createTerminal('RepoGraph MCP Setup');
		terminal.show();
		terminal.sendText(`${ENGINE_COMMAND} mcp setup`);
	});

	context.subscriptions.push(disposable, addRepository, removeRepository, configureMcp);
}

// This method is called when your extension is deactivated
export function deactivate() {}
