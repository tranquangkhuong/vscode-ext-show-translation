// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import fs from "fs";
import path from "path";
import vscode from "vscode";

const packageId: string = "vscode-ext-show-translation";
const cfgFileName: string = "show-translation.json";
const cfgRootDir: string = ".vscode";
const defaultMatchStrings: string[] = ["this._translate", "_translate", "translate", "trans"];
const defaultLanguages: string[] = ["javascript", "typescript", "html"];
const jsonCache: Record<string, any> = {};
const jsonWatchers: Record<string, vscode.FileSystemWatcher> = {};
let jsonPathLabels: Record<string, string> = {};

interface ConfigInterface {
  matchStrings: string[];
  workInFiles: string[];
  paths: string[];
}

let currentConfig: ConfigInterface = {
  matchStrings: defaultMatchStrings,
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
export function deactivate(): void {}

/**
 * Watch the config file for changes
 * @param context
 */
function watchConfigFile(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!root) return;

  const configDir = path.join(root, cfgRootDir);
  const configPath = path.join(configDir, cfgFileName);

  // Ensure the config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // If config file does not exist, create a default one
  if (!fs.existsSync(configPath)) {
    const defaultConfig: ConfigInterface = {
      matchStrings: defaultMatchStrings,
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
    new vscode.RelativePattern(root, `${cfgRootDir}/${cfgFileName}`)
  );

  const updateConfig = () => {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(content) as ConfigInterface;
      // Gộp với default để tránh thiếu field
      currentConfig = {
        matchStrings: parsed.matchStrings ?? defaultMatchStrings,
        workInFiles: parsed.workInFiles ?? defaultLanguages,
        paths: parsed.paths ?? [],
      };
      handleJsonCacheAndWatcher(currentConfig.paths, context);
    } catch (e: any) {
      // Log error to console instead of showing warning to avoid blocking
      console.error(`[${packageId}] Configuration read error:`, e.message);
      // Không thay đổi config hiện tại nếu file bị lỗi,
      // để extension vẫn hoạt động với cấu hình cũ.
    }
  };

  watcher.onDidChange(updateConfig);
  watcher.onDidCreate(updateConfig);
  watcher.onDidDelete(() => {
    currentConfig = {
      matchStrings: defaultMatchStrings,
      workInFiles: defaultLanguages,
      paths: [],
    };
    handleJsonCacheAndWatcher([], context);
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
      try {
        if (!currentConfig.workInFiles.includes(document.languageId)) return;

        const fullText = getFullTextAtPosition(document, position);
        if (!fullText) return;
        const allJson = getAllCachedJson();
        const key = getBestKeyFromFullText(fullText, allJson);
        if (key === null) return;
        let markdownText = "";

        for (const [lang, jsonData] of Object.entries(allJson)) {
          try {
            const value = getValueByKey(jsonData, key);
            if (value !== undefined) {
              markdownText += `**${lang}**: ${value}\n\n---\n\n`;
            }
          } catch (e) {
            // Silently skip errors for individual JSON files
            console.error(`[${packageId}] Error processing ${lang} JSON:`, e);
          }
        }

        if (markdownText.trim()) {
          return new vscode.Hover(new vscode.MarkdownString(markdownText));
        }
      } catch (e) {
        // Silently handle errors to avoid blocking other extensions
        console.error(`[${packageId}] Hover provider error:`, e);
      }

      return;
    },
  };

  // Đăng ký cho mọi file, sau đó tự lọc theo currentConfig.workInFiles
  const selector: vscode.DocumentSelector = [
    { scheme: "file" },
    { scheme: "untitled" },
    { scheme: "vscode-notebook-cell" },
  ];
  const disposable = vscode.languages.registerHoverProvider(selector, provider);
  context.subscriptions.push(disposable);
}

/**
 * Register completion items providers
 * @param context
 */
