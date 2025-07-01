// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import fs from "fs";
import path from "path";
import vscode from "vscode";

const packageId: string = "vscode-ext-show-translation";
const cfgFileName: string = "config.json";
const cfgRootDir: string = ".vscode";
const defaultVariableNames: string[] = ["this._translate", "_translate"];
const defaultLanguages: string[] = ["typescript", "html"];
const jsonCache: Record<string, any> = {};
const jsonWatchers: Record<string, vscode.FileSystemWatcher> = {};

interface ConfigInterface {
  variableNames: string[];
  workInFiles: string[];
  paths: string[];
}

let currentConfig: ConfigInterface = {
  variableNames: defaultVariableNames,
  workInFiles: defaultLanguages,
  paths: [],
};

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext): void {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated

  watchConfigFile(context);

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  registerCommand(context);
  registerHover(context);
  registerCompletionItem(context);
  registerDefinition(context);
}

// This method is called when your extension is deactivated
export function deactivate(): void { }

/**
 * Watch the config file for changes
 * @param context
 */
function watchConfigFile(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!root) return;

  const configDir = path.join(root, cfgRootDir, packageId);
  const configPath = path.join(configDir, cfgFileName);

  // Ensure the config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // If config file does not exist, create a default one
  if (!fs.existsSync(configPath)) {
    const defaultConfig: ConfigInterface = {
      variableNames: defaultVariableNames,
      workInFiles: defaultLanguages,
      paths: ["assets/i18n/vi.json", "assets/i18n/en.json"],
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
    vscode.window
      .showInformationMessage(`[${packageId}] Default config created.`, "Open")
      .then((val: string | undefined): void => {
        if (val === "Open") {
          vscode.workspace
            .openTextDocument(configPath)
            .then((doc: vscode.TextDocument) => vscode.window.showTextDocument(doc));
        }
      });
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, `${cfgRootDir}/${packageId}/${cfgFileName}`)
  );

  const updateConfig = () => {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      currentConfig = JSON.parse(content);
      handleJsonCacheAndWatcher(currentConfig.paths, context);
    } catch (e: any) {
      vscode.window.showWarningMessage(`[${packageId}] Configuration read error: ${e.message}`);
    }
  };

  watcher.onDidChange(updateConfig);
  watcher.onDidCreate(updateConfig);
  watcher.onDidDelete(() => {
    currentConfig = {
      variableNames: defaultVariableNames,
      workInFiles: defaultLanguages,
      paths: [],
    };
  });

  updateConfig(); // First load
  context.subscriptions.push(watcher);
}

/**
 * Register a command that can be invoked via the command palette
 * @param context
 */
function registerCommand(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(`${packageId}.helloWorld`, () => {
    // The code you place here will be executed every time your command is executed
    // Display a message box to the user
    vscode.window.showInformationMessage(`[${packageId}] Hello World!`);
  });
  context.subscriptions.push(disposable);
}

/**
 * Register hover providers
 * @param context
 */
function registerHover(context: vscode.ExtensionContext): void {
  const provider: vscode.HoverProvider = {
    provideHover(document, position, _token) {
      if (!currentConfig.workInFiles.includes(document.languageId)) return;

      const regex = buildRegexFromVariables(currentConfig.variableNames);
      const range = document.getWordRangeAtPosition(position, regex);
      if (!range) return;

      const fullText = document.getText(range);
      const key = currentConfig.variableNames.reduce(
        (acc, v) => acc.replace(new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?`), ""),
        fullText
      );
      const allJson = getAllCachedJson();
      let markdownText = "";

      for (const [lang, jsonData] of Object.entries(allJson)) {
        const value = getValueByKey(jsonData, key);
        if (value !== undefined) {
          markdownText += `**${lang}**: ${value}\n\n---\n\n`;
        }
      }

      if (markdownText.trim()) {
        return new vscode.Hover(new vscode.MarkdownString(markdownText));
      }

      return;
    },
  };

  const disposable = vscode.languages.registerHoverProvider(currentConfig.workInFiles, provider);
  context.subscriptions.push(disposable);
}

/**
 * Register completion items providers
 * @param context
 */
function registerCompletionItem(context: vscode.ExtensionContext): void {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position, _token, _context) {
      const regex = buildRegexFromVariables(currentConfig.variableNames);
      const lineText = document.lineAt(position).text;
      const match = regex.exec(lineText.substring(0, position.character));
      if (!match) return;

      const fullMatch = match[0];
      const keyPrefix = currentConfig.variableNames.reduce(
        (acc, v) => acc.replace(new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?`), ""),
        fullMatch
      );
      const allJson = getAllCachedJson();
      const keySet = new Set<string>();
      const suggestionMap = new Map<string, vscode.CompletionItem>(); // dùng để loại trùng
      // If keyPrefix is empty string (`this._translate.` or `_translate.`)
      const fullKeyIsRoot = keyPrefix === "";

      for (const [lang, jsonData] of Object.entries(allJson)) {
        const node = fullKeyIsRoot ? jsonData : getValueByKey(jsonData, keyPrefix);

        if (typeof node === "object" && node !== null) {
          for (const childKey of Object.keys(node)) {
            if (!keySet.has(childKey)) {
              keySet.add(childKey);
              const item = new vscode.CompletionItem(childKey, vscode.CompletionItemKind.Property);
              item.label = childKey;
              item.detail = childKey;
              suggestionMap.set(childKey, item);
            }

            // Get display value (if any)
            // Always update documentation (merge all languages)
            const fullKey = fullKeyIsRoot ? childKey : `${keyPrefix}.${childKey}`;
            const value = getValueByKey(jsonData, fullKey);
            if (value && typeof value === "string") {
              const item = suggestionMap.get(childKey)!;
              const prevDoc =
                item.documentation instanceof vscode.MarkdownString ? item.documentation.value : "";
              const md = new vscode.MarkdownString(prevDoc + `- **${lang}**: ${value}\n`);
              item.documentation = md;
            }
          }
        }
      }

      return Array.from(suggestionMap.values());
    },
  };

  const disposable = vscode.languages.registerCompletionItemProvider(
    currentConfig.workInFiles,
    provider,
    "."
  ); // Trigger when typing dot
  context.subscriptions.push(disposable);
}

