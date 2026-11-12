#!/usr/bin/env node
import { runBoard } from '../skills/planning-board/cli.mjs';

const USAGE = `usage: npx github:cadolphs/cad-skills <skill> <command>

skills:
  board    planning board on a GitHub project (board help)`;

const skills = { board: runBoard };

const [skill, ...rest] = process.argv.slice(2);
if (!skills[skill]) {
  console.log(USAGE);
  process.exitCode = skill && skill !== 'help' ? 1 : 0;
} else {
  process.exitCode = skills[skill](rest);
}