function registerCompletionItem(context: vscode.ExtensionContext): void {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position, _token, _context) {
      try {
        if (!currentConfig.workInFiles.includes(document.languageId)) return;

        // VSCode trigger completion tại dấu '.', nên lùi lại 1 ký tự để nằm trong từ cần phân tích
        const posForWord =
          position.character > 0
            ? new vscode.Position(position.line, position.character - 1)
            : position;
        const fullMatch = getFullTextAtPosition(document, posForWord);
        if (!fullMatch) return;
        const keyPrefix = extractKeyFromFullText(fullMatch);
        if (keyPrefix === null) return;
        const allJson = getAllCachedJson();
        const keySet = new Set<string>();
        const suggestionMap = new Map<string, vscode.CompletionItem>(); // dùng để loại trùng
        // If keyPrefix is empty string (`this._translate.` or `_translate.`)
        const fullKeyIsRoot = keyPrefix === "";

        for (const [lang, jsonData] of Object.entries(allJson)) {
          try {
            const node = fullKeyIsRoot ? jsonData : getValueByKey(jsonData, keyPrefix);

            if (typeof node === "object" && node !== null) {
              for (const childKey of Object.keys(node)) {
                if (!keySet.has(childKey)) {
                  keySet.add(childKey);
                  const item = new vscode.CompletionItem(
                    childKey,
                    vscode.CompletionItemKind.Property
                  );
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
                    item.documentation instanceof vscode.MarkdownString
                      ? item.documentation.value
                      : "";
                  const md = new vscode.MarkdownString(prevDoc + `- **${lang}**: ${value}\n`);
                  item.documentation = md;
                }
              }
            }
          } catch (e) {
            // Silently skip errors for individual JSON files
            console.error(`[${packageId}] Error processing ${lang} JSON in completion:`, e);
          }
        }

        return Array.from(suggestionMap.values());
      } catch (e) {
        // Silently handle errors to avoid blocking other extensions
        console.error(`[${packageId}] Completion provider error:`, e);
        return [];
      }
    },
  };

  // Đăng ký cho mọi file, sau đó tự lọc theo currentConfig.workInFiles
  const selector: vscode.DocumentSelector = [
    { scheme: "file" },
    { scheme: "untitled" },
    { scheme: "vscode-notebook-cell" },
  ];
  const disposable = vscode.languages.registerCompletionItemProvider(
    selector,
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
      const fullText = getFullTextAtPosition(document, position);
      if (!fullText) return;
      const allJson = getAllCachedJson();
      const key = getBestKeyFromFullText(fullText, allJson);
      if (key === null) return;
      const keyParts = key.split(".");
      const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
      const results: vscode.Location[] = [];

      for (const [lang, jsonData] of Object.entries(allJson)) {
        try {
          const value = getValueByKey(jsonData, key);
          if (value !== undefined) {
            const filePath = currentConfig.paths.find((p) => path.basename(p, ".json") === lang);
            if (!filePath) continue;

            const fullPath = path.resolve(root, filePath);
            try {
              const text = fs.readFileSync(fullPath, "utf8");
              const lineIndex = text
                .split("\n")
                .findIndex((line) => line.includes(`"${keyParts.at(-1)}"`));

              if (lineIndex >= 0) {
                results.push(
                  new vscode.Location(vscode.Uri.file(fullPath), new vscode.Position(lineIndex, 0))
                );
              }
            } catch (e) {
              // Silently skip if file cannot be read
              console.error(`[${packageId}] Error reading file ${fullPath}:`, e);
            }
          }
        } catch (e) {
          // Silently skip errors for individual JSON files
          console.error(`[${packageId}] Error processing ${lang} JSON in definition:`, e);
        }
      }

      return results.length ? results : undefined;
    },
  };

  // Đăng ký cho mọi file, sau đó tự lọc theo currentConfig.workInFiles
  const selector: vscode.DocumentSelector = [
    { scheme: "file" },
    { scheme: "untitled" },
    { scheme: "vscode-notebook-cell" },
  ];
  const disposable = vscode.languages.registerDefinitionProvider(selector, provider);
  context.subscriptions.push(disposable);
}

/**
 * Set json cache and initialize watchers for JSON files specified in the config
 * @param configPaths Array of relative paths to JSON files
 * @param context Extension context for managing subscriptions
 */
