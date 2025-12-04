const fs = require('fs');
const { execSync } = require('child_process');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const name = pkg.name || 'vscode-ext-show-translation';
const version = pkg.version || '0.0.0';

const outputFile = `dist/${name}-${version}.vsix`;

execSync(`npx @vscode/vsce package --out ${outputFile}`, { stdio: 'inherit' });
