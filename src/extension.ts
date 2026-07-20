// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { spawn } from 'child_process';

const REPOSITORIES_KEY = 'repograph.repositories';
const ENGINE_COMMAND = 'cgc';

function getRepositories(context: vscode.ExtensionContext): string[] {
	return context.globalState.get<string[]>(REPOSITORIES_KEY, []);
}

function indexRepository(folderPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	return new Promise((resolve, reject) => {
		outputChannel.show(true);
		outputChannel.appendLine(`\n> Indexando: ${folderPath}`);

		// Args passados como array (não concatenados em string) para evitar injeção de comando.
		const child = spawn(ENGINE_COMMAND, ['index', folderPath], { shell: false });

		child.stdout.on('data', (data: Buffer) => outputChannel.append(data.toString()));
		child.stderr.on('data', (data: Buffer) => outputChannel.append(data.toString()));

		child.on('error', (error) => reject(error));

		child.on('close', (code) => {
			if (code === 0) {
				outputChannel.appendLine(`Indexação concluída: ${folderPath}`);
				resolve();
			} else {
				reject(new Error(`cgc index terminou com código ${code}`));
			}
		});
	});
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "repograph" is now active!');

	const outputChannel = vscode.window.createOutputChannel('RepoGraph');
	context.subscriptions.push(outputChannel);

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
		vscode.window.showInformationMessage(`Repositório adicionado: ${folderPath}`);

		try {
			await indexRepository(folderPath, outputChannel);
			vscode.window.showInformationMessage(`Repositório indexado: ${folderPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`Erro ao indexar: ${message}`);
			vscode.window.showErrorMessage(`Falha ao indexar repositório: ${message}`);
		}
	});

	context.subscriptions.push(disposable, addRepository);
}

// This method is called when your extension is deactivated
export function deactivate() {}