function handleJsonCacheAndWatcher(configPaths: string[], context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";

  const newFullPaths = new Set<string>();
  const newLabels: Record<string, string> = {};

  for (const relativePath of configPaths) {
    const fullPath = path.resolve(root, relativePath);
    const label = path.basename(fullPath, ".json");
    newFullPaths.add(fullPath);
    newLabels[fullPath] = label;

    const loadFile = () => {
      try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        jsonCache[label] = JSON.parse(raw);
      } catch (e: any) {
        // Log error to console instead of showing warning to avoid blocking
        // This allows the extension to continue working even if some JSON files have errors
        console.error(`[${packageId}] Error reading ${relativePath}:`, e.message);
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

  // Dọn watcher và cache cho các path không còn trong config
  for (const [fullPath, watcher] of Object.entries(jsonWatchers)) {
    if (!newFullPaths.has(fullPath)) {
      watcher.dispose();
      delete jsonWatchers[fullPath];
      const label = jsonPathLabels[fullPath];
      if (label) {
        delete jsonCache[label];
      }
      delete jsonPathLabels[fullPath];
    }
  }

  jsonPathLabels = newLabels;
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
  // Match text that starts with any variable name, optionally followed by dot-separated properties
  // This allows matching text that looks like matchStrings, not just valid variables
  return new RegExp(`(?:${escaped.join("|")})(\\.[a-zA-Z0-9_]+)*`);
}

/**
 * Lấy toàn bộ chuỗi key (bao gồm prefix matchStrings) tại vị trí con trỏ
 * Chỉ cho phép các ký tự [a-zA-Z0-9_.] để tránh dính sang phần template/HTML khác
 */
function getFullTextAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): string | null {
  const lineText = document.lineAt(position.line).text;
  if (!lineText) return null;

  const isAllowed = (ch: string): boolean => /[a-zA-Z0-9_.]/.test(ch);

  // Di chuyển sang trái
  let start = position.character;
  if (start > 0) start--;
  while (start > 0 && isAllowed(lineText.charAt(start - 1))) {
    start--;
  }

  // Di chuyển sang phải
  let end = position.character;
  while (end < lineText.length && isAllowed(lineText.charAt(end))) {
    end++;
  }

  if (start === end) return null;
  return lineText.substring(start, end);
}

/**
 * Từ fullText (vd: `this._translate.CONTROLL.LABEL.total_payment_in_word`)
 * cắt bỏ prefix matchStrings để lấy key (vd: `CONTROLL.LABEL.total_payment_in_word`)
 * Nếu không khớp bất kỳ matchStrings nào thì trả về null.
 */
function extractKeyFromFullText(fullText: string): string | null {
  if (!fullText) return null;

  // Đảm bảo chuỗi match đúng pattern (dùng lại regex cũ để không match linh tinh)
  const regex = buildRegexFromVariables(currentConfig.matchStrings);
  if (!regex.test(fullText)) return null;

  for (const prefix of currentConfig.matchStrings) {
    if (fullText === prefix || fullText.startsWith(`${prefix}.`)) {
      const raw = fullText.slice(prefix.length);
      return raw.replace(/^\./, "");
    }
  }

  return null;
}

/**
 * Lấy key tốt nhất từ fullText dựa trên JSON hiện tại.
 * - Với `_translate.CONTROLL.LABEL.x` → dùng key `CONTROLL.LABEL.x`
 * - Với `'CONTROLL.buy_invoice' | translate` → ưu tiên `CONTROLL.buy_invoice`
 *   (vì JSON thường có root `CONTROLL`).
 */
function getBestKeyFromFullText(
  fullText: string,
  allJson: Record<string, any>
): string | null {
  if (!fullText) return null;

  // Bỏ quote đầu/cuối nếu có
  const cleaned = fullText.replace(/^['"]|['"]$/g, "");
  if (!cleaned) return null;

  const candidates: string[] = [];

  // Candidate 1: cắt prefix (như logic hiện tại)
  const stripped = extractKeyFromFullText(cleaned);
  if (stripped) {
    candidates.push(stripped);
  }

  // Candidate 2: dùng nguyên chuỗi (phù hợp trường hợp CONTROLL là root key)
  if (!candidates.includes(cleaned)) {
    candidates.push(cleaned);
  }

  // Thử lần lượt trên tất cả JSON; key nào tồn tại thì chọn
  for (const candidate of candidates) {
    for (const jsonData of Object.values(allJson)) {
      try {
        const value = getValueByKey(jsonData, candidate);
        if (value !== undefined) {
          return candidate;
        }
      } catch {
        // bỏ qua JSON lỗi, tiếp tục thử cái khác
      }
    }
  }

  return null;
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