/**
 * Register definition provider
 * @param context
 */
function registerDefinition(context: vscode.ExtensionContext): void {
  const provider: vscode.DefinitionProvider = {
    provideDefinition(document, position, _token) {
      const regex = buildRegexFromVariables(currentConfig.variableNames);
      const range = document.getWordRangeAtPosition(position, regex);
      if (!range) return;

      const fullText = document.getText(range);
      const key = currentConfig.variableNames.reduce(
        (acc, v) => acc.replace(new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?`), ""),
        fullText
      );
      const keyParts = key.split(".");
      const allJson = getAllCachedJson();
      const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
      const results: vscode.Location[] = [];

      for (const [lang, jsonData] of Object.entries(allJson)) {
        const value = getValueByKey(jsonData, key);
        if (value !== undefined) {
          const filePath = currentConfig.paths.find((p) => path.basename(p, ".json") === lang);
          if (!filePath) continue;

          const fullPath = path.resolve(root, filePath);
          const text = fs.readFileSync(fullPath, "utf8");
          const lineIndex = text
            .split("\n")
            .findIndex((line) => line.includes(`"${keyParts.at(-1)}"`));

          if (lineIndex >= 0) {
            results.push(
              new vscode.Location(vscode.Uri.file(fullPath), new vscode.Position(lineIndex, 0))
            );
          }
        }
      }

      return results.length ? results : undefined;
    },
  };

  const disposable = vscode.languages.registerDefinitionProvider(
    currentConfig.workInFiles,
    provider
  );
  context.subscriptions.push(disposable);
}

/**
 * Set json cache and initialize watchers for JSON files specified in the config
 * @param configPaths Array of relative paths to JSON files
 * @param context Extension context for managing subscriptions
 */
function handleJsonCacheAndWatcher(configPaths: string[], context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";

  for (const relativePath of configPaths) {
    const fullPath = path.resolve(root, relativePath);
    const label = path.basename(fullPath, ".json");

    const loadFile = () => {
      try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        jsonCache[label] = JSON.parse(raw);
      } catch (e: any) {
        vscode.window.showWarningMessage(
          `[${packageId}] Error reading ${relativePath}: ${e.message}`
        );
        jsonCache[label] = {};
      }
    };

    // Initial load
    loadFile();

    // Setup watcher if not already
    if (!jsonWatchers[fullPath]) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, relativePath)
      );
      watcher.onDidChange(loadFile);
      watcher.onDidCreate(loadFile);
      watcher.onDidDelete(() => {
        jsonCache[label] = {};
      });
      context.subscriptions.push(watcher);
      jsonWatchers[fullPath] = watcher;
    }
  }
}

/**
 * Get all cached JSON data
 * @returns Record of cached JSON data
 */
function getAllCachedJson(): Record<string, any> {
  return jsonCache;
}

/**
 * Build a regex from the variable names to match against
 * @param vars Array of variable names
 * @returns RegExp object
 */
function buildRegexFromVariables(vars: string[]): RegExp {
  // escape special characters in variable names
  const escaped = vars.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:${escaped.map((v) => `(this\\.${v}|${v})`).join("|")})(\\.[a-zA-Z0-9_]+)*`);

  // (?:${escaped.join("|")})(\\.[a-zA-Z0-9_]+)+
  // (?:${escaped.map(v => `(this\\.${v}|${v})`).join("|")})(\\.[a-zA-Z0-9_]+)*
}

/**
 * Get value by key from an object, supporting nested keys
 * @param obj The object to search in
 * @param key The key to find, can be nested (e.g., "a.b.c")
 * @returns The value found at the key, or undefined if not found
 */
function getValueByKey(obj: any, key: string): any {
  return key.split(".").reduce((acc, cur) => acc?.[cur], obj);
}
