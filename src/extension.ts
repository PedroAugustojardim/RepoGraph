// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

const REPOSITORIES_KEY = 'repograph.repositories';

function getRepositories(context: vscode.ExtensionContext): string[] {
	return context.globalState.get<string[]>(REPOSITORIES_KEY, []);
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "repograph" is now active!');

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
	});

	context.subscriptions.push(disposable, addRepository);
}

// This method is called when your extension is deactivated
export function deactivate() {}
