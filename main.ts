// Driver for the markdown-render-speed-02 entry. The harness runs
// `node /bot/main.ts`: read every case from cases.json, render each one
// alone with parse() from parse.js, and write html.json with the HTML
// strings in the cases' order. Outside a container the MAKEFUN_*_DIR
// environment variables stand in for /input and /output.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const out: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i].markdown);
writeFileSync(join(outDir, 'html.json'), JSON.stringify(out));
