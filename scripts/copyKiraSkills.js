const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(__dirname, '../skills');
const target = path.resolve(__dirname, '../dist/skills');
fs.mkdirSync(target, { recursive: true });
for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = path.join(source, entry.name, 'SKILL.md');
    if (!fs.statSync(skill).isFile()) throw new Error(`Missing skill: ${entry.name}`);
    fs.mkdirSync(path.join(target, entry.name), { recursive: true });
    fs.copyFileSync(skill, path.join(target, entry.name, 'SKILL.md'));
}
